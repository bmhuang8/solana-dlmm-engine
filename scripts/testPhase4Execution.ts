/**
 * scripts/testPhase4Execution.ts
 *
 * Phase 4 test — Execution Core (pure logic, no network, no wallet).
 *
 * Tests:
 *   1. ExecutionRunner state guards (enabled=false, paused)
 *   2. ExecutionRunner gate pipeline (range, fee, volatility gates)
 *   3. Rebalance trigger and state transitions (mock orchestrator)
 *   4. Failed rebalance — state consistency
 *   5. KillSwitch (register, trigger, duplicate, reset)
 *
 * Usage:
 *   cd meteora-sentinel
 *   npx ts-node scripts/testPhase4Execution.ts
 */

import dotenv from "dotenv";
dotenv.config();

import { Keypair } from "@solana/web3.js";
import { ExecutionRunner } from "../src/execution/executionRunner";
import { KillSwitch } from "../src/execution/killSwitch";
import {
  RebalanceOrchestrator,
  RebalanceParams,
  RebalanceResult,
} from "../src/execution/rebalanceOrchestrator";
import { StrategyRunner, TickStats, EntryState } from "../src/runners/strategyRunner";
import { FeeTracker } from "../src/analytics/feeTracker";
import { VolatilityTracker } from "../src/analytics/volatility";
import { PositionState } from "../src/core/position";
import { PriceData } from "../src/core/priceFeed";
import { ExecutionConfig, StrategyConfig } from "../src/config/settings";
import { CompositeGateResult } from "../src/execution/safetyGates";

// ---------------------------------------------------------------------------
// Test helpers
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

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

/** System program pubkey — valid base58, safe to use as a placeholder */
const PLACEHOLDER_PUBKEY = "11111111111111111111111111111111";

function makeStrategyConfig(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    id: "test-01",
    label: "Test Strategy 01",
    positionPubkey: PLACEHOLDER_PUBKEY,
    ...overrides,
  };
}

function makeExecConfig(overrides: Partial<ExecutionConfig> = {}): ExecutionConfig {
  return {
    enabled: true,
    walletPrivateKey: "",
    jupiterApiUrl: "https://lite-api.jup.ag/swap/v1",
    priorityFeeMicrolamports: 50_000,
    maxSlippageBps: 50,
    meteoraSlippageBps: 100,
    outOfRangeBinThreshold: 2,
    feeGateMultiplier: 3.0,
    minRebalanceIntervalMs: 300_000,
    volatilityCooldownThreshold: 0.02,
    volatilityCooldownMs: 900_000,
    maxRetries: 3,
    retryBaseDelayMs: 1_000,
    defaultStrategyType: 0,
    defaultBinRadius: 10,
    ...overrides,
  };
}

/**
 * Minimal StrategyRunner stub — analytics always return null (no entryState),
 * but FeeTracker and VolatilityTracker are controllable for gate testing.
 */
function makeMockAnalyticsRunner(opts: {
  lifetimeFees?: number;
  bollingerWidth?: number;
} = {}): StrategyRunner {
  const ft = { lifetimeFeesUsdc: opts.lifetimeFees ?? 1.0 } as FeeTracker;
  const vt = { bollingerWidth: opts.bollingerWidth ?? 0.005 } as VolatilityTracker;

  return {
    id: "test-01",
    entryState: null as EntryState | null,
    tick: (_pos: PositionState, _price: PriceData): TickStats | null => null,
    setEntryState: (_state: EntryState): void => {},
    get fees(): FeeTracker { return ft; },
    get volatility(): VolatilityTracker { return vt; },
  } as unknown as StrategyRunner;
}

/** Active bin well inside position range — no rebalance needed */
function makeInRangePosition(): PositionState {
  return {
    found: true,
    activeBinId: 5850,
    bins: [5830, 5840, 5850, 5860, 5870].map((id) => ({
      binId: id,
      liquidity: "1000",
      solAmount: 0.1,
      usdcAmount: 10,
    })),
    totalSolAmount: 0.5,
    totalUsdcAmount: 50,
    feeX: 0,
    feeY: 0,
    lastUpdated: Date.now(),
  };
}

/** Active bin 3 bins below range — rebalance warranted */
function makeOutOfRangePosition(): PositionState {
  return {
    found: true,
    activeBinId: 5827, // minBin=5830, binsBelow=3 > threshold=2
    bins: [5830, 5840, 5850, 5860, 5870].map((id) => ({
      binId: id,
      liquidity: "1000",
      solAmount: 0.1,
      usdcAmount: 10,
    })),
    totalSolAmount: 0.5,
    totalUsdcAmount: 50,
    feeX: 0,
    feeY: 0,
    lastUpdated: Date.now(),
  };
}

