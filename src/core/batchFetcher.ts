/**
 * core/batchFetcher.ts
 *
 * Fetches all on-chain state for every strategy in exactly ONE
 * getMultipleAccountsInfo call per poll cycle.
 *
 * No strategy runner or analytics module ever touches the RPC directly.
 * All account data flows through here.
 *
 * Boot sequence (once at startup):
 *   initAllPositionCaches(strategies)
 *     → getPositionsByUserAndLbPair (one getProgramAccounts call)
 *     → match results against configured pubkeys to get bin ranges
 *     → compute + store bin-array pubkeys per strategy
 *
 * Poll cycle (every N seconds):
 *   fetchBatchedState(strategies)
 *     → builds one flat account list: [pool, clock, pos0, binArrays0…, pos1, binArrays1…, …]
 *     → one getMultipleAccountsInfo call
 *     → decodes pool + clock once (shared)
 *     → runs processPosition in parallel for all strategies (pure computation, no I/O)
 *     → returns BatchedState { activeBinId, positions: Map<strategyId, PositionState> }
 */

import { PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import DLMM, {
  decodeAccount,
  wrapPosition,
  getBinArrayKeysCoverage,
  ClockLayout,
  LbPair,
  BinArray,
} from "@meteora-ag/dlmm";
import { connection, dlmmPool } from "./client";
import { config, StrategyConfig } from "../config/settings";
import { PositionState, BinEntry } from "./position";

// Token decimal constants
const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Cached pubkeys for one strategy — populated once at boot */
interface StrategyCache {
  positionPubkey: PublicKey;
  /** All bin-array accounts covering this position's bin range */
  binArrayPubkeys: PublicKey[];
  /** Consecutive poll cycles where the position account was missing */
  missCount?: number;
}

/** How many consecutive misses before clearing the cache (handles RPC eventual consistency) */
const MAX_MISS_COUNT = 3;

/** Result of one fetch cycle */
export interface BatchedState {
  /** Pool's active bin ID at time of fetch — shared across all strategies */
  activeBinId: number;
  /**
   * Per-strategy position snapshots.
   * Keys are strategy IDs from config (e.g. "strategy-01").
   * A strategy returns found=false if its position account is not yet deployed.
   */
  positions: Map<string, PositionState>;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/**
 * Parallel to config.strategies — null when a position isn't deployed yet.
 * Populated by initAllPositionCaches(); refreshed if an account goes missing.
 */
let strategyCaches: (StrategyCache | null)[] = [];
let cacheInitialized = false;

// ---------------------------------------------------------------------------
// Boot-time initialization
// ---------------------------------------------------------------------------

/**
 * Discover and cache bin-array pubkeys for all strategies.
 *
 * Uses getPositionsByUserAndLbPair (the standard SDK path) to fetch all
 * positions for the owner, then matches them against the configured pubkeys
 * to get lowerBinId / upperBinId and compute bin-array pubkeys.
 *
 * This runs exactly once at startup. The hot path (fetchBatchedState) never
 * calls this — it uses the cached pubkeys in a single getMultipleAccountsInfo.
 */
export async function initAllPositionCaches(
  strategies: StrategyConfig[]
): Promise<void> {
  strategyCaches = new Array(strategies.length).fill(null);

  const ownerPubkeyStr = process.env.POSITION_OWNER_PUBKEY;
  if (!ownerPubkeyStr) {
    console.error(
      "[batchFetcher] POSITION_OWNER_PUBKEY not set in .env — cannot initialize caches."
    );
    cacheInitialized = true;
    return;
  }

  let userPositions;
  try {
    const result = await dlmmPool.getPositionsByUserAndLbPair(
      new PublicKey(ownerPubkeyStr)
    );
    userPositions = result.userPositions;
  } catch (err) {
    console.warn("[batchFetcher] Cache init failed:", err);
    cacheInitialized = true;
    return;
  }

  // Index returned positions by their pubkey string for O(1) lookup
  const positionMap = new Map(
    userPositions.map((p) => [p.publicKey.toBase58(), p.positionData])
  );

  let successCount = 0;
  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i];
    const pd = positionMap.get(strategy.positionPubkey);

    if (!pd) {
      console.warn(
        `[batchFetcher] ${strategy.id}: pubkey ${strategy.positionPubkey} ` +
          `not found among owner's positions — will retry each cycle.`
      );
      continue;
    }

    const binArrayPubkeys = getBinArrayKeysCoverage(
      new BN(pd.lowerBinId),
      new BN(pd.upperBinId),
      config.poolPubkey,
      dlmmPool.program.programId
    );

    strategyCaches[i] = {
      positionPubkey: new PublicKey(strategy.positionPubkey),
      binArrayPubkeys,
    };
    successCount++;
    console.log(
      `[batchFetcher] ${strategy.id}: cached ${binArrayPubkeys.length} bin-array(s) ` +
        `(bins ${pd.lowerBinId}–${pd.upperBinId})`
    );
  }

  console.log(
    `[batchFetcher] Cache ready: ${successCount}/${strategies.length} strategies initialized. ` +
      `Poll cycles will use 1 RPC call for all positions.`
  );
  cacheInitialized = true;
}

