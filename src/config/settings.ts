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
  // Forward-test strategies
  //
  // Each entry corresponds to one on-chain position account.
  // POSITION_PUBKEY_01 is the base58 address of the position account,
  // found in the Meteora UI or by running getPositionsByUserAndLbPair.
  //
  // To add more strategies:
  //   1. Deploy a new position via the Meteora UI
  //   2. Add POSITION_PUBKEY_0N=<base58> to your .env
  //   3. Copy one of the entries below, update id/label/positionPubkey/entry
  // ---------------------------------------------------------------------------
  strategies: [
    {
      id: "strategy-01",
      label: "S01-9BIN",
      positionPubkey: requireEnv("POSITION_PUBKEY_01"),
      binRadius: 4,              // 9 bins total (±4 bins = ±0.4% range)
      strategyType: 0,           // Spot distribution
      outOfRangeBinThreshold: 0, // rebalance as soon as price leaves the range
      minRebalanceIntervalMs: 0,
      feeGateMultiplier: 1.0,    // fees must cover tx cost (1×) — fair test baseline
    },
    //{
    //  id: "strategy-02",
    //  label: "S02-19BIN",
    //  positionPubkey: requireEnv("POSITION_PUBKEY_02"),
    //  binRadius: 9,              // 19 bins total (±9 bins = ±0.9% range)
    //  strategyType: 0,           // Spot distribution
     // outOfRangeBinThreshold: 0, // rebalance as soon as price leaves the range
     // minRebalanceIntervalMs: 0,
     // feeGateMultiplier: 1.0,    // fees must cover tx cost (1×) — fair test baseline
    //},
    //{
     // id: "strategy-03",
      //label: "S03-31BIN",
      //positionPubkey: requireEnv("POSITION_PUBKEY_03"),
      //binRadius: 15,             // 31 bins total (±15 bins = ±1.5% range)
      //strategyType: 0,           // Spot distribution
      //outOfRangeBinThreshold: 0,
      //minRebalanceIntervalMs: 0,
      //feeGateMultiplier: 1.0,
    //},
    // { id: "strategy-04", label: "S04", positionPubkey: requireEnv("POSITION_PUBKEY_04") },
    // { id: "strategy-04", label: "S04", positionPubkey: requireEnv("POSITION_PUBKEY_04") },
    // { id: "strategy-05", label: "S05", positionPubkey: requireEnv("POSITION_PUBKEY_05") },
    // { id: "strategy-06", label: "S06", positionPubkey: requireEnv("POSITION_PUBKEY_06") },
  ],
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
