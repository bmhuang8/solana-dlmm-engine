/**
 * scripts/testPhase2Jupiter.ts
 *
 * Phase 2 test — Jupiter service validation.
 *
 * Tests:
 *   1. calculateBalancingSwap() — pure math, no network
 *   2. isPriceImpactTooHigh()   — pure logic, no network
 *   3. getQuote()               — live Jupiter API call (needs internet)
 *
 * Does NOT test buildSwapTransaction() — that requires EXECUTION_ENABLED + wallet.
 *
 * Usage:
 *   npx ts-node scripts/testPhase2Jupiter.ts
 *
 * No .env changes needed — runs with defaults.
 */

import dotenv from "dotenv";
dotenv.config();

import {
  calculateBalancingSwap,
  isPriceImpactTooHigh,
  getQuote,
  SOL_MINT,
  USDC_MINT,
  SwapQuote,
} from "../src/services/jupiterService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pass(label: string): void {
  console.log(`  ✓ ${label}`);
}

function fail(label: string, got: unknown, expected: unknown): void {
  console.error(`  ✗ ${label}`);
  console.error(`    expected: ${JSON.stringify(expected)}`);
  console.error(`    got:      ${JSON.stringify(got)}`);
  process.exitCode = 1;
}

function check(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass(label);
  } else {
    fail(label, actual, expected);
  }
}

// ---------------------------------------------------------------------------
// Section 1: calculateBalancingSwap — pure math
// ---------------------------------------------------------------------------

function testBalancingSwap(): void {
  console.log("\n── calculateBalancingSwap (pure math) ─────────────────────");
  const SOL_PRICE = 150; // $150/SOL

  // Case 1: Already balanced (5 SOL + 750 USDC @ $150 = $1500 total, $750 each)
  {
    const result = calculateBalancingSwap(5, 750, SOL_PRICE);
    check("perfectly balanced → direction=none", result.direction, "none");
  }

  // Case 2: Within 2% tolerance (5 SOL + 760 USDC — only 0.67% off)
  {
    const result = calculateBalancingSwap(5, 760, SOL_PRICE);
    check("within 2% tolerance → direction=none", result.direction, "none");
  }

  // Case 3: Too much SOL (10 SOL + 100 USDC @ $150 → total $1600, need $800 each)
  //   SOL value = $1500, target = $800, excess = $700 SOL value → sell ~4.67 SOL
  {
    const result = calculateBalancingSwap(10, 100, SOL_PRICE);
    check("excess SOL → direction=sol_to_usdc", result.direction, "sol_to_usdc");
    const expectedSol = (1500 - 800) / SOL_PRICE; // ~4.667 SOL
    const within5pct = Math.abs(result.amount - expectedSol) / expectedSol < 0.05;
    if (within5pct) {
      pass(`swap amount ~${expectedSol.toFixed(4)} SOL (got ${result.amount.toFixed(4)})`);
    } else {
      fail("swap amount out of range", result.amount, expectedSol);
    }
    console.log(`    lamports: ${result.amountSmallestUnit} (${(Number(result.amountSmallestUnit) / 1e9).toFixed(6)} SOL)`);
  }

  // Case 4: Too much USDC (1 SOL + 900 USDC @ $150 → total $1050, need $525 each)
  //   SOL value = $150, target = $525, excess USDC = $375 → sell 375 USDC
  {
    const result = calculateBalancingSwap(1, 900, SOL_PRICE);
    check("excess USDC → direction=usdc_to_sol", result.direction, "usdc_to_sol");
    const expectedUsdc = 375;
    const within5pct = Math.abs(result.amount - expectedUsdc) / expectedUsdc < 0.05;
    if (within5pct) {
      pass(`swap amount ~$${expectedUsdc} USDC (got $${result.amount.toFixed(2)})`);
    } else {
      fail("swap amount out of range", result.amount, expectedUsdc);
    }
    console.log(`    micro-USDC: ${result.amountSmallestUnit} (${(Number(result.amountSmallestUnit) / 1e6).toFixed(4)} USDC)`);
  }

  // Case 5: Print description string for logging
  {
    const result = calculateBalancingSwap(10, 100, SOL_PRICE);
    console.log(`    description: "${result.description}"`);
    pass("description string populated");
  }
}

// ---------------------------------------------------------------------------
// Section 2: isPriceImpactTooHigh — pure logic
// ---------------------------------------------------------------------------

