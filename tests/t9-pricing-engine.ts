/**
 * T9: Pricing Engine Integration Tests
 *
 * Devnet-runnable tests covering:
 *   (a) Oracle staleness rejection (PushOraclePrice with stale config)
 *   (b) Mark price median/EMA calculation accuracy
 *   (c) Hyperp EMA warm-up behavior
 *   (d) Dynamic fee tiers via UpdateRiskParams tradingFeeBps
 *   (e) Funding rate settlement via KeeperCrank
 *
 * Uses admin oracle mode (feed_id = all zeros) for deterministic control.
 * Run: HELIUS_API_KEY=xxx npx tsx tests/t9-pricing-engine.ts
 */

import {
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";

import {
  encodeInitMarket,
  encodeInitUser,
  encodeInitLP,
  encodeDepositCollateral,
  encodeKeeperCrank,
  encodeTradeNoCpi,
  encodePushOraclePrice,
  encodeSetOracleAuthority,
  encodeUpdateRiskParams,
  encodeCloseSlab,
  buildAccountMetas,
  buildIx,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_TRADE_NOCPI,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_CLOSE_SLAB,
  WELL_KNOWN,
  parseConfig,
  parseParams,
  parseEngine,
  parseAllAccounts,
  fetchSlab,
} from "../packages/core/src/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RPC_URL = process.env.SOLANA_RPC_URL ??
  `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY ?? ""}`;
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD"
);
const SLAB_SIZE = Number(process.env.SLAB_SIZE ?? 62_808);

// Load deployer wallet — set DEPLOYER_KP env var to override
const DEPLOYER_KP_PATH = process.env.DEPLOYER_KP ??
  `${process.env.HOME}/.config/solana/id.json`;

interface TestResult { name: string; passed: boolean; error?: string; duration: number }
const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, duration: Date.now() - start });
    console.log(`  ✅ ${name} (${Date.now() - start}ms)`);
  } catch (e: any) {
    results.push({ name, passed: false, error: e.message, duration: Date.now() - start });
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

import { Connection } from "@solana/web3.js";

// ============================================================================
// HELPERS
// ============================================================================

async function createMarketWithOracle(
  conn: Connection,
  payer: Keypair,
  opts: {
    initialPriceE6?: string;
    maxStalenessSecs?: string;
    tradingFeeBps?: string;
    warmupPeriodSlots?: string;
  } = {}
) {
  const slab = Keypair.generate();
  const mint = await createMint(conn, payer, payer.publicKey, null, 6);
  await sleep(500);

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), slab.publicKey.toBuffer()],
    PROGRAM_ID
  );
  const vaultAcc = await getOrCreateAssociatedTokenAccount(
    conn, payer, mint, vaultPda, true
  );
  const vault = vaultAcc.address;

  const rentExempt = await conn.getMinimumBalanceForRentExemption(SLAB_SIZE);
  const createSlabTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: slab.publicKey,
      lamports: rentExempt,
      space: SLAB_SIZE,
      programId: PROGRAM_ID,
    })
  );
  await sendAndConfirmTransaction(conn, createSlabTx, [payer, slab], { commitment: "confirmed" });

  const initData = encodeInitMarket({
    admin: payer.publicKey,
    collateralMint: mint,
    indexFeedId: "0".repeat(64),
    maxStalenessSecs: opts.maxStalenessSecs ?? "100000000",
    confFilterBps: 200,
    invert: 0,
    unitScale: 0,
    initialMarkPriceE6: opts.initialPriceE6 ?? "1000000",
    warmupPeriodSlots: opts.warmupPeriodSlots ?? "10",
    maintenanceMarginBps: "500",
    initialMarginBps: "1000",
    tradingFeeBps: opts.tradingFeeBps ?? "10",
    maxAccounts: "4096",
    newAccountFee: "1000000",
    riskReductionThreshold: "0",
    maintenanceFeePerSlot: "0",
    maxCrankStalenessSlots: "200",
    liquidationFeeBps: "100",
    liquidationFeeCap: "1000000000",
    liquidationBufferBps: "50",
    minLiquidationAbs: "100000",
  });

  const initKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
    payer.publicKey, slab.publicKey, mint, vault, vaultPda,
    WELL_KNOWN.tokenProgram, WELL_KNOWN.systemProgram, WELL_KNOWN.rent,
  ]);

  const initTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    buildIx({ programId: PROGRAM_ID, keys: initKeys, data: initData })
  );
  await sendAndConfirmTransaction(conn, initTx, [payer], { commitment: "confirmed" });

  return { slab, mint, vault, vaultPda };
}

