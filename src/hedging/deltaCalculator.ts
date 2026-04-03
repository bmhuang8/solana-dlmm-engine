/**
 * hedging/deltaCalculator.ts
 *
 * STUB — not yet implemented.
 *
 * Future implementation will compute the LP position's net delta exposure:
 *   - As SOL price rises, the LP sells SOL into USDC (delta decreases)
 *   - As SOL price falls, the LP buys SOL with USDC (delta increases)
 *   - This tracks that shift so the hedge manager knows how much to short
 */

import type { PositionState } from "../core/position";
import type { DeltaExposure } from "./types";

/**
 * Compute the LP position's current delta exposure to SOL price movement.
 *
 * STUB: Returns the raw position amounts as-is (fully unhedged exposure).
 * A real implementation would account for how delta shifts as price moves
 * through bins, and apply a gamma correction for the current active bin.
 *
 * @param positionState  Current LP position state from core/position.ts
 * @param currentPrice   Current SOL price in USDC
 * @returns              Delta exposure object describing net SOL directional risk
 */
export function calculateDelta(
  positionState: PositionState,
  currentPrice: number
): DeltaExposure {
  console.log("[HEDGE] deltaCalculator not implemented — returning unhedged exposure");

  // Even as a stub, return real position data so the rest of the system
  // has something meaningful to display (just without hedge adjustment)
  return {
    solAmount: positionState.totalSolAmount,
    solValueUsdc: positionState.totalSolAmount * currentPrice,
    usdcAmount: positionState.totalUsdcAmount,
    // Net delta = full SOL value (position is completely unhedged)
    netDeltaUsdc: positionState.totalSolAmount * currentPrice,
    timestamp: Date.now(),
  };
}
