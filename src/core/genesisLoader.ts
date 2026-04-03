/**
 * core/genesisLoader.ts
 *
 * Recovers the true genesis entry state for an LP position from on-chain
 * transaction history + Pyth historical prices. This lets the bot compute
 * accurate IL and P&L from the actual day-one deposit, regardless of when
 * the bot was started.
 *
 * Algorithm:
 *   1. getSignaturesForAddress(positionPubkey) — all transactions, newest first.
 *      The last entry is the creation/first-deposit transaction.
 *   2. getTransaction(sig) — full transaction with pre/post token balances.
 *   3. Sum all positive token balance deltas per mint.
 *      Positive delta = tokens flowing INTO an account = deposited into pool.
 *      This avoids needing to know the pool vault addresses.
 *   4. Fetch the SOL/USD price at block time from Pyth Hermes historical API.
 *   5. Return EntryState { timestamp, solPrice, solAmount, usdcAmount, valueUsdc }.
 *
 * Returns null if transaction history is unavailable or parsing fails.
 * Callers should fall back to the current on-chain state in that case.
 */

import { PublicKey, Connection } from "@solana/web3.js";
import type { EntryState } from "../runners/strategyRunner";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const PYTH_SOL_USD_ID =
  "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the genesis entry state from on-chain transaction history.
 *
 * Makes 2 RPC calls (getSignaturesForAddress + getTransaction) and
 * 1 HTTP call (Pyth historical price). Only runs once at startup per strategy.
 *
 * @param connection     Active Solana connection
 * @param positionPubkey The on-chain position account pubkey
 * @returns EntryState populated from the actual deposit transaction, or null on failure
 */
export async function loadGenesisFromChain(
  connection: Connection,
  positionPubkey: PublicKey
): Promise<EntryState | null> {
  // -------------------------------------------------------------------------
  // Step 1: Find the creation/deposit transaction (oldest signature)
  // -------------------------------------------------------------------------

  let signatures;
  try {
    // getSignaturesForAddress returns newest-first; last entry = creation tx
    signatures = await connection.getSignaturesForAddress(positionPubkey, {
      limit: 1000,
    });
  } catch (err) {
    console.warn("[genesis] getSignaturesForAddress failed:", err);
    return null;
  }

  if (signatures.length === 0) {
    console.warn("[genesis] No transaction history found for position.");
    return null;
  }

  const creationSig = signatures[signatures.length - 1];
  const blockTimeSec = creationSig.blockTime;

  if (!blockTimeSec) {
    console.warn("[genesis] Creation transaction has no blockTime.");
    return null;
  }

  // -------------------------------------------------------------------------
  // Step 2: Fetch full transaction with token balance snapshots
  // -------------------------------------------------------------------------

  let tx;
  try {
    tx = await connection.getTransaction(creationSig.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
  } catch (err) {
    console.warn("[genesis] getTransaction failed:", err);
    return null;
  }

  if (!tx?.meta) {
    console.warn("[genesis] Transaction metadata not available.");
    return null;
  }

  // -------------------------------------------------------------------------
  // Step 3: Parse deposit amounts from token balance changes
  //
  // Strategy: sum ALL positive deltas per mint across the transaction.
  //   - Positive delta on an account = tokens flowed INTO that account
  //   - The pool vaults received exactly the deposited amounts
  //   - This approach doesn't require knowing vault addresses
  //
  // preTokenBalances may omit accounts that had zero balance before the tx,
  // so treat a missing pre-entry as 0.
  // -------------------------------------------------------------------------

  const preByIndex = new Map(
    (tx.meta.preTokenBalances ?? []).map((b) => [b.accountIndex, b])
  );

  const inflows = new Map<string, number>();

  for (const post of tx.meta.postTokenBalances ?? []) {
    const pre = preByIndex.get(post.accountIndex);
    const preAmt = pre?.uiTokenAmount?.uiAmount ?? 0;
    const postAmt = post.uiTokenAmount?.uiAmount ?? 0;
    const delta = postAmt - preAmt;

    if (delta > 0) {
      inflows.set(post.mint, (inflows.get(post.mint) ?? 0) + delta);
    }
  }

  const solAmount = inflows.get(WSOL_MINT) ?? 0;
  const usdcAmount = inflows.get(USDC_MINT) ?? 0;

  if (solAmount === 0 && usdcAmount === 0) {
    console.warn(
      "[genesis] Could not parse deposit amounts from transaction. " +
        "The deposit may have used native SOL without a WSOL token account — " +
        "falling back to current position state."
    );
    return null;
  }

  // -------------------------------------------------------------------------
  // Step 4: Fetch historical SOL price from Pyth at the deposit block time
  // -------------------------------------------------------------------------

  const solPrice = await fetchPythHistoricalPrice(blockTimeSec);

  if (!solPrice) {
    console.warn(
      "[genesis] Pyth historical price unavailable — falling back to current state."
    );
    return null;
  }

  const valueUsdc = usdcAmount + solAmount * solPrice;

  return {
    timestamp: blockTimeSec * 1000,
    solPrice,
    solAmount,
    usdcAmount,
    valueUsdc,
  };
}

// ---------------------------------------------------------------------------
// Pyth historical price
// ---------------------------------------------------------------------------

/**
 * Fetch the SOL/USD price from Pyth Hermes at a specific historical timestamp.
 *
 * Pyth Hermes serves historical prices via:
 *   GET /v2/updates/price/{publish_time}?ids[]=<id>&parsed=true
 *
 * @param timestampSeconds  Unix timestamp in seconds (e.g. from transaction blockTime)
 * @returns SOL price in USD, or null if unavailable
 */
async function fetchPythHistoricalPrice(
  timestampSeconds: number
): Promise<number | null> {
  const url =
    `https://hermes.pyth.network/v2/updates/price/${timestampSeconds}` +
    `?ids[]=${PYTH_SOL_USD_ID}&parsed=true`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });

    if (!response.ok) {
      console.warn(
        `[genesis] Pyth historical API returned ${response.status} for timestamp ${timestampSeconds}`
      );
      return null;
    }

    const json = (await response.json()) as {
      parsed?: Array<{
        price?: { price?: string; expo?: number };
      }>;
    };

    const parsed = json?.parsed?.[0]?.price;
    if (!parsed?.price || parsed.expo === undefined) {
      console.warn("[genesis] Pyth historical response has unexpected format.");
      return null;
    }

    const price = parseFloat(parsed.price) * Math.pow(10, parsed.expo);
    return price > 0 ? price : null;
  } catch (err) {
    console.warn("[genesis] Pyth historical price fetch failed:", err);
    return null;
  }
}
