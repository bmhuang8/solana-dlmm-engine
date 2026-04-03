/**
 * analytics/feeTracker.ts
 *
 * Tracks cumulative fee accrual across poll cycles, including claimed fees.
 *
 * How fees work in DLMM:
 *   - Fees accumulate on-chain in the position account as feeX (SOL) and feeY (USDC).
 *   - They are NOT auto-compounded — they must be manually claimed (or auto-claimed
 *     during a rebalance).
 *   - When fees are claimed, the on-chain feeX/feeY reset to 0.
 *
 * Claim detection:
 *   - Raw token amounts (feeX, feeY) only ever increase while fees accumulate.
 *   - Any drop in either raw amount between two consecutive cycles = a claim occurred.
 *   - The dropped amount is added to claimedFeesUsdc so it is never lost from the total.
 *
 * Use lifetimeFeesUsdc (not totalFeesUsdc) for P&L calculations.
 */

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** One data point in the rolling rate window */
interface FeeSnapshot {
  timestamp: number;
  lifetimeFeesUsdc: number;
}

// ---------------------------------------------------------------------------
// FeeTracker class
// ---------------------------------------------------------------------------

/**
 * Stateful fee tracker — instantiate once and call update() each poll cycle.
 * All fee amounts are in human-readable USDC terms.
 */
export class FeeTracker {
  private currentFeeX: number = 0;
  private currentFeeY: number = 0;
  private currentSolPrice: number = 0;

  /** Raw fee token amounts from the previous cycle — used for claim detection */
  private prevFeeX: number = -1; // -1 = not yet initialized
  private prevFeeY: number = -1;

  /** Cumulative USDC value of all fees that have been claimed off-chain */
  private claimedFeesUsdc: number = 0;

  // Rolling window for rate calculation (max 60 entries = 5 min at 5s polling)
  private readonly windowSize = 60;
  private snapshots: FeeSnapshot[] = [];

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Call this every poll cycle with the latest fee values from the position.
   *
   * @param feeX      Accrued SOL fees currently in the position (human-readable SOL)
   * @param feeY      Accrued USDC fees currently in the position (human-readable USDC)
   * @param solPrice  Current SOL price in USDC
   */
  update(feeX: number, feeY: number, solPrice: number): void {
    // -----------------------------------------------------------------------
    // Claim detection: if either raw token amount dropped, fees were claimed.
    // Add the claimed portion (at current price) to the lifetime accumulator.
    // -----------------------------------------------------------------------
    if (this.prevFeeX >= 0) {
      const claimedX = Math.max(0, this.prevFeeX - feeX);
      const claimedY = Math.max(0, this.prevFeeY - feeY);
      if (claimedX > 1e-9 || claimedY > 1e-9) {
        const claimedUsdc = claimedX * solPrice + claimedY;
        this.claimedFeesUsdc += claimedUsdc;
        console.log(
          `[fees] Claim detected: +$${claimedUsdc.toFixed(4)} locked into lifetime fees ` +
            `(total claimed: $${this.claimedFeesUsdc.toFixed(4)})`
        );
      }
    }

    this.prevFeeX = feeX;
    this.prevFeeY = feeY;
    this.currentFeeX = feeX;
    this.currentFeeY = feeY;
    this.currentSolPrice = solPrice;

    // Snapshot uses lifetimeFeesUsdc so the rate isn't distorted by claims
    this.snapshots.push({ timestamp: Date.now(), lifetimeFeesUsdc: this.lifetimeFeesUsdc });
    if (this.snapshots.length > this.windowSize) this.snapshots.shift();
  }

  // ---------------------------------------------------------------------------
  // Getters
  // ---------------------------------------------------------------------------

  /**
   * Unclaimed fees currently sitting in the position account (USDC equivalent).
   * Resets toward 0 on every claim — use lifetimeFeesUsdc for P&L.
   */
  get totalFeesUsdc(): number {
    return this.currentFeeX * this.currentSolPrice + this.currentFeeY;
  }

  /**
   * All fees ever earned: unclaimed (in position) + claimed (sent to wallet).
   * This is the value to use for P&L and F/IL calculations.
   */
  get lifetimeFeesUsdc(): number {
    return this.claimedFeesUsdc + this.totalFeesUsdc;
  }

  /**
   * Rolling fee accrual rate in USDC per minute, averaged over the last 5 minutes.
   * Returns 0 if there aren't enough data points yet.
   */
  /** Last observed raw SOL fee amount — used by orchestrator to exclude from re-deploy */
  get lastFeeX(): number {
    return this.currentFeeX;
  }

  /** Last observed raw USDC fee amount — used by orchestrator to exclude from re-deploy */
  get lastFeeY(): number {
    return this.currentFeeY;
  }

  /**
   * Reset tracker state for a new position (after rebalance).
   * The caller is responsible for saving claimedFeesUsdc as "realized fees"
   * before calling this.
   */
  reset(): void {
    this.currentFeeX = 0;
    this.currentFeeY = 0;
    this.currentSolPrice = 0;
    this.prevFeeX = -1;
    this.prevFeeY = -1;
    this.claimedFeesUsdc = 0;
    this.snapshots = [];
  }

  get feeRatePerMinute(): number {
    if (this.snapshots.length < 2) return 0;

    const oldest = this.snapshots[0];
    const newest = this.snapshots[this.snapshots.length - 1];

    const deltaFeesUsdc = newest.lifetimeFeesUsdc - oldest.lifetimeFeesUsdc;
    const deltaMinutes = (newest.timestamp - oldest.timestamp) / 60_000;

    if (deltaMinutes <= 0) return 0;
    return deltaFeesUsdc / deltaMinutes;
  }
}