function makePrice(solPrice = 83.6): PriceData {
  return {
    onChainPrice: solPrice,
    activeBinId: -2483,
    source: "pyth",
    timestamp: Date.now(),
  };
}

/** Mock EventEmitter that records events for assertion */
class MockEmitter {
  readonly events: Array<{ event: string; data: unknown }> = [];
  emit(event: string, data: unknown): boolean {
    this.events.push({ event, data });
    return true;
  }
}

/**
 * Mock orchestrator — extends RebalanceOrchestrator and overrides execute().
 * Resolves after `delayMs` without touching the network.
 */
class MockOrchestrator extends RebalanceOrchestrator {
  constructor(
    private readonly _succeed: boolean,
    private readonly _delayMs = 60
  ) {
    super();
  }

  async execute(_params: RebalanceParams): Promise<RebalanceResult> {
    await delay(this._delayMs);
    if (this._succeed) {
      return {
        success: true,
        newPositionPubkey: Keypair.generate().publicKey,
        signatures: ["mock-sig-1", "mock-sig-2"],
        estimatedCostUsdc: 0.012,
        swapSlippageUsdc: 0.001,
        durationMs: this._delayMs,
      };
    }
    return {
      success: false,
      failedStep: "withdraw",
      error: "mock withdrawal failure",
      signatures: [],
      estimatedCostUsdc: 0.012,
      swapSlippageUsdc: 0,
      durationMs: this._delayMs,
    };
  }
}

// ---------------------------------------------------------------------------
// 1. State Guards
// ---------------------------------------------------------------------------

function testStateGuards(): void {
  console.log("\n── 1. ExecutionRunner — State Guards ──────────────────────────");

  // execution disabled → tick() returns without evaluating gates
  const r1 = new ExecutionRunner(
    makeStrategyConfig(),
    0,
    makeExecConfig({ enabled: false }),
    new MockOrchestrator(true),
    makeMockAnalyticsRunner(),
  );
  r1.tick(makeOutOfRangePosition(), makePrice());
  assert(
    "enabled=false → gates never evaluated (lastGateResult unchanged)",
    r1.lastGateResult.reason === "not yet evaluated"
  );
  assert("enabled=false → rebalanceInFlight=false", !r1.rebalanceInFlight);

  // paused → tick() returns without evaluating gates
  const r2 = new ExecutionRunner(
    makeStrategyConfig(),
    0,
    makeExecConfig(),
    new MockOrchestrator(true),
    makeMockAnalyticsRunner(),
  );
  r2.paused = true;
  r2.tick(makeOutOfRangePosition(), makePrice());
  assert(
    "paused=true → gates never evaluated",
    r2.lastGateResult.reason === "not yet evaluated"
  );
  assert("paused=true → rebalanceInFlight=false", !r2.rebalanceInFlight);

  // pause/resume toggle
  const r3 = new ExecutionRunner(
    makeStrategyConfig(), 0, makeExecConfig(), new MockOrchestrator(true), makeMockAnalyticsRunner()
  );
  assert("initially paused=false", !r3.paused);
  r3.paused = true;
  assert("paused setter → paused=true", r3.paused);
  r3.paused = false;
  assert("paused setter → paused=false", !r3.paused);
}

// ---------------------------------------------------------------------------
// 2. Gate Pipeline
// ---------------------------------------------------------------------------