// ---------------------------------------------------------------------------
// Per-cycle batch fetch
// ---------------------------------------------------------------------------

/**
 * Fetch all on-chain state for all strategies in a single RPC call.
 *
 * Account list layout sent to getMultipleAccountsInfo:
 *   [0]   poolPubkey
 *   [1]   SYSVAR_CLOCK_PUBKEY
 *   [2…]  for each cached strategy (in config order):
 *             positionPubkey, ...binArrayPubkeys
 *
 * Strategies with a null cache (position not deployed) are skipped in the
 * account list and return found=false.
 *
 * Decoding:
 *   - Pool + clock are decoded once and shared across all strategies.
 *   - processPosition() is called in parallel (Promise.all) — it is a pure
 *     computation over already-decoded account data, not an RPC call.
 *
 * @returns BatchedState with activeBinId and a per-strategy PositionState map.
 */
export async function fetchBatchedState(
  strategies: StrategyConfig[]
): Promise<BatchedState> {
  // If the cache was never initialized (e.g. first cycle after a failed init),
  // try again now rather than returning all-empty forever.
  if (!cacheInitialized) {
    await initAllPositionCaches(strategies);
  }

  const emptyResult: BatchedState = {
    activeBinId: 0,
    positions: new Map(strategies.map((s) => [s.id, emptyPosition()])),
  };

  // -------------------------------------------------------------------------
  // Build the flat account list and record where each strategy's slice starts
  // -------------------------------------------------------------------------

  const accountList: PublicKey[] = [config.poolPubkey, SYSVAR_CLOCK_PUBKEY];

  // strategySliceStart[i] = index into accountList where strategy i's data begins.
  // -1 when the strategy has no cache (position not deployed).
  const strategySliceStart: number[] = [];

  for (let i = 0; i < strategies.length; i++) {
    let cache = strategyCaches[i];

    // If cache was cleared but the strategy has a valid pubkey (e.g. after a
    // rebalance + transient RPC miss), try to recover it automatically.
    if (!cache && strategies[i].positionPubkey) {
      try {
        const pubkey = new PublicKey(strategies[i].positionPubkey);
        const lbPosition = await dlmmPool.getPosition(pubkey);
        const { lowerBinId, upperBinId } = lbPosition.positionData;
        const binArrayPubkeys = getBinArrayKeysCoverage(
          new BN(lowerBinId),
          new BN(upperBinId),
          config.poolPubkey,
          dlmmPool.program.programId
        );
        cache = { positionPubkey: pubkey, binArrayPubkeys };
        strategyCaches[i] = cache;
        console.log(
          `[batchFetcher] ${strategies[i].id}: cache recovered → ${pubkey.toBase58().slice(0, 8)}… ` +
            `(bins ${lowerBinId}–${upperBinId})`
        );
      } catch {
        // Position doesn't exist on-chain yet — skip this cycle
      }
    }

    if (!cache) {
      strategySliceStart.push(-1);
      continue;
    }
    strategySliceStart.push(accountList.length);
    accountList.push(cache.positionPubkey, ...cache.binArrayPubkeys);
  }

  // -------------------------------------------------------------------------
  // Single RPC call
  // -------------------------------------------------------------------------

  let accountInfos;
  try {
    accountInfos = await connection.getMultipleAccountsInfo(accountList);
  } catch (err) {
    console.error("[batchFetcher] Batch RPC call failed:", err);
    return emptyResult;
  }

  // -------------------------------------------------------------------------
  // Decode shared accounts: pool and clock
  // -------------------------------------------------------------------------

  const lbPairAccInfo = accountInfos[0];
  const clockAccInfo = accountInfos[1];

  if (!lbPairAccInfo || !clockAccInfo) {
    console.error("[batchFetcher] Pool or clock account missing in batch response.");
    return emptyResult;
  }

  let freshLbPair: LbPair;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let clock: any;
  try {
    freshLbPair = decodeAccount<LbPair>(
      dlmmPool.program,
      "lbPair",
      lbPairAccInfo.data
    );
    clock = ClockLayout.decode(clockAccInfo.data);
  } catch (err) {
    console.error("[batchFetcher] Failed to decode pool/clock accounts:", err);
    return emptyResult;
  }

  const activeBinId: number = freshLbPair.activeId;

  // -------------------------------------------------------------------------
  // Decode per-strategy accounts and run processPosition in parallel
  // -------------------------------------------------------------------------

  const positionEntries = await Promise.all(
    strategies.map(async (strategy, i): Promise<[string, PositionState]> => {
      const cache = strategyCaches[i];
      const sliceStart = strategySliceStart[i];

      if (!cache || sliceStart < 0) {
        return [strategy.id, emptyPosition(activeBinId)];
      }

      const positionAccInfo = accountInfos[sliceStart];
      const binArrayAccInfos = accountInfos.slice(
        sliceStart + 1,
        sliceStart + 1 + cache.binArrayPubkeys.length
      );

      // Position account missing — could be RPC eventual consistency (just deployed)
      // or truly closed. Only clear the cache after several consecutive misses.
      if (!positionAccInfo) {
        const misses = (cache.missCount ?? 0) + 1;
        if (misses >= MAX_MISS_COUNT) {
          console.warn(
            `[batchFetcher] ${strategy.id}: position missing for ${misses} cycles — clearing cache.`
          );
          strategyCaches[i] = null;
        } else {
          cache.missCount = misses;
          console.warn(
            `[batchFetcher] ${strategy.id}: position missing (${misses}/${MAX_MISS_COUNT}) — retrying next cycle.`
          );
        }
        return [strategy.id, emptyPosition(activeBinId)];
      }

      // Account found — reset miss counter
      cache.missCount = 0;

      try {
        const wrappedPosition = wrapPosition(
          dlmmPool.program,
          cache.positionPubkey,
          positionAccInfo
        );

        const binArraysMap = new Map<string, BinArray>();
        for (let j = 0; j < cache.binArrayPubkeys.length; j++) {
          const accInfo = binArrayAccInfos[j];
          if (accInfo) {
            binArraysMap.set(
              cache.binArrayPubkeys[j].toBase58(),
              decodeAccount<BinArray>(dlmmPool.program, "binArray", accInfo.data)
            );
          }
        }

        // processPosition: SDK static method that computes fee/reward math
        // from already-decoded account data. Awaitable but does NOT make RPC calls.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pd = await (DLMM as any).processPosition(
          dlmmPool.program,
          freshLbPair,
          clock,
          wrappedPosition,
          dlmmPool.tokenX.mint,
          dlmmPool.tokenY.mint,
          dlmmPool.rewards[0]?.mint ?? null,
          dlmmPool.rewards[1]?.mint ?? null,
          binArraysMap
        );

        if (!pd) {
          return [strategy.id, emptyPosition(activeBinId)];
        }

        return [strategy.id, buildPositionState(activeBinId, pd)];
      } catch (err) {
        console.error(`[batchFetcher] ${strategy.id}: decode error:`, err);
        return [strategy.id, emptyPosition(activeBinId)];
      }
    })
  );

  return {
    activeBinId,
    positions: new Map(positionEntries),
  };
}

