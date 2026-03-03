/**
 * PERC-387: Fix oracle_authority mismatch on BTC-PERP-1 and BTC-PERP-2
 *
 * Both slabs had oracle_authority=11obSVaVR4k4... but the oracle-keeper
 * wallet is FF7KFfU5Bb3... — this script calls SetOracleAuthority to fix.
 *
 * Admin keypair: ~/.config/solana/percolator-upgrade-authority.json (FF7KFfU5...)
 * Program: FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn (Small)
 *
 * Usage:
 *   npx tsx scripts/fix-oracle-authority.ts [--dry-run]
 *   ADMIN_KEYPAIR_PATH=/path/to/key.json npx tsx scripts/fix-oracle-authority.ts
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
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";

// Markets whose oracle_authority was wrong (11obSVaVR4k4... instead of FF7KFfU5...)
const SLABS = [
  { name: "BTC-PERP-1", address: "7eubYRwJiQdJgXsw1VdaNQ7YHvHbgChe7wbPNQw74S23" },
  { name: "BTC-PERP-2", address: "CkcwQtUuPe1MjeVhyMR2zZcLsKEzP2cqGzspwmgTuZRp" },
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
  console.log("PERC-387: Fix oracle_authority mismatch");
  console.log("=".repeat(60));
  console.log("Admin:             ", adminKp.publicKey.toBase58());
  console.log("New oracle_authority:", adminKp.publicKey.toBase58());
  console.log("Program:           ", SMALL_PROGRAM.toBase58());
  console.log("Dry run:           ", dryRun);
  console.log();

  for (const slab of SLABS) {
    const slabPubkey = new PublicKey(slab.address);
    console.log(`--- ${slab.name} (${slab.address}) ---`);

    const accountInfo = await conn.getAccountInfo(slabPubkey);
    if (!accountInfo) {
      console.log("  ❌ Slab not found on-chain, skipping");
      continue;
    }
    console.log("  Size:", accountInfo.data.length, "bytes");

    if (dryRun) {
      console.log(
        "  🔍 DRY RUN — would call SetOracleAuthority with newAuthority =",
        adminKp.publicKey.toBase58()
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
      buildIx({ programId: SMALL_PROGRAM, keys, data })
    );

    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [adminKp], {
        commitment: "confirmed",
      });
      console.log("  ✅ SetOracleAuthority success:", sig);
      console.log(
        "  Explorer: https://explorer.solana.com/tx/" + sig + "?cluster=devnet"
      );
    } catch (err) {
      const e = err as Error & { logs?: string[] };
      console.log("  ❌ SetOracleAuthority failed:", e.message);
      if (e.logs) {
        console.log("  Logs:", e.logs.slice(-5).join("\n    "));
      }
    }
    console.log();
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