function testGatePipeline(): void {
  console.log("\n── 2. ExecutionRunner — Gate Pipeline ─────────────────────────");

  // Gate 3 (range) blocks — position in range
  const r1 = new ExecutionRunner(
    makeStrategyConfig(),
    0,
    makeExecConfig({ minRebalanceIntervalMs: 0 }),
    new MockOrchestrator(true),
    makeMockAnalyticsRunner({ lifetimeFees: 1.0, bollingerWidth: 0.005 }),
  );
  r1.tick(makeInRangePosition(), makePrice());
  const g1 = r1.lastGateResult as CompositeGateResult;
  assert("in-range position → gate 3 blocks (pass=false)", !g1.pass, g1.reason);
  assert("gateName='range'", g1.gateName === "range", g1.gateName);
  assert("range gate → rebalanceInFlight=false", !r1.rebalanceInFlight);

  // Gate 4 (fee) blocks — out of range but tiny fees
  const r2 = new ExecutionRunner(
    makeStrategyConfig(),
    0,
    makeExecConfig({ minRebalanceIntervalMs: 0 }),
    new MockOrchestrator(true),
    makeMockAnalyticsRunner({ lifetimeFees: 0.0001, bollingerWidth: 0.005 }),
  );
  r2.tick(makeOutOfRangePosition(), makePrice());
  const g2 = r2.lastGateResult as CompositeGateResult;
  assert("out-of-range, tiny fees → gate 4 blocks (pass=false)", !g2.pass, g2.reason);
  assert("gateName='fee'", g2.gateName === "fee", g2.gateName);
  assert("fee gate → rebalanceInFlight=false", !r2.rebalanceInFlight);

  // Gate 2 (volatility) blocks — high Bollinger width refreshes spikeMs
  const r3 = new ExecutionRunner(
    makeStrategyConfig(),
    0,
    makeExecConfig({ minRebalanceIntervalMs: 0 }),
    new MockOrchestrator(true),
    makeMockAnalyticsRunner({ bollingerWidth: 0.05 }), // > 0.02 threshold
  );
  const beforeSpike = Date.now();
  r3.tick(makeOutOfRangePosition(), makePrice());
  const g3 = r3.lastGateResult as CompositeGateResult;
  assert("high volatility → gate 2 blocks (pass=false)", !g3.pass, g3.reason);
  assert("gateName='volatility'", g3.gateName === "volatility", g3.gateName);
  assert(
    "lastVolatilitySpikeMs persisted to ExecutionState",
    r3.executionState.lastVolatilitySpikeMs >= beforeSpike,
    String(r3.executionState.lastVolatilitySpikeMs)
  );
  assert("volatility gate → rebalanceInFlight=false", !r3.rebalanceInFlight);

  // All gates pass → rebalanceInFlight=true (no await — just check the flag)
  const r4 = new ExecutionRunner(
    makeStrategyConfig(),
    0,
    makeExecConfig({ minRebalanceIntervalMs: 0 }),
    new MockOrchestrator(true, 120), // slow enough to still be in-flight when we check
    makeMockAnalyticsRunner({ lifetimeFees: 1.0, bollingerWidth: 0.005 }),
  );
  r4.tick(makeOutOfRangePosition(), makePrice());
  const g4 = r4.lastGateResult as CompositeGateResult;
  assert("all gates pass → lastGateResult.pass=true", g4.pass, g4.reason);
  assert("all gates pass → rebalanceInFlight=true immediately", r4.rebalanceInFlight);
}

// ---------------------------------------------------------------------------
// 3. Successful Rebalance — State Transitions
// ---------------------------------------------------------------------------

async function testSuccessfulRebalance(): Promise<void> {
  console.log("\n── 3. Successful Rebalance — State Transitions ────────────────");

  const emitter = new MockEmitter();
  const runner = new ExecutionRunner(
    makeStrategyConfig(),
    0,
    makeExecConfig({ minRebalanceIntervalMs: 0 }),
    new MockOrchestrator(true, 80), // 80ms mock delay
    makeMockAnalyticsRunner({ lifetimeFees: 1.0, bollingerWidth: 0.005 }),
    emitter,
  );

  // Fire the rebalance
  runner.tick(makeOutOfRangePosition(), makePrice());
  assert("rebalanceInFlight=true immediately after tick()", runner.rebalanceInFlight);
  assert(
    "rebalance_start emitted",
    emitter.events.some((e) => e.event === "rebalance_start")
  );

  // Second tick while in-flight — must NOT double-trigger
  runner.tick(makeOutOfRangePosition(), makePrice());
  assert("second tick while in-flight → still in-flight (no double trigger)", runner.rebalanceInFlight);

  // Wait for mock to complete (80ms + generous buffer)
  await delay(300);

  assert("rebalanceInFlight cleared after completion", !runner.rebalanceInFlight);
  assert("rebalanceCount = 1", runner.executionState.rebalanceCount === 1);
  assert("lastRebalanceMs set (> 0)", runner.executionState.lastRebalanceMs > 0);
  assert(
    "lastRebalanceFeesUsdc = 1.0",
    runner.executionState.lastRebalanceFeesUsdc === 1.0,
    String(runner.executionState.lastRebalanceFeesUsdc)
  );
  assert(
    "totalRebalanceCostUsdc accumulated",
    runner.executionState.totalRebalanceCostUsdc > 0,
    String(runner.executionState.totalRebalanceCostUsdc)
  );
  assert(
    "rebalanceHistory has 1 entry",
    runner.executionState.rebalanceHistory.length === 1
  );
  assert("history entry is success", runner.executionState.rebalanceHistory[0].success);
  assert(
    "history entry records signatures",
    runner.executionState.rebalanceHistory[0].signatures.length > 0
  );
  assert(
    "rebalance_complete emitted",
    emitter.events.some((e) => e.event === "rebalance_complete")
  );

  // Immediately after rebalance — fee gate blocks (lastRebalanceFeesUsdc was set to 1.0,
  // so feesSinceLastRebalance = 1.0 - 1.0 = $0, which is below the ~$0.011 threshold)
  runner.tick(makeOutOfRangePosition(), makePrice());
  const g = runner.lastGateResult as CompositeGateResult;
  assert(
    "immediately after rebalance → fee gate blocks (0 new fees accumulated)",
    g.gateName === "fee",
    g.reason
  );
  assert("fee gate reason shows $0.00 earned", g.reason.includes("$0.0000"), g.reason);
}

