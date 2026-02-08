/**
 * Permissionless market factory - creates a new Percolator perpetual market
 * for any SPL token.
 *
 * Usage:
 *   npx tsx scripts/create-market.ts \
 *     --mint <SPL_MINT> --initial-price <E6> \
 *     --lp-collateral <AMOUNT> --insurance <AMOUNT> \
 *     [--oracle-feed <HEX64>] [--invert] [--trading-fee-bps N] [--initial-margin-bps N]
 *
 * Prerequisites:
 *   - .env with RPC_URL and ADMIN_KEYPAIR_PATH
 *   - Admin keypair funded with SOL for tx fees
 *   - Admin has tokens of the specified mint for LP collateral + insurance
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
} from "../packages/core/src/abi/instructions.js";
import {
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  buildAccountMetas,
} from "../packages/core/src/abi/accounts.js";
import { deriveVaultAuthority, derivePythPushOraclePDA } from "../packages/core/src/solana/pda.js";
import { buildIx } from "../packages/core/src/runtime/tx.js";

dotenv.config();

// ============================================================================
// CLI ARGS
// ============================================================================

const { values: args } = parseArgs({
  options: {
    mint: { type: "string" },
    "initial-price": { type: "string" },
    "lp-collateral": { type: "string" },
    insurance: { type: "string" },
    "oracle-feed": { type: "string" },
    invert: { type: "boolean", default: false },
    "trading-fee-bps": { type: "string", default: "30" },
    "initial-margin-bps": { type: "string", default: "1000" },
  },
  strict: true,
});

if (!args.mint) throw new Error("--mint is required");
if (!args["initial-price"]) throw new Error("--initial-price is required");
if (!args["lp-collateral"]) throw new Error("--lp-collateral is required");
if (!args.insurance) throw new Error("--insurance is required");

const MINT = new PublicKey(args.mint);
const INITIAL_PRICE_E6 = BigInt(args["initial-price"]);
const LP_COLLATERAL = BigInt(args["lp-collateral"]);
const INSURANCE_AMOUNT = BigInt(args.insurance);
const ORACLE_FEED = args["oracle-feed"] ?? "0".repeat(64); // all zeros = admin oracle
const INVERT = args.invert ? 1 : 0;
const TRADING_FEE_BPS = BigInt(args["trading-fee-bps"]!);
const INITIAL_MARGIN_BPS = BigInt(args["initial-margin-bps"]!);
const IS_ADMIN_ORACLE = ORACLE_FEED === "0".repeat(64);

// ============================================================================
// CONSTANTS
// ============================================================================

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24");
const SLAB_SIZE = 992_560;
const PRIORITY_FEE = 50_000;

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

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("PERCOLATOR - CREATE NEW MARKET");
  console.log("=".repeat(70));

  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL not set in .env");

  const keypairPath = process.env.ADMIN_KEYPAIR_PATH || "./admin-keypair.json";
  const payer = loadKeypair(keypairPath);
  const connection = new Connection(rpcUrl, "confirmed");

  console.log(`\nRPC: ${rpcUrl.replace(/api-key=.*/, "api-key=***")}`);
  console.log(`Admin: ${payer.publicKey.toBase58()}`);
  console.log(`Mint: ${MINT.toBase58()}`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  if (IS_ADMIN_ORACLE) {
    console.log(`Oracle: Admin (permissioned push)`);
  } else {
    const [pythPDA] = derivePythPushOraclePDA(ORACLE_FEED);
    console.log(`Oracle: Pyth Push Oracle`);
    console.log(`  Feed ID: ${ORACLE_FEED}`);
    console.log(`  Push Oracle PDA: ${pythPDA.toBase58()}`);
  }
  console.log(`Inverted: ${INVERT ? "Yes" : "No"}`);
  console.log(`Trading Fee: ${TRADING_FEE_BPS} bps`);
  console.log(`Initial Margin: ${INITIAL_MARGIN_BPS} bps`);
  console.log(`Initial Price (e6): ${INITIAL_PRICE_E6}`);

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL\n`);

  // ========================================================================
  // TX 1: Create slab account + vault ATA + InitMarket
  // ========================================================================
  console.log("Step 1: Creating slab account + InitMarket...");

  const slabKp = Keypair.generate();
  const slabRent = await connection.getMinimumBalanceForRentExemption(SLAB_SIZE);
  console.log(`  Slab: ${slabKp.publicKey.toBase58()}`);
  console.log(`  Rent: ${(slabRent / 1e9).toFixed(4)} SOL`);

  // Create slab account (separate tx due to size limits)
  const createSlabTx = new Transaction();
  addPriorityFee(createSlabTx);
  createSlabTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
  createSlabTx.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: slabKp.publicKey,
      lamports: slabRent,
      space: SLAB_SIZE,
      programId: PROGRAM_ID,
    }),
  );
  await sendAndConfirmTransaction(connection, createSlabTx, [payer, slabKp], {
    commitment: "confirmed",
  });
  console.log("  Slab account created");

  // Derive vault PDA and create vault ATA
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slabKp.publicKey);
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
    maintenanceMarginBps: (INITIAL_MARGIN_BPS / 2n).toString(), // MM = half IM
    initialMarginBps: INITIAL_MARGIN_BPS.toString(),
    tradingFeeBps: TRADING_FEE_BPS.toString(),
    maxAccounts: "4096",
    newAccountFee: "1000000", // 1 token (assuming 6 decimals)
    riskReductionThreshold: "0",
    maintenanceFeePerSlot: "0",
    maxCrankStalenessSlots: "100",
    liquidationFeeBps: "100", // 1%
    liquidationFeeCap: "0",
    liquidationBufferBps: "50",
    minLiquidationAbs: "0",
  });

  const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
    payer.publicKey,
    slabKp.publicKey,
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
  await sendAndConfirmTransaction(connection, initMarketTx, [payer], { commitment: "confirmed" });
  console.log("  Market initialized");

  // ========================================================================
  // TX 2: InitLP (passive) + DepositCollateral + TopUpInsurance
  // ========================================================================
  console.log("\nStep 2: Setting up LP + Insurance...");

  // InitLP with SystemProgram as passive matcher (no CPI matcher needed)
  const initLpData = encodeInitLP({
    matcherProgram: SystemProgram.programId,
    matcherContext: SystemProgram.programId,
    feePayment: "0",
  });
  const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [
    payer.publicKey,
    slabKp.publicKey,
    adminAta.address,
    vault,
    TOKEN_PROGRAM_ID,
  ]);

  const initLpTx = new Transaction();
  addPriorityFee(initLpTx);
  initLpTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
  initLpTx.add(buildIx({ programId: PROGRAM_ID, keys: initLpKeys, data: initLpData }));
  await sendAndConfirmTransaction(connection, initLpTx, [payer], { commitment: "confirmed" });
  console.log("  LP initialized at index 0");

  // Deposit collateral to LP
  const depositData = encodeDepositCollateral({
    userIdx: 0,
    amount: LP_COLLATERAL.toString(),
  });
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    payer.publicKey,
    slabKp.publicKey,
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
  console.log(`  Deposited ${LP_COLLATERAL} to LP`);

  // Top up insurance fund
  const topupData = encodeTopUpInsurance({ amount: INSURANCE_AMOUNT.toString() });
  const topupKeys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
    payer.publicKey,
    slabKp.publicKey,
    adminAta.address,
    vault,
    TOKEN_PROGRAM_ID,
  ]);

  const topupTx = new Transaction();
  addPriorityFee(topupTx);
  topupTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
  topupTx.add(buildIx({ programId: PROGRAM_ID, keys: topupKeys, data: topupData }));
  await sendAndConfirmTransaction(connection, topupTx, [payer], { commitment: "confirmed" });
  console.log(`  Insurance topped up: ${INSURANCE_AMOUNT}`);

  // ========================================================================
  // TX 3: Oracle setup + initial crank
  // ========================================================================
  if (IS_ADMIN_ORACLE) {
    console.log("\nStep 3: Setting up admin oracle...");

    // Set oracle authority
    const setAuthData = encodeSetOracleAuthority({ newAuthority: payer.publicKey });
    const setAuthKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
      payer.publicKey,
      slabKp.publicKey,
    ]);

    const setAuthTx = new Transaction();
    addPriorityFee(setAuthTx);
    setAuthTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    setAuthTx.add(buildIx({ programId: PROGRAM_ID, keys: setAuthKeys, data: setAuthData }));
    await sendAndConfirmTransaction(connection, setAuthTx, [payer], { commitment: "confirmed" });
    console.log("  Oracle authority set");

    // Push initial price + crank
    const now = Math.floor(Date.now() / 1000);
    const pushData = encodePushOraclePrice({
      priceE6: INITIAL_PRICE_E6.toString(),
      timestamp: now.toString(),
    });
    const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
      payer.publicKey,
      slabKp.publicKey,
    ]);

    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey,
      slabKp.publicKey,
      SYSVAR_CLOCK_PUBKEY,
      slabKp.publicKey, // admin oracle: oracle account = slab
    ]);

    const pushCrankTx = new Transaction();
    addPriorityFee(pushCrankTx);
    pushCrankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }));
    pushCrankTx.add(buildIx({ programId: PROGRAM_ID, keys: pushKeys, data: pushData }));
    pushCrankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
    await sendAndConfirmTransaction(connection, pushCrankTx, [payer], {
      commitment: "confirmed",
      skipPreflight: true,
    });
    console.log(`  Initial price pushed: ${INITIAL_PRICE_E6} (e6)`);
  } else {
    console.log("\nStep 3: Initial crank with Pyth oracle...");

    // Derive the Pyth Push Oracle PDA from the feed ID
    const [pythPDA] = derivePythPushOraclePDA(ORACLE_FEED);
    console.log(`  Pyth Push Oracle PDA: ${pythPDA.toBase58()}`);

    // Verify the Pyth account exists on-chain
    const pythInfo = await connection.getAccountInfo(pythPDA);
    if (!pythInfo) {
      console.warn("  WARNING: Pyth Push Oracle account not found on-chain.");
      console.warn("  The crank will fail until this feed is active. Skipping initial crank.");
    } else {
      console.log(`  Pyth account found (${pythInfo.data.length} bytes, owner: ${pythInfo.owner.toBase58().slice(0, 12)}...)`);

      // Crank with Pyth oracle - the program reads the price directly
      const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
      const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
        payer.publicKey,
        slabKp.publicKey,
        SYSVAR_CLOCK_PUBKEY,
        pythPDA, // Pyth Push Oracle PriceUpdateV2 account
      ]);

      const crankTx = new Transaction();
      addPriorityFee(crankTx);
      crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }));
      crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
      await sendAndConfirmTransaction(connection, crankTx, [payer], {
        commitment: "confirmed",
        skipPreflight: true,
      });
      console.log("  Initial crank with Pyth oracle succeeded");
    }
  }

  // ========================================================================
  // Save market info
  // ========================================================================
  const mintShort = MINT.toBase58().slice(0, 8);
  const outPath = `${mintShort}-market.json`;

  const pythPDA = IS_ADMIN_ORACLE ? null : derivePythPushOraclePDA(ORACLE_FEED)[0].toBase58();

  const marketInfo = {
    network: "mainnet",
    createdAt: new Date().toISOString(),
    programId: PROGRAM_ID.toBase58(),
    slab: slabKp.publicKey.toBase58(),
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
  console.log(`\nMarket info saved to ${outPath}`);

  console.log("\n" + "=".repeat(70));
  console.log("MARKET CREATED SUCCESSFULLY");
  console.log("=".repeat(70));
  console.log(`\n  Slab: ${slabKp.publicKey.toBase58()}`);
  console.log(`  Mint: ${MINT.toBase58()}`);
  console.log(`  Oracle: ${IS_ADMIN_ORACLE ? "Admin" : "Pyth"}`);
  console.log(`  Output: ${outPath}\n`);
}

main().catch(console.error);
