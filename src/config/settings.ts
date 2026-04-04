import dotenv from "dotenv";
import { PublicKey } from "@solana/web3.js";

// Load environment variables from .env file
dotenv.config();

/**
 * Per-strategy configuration — one entry per forward-test position.
 * Each strategy maps 1:1 to a single on-chain DLMM position account.
 *
 * No entry snapshot is needed here — baselines are captured automatically
 * at startup by initializeBaselines() in index.ts.
 *
 * To find your position pubkey: open the Meteora UI, connect your wallet,
 * and inspect the position transaction or use `getPositionsByUserAndLbPair`.
 */
export interface StrategyConfig {
  /** Short identifier used for log file naming (e.g. "strategy-01") */
  id: string;
  /** Human-readable label shown in console output */
  label: string;
  /**
   * Base58 pubkey of the on-chain position account.
   * This is NOT the pool pubkey or the owner pubkey — it's the specific
   * position account created when you deposited into the pool.
   */
  positionPubkey: string;
  /** Override global defaultBinRadius for this strategy */
  binRadius?: number;
  /** Override global defaultStrategyType for this strategy (0=Spot, 1=Curve, 2=BidAsk) */
  strategyType?: number;
  /** Override global feeGateMultiplier for this strategy */
  feeGateMultiplier?: number;
  /** Override global outOfRangeBinThreshold for this strategy */
  outOfRangeBinThreshold?: number;
  /** Override global minRebalanceIntervalMs for this strategy */
  minRebalanceIntervalMs?: number;
}

/**
 * Execution engine configuration — controls autonomous rebalancing behavior.
 * Only active when EXECUTION_ENABLED=true.
 */
export interface ExecutionConfig {
  /** Master switch — set EXECUTION_ENABLED=true to enable rebalancing */
  enabled: boolean;
  /** Base58 or JSON-array private key for the wallet that owns positions */
  walletPrivateKey: string;
  /** Jupiter V6 REST API base URL */
  jupiterApiUrl: string;
  /** Priority fee in microlamports added to every transaction */
  priorityFeeMicrolamports: number;
  /** Maximum acceptable slippage for Jupiter swaps in basis points (50 = 0.5%) */
  maxSlippageBps: number;
  /** Maximum acceptable slippage for Meteora deposit in basis points (100 = 1%) */
  meteoraSlippageBps: number;
  /** How many bins beyond the position edge triggers a rebalance */
  outOfRangeBinThreshold: number;
  /** Multiplier on estimated tx cost — fees must exceed this × cost to rebalance */
  feeGateMultiplier: number;
  /** Minimum ms between rebalances (prevents rapid-fire in choppy markets) */
  minRebalanceIntervalMs: number;
  /** Bollinger width threshold above which volatility cooldown is active */
  volatilityCooldownThreshold: number;
  /** How long (ms) to pause after a volatility spike clears */
  volatilityCooldownMs: number;
  /** Max transaction send retries before giving up */
  maxRetries: number;
  /** Base delay for exponential backoff on retries (ms) */
  retryBaseDelayMs: number;
  /** Default DLMM strategy type: 0=Spot, 1=Curve, 2=BidAsk */
  defaultStrategyType: number;
  /** Default bin radius for new positions (half-width around active bin) */
  defaultBinRadius: number;
}

/** Global bot configuration — shared across all strategies */
export interface AppConfig {
  /** Solana RPC endpoint URL */
  rpcUrl: string;
  /** The SOL/USDC DLMM pool (Bin Step 10, Fee 0.10%) */
  poolPubkey: PublicKey;
  /** Pool bin step in basis points (10 = 0.10%) */
  binStep: number;
  /** How often the main loop polls on-chain state (ms) */
  pollIntervalMs: number;
  /** How often the heartbeat checks RPC liveness (ms) */
  heartbeatIntervalMs: number;
  /** Set to true when hedging is ready to be enabled */
  hedgingEnabled: boolean;
  /**
   * Forward-test strategies — one entry per on-chain position.
   * All strategies share the same pool and poll cycle, but each gets its
   * own analytics trackers and JSONL log file at logs/<id>.jsonl.
   */
  strategies: StrategyConfig[];
}

