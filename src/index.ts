/**
 * src/index.ts
 *
 * Main entry point for Meteora Sentinel — multi-strategy forward-test runner.
 *
 * Startup sequence:
 *   1. Load config + connect to Solana RPC
 *   2. initAllPositionCaches() — one batch RPC call to discover bin-array
 *      pubkeys for all strategies
 *   3. Create one StrategyRunner per strategy
 *   4. initializeBaselines() — one batch RPC call + Pyth fetch to snapshot
 *      each position's token amounts and the genesis SOL price; stores the
 *      result in runner.entryState (no hardcoded values needed)
 *   5. Start heartbeat
 *   6. Enter poll loop
 *
 * Poll loop (every pollIntervalMs):
 *   a. fetchBatchedState()  — ONE getMultipleAccountsInfo for pool + clock +
 *                             all strategy positions + all bin-arrays combined
 *   b. fetchPrice()         — HTTP to Pyth (not an RPC call)
 *   c. runner.tick() for each strategy — pure analytics + JSONL write
 *   d. sleep
 *
 * RPC call budget per cycle: exactly 1 (the batch fetch).
 * Pyth HTTP is independent of the Solana RPC credit limit.
 */

import { config, executionConfig } from "./config/settings";
import { PublicKey } from "@solana/web3.js";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { initializeClient, startHeartbeat, stopHeartbeat, connection } from "./core/client";
import { initAllPositionCaches, fetchBatchedState } from "./core/batchFetcher";
import { fetchPrice } from "./core/priceFeed";
import { loadGenesisFromChain } from "./core/genesisLoader";
import { StrategyRunner, EntryState } from "./runners/strategyRunner";
import { startDashboard, stopDashboard, emitStateUpdate, registerExecutionEndpoints, io } from "./server";
import { initializeSigner } from "./core/signer";
import { ExecutionRunner } from "./execution/executionRunner";
import { RebalanceOrchestrator } from "./execution/rebalanceOrchestrator";
import { KillSwitch } from "./execution/killSwitch";

// ---------------------------------------------------------------------------
// Shutdown state — SIGINT handling with double-tap kill switch
// ---------------------------------------------------------------------------

let shutdownRequested = false;
let sigintCount = 0;

// Object container prevents TypeScript narrowing the value to null inside closures.
// Assigned during main() startup when execution mode is active.
const ctx: { killSwitch: KillSwitch | null } = { killSwitch: null };

