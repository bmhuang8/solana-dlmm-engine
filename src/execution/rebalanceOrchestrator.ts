/**
 * execution/rebalanceOrchestrator.ts
 *
 * Executes the atomic 7-step rebalance sequence:
 *   1. Snapshot active bin
 *   2. Withdraw + claim (1–3 txs)
 *   3. Calculate 50/50 split (pure math)
 *   4. Jupiter swap (0–1 tx)
 *   5. Read final wallet balances
 *   6. Deploy new position (1 tx)
 *   7. (Housekeeping — done by ExecutionRunner after this returns)
 *
 * Funds are safe at every step:
 *   Withdraw fails  → still in position     → abort, retry next cycle
 *   Swap fails      → in wallet (unbalanced) → abort, retry next cycle
 *   Deploy fails    → in wallet (balanced)   → abort, retry next cycle (Gate 3 will pass)
 *
 * A RebalanceSemaphore serializes execution across all runners that share
 * the same wallet. Monitoring (fetchBatchedState) is never blocked.
 */

import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { StrategyConfig, ExecutionConfig } from "../config/settings";
import { getWalletPubkey } from "../core/signer";
import { connection, getWalletSolBalance, getWalletUsdcBalance } from "../core/client";
import {
  withdrawAll,
  deployPosition,
  getActiveBin,
  refreshPoolState,
} from "../services/meteoraService";
import {
  getQuote,
  buildSwapTransaction,
  calculateBalancingSwap,
  isPriceImpactTooHigh,
  SOL_MINT,
  USDC_MINT,
} from "../services/jupiterService";
import {
  sendSequential,
  sendAndConfirmVersioned,
  estimateTransactionCost,
} from "../services/transactionService";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RebalanceParams {
  /** Index in config.strategies — used by ExecutionRunner to reinit cache */
  strategyIndex: number;
  /** Mutable reference — positionPubkey is updated after rebalance */
  strategyConfig: StrategyConfig;
  /** Current position pubkey to withdraw from */
  positionPubkey: PublicKey;
  /** SOL price in USDC at rebalance start */
  solPrice: number;
  /** Execution config (global + per-strategy overrides already applied) */
  config: ExecutionConfig;
  /** Last observed unclaimed fee SOL amount — logged during rebalance for debugging */
  lastFeeX?: number;
  /** Last observed unclaimed fee USDC amount — logged during rebalance for debugging */
  lastFeeY?: number;
}

export interface RebalanceResult {
  success: boolean;
  /** Set on success — the pubkey of the newly deployed position */
  newPositionPubkey?: PublicKey;
  /** Which step failed, if any */
  failedStep?: string;
  error?: string;
  /** Confirmed transaction signatures in order */
  signatures: string[];
  /** Estimated SOL tx cost converted to USDC */
  estimatedCostUsdc: number;
  /** Actual swap slippage: (expectedOut − received). 0 if no swap was needed. */
  swapSlippageUsdc: number;
  /**
   * Measured wallet cost of this rebalance (USDC). Positive = wallet lost money.
   * Captures rent cycling, tx fees, and swap slippage — all from real wallet deltas.
   */
  measuredWalletCostUsdc?: number;
  /** Wall-clock duration of the whole rebalance */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Semaphore — serializes rebalances across runners (shared wallet)
// ---------------------------------------------------------------------------

/**
 * Simple Promise-based mutex.
 * One runner at a time can execute a rebalance; others queue up.
 * Monitoring is never blocked — it lives on a separate async path.
 */
class RebalanceSemaphore {
  private locked = false;
  private readonly queue: Array<() => void> = [];

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (!this.locked) {
          this.locked = true;
          const release = () => {
            this.locked = false;
            const next = this.queue.shift();
            if (next) next();
          };
          resolve(release);
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }
}

// ---------------------------------------------------------------------------
// RebalanceOrchestrator
// ---------------------------------------------------------------------------

export class RebalanceOrchestrator {
  private readonly semaphore = new RebalanceSemaphore();

  /**
   * Execute the full 7-step rebalance (withdraw → Jupiter swap → deploy).
   * Acquires the semaphore before starting; releases it when done.
   */
  async execute(params: RebalanceParams): Promise<RebalanceResult> {
    const release = await this.semaphore.acquire();
    const startMs = Date.now();

    try {
      return await this._executeInternal(params, startMs);
    } finally {
      release();
    }
  }

