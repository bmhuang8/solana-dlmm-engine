/**
 * services/transactionService.ts
 *
 * Single point of contact for all Solana transactions.
 * No other module calls connection.sendRawTransaction() directly.
 *
 * Responsibilities:
 *   - Add priority fees (ComputeBudgetProgram)
 *   - Simulate before send (catches errors cheaply)
 *   - Send + confirm with exponential-backoff retry
 *   - Refresh blockhash on each retry (stale blockhash is the #1 failure cause)
 *   - Support additional signers (e.g. new position keypairs)
 *   - Estimate transaction cost in SOL
 */

import {
  Transaction,
  VersionedTransaction,
  ComputeBudgetProgram,
  Keypair,
  SendOptions,
} from "@solana/web3.js";
import { connection } from "../core/client";
import { getKeypair } from "../core/signer";
import { executionConfig } from "../config/settings";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TransactionResult {
  success: boolean;
  signature?: string;
  error?: string;
  slot?: number;
  attemptNumber: number;
}

export interface SendOpts extends SendOptions {
  /** Extra signers in addition to the main wallet keypair (e.g. position keypair) */
  additionalSigners?: Keypair[];
  /** If false, skip simulation (default: true) */
  simulate?: boolean;
}

// ---------------------------------------------------------------------------
// Priority fee + compute budget
// ---------------------------------------------------------------------------

/**
 * Prepend ComputeBudgetProgram instructions to set priority fee and compute limit.
 * Modifies the transaction in-place and returns it.
 */
export function addPriorityFee(
  tx: Transaction,
  microlamports: number = executionConfig.priorityFeeMicrolamports,
  computeUnits: number = 200_000
): Transaction {
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: microlamports })
  );
  return tx;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/**
 * Simulate a transaction and return estimated compute units and logs.
 * Throws if simulation fails (indicates the tx would fail on-chain).
 */
export async function simulateTransaction(
  tx: Transaction
): Promise<{ computeUnits: number; logs: string[] }> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = getKeypair().publicKey;

  const result = await connection.simulateTransaction(tx, undefined, true);

  if (result.value.err) {
    const logs = result.value.logs ?? [];
    throw new Error(
      `[transactionService] Simulation failed: ${JSON.stringify(result.value.err)}\n` +
        logs.join("\n")
    );
  }

  return {
    computeUnits: result.value.unitsConsumed ?? 200_000,
    logs: result.value.logs ?? [],
  };
}

// ---------------------------------------------------------------------------
// Send + confirm (with retry)
// ---------------------------------------------------------------------------

/**
 * Sign, send, and confirm a single transaction.
 * Retries up to executionConfig.maxRetries times with exponential backoff.
 * Refreshes the blockhash on every attempt to avoid stale-blockhash errors.
 */
