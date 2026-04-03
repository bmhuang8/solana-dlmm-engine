/**
 * services/meteoraService.ts
 *
 * Thin wrappers over the Meteora DLMM SDK write operations.
 * Every function returns Transaction(s) — NEVER sends them.
 * Sending is delegated exclusively to transactionService.ts.
 *
 * Uses:
 *   - dlmmPool from core/client.ts (shared pool instance)
 *   - getKeypair()/getWalletPubkey() from core/signer.ts
 */

import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import DLMM, { StrategyType } from "@meteora-ag/dlmm";
import { dlmmPool } from "../core/client";
import { getWalletPubkey } from "../core/signer";
import { executionConfig } from "../config/settings";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DepositParams {
  /** Amount of SOL in lamports */
  totalXAmount: BN;
  /** Amount of USDC in micro-USDC */
  totalYAmount: BN;
  /** The active bin to center the new position on */
  centerBinId: number;
  /** Half-width of the position range (bins on each side) */
  binRadius: number;
  /**
   * DLMM strategy type: 0=Spot, 1=Curve, 2=BidAsk
   * Uses executionConfig.defaultStrategyType if not provided.
   */
  strategyType?: number;
  /**
   * Slippage tolerance in basis points (e.g. 100 = 1%).
   * Uses executionConfig.meteoraSlippageBps if not provided.
   */
  slippageBps?: number;
}

export interface ActiveBinResult {
  binId: number;
  /** Price as a raw string from the SDK (high precision) */
  price: string;
  /** Human-readable price per token (SOL price in USDC) */
  pricePerToken: string;
}

export interface DeployResult {
  transaction: Transaction;
  /** The keypair that owns the new position account — must sign the tx */
  positionKeypair: Keypair;
  minBinId: number;
  maxBinId: number;
}

// ---------------------------------------------------------------------------
// Pool state
// ---------------------------------------------------------------------------

/**
 * Force the DLMM pool instance to refresh its internal state cache.
 * Call this after a successful withdraw so the SDK has fresh on-chain data
 * before building the deposit transaction.
 */
export async function refreshPoolState(): Promise<void> {
  await dlmmPool.refetchStates();
}

/**
 * Get the pool's current active bin.
 * The active bin tells us where the current market price sits within the pool.
 */
export async function getActiveBin(): Promise<ActiveBinResult> {
  const bin = await dlmmPool.getActiveBin();
  return {
    binId: bin.binId,
    price: bin.price,
    pricePerToken: bin.pricePerToken,
  };
}

// ---------------------------------------------------------------------------
// Withdraw
// ---------------------------------------------------------------------------

/**
 * Build transactions to remove 100% of liquidity from a position.
 *
 * When shouldClaimAndClose=true (the normal rebalance path):
 *   - All accrued swap fees are claimed
 *   - The position account is closed (rent returned to wallet)
 *   - SOL and USDC land in the wallet after the transactions confirm
 *
 * Returns 1–3 transactions (the SDK may split large positions across multiple
 * transactions due to account size limits).
 *
 * Does NOT send — caller passes to transactionService.sendSequential().
 */
export async function withdrawAll(
  positionPubkey: PublicKey,
  shouldClaimAndClose: boolean
): Promise<{ transactions: Transaction[] }> {
  // Fetch the live position to get the exact bin range (required by removeLiquidity)
  const lbPosition = await dlmmPool.getPosition(positionPubkey);
  const { lowerBinId, upperBinId } = lbPosition.positionData;

  const transactions = await dlmmPool.removeLiquidity({
    user: getWalletPubkey(),
    position: positionPubkey,
    fromBinId: lowerBinId,
    toBinId: upperBinId,
    bps: new BN(10_000), // 100% — basis points, 10000 = 100%
    shouldClaimAndClose,
  });

  console.log(
    `[meteoraService] withdrawAll built ${transactions.length} tx(s) for position ${positionPubkey.toBase58()} ` +
      `(bins ${lowerBinId}–${upperBinId}, close=${shouldClaimAndClose})`
  );

  return { transactions };
}

// ---------------------------------------------------------------------------
// Claim fees (standalone — not used in normal rebalance path)
// ---------------------------------------------------------------------------

/**
 * Build transactions to claim all accrued swap fees without removing liquidity.
 * Used when we want to harvest fees but keep the position open.
 *
 * Note: In the rebalance path, fees are claimed automatically via
 * withdrawAll({ shouldClaimAndClose: true }). This is a standalone claim.
 */
export async function claimFees(
  positionPubkey: PublicKey
): Promise<Transaction[]> {
  const lbPosition = await dlmmPool.getPosition(positionPubkey);

  const transactions = await dlmmPool.claimSwapFee({
    owner: getWalletPubkey(),
    position: lbPosition,
  });

  console.log(
    `[meteoraService] claimFees built ${transactions.length} tx(s) for position ${positionPubkey.toBase58()}`
  );

  return transactions;
}

// ---------------------------------------------------------------------------
// Deploy new position
// ---------------------------------------------------------------------------

/**
 * Build a transaction to initialize a new DLMM position and add liquidity.
 *
 * Generates a fresh Keypair for the new position account — the caller MUST
 * pass this keypair as an additional signer when sending the transaction:
 *   transactionService.sendAndConfirm(tx, { additionalSigners: [positionKeypair] })
 *
 * The position is centered on centerBinId with ±binRadius bins on each side.
 *
 * IMPORTANT: Does NOT call setEntryState() — PnL tracking continues against
 * the original genesis baseline in StrategyRunner.
 */
export async function deployPosition(params: DepositParams): Promise<DeployResult> {
  const {
    totalXAmount,
    totalYAmount,
    centerBinId,
    binRadius,
    strategyType = executionConfig.defaultStrategyType,
    slippageBps = executionConfig.meteoraSlippageBps,
  } = params;

  const minBinId = centerBinId - binRadius;
  const maxBinId = centerBinId + binRadius;

  // Generate a new keypair for the position account
  const positionKeypair = new Keypair();

  // Map numeric strategyType to SDK enum
  const sdkStrategyType = numericToStrategyType(strategyType);

  const transaction = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionKeypair.publicKey,
    totalXAmount,
    totalYAmount,
    strategy: {
      minBinId,
      maxBinId,
      strategyType: sdkStrategyType,
    },
    user: getWalletPubkey(),
    slippage: slippageBps / 100, // SDK expects % (e.g. 1 = 1%), not bps
  });

  console.log(
    `[meteoraService] deployPosition built tx for new position ${positionKeypair.publicKey.toBase58()} ` +
      `(bins ${minBinId}–${maxBinId}, type=${StrategyType[sdkStrategyType]}, ` +
      `X=${totalXAmount.toString()} lamports, Y=${totalYAmount.toString()} uUSDC)`
  );

  return { transaction, positionKeypair, minBinId, maxBinId };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a numeric strategy type (0/1/2) to the SDK's StrategyType enum.
 * Defaults to Spot if the value is out of range.
 */
function numericToStrategyType(n: number): StrategyType {
  switch (n) {
    case 1:
      return StrategyType.Curve;
    case 2:
      return StrategyType.BidAsk;
    default:
      return StrategyType.Spot;
  }
}

// Re-export for use in safetyGates / orchestrator without importing from @meteora-ag/dlmm
export { StrategyType };