  /**
   * Emergency path: withdraw all liquidity and stop. No swap, no re-deploy.
   * Called by ExecutionRunner.emergencyWithdraw() via the kill switch.
   */
  async executeWithdrawOnly(params: RebalanceParams): Promise<RebalanceResult> {
    const release = await this.semaphore.acquire();
    const startMs = Date.now();

    try {
      const { positionPubkey, solPrice } = params;
      const signatures: string[] = [];
      const estimatedCostUsdc = estimateTransactionCost(1) * solPrice;

      const { transactions: withdrawTxs } = await withdrawAll(positionPubkey, true);
      const withdrawResults = await sendSequential(withdrawTxs);

      for (const r of withdrawResults) {
        if (r.signature) signatures.push(r.signature);
      }

      const withdrawFailed = withdrawResults.find((r) => !r.success);
      if (withdrawFailed) {
        return {
          success: false,
          failedStep: "withdraw",
          error: withdrawFailed.error,
          signatures,
          estimatedCostUsdc,
          swapSlippageUsdc: 0,
          measuredWalletCostUsdc: 0,
          durationMs: Date.now() - startMs,
        };
      }

      console.log(`[orchestrator] Emergency withdraw complete (${withdrawTxs.length} tx(s))`);
      return {
        success: true,
        signatures,
        estimatedCostUsdc,
        swapSlippageUsdc: 0,
        durationMs: Date.now() - startMs,
      };
    } finally {
      release();
    }
  }

  /**
   * Fallback path: withdraw → skip swap → deploy with current wallet ratio.
   * Used when Jupiter returns high price impact or is unavailable.
   */
  async executeSdkNative(params: RebalanceParams): Promise<RebalanceResult> {
    const release = await this.semaphore.acquire();
    const startMs = Date.now();

    try {
      return await this._executeNativeInternal(params, startMs);
    } finally {
      release();
    }
  }

  // ---------------------------------------------------------------------------
  // Primary path: withdraw → Jupiter swap → deploy
  // ---------------------------------------------------------------------------

