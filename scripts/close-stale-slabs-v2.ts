#!/usr/bin/env npx tsx
/**
 * PERC-381 (v2): Close stale slab accounts using the new CloseStaleSlabs instruction (tag 51).
 *
 * Unlike close-stale-slabs.ts (which used CloseSlab/tag 13 and hit 0x4 / InvalidSlabLen),
 * this script uses TAG_CLOSE_STALE_SLAB = 51 which skips slab_guard and works on
 * slabs with any invalid size — as long as the header magic matches and the signer
 * is the admin stored in the header.
 *
 * Root cause of 0x4 failures: slab_guard rejected wrong-size slabs BEFORE the admin
 * check — 0x4 = InvalidSlabLen (4th PercolatorError), not an admin mismatch.
 *
 * Usage:
 *   npx tsx scripts/close-stale-slabs-v2.ts [--dry-run] [--program <PUBKEY>]
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
  TransactionInstruction,
} from "@solana/web3.js";
import * as fs from "fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    program: { type: "string" },
  },
  strict: true,
});

const DRY_RUN = args["dry-run"] ?? false;
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";

// All program IDs to scan (Small / Medium / Large)
const DEFAULT_PROGRAMS = [
  "FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn",  // Small  — valid size 65352
  "g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in",   // Medium — valid size 257448
  "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",  // Large  — valid size 1025832
];

// Valid sizes per program (SLAB_LEN, SLAB_LEN-16, SLAB_LEN-24)
const VALID_SIZES_PER_PROGRAM: Record<string, number[]> = {
  "FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn": [65352, 65336, 65328],   // Small
  "g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in":  [257448, 257432, 257424], // Medium
  "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD": [1025832, 1025816, 1025808], // Large
};

// TAG_CLOSE_STALE_SLAB = 51
const TAG_CLOSE_STALE_SLAB = 51;

// MAGIC = "PERCOLAT" as u64 LE
const MAGIC = Buffer.from([0x54, 0x41, 0x4c, 0x4f, 0x43, 0x52, 0x45, 0x50]);

function loadKeypair(path: string): Keypair {
  const resolved = path.startsWith("~")
    ? path.replace("~", process.env.HOME ?? "")
    : path;
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(resolved, "utf8")))
  );
}

function buildCloseStaleSlabIx(
  programId: PublicKey,
  dest: PublicKey,
  slab: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(TAG_CLOSE_STALE_SLAB, 0);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: dest, isSigner: true, isWritable: true },
      { pubkey: slab, isSigner: false, isWritable: true },
    ],
    data,
  });
}

async function main() {
  console.log("=".repeat(60));
  console.log("PERC-381 v2: Stale Slab Cleanup (TAG_CLOSE_STALE_SLAB=51)");
  console.log("=".repeat(60));

  const conn = new Connection(RPC_URL, "confirmed");
  const adminPath =
    process.env.ADMIN_KEYPAIR_PATH ??
    `${process.env.HOME}/.config/solana/percolator-upgrade-authority.json`;

  let admin: Keypair;
  try {
    admin = loadKeypair(adminPath);
  } catch {
    console.error(`❌ Cannot load admin keypair from ${adminPath}`);
    process.exit(1);
  }

  console.log(`Admin: ${admin.publicKey.toBase58()}`);
  console.log(`RPC:   ${RPC_URL.replace(/api[_-]?key=[^&]+/gi, "api-key=***")}`);
  console.log(`Dry Run: ${DRY_RUN}`);
  console.log();

  const programIds = args.program ? [args.program] : DEFAULT_PROGRAMS;

  let totalStale = 0;
  let totalClosed = 0;
  let totalReclaimed = 0;

  for (const pid of programIds) {
    const programId = new PublicKey(pid);
    const validSizes = new Set(VALID_SIZES_PER_PROGRAM[pid] ?? []);
    console.log(`\n--- Scanning ${pid.slice(0, 12)}... (valid: ${[...validSizes].join(", ")}) ---`);

    let accounts;
    try {
      accounts = await conn.getProgramAccounts(programId, {
        dataSlice: { offset: 0, length: 0 }, // just addresses
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
      if (validSizes.has(size)) continue; // Valid size — skip

      totalStale++;
      const addr = acct.pubkey.toBase58();
      const rentSol = info.lamports / 1e9;

      // Inspect header
      const hasMagic = info.data.length >= 8 && info.data.subarray(0, 8).equals(MAGIC);
      let adminInSlab = "N/A";
      if (info.data.length >= 48) {
        adminInSlab = new PublicKey(info.data.subarray(16, 48)).toBase58();
      }
      const adminMatches = adminInSlab === admin.publicKey.toBase58();

      console.log(`\n  🔴 STALE: ${addr}`);
      console.log(`     Size:   ${size} bytes (invalid for this program)`);
      console.log(`     Rent:   ${rentSol.toFixed(4)} SOL`);
      console.log(`     Magic:  ${hasMagic ? "✓ valid" : "✗ missing/corrupt"}`);
      console.log(`     Admin:  ${adminInSlab}`);
      console.log(`     Match:  ${adminMatches ? "✓ admin matches" : "✗ admin MISMATCH — will fail"}`);

      if (DRY_RUN) {
        console.log("     → Would call CloseStaleSlabs (dry-run)");
        continue;
      }

      if (!hasMagic) {
        console.log("     ⚠️  Skipping: no valid magic bytes — program will reject");
        continue;
      }
      if (!adminMatches) {
        console.log("     ⚠️  Skipping: admin mismatch — provide correct keypair via ADMIN_KEYPAIR_PATH");
        continue;
      }

      try {
        const closeIx = buildCloseStaleSlabIx(
          programId,
          admin.publicKey,
          acct.pubkey,
        );

        const tx = new Transaction();
        tx.add(
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
          closeIx,
        );

        const sig = await sendAndConfirmTransaction(conn, tx, [admin], {
          commitment: "confirmed",
        });
        console.log(`     ✅ Closed. TX: ${sig}`);
        totalClosed++;
        totalReclaimed += rentSol;
      } catch (e: any) {
        console.error(`     ❌ Close failed: ${e.message}`);
        const logs: string[] = e?.logs ?? [];
        if (logs.length) {
          console.error("        Logs:", logs.slice(-5).join("\n              "));
        }
      }

      // Rate limit
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Stale slabs found:    ${totalStale}`);
  if (!DRY_RUN) {
    console.log(`Successfully closed:  ${totalClosed}`);
    console.log(`SOL reclaimed:        ${totalReclaimed.toFixed(4)}`);
    if (totalStale > totalClosed) {
      console.log(`Skipped/failed:       ${totalStale - totalClosed}`);
    }
  }
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