export async function sendAndConfirm(
  tx: Transaction,
  opts: SendOpts = {}
): Promise<TransactionResult> {
  const wallet = getKeypair();
  const { additionalSigners = [], simulate = true, ...sendOptions } = opts;
  const maxAttempts = executionConfig.maxRetries + 1;

  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Always fetch a fresh blockhash — stale blockhash is the #1 retry cause
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");

      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;

      if (simulate && attempt === 1) {
        // Only simulate on first attempt — simulation uses the fresh blockhash above
        const simResult = await connection.simulateTransaction(tx, undefined, true);
        if (simResult.value.err) {
          const logs = simResult.value.logs ?? [];
          return {
            success: false,
            error: `Simulation failed: ${JSON.stringify(simResult.value.err)}\n${logs.join("\n")}`,
            attemptNumber: attempt,
          };
        }
      }

      // Sign with wallet + any additional signers (e.g. new position keypair)
      const signers = [wallet, ...additionalSigners];
      tx.sign(...signers);

      const rawTx = tx.serialize();
      const signature = await connection.sendRawTransaction(rawTx, {
        skipPreflight: true, // we already simulated above
        ...sendOptions,
      });

      console.log(
        `[transactionService] Sent tx (attempt ${attempt}): ${signature}`
      );

      // Confirm with block height strategy (more reliable than timeout)
      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      );

      if (confirmation.value.err) {
        throw new Error(
          `Transaction confirmed but failed: ${JSON.stringify(confirmation.value.err)}`
        );
      }

      const slotInfo = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });

      return {
        success: true,
        signature,
        slot: slotInfo?.slot,
        attemptNumber: attempt,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[transactionService] Attempt ${attempt}/${maxAttempts} failed: ${lastError}`
      );

      if (attempt < maxAttempts) {
        const delayMs =
          executionConfig.retryBaseDelayMs * Math.pow(2, attempt - 1);
        console.log(`[transactionService] Retrying in ${delayMs}ms…`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  return {
    success: false,
    error: lastError,
    attemptNumber: executionConfig.maxRetries + 1,
  };
}

// ---------------------------------------------------------------------------
// Sequential multi-transaction send
// ---------------------------------------------------------------------------

/**
 * Send a list of transactions in order. Stops on first failure.
 * Returns results for every attempted transaction.
 */
export async function sendSequential(
  txs: Transaction[],
  opts: SendOpts = {}
): Promise<TransactionResult[]> {
  const results: TransactionResult[] = [];

  for (const tx of txs) {
    const result = await sendAndConfirm(tx, opts);
    results.push(result);

    if (!result.success) {
      console.error(
        `[transactionService] Sequential send aborted after tx failure: ${result.error}`
      );
      break;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// VersionedTransaction send (for Jupiter swap transactions)
// ---------------------------------------------------------------------------

/**
 * Sign and send a Jupiter-built VersionedTransaction.
 * Jupiter returns base64-encoded VersionedTransactions via its /swap endpoint.
 * Unlike legacy Transactions, these are re-signed (not constructed from scratch)
 * so we deserialize, sign with the wallet, and send.
 *
 * Retries with a fresh blockhash on each attempt.
 */
export async function sendAndConfirmVersioned(
  tx: VersionedTransaction,
  additionalSigners: Keypair[] = []
): Promise<TransactionResult> {
  const wallet = getKeypair();
  const maxAttempts = executionConfig.maxRetries + 1;
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Refresh the blockhash in the message before signing
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");
      tx.message.recentBlockhash = blockhash;

      // Sign with wallet + any additional signers
      tx.sign([wallet, ...additionalSigners]);

      const rawTx = tx.serialize();
      const signature = await connection.sendRawTransaction(rawTx, {
        skipPreflight: true,
      });

      console.log(
        `[transactionService] Sent versioned tx (attempt ${attempt}): ${signature}`
      );

      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      );

      if (confirmation.value.err) {
        throw new Error(
          `Versioned tx confirmed but failed: ${JSON.stringify(confirmation.value.err)}`
        );
      }

      const slotInfo = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });

      return {
        success: true,
        signature,
        slot: slotInfo?.slot,
        attemptNumber: attempt,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[transactionService] Versioned attempt ${attempt}/${maxAttempts} failed: ${lastError}`
      );

      if (attempt < maxAttempts) {
        const delayMs =
          executionConfig.retryBaseDelayMs * Math.pow(2, attempt - 1);
        console.log(`[transactionService] Retrying in ${delayMs}ms…`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  return {
    success: false,
    error: lastError,
    attemptNumber: executionConfig.maxRetries + 1,
  };
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the total SOL cost of sending N transactions, including:
 *   - Base fee (5000 lamports per signature per tx)
 *   - Priority fee (priorityFeeMicrolamports × compute units)
 *
 * Returns cost in SOL (not lamports).
 */
export function estimateTransactionCost(txCount: number): number {
  const baseFeePerTx = 5_000; // lamports
  const computeUnitsPerTx = 200_000;
  const priorityFeePerTx =
    (executionConfig.priorityFeeMicrolamports * computeUnitsPerTx) / 1_000_000; // microlamports → lamports

  const totalLamports = txCount * (baseFeePerTx + priorityFeePerTx);
  return totalLamports / 1e9;
}