  private async _executeInternal(
    params: RebalanceParams,
    startMs: number
  ): Promise<RebalanceResult> {
    const { positionPubkey, solPrice, config, lastFeeX = 0, lastFeeY = 0 } = params;
    const signatures: string[] = [];
    const txCount = 3; // withdraw(~1) + swap(1) + deploy(1) for cost estimate
    const estimatedCostUsdc = estimateTransactionCost(txCount) * solPrice;
    let swapSlippageUsdc = 0;

    // -------------------------------------------------------------------------
    // STEP 1: Snapshot active bin
    // -------------------------------------------------------------------------
    const activeBin = await getActiveBin();
    console.log(
      `[orchestrator] Starting rebalance — active bin ${activeBin.binId}, ` +
        `price $${parseFloat(activeBin.pricePerToken).toFixed(4)}`
    );

    // -------------------------------------------------------------------------
    // STEP 2: Snapshot wallet BEFORE withdraw to measure true cost at the end
    // -------------------------------------------------------------------------
    const walletPubkey = getWalletPubkey();
    const solBaseline = await getWalletSolBalance(walletPubkey);
    const usdcBaseline = await getWalletUsdcBalance(walletPubkey);

    // -------------------------------------------------------------------------
    // STEP 2b: Read old position account rent BEFORE closing it.
    // The rent refund will show up in the wallet delta after withdraw,
    // but it's not liquidity — exclude it from the deploy amount.
    // -------------------------------------------------------------------------
    let oldPositionRentSol = 0;
    try {
      const oldAccount = await connection.getAccountInfo(new PublicKey(positionPubkey));
      if (oldAccount) {
        oldPositionRentSol = oldAccount.lamports / 1e9;
      }
    } catch (err) {
      console.warn(`[orchestrator] Could not read old position rent: ${err}`);
    }

    // -------------------------------------------------------------------------
    // STEP 3: Withdraw + claim
    // -------------------------------------------------------------------------
    const { transactions: withdrawTxs } = await withdrawAll(positionPubkey, true);
    const withdrawResults = await sendSequential(withdrawTxs);

    for (const r of withdrawResults) {
      if (r.signature) signatures.push(r.signature);
    }

    const withdrawFailed = withdrawResults.find((r) => !r.success);
    if (withdrawFailed) {
      return {
        success: false,
        failedStep: "withdraw",
        error: withdrawFailed.error,
        signatures,
        estimatedCostUsdc,
        swapSlippageUsdc: 0,
        durationMs: Date.now() - startMs,
      };
    }

    console.log(`[orchestrator] Withdraw complete (${withdrawTxs.length} tx(s))`);

    await refreshPoolState();

    // -------------------------------------------------------------------------
    // STEP 4: Calculate 50/50 split using only funds from this position
    // -------------------------------------------------------------------------
    const solAfterWithdraw = await getWalletSolBalance(walletPubkey);
    const usdcAfterWithdraw = await getWalletUsdcBalance(walletPubkey);

    // Delta = what came out of the position (ignores other wallet funds)
    const rawDeltaSol = Math.max(0, solAfterWithdraw - solBaseline);
    const positionUsdc = Math.max(0, usdcAfterWithdraw - usdcBaseline);

    // Exclude the rent refund — it's not liquidity, just account overhead returning.
    // The new position will charge fresh rent from the wallet separately.
    const positionSol = Math.max(0, rawDeltaSol - oldPositionRentSol);
    const positionTotalUsdc = positionSol * solPrice + positionUsdc;

    console.log(
      `[orchestrator] [DEBUG] Wallet before withdraw:  ${solBaseline.toFixed(6)} SOL  ${usdcBaseline.toFixed(4)} USDC`
    );
    console.log(
      `[orchestrator] [DEBUG] Wallet after withdraw:   ${solAfterWithdraw.toFixed(6)} SOL  ${usdcAfterWithdraw.toFixed(4)} USDC`
    );
    console.log(
      `[orchestrator] [DEBUG] Raw delta:               ${rawDeltaSol.toFixed(6)} SOL (includes ${oldPositionRentSol.toFixed(6)} SOL rent refund)`
    );
    console.log(
      `[orchestrator] [DEBUG] Liquidity delta (out):   ${positionSol.toFixed(6)} SOL + ${positionUsdc.toFixed(4)} USDC = $${positionTotalUsdc.toFixed(4)}`
    );
    console.log(
      `[orchestrator] [DEBUG] lastFeeX=${lastFeeX.toFixed(6)} SOL  lastFeeY=${lastFeeY.toFixed(4)} USDC  (unclaimed at rebalance start)`
    );

    // -------------------------------------------------------------------------
    // Take-profit cap: exclude harvested fees from the swap and deploy budget.
    //
    // withdrawAll(shouldClaimAndClose=true) dumps fees + liquidity into the
    // wallet together. If we swap/deploy the full delta, fees get silently
    // auto-compounded — inflating position value and breaking PnL math.
    //
    // By subtracting the known fee amounts (lastFeeX/lastFeeY, captured from
    // the FeeTracker right before rebalance), only the original liquidity
    // value is rebalanced. The fees stay in the wallet as realized profit.
    // -------------------------------------------------------------------------
    const liquiditySol = Math.max(0, positionSol - lastFeeX);
    const liquidityUsdc = Math.max(0, positionUsdc - lastFeeY);
    const feeValueUsdc = lastFeeX * solPrice + lastFeeY;
    const liquidityTotalUsdc = liquiditySol * solPrice + liquidityUsdc;

    console.log(
      `[orchestrator] [DEBUG] Fees excluded (take-profit): ${lastFeeX.toFixed(6)} SOL + ${lastFeeY.toFixed(4)} USDC = $${feeValueUsdc.toFixed(4)}`
    );
    console.log(
      `[orchestrator] [DEBUG] Liquidity budget for deploy: ${liquiditySol.toFixed(6)} SOL + ${liquidityUsdc.toFixed(4)} USDC = $${liquidityTotalUsdc.toFixed(4)}`
    );

    const swapParams = calculateBalancingSwap(liquiditySol, liquidityUsdc, solPrice);
    console.log(`[orchestrator] Balancing swap: ${swapParams.description}`);

    // -------------------------------------------------------------------------
    // STEP 4: Jupiter swap (skipped if already balanced)
    // Retries with a fresh quote on failure — stale quotes are the most common
    // cause of swap failures. Falls back to native (no swap) after all retries.
    // -------------------------------------------------------------------------
    if (swapParams.direction !== "none") {
      const inputMint =
        swapParams.direction === "sol_to_usdc" ? SOL_MINT : USDC_MINT;
      const outputMint =
        swapParams.direction === "sol_to_usdc" ? USDC_MINT : SOL_MINT;

      const maxSwapAttempts = 3;
      let swapSucceeded = false;

      for (let attempt = 1; attempt <= maxSwapAttempts; attempt++) {
        if (attempt > 1) {
          const delayMs = attempt * 1500;
          console.log(
            `[orchestrator] Swap attempt ${attempt}/${maxSwapAttempts} — re-fetching quote in ${delayMs}ms…`
          );
          await new Promise((r) => setTimeout(r, delayMs));
        }

        let quote;
        try {
          quote = await getQuote(
            inputMint,
            outputMint,
            swapParams.amountSmallestUnit,
            config.maxSlippageBps
          );
        } catch (err) {
          if (attempt === maxSwapAttempts) {
            console.warn(`[orchestrator] Jupiter unavailable after ${maxSwapAttempts} attempts, falling back to native path`);
            return this._deployOnly(params, startMs, signatures, estimatedCostUsdc, 0, solBaseline, usdcBaseline, oldPositionRentSol, lastFeeX, lastFeeY);
          }
          console.warn(`[orchestrator] Jupiter quote failed (attempt ${attempt}): ${err}`);
          continue;
        }

        if (isPriceImpactTooHigh(quote, 0.01)) {
          // High impact is a market condition, not a transient error — don't retry
          console.warn(`[orchestrator] Price impact too high (${quote.priceImpactPct}%), falling back to native path`);
          return this._deployOnly(params, startMs, signatures, estimatedCostUsdc, 0, solBaseline, usdcBaseline, oldPositionRentSol, lastFeeX, lastFeeY);
        }

        const { transaction: swapTx, expectedOutAmount } =
          await buildSwapTransaction(quote);

        const swapResult = await sendAndConfirmVersioned(swapTx);
        if (swapResult.signature) signatures.push(swapResult.signature);

        if (!swapResult.success) {
          if (attempt === maxSwapAttempts) {
            console.warn(
              `[orchestrator] Swap failed after ${maxSwapAttempts} attempts (${swapResult.error}), falling back to native path`
            );
            return this._deployOnly(params, startMs, signatures, estimatedCostUsdc, 0, solBaseline, usdcBaseline, oldPositionRentSol, lastFeeX, lastFeeY);
          }
          console.warn(`[orchestrator] Swap attempt ${attempt} failed: ${swapResult.error}`);
          continue;
        }

        // Swap succeeded — calculate slippage and break
        const postSwapSol = await getWalletSolBalance(walletPubkey);
        const postSwapUsdc = await getWalletUsdcBalance(walletPubkey);
        const postSwapTotalUsdc = (postSwapSol - solBaseline) * solPrice + (postSwapUsdc - usdcBaseline);

        console.log(
          `[orchestrator] [DEBUG] Wallet after swap:       ${postSwapSol.toFixed(6)} SOL  ${postSwapUsdc.toFixed(4)} USDC`
        );
        console.log(
          `[orchestrator] [DEBUG] Position funds post-swap: ${(postSwapSol - solBaseline).toFixed(6)} SOL + ${(postSwapUsdc - usdcBaseline).toFixed(4)} USDC = $${postSwapTotalUsdc.toFixed(4)}`
        );
        console.log(
          `[orchestrator] [DEBUG] Value change from swap:  $${(postSwapTotalUsdc - positionTotalUsdc).toFixed(4)} (slippage + fees)`
        );

        if (swapParams.direction === "sol_to_usdc") {
          const actualUsdc = postSwapUsdc - usdcAfterWithdraw;
          const expectedUsdc = parseFloat(expectedOutAmount) / 1e6;
          swapSlippageUsdc = Math.max(0, expectedUsdc - actualUsdc);
        } else {
          const actualSolLamports = (postSwapSol - solAfterWithdraw) * 1e9;
          const expectedSolLamports = parseFloat(expectedOutAmount);
          const slippageLamports = Math.max(0, expectedSolLamports - actualSolLamports);
          swapSlippageUsdc = (slippageLamports / 1e9) * solPrice;
        }

        swapSucceeded = true;
        break;
      }

      // Should never reach here (loop always returns or sets swapSucceeded=true)
      if (!swapSucceeded) {
        return this._deployOnly(params, startMs, signatures, estimatedCostUsdc, 0, solBaseline, usdcBaseline, oldPositionRentSol, lastFeeX, lastFeeY);
      }
    }

    return this._deployOnly(
      params,
      startMs,
      signatures,
      estimatedCostUsdc,
      swapSlippageUsdc,
      solBaseline,
      usdcBaseline,
      oldPositionRentSol,
      lastFeeX,
      lastFeeY,
    );
  }

