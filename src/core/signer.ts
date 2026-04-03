/**
 * core/signer.ts
 *
 * Loads the wallet keypair from the WALLET_PRIVATE_KEY env var.
 * Only called when EXECUTION_ENABLED=true — never touched in read-only mode.
 *
 * Supports two private key formats:
 *   - Base58 string (Phantom export)
 *   - JSON byte array string (Solana CLI default, e.g. "[12,34,...]")
 */

import { Keypair, PublicKey } from "@solana/web3.js";

// bs58 v4 ships no type declarations — require with explicit typing
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bs58 = require("bs58") as { decode: (s: string) => Uint8Array };

let keypair: Keypair | null = null;

/**
 * Load the wallet keypair from WALLET_PRIVATE_KEY.
 * Throws immediately if the env var is missing or unparseable.
 * Call once during startup (after executionConfig.enabled check).
 */
export function initializeSigner(): void {
  const raw = process.env["WALLET_PRIVATE_KEY"];
  if (!raw || raw.trim() === "") {
    throw new Error(
      "[signer] WALLET_PRIVATE_KEY is not set. " +
        "Add it to .env before enabling execution mode."
    );
  }

  const trimmed = raw.trim();

  try {
    if (trimmed.startsWith("[")) {
      // JSON byte array format: [12, 34, 56, ...]
      const bytes = JSON.parse(trimmed) as number[];
      keypair = Keypair.fromSecretKey(Uint8Array.from(bytes));
    } else {
      // Base58 format (Phantom / Backpack export)
      keypair = Keypair.fromSecretKey(bs58.decode(trimmed));
    }
  } catch (err) {
    throw new Error(
      `[signer] Failed to parse WALLET_PRIVATE_KEY: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  console.log(`[signer] Wallet loaded: ${keypair.publicKey.toBase58()}`);
}

/**
 * Return the loaded Keypair. Throws if initializeSigner() has not been called.
 */
export function getKeypair(): Keypair {
  if (!keypair) {
    throw new Error(
      "[signer] Keypair not initialized. Call initializeSigner() first."
    );
  }
  return keypair;
}

/**
 * Convenience getter for the wallet's public key.
 */
export function getWalletPubkey(): PublicKey {
  return getKeypair().publicKey;
}
