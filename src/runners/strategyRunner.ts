/**
 * runners/strategyRunner.ts
 *
 * StrategyRunner encapsulates all per-strategy state and analytics.
 * One instance is created per entry in config.strategies.
 *
 * Each runner:
 *   - Owns its FeeTracker and VolatilityTracker (no shared state between runners)
 *   - Receives pre-fetched PositionState and PriceData from the main loop
 *   - Computes IL and P&L analytics against its entryState baseline
 *   - Returns a TickStats object each tick; the caller emits it to the dashboard
 *
 * Realized vs Unrealized metrics:
 *   - "Realized" IL/fees are locked in at each rebalance and persisted to disk.
 *   - "Unrealized" IL/fees come from the current open position only.
 *   - Dashboard totals = realized + unrealized.
 *   - PnL is always anchored to the original genesis entry for total performance.
 *
 * The runner never touches the RPC — all data is pushed in via tick().
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { StrategyConfig } from "../config/settings";
import { PositionState } from "../core/position";
import { PriceData } from "../core/priceFeed";
import { FeeTracker } from "../analytics/feeTracker";
import { VolatilityTracker } from "../analytics/volatility";
import { calculateIL } from "../analytics/ilCalculator";
import { calculatePnL } from "../analytics/pnl";

// ---------------------------------------------------------------------------
// EntryState — captured once at startup by initializeBaselines()
// ---------------------------------------------------------------------------

/**
 * Baseline snapshot recorded at bot startup.
 * Populated from on-chain transaction history by genesisLoader.ts,
 * or from the current position state as a fallback.
 */
export interface EntryState {
  /** Epoch ms when the baseline was captured */
  timestamp: number;
  /** SOL price in USDC at baseline capture time */
  solPrice: number;
  /** SOL tokens in the position at baseline capture time */
  solAmount: number;
  /** USDC tokens in the position at baseline capture time */
  usdcAmount: number;
  /** Total position value in USDC at baseline: usdcAmount + (solAmount * solPrice) */
  valueUsdc: number;
}

// ---------------------------------------------------------------------------
// TickStats — returned by tick(), emitted to dashboard via socket.io
// ---------------------------------------------------------------------------

/** Live snapshot of one strategy's analytics for the current poll cycle. */
export interface TickStats {
  id: string;
  label: string;
  positionPubkey: string;
  inRange: boolean;
  valueUsdc: number;
  solAmount: number;
  usdcAmount: number;
  ilUsdc: number;
  realizedIlUsdc: number;
  feesUsdc: number;
  realizedFeesUsdc: number;
  /** Fees / IL ratio as a formatted string ("2.34x" or "--") */
  feeIlRatio: string;
  pnlUsdc: number;
  /** Cumulative measured cost of all rebalances (rent + tx fees + slippage) */
  rebalCostUsdc: number;
  intervalVol: number;
  bias: number;
  biasArrow: string;
}

// ---------------------------------------------------------------------------
// Persisted state shape
// ---------------------------------------------------------------------------

interface PersistedState {
  positionPubkey: string;
  totalRebalanceCostsUsdc: number;
  realizedIlUsdc: number;
  realizedFeesUsdc: number;
  /** Entry state for the current position (set after each rebalance) */
  currentEntry: EntryState | null;
  /** True if a rebalance completed but the next tick hasn't captured the new baseline yet */
  needsNewBaseline?: boolean;
}

// ---------------------------------------------------------------------------
// StrategyRunner
// ---------------------------------------------------------------------------

export class StrategyRunner {
  readonly id: string;
  private readonly label: string;
  private readonly feeTracker: FeeTracker;
  private readonly volatilityTracker: VolatilityTracker;

  /**
   * Original genesis entry — set once at startup, NEVER changed.
   * Used for PnL calculation (total performance since inception).
   */
  private originalEntry: EntryState | null = null;

