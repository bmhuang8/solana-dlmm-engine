/**
 * execution/safetyGates.ts
 *
 * Four safety gates evaluated before every rebalance.
 * Each gate returns { pass: boolean; reason: string }.
 * Gates are evaluated in order and short-circuit on the first failure.
 *
 * Gate evaluation order:
 *   1. Minimum Interval   — enough time since last rebalance
 *   2. Volatility Cooldown — not in post-spike cooldown
 *   3. Out-of-Range Check  — position actually needs rebalancing
 *   4. Fee Gate (3× rule)  — fees earned > 3× estimated tx cost
 *
 * All four must pass for a rebalance to trigger.
 */

import { FeeTracker } from "../analytics/feeTracker";
import { VolatilityTracker } from "../analytics/volatility";
import { PositionState } from "../core/position";
import { ExecutionConfig } from "../config/settings";
import { estimateTransactionCost } from "../services/transactionService";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GateResult {
  pass: boolean;
  reason: string;
}

export interface GateParams {
  // --- ExecutionState fields (from ExecutionRunner) ---
  /** Epoch ms of the last completed rebalance (0 = never rebalanced) */
  lastRebalanceMs: number;
  /** lifetimeFeesUsdc snapshot taken at the last rebalance */
  lastRebalanceFeesUsdc: number;
  /** Epoch ms of the last volatility spike detection */
  lastVolatilitySpikeMs: number;

  // --- Analytics trackers (from StrategyRunner getters) ---
  feeTracker: FeeTracker;
  volatilityTracker: VolatilityTracker;

  // --- Current on-chain state ---
  position: PositionState;

  // --- Market data ---
  /** Current SOL price in USDC (used for fee gate cost estimation) */
  solPrice: number;

  // --- Config ---
  config: ExecutionConfig;
  /** Per-strategy fee gate multiplier override (falls back to config.feeGateMultiplier) */
  feeGateMultiplier?: number;
  /** Per-strategy out-of-range bin threshold override (falls back to config.outOfRangeBinThreshold) */
  outOfRangeBinThreshold?: number;
  /** Per-strategy minimum rebalance interval override (falls back to config.minRebalanceIntervalMs) */
  minRebalanceIntervalMs?: number;
}

export interface CompositeGateResult extends GateResult {
  /** Name of the gate that caused a failure, or "all" on success */
  gateName: string;
  /**
   * Updated lastVolatilitySpikeMs if the volatility gate refreshed the timer.
   * Caller (ExecutionRunner) must persist this value back to ExecutionState.
   */
  updatedSpikeMs?: number;
}

// ---------------------------------------------------------------------------
// Gate 1: Minimum interval
// ---------------------------------------------------------------------------

/**
 * Prevents rapid-fire rebalances during choppy markets.
 * Cheapest check — evaluated first to avoid unnecessary RPC/compute.
 */
export function checkIntervalGate(
  lastRebalanceMs: number,
  minRebalanceIntervalMs: number
): GateResult {
  if (lastRebalanceMs === 0) {
    // Never rebalanced — always pass (first rebalance)
    return { pass: true, reason: "first rebalance" };
  }

  const elapsedMs = Date.now() - lastRebalanceMs;
  const pass = elapsedMs >= minRebalanceIntervalMs;

  if (pass) {
    return { pass: true, reason: `interval ok (${Math.floor(elapsedMs / 1000)}s elapsed)` };
  }

  const remainingSec = Math.ceil((minRebalanceIntervalMs - elapsedMs) / 1000);
  return {
    pass: false,
    reason: `min interval not met — ${remainingSec}s remaining`,
  };
}

// ---------------------------------------------------------------------------
// Gate 2: Volatility cooldown
// ---------------------------------------------------------------------------

