#!/usr/bin/env npx tsx
/**
 * Devnet Market Re-Initialization Script
 *
 * Closes an existing slab (via CloseSlab instruction) and re-creates the market
 * with a fresh slab account at the correct size. Useful when the on-chain program
 * has been upgraded with a new slab layout (causing InvalidSlabLen errors) or when
 * devnet markets need a clean reset.
 *
 * Usage:
 *   npx tsx scripts/devnet-reinit-market.ts \
 *     --slab <OLD_SLAB_PUBKEY> \
 *     --tier <small|medium|large> \
 *     [--mint <SPL_MINT>] \
 *     [--initial-price <E6>] \
 *     [--lp-collateral <AMOUNT>] \
 *     [--insurance <AMOUNT>] \
 *     [--oracle-feed <HEX64>] \
 *     [--invert] \
 *     [--trading-fee-bps N] \
 *     [--initial-margin-bps N] \
 *     [--skip-close]        # Skip CloseSlab (if already closed or uninitialized)
 *     [--dry-run]           # Print what would happen, don't send txns
 *
 * Prerequisites:
 *   - .env with RPC_URL (must be devnet!) and ADMIN_KEYPAIR_PATH
 *   - Admin keypair that matches the market's admin
 *   - Sufficient SOL for new slab rent + tx fees
 *
 * The script will:
 *   1. Read the old slab to extract current market config (mint, oracle, etc.)
 *   2. Close the old slab (CloseSlab instruction — reclaims rent SOL)
 *   3. Create a new slab account at the correct tier size
 *   4. InitMarket with the same (or overridden) parameters
 *   5. Re-set up LP, insurance, and oracle
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { parseArgs } from "node:util";

import {
  encodeInitMarket,
  encodeInitLP,
  encodeDepositCollateral,
  encodeTopUpInsurance,
  encodeKeeperCrank,
  encodeSetOracleAuthority,
  encodePushOraclePrice,
  encodeCloseSlab,
} from "../packages/core/src/abi/instructions.js";
import {
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_CLOSE_SLAB,
  buildAccountMetas,
} from "../packages/core/src/abi/accounts.js";
import { deriveVaultAuthority, derivePythPushOraclePDA } from "../packages/core/src/solana/pda.js";
import { buildIx } from "../packages/core/src/runtime/tx.js";
import { SLAB_TIERS, type SlabTierKey } from "../packages/core/src/solana/discovery.js";
import { parseHeader, parseConfig } from "../packages/core/src/solana/slab.js";

dotenv.config();

// ============================================================================
// CLI ARGS
// ============================================================================

const { values: args } = parseArgs({
  options: {
    slab: { type: "string" },
    tier: { type: "string", default: "large" },
    mint: { type: "string" },
    "initial-price": { type: "string" },
    "lp-collateral": { type: "string" },
    insurance: { type: "string" },
    "oracle-feed": { type: "string" },
    invert: { type: "boolean", default: false },
    "trading-fee-bps": { type: "string", default: "30" },
    "initial-margin-bps": { type: "string", default: "1000" },
    "skip-close": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});

if (!args.slab) throw new Error("--slab is required (old slab pubkey to close + reinit)");

const TIER = args.tier as SlabTierKey;
if (!SLAB_TIERS[TIER]) {
  throw new Error(`Invalid --tier "${args.tier}". Must be one of: ${Object.keys(SLAB_TIERS).join(", ")}`);
}

const PRIORITY_FEE = 50_000;
const DRY_RUN = args["dry-run"] ?? false;
const SKIP_CLOSE = args["skip-close"] ?? false;

// ============================================================================
// HELPERS
// ============================================================================

function loadKeypair(path: string): Keypair {
  const resolved = path.startsWith("~/")
    ? path.replace("~", process.env.HOME || "")
    : path;
  const raw = fs.readFileSync(resolved, "utf-8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function addPriorityFee(tx: Transaction): void {
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE }));
}

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("PERCOLATOR - DEVNET MARKET RE-INITIALIZATION");
  console.log("=".repeat(70));

  // Validate devnet
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL not set in .env");
  // Detect network from RPC URL
  const detectedNetwork = rpcUrl.includes("devnet")
    ? "devnet"
    : rpcUrl.includes("mainnet")
      ? "mainnet-beta"
      : rpcUrl.includes("testnet")
        ? "testnet"
        : "unknown";

  if (detectedNetwork !== "devnet") {
    console.error("\n⛔ SAFETY: RPC_URL does not contain 'devnet'.");
    console.error("   This script is designed for devnet only.");
    console.error("   If you REALLY want to run on a non-devnet cluster, set FORCE_NON_DEVNET=1");
    if (process.env.FORCE_NON_DEVNET !== "1") process.exit(1);
    console.warn("\n⚠️  FORCE_NON_DEVNET=1 — proceeding on non-devnet cluster\n");
  }

  const PROGRAM_ID = new PublicKey(
    process.env.PROGRAM_ID || "GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24"
  );
  const keypairPath = process.env.ADMIN_KEYPAIR_PATH || "./admin-keypair.json";
  const payer = loadKeypair(keypairPath);
  const connection = new Connection(rpcUrl, "confirmed");

  const oldSlabPubkey = new PublicKey(args.slab!);
  const tierInfo = SLAB_TIERS[TIER];

  // Log only the RPC host, never full URL (may contain API keys/tokens)
  let rpcHost: string;
  try {
    const u = new URL(rpcUrl);
    rpcHost = u.origin;
  } catch {
    rpcHost = rpcUrl.split("/").slice(0, 3).join("/").replace(/[?#].*/, "");
  }
  console.log(`\nRPC: ${rpcHost}`);
  console.log(`Admin: ${payer.publicKey.toBase58()}`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`Old Slab: ${oldSlabPubkey.toBase58()}`);
  console.log(`New Tier: ${tierInfo.label} (${tierInfo.maxAccounts} slots, ${tierInfo.dataSize} bytes)`);
  console.log(`Dry Run: ${DRY_RUN}`);
  console.log(`Skip Close: ${SKIP_CLOSE}`);

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);

  // ========================================================================
  // STEP 0: Read existing market config from old slab
  // ========================================================================
  console.log("\n--- Step 0: Reading old slab data ---");

  let existingMint: PublicKey | null = null;
  let existingFeedId: string | null = null;
  let existingInvert: number | null = null;
  let existingPrice: bigint | null = null;

  const slabInfo = await connection.getAccountInfo(oldSlabPubkey);
  if (slabInfo) {
    console.log(`  Old slab: ${slabInfo.data.length} bytes (owner: ${slabInfo.owner.toBase58().slice(0, 12)}...)`);
    console.log(`  Old slab rent: ${(slabInfo.lamports / 1e9).toFixed(4)} SOL`);

    try {
      const data = slabInfo.data;
      const header = parseHeader(data);
      const config = parseConfig(data);

      existingMint = config.collateralMint;
      existingFeedId = hexEncode(new Uint8Array(config.indexFeedId));
      existingInvert = config.invert ? 1 : 0;
      existingPrice = config.initialMarkPriceE6 ?? null;

      console.log(`  Existing mint: ${existingMint.toBase58()}`);
      console.log(`  Existing oracle feed: ${existingFeedId}`);
      console.log(`  Existing invert: ${existingInvert}`);
      if (existingPrice) console.log(`  Existing initial price (e6): ${existingPrice}`);
      console.log(`  Header version: ${header.version}`);
    } catch (e: any) {
      console.warn(`  ⚠️  Could not parse old slab (may be corrupted): ${e.message}`);
      console.warn("  Will use CLI overrides for all parameters.");
    }
  } else {
    console.warn("  ⚠️  Old slab account not found on-chain. Using --skip-close automatically.");
  }

  // Resolve final parameters (CLI overrides > existing config > defaults)
  const MINT = new PublicKey(args.mint || existingMint?.toBase58() || (() => { throw new Error("--mint required (old slab has no data)"); })());
  const ORACLE_FEED = args["oracle-feed"] || existingFeedId || "0".repeat(64);
  const INVERT = args.invert ? 1 : (existingInvert ?? 0);
  const INITIAL_PRICE_E6 = BigInt(args["initial-price"] || existingPrice?.toString() || (() => { throw new Error("--initial-price required (could not read from old slab)"); })());
  const LP_COLLATERAL = BigInt(args["lp-collateral"] || "10000000"); // 10 USDC default for devnet
  const INSURANCE_AMOUNT = BigInt(args.insurance || "5000000"); // 5 USDC default for devnet
  const TRADING_FEE_BPS = BigInt(args["trading-fee-bps"]!);
  const INITIAL_MARGIN_BPS = BigInt(args["initial-margin-bps"]!);
  const IS_ADMIN_ORACLE = ORACLE_FEED === "0".repeat(64);

  // --- Input validation ---
  if (!IS_ADMIN_ORACLE && !/^[0-9a-fA-F]{64}$/.test(ORACLE_FEED)) {
    throw new Error(`Invalid oracle feed ID: expected 64 hex chars, got "${ORACLE_FEED}"`);
  }
  if (INVERT !== 0 && INVERT !== 1) {
    throw new Error(`Invalid --invert value: expected 0 or 1, got ${INVERT}`);
  }
  if (INITIAL_PRICE_E6 <= 0n) {
    throw new Error(`Invalid --initial-price: must be positive, got ${INITIAL_PRICE_E6}`);
  }
  if (LP_COLLATERAL <= 0n) {
    throw new Error(`Invalid --lp-collateral: must be positive, got ${LP_COLLATERAL}`);
  }
  if (INSURANCE_AMOUNT < 0n) {
    throw new Error(`Invalid --insurance: must be non-negative, got ${INSURANCE_AMOUNT}`);
  }
  if (TRADING_FEE_BPS < 0n || TRADING_FEE_BPS > 10000n) {
    throw new Error(`Invalid --trading-fee-bps: must be 0-10000, got ${TRADING_FEE_BPS}`);
  }
  if (INITIAL_MARGIN_BPS < 0n || INITIAL_MARGIN_BPS > 10000n) {
    throw new Error(`Invalid --initial-margin-bps: must be 0-10000, got ${INITIAL_MARGIN_BPS}`);
  }

  console.log("\n--- Final Parameters ---");
  console.log(`  Mint: ${MINT.toBase58()}`);
  console.log(`  Oracle: ${IS_ADMIN_ORACLE ? "Admin (push)" : `Pyth (${ORACLE_FEED.slice(0, 16)}...)`}`);
  console.log(`  Inverted: ${INVERT ? "Yes" : "No"}`);
  console.log(`  Initial Price (e6): ${INITIAL_PRICE_E6}`);
  console.log(`  LP Collateral: ${LP_COLLATERAL}`);
  console.log(`  Insurance: ${INSURANCE_AMOUNT}`);
  console.log(`  Trading Fee: ${TRADING_FEE_BPS} bps`);
  console.log(`  Initial Margin: ${INITIAL_MARGIN_BPS} bps`);
  console.log(`  Tier: ${TIER} (${tierInfo.maxAccounts} accounts, ${tierInfo.dataSize} bytes)`);

  if (DRY_RUN) {
    console.log("\n🏁 DRY RUN — no transactions sent.\n");
    return;
  }

  // ========================================================================
  // STEP 1: Close old slab (CloseSlab instruction)
  // ========================================================================
  if (!SKIP_CLOSE && slabInfo) {
    console.log("\n--- Step 1: Closing old slab ---");

    const closeData = encodeCloseSlab();
    const closeKeys = buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [
      payer.publicKey,      // admin (signer, writable)
      oldSlabPubkey,        // slab (writable)
    ]);

    const closeTx = new Transaction();
    addPriorityFee(closeTx);
    closeTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    closeTx.add(buildIx({ programId: PROGRAM_ID, keys: closeKeys, data: closeData }));

    try {
      const sig = await sendAndConfirmTransaction(connection, closeTx, [payer], {
        commitment: "confirmed",
      });
      console.log(`  ✅ Old slab closed. TX: ${sig}`);
      const newBalance = await connection.getBalance(payer.publicKey);
      console.log(`  Balance after close: ${(newBalance / 1e9).toFixed(4)} SOL (reclaimed ${((newBalance - balance) / 1e9).toFixed(4)} SOL)`);
    } catch (e: any) {
      console.error(`  ❌ CloseSlab failed: ${e.message}`);
      console.error("  If the slab is already closed or you're not the admin, use --skip-close");
      process.exit(1);
    }
  } else {
    console.log("\n--- Step 1: Skipped (--skip-close or slab not found) ---");
  }

  // ========================================================================
  // STEP 2: Create new slab account + InitMarket
  // ========================================================================
  console.log("\n--- Step 2: Creating new slab + InitMarket ---");

  const newSlabKp = Keypair.generate();
  const slabSize = tierInfo.dataSize;
  const slabRent = await connection.getMinimumBalanceForRentExemption(slabSize);

  console.log(`  New slab: ${newSlabKp.publicKey.toBase58()}`);
  console.log(`  Size: ${slabSize} bytes`);
  console.log(`  Rent: ${(slabRent / 1e9).toFixed(4)} SOL`);

  // Create slab account (separate tx due to size)
  const createSlabTx = new Transaction();
  addPriorityFee(createSlabTx);
  createSlabTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
  createSlabTx.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: newSlabKp.publicKey,
      lamports: slabRent,
      space: slabSize,
      programId: PROGRAM_ID,
    }),
  );

  const createSig = await sendAndConfirmTransaction(connection, createSlabTx, [payer, newSlabKp], {
    commitment: "confirmed",
  });
  console.log(`  ✅ New slab account created. TX: ${createSig}`);

  // Derive vault PDA + ATA
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, newSlabKp.publicKey);
  const vaultAccount = await getOrCreateAssociatedTokenAccount(
    connection, payer, MINT, vaultPda, true,
  );
  const vault = vaultAccount.address;
  console.log(`  Vault PDA: ${vaultPda.toBase58()}`);
  console.log(`  Vault ATA: ${vault.toBase58()}`);

  // Admin ATA
  const adminAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, MINT, payer.publicKey,
  );

  // InitMarket
  const initMarketData = encodeInitMarket({
    admin: payer.publicKey,
    collateralMint: MINT,
    indexFeedId: ORACLE_FEED,
    maxStalenessSecs: "50",
    confFilterBps: 0,
    invert: INVERT,
    unitScale: 0,
    initialMarkPriceE6: INITIAL_PRICE_E6.toString(),
    warmupPeriodSlots: "0",
    maintenanceMarginBps: (INITIAL_MARGIN_BPS / 2n).toString(),
    initialMarginBps: INITIAL_MARGIN_BPS.toString(),
    tradingFeeBps: TRADING_FEE_BPS.toString(),
    maxAccounts: tierInfo.maxAccounts.toString(),
    newAccountFee: "1000000",
    riskReductionThreshold: "0",
    maintenanceFeePerSlot: "0",
    maxCrankStalenessSlots: "100",
    liquidationFeeBps: "100",
    liquidationFeeCap: "0",
    liquidationBufferBps: "50",
    minLiquidationAbs: "0",
  });

  const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
    payer.publicKey,
    newSlabKp.publicKey,
    MINT,
    vault,
    TOKEN_PROGRAM_ID,
    SYSVAR_CLOCK_PUBKEY,
    SYSVAR_RENT_PUBKEY,
    vault, // dummyAta
    SystemProgram.programId,
  ]);

  const initMarketTx = new Transaction();
  addPriorityFee(initMarketTx);
  initMarketTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  initMarketTx.add(buildIx({ programId: PROGRAM_ID, keys: initMarketKeys, data: initMarketData }));

  const initSig = await sendAndConfirmTransaction(connection, initMarketTx, [payer], {
    commitment: "confirmed",
  });
  console.log(`  ✅ Market initialized. TX: ${initSig}`);

  // ========================================================================
  // STEP 3: InitLP + Deposit + Insurance
  // ========================================================================
  console.log("\n--- Step 3: LP + Insurance setup ---");

  // InitLP
  const initLpData = encodeInitLP({
    matcherProgram: SystemProgram.programId,
    matcherContext: SystemProgram.programId,
    feePayment: "0",
  });
  const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [
    payer.publicKey,
    newSlabKp.publicKey,
    adminAta.address,
    vault,
    TOKEN_PROGRAM_ID,
  ]);

  const initLpTx = new Transaction();
  addPriorityFee(initLpTx);
  initLpTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
  initLpTx.add(buildIx({ programId: PROGRAM_ID, keys: initLpKeys, data: initLpData }));
  await sendAndConfirmTransaction(connection, initLpTx, [payer], { commitment: "confirmed" });
  console.log("  ✅ LP initialized at index 0");

  // Deposit collateral to LP
  const depositData = encodeDepositCollateral({
    userIdx: 0,
    amount: LP_COLLATERAL.toString(),
  });
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    payer.publicKey,
    newSlabKp.publicKey,
    adminAta.address,
    vault,
    TOKEN_PROGRAM_ID,
    SYSVAR_CLOCK_PUBKEY,
  ]);

  const depositTx = new Transaction();
  addPriorityFee(depositTx);
  depositTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
  depositTx.add(buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData }));
  await sendAndConfirmTransaction(connection, depositTx, [payer], { commitment: "confirmed" });
  console.log(`  ✅ Deposited ${LP_COLLATERAL} to LP`);

  // Top up insurance
  const topupData = encodeTopUpInsurance({ amount: INSURANCE_AMOUNT.toString() });
  const topupKeys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
    payer.publicKey,
    newSlabKp.publicKey,
    adminAta.address,
    vault,
    TOKEN_PROGRAM_ID,
  ]);

  const topupTx = new Transaction();
  addPriorityFee(topupTx);
  topupTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
  topupTx.add(buildIx({ programId: PROGRAM_ID, keys: topupKeys, data: topupData }));
  await sendAndConfirmTransaction(connection, topupTx, [payer], { commitment: "confirmed" });
  console.log(`  ✅ Insurance topped up: ${INSURANCE_AMOUNT}`);

  // ========================================================================
  // STEP 4: Oracle setup + initial crank
  // ========================================================================
  if (IS_ADMIN_ORACLE) {
    console.log("\n--- Step 4: Admin oracle setup + initial crank ---");

    const setAuthData = encodeSetOracleAuthority({ newAuthority: payer.publicKey });
    const setAuthKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
      payer.publicKey,
      newSlabKp.publicKey,
    ]);

    const setAuthTx = new Transaction();
    addPriorityFee(setAuthTx);
    setAuthTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    setAuthTx.add(buildIx({ programId: PROGRAM_ID, keys: setAuthKeys, data: setAuthData }));
    await sendAndConfirmTransaction(connection, setAuthTx, [payer], { commitment: "confirmed" });
    console.log("  ✅ Oracle authority set");

    const now = Math.floor(Date.now() / 1000);
    const pushData = encodePushOraclePrice({
      priceE6: INITIAL_PRICE_E6.toString(),
      timestamp: now.toString(),
    });
    const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
      payer.publicKey,
      newSlabKp.publicKey,
    ]);

    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey,
      newSlabKp.publicKey,
      SYSVAR_CLOCK_PUBKEY,
      newSlabKp.publicKey, // admin oracle: oracle account = slab
    ]);

    const pushCrankTx = new Transaction();
    addPriorityFee(pushCrankTx);
    pushCrankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }));
    pushCrankTx.add(buildIx({ programId: PROGRAM_ID, keys: pushKeys, data: pushData }));
    pushCrankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
    await sendAndConfirmTransaction(connection, pushCrankTx, [payer], {
      commitment: "confirmed",
      skipPreflight: false,
    });
    console.log(`  ✅ Price pushed (${INITIAL_PRICE_E6} e6) + crank succeeded`);
  } else {
    console.log("\n--- Step 4: Pyth oracle crank ---");

    const [pythPDA] = derivePythPushOraclePDA(ORACLE_FEED);
    console.log(`  Pyth Push Oracle PDA: ${pythPDA.toBase58()}`);

    const pythInfo = await connection.getAccountInfo(pythPDA);
    if (!pythInfo) {
      console.warn("  ⚠️  Pyth Push Oracle not found on-chain. Skipping initial crank.");
    } else {
      const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
      const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
        payer.publicKey,
        newSlabKp.publicKey,
        SYSVAR_CLOCK_PUBKEY,
        pythPDA,
      ]);

      const crankTx = new Transaction();
      addPriorityFee(crankTx);
      crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }));
      crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
      await sendAndConfirmTransaction(connection, crankTx, [payer], {
        commitment: "confirmed",
        skipPreflight: false,
      });
      console.log("  ✅ Pyth oracle crank succeeded");
    }
  }

  // ========================================================================
  // Save output
  // ========================================================================
  const outPath = `devnet-reinit-${TIER}-${Date.now()}.json`;
  const pythPDA = IS_ADMIN_ORACLE ? null : derivePythPushOraclePDA(ORACLE_FEED)[0].toBase58();

  const marketInfo = {
    network: detectedNetwork,
    reinitializedAt: new Date().toISOString(),
    programId: PROGRAM_ID.toBase58(),
    oldSlab: oldSlabPubkey.toBase58(),
    newSlab: newSlabKp.publicKey.toBase58(),
    tier: TIER,
    slabSize: tierInfo.dataSize,
    maxAccounts: tierInfo.maxAccounts,
    mint: MINT.toBase58(),
    vault: vault.toBase58(),
    vaultPda: vaultPda.toBase58(),
    oracleMode: IS_ADMIN_ORACLE ? "admin" : "pyth",
    oracleFeed: ORACLE_FEED,
    pythOraclePDA: pythPDA,
    inverted: INVERT === 1,
    initialPriceE6: INITIAL_PRICE_E6.toString(),
    tradingFeeBps: TRADING_FEE_BPS.toString(),
    initialMarginBps: INITIAL_MARGIN_BPS.toString(),
    lpCollateral: LP_COLLATERAL.toString(),
    insuranceAmount: INSURANCE_AMOUNT.toString(),
    admin: payer.publicKey.toBase58(),
  };

  fs.writeFileSync(outPath, JSON.stringify(marketInfo, null, 2));
  console.log(`\nOutput saved to ${outPath}`);

  console.log("\n" + "=".repeat(70));
  console.log("✅ DEVNET MARKET RE-INITIALIZED SUCCESSFULLY");
  console.log("=".repeat(70));
  console.log(`\n  Old Slab: ${oldSlabPubkey.toBase58()}`);
  console.log(`  New Slab: ${newSlabKp.publicKey.toBase58()}`);
  console.log(`  Tier:     ${tierInfo.label} (${tierInfo.maxAccounts} accounts)`);
  console.log(`  Mint:     ${MINT.toBase58()}`);
  console.log(`  Oracle:   ${IS_ADMIN_ORACLE ? "Admin" : "Pyth"}`);

  // Reminder for downstream updates
  console.log("\n📋 NEXT STEPS:");
  console.log("  1. Update .env / Supabase with new slab address");
  console.log("  2. Restart keeper/indexer services to pick up new slab");
  console.log("  3. Verify on Solana Explorer: https://explorer.solana.com/address/" + newSlabKp.publicKey.toBase58() + "?cluster=devnet");
  console.log("  4. Run a test crank to confirm market is live\n");
}

main().catch((err) => {
  console.error("\n❌ Fatal error:", err.message || err);
  process.exit(1);
});
