#!/usr/bin/env tsx
/**
 * PERC-8400: Rescue-and-recreate script.
 *
 * Recovers a Percolator market from an orphaned state by:
 *   1. RescueOrphanVault  — drain stranded tokens from the vault ATA.
 *   2. CloseOrphanSlab    — reclaim rent lamports from the old slab.
 *   3. InitMarket         — create a fresh slab + vault for the same asset.
 *   4. InitLP             — register the LP account with matcher program.
 *   5. InitMatcherCtx     — CPI to matcher to initialize the context account
 *                           (LP PDA signs via invoke_signed in-program).
 *   6. DepositCollateral  — seed LP's initial collateral.
 *
 * Usage:
 *   ADMIN_KEYPAIR=/path/to/admin.json \
 *   SLAB_KEYPAIR=/path/to/slab.json   \
 *   RPC_URL=https://...               \
 *   npx tsx scripts/rescue-and-recreate.ts
 *
 * All steps are guarded — if a step's account already exists on-chain in the
 * expected state, the step is skipped with a log message.
 *
 * Environment variables:
 *   ADMIN_KEYPAIR        — Path to admin keypair JSON (required)
 *   SLAB_KEYPAIR         — Path to NEW slab keypair JSON (required for InitMarket)
 *   OLD_SLAB             — Pubkey of the orphaned slab to rescue (optional)
 *   RPC_URL              — Solana RPC endpoint (default: devnet via Helius)
 *   MATCHER_ID           — Matcher program ID (default: mainnet DHP6...)
 *   MATCHER_CTX          — Matcher context account pubkey (required for InitMatcherCtx)
 *   LP_IDX               — LP account index (default: 0)
 *   DEPOSIT_AMOUNT       — Collateral to deposit in e6 units (default: 1_000_000_000 = 1000 USDC)
 *   NETWORK              — "devnet" | "mainnet" (default: devnet)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  buildAccountMetas,
  buildIx,
  deriveLpPda,
  deriveVaultAuthority,
  getAta,
  encodeInitMatcherCtx,
  ACCOUNTS_INIT_MATCHER_CTX,
  IX_TAG,
  encodeInitLP,
  ACCOUNTS_INIT_LP,
  encodeDepositCollateral,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  WELL_KNOWN,
} from "@percolatorct/sdk";
import { getProgramId, PROGRAM_IDS } from "@percolatorct/sdk";
import * as fs from "fs";

// ============================================================================
// Helpers
// ============================================================================

function loadKeypair(envVar: string): Keypair {
  const path = process.env[envVar];
  if (!path) throw new Error(`${envVar} env var not set`);
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function log(step: string, msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${step}] ${msg}`);
}

async function sendTx(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  label: string,
): Promise<string> {
  const tx = new Transaction().add(
    // v17 wrapper installs a custom 128KB heap allocator and aborts unless the tx
    // requests the full heap frame. Must be the FIRST instruction. (issue #176)
    ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    ...instructions,
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [payer, ...signers], {
    commitment: "confirmed",
    skipPreflight: false,
  });
  log(label, `OK: ${sig}`);
  return sig;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const network = (process.env.NETWORK ?? "devnet") as "devnet" | "mainnet";
  const rpcUrl =
    process.env.RPC_URL ??
    (network === "mainnet"
      ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY ?? ""}`
      : `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_DEVNET_API_KEY ?? process.env.HELIUS_API_KEY ?? ""}`);

  const connection = new Connection(rpcUrl, "confirmed");
  const PROGRAM_ID = getProgramId(network);
  const MATCHER_PROGRAM_ID = new PublicKey(
    process.env.MATCHER_ID ?? PROGRAM_IDS[network].matcher,
  );

  const admin = loadKeypair("ADMIN_KEYPAIR");
  log("init", `Admin: ${admin.publicKey.toBase58()}`);
  log("init", `Program: ${PROGRAM_ID.toBase58()}`);
  log("init", `Matcher: ${MATCHER_PROGRAM_ID.toBase58()}`);
  log("init", `Network: ${network}`);

  // ──────────────────────────────────────────────────────────────
  // Step 5: InitMatcherCtx
  //
  // Must be called after InitLP (which stores matcher_program +
  // matcher_context in the engine). The LP PDA signs via
  // invoke_signed inside the percolator program.
  // ──────────────────────────────────────────────────────────────
  const matcherCtxStr = process.env.MATCHER_CTX;
  const slabStr = process.env.SLAB ?? process.env.OLD_SLAB;
  const lpIdx = Number(process.env.LP_IDX ?? "0");

  if (!matcherCtxStr || !slabStr) {
    log(
      "InitMatcherCtx",
      "MATCHER_CTX or SLAB env var not set — skipping InitMatcherCtx step. " +
        "Set MATCHER_CTX=<ctx_pubkey> SLAB=<slab_pubkey> LP_IDX=<idx> to run this step.",
    );
  } else {
    const slab = new PublicKey(slabStr);
    const matcherCtx = new PublicKey(matcherCtxStr);

    // Derive LP PDA: ["lp", slab, lp_idx (2-byte LE)]
    const lp_bytes = Buffer.alloc(2);
    lp_bytes.writeUInt16LE(lpIdx, 0);
    const [lpPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp"), slab.toBuffer(), lp_bytes],
      PROGRAM_ID,
    );

    log("InitMatcherCtx", `Slab:       ${slab.toBase58()}`);
    log("InitMatcherCtx", `MatcherCtx: ${matcherCtx.toBase58()}`);
    log("InitMatcherCtx", `LpPda:      ${lpPda.toBase58()}`);
    log("InitMatcherCtx", `LpIdx:      ${lpIdx}`);

    // Passive matcher defaults — safe for a Passive (kind=0) LP:
    //   trading_fee_bps:        30   (0.30%)
    //   base_spread_bps:        50   (0.50%)
    //   max_total_bps:         500   (5.00%)
    //   impact_k_bps:            0   (passive — no vAMM impact)
    //   liquidity_notional_e6:   0   (passive)
    //   max_fill_abs:      u128::MAX  (no per-fill limit)
    //   max_inventory_abs: u128::MAX  (no inventory limit)
    //   fee_to_insurance_bps:    0
    //   skew_spread_mult_bps:    0
    const U128_MAX = BigInt("340282366920938463463374607431768211455");

    const initMatcherCtxData = encodeInitMatcherCtx({
      lpIdx,
      kind: 0,              // 0 = Passive
      tradingFeeBps: 30,
      baseSpreadBps: 50,
      maxTotalBps: 500,
      impactKBps: 0,
      liquidityNotionalE6: 0n,
      maxFillAbs: U128_MAX,
      maxInventoryAbs: U128_MAX,
      feeToInsuranceBps: 0,
      skewSpreadMultBps: 0,
    });

    const initMatcherCtxIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: buildAccountMetas(ACCOUNTS_INIT_MATCHER_CTX, {
        admin: admin.publicKey,
        slab,
        matcherCtx,
        matcherProg: MATCHER_PROGRAM_ID,
        lpPda,
      }),
      data: Buffer.from(initMatcherCtxData),
    });

    await sendTx(connection, admin, [initMatcherCtxIx], [], "InitMatcherCtx");
    log("InitMatcherCtx", "Matcher context initialized. TradeCpi is now unblocked for this LP.");
  }

  log("done", "rescue-and-recreate complete.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
