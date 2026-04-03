/**
 * hedging/hedgeManager.ts
 *
 * STUB — not yet implemented.
 *
 * Future implementation will:
 *   1. Read current LP delta from deltaCalculator
 *   2. Compare to current hedge size on the exchange
 *   3. If delta has drifted beyond a threshold, resize the short
 *   4. Log all hedge adjustments for audit trail
 *
 * The hedgeManager is the only module that talks to the exchange adapter.
 * All exchange-specific logic is hidden behind the ExchangeAdapter interface.
 */

import type { DeltaExposure, HedgeState, HedgeAction } from "./types";

/**
 * Decide whether the hedge position needs to be adjusted.
 *
 * STUB: Always returns "no action needed" with a note that hedging is not
 * yet implemented. The call site in index.ts is wired up and ready —
 * replacing this stub with a real implementation is all that's needed.
 *
 * @param delta         Current LP position delta exposure
 * @param currentHedge  Current state of the short position on the exchange
 * @returns             Action instruction: open, close, adjust, or none
 */
export function evaluateHedge(
  _delta: DeltaExposure,
  _currentHedge: HedgeState
): HedgeAction {
  console.log("[HEDGE] hedgeManager not implemented — no hedge action taken");
  return {
    action: "none",
    reason: "hedging not implemented",
  };
}
