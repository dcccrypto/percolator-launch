/**
 * PERC-381: Reinit a broken slab (close + recreate with correct size).
 *
 * This script:
 * 1. Reads the existing slab to check its size and active accounts
 * 2. If no active accounts, closes the slab via CloseSlab instruction
 * 3. Creates a new slab account with the correct SLAB_TIERS size
 * 4. Re-runs InitMarket to initialize the new slab
 *
 * ⚠️ DEVNET ONLY — closing a slab with active positions loses user funds.
 *
 * Usage:
 *   npx tsx scripts/reinit-slab.ts --slab <SLAB_PUBKEY> [--force] [--dry-run]
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  SystemProgram,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { parseArgs } from "node:util";
import { SLAB_TIERS } from "../packages/core/src/solana/discovery.js";
import { detectLayout } from "../packages/core/src/solana/slab.js";
import { parseHeader, parseAllAccounts } from "../packages/core/src/solana/slab.js";
import {
  encodeCloseSlab,
  encodeInitMarket,
  encodeInitLP,
} from "../packages/core/src/abi/instructions.js";
import {
  ACCOUNTS_CLOSE_SLAB,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_LP,
  buildAccountMetas,
} from "../packages/core/src/abi/accounts.js";
import { deriveVaultAuthority } from "../packages/core/src/solana/pda.js";
import { buildIx } from "../packages/core/src/runtime/tx.js";

dotenv.config();

const { values: args } = parseArgs({
  options: {
    slab: { type: "string" },
    force: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    tier: { type: "string", default: "large" },
  },
  strict: true,
});

if (!args.slab) throw new Error("--slab <PUBKEY> is required");

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24");
const PRIORITY_FEE = 50_000;

function loadKeypair(path: string): Keypair {
  const resolved = path.startsWith("~/")
    ? path.replace("~", process.env.HOME || "")
    : path;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(resolved, "utf-8"))));
}

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("PERC-381: REINIT BROKEN SLAB");
  console.log("=".repeat(70));

  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL not set in .env");

  const keypairPath = process.env.ADMIN_KEYPAIR_PATH || "./admin-keypair.json";
  const payer = loadKeypair(keypairPath);
  const connection = new Connection(rpcUrl, "confirmed");

  const slabPubkey = new PublicKey(args.slab!);
  const tierKey = args.tier as keyof typeof SLAB_TIERS;
  const tier = SLAB_TIERS[tierKey];
  if (!tier) throw new Error(`Unknown tier: ${tierKey}. Use small/medium/large`);

  console.log(`\nSlab:     ${slabPubkey.toBase58()}`);
  console.log(`Tier:     ${tier.label} (${tier.maxAccounts} accounts, ${tier.dataSize} bytes)`);
  console.log(`Admin:    ${payer.publicKey.toBase58()}`);
  console.log(`Program:  ${PROGRAM_ID.toBase58()}`);
  console.log(`Dry run:  ${args["dry-run"] ? "YES" : "no"}`);

  // Step 1: Fetch and diagnose
  console.log("\n--- Step 1: Diagnose existing slab ---");
  const accountInfo = await connection.getAccountInfo(slabPubkey);
  if (!accountInfo) {
    console.log("❌ Slab account not found on-chain. Nothing to reinit.");
    console.log("   Use create-market.ts to create a new market instead.");
    return;
  }

  console.log(`  Owner:     ${accountInfo.owner.toBase58()}`);
  console.log(`  Data size: ${accountInfo.data.length} bytes`);
  console.log(`  Expected:  ${tier.dataSize} bytes`);

  const layout = detectLayout(accountInfo.data.length);
  if (layout) {
    console.log(`  Layout:    detected (maxAccounts=${layout.maxAccounts})`);
  } else {
    console.log(`  Layout:    ❌ UNKNOWN — size doesn't match any known tier`);
    console.log(`  This is the bug. Slab was created with wrong size.`);
  }

  // Check for active accounts
  let activeAccounts = 0;
  try {
    const accounts = parseAllAccounts(new Uint8Array(accountInfo.data));
    activeAccounts = accounts.length;
    console.log(`  Active accounts: ${activeAccounts}`);
  } catch (e) {
    console.log(`  ⚠️ Could not parse accounts (layout broken): ${e}`);
  }

  if (activeAccounts > 0 && !args.force) {
    console.log(`\n❌ Slab has ${activeAccounts} active accounts. Use --force to proceed (WILL LOSE USER FUNDS).`);
    console.log("   On devnet this is acceptable. On mainnet, NEVER do this.");
    return;
  }

  if (accountInfo.data.length === tier.dataSize) {
    console.log("\n✅ Slab already has correct size. No reinit needed.");
    return;
  }

  if (args["dry-run"]) {
    console.log("\n🔍 DRY RUN — would close and recreate slab. Exiting.");
    return;
  }

  // Step 2: Close the broken slab
  console.log("\n--- Step 2: Close broken slab ---");
  const closeTx = new Transaction();
  closeTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE }));
  closeTx.add(
    buildIx(
      PROGRAM_ID,
      encodeCloseSlab(),
      buildAccountMetas(ACCOUNTS_CLOSE_SLAB, {
        admin: payer.publicKey,
        slab: slabPubkey,
      }),
    ),
  );

  const closeSig = await sendAndConfirmTransaction(connection, closeTx, [payer], {
    commitment: "confirmed",
  });
  console.log(`  ✅ Closed: ${closeSig}`);

  // Step 3: Create new slab with correct size
  console.log("\n--- Step 3: Create new slab account ---");
  const newSlabKp = Keypair.generate();
  const slabRent = await connection.getMinimumBalanceForRentExemption(tier.dataSize);
  console.log(`  New slab:  ${newSlabKp.publicKey.toBase58()}`);
  console.log(`  Size:      ${tier.dataSize} bytes`);
  console.log(`  Rent:      ${(slabRent / 1e9).toFixed(4)} SOL`);

  const createTx = new Transaction();
  createTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE }));
  createTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
  createTx.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: newSlabKp.publicKey,
      lamports: slabRent,
      space: tier.dataSize,
      programId: PROGRAM_ID,
    }),
  );

  const createSig = await sendAndConfirmTransaction(connection, createTx, [payer, newSlabKp], {
    commitment: "confirmed",
  });
  console.log(`  ✅ Created: ${createSig}`);

  console.log("\n" + "=".repeat(70));
  console.log("NEW SLAB CREATED — NEEDS InitMarket TO COMPLETE SETUP");
  console.log(`  New slab address: ${newSlabKp.publicKey.toBase58()}`);
  console.log("  Run create-market.ts with this slab, or manually call InitMarket.");
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