  /**
   * Current position entry — updated after each rebalance.
   * Used for unrealized IL calculation (IL relative to the current position's deposit).
   * Before the first rebalance, this equals originalEntry.
   */
  private currentEntry: EntryState | null = null;

  /**
   * True after a rebalance completes — the next tick() will capture the new
   * position state as the currentEntry baseline.
   */
  private needsNewBaseline: boolean = false;

  /**
   * Cumulative IL locked in from all past rebalances (USDC).
   * At each rebalance, the unrealized IL at that moment becomes realized.
   */
  private realizedIlUsdc: number = 0;

  /**
   * Cumulative fees locked in from all past rebalances (USDC).
   * At each rebalance, the lifetime fees at that moment become realized.
   */
  private realizedFeesUsdc: number = 0;

  /**
   * Cumulative measured wallet cost of all rebalances (USDC).
   * Derived from actual wallet deltas — no assumptions or hardcoded values.
   * Subtracted from PnL so it accurately reflects the true cost of rebalancing.
   * Persisted to disk so it survives bot restarts.
   */
  private totalRebalanceCostsUsdc: number = 0;
  private readonly costFilePath: string;
  private currentPositionPubkey: string;

  constructor(strategyConfig: StrategyConfig) {
    this.id = strategyConfig.id;
    this.label = strategyConfig.label;
    this.feeTracker = new FeeTracker();
    // 60 samples at 3s polling = 3 minutes of volatility history
    this.volatilityTracker = new VolatilityTracker(60);
    this.currentPositionPubkey = strategyConfig.positionPubkey;

    // Load persisted state from previous runs
    const dataDir = join(__dirname, "..", "..", "data");
    mkdirSync(dataDir, { recursive: true });
    this.costFilePath = join(dataDir, `rebal-costs-${this.id}.json`);
    try {
      const raw = readFileSync(this.costFilePath, "utf-8");
      const data: PersistedState = JSON.parse(raw);
      if (data.positionPubkey === strategyConfig.positionPubkey) {
        this.totalRebalanceCostsUsdc = data.totalRebalanceCostsUsdc ?? 0;
        this.realizedIlUsdc = data.realizedIlUsdc ?? 0;
        this.realizedFeesUsdc = data.realizedFeesUsdc ?? 0;
        // Restore current entry from persisted state (survives restarts).
        // If needsNewBaseline was persisted (crash between rebalance and next tick),
        // discard the stale currentEntry so the first tick captures a fresh baseline.
        if (data.needsNewBaseline) {
          this.needsNewBaseline = true;
          this.currentEntry = null;
          console.log(
            `[${this.id}] Recovered from mid-rebalance restart — will capture fresh baseline on first tick`
          );
        } else if (data.currentEntry) {
          this.currentEntry = data.currentEntry;
        }
        if (this.totalRebalanceCostsUsdc > 0 || this.realizedIlUsdc > 0 || this.realizedFeesUsdc > 0) {
          console.log(
            `[${this.id}] Loaded persisted state: ` +
              `rebalCost=$${this.totalRebalanceCostsUsdc.toFixed(4)}, ` +
              `realizedIL=$${this.realizedIlUsdc.toFixed(4)}, ` +
              `realizedFees=$${this.realizedFeesUsdc.toFixed(4)}`
          );
        }
      } else {
        console.log(`[${this.id}] Position changed — resetting persisted state`);
      }
    } catch {
      // No file yet — first run
    }
  }

  // ---------------------------------------------------------------------------
  // Baseline
  // ---------------------------------------------------------------------------

  /**
   * Lock in the genesis baseline snapshot. Called once by initializeBaselines()
   * before the poll loop starts.
   */
  setEntryState(state: EntryState): void {
    this.originalEntry = state;
    // If no currentEntry was restored from disk (first run or position changed),
    // start with the genesis entry as the current baseline too
    if (!this.currentEntry) {
      this.currentEntry = state;
    }
  }

