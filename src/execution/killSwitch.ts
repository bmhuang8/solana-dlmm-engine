/**
 * execution/killSwitch.ts
 *
 * Emergency global withdrawal. Withdraws ALL positions across all runners,
 * returning funds to the wallet. No new positions are deployed.
 *
 * Activation paths:
 *   - POST /api/kill  HTTP endpoint (Phase 5 — server.ts)
 *   - kill_switch     Socket.io event from dashboard (Phase 5 — server.ts)
 *   - Double SIGINT   (first = graceful shutdown, second = emergency)
 *   - Programmatic    (e.g. wallet SOL balance < 0.05)
 *
 * Algorithm:
 *   1. Set isTriggered = true (blocks new rebalances system-wide)
 *   2. Pause all runners
 *   3. Wait for in-flight rebalances to complete (30s timeout each)
 *   4. Withdraw all positions in parallel
 *   5. Return aggregate results
 */

import { ExecutionRunner } from "./executionRunner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WithdrawOutcome {
  strategyId: string;
  success: boolean;
  signatures: string[];
  error?: string;
}

export interface KillSwitchResult {
  triggeredAt: number;
  reason: string;
  outcomes: WithdrawOutcome[];
  allSucceeded: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max time to wait for each in-flight rebalance to finish before force-withdrawing */
const INFLIGHT_WAIT_TIMEOUT_MS = 30_000;
const INFLIGHT_POLL_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// KillSwitch
// ---------------------------------------------------------------------------

export class KillSwitch {
  private isTriggered = false;
  private runners: ExecutionRunner[] = [];

  /**
   * Register the execution runners managed by this kill switch.
   * Call once after all ExecutionRunners are created at startup.
   */
  registerRunners(runners: ExecutionRunner[]): void {
    this.runners = runners;
    console.log(
      `[killSwitch] Registered ${runners.length} runner(s): ` +
        runners.map((r) => r.id).join(", ")
    );
  }

  /**
   * Trigger the emergency withdrawal sequence.
   * Safe to call multiple times — subsequent calls are no-ops (returns prior result reference).
   *
   * @param reason  Human-readable reason for audit logs and dashboard display
   */
  async trigger(reason: string): Promise<KillSwitchResult> {
    if (this.isTriggered) {
      console.warn("[killSwitch] Already triggered — ignoring duplicate call");
      return {
        triggeredAt: Date.now(),
        reason: `duplicate trigger (original reason: ${reason})`,
        outcomes: [],
        allSucceeded: false,
      };
    }

    this.isTriggered = true;
    const triggeredAt = Date.now();

    console.error(
      `\n${"!".repeat(60)}\n` +
        `[killSwitch] KILL SWITCH TRIGGERED: ${reason}\n` +
        `${"!".repeat(60)}\n`
    );

    // Step 2: Pause all runners (blocks new rebalances from triggering)
    for (const runner of this.runners) {
      runner.paused = true;
    }

    // Step 3: Wait for any in-flight rebalances to complete
    await Promise.all(
      this.runners.map((runner) => this._waitForInFlight(runner))
    );

    // Step 4: Emergency withdraw all positions in parallel
    console.log(`[killSwitch] Withdrawing ${this.runners.length} position(s)…`);

    const outcomes = await Promise.all(
      this.runners.map(async (runner): Promise<WithdrawOutcome> => {
        try {
          const result = await runner.emergencyWithdraw();
          console.log(
            `[killSwitch] ${runner.id}: ${result.success ? "✓" : "✗"} ` +
              (result.error ? `— ${result.error}` : `— ${result.signatures.length} tx(s)`)
          );
          return { strategyId: runner.id, ...result };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          console.error(`[killSwitch] ${runner.id}: unexpected error — ${error}`);
          return { strategyId: runner.id, success: false, signatures: [], error };
        }
      })
    );

    const allSucceeded = outcomes.every((o) => o.success);

    console.log(
      `[killSwitch] Done. ` +
        `${outcomes.filter((o) => o.success).length}/${outcomes.length} withdrawals succeeded.`
    );

    return { triggeredAt, reason, outcomes, allSucceeded };
  }

  get triggered(): boolean {
    return this.isTriggered;
  }

  /**
   * Reset the kill switch. Only use this in testing — in production, a triggered
   * kill switch should require a manual restart.
   */
  reset(): void {
    this.isTriggered = false;
    for (const runner of this.runners) {
      runner.paused = false;
    }
    console.warn("[killSwitch] Reset — kill switch cleared.");
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async _waitForInFlight(runner: ExecutionRunner): Promise<void> {
    if (!runner.rebalanceInFlight) return;

    console.log(
      `[killSwitch] ${runner.id}: waiting for in-flight rebalance to finish ` +
        `(max ${INFLIGHT_WAIT_TIMEOUT_MS / 1000}s)…`
    );

    const deadline = Date.now() + INFLIGHT_WAIT_TIMEOUT_MS;

    while (runner.rebalanceInFlight && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, INFLIGHT_POLL_INTERVAL_MS));
    }

    if (runner.rebalanceInFlight) {
      console.warn(
        `[killSwitch] ${runner.id}: timed out waiting for in-flight rebalance — proceeding anyway`
      );
    } else {
      console.log(`[killSwitch] ${runner.id}: in-flight rebalance finished`);
    }
  }
}
