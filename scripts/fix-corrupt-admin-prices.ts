#!/usr/bin/env npx tsx
/**
 * fix-corrupt-admin-prices.ts
 *
 * One-off fix for two TEST/garbage admin-mode slabs with corrupt on-chain
 * authorityPriceE6 values ($11M / $92M), blocking the oracle-keeper crank.
 *
 * Action: calls PushOraclePrice with a nominal $100 price to clear corruption.
 *
 * Slabs:
 *   GYpukkn94KKDU9ufNURjDZVMGPp3LTadZrdoPtE2cdc1  (symbol: TEST)
 *   2Zta2EPRR444Hp2WbH2L9vfM38Stwr9chDpNk66eevzU  (symbol: 47RNQiHt)
 *
 * Both owned by FxfD37s1... (large devnet program), 62808 bytes (V0 layout).
 *
 * Usage:
 *   npx tsx scripts/fix-corrupt-admin-prices.ts [--dry-run]
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
import {
  encodePushOraclePrice,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  buildAccountMetas,
  buildIx,
} from "../packages/core/src/index.js";

const PROGRAM_ID = new PublicKey("FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD");
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const ADMIN_KP_PATH =
  process.env.ADMIN_KEYPAIR_PATH ??
  `${process.env.HOME}/.config/solana/percolator-upgrade-authority.json`;

// Nominal fix price: $100.00 in e6 format
const FIX_PRICE_E6 = 100_000_000n;

const CORRUPT_SLABS = [
  {
    name: "TEST",
    address: "GYpukkn94KKDU9ufNURjDZVMGPp3LTadZrdoPtE2cdc1",
    corruptPriceUsd: "$11.1M",
  },
  {
    name: "47RNQiHt",
    address: "2Zta2EPRR444Hp2WbH2L9vfM38Stwr9chDpNk66eevzU",
    corruptPriceUsd: "$92.1M",
  },
];

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  console.log("=".repeat(60));
  console.log("fix-corrupt-admin-prices: PushOraclePrice fix");
  console.log("=".repeat(60));
  console.log("Program:  ", PROGRAM_ID.toBase58());
  console.log("RPC:      ", RPC_URL);
  console.log("Fix price:", `$${(Number(FIX_PRICE_E6) / 1e6).toFixed(2)} (${FIX_PRICE_E6})`);
  console.log("Dry run:  ", dryRun);
  console.log();

  const adminKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(ADMIN_KP_PATH, "utf8")))
  );
  console.log("Admin:    ", adminKp.publicKey.toBase58());
  console.log();

  const conn = new Connection(RPC_URL, "confirmed");

  for (const slab of CORRUPT_SLABS) {
    const slabPk = new PublicKey(slab.address);
    console.log(`--- ${slab.name} (${slab.address}) ---`);
    console.log(`  Corrupt on-chain price: ${slab.corruptPriceUsd}`);

    // Verify account exists
    const accountInfo = await conn.getAccountInfo(slabPk);
    if (!accountInfo) {
      console.log("  ❌ Account not found on-chain — skipping");
      console.log();
      continue;
    }
    console.log(`  ✓ Account found: ${accountInfo.data.length} bytes`);

    if (accountInfo.owner.toBase58() !== PROGRAM_ID.toBase58()) {
      console.log(`  ❌ Owner mismatch: ${accountInfo.owner.toBase58()} ≠ ${PROGRAM_ID.toBase58()}`);
      console.log("     Try setting PROGRAM_ID env var to override");
      console.log();
      continue;
    }

    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const ixData = encodePushOraclePrice({
      priceE6: FIX_PRICE_E6.toString(),
      timestamp: timestamp.toString(),
    });
    const keys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
      adminKp.publicKey,
      slabPk,
    ]);

    if (dryRun) {
      console.log(`  🔍 DRY RUN — would call PushOraclePrice:`);
      console.log(`     priceE6 = ${FIX_PRICE_E6} ($100.00)`);
      console.log(`     timestamp = ${timestamp}`);
      console.log();
      continue;
    }

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      buildIx({ programId: PROGRAM_ID, keys, data: ixData })
    );
    tx.feePayer = adminKp.publicKey;
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;

    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [adminKp], {
        commitment: "confirmed",
        skipPreflight: false,
      });
      console.log(`  ✅ PushOraclePrice success: ${sig}`);
      console.log(`     Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    } catch (err) {
      const e = err as Error & { logs?: string[] };
      console.log(`  ❌ PushOraclePrice failed: ${e.message}`);
      if (e.logs?.length) {
        console.log("  Program logs:");
        e.logs.slice(-10).forEach(l => console.log("   ", l));
      }
    }
    console.log();
  }

  console.log("Done.");
  console.log();
  console.log("Next steps:");
  console.log(
    "  1. Oracle-keeper should now be able to crank these slabs (valid price set)"
  );
  console.log(
    "  2. These are TEST/garbage markets — consider running drain-broken-slab.ts"
  );
  console.log("     to resolve + close them permanently:");
  console.log(
    "     npx tsx scripts/drain-broken-slab.ts --slab GYpukkn94KKDU9ufNURjDZVMGPp3LTadZrdoPtE2cdc1 --price 100"
  );
  console.log(
    "     npx tsx scripts/drain-broken-slab.ts --slab 2Zta2EPRR444Hp2WbH2L9vfM38Stwr9chDpNk66eevzU --price 100"
  );
}

main().catch(e => {
  console.error("Fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
