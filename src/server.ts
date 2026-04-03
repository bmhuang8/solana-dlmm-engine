/**
 * src/server.ts
 *
 * Express + Socket.io server that powers the live dashboard.
 * Started once at bot startup; the poll loop calls emitStateUpdate()
 * every tick to push fresh data to all connected browsers.
 *
 * Execution endpoints (only active when EXECUTION_ENABLED=true):
 *   POST /api/kill              — trigger emergency withdrawal (requires KILL_SWITCH_TOKEN)
 *   POST /api/pause/:id         — pause one runner's execution
 *   POST /api/resume/:id        — resume one runner's execution
 *   GET  /api/execution-state   — snapshot of all runners' ExecutionState
 *
 * Socket.io events emitted by execution layer:
 *   rebalance_start     — rebalance sequence has begun
 *   rebalance_complete  — rebalance succeeded, new position deployed
 *   rebalance_failed    — rebalance failed at a specific step
 *   execution_update    — periodic gate status / execution state
 *   kill_switch         — kill switch was triggered
 *
 * Socket.io events received from dashboard:
 *   kill_switch         — dashboard-initiated emergency withdrawal
 */

import express from "express";
import crypto from "crypto";
import { createServer } from "http";
import { Server as SocketServer } from "socket.io";
import path from "path";
import type { TickStats } from "./runners/strategyRunner";
import type { KillSwitch } from "./execution/killSwitch";
import type { ExecutionRunner } from "./execution/executionRunner";

const app = express();
app.use(express.json());
const httpServer = createServer(app);
export const io = new SocketServer(httpServer);

// ---------------------------------------------------------------------------
// Simple password gate — set DASHBOARD_PASSWORD in .env to enable
// ---------------------------------------------------------------------------
const DASHBOARD_PASSWORD = process.env["DASHBOARD_PASSWORD"] ?? "";
const activeSessions = new Set<string>();

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  header.split(";").forEach((c) => {
    const [k, ...v] = c.trim().split("=");
    if (k) cookies[k] = v.join("=");
  });
  return cookies;
}

function isAuthenticated(cookieHeader: string | undefined): boolean {
  if (!DASHBOARD_PASSWORD) return true; // no password = no gate
  if (!cookieHeader) return false;
  const cookies = parseCookies(cookieHeader);
  return activeSessions.has(cookies["sentinel_session"] ?? "");
}