/**
 * Prevents rebalancing into fast-moving markets.
 * If Bollinger width exceeds the threshold, the timer is reset.
 * Rebalances are blocked until the timer has been calm for volatilityCooldownMs.
 *
 * Returns `updatedSpikeMs` when the spike timer was refreshed —
 * caller MUST write it back to ExecutionState.lastVolatilitySpikeMs.
 */
export function checkVolatilityGate(
  volatilityTracker: VolatilityTracker,
  lastVolatilitySpikeMs: number,
  config: ExecutionConfig
): GateResult & { updatedSpikeMs?: number } {
  const now = Date.now();
  const bw = volatilityTracker.bollingerWidth;

  let updatedSpikeMs: number | undefined;

  if (bw > config.volatilityCooldownThreshold) {
    // Currently volatile — refresh the spike timer and block
    updatedSpikeMs = now;
    return {
      pass: false,
      reason: `volatility high (Bollinger width ${(bw * 100).toFixed(2)}% > ${(config.volatilityCooldownThreshold * 100).toFixed(2)}% threshold)`,
      updatedSpikeMs,
    };
  }

  // Price is calm now — but check if we're still within the cooldown window
  if (lastVolatilitySpikeMs === 0) {
    return { pass: true, reason: "no volatility spike recorded" };
  }

  const cooldownElapsedMs = now - lastVolatilitySpikeMs;
  const pass = cooldownElapsedMs >= config.volatilityCooldownMs;

  if (pass) {
    const cooldownSec = Math.floor(cooldownElapsedMs / 1000);
    return { pass: true, reason: `volatility cooldown cleared (${cooldownSec}s since spike)` };
  }

  const remainingSec = Math.ceil((config.volatilityCooldownMs - cooldownElapsedMs) / 1000);
  return {
    pass: false,
    reason: `volatility cooldown active — ${remainingSec}s remaining`,
  };
}

// ---------------------------------------------------------------------------
// Gate 3: Out-of-range check
// ---------------------------------------------------------------------------

/**
 * Verifies the position actually needs rebalancing before incurring tx costs.
 * pass=true  → position IS out of range → rebalance warranted
 * pass=false → position still in range → skip
 *
 * A position is considered out of range when the active bin has moved more
 * than `outOfRangeBinThreshold` bins beyond the position edge.
 */
export function checkOutOfRangeGate(
  position: PositionState,
  outOfRangeBinThreshold: number
): GateResult {
  if (!position.found || position.bins.length === 0) {
    // No active position — funds are likely in the wallet after a partial rebalance.
    // Returning pass=true lets Gates 1, 2, 4 decide whether to proceed with deploy.
    return { pass: true, reason: "no active position — deploy needed" };
  }

  const activeBinId = position.activeBinId;
  const minBin = Math.min(...position.bins.map((b) => b.binId));
  const maxBin = Math.max(...position.bins.map((b) => b.binId));

  // Positive when active bin is BELOW the position range
  const binsBelow = minBin - activeBinId;
  // Positive when active bin is ABOVE the position range
  const binsAbove = activeBinId - maxBin;

  const outOfRange =
    binsBelow > outOfRangeBinThreshold || binsAbove > outOfRangeBinThreshold;

  if (outOfRange) {
    const direction = binsBelow > 0 ? "below" : "above";
    const distance = Math.max(binsBelow, binsAbove);
    return {
      pass: true,
      reason: `out of range by ${distance} bin(s) ${direction} (active=${activeBinId}, range=${minBin}–${maxBin})`,
    };
  }

  // Still in range — check how close we are to the edge (for informational logging)
  const binsToEdge = Math.min(activeBinId - minBin, maxBin - activeBinId);
  return {
    pass: false,
    reason: `still in range — ${binsToEdge} bin(s) from edge (active=${activeBinId}, range=${minBin}–${maxBin})`,
  };
}

// ---------------------------------------------------------------------------
// Gate 4: Fee gate (3× rule)
// ---------------------------------------------------------------------------

