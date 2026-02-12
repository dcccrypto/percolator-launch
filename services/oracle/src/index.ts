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
const MAX_BACKOFF_MS = 60_000; // 60 seconds max backoff

// Graceful shutdown flag
let running = true;
let backoffMs = PUSH_INTERVAL_MS;
let consecutiveFailures = 0;
const MAX_FAILURES = 20; // Exit after 20 consecutive failures

// Signal handlers for graceful shutdown
process.on("SIGINT", () => {
  console.log("\nReceived SIGINT, shutting down gracefully...");
  running = false;
});

process.on("SIGTERM", () => {
  console.log("\nReceived SIGTERM, shutting down gracefully...");
  running = false;
});

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

        // Remove skipPreflight to catch errors before on-chain submission
        const sig = await connection.sendTransaction(tx, [payer]);
        console.log(`  [${market.slab.slice(0, 8)}] Price: $${price} → ${sig.slice(0, 16)}...`);
      } catch (e) {
        console.error(`  [${market.slab.slice(0, 8)}] Error:`, e);
      }
    }
  }

  // Run loop with graceful shutdown and exponential backoff
  while (running) {
    try {
      await pushPrices();
      
      // Reset backoff and failure counter on success
      backoffMs = PUSH_INTERVAL_MS;
      consecutiveFailures = 0;
      
      await new Promise((r) => setTimeout(r, backoffMs));
    } catch (e) {
      console.error("Error in push cycle:", e);
      
      // Increment failure counter
      consecutiveFailures++;
      
      // Circuit breaker: exit after too many failures
      if (consecutiveFailures >= MAX_FAILURES) {
        console.error(\`Too many consecutive failures (\${MAX_FAILURES}), exiting...\`);
        process.exit(1);
      }
      
      // Exponential backoff
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      console.log(\`Retrying in \${backoffMs}ms... (failures: \${consecutiveFailures})\`);
      
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  console.log("Oracle service stopped gracefully");
  process.exit(0);
}

main().catch(console.error);
