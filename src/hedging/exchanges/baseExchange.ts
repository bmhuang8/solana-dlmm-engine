/**
 * hedging/exchanges/baseExchange.ts
 *
 * Abstract interface that every exchange integration must implement.
 * This ensures we can swap between Kraken, Interactive Brokers, or any other
 * venue without changing the hedge manager logic — just plug in a new adapter.
 *
 * NO concrete implementation lives here. This is the contract only.
 */

import type { HedgeState } from "../types";

/**
 * Any future exchange integration must implement this interface.
 *
 * Workflow for opening/managing a hedge:
 *   1. connect()         — authenticate and establish session
 *   2. getPosition()     — read current short size and PnL
 *   3. openShort()       — open a new short position
 *   4. adjustShort()     — resize existing short to match new delta
 *   5. closeShort()      — fully close the short
 *   6. getFundingRate()  — read the current hourly funding rate
 *   7. disconnect()      — clean up the session
 */
export interface ExchangeAdapter {
  /** Human-readable name of the exchange, e.g. "kraken" */
  name: string;

  /** Authenticate and establish a connection to the exchange */
  connect(): Promise<void>;

  /** Read the current state of the short position on this exchange */
  getPosition(): Promise<HedgeState>;

  /**
   * Open a new short position.
   * @param sizeSol  Amount of SOL to short
   * @returns        Order ID from the exchange
   */
  openShort(sizeSol: number): Promise<string>;

  /**
   * Partially close the short position (reduce size).
   * @param sizeSol  Amount of SOL to remove from the short
   * @returns        Order ID from the exchange
   */
  closeShort(sizeSol: number): Promise<string>;

  /**
   * Resize the short to exactly newSizeSol (open or close the difference).
   * @param newSizeSol  Target total short size in SOL
   * @returns           Order ID from the exchange
   */
  adjustShort(newSizeSol: number): Promise<string>;

  /**
   * Get the current hourly funding rate as a decimal.
   * Positive = longs pay shorts (profitable for our hedge).
   * Negative = shorts pay longs (costs us money).
   * @returns  Funding rate, e.g. 0.0001 = 0.01% per hour
   */
  getFundingRate(): Promise<number>;

  /** Close the exchange session cleanly */
  disconnect(): Promise<void>;
}
