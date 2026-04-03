/**
 * scripts/testPhase5Server.ts
 *
 * Phase 5 test — Server integration (HTTP endpoints, no network, no wallet).
 *
 * Starts the Express server on port 3099, registers execution endpoints
 * with mock objects, then hits each endpoint with Node's built-in fetch.
 *
 * Tests:
 *   1. GET  /api/execution-state  — response shape
 *   2. POST /api/pause/:id        — valid id / unknown id
 *   3. POST /api/resume/:id       — success / kill switch active / unknown id
 *   4. POST /api/kill             — auth checks + trigger + idempotency
 *   5. emitStateUpdate            — non-throwing sanity check
 *
 * Usage:
 *   cd meteora-sentinel
 *   npx ts-node scripts/testPhase5Server.ts
 */

import dotenv from "dotenv";
dotenv.config();

import { Keypair } from "@solana/web3.js";
import {
  startDashboard,
  stopDashboard,
  registerExecutionEndpoints,
  emitStateUpdate,
} from "../src/server";
import type { KillSwitchResult } from "../src/execution/killSwitch";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_PORT = 3099;
const BASE = `http://localhost:${TEST_PORT}`;
const KILL_TOKEN = "test-secret-token-phase5";

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

async function get(path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(`${BASE}${path}`, { headers });
}

