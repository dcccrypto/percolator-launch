/**
 * Oracle Price Pusher Service
 *
 * Watches all registered markets and pushes prices from Jupiter API.
 * Run: npx tsx src/index.ts
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import {
  encodePushOraclePrice,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  buildAccountMetas,
  buildIx,
  getProgramId,
} from "@percolator/core";
import * as dotenv from "dotenv";

dotenv.config();

const PROGRAM_ID = getProgramId();
const PUSH_INTERVAL_MS = 10_000;

interface MarketEntry {
  slab: string;
  mint: string;
}

async function fetchPrice(mint: string): Promise<number | null> {
  try {
    const resp = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`);
    const data = await resp.json();
    return data.data?.[mint]?.price ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL not set");

  const keypairPath = process.env.ADMIN_KEYPAIR_PATH;
  if (!keypairPath) throw new Error("ADMIN_KEYPAIR_PATH not set");

  // Load markets from MARKETS env (JSON array)
  const markets: MarketEntry[] = JSON.parse(process.env.MARKETS || "[]");
  if (markets.length === 0) {
    console.log("No markets configured. Set MARKETS env var.");
    return;
  }

  const connection = new Connection(rpcUrl, "confirmed");
  const fs = await import("fs");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")))
  );

  console.log(`Oracle service started. Watching ${markets.length} markets.`);

  async function pushPrices() {
    for (const market of markets) {
      const price = await fetchPrice(market.mint);
      if (!price) {
        console.log(`  [${market.slab.slice(0, 8)}] No price available`);
        continue;
      }

      const priceE6 = Math.round(price * 1_000_000).toString();
      const now = Math.floor(Date.now() / 1000);

      try {
        const slabPk = new PublicKey(market.slab);
        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
        tx.add(buildIx({
          programId: PROGRAM_ID,
          keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slabPk]),
          data: encodePushOraclePrice({ priceE6, timestamp: now.toString() }),
        }));

        const sig = await connection.sendTransaction(tx, [payer], { skipPreflight: true });
        console.log(`  [${market.slab.slice(0, 8)}] Price: $${price} → ${sig.slice(0, 16)}...`);
      } catch (e) {
        console.error(`  [${market.slab.slice(0, 8)}] Error:`, e);
      }
    }
  }

  // Run loop
  while (true) {
    await pushPrices();
    await new Promise((r) => setTimeout(r, PUSH_INTERVAL_MS));
  }
}

main().catch(console.error);
