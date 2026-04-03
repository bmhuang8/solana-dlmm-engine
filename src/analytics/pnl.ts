/**
 * analytics/pnl.ts
 *
 * Computes the net P&L of the entire portfolio (LP position + fees + hedge).
 *
 * Formula:
 *   netPnL = positionValue + feesEarned + hedgePnL - entryValue
 *
 * When hedging is disabled (hedgeState not provided or is the default), hedgePnL = 0.
 * When hedging is eventually enabled, pass the real HedgeState from hedgeManager.
 *
 * This number is what the kill switch will eventually read to decide whether
 * to exit the position.
 */

import type { HedgeState } from "../hedging/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Full P&L breakdown for one poll cycle */
export interface PnLResult {
  /** Current USDC value of the LP position (tokens only, no fees) */
  positionValueUsdc: number;
  /** Cumulative fees earned since tracking started (USDC) */
  feesEarnedUsdc: number;
  /**
   * Unrealized P&L on the hedge short position (USDC).
   * Always 0 when hedging is disabled.
   */
  hedgePnlUsdc: number;
  /**
   * Net P&L vs the USDC-hold baseline.
   * = positionValueUsdc + feesEarnedUsdc + hedgePnlUsdc - entryValueUsdc
   * Positive = we're ahead of holding USDC. Negative = we're behind.
   */
  netPnlUsdc: number;
  /** Net P&L as a percentage of entry value */
  netPnlPercent: number;
}

// ---------------------------------------------------------------------------
// Pure computation — no state, no async
// ---------------------------------------------------------------------------

/**
 * Compute net portfolio P&L for one poll cycle.
 *
 * @param positionValueUsdc  Current USDC value of LP tokens (from ilCalculator.currentValueUsdc)
 * @param feesEarnedUsdc     Cumulative fees since tracking started (from feeTracker.totalFeesUsdc)
 * @param entryValueUsdc     USDC value at position open (from config.entry.valueUsdc)
 * @param hedgeState         Optional: current hedge state (from hedgeManager / defaultHedgeState)
 * @returns                  Full P&L breakdown
 */
export function calculatePnL(
  positionValueUsdc: number,
  feesEarnedUsdc: number,
  entryValueUsdc: number,
  hedgeState?: HedgeState
): PnLResult {
  // Hedge P&L is 0 when not provided (hedging disabled) or when exchange is "none"
  const hedgePnlUsdc = hedgeState?.unrealizedPnlUsdc ?? 0;

  const netPnlUsdc = positionValueUsdc + feesEarnedUsdc + hedgePnlUsdc - entryValueUsdc;

  const netPnlPercent = entryValueUsdc > 0
    ? (netPnlUsdc / entryValueUsdc) * 100
    : 0;

  return {
    positionValueUsdc,
    feesEarnedUsdc,
    hedgePnlUsdc,
    netPnlUsdc,
    netPnlPercent,
  };
}