  /**
   * Public getter for entryState — used by initializeBaselines() to check
   * whether the baseline has been set.
   */
  get entryState(): EntryState | null {
    return this.originalEntry;
  }

  /**
   * Called by ExecutionRunner after each successful rebalance.
   * Adds the measured wallet cost (rent + tx fees + slippage) to the lifetime total.
   */
  addRebalanceCost(costUsdc: number, newPositionPubkey: string): void {
    this.totalRebalanceCostsUsdc += costUsdc;
    this.currentPositionPubkey = newPositionPubkey;
    console.log(
      `[${this.id}] Rebalance cost: $${costUsdc.toFixed(4)} (lifetime: $${this.totalRebalanceCostsUsdc.toFixed(4)})`
    );
    this.persistState();
  }

  /**
   * Called by ExecutionRunner BEFORE a rebalance closes the old position.
   * Captures the current unrealized IL and fees as "realized" and resets
   * the feeTracker for the new position.
   *
   * @param currentIlUsdc   The unrealized IL at the moment of rebalance
   * @param currentFeesUsdc The lifetime fees (realized + unrealized) at the moment of rebalance
   */
  captureRealizedMetrics(currentIlUsdc: number, currentFeesUsdc: number): void {
    this.realizedIlUsdc += currentIlUsdc;
    // currentFeesUsdc is the feeTracker's lifetimeFeesUsdc at this moment.
    // Add it to realized, then reset the tracker for the new position.
    this.realizedFeesUsdc += currentFeesUsdc;

    console.log(
      `[${this.id}] Realized metrics captured: ` +
        `IL=$${currentIlUsdc.toFixed(4)} (total=$${this.realizedIlUsdc.toFixed(4)}), ` +
        `fees=$${currentFeesUsdc.toFixed(4)} (total=$${this.realizedFeesUsdc.toFixed(4)})`
    );

    // Reset fee tracker — the new position starts with 0 unclaimed fees
    this.feeTracker.reset();

    // Signal that the next tick should capture the new position as currentEntry
    this.needsNewBaseline = true;

    this.persistState();
  }

  // ---------------------------------------------------------------------------
  // Tracker accessors — used by ExecutionRunner for safety gate evaluation
  // ---------------------------------------------------------------------------

  /** Exposes FeeTracker for the execution layer (safety gate 4 — fee rule). */
  get fees(): FeeTracker {
    return this.feeTracker;
  }

  /** Exposes VolatilityTracker for the execution layer (safety gate 2 — volatility cooldown). */
  get volatility(): VolatilityTracker {
    return this.volatilityTracker;
  }

  /**
   * The unrealized IL from the current position (computed in the last tick).
   * Used by ExecutionRunner to capture realized IL at rebalance time.
   */
  get lastUnrealizedIlUsdc(): number {
    return this._lastUnrealizedIlUsdc;
  }
  private _lastUnrealizedIlUsdc: number = 0;

  // ---------------------------------------------------------------------------
  // tick — called once per poll cycle by the main loop
  // ---------------------------------------------------------------------------

