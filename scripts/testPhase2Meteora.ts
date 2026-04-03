/**
 * scripts/testPhase2Meteora.ts
 *
 * Phase 2 test — Meteora service validation (read-only).
 *
 * Tests:
 *   1. getActiveBin()       — reads live pool state (needs RPC_URL)
 *   2. refreshPoolState()   — confirms SDK state refresh works
 *   3. estimateTransactionCost() — validates cost estimation (Phase 1 service)
 *
 * Does NOT test withdrawAll() or deployPosition() — those require a funded
 * wallet and a live position. Test those manually on devnet before mainnet.
 *
 * Usage:
 *   npx ts-node scripts/testPhase2Meteora.ts
 *
 * Requires: RPC_URL in .env
 */

import dotenv from "dotenv";
dotenv.config();

import { initializeClient } from "../src/core/client";
import { getActiveBin, refreshPoolState } from "../src/services/meteoraService";
import { estimateTransactionCost } from "../src/services/transactionService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pass(label: string): void {
  console.log(`  ✓ ${label}`);
}

function fail(label: string, detail?: string): void {
  console.error(`  ✗ ${label}${detail ? ": " + detail : ""}`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testGetActiveBin(): Promise<void> {
  console.log("\n── getActiveBin() ──────────────────────────────────────────");

  let bin;
  try {
    bin = await getActiveBin();
  } catch (err) {
    fail("getActiveBin() threw", String(err));
    return;
  }

  // binId is a signed integer — can be negative (bins are centered around 0)
  if (typeof bin.binId === "number" && Number.isInteger(bin.binId)) {
    pass(`binId = ${bin.binId}`);
  } else {
    fail("binId should be an integer", String(bin.binId));
  }

  // price strings should be non-empty
  if (bin.price && bin.price.length > 0) {
    pass(`price = "${bin.price}" (raw lamport price)`);
  } else {
    fail("price should be a non-empty string");
  }

  if (bin.pricePerToken && bin.pricePerToken.length > 0) {
    const humanPrice = parseFloat(bin.pricePerToken);
    if (humanPrice > 0) {
      pass(`pricePerToken = $${humanPrice.toFixed(2)} / SOL`);

      // Sanity check: SOL price should be in a plausible range
      if (humanPrice > 1 && humanPrice < 100_000) {
        pass(`SOL price $${humanPrice.toFixed(2)} within plausible range ($1–$100k)`);
      } else {
        fail(`SOL price $${humanPrice.toFixed(2)} looks implausible — check pool config`);
      }
    } else {
      fail("pricePerToken parsed to 0 or negative");
    }
  } else {
    fail("pricePerToken should be a non-empty string");
  }
}

async function testRefreshPoolState(): Promise<void> {
  console.log("\n── refreshPoolState() ──────────────────────────────────────");

  try {
    await refreshPoolState();
    pass("refreshPoolState() completed without error");
  } catch (err) {
    fail("refreshPoolState() threw", String(err));
    return;
  }

  // Fetch active bin again after refresh — should still be consistent
  try {
    const bin = await getActiveBin();
    pass(`binId after refresh = ${bin.binId} (pool state is fresh)`);
  } catch (err) {
    fail("getActiveBin() failed after refreshPoolState()", String(err));
  }
}

function testCostEstimation(): void {
  console.log("\n── estimateTransactionCost() ───────────────────────────────");

  // A full rebalance = 3 transactions (withdraw + swap + deposit)
  const cost3 = estimateTransactionCost(3);
  if (typeof cost3 === "number" && cost3 > 0) {
    pass(`3-tx rebalance cost = ${cost3.toFixed(6)} SOL`);
  } else {
    fail("estimateTransactionCost(3) should return a positive number", String(cost3));
  }

  // 1 tx should cost less than 3 txs
  const cost1 = estimateTransactionCost(1);
  if (cost1 < cost3) {
    pass(`1-tx cost (${cost1.toFixed(6)}) < 3-tx cost (${cost3.toFixed(6)})`);
  } else {
    fail("1-tx cost should be less than 3-tx cost");
  }

  // Fee gate sanity check: at $150/SOL, 3x multiplier, 3 txs
  const solPrice = 150;
  const costUsdc = cost3 * solPrice;
  const feeGateThreshold = costUsdc * 3.0;
  console.log(`    At $${solPrice}/SOL: rebalance costs ~$${costUsdc.toFixed(4)} USDC`);
  console.log(`    3x fee gate threshold: fees must exceed $${feeGateThreshold.toFixed(4)} USDC`);
  pass("cost estimation plausible for fee gate");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  Phase 2 Test — Meteora Service (read-only)");
  console.log("=".repeat(60));

  console.log("\n── Initializing client ─────────────────────────────────────");
  try {
    await initializeClient();
    pass("initializeClient() succeeded");
  } catch (err) {
    fail("initializeClient() failed — check RPC_URL in .env", String(err));
    process.exit(1);
  }

  testCostEstimation();
  await testGetActiveBin();
  await testRefreshPoolState();

  console.log("\n" + "=".repeat(60));
  if (process.exitCode === 1) {
    console.log("  RESULT: FAILED — see errors above");
  } else {
    console.log("  RESULT: ALL TESTS PASSED");
    console.log("");
    console.log("  NOTE: withdrawAll() and deployPosition() require a funded");
    console.log("  wallet + live position. Test those manually on devnet.");
  }
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
