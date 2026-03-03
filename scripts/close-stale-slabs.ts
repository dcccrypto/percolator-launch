#!/usr/bin/env npx tsx
/**
 * PERC-381: Close stale slab accounts that have wrong sizes.
 *
 * On devnet, old slab accounts persist from previous program deploys with
 * outdated layout sizes. The keeper discovers them via getProgramAccounts
 * but can't crank them (0x4 NotInitialized). This script identifies and
 * closes them to reclaim rent and clean up the on-chain program space.
 *
 * Usage:
 *   npx tsx scripts/close-stale-slabs.ts [--dry-run] [--program <PUBKEY>]
 *
 * Prerequisites:
 *   - Admin keypair at ADMIN_KEYPAIR_PATH or ~/.config/solana/percolator-upgrade-authority.json
 *   - RPC_URL env var or defaults to devnet
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import * as fs from "fs";
import { parseArgs } from "node:util";

import {
  encodeCloseSlab,
  buildAccountMetas,
  ACCOUNTS_CLOSE_SLAB,
  buildIx,
  SLAB_TIERS,
  parseHeader,
} from "../packages/core/src/index.js";

const { values: args } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    program: { type: "string" },
  },
  strict: true,
});

const DRY_RUN = args["dry-run"] ?? false;
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";

// All program IDs to scan
const DEFAULT_PROGRAMS = [
  "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",  // Large
  "FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn",  // Small
  "g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in",   // Medium
];

const VALID_SIZES = new Set(Object.values(SLAB_TIERS).map(t => t.dataSize));
const MAGIC_BYTES = Buffer.from("TALOCREP");  // PERCOLAT reversed (little-endian)

function loadKeypair(path: string): Keypair {
  const resolved = path.startsWith("~")
    ? path.replace("~", process.env.HOME || "")
    : path;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(resolved, "utf8"))));
}

async function main() {
  console.log("=".repeat(60));
  console.log("PERC-381: Stale Slab Cleanup");
  console.log("=".repeat(60));

  const conn = new Connection(RPC_URL, "confirmed");
  const adminPath = process.env.ADMIN_KEYPAIR_PATH
    ?? `${process.env.HOME}/.config/solana/percolator-upgrade-authority.json`;

  let admin: Keypair;
  try {
    admin = loadKeypair(adminPath);
  } catch {
    console.error(`❌ Cannot load admin keypair from ${adminPath}`);
    process.exit(1);
  }

  console.log(`Admin: ${admin.publicKey.toBase58()}`);
  console.log(`RPC: ${RPC_URL.replace(/api[_-]?key=[^&]+/gi, "api-key=***")}`);
  console.log(`Dry Run: ${DRY_RUN}`);
  console.log(`Valid sizes: ${[...VALID_SIZES].join(", ")}`);

  const programIds = args.program ? [args.program] : DEFAULT_PROGRAMS;

  let totalStale = 0;
  let totalClosed = 0;
  let totalReclaimed = 0;

  for (const pid of programIds) {
    const programId = new PublicKey(pid);
    console.log(`\n--- Scanning ${pid.slice(0, 12)}... ---`);

    let accounts;
    try {
      accounts = await conn.getProgramAccounts(programId, {
        dataSlice: { offset: 0, length: 8 },  // Just the magic bytes
      });
    } catch (e: any) {
      console.error(`  ⚠️  Failed to scan: ${e.message}`);
      continue;
    }

    console.log(`  Found ${accounts.length} total accounts`);

    for (const acct of accounts) {
      const info = await conn.getAccountInfo(acct.pubkey);
      if (!info) continue;

      const size = info.data.length;
      if (VALID_SIZES.has(size)) continue;  // Correct size, skip

      totalStale++;
      const addr = acct.pubkey.toBase58();
      const rent = info.lamports / 1e9;

      // Check if it has valid magic bytes
      const hasMagic = info.data.subarray(0, 8).equals(MAGIC_BYTES);

      console.log(`\n  🔴 STALE: ${addr}`);
      console.log(`     Size: ${size} (no matching tier)`);
      console.log(`     Rent: ${rent.toFixed(4)} SOL`);
      console.log(`     Magic: ${hasMagic ? "✓ valid" : "✗ missing/corrupt"}`);

      if (DRY_RUN) {
        console.log("     → Would close (dry-run)");
        continue;
      }

      // Attempt CloseSlab
      try {
        const closeData = encodeCloseSlab();
        const closeKeys = buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [
          admin.publicKey,
          acct.pubkey,
        ]);

        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
        tx.add(buildIx({ programId, keys: closeKeys, data: closeData }));

        const sig = await sendAndConfirmTransaction(conn, tx, [admin], {
          commitment: "confirmed",
        });
        console.log(`     ✅ Closed. TX: ${sig}`);
        totalClosed++;
        totalReclaimed += rent;
      } catch (e: any) {
        console.error(`     ❌ Close failed: ${e.message}`);
        console.error("        (May not be admin for this slab, or slab not initialized)");
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Stale slabs found: ${totalStale}`);
  if (!DRY_RUN) {
    console.log(`Closed: ${totalClosed}`);
    console.log(`Reclaimed: ${totalReclaimed.toFixed(4)} SOL`);
  }
  console.log("=".repeat(60));
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