// ---------------------------------------------------------------------------
// Post-rebalance cache refresh (called by ExecutionRunner after deploy)
// ---------------------------------------------------------------------------

/**
 * Update the batch-fetcher cache for one strategy after a successful rebalance.
 *
 * The new position account was just deployed on-chain. This function:
 *   1. Fetches the new position to determine its bin range
 *   2. Recomputes the bin-array pubkeys for that range
 *   3. Replaces strategyCaches[strategyIndex] so the NEXT fetchBatchedState()
 *      call automatically monitors the new position
 *
 * Must be awaited before the next poll cycle begins (otherwise the stale cache
 * would attempt to fetch the now-closed old position account).
 */
export async function reinitializeStrategyCache(
  strategyIndex: number,
  newPubkey: PublicKey
): Promise<void> {
  const lbPosition = await dlmmPool.getPosition(newPubkey);
  const { lowerBinId, upperBinId } = lbPosition.positionData;

  const binArrayPubkeys = getBinArrayKeysCoverage(
    new BN(lowerBinId),
    new BN(upperBinId),
    config.poolPubkey,
    dlmmPool.program.programId
  );

  strategyCaches[strategyIndex] = {
    positionPubkey: newPubkey,
    binArrayPubkeys,
  };

  console.log(
    `[batchFetcher] Strategy[${strategyIndex}] cache updated → ` +
      `${newPubkey.toBase58().slice(0, 8)}… (bins ${lowerBinId}–${upperBinId}, ` +
      `${binArrayPubkeys.length} bin-array(s))`
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyPosition(activeBinId = 0): PositionState {
  return {
    found: false,
    activeBinId,
    bins: [],
    totalSolAmount: 0,
    totalUsdcAmount: 0,
    feeX: 0,
    feeY: 0,
    lastUpdated: Date.now(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildPositionState(activeBinId: number, pd: any): PositionState {
  const bins: BinEntry[] = pd.positionBinData.map((binData: any) => ({
    binId: binData.binId,
    liquidity: binData.positionXAmount,
    solAmount:
      parseFloat(binData.positionXAmount) / Math.pow(10, SOL_DECIMALS),
    usdcAmount:
      parseFloat(binData.positionYAmount) / Math.pow(10, USDC_DECIMALS),
  }));

  const totalSolAmount =
    parseFloat(pd.totalXAmount) / Math.pow(10, SOL_DECIMALS);
  const totalUsdcAmount =
    parseFloat(pd.totalYAmount) / Math.pow(10, USDC_DECIMALS);

  // SDK issue #245: feeX / feeY can be undefined on some versions. Default to 0.
  const rawFeeX = pd.feeX ?? null;
  const rawFeeY = pd.feeY ?? null;
  const feeX = rawFeeX
    ? rawFeeX.toNumber() / Math.pow(10, SOL_DECIMALS)
    : 0;
  const feeY = rawFeeY
    ? rawFeeY.toNumber() / Math.pow(10, USDC_DECIMALS)
    : 0;

  return {
    found: true,
    activeBinId,
    bins,
    totalSolAmount,
    totalUsdcAmount,
    feeX,
    feeY,
    lastUpdated: Date.now(),
  };
}
