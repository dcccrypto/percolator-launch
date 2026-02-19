/**
 * Percolator Risk Engine Simulator — Phase 1 Deploy Script
 *
 * Creates simUSDC mint and 3 simulation markets (SOL/USD, BTC/USD, ETH/USD)
 * using admin oracle mode (no Pyth — prices pushed manually).
 *
 * Usage:
 *   npx tsx scripts/deploy-sim.ts
 *
 * Env:
 *   RPC_URL            — Solana RPC endpoint (devnet)
 *   ADMIN_KEYPAIR_PATH — Path to admin keypair JSON (default: .keys/deployer.json)
 *
 * Output: config/sim-markets.json
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMintInstruction,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import {
  encodeInitMarket,
  encodeInitLP,
  encodeDepositCollateral,
  encodeTopUpInsurance,
  encodeKeeperCrank,
  encodeSetOracleAuthority,
  encodePushOraclePrice,
  encodeInitVamm,
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
import { deriveVaultAuthority, deriveLpPda } from "../packages/core/src/solana/pda.js";
import { buildIx } from "../packages/core/src/runtime/tx.js";

dotenv.config();

// ============================================================================
// CONSTANTS
// ============================================================================

// Sim program: test-build with MAX_ACCOUNTS=64 (small slabs, ~0.44 SOL rent each)
const PROGRAM_ID = new PublicKey("DxoMuuiUy5TymJRwALizxb5X8GwnQB7pUv1x2z3oLjDJ");
const MATCHER_PROGRAM_ID = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");
const SLAB_SIZE = 16_320; // MAX_ACCOUNTS=64 test build (0x3fc0)
const MATCHER_CTX_SIZE = 320;
const PRIORITY_FEE = 50_000;

// simUSDC: 6 decimals
const SIM_USDC_DECIMALS = 6;
// Initial LP + insurance per market (100,000 simUSDC each)
const LP_COLLATERAL = BigInt(100_000_000_000); // 100,000 simUSDC (6 dec)
const INSURANCE_AMOUNT = BigInt(100_000_000_000); // 100,000 simUSDC (6 dec)
// Mint 1M simUSDC to admin to fund all 3 markets
const ADMIN_MINT_AMOUNT = BigInt(1_000_000_000_000); // 1,000,000 simUSDC (6 dec)

const MARKETS = [
  {
    key: "SOL/USD",
    name: "SIM-SOL/USD",
    initialPriceE6: BigInt(180_000_000), // $180
    tradingFeeBps: BigInt(10),
    initialMarginBps: BigInt(500), // 20x max
  },
  {
    key: "BTC/USD",
    name: "SIM-BTC/USD",
    initialPriceE6: BigInt(95_000_000_000), // $95,000 — wait, e6 is $95_000 * 1e6 = 95_000_000_000
    tradingFeeBps: BigInt(10),
    initialMarginBps: BigInt(500), // 20x max
  },
  {
    key: "ETH/USD",
    name: "SIM-ETH/USD",
    initialPriceE6: BigInt(3_200_000_000), // $3,200
    tradingFeeBps: BigInt(10),
    initialMarginBps: BigInt(500), // 20x max
  },
];

// ============================================================================
// HELPERS
// ============================================================================

function loadKeypair(filePath: string): Keypair {
  const resolved = filePath.startsWith("~/")
    ? filePath.replace("~", process.env.HOME || "")
    : filePath;
  const raw = fs.readFileSync(resolved, "utf-8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function addPriorityFee(tx: Transaction): void {
  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// STEP 1: Create simUSDC Mint
// ============================================================================

async function createSimUSDCMint(
  connection: Connection,
  payer: Keypair,
): Promise<PublicKey> {
  console.log("\n─── Step 1: Creating simUSDC SPL token mint ───");

  const mint = await createMint(
    connection,
    payer,
    payer.publicKey, // mint authority
    payer.publicKey, // freeze authority
    SIM_USDC_DECIMALS,
  );

  console.log(`  simUSDC mint: ${mint.toBase58()}`);

  // Mint initial supply to admin
  const adminAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    payer.publicKey,
  );

  const sig = await mintTo(
    connection,
    payer,
    mint,
    adminAta.address,
    payer,
    ADMIN_MINT_AMOUNT,
  );
  console.log(`  Minted ${Number(ADMIN_MINT_AMOUNT) / 1e6} simUSDC to admin`);
  console.log(`  Sig: ${sig}`);

  return mint;
}

// ============================================================================
// STEP 2: Create a Single Simulation Market
// ============================================================================

async function createSimMarket(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  market: (typeof MARKETS)[0],
): Promise<string> {
  console.log(`\n─── Creating market: ${market.name} ───`);

  // ── Slab account ──
  const slabKp = Keypair.generate();
  const slabRent = await connection.getMinimumBalanceForRentExemption(SLAB_SIZE);
  console.log(`  Slab: ${slabKp.publicKey.toBase58()}`);

  const createSlabTx = new Transaction();
  addPriorityFee(createSlabTx);
  createSlabTx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
  );
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
  console.log("  Slab created");

  // ── Vault PDA + ATA ──
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slabKp.publicKey);
  const vaultAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    vaultPda,
    true, // allowOwnerOffCurve
  );
  const vault = vaultAccount.address;
  console.log(`  Vault PDA: ${vaultPda.toBase58()}`);
  console.log(`  Vault ATA: ${vault.toBase58()}`);

  const adminAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    payer.publicKey,
  );

  // ── InitMarket ──
  const initMarketData = encodeInitMarket({
    admin: payer.publicKey,
    collateralMint: mint,
    indexFeedId: "0100000000000000000000000000000000000000000000000000000000000000", // non-zero to disable hyperp mode; prices pushed via admin oracle
    maxStalenessSecs: "86400",  // 24h — lenient for sim (oracle may go down)
    confFilterBps: 0,
    invert: 0,
    unitScale: 0,
    initialMarkPriceE6: market.initialPriceE6.toString(),
    warmupPeriodSlots: "0",
    maintenanceMarginBps: (market.initialMarginBps / 2n).toString(),
    initialMarginBps: market.initialMarginBps.toString(),
    tradingFeeBps: market.tradingFeeBps.toString(),
    maxAccounts: "64",
    newAccountFee: "1000000", // 1 simUSDC
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
    slabKp.publicKey,
    mint,
    vault,
    TOKEN_PROGRAM_ID,
    SYSVAR_CLOCK_PUBKEY,
    SYSVAR_RENT_PUBKEY,
    vault, // dummyAta
    SystemProgram.programId,
  ]);

  const initMarketTx = new Transaction();
  addPriorityFee(initMarketTx);
  initMarketTx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
  );
  initMarketTx.add(
    buildIx({ programId: PROGRAM_ID, keys: initMarketKeys, data: initMarketData }),
  );
  await sendAndConfirmTransaction(connection, initMarketTx, [payer], {
    commitment: "confirmed",
  });
  console.log("  Market initialized");

  // ── Create matcher context account + InitLP with vAMM ──
  const matcherCtxKp = Keypair.generate();
  const matcherCtxRent = await connection.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);

  // Derive LP PDA for index 0
  const [lpPda] = deriveLpPda(PROGRAM_ID, slabKp.publicKey, 0);

  // 1. Create matcher context account (owned by matcher program)
  const createCtxIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: matcherCtxKp.publicKey,
    lamports: matcherCtxRent,
    space: MATCHER_CTX_SIZE,
    programId: MATCHER_PROGRAM_ID,
  });

  // 2. Initialize vAMM matcher
  const initVammData = encodeInitVamm({
    mode: 0,
    tradingFeeBps: 30,                    // 0.3% fee
    baseSpreadBps: 20,                    // 0.2% spread
    maxTotalBps: 200,                     // 2% max spread
    impactKBps: 0,                        // no impact
    liquidityNotionalE6: "50000000000000",    // $50M notional
    maxFillAbs: "100000000000000000",        // 100M units — effectively unlimited for sim
    maxInventoryAbs: "0",                    // 0 = unlimited inventory
  });

  const initMatcherIx = new TransactionInstruction({
    programId: MATCHER_PROGRAM_ID,
    keys: [
      { pubkey: lpPda, isSigner: false, isWritable: false },
      { pubkey: matcherCtxKp.publicKey, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(initVammData),
  });

  // 3. InitLP with real matcher program + context
  const initLpData = encodeInitLP({
    matcherProgram: MATCHER_PROGRAM_ID,
    matcherContext: matcherCtxKp.publicKey,
    feePayment: "2000000", // 2 simUSDC (required LP init fee)
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
  initLpTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  initLpTx.add(createCtxIx);
  initLpTx.add(initMatcherIx);
  initLpTx.add(
    buildIx({ programId: PROGRAM_ID, keys: initLpKeys, data: initLpData }),
  );
  await sendAndConfirmTransaction(connection, initLpTx, [payer, matcherCtxKp], {
    commitment: "confirmed",
  });
  console.log("  LP initialized with vAMM matcher (index 0)");
  console.log(`  Matcher context: ${matcherCtxKp.publicKey.toBase58()}`);

  // ── DepositCollateral (LP funding) ──
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
  depositTx.add(
    buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData }),
  );
  await sendAndConfirmTransaction(connection, depositTx, [payer], {
    commitment: "confirmed",
  });
  console.log(`  LP funded: ${Number(LP_COLLATERAL) / 1e6} simUSDC`);

  // ── TopUpInsurance ──
  const topupData = encodeTopUpInsurance({
    amount: INSURANCE_AMOUNT.toString(),
  });
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
  topupTx.add(
    buildIx({ programId: PROGRAM_ID, keys: topupKeys, data: topupData }),
  );
  await sendAndConfirmTransaction(connection, topupTx, [payer], {
    commitment: "confirmed",
  });
  console.log(`  Insurance funded: ${Number(INSURANCE_AMOUNT) / 1e6} simUSDC`);

  // ── SetOracleAuthority ──
  const setAuthData = encodeSetOracleAuthority({
    newAuthority: payer.publicKey,
  });
  const setAuthKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
    payer.publicKey,
    slabKp.publicKey,
  ]);

  const setAuthTx = new Transaction();
  addPriorityFee(setAuthTx);
  setAuthTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
  setAuthTx.add(
    buildIx({ programId: PROGRAM_ID, keys: setAuthKeys, data: setAuthData }),
  );
  await sendAndConfirmTransaction(connection, setAuthTx, [payer], {
    commitment: "confirmed",
  });
  console.log("  Oracle authority set to admin");

  // ── PushOraclePrice + KeeperCrank (initial) ──
  const now = Math.floor(Date.now() / 1000);
  const pushData = encodePushOraclePrice({
    priceE6: market.initialPriceE6.toString(),
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
  pushCrankTx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
  );
  pushCrankTx.add(
    buildIx({ programId: PROGRAM_ID, keys: pushKeys, data: pushData }),
  );
  pushCrankTx.add(
    buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }),
  );
  // Retry push+crank up to 3 times (devnet can be flaky)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      pushCrankTx.recentBlockhash = blockhash;
      pushCrankTx.feePayer = payer.publicKey;
      await sendAndConfirmTransaction(connection, pushCrankTx, [payer], {
        commitment: "confirmed",
        skipPreflight: true,
      });
      console.log(
        `  Initial price pushed: ${Number(market.initialPriceE6) / 1e6} USD`,
      );
      break;
    } catch (e) {
      console.warn(`  Push+crank attempt ${attempt + 1} failed: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
      if (attempt === 2) {
        console.warn("  ⚠ Skipping initial crank — oracle service will crank on startup");
      } else {
        await sleep(3000);
      }
    }
  }

  return slabKp.publicKey.toBase58();
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("PERCOLATOR RISK ENGINE SIMULATOR — PHASE 1 DEPLOY");
  console.log("=".repeat(70));

  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL env var not set");

  const keypairPath =
    process.env.ADMIN_KEYPAIR_PATH ||
    path.resolve(process.cwd(), ".keys/deployer.json");
  const payer = loadKeypair(keypairPath);
  const connection = new Connection(rpcUrl, "confirmed");

  console.log(`\nRPC:    ${rpcUrl.replace(/api-key=.*/, "api-key=***")}`);
  console.log(`Admin:  ${payer.publicKey.toBase58()}`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`Matcher: ${MATCHER_PROGRAM_ID.toBase58()}`);

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);

  if (balance < 2e9) {
    console.warn(
      "\n⚠  Warning: Low SOL balance. You may need at least 2 SOL for rent + fees.",
    );
  }

  // Step 1: simUSDC mint
  const simUsdcMint = await createSimUSDCMint(connection, payer);

  // Step 2–4: Create each market
  const slabAddresses: Record<string, string> = {};

  for (const market of MARKETS) {
    await sleep(2000); // small delay between markets
    const slab = await createSimMarket(connection, payer, simUsdcMint, market);
    slabAddresses[market.key] = slab;
    console.log(`  ✓ ${market.name}: ${slab}`);
  }

  // ── Save config ──
  const configDir = path.resolve(process.cwd(), "config");
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

  const configPath = path.join(configDir, "sim-markets.json");
  const config = {
    network: "devnet",
    deployedAt: new Date().toISOString(),
    admin: payer.publicKey.toBase58(),
    programId: PROGRAM_ID.toBase58(),
    matcherProgramId: MATCHER_PROGRAM_ID.toBase58(),
    simUSDC: {
      mint: simUsdcMint.toBase58(),
      decimals: SIM_USDC_DECIMALS,
    },
    markets: {
      "SOL/USD": {
        slab: slabAddresses["SOL/USD"],
        name: "SIM-SOL/USD",
        initialPriceUsd: 180,
        oracleMode: "admin",
      },
      "BTC/USD": {
        slab: slabAddresses["BTC/USD"],
        name: "SIM-BTC/USD",
        initialPriceUsd: 95000,
        oracleMode: "admin",
      },
      "ETH/USD": {
        slab: slabAddresses["ETH/USD"],
        name: "SIM-ETH/USD",
        initialPriceUsd: 3200,
        oracleMode: "admin",
      },
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`\nConfig saved → ${configPath}`);

  // Auto-sync to app/config so the frontend reads the same addresses
  const appConfigPath = path.resolve(__dirname, "../app/config/sim-markets.json");
  fs.writeFileSync(appConfigPath, JSON.stringify(config, null, 2));
  console.log(`Config synced → ${appConfigPath}`);

  // ── Summary ──
  console.log("\n" + "=".repeat(70));
  console.log("DEPLOY COMPLETE ✓");
  console.log("=".repeat(70));
  console.log(`\n  simUSDC mint : ${simUsdcMint.toBase58()}`);
  for (const [key, slab] of Object.entries(slabAddresses)) {
    console.log(`  ${key.padEnd(8)}: ${slab}`);
  }
  console.log(
    "\nNext step: Set SIM_MINT_AUTHORITY in .env.local for the faucet API.\n",
  );
}

main().catch((err) => {
  console.error("\nDeploy failed:", err);
  process.exit(1);
});
