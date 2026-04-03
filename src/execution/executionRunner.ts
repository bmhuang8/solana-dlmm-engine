/**
 * execution/executionRunner.ts
 *
 * Wraps StrategyRunner via composition ("has-a", not "is-a").
 * Each instance owns one ExecutionState and delegates analytics to the
 * inner StrategyRunner — its tick() returns the same TickStats interface,
 * so the poll loop and dashboard are unchanged.
 *
 * Execution flow (every 5s tick):
 *   1. analyticsRunner.tick() — ALWAYS runs (monitoring is never skipped)
 *   2. Skip if: execution disabled, paused, or rebalance in flight
 *   3. Evaluate safety gates
 *   4. All gates pass → fire-and-forget triggerRebalance()
 *   5. Return TickStats
 *
 * PnL continuity invariant:
 *   - analyticsRunner.setEntryState() is NEVER called after a rebalance.
 *   - PnL and IL always compare against the original genesis deposit.
 *   - FeeTracker claim detection handles the position transition automatically.
 */

import { PublicKey } from "@solana/web3.js";
import { StrategyConfig, ExecutionConfig } from "../config/settings";
import { PositionState } from "../core/position";
import { PriceData } from "../core/priceFeed";
import { StrategyRunner, TickStats } from "../runners/strategyRunner";
import { reinitializeStrategyCache } from "../core/batchFetcher";
import { evaluateAllGates, GateResult } from "./safetyGates";
import {
  RebalanceOrchestrator,
  RebalanceResult,
} from "./rebalanceOrchestrator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RebalanceRecord {
  startedAt: number;
  completedAt: number;
  oldPositionPubkey: string;
  newPositionPubkey?: string;
  success: boolean;
  failedStep?: string;
  durationMs: number;
  signatures: string[];
  estimatedCostUsdc: number;
  swapSlippageUsdc: number;
}

interface ExecutionState {
  /** Tracks the live position pubkey (changes after each rebalance) */
  currentPositionPubkey: PublicKey;
  rebalanceCount: number;
  /** Epoch ms of the last completed rebalance (0 = never) */
  lastRebalanceMs: number;
  /** lifetimeFeesUsdc snapshot taken at the end of the last rebalance */
  lastRebalanceFeesUsdc: number;
  /** Epoch ms of the last recorded volatility spike */
  lastVolatilitySpikeMs: number;
  /** True while a rebalance transaction sequence is in-flight */
  rebalanceInFlight: boolean;
  /** Most recent gate evaluation result (for dashboard) */
  lastGateResult: GateResult;
  /** Audit trail of all rebalance attempts */
  rebalanceHistory: RebalanceRecord[];
  /** Kill switch or manual pause */
  paused: boolean;
  /** Cumulative cost of all rebalances (tx fees + estimated slippage) */
  totalRebalanceCostUsdc: number;
  /** Cumulative swap slippage across all rebalances */
  totalSwapSlippageUsdc: number;
}

/**
 * Minimal event emitter interface — satisfied by socket.io Server, Node EventEmitter,
 * or any object that has an emit() method. Kept generic to avoid importing socket.io here.
 */
export interface EventEmitter {
  emit(event: string, data: unknown): boolean | void;
}

// ---------------------------------------------------------------------------
// ExecutionRunner
// ---------------------------------------------------------------------------

export class ExecutionRunner {
  readonly id: string;
  private readonly strategyConfig: StrategyConfig;
  private readonly strategyIndex: number;
  private readonly execConfig: ExecutionConfig;
  private readonly orchestrator: RebalanceOrchestrator;
  private readonly analyticsRunner: StrategyRunner;
  private readonly io: EventEmitter | null;
  private readonly state: ExecutionState;