// ---------------------------------------------------------------------------
// Validate required environment variables
// ---------------------------------------------------------------------------

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${key}\n` +
        `Copy .env.example to .env and fill in the values.`
    );
  }
  return value;
}

function optionalEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function optionalEnvFloat(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

function optionalEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === "true";
}

// ---------------------------------------------------------------------------
// Strategy builder — auto-discovers strategies from POSITION_PUBKEY_XX env vars
// ---------------------------------------------------------------------------

function buildStrategiesFromEnv(): StrategyConfig[] {
  const strategies: StrategyConfig[] = [];

  for (let i = 1; i <= 6; i++) {
    const num = String(i).padStart(2, "0");
    const pubkey = process.env[`POSITION_PUBKEY_${num}`];
    if (!pubkey) continue;

    // Parse optional STRATEGY_XX=binRadius,strategyType,outOfRangeBinThreshold,minRebalanceIntervalMs,feeGateMultiplier
    const raw = process.env[`STRATEGY_${num}`];
    const parts = raw ? raw.split(",").map((s) => s.trim()) : [];

    const binRadius = parts[0] ? parseInt(parts[0], 10) : 10;
    const strategyType = parts[1] ? parseInt(parts[1], 10) : 0;
    const outOfRangeBinThreshold = parts[2] ? parseInt(parts[2], 10) : 0;
    const minRebalanceIntervalMs = parts[3] ? parseInt(parts[3], 10) : 0;
    const feeGateMultiplier = parts[4] ? parseFloat(parts[4]) : 1.0;

    const totalBins = 2 * binRadius + 1;
    strategies.push({
      id: `strategy-${num}`,
      label: `S${num}-${totalBins}BIN`,
      positionPubkey: pubkey,
      binRadius,
      strategyType,
      outOfRangeBinThreshold,
      minRebalanceIntervalMs,
      feeGateMultiplier,
    });
  }

  if (strategies.length === 0) {
    throw new Error(
      "No strategies found — set at least POSITION_PUBKEY_01 in .env"
    );
  }

  return strategies;
}

// ---------------------------------------------------------------------------
// Build and export the config object
// ---------------------------------------------------------------------------

export const config: AppConfig = {
  rpcUrl: requireEnv("RPC_URL"),

  // SOL/USDC DLMM pool — Bin Step 10, Fee 0.10%
  poolPubkey: new PublicKey("BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y"),

  binStep: 10,

  // Poll every 5 seconds
  pollIntervalMs: 5_000,

  // Check RPC liveness every 30 seconds
  heartbeatIntervalMs: 30_000,

  // Flip to true once hedging is implemented
  hedgingEnabled: false,

  // ---------------------------------------------------------------------------
  // Forward-test strategies — auto-discovered from .env
  //
  // For each POSITION_PUBKEY_XX that exists, a strategy is created.
  // Per-strategy settings are read from STRATEGY_XX env var (comma-separated):
  //   STRATEGY_XX=binRadius,strategyType,outOfRangeBinThreshold,minRebalanceIntervalMs,feeGateMultiplier
  //
  // Example .env:
  //   POSITION_PUBKEY_01=<base58>
  //   STRATEGY_01=4,0,0,0,1.0       # 9-bin, Spot, immediate rebal, no delay, 1x fee gate
  //   POSITION_PUBKEY_02=<base58>
  //   STRATEGY_02=9,0,0,0,1.0       # 19-bin
  //
  // If STRATEGY_XX is not set, defaults are used (binRadius=10, strategyType=0,
  // outOfRangeBinThreshold=0, minRebalanceIntervalMs=0, feeGateMultiplier=1.0).
  // ---------------------------------------------------------------------------
  strategies: buildStrategiesFromEnv(),
};

// ---------------------------------------------------------------------------
// Execution engine config — only consulted when EXECUTION_ENABLED=true
// ---------------------------------------------------------------------------

export const executionConfig: ExecutionConfig = {
  enabled: optionalEnvBool("EXECUTION_ENABLED", false),
  walletPrivateKey: process.env["WALLET_PRIVATE_KEY"] ?? "",
  jupiterApiUrl: process.env["JUPITER_API_URL"] ?? "https://lite-api.jup.ag/swap/v1",
  priorityFeeMicrolamports: optionalEnvInt("PRIORITY_FEE_MICROLAMPORTS", 50_000),
  maxSlippageBps: optionalEnvInt("MAX_SLIPPAGE_BPS", 50),
  meteoraSlippageBps: optionalEnvInt("METEORA_SLIPPAGE_BPS", 100),
  outOfRangeBinThreshold: optionalEnvInt("OUT_OF_RANGE_BIN_THRESHOLD", 2),
  feeGateMultiplier: optionalEnvFloat("FEE_GATE_MULTIPLIER", 3.0),
  minRebalanceIntervalMs: optionalEnvInt("MIN_REBALANCE_INTERVAL_MS", 300_000),
  volatilityCooldownThreshold: optionalEnvFloat("VOLATILITY_COOLDOWN_THRESHOLD", 0.02),
  volatilityCooldownMs: optionalEnvInt("VOLATILITY_COOLDOWN_MS", 900_000),
  maxRetries: optionalEnvInt("MAX_RETRIES", 3),
  retryBaseDelayMs: optionalEnvInt("RETRY_BASE_DELAY_MS", 1_000),
  defaultStrategyType: optionalEnvInt("DEFAULT_STRATEGY_TYPE", 0),
  defaultBinRadius: optionalEnvInt("DEFAULT_BIN_RADIUS", 10),
};