async function post(
  path: string,
  body?: unknown,
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// Mock objects
// ---------------------------------------------------------------------------

/** Minimal mock that satisfies the structural interface expected by server.ts */
function makeMockKillSwitch(): {
  _triggered: boolean;
  trigger: (reason: string) => Promise<KillSwitchResult>;
  get triggered(): boolean;
  reset: () => void;
} {
  let _triggered = false;

  return {
    get _triggered() { return _triggered; },
    set _triggered(v: boolean) { _triggered = v; },
    get triggered(): boolean { return _triggered; },
    async trigger(reason: string): Promise<KillSwitchResult> {
      if (_triggered) {
        return { triggeredAt: Date.now(), reason: `duplicate (${reason})`, outcomes: [], allSucceeded: false };
      }
      _triggered = true;
      return {
        triggeredAt: Date.now(),
        reason,
        outcomes: [{ strategyId: "test-01", success: true, signatures: ["mock-sig"] }],
        allSucceeded: true,
      };
    },
    reset() { _triggered = false; },
  };
}

function makeMockRunner(id: string, label: string) {
  let _paused = false;
  const pubkey = Keypair.generate().publicKey;

  return {
    get id(): string { return id; },
    get paused(): boolean { return _paused; },
    set paused(v: boolean) { _paused = v; },
    get executionState() {
      return {
        paused: _paused,
        rebalanceInFlight: false,
        lastGateResult: { pass: false, reason: "not yet evaluated" },
        rebalanceCount: 0,
        lastRebalanceMs: 0,
        lastRebalanceFeesUsdc: 0,
        totalRebalanceCostUsdc: 0,
        totalSwapSlippageUsdc: 0,
        rebalanceHistory: [],
        currentPositionPubkey: pubkey,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Test sections
// ---------------------------------------------------------------------------

async function testExecutionState(mockKS: ReturnType<typeof makeMockKillSwitch>): Promise<void> {
  console.log("\n── 1. GET /api/execution-state ────────────────────────────────");

  const res = await get("/api/execution-state");
  assert("status 200", res.status === 200, String(res.status));

  const body = await res.json() as Record<string, unknown>;
  assert("has killSwitchTriggered field", "killSwitchTriggered" in body, JSON.stringify(body));
  assert("killSwitchTriggered=false", body["killSwitchTriggered"] === false);
  assert("has runners array", Array.isArray(body["runners"]), JSON.stringify(body));

  const runners = body["runners"] as Array<Record<string, unknown>>;
  assert("2 runners in response", runners.length === 2, String(runners.length));

  const r = runners[0];
  const requiredFields = ["id", "paused", "rebalanceInFlight", "lastGateResult",
    "rebalanceCount", "lastRebalanceMs", "lastRebalanceFeesUsdc",
    "totalRebalanceCostUsdc", "totalSwapSlippageUsdc", "rebalanceHistory",
    "currentPositionPubkey"];
  for (const field of requiredFields) {
    assert(`runner[0] has '${field}'`, field in r, JSON.stringify(Object.keys(r)));
  }

  assert(
    "currentPositionPubkey is a string (base58)",
    typeof r["currentPositionPubkey"] === "string" && (r["currentPositionPubkey"] as string).length > 30
  );
}

async function testPauseResume(
  runner01: ReturnType<typeof makeMockRunner>,
  mockKS: ReturnType<typeof makeMockKillSwitch>
): Promise<void> {
  console.log("\n── 2. POST /api/pause/:id ─────────────────────────────────────");

  // Valid id → pauses
  const r1 = await post("/api/pause/test-01");
  assert("pause valid id → 200", r1.status === 200, String(r1.status));
  const b1 = await r1.json() as Record<string, unknown>;
  assert("pause response success=true", b1["success"] === true);
  assert("pause response paused=true", b1["paused"] === true);
  assert("runner.paused=true after request", runner01.paused);

  // Unknown id → 404
  const r2 = await post("/api/pause/nonexistent");
  assert("pause unknown id → 404", r2.status === 404, String(r2.status));
  await r2.json(); // drain

  console.log("\n── 3. POST /api/resume/:id ────────────────────────────────────");

  // Valid id, kill switch NOT triggered → resumes
  const r3 = await post("/api/resume/test-01");
  assert("resume valid id → 200", r3.status === 200, String(r3.status));
  const b3 = await r3.json() as Record<string, unknown>;
  assert("resume response paused=false", b3["paused"] === false);
  assert("runner.paused=false after resume", !runner01.paused);

  // Unknown id → 404
  const r4 = await post("/api/resume/nonexistent");
  assert("resume unknown id → 404", r4.status === 404, String(r4.status));
  await r4.json();

  // Kill switch active → 409
  mockKS._triggered = true; // simulate kill switch already fired
  const r5 = await post("/api/resume/test-01");
  assert("resume when kill switch active → 409", r5.status === 409, String(r5.status));
  const b5 = await r5.json() as Record<string, unknown>;
  assert("409 body has error field", typeof b5["error"] === "string");
  mockKS._triggered = false; // restore for subsequent tests
}

async function testKillEndpoint(mockKS: ReturnType<typeof makeMockKillSwitch>): Promise<void> {
  console.log("\n── 4. POST /api/kill ──────────────────────────────────────────");

  // No auth header → 401
  const r1 = await post("/api/kill", { reason: "test no-token" });
  assert("no auth header → 401", r1.status === 401, String(r1.status));
  await r1.json();

  // Wrong token → 401
  const r2 = await post("/api/kill", { reason: "wrong token" }, "wrong-token");
  assert("wrong token → 401", r2.status === 401, String(r2.status));
  await r2.json();

  // Correct token → 200 and triggers kill switch
  const r3 = await post("/api/kill", { reason: "test trigger" }, KILL_TOKEN);
  assert("correct token → 200", r3.status === 200, String(r3.status));
  const b3 = await r3.json() as Record<string, unknown>;
  assert("kill response success=true", b3["success"] === true);
  assert("kill switch triggered", mockKS.triggered);
  const result = b3["result"] as Record<string, unknown>;
  assert("result.reason = 'test trigger'", result["reason"] === "test trigger");
  assert("result.allSucceeded=true", result["allSucceeded"] === true);

  // GET /api/execution-state now shows killSwitchTriggered=true
  const r4 = await get("/api/execution-state");
  const b4 = await r4.json() as Record<string, unknown>;
  assert("execution-state reflects kill switch triggered", b4["killSwitchTriggered"] === true);

  // Idempotent — second call is a no-op (still 200 but allSucceeded=false, outcomes=[])
  const r5 = await post("/api/kill", { reason: "duplicate" }, KILL_TOKEN);
  assert("duplicate kill → still 200", r5.status === 200, String(r5.status));
  const b5 = await r5.json() as Record<string, unknown>;
  const result5 = b5["result"] as Record<string, unknown>;
  assert("duplicate kill → outcomes=[] (no-op)", (result5["outcomes"] as unknown[]).length === 0);
}

function testEmitStateUpdate(): void {
  console.log("\n── 5. emitStateUpdate ─────────────────────────────────────────");

  let threw = false;
  try {
    emitStateUpdate({
      solPrice: 167.42,
      timestamp: Date.now(),
      runners: [
        {
          id: "test-01",
          label: "Test 01",
          inRange: true,
          valueUsdc: 1500,
          ilUsdc: 5,
          feesUsdc: 8,
          feeIlRatio: "1.60x",
          pnlUsdc: 3,
          intervalVol: 0.003,
          bias: 0.1,
          biasArrow: "▲",
        },
      ],
    });
  } catch (err) {
    threw = true;
    fail("emitStateUpdate threw", String(err));
  }

  if (!threw) pass("emitStateUpdate completed without throwing");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  Phase 5 Test — Server Integration");
  console.log("=".repeat(60));

  // Set kill switch token BEFORE registering endpoints (captured in closure)
  process.env["KILL_SWITCH_TOKEN"] = KILL_TOKEN;

  const mockKS = makeMockKillSwitch();
  const runner01 = makeMockRunner("test-01", "Test Strategy 01");
  const runner02 = makeMockRunner("test-02", "Test Strategy 02");

  // Register execution endpoints before starting the server
  // Cast to satisfy structural types — mock objects satisfy the required interface
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerExecutionEndpoints(mockKS as any, [runner01 as any, runner02 as any]);

  // Start the server on the test port
  startDashboard(TEST_PORT);

  // Brief pause to allow the HTTP server to begin listening
  await new Promise((r) => setTimeout(r, 100));

  try {
    await testExecutionState(mockKS);
    await testPauseResume(runner01, mockKS);
    await testKillEndpoint(mockKS);
    testEmitStateUpdate();
  } finally {
    await stopDashboard();
  }

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