  // ---------------------------------------------------------------------------
  // Native fallback: withdraw → skip swap → deploy with current ratio
  // ---------------------------------------------------------------------------

  private async _executeNativeInternal(
    params: RebalanceParams,
    startMs: number
  ): Promise<RebalanceResult> {
    const { positionPubkey, solPrice, config, lastFeeX = 0, lastFeeY = 0 } = params;
    const signatures: string[] = [];
    const estimatedCostUsdc = estimateTransactionCost(2) * solPrice; // withdraw + deploy

    // Read old position rent before closing
    let oldPositionRentSol = 0;
    try {
      const oldAccount = await connection.getAccountInfo(new PublicKey(positionPubkey));
      if (oldAccount) {
        oldPositionRentSol = oldAccount.lamports / 1e9;
      }
    } catch (err) {
      console.warn(`[orchestrator] Could not read old position rent: ${err}`);
    }

    const activeBin = await getActiveBin();
    console.log(
      `[orchestrator] Native rebalance — active bin ${activeBin.binId}`
    );

    const walletPubkey = getWalletPubkey();
    const solBaseline = await getWalletSolBalance(walletPubkey);
    const usdcBaseline = await getWalletUsdcBalance(walletPubkey);

    const { transactions: withdrawTxs } = await withdrawAll(positionPubkey, true);
    const withdrawResults = await sendSequential(withdrawTxs);

    for (const r of withdrawResults) {
      if (r.signature) signatures.push(r.signature);
    }

    const withdrawFailed = withdrawResults.find((r) => !r.success);
    if (withdrawFailed) {
      return {
        success: false,
        failedStep: "withdraw",
        error: withdrawFailed.error,
        signatures,
        estimatedCostUsdc,
        swapSlippageUsdc: 0,
        durationMs: Date.now() - startMs,
      };
    }

    await refreshPoolState();

    return this._deployOnly(params, startMs, signatures, estimatedCostUsdc, 0, solBaseline, usdcBaseline, oldPositionRentSol, lastFeeX, lastFeeY);
  }

