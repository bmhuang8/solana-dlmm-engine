/**
 * core/priceFeed.ts
 *
 * Fetches the current SOL/USD market price from the Pyth Hermes API.
 * Falls back to the bin-math price (computed from activeBinId) if Pyth fails.
 *
 * The activeBinId is provided by the caller (from the batch fetch result),
 * so this module makes NO RPC calls — only HTTP to Pyth.
 *
 * Market price is preferred over bin price for two reasons:
 *   1. Hedging — perp exchanges price at market, so IL and hedge P&L share the same basis
 *   2. Real-world value — market price reflects true SOL value, not pool-specific state
 */

import { config } from "../config/settings";

// Pyth Hermes API — free, no API key, US-accessible
// Price feed ID: SOL/USD
const PYTH_SOL_USD_ID =
  "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const PYTH_PRICE_URL = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${PYTH_SOL_USD_ID}&parsed=true`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PriceData {
  /** SOL price in USD, e.g. 185.42 — sourced from Pyth market price */
  onChainPrice: number;
  /** The active bin ID at time of fetch (passed in from batch fetch) */
  activeBinId: number;
  /** Where the price came from */
  source: "pyth" | "bin_fallback" | "stale_cache";
  /** Epoch ms when this was fetched */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Stale price cache — used when Pyth is unreachable
// ---------------------------------------------------------------------------

let lastKnownPrice: PriceData | null = null;

// ---------------------------------------------------------------------------
// Pyth market price fetch (HTTP only — no RPC)
// ---------------------------------------------------------------------------

/**
 * Fetch SOL market price from Pyth Hermes API.
 * Returns null on any failure so the caller can fall back to bin price.
 */
async function fetchPythPrice(): Promise<number | null> {
  try {
    const response = await fetch(PYTH_PRICE_URL, {
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      console.warn(`[priceFeed] Pyth API returned ${response.status}`);
      return null;
    }

    const json = (await response.json()) as {
      parsed?: Array<{
        price?: { price?: string; expo?: number };
      }>;
    };

    const parsed = json?.parsed?.[0]?.price;
    if (!parsed?.price || parsed.expo === undefined) {
      console.warn("[priceFeed] Pyth API returned unexpected format");
      return null;
    }

    const price = parseFloat(parsed.price) * Math.pow(10, parsed.expo);
    if (isNaN(price) || price <= 0) {
      console.warn("[priceFeed] Pyth price calculation produced invalid result");
      return null;
    }

    return price;
  } catch (err) {
    console.warn("[priceFeed] Pyth API call failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main fetch function
// ---------------------------------------------------------------------------

/**
 * Fetch the current SOL price. No RPC calls — activeBinId comes from the
 * batch fetch result so the bin-math fallback is free.
 *
 * Priority:
 *   1. Pyth market price (primary)
 *   2. Bin-math price computed from activeBinId (fallback, no RPC needed)
 *   3. Stale cache (last resort if Pyth has been down for multiple cycles)
 *   4. Zero placeholder (if no price has ever been fetched)
 *
 * @param activeBinId  Pool's active bin ID from the current batch fetch
 * @returns Price snapshot with onChainPrice in USD per SOL
 */
export async function fetchPrice(activeBinId: number): Promise<PriceData> {
  const pythPrice = await fetchPythPrice();

  if (pythPrice !== null) {
    const priceData: PriceData = {
      onChainPrice: pythPrice,
      activeBinId,
      source: "pyth",
      timestamp: Date.now(),
    };
    lastKnownPrice = priceData;
    return priceData;
  }

  // Pyth unavailable — fall back to bin-math price (pure computation, no RPC)
  const binPrice = binIdToPrice(activeBinId);
  if (binPrice > 0) {
    console.warn("[priceFeed] Pyth unavailable — using bin-math price as fallback");
    const priceData: PriceData = {
      onChainPrice: binPrice,
      activeBinId,
      source: "bin_fallback",
      timestamp: Date.now(),
    };
    lastKnownPrice = priceData;
    return priceData;
  }

  // Last resort — stale cache
  if (lastKnownPrice) {
    console.warn(
      `[priceFeed] Using stale price from ` +
        `${Math.round((Date.now() - lastKnownPrice.timestamp) / 1000)}s ago: ` +
        `$${lastKnownPrice.onChainPrice.toFixed(2)}`
    );
    return { ...lastKnownPrice, source: "stale_cache" };
  }

  return {
    onChainPrice: 0,
    activeBinId,
    source: "bin_fallback",
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Bin ID to price conversion utility
// ---------------------------------------------------------------------------

/**
 * Convert a DLMM bin ID to a SOL/USDC price using the pool's bin-step formula.
 * This is a pure mathematical approximation — no RPC calls.
 *
 * Formula: price = (1 + binStep/10_000)^binId * 10^(SOL_DECIMALS - USDC_DECIMALS)
 */
export function binIdToPrice(
  binId: number,
  binStep: number = config.binStep
): number {
  const SOL_DECIMALS = 9;
  const USDC_DECIMALS = 6;
  const rawPrice = Math.pow(1 + binStep / 10_000, binId);
  return rawPrice * Math.pow(10, SOL_DECIMALS - USDC_DECIMALS);
}
