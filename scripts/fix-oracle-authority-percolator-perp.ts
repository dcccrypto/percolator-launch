/**
 * Fix oracle_authority mismatch for PERCOLATOR-PERP slabs
 *
 * DevOps reported: oracle-keeper failing with 'Provided owner is not allowed'
 * every 3-4 seconds on PERCOLATOR-PERP (dynamic). BTC-PERP-1/2 healthy.
 *
 * Slabs (3 total — 2 Small, 1 Large):
 *   HjBePQZnoZVftg9B52gyeuHGjBvt2f8FNCVP4FeoP3YT  → Small  (FwfBKZX...)
 *   484DG6KQi5eVXuaXzWxaWMWeXDp9LFXyshNi33UnWfxV  → Small  (FwfBKZX...)
 *   GDyHCzpiuEsWDkLuji3NEFYJfqbDTzMCKn9ugUzTZqAW  → Large  (FxfD37s...)
 *
 * Admin: percolator-upgrade-authority.json (FF7KFfU5...)
 * Sets oracle_authority = admin pubkey so the keeper can push prices.
 *
 * Usage:
 *   npx tsx scripts/fix-oracle-authority-percolator-perp.ts [--dry-run]
 *   ADMIN_KEYPAIR_PATH=/path/to/key.json npx tsx scripts/fix-oracle-authority-percolator-perp.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import fs from "fs";
import path from "path";
import {
  encodeSetOracleAuthority,
  buildAccountMetas,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  buildIx,
} from "../packages/core/src/index.js";

const SMALL_PROGRAM = new PublicKey("FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn");
const LARGE_PROGRAM = new PublicKey("FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD");
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";

// V0 layout: HEADER_LEN=72, oracle_authority at offset 72+32=104
const HEADER_LEN = 72;
const ORACLE_AUTH_OFFSET = HEADER_LEN + 32; // 104

const SLABS: { name: string; address: string; program: PublicKey }[] = [
  {
    name: "PERCOLATOR-PERP-1",
    address: "HjBePQZnoZVftg9B52gyeuHGjBvt2f8FNCVP4FeoP3YT",
    program: SMALL_PROGRAM,
  },
  {
    name: "PERCOLATOR-PERP-2",
    address: "484DG6KQi5eVXuaXzWxaWMWeXDp9LFXyshNi33UnWfxV",
    program: SMALL_PROGRAM,
  },
  {
    name: "PERCOLATOR-PERP-3",
    address: "GDyHCzpiuEsWDkLuji3NEFYJfqbDTzMCKn9ugUzTZqAW",
    program: LARGE_PROGRAM,
  },
];

async function main() {
  const adminPath =
    process.env.ADMIN_KEYPAIR_PATH ??
    path.join(process.env.HOME!, ".config/solana/percolator-upgrade-authority.json");

  const adminKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(adminPath, "utf8")))
  );

  const conn = new Connection(RPC_URL, "confirmed");
  const dryRun = process.argv.includes("--dry-run");

  console.log("=".repeat(60));
  console.log("Fix oracle_authority — PERCOLATOR-PERP (all 3 slabs)");
  console.log("=".repeat(60));
  console.log("Admin:             ", adminKp.publicKey.toBase58());
  console.log("New oracle_auth:   ", adminKp.publicKey.toBase58());
  console.log("Dry run:           ", dryRun);
  console.log();

  let successCount = 0;
  let failCount = 0;

  for (const slab of SLABS) {
    const slabPubkey = new PublicKey(slab.address);
    console.log(`--- ${slab.name} (${slab.address}) ---`);
    console.log(`    Program: ${slab.program.toBase58()}`);

    const accountInfo = await conn.getAccountInfo(slabPubkey);
    if (!accountInfo) {
      console.log("  ❌ Slab not found on-chain — skipping");
      failCount++;
      console.log();
      continue;
    }

    console.log(`  Size: ${accountInfo.data.length} bytes`);
    console.log(`  On-chain owner: ${accountInfo.owner.toBase58()}`);

    // Read current oracle_authority from raw slab data
    if (accountInfo.data.length > ORACLE_AUTH_OFFSET + 32) {
      const currentOracleAuth = new PublicKey(
        accountInfo.data.slice(ORACLE_AUTH_OFFSET, ORACLE_AUTH_OFFSET + 32)
      );
      console.log(`  Current oracle_authority: ${currentOracleAuth.toBase58()}`);
      if (currentOracleAuth.equals(adminKp.publicKey)) {
        console.log("  ✅ oracle_authority already correct — skipping");
        successCount++;
        console.log();
        continue;
      }
    }

    if (dryRun) {
      console.log(
        `  🔍 DRY RUN — would call SetOracleAuthority(newAuthority=${adminKp.publicKey.toBase58()})`
      );
      console.log();
      continue;
    }

    const data = encodeSetOracleAuthority({ newAuthority: adminKp.publicKey });
    const keys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
      adminKp.publicKey,
      slabPubkey,
    ]);

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      buildIx({ programId: slab.program, keys, data })
    );

    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [adminKp], {
        commitment: "confirmed",
      });
      console.log("  ✅ SetOracleAuthority success:", sig);
      console.log(
        "  Explorer: https://explorer.solana.com/tx/" + sig + "?cluster=devnet"
      );
      successCount++;
    } catch (err) {
      const e = err as Error & { logs?: string[] };
      console.log("  ❌ SetOracleAuthority failed:", e.message);
      if (e.logs) {
        console.log("  Program logs:", e.logs.slice(-8).join("\n    "));
      }
      failCount++;
    }
    console.log();
  }

  console.log("=".repeat(60));
  console.log(`Done. ${successCount} fixed, ${failCount} failed.`);
  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
