#!/usr/bin/env npx tsx
/**
 * pause-market.ts — Emergency pause / unpause a devnet market on-chain.
 *
 * When paused the program blocks Trade, Deposit, Withdraw, and InitUser.
 * Crank, liquidation, admin actions, and UnpauseMarket still proceed.
 *
 * Usage:
 *   # Pause
 *   npx tsx scripts/pause-market.ts --market <SLAB_PUBKEY>
 *
 *   # Unpause
 *   npx tsx scripts/pause-market.ts --market <SLAB_PUBKEY> --unpause
 *
 *   # Dry-run (prints TX without sending)
 *   npx tsx scripts/pause-market.ts --market <SLAB_PUBKEY> [--unpause] --dry-run
 *
 * Prerequisites:
 *   - Admin keypair at ADMIN_KEYPAIR_PATH or
 *     ~/.config/solana/percolator-upgrade-authority.json
 *   - RPC_URL env var, or defaults to devnet
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

import {
  encodePauseMarket,
  encodeUnpauseMarket,
  buildAccountMetas,
  buildIx,
  ACCOUNTS_PAUSE_MARKET,
  ACCOUNTS_UNPAUSE_MARKET,
} from "../packages/core/src/index.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    market:    { type: "string" },
    unpause:   { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    program:   { type: "string" },
  },
  strict: true,
});

if (!args.market) {
  console.error("❌  --market <SLAB_PUBKEY> is required");
  process.exit(1);
}

const ACTION   = args.unpause ? "unpause" : "pause";
const DRY_RUN  = args["dry-run"] ?? false;
const RPC_URL  = process.env.RPC_URL ?? "https://api.devnet.solana.com";

// ---------------------------------------------------------------------------
// Known program IDs (all 3 tiers)
// ---------------------------------------------------------------------------
const DEFAULT_PROGRAMS = [
  "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",  // Large
  "FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn",  // Small
  "g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in",   // Medium
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function loadKeypair(path: string): Keypair {
  const resolved = path.startsWith("~")
    ? path.replace("~", process.env.HOME ?? "")
    : path;
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(resolved, "utf8")))
  );
}

/** Return the program that owns the slab account, or undefined if not found. */
async function resolveProgram(
  conn: Connection,
  slabPubkey: PublicKey,
  programOverride?: string,
): Promise<PublicKey> {
  if (programOverride) return new PublicKey(programOverride);

  const info = await conn.getAccountInfo(slabPubkey);
  if (!info) throw new Error(`Slab account ${slabPubkey.toBase58()} not found on-chain`);

  const owner = info.owner.toBase58();
  if (!DEFAULT_PROGRAMS.includes(owner)) {
    throw new Error(
      `Slab owner ${owner} is not a known Percolator program ID.\n` +
      `Pass --program <PROGRAM_PUBKEY> to override.`
    );
  }
  return info.owner;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=".repeat(60));
  console.log(`Percolator: ${ACTION.toUpperCase()} MARKET`);
  if (DRY_RUN) console.log("⚠️  DRY-RUN MODE — no transaction will be sent");
  console.log("=".repeat(60));

  const conn     = new Connection(RPC_URL, "confirmed");
  const adminPath =
    process.env.ADMIN_KEYPAIR_PATH ??
    `${process.env.HOME}/.config/solana/percolator-upgrade-authority.json`;

  let admin: Keypair;
  try {
    admin = loadKeypair(adminPath);
  } catch {
    console.error(`❌ Cannot load admin keypair from ${adminPath}`);
    console.error("   Set ADMIN_KEYPAIR_PATH env var to point to the correct file.");
    process.exit(1);
  }

  const slabPubkey = new PublicKey(args.market!);
  console.log(`\nSlab    : ${slabPubkey.toBase58()}`);
  console.log(`Admin   : ${admin.publicKey.toBase58()}`);
  console.log(`RPC     : ${RPC_URL}`);
  console.log(`Action  : ${ACTION.toUpperCase()}\n`);

  // Resolve owning program
  const programId = await resolveProgram(conn, slabPubkey, args.program);
  console.log(`Program : ${programId.toBase58()}\n`);

  // Build instruction
  const data = args.unpause ? encodeUnpauseMarket() : encodePauseMarket();
  const accounts = args.unpause ? ACCOUNTS_UNPAUSE_MARKET : ACCOUNTS_PAUSE_MARKET;
  const keys = buildAccountMetas(accounts, [admin.publicKey, slabPubkey]);
  const ix: TransactionInstruction = buildIx({ programId, keys, data });

  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 });

  if (DRY_RUN) {
    console.log("Instruction (dry-run):");
    console.log("  programId:", programId.toBase58());
    console.log("  data (hex):", Buffer.from(data).toString("hex"));
    console.log("  accounts:");
    for (const k of keys) {
      console.log(
        `    ${k.pubkey.toBase58()}  signer=${k.isSigner}  writable=${k.isWritable}`
      );
    }
    console.log("\n✅ Dry-run complete — no changes made.");
    return;
  }

  // Send TX
  const tx = new Transaction().add(computeIx, ix);
  console.log(`Sending ${ACTION} transaction...`);
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [admin], {
      commitment: "confirmed",
    });
    console.log(`\n✅ Market ${ACTION}d successfully!`);
    console.log(`   Signature : ${sig}`);
    console.log(
      `   Explorer  : https://explorer.solana.com/tx/${sig}?cluster=devnet`
    );
  } catch (err) {
    console.error(`\n❌ Transaction failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
