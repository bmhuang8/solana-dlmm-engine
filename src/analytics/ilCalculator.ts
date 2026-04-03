/**
 * analytics/ilCalculator.ts
 *
 * Computes true Impermanent Loss (IL) for the LP position.
 *
 * IL baseline: holding the original deposit tokens (initialSol + initialUsdc).
 *   hodlValue = entrySolAmount * currentPrice + entryUsdcAmount
 *   IL = hodlValue - currentPositionValue
 *
 *   - Positive IL = LP is worth LESS than just holding the initial tokens (the AMM
 *     rebalancing mechanism cost you money — the classic IL scenario)
 *   - Near-zero IL = price hasn't moved much, AMM hasn't rebalanced significantly
 *   - Negative IL = LP is worth MORE than holding (rare edge case)
 *
 * This is compared against fees in pnl.ts to answer: "are fees covering IL?"
 * Fees are tracked separately in feeTracker.ts and combined in pnl.ts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Output of calculateIL() */
export interface ILResult {
  /** Current USDC value of the position: (solAmount * solPrice) + usdcAmount */
  currentValueUsdc: number;
  /** What holding the initial tokens would be worth at current price */
  hodlValueUsdc: number;
  /**
   * True IL in USDC: hodlValue - currentValue.
   * Positive = LP underperformed holding the initial tokens (AMM cost you money).
   */
  ilUsdc: number;
  /** IL as a percentage of hodl value */
  ilPercent: number;
}

// ---------------------------------------------------------------------------
// Pure computation — no state, no async
// ---------------------------------------------------------------------------

/**
 * Compute true IL relative to a hold-initial-tokens baseline.
 *
 * @param totalSolAmount   Total SOL currently in the position (human-readable)
 * @param totalUsdcAmount  Total USDC currently in the position (human-readable)
 * @param currentSolPrice  Current SOL price in USDC
 * @param entrySolAmount   SOL tokens at time of deposit (from deposit transaction)
 * @param entryUsdcAmount  USDC tokens at time of deposit (from deposit transaction)
 * @returns                IL result with current value, hodl value, absolute IL, and IL%
 */
export function calculateIL(
  totalSolAmount: number,
  totalUsdcAmount: number,
  currentSolPrice: number,
  entrySolAmount: number,
  entryUsdcAmount: number
): ILResult {
  // Current value of the LP position in USDC terms
  const currentValueUsdc = totalSolAmount * currentSolPrice + totalUsdcAmount;

  // What holding the initial tokens would be worth at the current price
  const hodlValueUsdc = entrySolAmount * currentSolPrice + entryUsdcAmount;

  // True IL = what holding would give us minus what the LP actually gives us
  // Positive = the AMM rebalancing hurt us vs just holding
  const ilUsdc = hodlValueUsdc - currentValueUsdc;

  const ilPercent = hodlValueUsdc > 0
    ? (ilUsdc / hodlValueUsdc) * 100
    : 0;

  return { currentValueUsdc, hodlValueUsdc, ilUsdc, ilPercent };
}
