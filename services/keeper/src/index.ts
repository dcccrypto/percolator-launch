/**
 * Multi-Market Keeper / Crank Bot
 *
 * Cranks all registered markets every 5 seconds.
 * Run: npx tsx src/index.ts
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import {
  encodeKeeperCrank,
  ACCOUNTS_KEEPER_CRANK,
  buildAccountMetas,
  buildIx,
} from "@percolator/core";
import * as dotenv from "dotenv";

dotenv.config();

const PROGRAM_ID = new PublicKey("GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24");
const CRANK_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 60_000; // 60 seconds max backoff

// Graceful shutdown flag
let running = true;
let backoffMs = CRANK_INTERVAL_MS;
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

async function main() {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL not set");

  const keypairPath = process.env.ADMIN_KEYPAIR_PATH;
  if (!keypairPath) throw new Error("ADMIN_KEYPAIR_PATH not set");

  const slabs: string[] = JSON.parse(process.env.SLABS || "[]");
  if (slabs.length === 0) {
    console.log("No slabs configured. Set SLABS env var (JSON array of addresses).");
    return;
  }

  const connection = new Connection(rpcUrl, "confirmed");
  const fs = await import("fs");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")))
  );

  console.log(`Keeper started. Cranking ${slabs.length} markets every ${CRANK_INTERVAL_MS / 1000}s.`);

  while (true) {
    for (const slab of slabs) {
      try {
        const slabPk = new PublicKey(slab);
        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }));
        tx.add(buildIx({
          programId: PROGRAM_ID,
          keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, slabPk, SYSVAR_CLOCK_PUBKEY, slabPk]),
          data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: false }),
        }));

        // Remove skipPreflight to catch errors before on-chain submission
        const sig = await connection.sendTransaction(tx, [payer]);
        console.log(`  [${slab.slice(0, 8)}] Cranked → ${sig.slice(0, 16)}...`);
      } catch (e) {
        console.error(`  [${slab.slice(0, 8)}] Crank error:`, e);
      }
    }
    await new Promise((r) => setTimeout(r, CRANK_INTERVAL_MS));
  }
}

main().catch(console.error);