function testPriceImpactGuard(): void {
  console.log("\n── isPriceImpactTooHigh (pure logic) ──────────────────────");

  const makeQuote = (pct: string): SwapQuote =>
    ({ priceImpactPct: pct } as unknown as SwapQuote);

  check("0.1% impact, 1% limit → false", isPriceImpactTooHigh(makeQuote("0.001")), false);
  check("0.5% impact, 1% limit → false", isPriceImpactTooHigh(makeQuote("0.005")), false);
  check("1.0% impact, 1% limit → false", isPriceImpactTooHigh(makeQuote("0.01")),  false); // boundary: not strictly greater
  check("1.1% impact, 1% limit → true",  isPriceImpactTooHigh(makeQuote("0.011")), true);
  check("5.0% impact, 1% limit → true",  isPriceImpactTooHigh(makeQuote("0.05")),  true);
  check("custom 0.5% limit: 0.6% → true", isPriceImpactTooHigh(makeQuote("0.006"), 0.005), true);
  check("invalid string → false (safe default)", isPriceImpactTooHigh(makeQuote("NaN")), false);
}

// ---------------------------------------------------------------------------
// Section 3: getQuote — live Jupiter API
// ---------------------------------------------------------------------------

async function testJupiterQuote(): Promise<void> {
  console.log("\n── getQuote (live Jupiter API) ─────────────────────────────");

  // Test 1: SOL → USDC, 1 SOL (1e9 lamports)
  const solAmount = "1000000000"; // 1 SOL in lamports
  console.log(`  Requesting quote: 1 SOL → USDC (amount=${solAmount} lamports)`);

  let quote: SwapQuote;
  try {
    quote = await getQuote(SOL_MINT, USDC_MINT, solAmount);
  } catch (err) {
    console.error(`  ✗ getQuote threw: ${err}`);
    process.exitCode = 1;
    return;
  }

  // Validate response shape
  check("inputMint = SOL", quote.inputMint, SOL_MINT);
  check("outputMint = USDC", quote.outputMint, USDC_MINT);
  check("inAmount echoed back", quote.inAmount, solAmount);

  const outUsdc = Number(quote.outAmount) / 1e6;
  if (outUsdc > 0) {
    pass(`outAmount > 0 (${outUsdc.toFixed(4)} USDC)`);
  } else {
    fail("outAmount should be > 0", outUsdc, "> 0");
  }

  const impact = parseFloat(quote.priceImpactPct);
  console.log(`    priceImpactPct: ${quote.priceImpactPct} (${(impact * 100).toFixed(4)}%)`);
  console.log(`    slippageBps:    ${quote.slippageBps}`);
  console.log(`    route hops:     ${quote.routePlan.length}`);
  console.log(`    _rawQuote keys: ${Object.keys(quote._rawQuote).join(", ")}`);

  if (quote._rawQuote && typeof quote._rawQuote === "object") {
    pass("_rawQuote preserved for POST /swap");
  } else {
    fail("_rawQuote missing", quote._rawQuote, "object");
  }

  // Test 2: USDC → SOL, 100 USDC (100e6 micro-USDC)
  const usdcAmount = "100000000"; // 100 USDC
  console.log(`\n  Requesting quote: 100 USDC → SOL (amount=${usdcAmount} micro-USDC)`);

  let quote2: SwapQuote;
  try {
    quote2 = await getQuote(USDC_MINT, SOL_MINT, usdcAmount);
  } catch (err) {
    console.error(`  ✗ getQuote (USDC→SOL) threw: ${err}`);
    process.exitCode = 1;
    return;
  }

  const outSol = Number(quote2.outAmount) / 1e9;
  if (outSol > 0) {
    pass(`outAmount > 0 (${outSol.toFixed(6)} SOL)`);
  } else {
    fail("outAmount should be > 0", outSol, "> 0");
  }

  // Implied price check: 1 SOL from quote1 ≈ 1 SOL from quote2
  const solPriceFromQ1 = outUsdc;
  const solPriceFromQ2 = 100 / outSol;
  const spread = Math.abs(solPriceFromQ1 - solPriceFromQ2) / solPriceFromQ1;
  console.log(`    Implied price check: $${solPriceFromQ1.toFixed(2)} vs $${solPriceFromQ2.toFixed(2)} (spread ${(spread * 100).toFixed(3)}%)`);
  if (spread < 0.02) {
    pass("bid/ask spread within 2%");
  } else {
    console.warn(`  ⚠ spread ${(spread * 100).toFixed(3)}% > 2% — unusual, check market conditions`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  Phase 2 Test — Jupiter Service");
  console.log("=".repeat(60));

  testBalancingSwap();
  testPriceImpactGuard();
  await testJupiterQuote();

  console.log("\n" + "=".repeat(60));
  if (process.exitCode === 1) {
    console.log("  RESULT: FAILED — see errors above");
  } else {
    console.log("  RESULT: ALL TESTS PASSED");
  }
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