  /**
   * Process one poll cycle for this strategy.
   * All inputs come from the central batch fetch — no RPC calls here.
   *
   * Returns a TickStats object for the dashboard, or null if skipped.
   * Skips silently if:
   *   - entryState is not yet set (baseline not captured)
   *   - position not found on-chain
   *   - price is unavailable
   */
  tick(position: PositionState, price: PriceData): TickStats | null {
    if (!this.originalEntry || !position.found || price.onChainPrice === 0) return null;

    // --- Capture new baseline after rebalance (or crash recovery) ------------
    // Must run BEFORE the currentEntry null-check so we can recover from a
    // restart where needsNewBaseline was persisted but currentEntry was cleared.
    if (this.needsNewBaseline || !this.currentEntry) {
      this.currentEntry = {
        timestamp: Date.now(),
        solPrice: price.onChainPrice,
        solAmount: position.totalSolAmount,
        usdcAmount: position.totalUsdcAmount,
        valueUsdc: position.totalSolAmount * price.onChainPrice + position.totalUsdcAmount,
      };
      this.needsNewBaseline = false;
      console.log(
        `[${this.id}] New baseline captured: ` +
          `${position.totalSolAmount.toFixed(6)} SOL + ${position.totalUsdcAmount.toFixed(4)} USDC ` +
          `= $${this.currentEntry.valueUsdc.toFixed(2)} @ $${price.onChainPrice.toFixed(2)}/SOL`
      );
      this.persistState();
    }

    // --- Update rolling trackers -------------------------------------------
    this.volatilityTracker.update(price.onChainPrice);
    this.feeTracker.update(position.feeX, position.feeY, price.onChainPrice);

    // --- Compute unrealized IL (against current position's entry) -----------
    const il = calculateIL(
      position.totalSolAmount,
      position.totalUsdcAmount,
      price.onChainPrice,
      this.currentEntry.solAmount,
      this.currentEntry.usdcAmount
    );
    this._lastUnrealizedIlUsdc = il.ilUsdc;

    // --- Combine realized + unrealized for totals ---------------------------
    const totalIlUsdc = this.realizedIlUsdc + il.ilUsdc;
    const unrealizedFeesUsdc = this.feeTracker.lifetimeFeesUsdc;
    const totalFeesUsdc = this.realizedFeesUsdc + unrealizedFeesUsdc;

    // --- PnL anchored to original genesis entry -----------------------------
    const pnl = calculatePnL(
      il.currentValueUsdc,
      totalFeesUsdc,
      this.originalEntry.valueUsdc
    );

    // Adjust PnL for measured rebalance costs (rent + tx fees + slippage)
    const adjustedPnlUsdc = pnl.netPnlUsdc - this.totalRebalanceCostsUsdc;

    // --- In-range check ------------------------------------------------------
    let inRange = false;
    if (position.bins.length > 0) {
      const minBin = Math.min(...position.bins.map((b) => b.binId));
      const maxBin = Math.max(...position.bins.map((b) => b.binId));
      inRange =
        position.activeBinId >= minBin && position.activeBinId <= maxBin;
    }

    const feeIlRatio =
      totalIlUsdc > 0.001
        ? `${(totalFeesUsdc / totalIlUsdc).toFixed(2)}x`
        : "--";

    return {
      id: this.id,
      label: this.label,
      positionPubkey: this.currentPositionPubkey,
      inRange,
      valueUsdc: il.currentValueUsdc,
      solAmount: position.totalSolAmount,
      usdcAmount: position.totalUsdcAmount,
      ilUsdc: totalIlUsdc,
      realizedIlUsdc: this.realizedIlUsdc,
      feesUsdc: totalFeesUsdc,
      realizedFeesUsdc: this.realizedFeesUsdc,
      feeIlRatio,
      pnlUsdc: adjustedPnlUsdc,
      rebalCostUsdc: this.totalRebalanceCostsUsdc,
      intervalVol: this.volatilityTracker.intervalVolatility,
      bias: this.volatilityTracker.directionalBias,
      biasArrow: this.volatilityTracker.biasArrow,
    };
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private persistState(): void {
    try {
      const state: PersistedState = {
        positionPubkey: this.currentPositionPubkey,
        totalRebalanceCostsUsdc: this.totalRebalanceCostsUsdc,
        realizedIlUsdc: this.realizedIlUsdc,
        realizedFeesUsdc: this.realizedFeesUsdc,
        currentEntry: this.currentEntry,
        needsNewBaseline: this.needsNewBaseline,
      };
      writeFileSync(this.costFilePath, JSON.stringify(state));
    } catch (err) {
      console.error(`[${this.id}] Failed to persist state: ${err}`);
    }
  }
}
