/**
 * core/client.ts
 *
 * Creates and exports the Solana connection and DLMM pool instance.
 * Call initializeClient() once at startup before anything else.
 * The heartbeat checks that the RPC is responsive every 30 seconds.
 */

import { Connection, PublicKey, ParsedAccountData } from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";
import { config } from "../config/settings";

// ---------------------------------------------------------------------------
// Module-level singletons
// These are assigned by initializeClient() and used by position.ts / priceFeed.ts
// ---------------------------------------------------------------------------

/** Raw Solana JSON-RPC connection */
export let connection: Connection;

/** Initialized DLMM pool instance for our SOL/USDC pool */
export let dlmmPool: DLMM;

// Interval handle so we can clear the heartbeat on shutdown
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Connect to Solana and initialize the DLMM pool instance.
 * Must be called (and awaited) before fetchPosition() or fetchPrice().
 *
 * Throws if the RPC or SDK initialization fails — caller should catch and exit.
 */
export async function initializeClient(): Promise<void> {
  // Use "confirmed" commitment — fast enough for monitoring, doesn't need finalized
  connection = new Connection(config.rpcUrl, "confirmed");

  console.log(`[client] Connecting to RPC: ${config.rpcUrl}`);
  console.log(`[client] Loading pool: ${config.poolPubkey.toBase58()}`);

  // DLMM.create() fetches the pool account and builds the in-memory pool object
  dlmmPool = await DLMM.create(connection, config.poolPubkey);

  console.log("[client] DLMM pool loaded successfully.");
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/**
 * Start a background interval that pings the RPC every 30 seconds.
 * Logs a warning if the RPC is slow (>2s) or unresponsive.
 *
 * @returns  The interval handle — pass to stopHeartbeat() on shutdown.
 */
export function startHeartbeat(): ReturnType<typeof setInterval> {
  heartbeatTimer = setInterval(async () => {
    const start = Date.now();
    try {
      await connection.getSlot();
      const latencyMs = Date.now() - start;

      if (latencyMs > 2_000) {
        console.warn(
          `[heartbeat] WARNING: RPC latency is high (${latencyMs}ms). ` +
            `Consider switching to a private RPC (Helius, QuickNode).`
        );
      }
    } catch (err) {
      console.error("[heartbeat] ERROR: RPC ping failed:", err);
    }
  }, config.heartbeatIntervalMs);

  return heartbeatTimer;
}

/**
 * Stop the heartbeat interval. Call this during clean shutdown.
 */
export function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Wallet balance helpers (used by execution engine)
// ---------------------------------------------------------------------------

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * Return the SOL balance of a wallet in whole SOL (not lamports).
 */
export async function getWalletSolBalance(walletPubkey: PublicKey): Promise<number> {
  const lamports = await connection.getBalance(walletPubkey, "confirmed");
  return lamports / 1e9;
}

/**
 * Return the USDC token balance of a wallet in whole USDC (not micro-USDC).
 * Returns 0 if no USDC token account exists.
 */
export async function getWalletUsdcBalance(walletPubkey: PublicKey): Promise<number> {
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    walletPubkey,
    { mint: new PublicKey(USDC_MINT) },
    "confirmed"
  );

  if (tokenAccounts.value.length === 0) return 0;

  const parsed = tokenAccounts.value[0].account.data as ParsedAccountData;
  return parsed.parsed.info.tokenAmount.uiAmount as number ?? 0;
}
