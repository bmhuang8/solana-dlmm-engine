/**
 * analytics/volatility.ts
 *
 * Maintains a rolling window of price samples and computes three volatility metrics:
 *
 *   ATR (Average True Range):
 *     Mean of absolute price changes over the window.
 *     Measures how much SOL price is moving in dollar terms per interval.
 *     e.g. ATR = 0.15 means the price moves ~$0.15 on average each 10s tick.
 *
 *   Directional Bias:
 *     Percentage of ticks where price moved DOWN (negative return).
 *     >60% = bearish trend, <40% = bullish trend, ~50% = choppy/sideways.
 *     Displayed with a ↓ or ↑ arrow.
 *
 *   Bollinger Band Width:
 *     2 * standard deviation / mean (normalized by price level).
 *     Higher = price is more volatile / spread out from its rolling average.
 *     Near zero = price is very stable / ranging tightly.
 */

// ---------------------------------------------------------------------------
// VolatilityTracker class
// ---------------------------------------------------------------------------

/**
 * Stateful volatility tracker — instantiate once and call update() each poll cycle.
 *
 * @param windowSize  Number of price samples to keep (default 60 = 10 min at 10s polling)
 */
export class VolatilityTracker {
  private prices: number[] = [];
  private readonly windowSize: number;

  constructor(windowSize: number = 60) {
    this.windowSize = windowSize;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Add a new price sample to the rolling window.
   * Oldest sample is dropped when the window is full.
   *
   * @param price  Current SOL price in USDC
   */
  update(price: number): void {
    this.prices.push(price);
    if (this.prices.length > this.windowSize) {
      this.prices.shift();
    }
  }

  // ---------------------------------------------------------------------------
  // Getters
  // ---------------------------------------------------------------------------

  /**
   * True when there are at least 2 samples — required for meaningful stats.
   * Returns 0/false for all metrics when not ready.
   */
  get ready(): boolean {
    return this.prices.length >= 2;
  }

  /**
   * Interval volatility: mean absolute price change per poll interval.
   * e.g. 0.15 means the price moves ~$0.15 on average each 10s tick.
   * Returns 0 if fewer than 2 samples.
   */
  get intervalVolatility(): number {
    if (!this.ready) return 0;

    // Compute absolute change for each adjacent pair of prices
    let totalChange = 0;
    for (let i = 1; i < this.prices.length; i++) {
      totalChange += Math.abs(this.prices[i] - this.prices[i - 1]);
    }
    return totalChange / (this.prices.length - 1);
  }

  /**
   * Directional bias: percentage of ticks where price moved downward.
   * Range: 0–100. >60 = bearish trend.
   * Returns 50 (neutral) if fewer than 2 samples.
   */
  get directionalBias(): number {
    if (!this.ready) return 50;

    let negativeCount = 0;
    for (let i = 1; i < this.prices.length; i++) {
      if (this.prices[i] < this.prices[i - 1]) {
        negativeCount++;
      }
    }
    return (negativeCount / (this.prices.length - 1)) * 100;
  }

  /**
   * Arrow indicator for the directional bias.
   * "↓" when more than half the ticks were down moves, "↑" otherwise.
   */
  get biasArrow(): string {
    return this.directionalBias > 50 ? "↓" : "↑";
  }

  /**
   * Bollinger Band width: (2 * std dev) / mean — normalized volatility measure.
   * Higher = more volatile. Near zero = very stable price.
   * Returns 0 if fewer than 2 samples.
   */
  get bollingerWidth(): number {
    if (!this.ready) return 0;

    const mean = this.prices.reduce((sum, p) => sum + p, 0) / this.prices.length;
    if (mean === 0) return 0;

    // Population standard deviation
    const variance =
      this.prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) /
      this.prices.length;
    const stdDev = Math.sqrt(variance);

    return (2 * stdDev) / mean;
  }
}
