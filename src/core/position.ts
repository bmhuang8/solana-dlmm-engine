/**
 * core/position.ts
 *
 * Shared types for LP position state.
 *
 * Fetch logic has moved to core/batchFetcher.ts, which issues a single
 * getMultipleAccountsInfo call per cycle covering the pool, clock, and
 * all strategy positions at once.
 *
 * These types are imported by analytics/, hedging/, and runners/.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single bin inside the LP position range */
export interface BinEntry {
  binId: number;
  /** Raw X-amount string from the SDK (used for reference) */
  liquidity: string;
  /** SOL amount in this bin (decimal-adjusted, human-readable) */
  solAmount: number;
  /** USDC amount in this bin (decimal-adjusted, human-readable) */
  usdcAmount: number;
}

/**
 * Snapshot of one LP position at a given point in time.
 * All token amounts are in human-readable units (SOL, USDC) — not lamports.
 */
export interface PositionState {
  /** False when the position account was not found on-chain */
  found: boolean;
  /** The pool's currently active bin ID at time of fetch */
  activeBinId: number;
  /** Per-bin breakdown of liquidity and token amounts */
  bins: BinEntry[];
  /** Total SOL across all bins (sum of bins[].solAmount) */
  totalSolAmount: number;
  /** Total USDC across all bins (sum of bins[].usdcAmount) */
  totalUsdcAmount: number;
  /**
   * Accrued but unclaimed SOL fees.
   * NOTE: fee fields can be null/undefined in some SDK versions (issue #245).
   * Defaults to 0 when not available.
   */
  feeX: number;
  /** Accrued but unclaimed USDC fees */
  feeY: number;
  /** Epoch ms when this snapshot was taken */
  lastUpdated: number;
}
