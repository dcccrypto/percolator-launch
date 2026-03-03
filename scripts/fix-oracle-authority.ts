#!/usr/bin/env npx tsx
/**
 * PERC-387: Fix oracle authority on deployed markets.
 *
 * The oracle-keeper skips markets where on-chain oracle_authority doesn't match
 * the keeper's admin key. This script reads the deployment file, checks each
 * market's oracle_authority, and calls SetOracleAuthority + PushOraclePrice +
 * KeeperCrank to fix mismatches.
 *
 * Usage:
 *   npx tsx scripts/fix-oracle-authority.ts [--dry-run]
 *
 * Requires: ADMIN_KEYPAIR_PATH or ~/.config/solana/percolator-upgrade-authority.json
 */

import {
  Connection, Keypair, PublicKey, Transaction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  encodeSetOracleAuthority, encodePushOraclePrice,
  encodeKeeperCrank,
  ACCOUNTS_SET_ORACLE_AUTHORITY, ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_KEEPER_CRANK,
  buildAccountMetas, buildIx, WELL_KNOWN,
  fetchSlab, parseConfig,
} from "../packages/core/src/index.js";
import * as fs from "fs";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const ADMIN_KP_PATH = process.env.ADMIN_KEYPAIR_PATH ??
  `${process.env.HOME}/.config/solana/percolator-upgrade-authority.json`;
const DRY_RUN = process.argv.includes("--dry-run");

const conn = new Connection(RPC_URL, "confirmed");
const admin = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(ADMIN_KP_PATH, "utf8")))
);

interface MarketInfo {
  symbol: string;
  label: string;
  slab: string;
  priceE6?: string;
}

async function main() {
  console.log(`Admin: ${admin.publicKey.toBase58()}`);
  console.log(`RPC: ${new URL(RPC_URL).hostname}`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}\n`);

  const deployPath = "/tmp/percolator-devnet-deployment.json";
  if (!fs.existsSync(deployPath)) {
    console.error("❌ Deployment file not found:", deployPath);
    process.exit(1);
  }
  const deploy = JSON.parse(fs.readFileSync(deployPath, "utf8"));
  const programId = new PublicKey(deploy.programId);
  const markets = deploy.markets as MarketInfo[];

  let fixed = 0;
  let skipped = 0;

  for (const market of markets) {
    const slabPk = new PublicKey(market.slab);
    console.log(`── ${market.label} (${market.slab.slice(0, 12)}...) ──`);

    try {
      const data = await fetchSlab(conn, slabPk);
      const cfg = parseConfig(data);

      // Read admin from header directly (offset 16, 32 bytes)
      const rawData = (await conn.getAccountInfo(slabPk))!.data;
      const slabAdmin = new PublicKey(rawData.subarray(16, 48));

      console.log(`  Slab admin:       ${slabAdmin.toBase58().slice(0, 16)}...`);
      console.log(`  Oracle authority:  ${cfg.oracleAuthority.toBase58().slice(0, 16)}...`);
      console.log(`  Our key:          ${admin.publicKey.toBase58().slice(0, 16)}...`);

      if (cfg.oracleAuthority.equals(admin.publicKey)) {
        console.log(`  ✅ Already correct — skipping\n`);
        skipped++;
        continue;
      }

      if (!slabAdmin.equals(admin.publicKey)) {
        console.log(`  ❌ Slab admin is NOT our key — cannot fix (need admin to sign)\n`);
        continue;
      }

      if (DRY_RUN) {
        console.log(`  🔵 Would fix: SetOracleAuthority → ${admin.publicKey.toBase58().slice(0, 16)}...\n`);
        fixed++;
        continue;
      }

      // Fix: SetOracleAuthority → our key, then push initial price + crank
      const setAuthData = encodeSetOracleAuthority({ newAuthority: admin.publicKey });
      const setAuthKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [admin.publicKey, slabPk]);

      const priceE6 = market.priceE6 ?? "1000000";
      const now = Math.floor(Date.now() / 1000);
      const pushData = encodePushOraclePrice({
        priceE6,
        timestamp: now.toString(),
      });
      const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [admin.publicKey, slabPk]);

      const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
      const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
        admin.publicKey, slabPk, WELL_KNOWN.clock, slabPk,
      ]);

      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        buildIx({ programId, keys: setAuthKeys, data: setAuthData }),
        buildIx({ programId, keys: pushKeys, data: pushData }),
        buildIx({ programId, keys: crankKeys, data: crankData }),
      );
      tx.feePayer = admin.publicKey;
      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;

      const sig = await sendAndConfirmTransaction(conn, tx, [admin], {
        commitment: "confirmed",
        skipPreflight: true,
      });

      console.log(`  ✅ Fixed! Sig: ${sig.slice(0, 16)}...\n`);
      fixed++;
    } catch (e) {
      console.log(`  ❌ Error: ${(e as Error).message?.slice(0, 80)}\n`);
    }
  }

  console.log(`\nDone: ${fixed} fixed, ${skipped} already correct, ${markets.length - fixed - skipped} failed`);
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