/**
 * Ensures fees earned since the last rebalance cover the cost of the rebalance
 * by at least `feeGateMultiplier` times.
 *
 * Cost estimate: 3 transactions (withdraw + swap + deposit) × priority fee.
 * solPrice is required to convert the SOL-denominated tx cost to USDC.
 */
export function checkFeeGate(
  feeTracker: FeeTracker,
  lastRebalanceFeesUsdc: number,
  solPrice: number,
  feeGateMultiplier: number
): GateResult {
  const feesSinceLastRebalance =
    feeTracker.lifetimeFeesUsdc - lastRebalanceFeesUsdc;

  // 3 txs: withdraw (1–3 bundled to 1 for cost estimate) + swap + deposit
  const estimatedCostSol = estimateTransactionCost(3);
  const estimatedCostUsdc = estimatedCostSol * solPrice;
  const requiredFeesUsdc = feeGateMultiplier * estimatedCostUsdc;

  const pass = feesSinceLastRebalance >= requiredFeesUsdc;

  if (pass) {
    return {
      pass: true,
      reason:
        `fee gate passed: $${feesSinceLastRebalance.toFixed(4)} earned ≥ ` +
        `${feeGateMultiplier}× $${estimatedCostUsdc.toFixed(4)} cost = $${requiredFeesUsdc.toFixed(4)}`,
    };
  }

  const shortfall = requiredFeesUsdc - feesSinceLastRebalance;
  return {
    pass: false,
    reason:
      `fee gate: $${feesSinceLastRebalance.toFixed(4)} earned < ` +
      `${feeGateMultiplier}× $${estimatedCostUsdc.toFixed(4)} cost (need $${shortfall.toFixed(4)} more)`,
  };
}

// ---------------------------------------------------------------------------
// Composite evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate all four gates in order, short-circuiting on the first failure.
 *
 * Returns a CompositeGateResult:
 *   - pass=true  → all gates passed → rebalance may proceed
 *   - pass=false → gateName identifies which gate blocked
 *   - updatedSpikeMs → if set, caller must write back to ExecutionState
 */
export function evaluateAllGates(params: GateParams): CompositeGateResult {
  const {
    lastRebalanceMs,
    lastRebalanceFeesUsdc,
    lastVolatilitySpikeMs,
    feeTracker,
    volatilityTracker,
    position,
    solPrice,
    config,
    feeGateMultiplier,
    outOfRangeBinThreshold,
    minRebalanceIntervalMs,
  } = params;

  // Gate 1: Minimum interval
  const effectiveIntervalMs = minRebalanceIntervalMs ?? config.minRebalanceIntervalMs;
  const g1 = checkIntervalGate(lastRebalanceMs, effectiveIntervalMs);
  if (!g1.pass) {
    return { ...g1, gateName: "interval" };
  }

  // Gate 2: Volatility cooldown
  const g2 = checkVolatilityGate(volatilityTracker, lastVolatilitySpikeMs, config);
  if (!g2.pass) {
    return { ...g2, gateName: "volatility" };
  }

  // Gate 3: Out-of-range
  const effectiveThreshold = outOfRangeBinThreshold ?? config.outOfRangeBinThreshold;
  const g3 = checkOutOfRangeGate(position, effectiveThreshold);
  if (!g3.pass) {
    return { ...g3, gateName: "range" };
  }

  // Gate 4: Fee gate
  const effectiveMultiplier = feeGateMultiplier ?? config.feeGateMultiplier;
  const g4 = checkFeeGate(
    feeTracker,
    lastRebalanceFeesUsdc,
    solPrice,
    effectiveMultiplier
  );
  if (!g4.pass) {
    return { ...g4, gateName: "fee", updatedSpikeMs: g2.updatedSpikeMs };
  }

  return {
    pass: true,
    reason: "all gates passed",
    gateName: "all",
    updatedSpikeMs: g2.updatedSpikeMs,
  };
}