// ---------------------------------------------------------------------------
// 4. Failed Rebalance — State Consistency
// ---------------------------------------------------------------------------

async function testFailedRebalance(): Promise<void> {
  console.log("\n── 4. Failed Rebalance — State Consistency ────────────────────");

  const emitter = new MockEmitter();
  const runner = new ExecutionRunner(
    makeStrategyConfig(),
    0,
    makeExecConfig({ minRebalanceIntervalMs: 0 }),
    new MockOrchestrator(false, 50), // always fails
    makeMockAnalyticsRunner({ lifetimeFees: 1.0, bollingerWidth: 0.005 }),
    emitter,
  );

  runner.tick(makeOutOfRangePosition(), makePrice());
  assert("rebalanceInFlight=true while failing rebalance runs", runner.rebalanceInFlight);

  await delay(200);

  assert("rebalanceInFlight cleared after failure", !runner.rebalanceInFlight);
  assert("rebalanceCount stays 0 on failure", runner.executionState.rebalanceCount === 0);
  assert(
    "lastRebalanceMs NOT updated on failure",
    runner.executionState.lastRebalanceMs === 0
  );
  assert(
    "rebalanceHistory has 1 entry (failed)",
    runner.executionState.rebalanceHistory.length === 1
  );
  assert("history entry is failure", !runner.executionState.rebalanceHistory[0].success);
  assert(
    "history records failedStep='withdraw'",
    runner.executionState.rebalanceHistory[0].failedStep === "withdraw"
  );
  assert(
    "rebalance_failed emitted",
    emitter.events.some((e) => e.event === "rebalance_failed")
  );

  // After failure, interval gate does NOT block (lastRebalanceMs=0 → first-rebalance pass)
  runner.tick(makeOutOfRangePosition(), makePrice());
  assert("after failure → can retry immediately (rebalanceInFlight=true)", runner.rebalanceInFlight);
  await delay(200); // let it finish
}

// ---------------------------------------------------------------------------
// 5. KillSwitch
// ---------------------------------------------------------------------------

async function testKillSwitch(): Promise<void> {
  console.log("\n── 5. KillSwitch ──────────────────────────────────────────────");

  const ks = new KillSwitch();
  assert("triggered=false initially", !ks.triggered);

  const makeRunner = (id: string) =>
    new ExecutionRunner(
      makeStrategyConfig({ id, label: `Strategy ${id}` }),
      0,
      makeExecConfig({ minRebalanceIntervalMs: 0 }),
      new MockOrchestrator(false, 10), // fails fast — no network needed
      makeMockAnalyticsRunner(),
    );

  const r1 = makeRunner("strategy-01");
  const r2 = makeRunner("strategy-02");

  ks.registerRunners([r1, r2]);

  // Trigger
  const result = await ks.trigger("unit test");

  assert("triggered=true after trigger()", ks.triggered);
  assert("r1 is paused after trigger", r1.paused);
  assert("r2 is paused after trigger", r2.paused);
  assert("result has 2 outcomes", result.outcomes.length === 2, String(result.outcomes.length));
  assert("reason is propagated", result.reason === "unit test");
  assert("triggeredAt is recent (< 10s ago)", Math.abs(Date.now() - result.triggeredAt) < 10_000);

  console.log(`    outcome[0]: ${result.outcomes[0].strategyId} success=${result.outcomes[0].success}`);
  console.log(`    outcome[1]: ${result.outcomes[1].strategyId} success=${result.outcomes[1].success}`);

  // Duplicate trigger → no-op (safe to call twice)
  const result2 = await ks.trigger("duplicate");
  assert("duplicate trigger → 0 outcomes (no-op)", result2.outcomes.length === 0);
  assert("duplicate trigger reason contains 'duplicate'", result2.reason.includes("duplicate"));

  // Reset
  ks.reset();
  assert("triggered=false after reset()", !ks.triggered);
  assert("r1 unpaused after reset", !r1.paused);
  assert("r2 unpaused after reset", !r2.paused);

  // After reset, trigger works again
  const result3 = await ks.trigger("second trigger after reset");
  assert("can trigger again after reset", ks.triggered);
  assert("second trigger has 2 outcomes", result3.outcomes.length === 2);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  Phase 4 Test — Execution Core");
  console.log("=".repeat(60));

  testStateGuards();
  testGatePipeline();
  await testSuccessfulRebalance();
  await testFailedRebalance();
  await testKillSwitch();

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
