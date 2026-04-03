/**
 * services/jupiterService.ts
 *
 * Jupiter V6 REST API integration — no npm dependency, native fetch only.
 *
 * Jupiter is used for the SOL↔USDC swap step during rebalancing.
 * It aggregates across 20+ DEXs for better routing than the pool's built-in swap.
 *
 * Jupiter V6 returns VersionedTransaction (not legacy Transaction).
 * Use transactionService.sendAndConfirmVersioned() to send the swap.
 */

import { VersionedTransaction } from "@solana/web3.js";
import { executionConfig } from "../config/settings";
import { getWalletPubkey } from "../core/signer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Tolerance band: skip swap if already within ±BALANCE_TOLERANCE of 50/50 */
const BALANCE_TOLERANCE = 0.02; // 2%

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw response from GET /quote */
export interface SwapQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
  /** Preserved for POST /swap */
  _rawQuote: Record<string, unknown>;
}

/** Direction of the balancing swap, or "none" if already balanced */
export type SwapDirection = "sol_to_usdc" | "usdc_to_sol" | "none";

export interface BalancingSwapParams {
  direction: SwapDirection;
  /** Human-readable amount in the input token's native unit */
  amount: number;
  /** Amount in smallest unit (lamports or micro-USDC) as a string for API calls */
  amountSmallestUnit: string;
  /** For logging: "SOL→USDC" or "USDC→SOL" */
  description: string;
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

/**
 * Fetch a swap quote from Jupiter.
 *
 * @param inputMint  - Input token mint address
 * @param outputMint - Output token mint address
 * @param amount     - Amount in smallest unit (lamports / micro-USDC) as a string
 * @param slippageBps - Max slippage in basis points (e.g. 50 = 0.5%)
 */
export async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number = executionConfig.maxSlippageBps
): Promise<SwapQuote> {
  const baseUrl = executionConfig.jupiterApiUrl;
  const url =
    `${baseUrl}/quote` +
    `?inputMint=${inputMint}` +
    `&outputMint=${outputMint}` +
    `&amount=${amount}` +
    `&slippageBps=${slippageBps}`;

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `[jupiterService] Quote failed (${res.status}): ${body}`
    );
  }

  const raw = (await res.json()) as Record<string, unknown>;

  return {
    inputMint: raw["inputMint"] as string,
    inAmount: raw["inAmount"] as string,
    outputMint: raw["outputMint"] as string,
    outAmount: raw["outAmount"] as string,
    otherAmountThreshold: raw["otherAmountThreshold"] as string,
    swapMode: raw["swapMode"] as string,
    slippageBps: raw["slippageBps"] as number,
    priceImpactPct: raw["priceImpactPct"] as string,
    routePlan: raw["routePlan"] as unknown[],
    _rawQuote: raw,
  };
}

// ---------------------------------------------------------------------------
// Swap transaction
// ---------------------------------------------------------------------------

/**
 * Build a swap transaction from a quote.
 *
 * Jupiter returns a base64-encoded VersionedTransaction.
 * The caller must sign and send it via transactionService.sendAndConfirmVersioned().
 *
 * Returns the deserialized VersionedTransaction and the expected output amount.
 */
export async function buildSwapTransaction(quote: SwapQuote): Promise<{
  transaction: VersionedTransaction;
  expectedOutAmount: string;
}> {
  const baseUrl = executionConfig.jupiterApiUrl;
  const userPublicKey = getWalletPubkey().toBase58();

  const res = await fetch(`${baseUrl}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote._rawQuote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      // Jupiter handles priority fees internally — don't double-add them
      dynamicComputeUnitLimit: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `[jupiterService] Swap build failed (${res.status}): ${body}`
    );
  }

  const json = (await res.json()) as Record<string, unknown>;
  const swapTransactionB64 = json["swapTransaction"] as string;

  if (!swapTransactionB64) {
    throw new Error("[jupiterService] Swap response missing swapTransaction field");
  }

  // Deserialize the base64-encoded VersionedTransaction
  const swapTransactionBuf = Buffer.from(swapTransactionB64, "base64");
  const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

  return {
    transaction,
    expectedOutAmount: quote.outAmount,
  };
}

// ---------------------------------------------------------------------------
// Price impact guard
// ---------------------------------------------------------------------------

/**
 * Return true if the quote's price impact exceeds the given threshold.
 * Caller should abort the swap if this returns true.
 *
 * @param quote     - The quote to inspect
 * @param maxPct    - Maximum acceptable price impact as a decimal (e.g. 0.01 = 1%)
 */
export function isPriceImpactTooHigh(
  quote: SwapQuote,
  maxPct: number = 0.01
): boolean {
  const impact = parseFloat(quote.priceImpactPct);
  return !isNaN(impact) && impact > maxPct;
}

// ---------------------------------------------------------------------------
// Balancing swap calculation (pure math — no RPC or HTTP)
// ---------------------------------------------------------------------------

/**
 * Calculate the swap needed to achieve a 50/50 SOL/USDC split by value.
 *
 * Applies a ±BALANCE_TOLERANCE (2%) band — if already within range, returns
 * direction="none" to skip the swap.
 *
 * @param solBalance  - Available SOL (not reserved for fees)
 * @param usdcBalance - Available USDC
 * @param solPrice    - Current SOL price in USDC
 */
export function calculateBalancingSwap(
  solBalance: number,
  usdcBalance: number,
  solPrice: number
): BalancingSwapParams {
  const totalValueUsdc = solBalance * solPrice + usdcBalance;
  const targetPerSideUsdc = totalValueUsdc / 2;

  const currentSolValueUsdc = solBalance * solPrice;

  // How far from 50/50 are we?
  const deviation = Math.abs(currentSolValueUsdc - targetPerSideUsdc) / totalValueUsdc;

  if (deviation <= BALANCE_TOLERANCE) {
    return {
      direction: "none",
      amount: 0,
      amountSmallestUnit: "0",
      description: "already balanced (within 2%)",
    };
  }

  if (currentSolValueUsdc > targetPerSideUsdc) {
    // Too much SOL — sell SOL for USDC
    const excessUsdc = currentSolValueUsdc - targetPerSideUsdc;
    const excessSol = excessUsdc / solPrice;
    const lamports = Math.floor(excessSol * 1e9);

    return {
      direction: "sol_to_usdc",
      amount: excessSol,
      amountSmallestUnit: lamports.toString(),
      description: `SOL→USDC: sell ${excessSol.toFixed(4)} SOL (${excessUsdc.toFixed(2)} USDC excess)`,
    };
  } else {
    // Too much USDC — sell USDC for SOL
    const excessUsdc = targetPerSideUsdc - currentSolValueUsdc;
    const microUsdc = Math.floor(excessUsdc * 1e6);

    return {
      direction: "usdc_to_sol",
      amount: excessUsdc,
      amountSmallestUnit: microUsdc.toString(),
      description: `USDC→SOL: sell ${excessUsdc.toFixed(2)} USDC`,
    };
  }
}

// ---------------------------------------------------------------------------
// Token mint helpers (re-exported for orchestrator convenience)
// ---------------------------------------------------------------------------

export { SOL_MINT, USDC_MINT };