// Login page
app.get("/login", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sentinel Login</title>
<style>body{font-family:monospace;background:#09090f;color:#e5e5e5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
form{background:#111;border:1px solid #333;border-radius:12px;padding:2rem;width:300px;text-align:center}
input{width:100%;padding:10px;margin:12px 0;border:1px solid #444;border-radius:6px;background:#1a1a2e;color:#e5e5e5;font-family:monospace;box-sizing:border-box}
button{width:100%;padding:10px;border:none;border-radius:6px;background:#3b82f6;color:#fff;font-weight:bold;font-family:monospace;cursor:pointer}
button:hover{background:#2563eb}.err{color:#f87171;font-size:13px;margin-top:8px}
h2{margin:0 0 8px;font-size:18px;letter-spacing:2px;text-transform:uppercase}</style></head>
<body><form method="POST" action="/login"><h2>Meteora Sentinel</h2>
<input type="password" name="password" placeholder="Password" autofocus>
<button type="submit">Enter</button>
<div class="err" id="err"></div></form>
<script>if(location.search.includes('fail'))document.getElementById('err').textContent='Wrong password'</script>
</body></html>`);
});

app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
  if (req.body?.password === DASHBOARD_PASSWORD) {
    const token = generateToken();
    activeSessions.add(token);
    res.setHeader("Set-Cookie", `sentinel_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`);
    res.redirect("/");
  } else {
    res.redirect("/login?fail=1");
  }
});

// Auth middleware — blocks everything except /login and socket.io
if (DASHBOARD_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path === "/login") return next();
    if (isAuthenticated(req.headers.cookie)) return next();
    res.redirect("/login");
  });
}

// Serve public/ from the project root (one level above src/)
app.use(express.static(path.join(__dirname, "..", "public")));

export function startDashboard(port = 3000): void {
  // Reject unauthenticated socket.io connections
  if (DASHBOARD_PASSWORD) {
    io.use((socket, next) => {
      const cookie = socket.handshake.headers.cookie ?? "";
      if (isAuthenticated(cookie)) return next();
      next(new Error("Unauthorized — reload the page and log in"));
    });
  }

  httpServer.listen(port, () => {
    console.log(`[dashboard] http://localhost:${port}`);
  });
}

export function stopDashboard(): Promise<void> {
  return new Promise((resolve) => {
    io.close();
    httpServer.close(() => resolve());
  });
}

export interface StateUpdate {
  solPrice: number;
  timestamp: number;
  runners: TickStats[];
}

export function emitStateUpdate(update: StateUpdate): void {
  io.emit("state_update", update);
}

// ---------------------------------------------------------------------------
// Execution endpoints — registered only when execution mode is active
// ---------------------------------------------------------------------------

/**
 * Wire up kill-switch HTTP and Socket.io endpoints.
 * Call this from index.ts after creating the KillSwitch and ExecutionRunners.
 */
export function registerExecutionEndpoints(
  killSwitch: KillSwitch,
  executionRunners: ExecutionRunner[]
): void {
  const killToken = process.env["KILL_SWITCH_TOKEN"];

  // -------------------------------------------------------------------------
  // POST /api/kill — emergency withdrawal (requires Authorization header)
  // -------------------------------------------------------------------------
  app.post("/api/kill", async (req, res) => {
    if (killToken) {
      const authHeader = req.headers["authorization"] ?? "";
      const provided = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : authHeader;

      if (provided !== killToken) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    const reason: string =
      (req.body as Record<string, unknown>)?.["reason"] as string ||
      "HTTP kill endpoint";

    console.log(`[server] /api/kill received — reason: ${reason}`);

    try {
      const result = await killSwitch.trigger(reason);
      io.emit("kill_switch", { reason, result, timestamp: Date.now() });
      res.json({ success: true, result });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/pause/:id — pause one runner's execution
  // -------------------------------------------------------------------------
  app.post("/api/pause/:id", (req, res) => {
    const runner = executionRunners.find((r) => r.id === req.params["id"]);
    if (!runner) {
      res.status(404).json({ error: `Runner "${req.params["id"]}" not found` });
      return;
    }
    runner.paused = true;
    res.json({ success: true, id: runner.id, paused: true });
  });

  // -------------------------------------------------------------------------
  // POST /api/resume/:id — resume one runner's execution
  // -------------------------------------------------------------------------
  app.post("/api/resume/:id", (req, res) => {
    const runner = executionRunners.find((r) => r.id === req.params["id"]);
    if (!runner) {
      res.status(404).json({ error: `Runner "${req.params["id"]}" not found` });
      return;
    }
    if (killSwitch.triggered) {
      res.status(409).json({
        error: "Kill switch is active — restart the bot to resume execution",
      });
      return;
    }
    runner.paused = false;
    res.json({ success: true, id: runner.id, paused: false });
  });

  // -------------------------------------------------------------------------
  // GET /api/execution-state — snapshot of all runners' execution state
  // -------------------------------------------------------------------------
  app.get("/api/execution-state", (_req, res) => {
    const state = executionRunners.map((r) => {
      const es = r.executionState;
      return {
        id: r.id,
        paused: es.paused,
        rebalanceInFlight: es.rebalanceInFlight,
        lastGateResult: es.lastGateResult,
        rebalanceCount: es.rebalanceCount,
        lastRebalanceMs: es.lastRebalanceMs,
        lastRebalanceFeesUsdc: es.lastRebalanceFeesUsdc,
        totalRebalanceCostUsdc: es.totalRebalanceCostUsdc,
        totalSwapSlippageUsdc: es.totalSwapSlippageUsdc,
        rebalanceHistory: es.rebalanceHistory,
        currentPositionPubkey: es.currentPositionPubkey.toBase58(),
      };
    });
    res.json({ killSwitchTriggered: killSwitch.triggered, runners: state });
  });

  // -------------------------------------------------------------------------
  // Socket.io: kill_switch + manual_rebalance events from dashboard
  // -------------------------------------------------------------------------
  io.on("connection", (socket) => {
    socket.on("kill_switch", async (data: { reason?: string }) => {
      const reason = data?.reason ?? "dashboard kill switch";
      console.log(`[server] kill_switch socket event — reason: ${reason}`);

      try {
        const result = await killSwitch.trigger(reason);
        io.emit("kill_switch", { reason, result, timestamp: Date.now() });
      } catch (err) {
        socket.emit("kill_switch_error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    socket.on("manual_rebalance", async (data: { strategyId: string; solPrice: number }) => {
      const runner = executionRunners.find((r) => r.id === data.strategyId);
      if (!runner) {
        socket.emit("manual_rebalance_result", {
          strategyId: data.strategyId,
          success: false,
          error: `Runner "${data.strategyId}" not found`,
        });
        return;
      }

      console.log(`[server] manual_rebalance for ${data.strategyId} @ $${data.solPrice.toFixed(2)}`);

      try {
        const result = await runner.forceRebalance(data.solPrice);
        socket.emit("manual_rebalance_result", {
          strategyId: data.strategyId,
          ...result,
        });
      } catch (err) {
        socket.emit("manual_rebalance_result", {
          strategyId: data.strategyId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  });

  console.log("[server] Execution endpoints registered");
}
