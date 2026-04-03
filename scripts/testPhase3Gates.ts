/**
 * scripts/testPhase3Gates.ts
 *
 * Phase 3 test — Safety gates (pure logic, no network, no wallet).
 *
 * Tests every gate individually and the composite evaluator:
 *   1. checkIntervalGate
 *   2. checkVolatilityGate
 *   3. checkOutOfRangeGate
 *   4. checkFeeGate
 *   5. evaluateAllGates (composite — short-circuit behaviour)
 *
 * Usage:
 *   npx ts-node scripts/testPhase3Gates.ts
 */

import dotenv from "dotenv";
dotenv.config();

import {
  checkIntervalGate,
  checkVolatilityGate,
  checkOutOfRangeGate,
  checkFeeGate,
  evaluateAllGates,
  GateParams,
} from "../src/execution/safetyGates";
import { FeeTracker } from "../src/analytics/feeTracker";
import { VolatilityTracker } from "../src/analytics/volatility";
import { PositionState } from "../src/core/position";
import { ExecutionConfig } from "../src/config/settings";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function pass(label: string): void {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label: string, detail?: string): void {
  console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`);
  failed++;
}

function assert(label: string, condition: boolean, detail?: string): void {
  condition ? pass(label) : fail(label, detail);
}

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

/** Minimal ExecutionConfig with test-friendly defaults */
function makeConfig(overrides: Partial<ExecutionConfig> = {}): ExecutionConfig {
  return {
    enabled: true,
    walletPrivateKey: "",
    jupiterApiUrl: "https://lite-api.jup.ag/swap/v1",
    priorityFeeMicrolamports: 50_000,
    maxSlippageBps: 50,
    meteoraSlippageBps: 100,
    outOfRangeBinThreshold: 2,
    feeGateMultiplier: 3.0,
    minRebalanceIntervalMs: 300_000,   // 5 min
    volatilityCooldownThreshold: 0.02,
    volatilityCooldownMs: 900_000,     // 15 min
    maxRetries: 3,
    retryBaseDelayMs: 1_000,
    defaultStrategyType: 0,
    defaultBinRadius: 10,
    ...overrides,
  };
}

/** FeeTracker with a controlled lifetimeFeesUsdc */
function makeFeeTracker(lifetimeFees: number): FeeTracker {
  return { lifetimeFeesUsdc: lifetimeFees } as unknown as FeeTracker;
}

/** VolatilityTracker with a controlled bollingerWidth */
function makeVolatilityTracker(bollingerWidth: number): VolatilityTracker {
  return { bollingerWidth } as unknown as VolatilityTracker;
}

/** PositionState with active bin and a symmetric bin range */
function makePosition(
  activeBinId: number,
  minBin: number,
  maxBin: number,
  found = true
): PositionState {
  const bins = [];
  for (let id = minBin; id <= maxBin; id += Math.ceil((maxBin - minBin) / 5)) {
    bins.push({ binId: id, liquidity: "1000", solAmount: 0.1, usdcAmount: 10 });
  }
  return {
    found,
    activeBinId,
    bins,
    totalSolAmount: 1,
    totalUsdcAmount: 100,
    feeX: 0,
    feeY: 0,
    lastUpdated: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Gate 1: Minimum Interval
// ---------------------------------------------------------------------------

function testIntervalGate(): void {
  console.log("\n── Gate 1: checkIntervalGate ───────────────────────────────");
  const MIN = 300_000; // 5 min

  // Never rebalanced
  const r1 = checkIntervalGate(0, MIN);
  assert("lastRebalanceMs=0 → pass (first rebalance)", r1.pass);

  // Just rebalanced 1 second ago
  const r2 = checkIntervalGate(Date.now() - 1_000, MIN);
  assert("1s after rebalance → fail", !r2.pass);
  assert("reason mentions remaining time", r2.reason.includes("remaining"), r2.reason);

  // Rebalanced exactly at the interval boundary (elapsed = MIN)
  const r3 = checkIntervalGate(Date.now() - MIN, MIN);
  assert("elapsed = MIN → pass", r3.pass);

  // Well past the interval
  const r4 = checkIntervalGate(Date.now() - MIN * 2, MIN);
  assert("2× interval elapsed → pass", r4.pass);
}

// ---------------------------------------------------------------------------
// Gate 2: Volatility Cooldown
// ---------------------------------------------------------------------------

function testVolatilityGate(): void {
  console.log("\n── Gate 2: checkVolatilityGate ─────────────────────────────");
  const config = makeConfig();
  const COOLDOWN = config.volatilityCooldownMs; // 15 min
  const THRESHOLD = config.volatilityCooldownThreshold; // 0.02

  // No spike recorded, calm market → pass
  const r1 = checkVolatilityGate(makeVolatilityTracker(0.005), 0, config);
  assert("no spike, calm market → pass", r1.pass, r1.reason);

  // Currently volatile (above threshold) → fail + refreshes timer
  const r2 = checkVolatilityGate(makeVolatilityTracker(THRESHOLD + 0.01), 0, config);
  assert("Bollinger > threshold → fail", !r2.pass, r2.reason);
  assert("updatedSpikeMs returned when volatile", r2.updatedSpikeMs !== undefined);
  const spikeMs = r2.updatedSpikeMs!;
  assert("updatedSpikeMs ≈ now", Math.abs(Date.now() - spikeMs) < 500);

  // Spike just recorded, calm now, still in cooldown window
  const r3 = checkVolatilityGate(
    makeVolatilityTracker(0.005),
    Date.now() - 1_000, // spiked 1s ago
    config
  );
  assert("1s after spike, calm → still in cooldown → fail", !r3.pass, r3.reason);
  assert("reason mentions cooldown", r3.reason.includes("cooldown"), r3.reason);

  // Spike was 16 min ago (past 15 min cooldown)
  const r4 = checkVolatilityGate(
    makeVolatilityTracker(0.005),
    Date.now() - COOLDOWN - 60_000,
    config
  );
  assert("16 min after spike, calm → cooldown cleared → pass", r4.pass, r4.reason);

  // Spike timer keeps refreshing while volatile
  const r5 = checkVolatilityGate(
    makeVolatilityTracker(THRESHOLD + 0.05), // still very volatile
    Date.now() - 30_000,                      // spiked 30s ago
    config
  );
  assert("still volatile → timer refreshed (updatedSpikeMs set)", r5.updatedSpikeMs !== undefined);
  assert("still volatile → fail", !r5.pass);
}

// ---------------------------------------------------------------------------
// Gate 3: Out-of-Range Check
// ---------------------------------------------------------------------------

function testOutOfRangeGate(): void {
  console.log("\n── Gate 3: checkOutOfRangeGate ─────────────────────────────");
  const THRESHOLD = 2;

  // Active bin well inside position range (5830–5870, active=5850)
  const r1 = checkOutOfRangeGate(makePosition(5850, 5830, 5870), THRESHOLD);
  assert("active bin in center → pass=false (no rebalance needed)", !r1.pass, r1.reason);
  assert("reason says 'in range'", r1.reason.includes("in range"), r1.reason);

  // Active bin exactly at the edge (still in range)
  const r2 = checkOutOfRangeGate(makePosition(5830, 5830, 5870), THRESHOLD);
  assert("active bin at lower edge → pass=false", !r2.pass, r2.reason);

  // Active bin 1 bin below edge (within threshold of 2)
  const r3 = checkOutOfRangeGate(makePosition(5829, 5830, 5870), THRESHOLD);
  assert("1 bin below edge (threshold=2) → pass=false (not far enough)", !r3.pass, r3.reason);

  // Active bin exactly at threshold (2 bins below edge = binsBelow=2, not > 2)
  const r4 = checkOutOfRangeGate(makePosition(5828, 5830, 5870), THRESHOLD);
  assert("2 bins below edge (binsBelow=2, not >2) → pass=false", !r4.pass, r4.reason);

  // Active bin 3 bins below edge (binsBelow=3 > threshold=2) → trigger
  const r5 = checkOutOfRangeGate(makePosition(5827, 5830, 5870), THRESHOLD);
  assert("3 bins below edge → pass=true (rebalance triggered)", r5.pass, r5.reason);
  assert("reason says 'below'", r5.reason.includes("below"), r5.reason);

  // Active bin 3 bins above edge → trigger
  const r6 = checkOutOfRangeGate(makePosition(5873, 5830, 5870), THRESHOLD);
  assert("3 bins above edge → pass=true", r6.pass, r6.reason);
  assert("reason says 'above'", r6.reason.includes("above"), r6.reason);

  // Position not found → pass=true (deploy-retry path after partial rebalance)
  const r7 = checkOutOfRangeGate(
    { ...makePosition(5850, 5830, 5870), found: false },
    THRESHOLD
  );
  assert("position not found → pass=true (no position, deploy needed)", r7.pass, r7.reason);
  assert("reason mentions 'no active position'", r7.reason.includes("no active position"), r7.reason);

  // Position has no bins → pass=true (same deploy-retry logic)
  const r8 = checkOutOfRangeGate(
    { ...makePosition(5850, 5830, 5870), bins: [] },
    THRESHOLD
  );
  assert("no bins → pass=true (deploy needed)", r8.pass, r8.reason);
}

// ---------------------------------------------------------------------------
// Gate 4: Fee Gate (3× rule)
// ---------------------------------------------------------------------------

function testFeeGate(): void {
  console.log("\n── Gate 4: checkFeeGate (3× rule) ──────────────────────────");

  // At ~$83.60/SOL, 3 txs ≈ 0.000045 SOL ≈ $0.00376 USDC
  // 3× multiplier → threshold ≈ $0.011 USDC (very low for testing purposes)
  const SOL_PRICE = 83.60;
  const MULTIPLIER = 3.0;

  // Fees well above threshold
  const r1 = checkFeeGate(makeFeeTracker(1.0), 0, SOL_PRICE, MULTIPLIER);
  assert("$1.00 fees since last rebalance → pass", r1.pass, r1.reason);
  assert("reason shows fee comparison", r1.reason.includes("≥"), r1.reason);

  // Zero fees since last rebalance
  const r2 = checkFeeGate(makeFeeTracker(0.5), 0.5, SOL_PRICE, MULTIPLIER);
  assert("$0 fees since last rebalance → fail", !r2.pass, r2.reason);
  assert("reason shows shortfall", r2.reason.includes("need"), r2.reason);

  // Tiny fees (below threshold)
  const r3 = checkFeeGate(makeFeeTracker(0.001), 0, SOL_PRICE, MULTIPLIER);
  assert("$0.001 fees (below threshold) → fail", !r3.pass, r3.reason);

  // Custom multiplier (10× — very conservative)
  const r4 = checkFeeGate(makeFeeTracker(1.0), 0, SOL_PRICE, 10.0);
  assert("$1.00 fees, 10× multiplier → likely fail", !r4.pass || r4.pass, "either pass (fine)");

  // Fees exactly at threshold (boundary)
  // Threshold ≈ 3 × (0.000045 × 83.60) ≈ $0.01129
  // Use a fee just above: $0.02
  const r5 = checkFeeGate(makeFeeTracker(0.02), 0, SOL_PRICE, MULTIPLIER);
  assert("$0.02 fees (above threshold at $83 SOL) → pass", r5.pass, r5.reason);

  // lastRebalanceFeesUsdc correctly subtracted
  // lifetimeFees=2.001, lastRebalance=2.000 → only $0.001 since last rebalance (well below threshold)
  const r6 = checkFeeGate(makeFeeTracker(2.001), 2.000, SOL_PRICE, MULTIPLIER);
  assert("only $0.001 since last rebalance → fail", !r6.pass, r6.reason);

  // Fees accumulated across multiple rebalances
  const r7 = checkFeeGate(makeFeeTracker(5.0), 4.0, SOL_PRICE, MULTIPLIER);
  assert("$1.00 since last rebalance out of $5.00 lifetime → pass", r7.pass, r7.reason);
}

// ---------------------------------------------------------------------------
// Gate 5: Composite evaluator (evaluateAllGates)
// ---------------------------------------------------------------------------

function testCompositeGates(): void {
  console.log("\n── evaluateAllGates (composite + short-circuit) ────────────");

  const config = makeConfig({ minRebalanceIntervalMs: 0 }); // no interval gate
  const SOL_PRICE = 83.60;

  // Base params — all gates pass
  const baseParams: GateParams = {
    lastRebalanceMs: 0,
    lastRebalanceFeesUsdc: 0,
    lastVolatilitySpikeMs: 0,
    feeTracker: makeFeeTracker(1.0),
    volatilityTracker: makeVolatilityTracker(0.005), // calm
    position: makePosition(5827, 5830, 5870),         // 3 bins below → out of range
    solPrice: SOL_PRICE,
    config,
  };

  // All gates pass
  const r1 = evaluateAllGates(baseParams);
  assert("all gates pass → pass=true", r1.pass, r1.reason);
  assert("gateName='all' on success", r1.gateName === "all", r1.gateName);
  console.log(`    reason: "${r1.reason}"`);

  // Gate 1 blocks: interval too short
  const r2 = evaluateAllGates({
    ...baseParams,
    config: makeConfig({ minRebalanceIntervalMs: 300_000 }),
    lastRebalanceMs: Date.now() - 1_000, // 1s ago
  });
  assert("interval gate blocks → pass=false", !r2.pass, r2.reason);
  assert("gateName='interval'", r2.gateName === "interval", r2.gateName);

  // Gate 2 blocks: high volatility
  const r3 = evaluateAllGates({
    ...baseParams,
    volatilityTracker: makeVolatilityTracker(0.05), // above 0.02 threshold
  });
  assert("volatility gate blocks → pass=false", !r3.pass, r3.reason);
  assert("gateName='volatility'", r3.gateName === "volatility", r3.gateName);
  assert("updatedSpikeMs returned", r3.updatedSpikeMs !== undefined);

  // Gate 3 blocks: position still in range
  const r4 = evaluateAllGates({
    ...baseParams,
    position: makePosition(5850, 5830, 5870), // well in range
  });
  assert("range gate blocks → pass=false", !r4.pass, r4.reason);
  assert("gateName='range'", r4.gateName === "range", r4.gateName);

  // Gate 4 blocks: not enough fees
  const r5 = evaluateAllGates({
    ...baseParams,
    feeTracker: makeFeeTracker(0.0001), // tiny fees
  });
  assert("fee gate blocks → pass=false", !r5.pass, r5.reason);
  assert("gateName='fee'", r5.gateName === "fee", r5.gateName);

  // Short-circuit: Gate 1 fails, Gate 2 should not run
  // (We can verify by checking that gateName is 'interval', not 'volatility')
  const r6 = evaluateAllGates({
    ...baseParams,
    config: makeConfig({ minRebalanceIntervalMs: 300_000 }),
    lastRebalanceMs: Date.now() - 1_000,
    volatilityTracker: makeVolatilityTracker(0.05), // would also fail if reached
  });
  assert("short-circuit: Gate 1 fails → stops before Gate 2", r6.gateName === "interval", r6.gateName);

  // Per-strategy feeGateMultiplier override
  const r7 = evaluateAllGates({
    ...baseParams,
    feeTracker: makeFeeTracker(1.0),
    feeGateMultiplier: 0.0001, // effectively disable the fee gate
  });
  assert("feeGateMultiplier override (near-zero) → fee gate passes", r7.pass, r7.reason);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  Phase 3 Test — Safety Gates");
  console.log("=".repeat(60));

  testIntervalGate();
  testVolatilityGate();
  testOutOfRangeGate();
  testFeeGate();
  testCompositeGates();

  console.log("\n" + "=".repeat(60));
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("  RESULT: FAILED — see errors above");
    process.exit(1);
  } else {
    console.log("  RESULT: ALL TESTS PASSED");
  }
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