  constructor(
    strategyConfig: StrategyConfig,
    strategyIndex: number,
    execConfig: ExecutionConfig,
    orchestrator: RebalanceOrchestrator,
    analyticsRunner: StrategyRunner,
    io: EventEmitter | null = null
  ) {
    this.id = strategyConfig.id;
    this.strategyConfig = strategyConfig;
    this.strategyIndex = strategyIndex;
    this.execConfig = execConfig;
    this.orchestrator = orchestrator;
    this.analyticsRunner = analyticsRunner;
    this.io = io;

    this.state = {
      currentPositionPubkey: new PublicKey(strategyConfig.positionPubkey),
      rebalanceCount: 0,
      lastRebalanceMs: 0,
      lastRebalanceFeesUsdc: 0,
      lastVolatilitySpikeMs: 0,
      rebalanceInFlight: false,
      lastGateResult: { pass: false, reason: "not yet evaluated" },
      rebalanceHistory: [],
      paused: false,
      totalRebalanceCostUsdc: 0,
      totalSwapSlippageUsdc: 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Public interface used by the poll loop (same signature as StrategyRunner)
  // ---------------------------------------------------------------------------

  /**
   * Process one 5s poll cycle.
   * Analytics always run. Rebalance logic is fire-and-forget async.
   */
  tick(position: PositionState, price: PriceData): TickStats | null {
    // Step 1: Analytics always run (returns null during transition window)
    const tickStats = this.analyticsRunner.tick(position, price);

    // Step 2: Skip execution if disabled / paused / in-flight
    if (
      !this.execConfig.enabled ||
      this.state.paused ||
      this.state.rebalanceInFlight
    ) {
      return tickStats;
    }

    // Step 3: Evaluate safety gates
    const gateResult = evaluateAllGates({
      lastRebalanceMs: this.state.lastRebalanceMs,
      lastRebalanceFeesUsdc: this.state.lastRebalanceFeesUsdc,
      lastVolatilitySpikeMs: this.state.lastVolatilitySpikeMs,
      feeTracker: this.analyticsRunner.fees,
      volatilityTracker: this.analyticsRunner.volatility,
      position,
      solPrice: price.onChainPrice,
      config: this.execConfig,
      feeGateMultiplier: this.strategyConfig.feeGateMultiplier,
      outOfRangeBinThreshold: this.strategyConfig.outOfRangeBinThreshold,
      minRebalanceIntervalMs: this.strategyConfig.minRebalanceIntervalMs,
    });

    // Persist spike timer update even on non-pass
    if (gateResult.updatedSpikeMs !== undefined) {
      this.state.lastVolatilitySpikeMs = gateResult.updatedSpikeMs;
    }
    this.state.lastGateResult = gateResult;

    if (!gateResult.pass) {
      return tickStats;
    }

    // Step 4: All gates pass — snapshot realized metrics NOW, then fire rebalance.
    //
    // Timing matters: we capture IL and fees at this exact tick because:
    //   - analyticsRunner.tick() just ran with the current position state + price
    //   - lastUnrealizedIlUsdc and fees.lifetimeFeesUsdc reflect the live state
    //   - Once the rebalance starts, the old position gets closed on-chain and
    //     subsequent ticks return null — the values would freeze at a stale point
    //
    // By snapshotting here we get the most accurate pre-rebalance metrics.
    const snapshotIl = this.analyticsRunner.lastUnrealizedIlUsdc;
    const snapshotFees = this.analyticsRunner.fees.lifetimeFeesUsdc;

    this.state.rebalanceInFlight = true;
    const oldPubkey = this.state.currentPositionPubkey;
    const startedAt = Date.now();

    console.log(
      `[executionRunner] ${this.id} — gates passed (${gateResult.reason}), ` +
        `triggering rebalance…`
    );

    this.io?.emit("rebalance_start", {
      strategyId: this.id,
      positionPubkey: oldPubkey.toBase58(),
      solPrice: price.onChainPrice,
      timestamp: startedAt,
    });

    this.triggerRebalance(oldPubkey, price.onChainPrice, startedAt, snapshotIl, snapshotFees).catch(
      (err) => {
        // Unexpected error outside normal error handling — log and reset flag
        console.error(`[executionRunner] ${this.id} unexpected error:`, err);
        this.state.rebalanceInFlight = false;
      }
    );

    // Step 5: Return TickStats unchanged — dashboard sees no disruption
    return tickStats;
  }

  // ---------------------------------------------------------------------------
  // Rebalance trigger (async, runs off the poll loop)
  // ---------------------------------------------------------------------------

  private async triggerRebalance(
    positionPubkey: PublicKey,
    solPrice: number,
    startedAt: number,
    snapshotIlUsdc: number,
    snapshotFeesUsdc: number
  ): Promise<void> {
    let result: RebalanceResult;

    try {
      result = await this.orchestrator.execute({
        strategyIndex: this.strategyIndex,
        strategyConfig: this.strategyConfig,
        positionPubkey,
        solPrice,
        config: this.execConfig,
        lastFeeX: this.analyticsRunner.fees.lastFeeX,
        lastFeeY: this.analyticsRunner.fees.lastFeeY,
      });
    } catch (err) {
      result = {
        success: false,
        failedStep: "unexpected",
        error: err instanceof Error ? err.message : String(err),
        signatures: [],
        estimatedCostUsdc: 0,
        swapSlippageUsdc: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    // -------------------------------------------------------------------------
    // Step 7: Housekeeping (always runs, success or failure)
    // -------------------------------------------------------------------------
    this.state.rebalanceInFlight = false;

    const record: RebalanceRecord = {
      startedAt,
      completedAt: Date.now(),
      oldPositionPubkey: positionPubkey.toBase58(),
      newPositionPubkey: result.newPositionPubkey?.toBase58(),
      success: result.success,
      failedStep: result.failedStep,
      durationMs: result.durationMs,
      signatures: result.signatures,
      estimatedCostUsdc: result.estimatedCostUsdc,
      swapSlippageUsdc: result.swapSlippageUsdc,
    };
    this.state.rebalanceHistory.push(record);

    if (!result.success) {
      console.error(
        `[executionRunner] ${this.id} rebalance FAILED at step "${result.failedStep}": ${result.error}`
      );
      this.io?.emit("rebalance_failed", {
        strategyId: this.id,
        failedStep: result.failedStep,
        error: result.error,
        timestamp: Date.now(),
      });
      return;
    }

    // Success path — update execution state
    const newPubkey = result.newPositionPubkey!;

    this.state.currentPositionPubkey = newPubkey;
    this.state.rebalanceCount++;
    this.state.lastRebalanceMs = Date.now();
    this.state.lastRebalanceFeesUsdc =
      this.analyticsRunner.fees.lifetimeFeesUsdc;
    this.state.totalRebalanceCostUsdc += result.estimatedCostUsdc;
    this.state.totalSwapSlippageUsdc += result.swapSlippageUsdc;

    // Lock in realized metrics using the pre-rebalance snapshot (captured in tick()
    // before the rebalance was fired, when position state and price were known-good).
    this.analyticsRunner.captureRealizedMetrics(snapshotIlUsdc, snapshotFeesUsdc);

    // Record the measured wallet cost so PnL stays accurate
    if (result.measuredWalletCostUsdc != null) {
      this.analyticsRunner.addRebalanceCost(result.measuredWalletCostUsdc, newPubkey.toBase58());
    }

    // Update the strategy config's positionPubkey so future restarts use the new position
    this.strategyConfig.positionPubkey = newPubkey.toBase58();

    // Reinitialize batchFetcher cache so the next poll cycle monitors the new position
    try {
      await reinitializeStrategyCache(this.strategyIndex, newPubkey);
    } catch (err) {
      console.error(
        `[executionRunner] ${this.id} cache reinit failed (non-fatal): ${err}`
      );
    }

    console.log(
      `[executionRunner] ${this.id} rebalance #${this.state.rebalanceCount} complete ` +
        `→ ${newPubkey.toBase58().slice(0, 8)}… ` +
        `(${(result.durationMs / 1000).toFixed(1)}s, ` +
        `cost ~$${result.estimatedCostUsdc.toFixed(3)})`
    );

    this.io?.emit("rebalance_complete", {
      strategyId: this.id,
      rebalanceCount: this.state.rebalanceCount,
      newPositionPubkey: newPubkey.toBase58(),
      oldPositionPubkey: positionPubkey.toBase58(),
      durationMs: result.durationMs,
      signatures: result.signatures,
      estimatedCostUsdc: result.estimatedCostUsdc,
      totalRebalanceCostUsdc: this.state.totalRebalanceCostUsdc,
      swapSlippageUsdc: result.swapSlippageUsdc,
      timestamp: Date.now(),
    });
  }

  // ---------------------------------------------------------------------------
  // Manual rebalance (triggered from dashboard)
  // ---------------------------------------------------------------------------

  /**
   * Force a rebalance regardless of safety gates. Uses the latest analytics
   * snapshot for realized metrics, just like the automated path.
   *
   * @param solPrice Current SOL price in USDC
   * @returns Object with success/error for the UI to display
   */
  async forceRebalance(solPrice: number): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (this.state.rebalanceInFlight) {
      return { success: false, error: "Rebalance already in flight" };
    }

    console.log(`[executionRunner] ${this.id} — MANUAL rebalance triggered`);

    // Snapshot realized metrics from the latest tick
    const snapshotIl = this.analyticsRunner.lastUnrealizedIlUsdc;
    const snapshotFees = this.analyticsRunner.fees.lifetimeFeesUsdc;

    this.state.rebalanceInFlight = true;
    const oldPubkey = this.state.currentPositionPubkey;
    const startedAt = Date.now();

    this.io?.emit("rebalance_start", {
      strategyId: this.id,
      positionPubkey: oldPubkey.toBase58(),
      solPrice,
      timestamp: startedAt,
      manual: true,
    });

    try {
      await this.triggerRebalance(oldPubkey, solPrice, startedAt, snapshotIl, snapshotFees);
      return { success: true };
    } catch (err) {
      this.state.rebalanceInFlight = false;
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Emergency withdraw (called by KillSwitch)
  // ---------------------------------------------------------------------------

  /**
   * Immediately withdraw all liquidity from the current position.
   * Called by KillSwitch.trigger() — does NOT deploy a new position.
   */
  async emergencyWithdraw(): Promise<{
    success: boolean;
    signatures: string[];
    error?: string;
  }> {
    console.log(
      `[executionRunner] ${this.id} — EMERGENCY WITHDRAW initiated`
    );

    try {
      const result = await this.orchestrator.executeWithdrawOnly({
        strategyIndex: this.strategyIndex,
        strategyConfig: this.strategyConfig,
        positionPubkey: this.state.currentPositionPubkey,
        solPrice: 0,
        config: { ...this.execConfig, meteoraSlippageBps: 500 },
      });

      return {
        success: result.success,
        signatures: result.signatures,
        error: result.error,
      };
    } catch (err) {
      return {
        success: false,
        signatures: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  get paused(): boolean {
    return this.state.paused;
  }

  set paused(value: boolean) {
    this.state.paused = value;
    console.log(
      `[executionRunner] ${this.id} ${value ? "paused" : "resumed"}`
    );
  }

  get rebalanceInFlight(): boolean {
    return this.state.rebalanceInFlight;
  }

  get executionState(): Readonly<ExecutionState> {
    return this.state;
  }

  get lastGateResult(): GateResult {
    return this.state.lastGateResult;
  }
}