process.on("SIGINT", () => {
  sigintCount++;

  if (sigintCount === 1) {
    console.log("\n[sentinel] SIGINT received — shutting down after this cycle...");
    shutdownRequested = true;
  } else if (sigintCount === 2) {
    const ks = ctx.killSwitch;
    if (ks !== null && !ks.triggered) {
      console.error("\n[sentinel] Second SIGINT — triggering emergency withdrawal!");
      ks.trigger("double SIGINT (Ctrl-C twice)").then(() => {
        process.exit(1);
      }).catch(() => {
        process.exit(1);
      });
    } else {
      process.exit(1);
    }
  } else {
    console.error("\n[sentinel] Force exit.");
    process.exit(1);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// Baseline initialization — runs once before the poll loop
// ---------------------------------------------------------------------------

/**
 * Captures the genesis state for every strategy in one batched operation:
 *   - ONE getMultipleAccountsInfo call (via fetchBatchedState) for pool + all positions
 *   - ONE HTTP call to Pyth for the genesis SOL price
 *
 * If some positions aren't deployed yet, retries up to maxAttempts times
 * (with a short delay between each) so the bot can start before all
 * positions are live. Runners without a baseline skip analytics until
 * their position appears and a subsequent retry succeeds — but in practice
 * all positions should be deployed before starting the bot.
 *
 * Sets runner.entryState on each runner. The poll loop will not start
 * until this function returns.
 */
async function initializeBaselines(runners: StrategyRunner[]): Promise<void> {
  console.log("[sentinel] Locking baselines — recovering genesis from chain...");

  // -------------------------------------------------------------------------
  // Phase 1: Recover true genesis from on-chain transaction history.
  //
  // For each strategy, fetch the oldest transaction for the position account,
  // parse the original deposit amounts from pre/post token balances, and
  // fetch the SOL price at that block time from Pyth historical API.
  //
  // All runners are processed in parallel (each makes 2 RPC + 1 HTTP call).
  // -------------------------------------------------------------------------
  await Promise.all(
    runners.map(async (runner) => {
      const strategy = config.strategies.find((s) => s.id === runner.id)!;
      const positionPubkey = new PublicKey(strategy.positionPubkey);

      const genesis = await loadGenesisFromChain(connection, positionPubkey);
      if (genesis) {
        runner.setEntryState(genesis);
        console.log(
          `[sentinel] ${runner.id} LOCKED (chain genesis): ` +
            `${genesis.solAmount.toFixed(6)} SOL + ${genesis.usdcAmount.toFixed(4)} USDC ` +
            `= $${genesis.valueUsdc.toFixed(2)} ` +
            `@ $${genesis.solPrice.toFixed(2)}/SOL ` +
            `(deposited ${new Date(genesis.timestamp).toISOString()})`
        );
      } else {
        console.warn(
          `[sentinel] ${runner.id}: chain genesis unavailable — ` +
            `will fall back to current on-chain state.`
        );
      }
    })
  );

  // -------------------------------------------------------------------------
  // Phase 2: Fallback for runners that couldn't load genesis from chain.
  //
  // Uses the batched RPC fetch to snapshot current position state.
  // Retries until positions are found (handles not-yet-deployed positions).
  // -------------------------------------------------------------------------
  const needsFallback = runners.filter((r) => r.entryState === null);

  if (needsFallback.length > 0) {
    console.log(
      `[sentinel] ${needsFallback.length} runner(s) falling back to current state...`
    );

    const maxAttempts = 10;
    const retryDelayMs = 5_000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const batchedState = await fetchBatchedState(config.strategies);
      const price = await fetchPrice(batchedState.activeBinId);

      if (price.onChainPrice === 0) {
        console.warn(
          `[sentinel] Price unavailable (attempt ${attempt}/${maxAttempts}) — ` +
            `retrying in ${retryDelayMs / 1000}s...`
        );
        await sleep(retryDelayMs);
        continue;
      }

      let pendingCount = 0;
      for (const runner of needsFallback) {
        if (runner.entryState !== null) continue;

        const pos = batchedState.positions.get(runner.id);
        if (!pos?.found) {
          pendingCount++;
          continue;
        }

        const valueUsdc =
          pos.totalUsdcAmount + pos.totalSolAmount * price.onChainPrice;

        const entryState: EntryState = {
          timestamp: Date.now(),
          solPrice: price.onChainPrice,
          solAmount: pos.totalSolAmount,
          usdcAmount: pos.totalUsdcAmount,
          valueUsdc,
        };
        runner.setEntryState(entryState);

        console.log(
          `[sentinel] ${runner.id} LOCKED (current state): ` +
            `${pos.totalSolAmount.toFixed(6)} SOL + ` +
            `${pos.totalUsdcAmount.toFixed(4)} USDC ` +
            `= $${valueUsdc.toFixed(2)} @ $${price.onChainPrice.toFixed(2)}/SOL`
        );
      }

      if (pendingCount === 0) break;

      console.warn(
        `[sentinel] ${pendingCount} position(s) not found yet ` +
          `(attempt ${attempt}/${maxAttempts}) — retrying in ${retryDelayMs / 1000}s...`
      );
      await sleep(retryDelayMs);
    }
  }

  const lockedCount = runners.filter((r) => r.entryState !== null).length;
  console.log(
    `[sentinel] Baselines locked: ${lockedCount}/${runners.length} strategies ready.`
  );

  if (lockedCount === 0) {
    throw new Error(
      "No baselines could be established — ensure positions are deployed before starting."
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("  Meteora Sentinel — Multi-Strategy Forward Test Runner");
  console.log("=".repeat(70));

  // -------------------------------------------------------------------------
  // Connect to Solana and initialize DLMM pool
  // -------------------------------------------------------------------------
  try {
    await initializeClient();
  } catch (err) {
    console.error("[sentinel] FATAL: Failed to initialize client:", err);
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Boot-time cache init: one batch RPC call to discover bin-array pubkeys
  // for all strategies. Subsequent poll cycles use one call for everything.
  // -------------------------------------------------------------------------
  await initAllPositionCaches(config.strategies);

  // -------------------------------------------------------------------------
  // Create one StrategyRunner per strategy
  // -------------------------------------------------------------------------
  const analyticsRunners = config.strategies.map((s) => new StrategyRunner(s));

  // -------------------------------------------------------------------------
  // Execution mode — wrap analytics runners with ExecutionRunner if enabled
  // -------------------------------------------------------------------------
  let executionRunners: ExecutionRunner[] | null = null;

  if (executionConfig.enabled) {
    console.log("[sentinel] Execution mode ENABLED — initializing signer...");
    initializeSigner();

    const orchestrator = new RebalanceOrchestrator();
    const killSwitch = new KillSwitch();

    executionRunners = analyticsRunners.map(
      (analyticsRunner, i) =>
        new ExecutionRunner(
          config.strategies[i],
          i,
          executionConfig,
          orchestrator,
          analyticsRunner,
          io
        )
    );

    killSwitch.registerRunners(executionRunners);
    ctx.killSwitch = killSwitch;

    startDashboard();
    registerExecutionEndpoints(killSwitch, executionRunners);
  } else {
    startDashboard();
  }

  // runners alias: execution runners proxy analytics, fall back to analytics directly
  const runners = analyticsRunners;

  // -------------------------------------------------------------------------
  // Startup summary
  // -------------------------------------------------------------------------
  console.log("=".repeat(70));
  console.log(`[sentinel] Pool:       ${config.poolPubkey.toBase58()}`);
  console.log(`[sentinel] Strategies: ${config.strategies.length}`);
  for (const s of config.strategies) {
    console.log(`[sentinel]   ${s.label} → ${s.positionPubkey}`);
  }
  console.log(`[sentinel] Interval:   ${config.pollIntervalMs / 1000}s`);
  console.log("=".repeat(70));

  // -------------------------------------------------------------------------
  // Capture genesis baselines — one batch RPC + Pyth fetch, no hardcoding
  // -------------------------------------------------------------------------
  try {
    await initializeBaselines(analyticsRunners);
  } catch (err) {
    console.error("[sentinel] FATAL: Could not initialize baselines:", err);
    process.exit(1);
  }

  // Ensure logs directory exists before the poll loop writes to it
  mkdirSync(join(__dirname, "..", "logs"), { recursive: true });

  console.log("=".repeat(70));
  startHeartbeat();

  // -------------------------------------------------------------------------
  // Poll loop
  // -------------------------------------------------------------------------
  let cycleCount = 0;

  while (!shutdownRequested) {
    try {
      // --- 1. ONE RPC call: pool + clock + all positions --------------------
      const batchedState = await fetchBatchedState(config.strategies);

      // --- 2. Price feed (HTTP to Pyth — not an RPC call) ------------------
      const price = await fetchPrice(batchedState.activeBinId);

      // If price is unavailable skip analytics this cycle (stale cache
      // already logged a warning inside fetchPrice)
      if (price.onChainPrice === 0) {
        console.warn(
          `[${timestamp()}] Price unavailable — skipping analytics this cycle.`
        );
        await sleep(config.pollIntervalMs);
        continue;
      }

      // Check whether any strategy has a live position yet
      const anyFound = config.strategies.some(
        (s) => batchedState.positions.get(s.id)?.found
      );
      if (!anyFound) {
        console.log(
          `[${timestamp()}] No positions found yet. Waiting for deployment...`
        );
        await sleep(config.pollIntervalMs);
        continue;
      }

      // --- 3. Dispatch to runners -------------------------------------------
      // ExecutionRunner.tick() returns the same TickStats as StrategyRunner.tick(),
      // so the dashboard path is identical in both modes.
      const activeRunners = executionRunners ?? runners;
      const tickResults = activeRunners
        .map((runner) => {
          const positionState = batchedState.positions.get(runner.id);
          return positionState ? runner.tick(positionState, price) : null;
        })
        .filter((s): s is NonNullable<typeof s> => s !== null);

      // --- 4. Append tick to JSONL log (one file per strategy) -------------
      for (const stats of tickResults) {
        const row = JSON.stringify({
          ts: Date.now(),
          iso: new Date().toISOString(),
          strategyId: stats.id,
          price: price.onChainPrice,
          priceSource: price.source,
          activeBinId: batchedState.activeBinId,
          inRange: stats.inRange,
          posValue: stats.valueUsdc,
          ilUsdc: stats.ilUsdc,
          feesUsdc: stats.feesUsdc,
          feeIlRatio: stats.feeIlRatio,
          pnlUsdc: stats.pnlUsdc,
          iVol: stats.intervalVol,
          bBandWidth: price.onChainPrice > 0 ? stats.intervalVol : 0,
          bias: stats.bias,
        });
        const logPath = join(__dirname, "..", "logs", `${stats.id}.jsonl`);
        appendFileSync(logPath, row + "\n");
      }

      // --- 5. Push to dashboard --------------------------------------------
      emitStateUpdate({
        solPrice: price.onChainPrice,
        timestamp: Date.now(),
        runners: tickResults,
      });

      // --- 5. Minimal heartbeat (one compact line per cycle) ---------------
      cycleCount++;
      const execFlag = executionConfig.enabled ? " [EXEC]" : "";
      console.log(
        `[${timestamp()}] #${cycleCount} | SOL $${price.onChainPrice.toFixed(2)} | ${tickResults.length}/${analyticsRunners.length}${execFlag}`
      );
    } catch (err) {
      // A single failed cycle should never crash the process.
      console.error(`[${timestamp()}] Poll cycle error:`, err);
    }

    await sleep(config.pollIntervalMs);
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------
  stopHeartbeat();
  await stopDashboard();
  console.log("[sentinel] Shutdown complete.");
}

main();
