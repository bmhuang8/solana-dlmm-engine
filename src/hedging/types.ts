/**
 * hedging/types.ts
 *
 * Single source of truth for all hedging-related types.
 * These are imported by analytics/pnl.ts and by the hedging sub-modules.
 * No runtime logic lives here — only interfaces and safe default factories.
 */

// ---------------------------------------------------------------------------
// Core interfaces
// ---------------------------------------------------------------------------

/**
 * The LP position's current directional exposure to SOL price movement.
 * As SOL price rises, the LP position accumulates more USDC and less SOL
 * (it's effectively selling SOL). This tracks that exposure.
 */
export interface DeltaExposure {
  /** Total SOL held across all bins in the LP position */
  solAmount: number;
  /** USD value of the SOL held (solAmount * currentSolPrice) */
  solValueUsdc: number;
  /** Total USDC held across all bins in the LP position */
  usdcAmount: number;
  /**
   * Net directional exposure in USDC terms.
   * Positive = long SOL (unhedged). Near zero = delta neutral.
   */
  netDeltaUsdc: number;
  /** Epoch ms when this snapshot was taken */
  timestamp: number;
}

/**
 * State of the hedge on a perpetuals exchange.
 * The hedge is a short SOL position that offsets the LP's long SOL exposure.
 */
export interface HedgeState {
  /** Which exchange holds the short, e.g. "none", "kraken", "interactive_brokers" */
  exchange: string;
  /** Current short position size in SOL */
  shortSizeSol: number;
  /** Average entry price of the short position in USDC */
  shortEntryPrice: number;
  /** Current unrealized PnL on the short (positive = profitable) */
  unrealizedPnlUsdc: number;
  /** Cumulative funding payments received (+) or paid (-) */
  fundingAccruedUsdc: number;
  /** Epoch ms of last update */
  lastUpdated: number;
}

/**
 * Combined view of the entire portfolio: LP position + hedge = net exposure.
 * When hedging is working correctly, netDeltaUsdc should be near zero.
 */
export interface NetPortfolioState {
  /** Current USDC value of the LP position (tokens only, no fees) */
  lpValueUsdc: number;
  /** Unrealized PnL on the hedge */
  hedgePnlUsdc: number;
  /** Cumulative fees earned by the LP position */
  feesEarnedUsdc: number;
  /** Net directional exposure (LP delta - hedge size). Near zero = delta neutral. */
  netDeltaUsdc: number;
  /** Total portfolio PnL = (LP value + fees + hedge PnL) - entry value */
  totalPnlUsdc: number;
}

/**
 * Instruction from hedgeManager.evaluateHedge() describing what action to take.
 */
export interface HedgeAction {
  action: "open" | "close" | "adjust" | "none";
  /** Target short size in SOL (only relevant for "open" or "adjust") */
  targetSizeSol?: number;
  /** Human-readable explanation of why this action was chosen */
  reason: string;
}

// ---------------------------------------------------------------------------
// Safe default factories
// ---------------------------------------------------------------------------
// These return zeroed-out objects that are safe to use when hedging is disabled
// or before any hedge has been opened.

/**
 * Returns a HedgeState representing "no hedge / hedging disabled".
 */
export function defaultHedgeState(): HedgeState {
  return {
    exchange: "none",
    shortSizeSol: 0,
    shortEntryPrice: 0,
    unrealizedPnlUsdc: 0,
    fundingAccruedUsdc: 0,
    lastUpdated: Date.now(),
  };
}

/**
 * Returns a DeltaExposure with all fields zeroed out.
 * Used as a placeholder before a real delta calculation is available.
 */
export function defaultDeltaExposure(): DeltaExposure {
  return {
    solAmount: 0,
    solValueUsdc: 0,
    usdcAmount: 0,
    netDeltaUsdc: 0,
    timestamp: Date.now(),
  };
}