  // ---------------------------------------------------------------------------
  // Steps 5+6: Read balances → deploy new position
  // Shared by primary path (post-swap) and native fallback (no swap).
  // ---------------------------------------------------------------------------

  private async _deployOnly(
    params: RebalanceParams,
    startMs: number,
    signatures: string[],
    estimatedCostUsdc: number,
    swapSlippageUsdc = 0,
    solBaseline = 0,
    usdcBaseline = 0,
    oldPositionRentSol = 0,
    excludeFeeX = 0,
    excludeFeeY = 0,
  ): Promise<RebalanceResult> {
    const { config, solPrice } = params;
    const walletPubkey = getWalletPubkey();

    // -------------------------------------------------------------------------
    // STEP 5: Read final balances — deploy only the liquidity portion above
    // the pre-rebalance baseline. Harvested fees (excludeFeeX/Y) and the
    // rent refund are left in the wallet.
    // -------------------------------------------------------------------------
    const finalSolRaw = await getWalletSolBalance(walletPubkey);
    const finalUsdc = await getWalletUsdcBalance(walletPubkey);
    // Wallet delta minus rent refund minus harvested fees = liquidity only
    const walletDeltaSol = Math.max(0, finalSolRaw - solBaseline - oldPositionRentSol);
    const walletDeltaUsdc = Math.max(0, finalUsdc - usdcBaseline);
    const finalSol = Math.max(0, walletDeltaSol - excludeFeeX);
    const finalUsdcForDeploy = Math.max(0, walletDeltaUsdc - excludeFeeY);
    const deployTotalUsdc = finalSol * solPrice + finalUsdcForDeploy;

    console.log(
      `[orchestrator] [DEBUG] Wallet before deploy:    ${finalSolRaw.toFixed(6)} SOL  ${finalUsdc.toFixed(4)} USDC`
    );
    console.log(
      `[orchestrator] [DEBUG] Wallet delta (full):     ${walletDeltaSol.toFixed(6)} SOL + ${walletDeltaUsdc.toFixed(4)} USDC`
    );
    console.log(
      `[orchestrator] [DEBUG] Fees left in wallet:     ${excludeFeeX.toFixed(6)} SOL + ${excludeFeeY.toFixed(4)} USDC = $${(excludeFeeX * solPrice + excludeFeeY).toFixed(4)}`
    );
    console.log(
      `[orchestrator] [DEBUG] Deploying (liq only):    ${finalSol.toFixed(6)} SOL + ${finalUsdcForDeploy.toFixed(4)} USDC = $${deployTotalUsdc.toFixed(4)}`
    );

    const totalXAmount = new BN(Math.floor(finalSol * 1e9));
    const totalYAmount = new BN(Math.floor(finalUsdcForDeploy * 1e6));

    // -------------------------------------------------------------------------
    // STEP 6: Deploy new position
    // -------------------------------------------------------------------------
    const freshActiveBin = await getActiveBin(); // price may have moved during swap
    const binRadius = params.strategyConfig.binRadius ?? config.defaultBinRadius;
    const strategyType =
      params.strategyConfig.strategyType ?? config.defaultStrategyType;

    const { transaction: deployTx, positionKeypair } = await deployPosition({
      totalXAmount,
      totalYAmount,
      centerBinId: freshActiveBin.binId,
      binRadius,
      strategyType,
      slippageBps: config.meteoraSlippageBps,
    });

    const deployResult = await sendSequential([deployTx], {
      additionalSigners: [positionKeypair],
    });

    if (deployResult[0].signature) signatures.push(deployResult[0].signature);

    if (!deployResult[0].success) {
      return {
        success: false,
        failedStep: "deploy",
        error: deployResult[0].error,
        signatures,
        estimatedCostUsdc,
        swapSlippageUsdc,
        durationMs: Date.now() - startMs,
      };
    }

    const durationMs = Date.now() - startMs;

    // Measure true wallet cost: how much the wallet lost during the entire rebalance.
    // The raw wallet delta includes rent, but rent is refundable — subtract it.
    const postDeploySolRaw = await getWalletSolBalance(walletPubkey);
    const postDeployUsdc = await getWalletUsdcBalance(walletPubkey);
    const walletSolDelta = postDeploySolRaw - solBaseline;
    const walletUsdcDelta = postDeployUsdc - usdcBaseline;
    const rawWalletCostUsdc = -(walletSolDelta * solPrice + walletUsdcDelta);

    // Read the new position account's lamport balance = refundable rent.
    // This is not a real cost — it comes back when the position is closed.
    let positionRentUsdc = 0;
    try {
      const accountInfo = await connection.getAccountInfo(positionKeypair.publicKey);
      if (accountInfo) {
        const rentSol = accountInfo.lamports / 1e9;
        positionRentUsdc = rentSol * solPrice;
        console.log(
          `[orchestrator] [DEBUG] Position rent (refundable): ${rentSol.toFixed(6)} SOL = $${positionRentUsdc.toFixed(4)}`
        );
      }
    } catch (err) {
      console.warn(`[orchestrator] Could not read position rent: ${err}`);
    }

    const measuredWalletCostUsdc = Math.max(0, rawWalletCostUsdc - positionRentUsdc);

    console.log(
      `[orchestrator] [DEBUG] Wallet after deploy:     ${postDeploySolRaw.toFixed(6)} SOL  ${postDeployUsdc.toFixed(4)} USDC`
    );
    console.log(
      `[orchestrator] [DEBUG] Wallet delta:            ${walletSolDelta.toFixed(6)} SOL + ${walletUsdcDelta.toFixed(4)} USDC`
    );
    console.log(
      `[orchestrator] [DEBUG] Raw wallet cost:          $${rawWalletCostUsdc.toFixed(4)} (includes rent)`
    );
    console.log(
      `[orchestrator] [DEBUG] True rebalance cost:      $${measuredWalletCostUsdc.toFixed(4)} (tx fees + slippage only)`
    );
    console.log(
      `[orchestrator] [DEBUG] Deployed: $${deployTotalUsdc.toFixed(4)} | Sol price used: $${solPrice.toFixed(2)}`
    );

    console.log(
      `[orchestrator] Rebalance complete in ${(durationMs / 1000).toFixed(1)}s — ` +
        `new position: ${positionKeypair.publicKey.toBase58()}`
    );

    return {
      success: true,
      newPositionPubkey: positionKeypair.publicKey,
      signatures,
      estimatedCostUsdc,
      swapSlippageUsdc,
      measuredWalletCostUsdc,
      durationMs,
    };
  }
}
