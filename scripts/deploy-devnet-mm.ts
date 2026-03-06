#!/usr/bin/env npx tsx
/**
 * PERC-370: Deploy devnet market-making bots
 *
 * Phase 1: Create Small-tier markets (SOL-PERP, BTC-PERP) on devnet
 * Phase 2: Fund keeper wallets with test tokens
 * Phase 3: Output config for floating-maker bot
 *
 * Usage:
 *   npx tsx scripts/deploy-devnet-mm.ts
 *
 * Prerequisites:
 *   - Admin keypair at ~/.config/solana/percolator-upgrade-authority.json
 *   - Keeper wallets at /tmp/percolator-keepers/
 *   - ~2 SOL on admin keypair (for slab rent + tx fees)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddress,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";

import {
  encodeInitMarket,
  encodeInitLP,
  encodeInitUser,
  encodeDepositCollateral,
  encodeTopUpInsurance,
  encodeKeeperCrank,
  encodeSetOracleAuthority,
  encodePushOraclePrice,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  buildAccountMetas,
  buildIx,
  WELL_KNOWN,
  deriveVaultAuthority,
  deriveLpPda,
  SLAB_TIERS,
} from "../packages/core/src/index.js";

// ═══════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════

const HELIUS_KEY = process.env.HELIUS_DEVNET_API_KEY ?? process.env.HELIUS_API_KEY ?? "";
const RPC_URL = process.env.RPC_URL ??
  (HELIUS_KEY ? `https://devnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : "https://api.devnet.solana.com");

// Small-tier program (compiled with MAX_ACCOUNTS=256)
const SMALL_PROGRAM_ID = new PublicKey("FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn");
const MATCHER_PROGRAM_ID = new PublicKey("GTRgyTDfrMvBubALAqtHuQwT8tbGyXid7svXZKtWfC9k");
const MATCHER_CTX_SIZE = 320;

const ADMIN_KP_PATH = process.env.ADMIN_KEYPAIR_PATH ??
  `${process.env.HOME}/.config/solana/percolator-upgrade-authority.json`;
const KEEPER_DIR = process.env.KEEPER_WALLETS_DIR ?? "/tmp/percolator-keepers";

// Markets to create
const MARKETS = [
  { symbol: "SOL", priceE6: 130_000_000n, label: "SOL-PERP" },    // $130
  { symbol: "BTC", priceE6: 85_000_000_000n, label: "BTC-PERP" },  // $85,000
];

// Token amounts (6 decimals — USDC-like)
const DECIMALS = 6;
const LP_COLLATERAL = 50_000_000_000n;    // 50,000 USDC
const INSURANCE_AMOUNT = 10_000_000_000n; // 10,000 USDC
const KEEPER_MINT_AMOUNT = 10_000_000_000n; // 10,000 USDC per keeper
const VAULT_SEED = 1_000_000_000n;        // 1000 USDC seed for vault (min 500M native units)

const conn = new Connection(RPC_URL, "confirmed");

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function loadKp(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function log(phase: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${phase}] ${msg}`);
}

async function send(tx: Transaction, signers: Keypair[], label: string): Promise<string> {
  tx.feePayer = signers[0].publicKey;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, signers, {
      commitment: "confirmed",
      skipPreflight: false,
    });
    log("tx", `✅ ${label} → ${sig.slice(0, 16)}...`);
    return sig;
  } catch (e: any) {
    // Extract logs from SendTransactionError
    let errMsg = "";
    if (e?.logs && Array.isArray(e.logs)) {
      errMsg = e.logs.join("\n");
    } else if (e?.message) {
      errMsg = e.message;
    } else {
      errMsg = JSON.stringify(e, null, 2);
    }
    log("tx", `❌ ${label} FAILED:\n${errMsg}`);
    throw new Error(`${label}: ${errMsg.slice(0, 200)}`);
  }
}

async function sleep(ms: number) {
  await new Promise(r => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════
// Phase 1: Create token mint
// ═══════════════════════════════════════════════════════════════

async function createMint(admin: Keypair): Promise<PublicKey> {
  log("mint", "Creating test USDC mint (6 decimals)...");
  const mintKp = Keypair.generate();
  const mintRent = await getMinimumBalanceForRentExemptMint(conn);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: mintKp.publicKey,
      lamports: mintRent,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mintKp.publicKey, DECIMALS, admin.publicKey, admin.publicKey),
  );
  await send(tx, [admin, mintKp], `Create mint: ${mintKp.publicKey.toBase58().slice(0, 12)}...`);

  // Create admin ATA + mint tokens
  const adminAta = await getAssociatedTokenAddress(mintKp.publicKey, admin.publicKey);
  const totalMint = LP_COLLATERAL * 2n + INSURANCE_AMOUNT * 2n + KEEPER_MINT_AMOUNT * 5n + VAULT_SEED * 10n;
  const mintTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    createAssociatedTokenAccountInstruction(admin.publicKey, adminAta, admin.publicKey, mintKp.publicKey),
    createMintToInstruction(mintKp.publicKey, adminAta, admin.publicKey, totalMint),
  );
  await send(mintTx, [admin], `Mint ${Number(totalMint) / 1e6} tokens to admin`);

  // Save mint info
  fs.writeFileSync("/tmp/percolator-test-usdc.json", JSON.stringify({
    mint: mintKp.publicKey.toBase58(),
    secretKey: Array.from(mintKp.secretKey),
    decimals: DECIMALS,
    adminAta: adminAta.toBase58(),
  }));

  log("mint", `✅ Mint: ${mintKp.publicKey.toBase58()}`);
  return mintKp.publicKey;
}

// ═══════════════════════════════════════════════════════════════
// Phase 2: Create markets
// ═══════════════════════════════════════════════════════════════

interface CreatedMarket {
  symbol: string;
  label: string;
  slab: string;
  mint: string;
  vault: string;
  matcherCtx: string;
  priceE6: string;
}

async function createMarket(
  admin: Keypair,
  mint: PublicKey,
  marketDef: typeof MARKETS[0],
): Promise<CreatedMarket> {
  const tier = SLAB_TIERS.small;
  const programId = SMALL_PROGRAM_ID;

  log("market", `Creating ${marketDef.label} (Small tier, ${tier.dataSize} bytes)...`);

  // 1. Create slab account
  const slabKp = Keypair.generate();
  const slabRent = await conn.getMinimumBalanceForRentExemption(tier.dataSize);
  log("market", `Slab rent: ${(slabRent / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const createSlabTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: slabKp.publicKey,
      lamports: slabRent,
      space: tier.dataSize,
      programId,
    }),
  );
  await send(createSlabTx, [admin, slabKp], `Create slab for ${marketDef.label}`);
  await sleep(500);

  // 2. Create vault ATA
  const [vaultPda] = deriveVaultAuthority(programId, slabKp.publicKey);
  const vaultAta = await getAssociatedTokenAddress(mint, vaultPda, true);
  const createVaultTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    createAssociatedTokenAccountInstruction(admin.publicKey, vaultAta, vaultPda, mint),
  );
  await send(createVaultTx, [admin], `Create vault ATA`);
  await sleep(500);

  // 3. Seed vault (program requires min balance before InitMarket)
  const adminAta = await getAssociatedTokenAddress(mint, admin.publicKey);
  const { createTransferInstruction: xfer } = await import("@solana/spl-token");
  const seedTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    xfer(adminAta, vaultAta, admin.publicKey, VAULT_SEED),
  );
  await send(seedTx, [admin], `Seed vault`);
  await sleep(500);

  // 4. InitMarket (Hyperp / admin oracle mode)
  const initMarketData = encodeInitMarket({
    admin: admin.publicKey,
    collateralMint: mint,
    indexFeedId: "0".repeat(64),  // Hyperp mode
    maxStalenessSecs: "120",
    confFilterBps: 0,
    invert: 0,
    unitScale: 0,
    initialMarkPriceE6: marketDef.priceE6.toString(),
    warmupPeriodSlots: "0",
    maintenanceMarginBps: "500",    // 5% maintenance margin
    initialMarginBps: "1000",       // 10% initial margin
    tradingFeeBps: "30",            // 0.30% trading fee
    maxAccounts: tier.maxAccounts.toString(),
    newAccountFee: "1000000",       // 1 USDC
    riskReductionThreshold: "0",
    maintenanceFeePerSlot: "0",
    maxCrankStalenessSlots: "200",
    liquidationFeeBps: "100",       // 1%
    liquidationFeeCap: "0",
    liquidationBufferBps: "50",
    minLiquidationAbs: "0",
  });
  const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
    admin.publicKey, slabKp.publicKey, mint, vaultAta,
    WELL_KNOWN.tokenProgram, WELL_KNOWN.clock, WELL_KNOWN.rent,
    vaultPda, WELL_KNOWN.systemProgram,
  ]);
  const initMarketTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    buildIx({ programId, keys: initMarketKeys, data: initMarketData }),
  );
  await send(initMarketTx, [admin], `InitMarket ${marketDef.label}`);
  await sleep(500);

  // 5. Create matcher context + InitLP
  const matcherCtxKp = Keypair.generate();
  const matcherRent = await conn.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);
  const createMatcherTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: matcherCtxKp.publicKey,
      lamports: matcherRent,
      space: MATCHER_CTX_SIZE,
      programId: MATCHER_PROGRAM_ID,
    }),
  );
  await send(createMatcherTx, [admin, matcherCtxKp], `Create matcher ctx`);
  await sleep(500);

  const initLpData = encodeInitLP({
    matcherProgram: MATCHER_PROGRAM_ID,
    matcherContext: matcherCtxKp.publicKey,
    feePayment: "1000000",
  });
  const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [
    admin.publicKey, slabKp.publicKey, adminAta, vaultAta, WELL_KNOWN.tokenProgram,
  ]);
  const initLpTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    buildIx({ programId, keys: initLpKeys, data: initLpData }),
  );
  await send(initLpTx, [admin], `InitLP`);
  await sleep(500);

  // 6. Deposit LP collateral + insurance
  const depositData = encodeDepositCollateral({ userIdx: 0, amount: LP_COLLATERAL.toString() });
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    admin.publicKey, slabKp.publicKey, adminAta, vaultAta, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
  ]);
  const topupData = encodeTopUpInsurance({ amount: INSURANCE_AMOUNT.toString() });
  const topupKeys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
    admin.publicKey, slabKp.publicKey, adminAta, vaultAta, WELL_KNOWN.tokenProgram,
  ]);
  const depositTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    buildIx({ programId, keys: depositKeys, data: depositData }),
    buildIx({ programId, keys: topupKeys, data: topupData }),
  );
  await send(depositTx, [admin], `Deposit LP $${Number(LP_COLLATERAL) / 1e6} + Insurance $${Number(INSURANCE_AMOUNT) / 1e6}`);
  await sleep(500);

  // 7. Set oracle authority + push initial price + crank
  const setAuthData = encodeSetOracleAuthority({ newAuthority: admin.publicKey });
  const setAuthKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [admin.publicKey, slabKp.publicKey]);

  const now = Math.floor(Date.now() / 1000);
  const pushData = encodePushOraclePrice({ priceE6: marketDef.priceE6.toString(), timestamp: now.toString() });
  const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [admin.publicKey, slabKp.publicKey]);

  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    admin.publicKey, slabKp.publicKey, WELL_KNOWN.clock, slabKp.publicKey,
  ]);

  const oracleTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    buildIx({ programId, keys: setAuthKeys, data: setAuthData }),
    buildIx({ programId, keys: pushKeys, data: pushData }),
    buildIx({ programId, keys: crankKeys, data: crankData }),
  );
  await send(oracleTx, [admin], `Oracle setup + push $${Number(marketDef.priceE6) / 1e6} + crank`);

  log("market", `✅ ${marketDef.label} created at ${slabKp.publicKey.toBase58()}`);

  return {
    symbol: marketDef.symbol,
    label: marketDef.label,
    slab: slabKp.publicKey.toBase58(),
    mint: mint.toBase58(),
    vault: vaultAta.toBase58(),
    matcherCtx: matcherCtxKp.publicKey.toBase58(),
    priceE6: marketDef.priceE6.toString(),
  };
}

// ═══════════════════════════════════════════════════════════════
// Phase 3: Fund keeper wallets
// ═══════════════════════════════════════════════════════════════

async function fundKeepers(admin: Keypair, mint: PublicKey): Promise<void> {
  const keeperFiles = ["keeper-wide.json", "keeper-tight_a.json", "keeper-tight_b.json"];
  const adminAta = await getAssociatedTokenAddress(mint, admin.publicKey);

  // Read mint keypair for minting authority
  const mintInfo = JSON.parse(fs.readFileSync("/tmp/percolator-test-usdc.json", "utf8"));
  const mintKp = Keypair.fromSecretKey(Uint8Array.from(mintInfo.secretKey));

  for (const file of keeperFiles) {
    const path = `${KEEPER_DIR}/${file}`;
    if (!fs.existsSync(path)) {
      log("fund", `⚠️ Keeper wallet not found: ${path}`);
      continue;
    }
    const kp = loadKp(path);
    const name = file.replace("keeper-", "").replace(".json", "").toUpperCase();
    log("fund", `Funding ${name} (${kp.publicKey.toBase58().slice(0, 12)}...)...`);

    // Create ATA for keeper
    const keeperAta = await getAssociatedTokenAddress(mint, kp.publicKey);

    // Create ATA + mint tokens in one tx
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      createAssociatedTokenAccountInstruction(admin.publicKey, keeperAta, kp.publicKey, mint),
      createMintToInstruction(mint, keeperAta, admin.publicKey, KEEPER_MINT_AMOUNT),
    );
    await send(tx, [admin], `Fund ${name}: $${Number(KEEPER_MINT_AMOUNT) / 1e6} USDC`);
    await sleep(500);
  }
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  PERC-370: Deploy Devnet Market-Making Infrastructure    ║
╚══════════════════════════════════════════════════════════╝
`);

  // Load admin keypair
  if (!fs.existsSync(ADMIN_KP_PATH)) {
    console.error(`❌ Admin keypair not found at ${ADMIN_KP_PATH}`);
    process.exit(1);
  }
  const admin = loadKp(ADMIN_KP_PATH);
  log("init", `Admin: ${admin.publicKey.toBase58()}`);
  log("init", `RPC: ${RPC_URL.replace(/api-key=.*/, "api-key=***")}`);

  const adminBal = await conn.getBalance(admin.publicKey);
  log("init", `Admin balance: ${(adminBal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  if (adminBal < 1 * LAMPORTS_PER_SOL) {
    log("init", "⚠️ Admin needs at least 1 SOL. Requesting airdrop...");
    try {
      const sig = await conn.requestAirdrop(admin.publicKey, 2 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
      log("init", "✅ Airdrop received");
    } catch (e: any) {
      log("init", `❌ Airdrop failed: ${e.message?.slice(0, 80)}`);
    }
  }

  log("init", `Small program: ${SMALL_PROGRAM_ID.toBase58()}`);
  log("init", `Matcher program: ${MATCHER_PROGRAM_ID.toBase58()}`);

  // Verify programs exist
  const progInfo = await conn.getAccountInfo(SMALL_PROGRAM_ID);
  if (!progInfo?.executable) {
    console.error("❌ Small-tier program not deployed on devnet!");
    process.exit(1);
  }
  const matcherInfo = await conn.getAccountInfo(MATCHER_PROGRAM_ID);
  if (!matcherInfo?.executable) {
    console.error("❌ Matcher program not deployed on devnet!");
    process.exit(1);
  }
  log("init", "✅ Programs verified on-chain");

  // Phase 1: Create token mint
  log("phase1", "═══ Phase 1: Create test USDC mint ═══");
  const mint = await createMint(admin);

  // Phase 2: Create markets
  log("phase2", "═══ Phase 2: Create markets ═══");
  const createdMarkets: CreatedMarket[] = [];
  for (const marketDef of MARKETS) {
    try {
      const market = await createMarket(admin, mint, marketDef);
      createdMarkets.push(market);
    } catch (e: any) {
      log("phase2", `❌ Failed to create ${marketDef.label}: ${e.message?.slice(0, 100)}`);
    }
    await sleep(1000);
  }

  if (createdMarkets.length === 0) {
    console.error("❌ No markets created. Exiting.");
    process.exit(1);
  }

  // Phase 3: Fund keeper wallets
  log("phase3", "═══ Phase 3: Fund keeper wallets ═══");
  await fundKeepers(admin, mint);

  // Output summary
  console.log("\n" + "═".repeat(60));
  console.log("DEPLOYMENT SUMMARY");
  console.log("═".repeat(60));
  console.log(`\nMint: ${mint.toBase58()}`);
  console.log(`Program: ${SMALL_PROGRAM_ID.toBase58()} (Small tier)`);
  console.log(`\nMarkets created:`);
  for (const m of createdMarkets) {
    console.log(`  ${m.label}: ${m.slab}`);
    console.log(`    Price: $${Number(BigInt(m.priceE6)) / 1e6}`);
  }

  // Save deployment info
  const deployInfo = {
    deployedAt: new Date().toISOString(),
    network: "devnet",
    programId: SMALL_PROGRAM_ID.toBase58(),
    matcherProgramId: MATCHER_PROGRAM_ID.toBase58(),
    mint: mint.toBase58(),
    markets: createdMarkets,
    keeperWallets: {
      WIDE: "/tmp/percolator-keepers/keeper-wide.json",
      TIGHT_A: "/tmp/percolator-keepers/keeper-tight_a.json",
      TIGHT_B: "/tmp/percolator-keepers/keeper-tight_b.json",
    },
  };
  const outPath = "/tmp/percolator-devnet-deployment.json";
  fs.writeFileSync(outPath, JSON.stringify(deployInfo, null, 2));
  console.log(`\nDeployment info saved to: ${outPath}`);

  // Print floating-maker launch commands
  console.log("\n" + "═".repeat(60));
  console.log("FLOATING MAKER BOT COMMANDS");
  console.log("═".repeat(60));
  const keeperProfiles = [
    { name: "WIDE", file: "keeper-wide.json", spreadBps: 50 },
    { name: "TIGHT_A", file: "keeper-tight_a.json", spreadBps: 15 },
    { name: "TIGHT_B", file: "keeper-tight_b.json", spreadBps: 20 },
  ];
  for (const profile of keeperProfiles) {
    console.log(`\n# ${profile.name} (spread: ${profile.spreadBps}bps)`);
    console.log(`BOOTSTRAP_KEYPAIR=/tmp/percolator-keepers/${profile.file} \\`);
    console.log(`  PROGRAM_ID=${SMALL_PROGRAM_ID.toBase58()} \\`);
    console.log(`  SPREAD_BPS=${profile.spreadBps} \\`);
    console.log(`  MAX_QUOTE_SIZE_USDC=500 \\`);
    console.log(`  QUOTE_INTERVAL_MS=5000 \\`);
    console.log(`  npx tsx scripts/floating-maker.ts`);
  }

  console.log("\n" + "═".repeat(60));
  console.log("✅ Deployment complete! Markets ready for market-making.");
  console.log("═".repeat(60) + "\n");
}

main().catch((e) => {
  console.error("\n💀 Fatal error:", e.message || e);
  if (e.logs) console.error("Program logs:", e.logs.join("\n"));
  process.exit(1);
});
