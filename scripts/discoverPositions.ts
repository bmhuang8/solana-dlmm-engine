/**
 * scripts/discoverPositions.ts
 *
 * One-shot helper: connects to the DLMM pool and prints every position
 * account owned by POSITION_OWNER_PUBKEY, along with the values you
 * need to paste into your .env file.
 *
 * Usage:
 *   npx ts-node scripts/discoverPositions.ts
 *
 * Output example:
 *   Position #1
 *     Pubkey (→ POSITION_PUBKEY_01): 7xK...abc
 *     Bin range: 5820 – 5860
 *     SOL:  0.603100
 *     USDC: 52.3921
 */

import dotenv from "dotenv";
import { Connection, PublicKey } from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";

dotenv.config();

const POOL_PUBKEY = "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y";
const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

async function main(): Promise<void> {
  const rpcUrl = requireEnv("RPC_URL");
  const ownerPubkey = new PublicKey(requireEnv("POSITION_OWNER_PUBKEY"));

  console.log("=".repeat(60));
  console.log("  Meteora Sentinel — Position Discovery");
  console.log("=".repeat(60));
  console.log(`RPC:   ${rpcUrl}`);
  console.log(`Owner: ${ownerPubkey.toBase58()}`);
  console.log(`Pool:  ${POOL_PUBKEY}`);
  console.log("");

  const connection = new Connection(rpcUrl, "confirmed");
  const poolKey = new PublicKey(POOL_PUBKEY);
  const dlmmPool = await DLMM.create(connection, poolKey);

  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(ownerPubkey);

  if (userPositions.length === 0) {
    console.log("No positions found for this owner in this pool.");
    console.log(
      "Make sure you have deposited into the SOL/USDC Bin-Step-10 pool first."
    );
    return;
  }

  console.log(`Found ${userPositions.length} position(s):\n`);

  for (let i = 0; i < userPositions.length; i++) {
    const pos = userPositions[i];
    const pd = pos.positionData;

    const totalSol =
      parseFloat(pd.totalXAmount) / Math.pow(10, SOL_DECIMALS);
    const totalUsdc =
      parseFloat(pd.totalYAmount) / Math.pow(10, USDC_DECIMALS);

    const envKey = `POSITION_PUBKEY_0${i + 1}`;

    console.log(`Position #${i + 1}`);
    console.log(`  Pubkey (→ ${envKey}): ${pos.publicKey.toBase58()}`);
    console.log(`  Bin range: ${pd.lowerBinId} – ${pd.upperBinId}`);
    console.log(`  SOL:       ${totalSol.toFixed(6)}`);
    console.log(`  USDC:      ${totalUsdc.toFixed(4)}`);
    console.log("");
  }

  console.log("=".repeat(60));
  console.log("Paste the pubkey(s) above into your .env file:");
  console.log("");
  for (let i = 0; i < userPositions.length; i++) {
    console.log(
      `POSITION_PUBKEY_0${i + 1}=${userPositions[i].publicKey.toBase58()}`
    );
  }
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