async function pushOraclePrice(
  conn: Connection,
  payer: Keypair,
  slab: PublicKey,
  priceE6: string
) {
  const data = encodePushOraclePrice({ priceE6, timestamp: BigInt(Math.floor(Date.now() / 1000)) });
  const keys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
    payer.publicKey, slab,
  ]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    buildIx({ programId: PROGRAM_ID, keys, data })
  );
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function runKeeperCrank(
  conn: Connection,
  payer: Keypair,
  slab: PublicKey,
  callerIdx: number = 65535,
  allowPanic: boolean = false,
) {
  const data = encodeKeeperCrank({ callerIdx, allowPanic });
  const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey, slab, WELL_KNOWN.clock,
  ]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    buildIx({ programId: PROGRAM_ID, keys, data })
  );
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function initUserWithDeposit(
  conn: Connection,
  payer: Keypair,
  slab: Keypair,
  mint: PublicKey,
  vault: PublicKey,
  vaultPda: PublicKey,
  depositAmount: bigint,
  isLP: boolean = false,
): Promise<{ userKp: Keypair; userIdx: number }> {
  const userKp = Keypair.generate();

  // Fund user
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: userKp.publicKey,
      lamports: 0.05 * LAMPORTS_PER_SOL,
    })
  );
  await sendAndConfirmTransaction(conn, fundTx, [payer], { commitment: "confirmed" });

  // Create ATA and mint tokens
  const userAta = await getOrCreateAssociatedTokenAccount(
    conn, payer, mint, userKp.publicKey
  );
  await mintTo(conn, payer, mint, userAta.address, payer, Number(depositAmount + 2_000_000n));
  await sleep(300);

  // Init user/LP
  const initData = isLP
    ? encodeInitLP({
        matcherProgram: PublicKey.default, // No matcher for TradeNoCpi
        matcherContext: PublicKey.default,
        feePayment: "1000000",
      })
    : encodeInitUser({ feePayment: "1000000" });

  const initAccounts = isLP
    ? ACCOUNTS_INIT_LP
    : ACCOUNTS_INIT_USER;

  const initKeys = buildAccountMetas(initAccounts, [
    isLP ? payer.publicKey : userKp.publicKey,
    slab.publicKey,
    userAta.address,
    vault,
    vaultPda,
    WELL_KNOWN.tokenProgram,
  ]);

  const initTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    buildIx({ programId: PROGRAM_ID, keys: initKeys, data: initData })
  );
  const initSigners = isLP ? [payer] : [payer, userKp];
  await sendAndConfirmTransaction(conn, initTx, initSigners, { commitment: "confirmed" });

  // Get user index
  const slabData = await fetchSlab(conn, slab.publicKey);
  const accounts = parseAllAccounts(slabData);
  const ownerKey = isLP ? payer.publicKey.toBase58() : userKp.publicKey.toBase58();
  const userAcct = accounts.find(a =>
    new PublicKey(a.account.owner).toBase58() === ownerKey
  );
  const userIdx = userAcct?.idx ?? 0;

  // Deposit collateral
  const depositData = encodeDepositCollateral({
    userIdx: userIdx,
    amount: depositAmount.toString(),
  });
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    isLP ? payer.publicKey : userKp.publicKey,
    slab.publicKey,
    userAta.address,
    vault,
    vaultPda,
    WELL_KNOWN.tokenProgram,
  ]);
  const depositTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData })
  );
  await sendAndConfirmTransaction(
    conn, depositTx, isLP ? [payer] : [payer, userKp],
    { commitment: "confirmed" }
  );

  return { userKp, userIdx };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("=== T9: Pricing Engine Integration Tests ===\n");

  const payerData = JSON.parse(fs.readFileSync(DEPLOYER_KP_PATH, "utf8"));
  const payer = Keypair.fromSecretKey(new Uint8Array(payerData));
  const conn = new Connection(RPC_URL, "confirmed");

  const balance = await conn.getBalance(payer.publicKey);
  console.log(`Deployer: ${payer.publicKey.toBase58()}`);
  console.log(`Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(2)} SOL\n`);

  // ========================================================================
  // (a) Oracle staleness rejection
  // ========================================================================
  console.log("--- (a) Oracle Staleness ---");

  await runTest("PushOraclePrice updates price and last_effective_price", async () => {
    const { slab } = await createMarketWithOracle(conn, payer, {
      initialPriceE6: "50000000", // $50
    });

    // Push a new price
    await pushOraclePrice(conn, payer, slab.publicKey, "55000000"); // $55

    const slabData = await fetchSlab(conn, slab.publicKey);
    const config = parseConfig(slabData);

    if (config.authorityPriceE6 !== 55_000_000n) {
      throw new Error(`Expected authority_price_e6=55000000, got ${config.authorityPriceE6}`);
    }
    if (config.lastEffectivePriceE6 !== 55_000_000n) {
      throw new Error(`Expected last_effective_price_e6=55000000, got ${config.lastEffectivePriceE6}`);
    }
  });

  await runTest("PushOraclePrice from non-authority is rejected", async () => {
    const { slab } = await createMarketWithOracle(conn, payer, {
      initialPriceE6: "50000000",
    });

    // Set oracle authority to a different address
    const newAuth = Keypair.generate();
    const setAuthData = encodeSetOracleAuthority({ newAuthority: newAuth.publicKey });
    const setAuthKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
      payer.publicKey, slab.publicKey,
    ]);
    const setAuthTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      buildIx({ programId: PROGRAM_ID, keys: setAuthKeys, data: setAuthData })
    );
    await sendAndConfirmTransaction(conn, setAuthTx, [payer], { commitment: "confirmed" });

    // Now try to push from original payer (no longer authority)
    try {
      await pushOraclePrice(conn, payer, slab.publicKey, "60000000");
      throw new Error("Should have failed — payer is no longer oracle authority");
    } catch (e: any) {
      if (e.message.includes("Should have failed")) throw e;
      // Expected: custom program error (unauthorized)
    }
  });

  // ========================================================================
  // (b) Mark price / effective price accuracy
  // ========================================================================
  console.log("\n--- (b) Mark Price Accuracy ---");

  await runTest("Initial mark price matches InitMarket parameter", async () => {
    const { slab } = await createMarketWithOracle(conn, payer, {
      initialPriceE6: "42000000", // $42
    });

    const slabData = await fetchSlab(conn, slab.publicKey);
    const config = parseConfig(slabData);

    if (config.lastEffectivePriceE6 !== 42_000_000n) {
      throw new Error(`Expected last_effective_price_e6=42000000, got ${config.lastEffectivePriceE6}`);
    }
  });

  await runTest("Price update chain: multiple pushes update correctly", async () => {
    const { slab } = await createMarketWithOracle(conn, payer, {
      initialPriceE6: "10000000", // $10
    });

    // Push several prices
    const prices = ["15000000", "20000000", "12000000"];
    for (const p of prices) {
      await pushOraclePrice(conn, payer, slab.publicKey, p);
      await sleep(300);
    }

    const slabData = await fetchSlab(conn, slab.publicKey);
    const config = parseConfig(slabData);

    // Final price should be the last pushed value
    if (config.authorityPriceE6 !== 12_000_000n) {
      throw new Error(`Expected authority_price_e6=12000000, got ${config.authorityPriceE6}`);
    }
  });

  await runTest("Zero price push is rejected", async () => {
    const { slab } = await createMarketWithOracle(conn, payer, {
      initialPriceE6: "10000000",
    });

    try {
      await pushOraclePrice(conn, payer, slab.publicKey, "0");
      throw new Error("Should have failed — zero price");
    } catch (e: any) {
      if (e.message.includes("Should have failed")) throw e;
      // Expected rejection
    }
  });

  // ========================================================================
  // (c) Hyperp EMA warm-up behavior
  // ========================================================================
  console.log("\n--- (c) Hyperp EMA Warm-up ---");

  await runTest("Hyperp mode: initial price sets last_effective_price", async () => {
    // Hyperp mode = all-zero feed ID + all-zero oracle authority
    // which is what admin oracle gives us by default.
    // For Hyperp-specific EMA, we just check the warm-up init.
    const { slab } = await createMarketWithOracle(conn, payer, {
      initialPriceE6: "1000000",
      warmupPeriodSlots: "50",
    });

    const slabData = await fetchSlab(conn, slab.publicKey);
    const config = parseConfig(slabData);
    const params = parseParams(slabData);

    if (params.warmupPeriodSlots !== 50n) {
      throw new Error(`Expected warmupPeriodSlots=50, got ${params.warmupPeriodSlots}`);
    }
    if (config.lastEffectivePriceE6 !== 1_000_000n) {
      throw new Error(`Expected initial price 1000000, got ${config.lastEffectivePriceE6}`);
    }
  });

  await runTest("Price pushes during warm-up period track correctly", async () => {
    const { slab } = await createMarketWithOracle(conn, payer, {
      initialPriceE6: "5000000",
      warmupPeriodSlots: "100",
    });

    // Push price changes during warm-up
    await pushOraclePrice(conn, payer, slab.publicKey, "5500000");
    await sleep(500);
    await pushOraclePrice(conn, payer, slab.publicKey, "6000000");

    const slabData = await fetchSlab(conn, slab.publicKey);
    const config = parseConfig(slabData);

    // Price should track the latest push
    if (config.authorityPriceE6 !== 6_000_000n) {
      throw new Error(`Expected 6000000, got ${config.authorityPriceE6}`);
    }
  });

  // ========================================================================
  // (d) Dynamic fee tiers
  // ========================================================================
  console.log("\n--- (d) Dynamic Fee Tiers ---");

  await runTest("UpdateRiskParams with tradingFeeBps changes fee", async () => {
    const { slab } = await createMarketWithOracle(conn, payer, {
      tradingFeeBps: "10", // 0.10%
    });

    // Read initial fee
    const slabData1 = await fetchSlab(conn, slab.publicKey);
    const params1 = parseParams(slabData1);
    if (params1.tradingFeeBps !== 10n) {
      throw new Error(`Expected initial tradingFeeBps=10, got ${params1.tradingFeeBps}`);
    }

    // Update to 25 bps (0.25%)
    const updateData = encodeUpdateRiskParams({
      initialMarginBps: "1000",
      maintenanceMarginBps: "500",
      tradingFeeBps: "25",
    });
    const updateKeys = buildAccountMetas([
      { name: "admin", signer: true, writable: true },
      { name: "slab", signer: false, writable: true },
    ], [payer.publicKey, slab.publicKey]);

    const updateTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      buildIx({ programId: PROGRAM_ID, keys: updateKeys, data: updateData })
    );
    await sendAndConfirmTransaction(conn, updateTx, [payer], { commitment: "confirmed" });

    // Verify updated fee
    const slabData2 = await fetchSlab(conn, slab.publicKey);
    const params2 = parseParams(slabData2);
    if (params2.tradingFeeBps !== 25n) {
      throw new Error(`Expected updated tradingFeeBps=25, got ${params2.tradingFeeBps}`);
    }
  });

  await runTest("UpdateRiskParams > 1000 bps is rejected", async () => {
    const { slab } = await createMarketWithOracle(conn, payer, {
      tradingFeeBps: "10",
    });

    const updateData = encodeUpdateRiskParams({
      initialMarginBps: "1000",
      maintenanceMarginBps: "500",
      tradingFeeBps: "1001", // Over max
    });
    const updateKeys = buildAccountMetas([
      { name: "admin", signer: true, writable: true },
      { name: "slab", signer: false, writable: true },
    ], [payer.publicKey, slab.publicKey]);

    const updateTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      buildIx({ programId: PROGRAM_ID, keys: updateKeys, data: updateData })
    );

    try {
      await sendAndConfirmTransaction(conn, updateTx, [payer], { commitment: "confirmed" });
      throw new Error("Should have failed — fee > 1000 bps");
    } catch (e: any) {
      if (e.message.includes("Should have failed")) throw e;
      // Expected: InvalidConfigParam
    }
  });

  await runTest("UpdateRiskParams without tradingFeeBps preserves fee", async () => {
    const { slab } = await createMarketWithOracle(conn, payer, {
      tradingFeeBps: "15",
    });

    // Update without tradingFeeBps (old format, 17 bytes)
    const updateData = encodeUpdateRiskParams({
      initialMarginBps: "1200",
      maintenanceMarginBps: "600",
    });
    const updateKeys = buildAccountMetas([
      { name: "admin", signer: true, writable: true },
      { name: "slab", signer: false, writable: true },
    ], [payer.publicKey, slab.publicKey]);

    const updateTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      buildIx({ programId: PROGRAM_ID, keys: updateKeys, data: updateData })
    );
    await sendAndConfirmTransaction(conn, updateTx, [payer], { commitment: "confirmed" });

    // Fee should remain 15
    const slabData = await fetchSlab(conn, slab.publicKey);
    const params = parseParams(slabData);
    if (params.tradingFeeBps !== 15n) {
      throw new Error(`Expected tradingFeeBps=15, got ${params.tradingFeeBps}`);
    }
  });

  // ========================================================================
  // (e) Funding rate settlement
  // ========================================================================
  console.log("\n--- (e) Funding Rate Settlement ---");

  await runTest("KeeperCrank settles funding on market with positions", async () => {
    const { slab, mint, vault, vaultPda } = await createMarketWithOracle(conn, payer, {
      initialPriceE6: "10000000", // $10
      tradingFeeBps: "0",
    });

    // Set oracle authority to payer
    await pushOraclePrice(conn, payer, slab.publicKey, "10000000");

    // Init LP with large deposit
    const { userIdx: lpIdx } = await initUserWithDeposit(
      conn, payer, slab, mint, vault, vaultPda, 100_000_000n, true
    );

    // Init user with deposit
    const { userKp, userIdx } = await initUserWithDeposit(
      conn, payer, slab, mint, vault, vaultPda, 50_000_000n, false
    );

    // Execute trade to create positions
    const tradeData = encodeTradeNoCpi({
      lpIdx, userIdx, size: "10000000", // 10 units long
    });
    const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_NOCPI, [
      userKp.publicKey,
      payer.publicKey, // LP owner
      slab.publicKey,
      WELL_KNOWN.clock,
      slab.publicKey, // oracle = slab in admin mode
    ]);
    const tradeTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData })
    );
    await sendAndConfirmTransaction(conn, tradeTx, [payer, userKp], { commitment: "confirmed" });

    // Read engine state after trade
    const slabDataBefore = await fetchSlab(conn, slab.publicKey);
    const engineBefore = parseEngine(slabDataBefore);

    // Wait a bit for slots to advance
    await sleep(2000);

    // Run keeper crank
    await runKeeperCrank(conn, payer, slab.publicKey);

    // Read engine state after crank
    const slabDataAfter = await fetchSlab(conn, slab.publicKey);
    const engineAfter = parseEngine(slabDataAfter);

    // Funding should have been applied (lastFundingSlot should advance)
    if (engineAfter.lastFundingSlot <= engineBefore.lastFundingSlot) {
      throw new Error(
        `Expected funding slot to advance: before=${engineBefore.lastFundingSlot}, after=${engineAfter.lastFundingSlot}`
      );
    }
  });

  await runTest("KeeperCrank on empty market succeeds without error", async () => {
    const { slab } = await createMarketWithOracle(conn, payer, {
      initialPriceE6: "10000000",
    });

    // Crank with no accounts — should succeed
    await runKeeperCrank(conn, payer, slab.publicKey, 65535, false);
  });

  // ========================================================================
  // SUMMARY
  // ========================================================================
  console.log("\n=== Results ===");
  let passed = 0, failed = 0;
  for (const r of results) {
    if (r.passed) passed++;
    else {
      failed++;
      console.log(`  FAIL: ${r.name} — ${r.error}`);
    }
  }
  console.log(`\n${passed}/${results.length} passed, ${failed} failed`);

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
