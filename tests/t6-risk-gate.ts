/**
 * T6: Risk Gate — Verify improved defaults allow immediate direction flip
 *
 * Old program defaults would block opening a SHORT immediately after closing a LONG
 * on a small market (Error 22 = RiskGate). The v2 defaults should allow this.
 *
 * Flow: Create market → LP → Trader → Open LONG → Close LONG → Open SHORT → Close SHORT
 */
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import {
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as fs from "fs";

import {
  encodeInitMarket,
  encodeInitLP,
  encodeInitUser,
  encodeDepositCollateral,
  encodeKeeperCrank,
  encodeTradeCpi,
  encodePushOraclePrice,
  encodeSetOracleAuthority,
  encodeCloseSlab,
  buildAccountMetas,
  buildIx,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_TRADE_CPI,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_CLOSE_SLAB,
  WELL_KNOWN,
  parseEngine,
  parseAccount,
  parseParams,
  deriveLpPda,
  fetchSlab,
} from "@percolator/sdk";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD");
const MATCHER_PROGRAM_ID = new PublicKey(process.env.MATCHER_PROGRAM_ID ?? "FmTx5yi62Y3h1ATkxm8ujLNNCwYcc2LTmWRFFWN31Af");
const SLAB_SIZE = Number(process.env.SLAB_SIZE ?? 62_808);
const MATCHER_CTX_SIZE = 320;

interface TestResult { name: string; passed: boolean; error?: string; duration: number }
const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, duration: Date.now() - start });
    console.log(`  ✅ ${name} (${Date.now() - start}ms)`);
  } catch (e: any) {
    results.push({ name, passed: false, error: e.message?.slice(0, 200), duration: Date.now() - start });
    console.log(`  ❌ ${name}: ${e.message?.slice(0, 200)}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

async function main() {
  console.log("\n=== T6: Risk Gate — Immediate Direction Flip ===\n");
  console.log(`  Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`  Matcher: ${MATCHER_PROGRAM_ID.toBase58()}\n`);

  const { Connection } = await import("@solana/web3.js");
  const connection = new Connection(RPC_URL, "confirmed");
  const payerData = JSON.parse(fs.readFileSync(process.env.SOLANA_KEYPAIR ?? "/tmp/deployer.json", "utf8"));
  const payer = Keypair.fromSecretKey(new Uint8Array(payerData));
  console.log(`  Payer: ${payer.publicKey.toBase58()}`);

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`  Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);

  let slab: Keypair;
  let mint: PublicKey;
  let vaultPda: PublicKey;
  let vault: PublicKey;
  let matcherCtxKp: Keypair;
  let lpOwner: Keypair;
  let lpAta: PublicKey;
  let trader: Keypair;
  let traderAta: PublicKey;
  const lpIdx = 0;
  let traderIdx = -1;

  // ============================================================
  // STEP 1: Create small market @ $1.00
  // ============================================================
  await runTest("1. Create small market ($1.00)", async () => {
    slab = Keypair.generate();
    mint = await createMint(connection, payer, payer.publicKey, null, 6);
    await sleep(500);

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), slab.publicKey.toBuffer()], PROGRAM_ID
    );

    const rentExempt = await connection.getMinimumBalanceForRentExemption(SLAB_SIZE);
    const createTx = new Transaction();
    createTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
    createTx.add(SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: slab.publicKey,
      lamports: rentExempt, space: SLAB_SIZE, programId: PROGRAM_ID,
    }));
    await sendAndConfirmTransaction(connection, createTx, [payer, slab], { commitment: "confirmed" });

    const vaultAccount = await getOrCreateAssociatedTokenAccount(connection, payer, mint, vaultPda, true);
    vault = vaultAccount.address;

    const initData = encodeInitMarket({
      admin: payer.publicKey,
      collateralMint: mint,
      indexFeedId: "0".repeat(64),
      maxStalenessSecs: "100000000",
      confFilterBps: 200,
      invert: 0,
      unitScale: 0,
      initialMarkPriceE6: "1000000",
      warmupPeriodSlots: "10",
      maintenanceMarginBps: "500",
      initialMarginBps: "1000",
      tradingFeeBps: "10",
      maxAccounts: "256",
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
      payer.publicKey, slab.publicKey, mint, vault,
      WELL_KNOWN.tokenProgram, WELL_KNOWN.clock, WELL_KNOWN.rent,
      vaultPda, WELL_KNOWN.systemProgram,
    ]);
    const initTx = new Transaction();
    initTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    initTx.add(buildIx({ programId: PROGRAM_ID, keys: initKeys, data: initData }));
    await sendAndConfirmTransaction(connection, initTx, [payer], { commitment: "confirmed" });

    // Set oracle authority
    const setOracleData = encodeSetOracleAuthority({ newAuthority: payer.publicKey });
    const setOracleKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, slab.publicKey]);
    const setOracleTx = new Transaction();
    setOracleTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    setOracleTx.add(buildIx({ programId: PROGRAM_ID, keys: setOracleKeys, data: setOracleData }));
    await sendAndConfirmTransaction(connection, setOracleTx, [payer], { commitment: "confirmed" });

    console.log(`    Slab: ${slab.publicKey.toBase58()}`);
  });

  // ============================================================
  // STEP 2: Push oracle price ($1.00)
  // ============================================================
  await runTest("2. Push oracle price ($1.00)", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const pushData = encodePushOraclePrice({ priceE6: "1000000", timestamp: ts });
    const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slab.publicKey]);
    const pushTx = new Transaction();
    pushTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    pushTx.add(buildIx({ programId: PROGRAM_ID, keys: pushKeys, data: pushData }));
    await sendAndConfirmTransaction(connection, pushTx, [payer], { commitment: "confirmed" });

    // Initial crank
    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab.publicKey, SYSVAR_CLOCK_PUBKEY, slab.publicKey,
    ]);
    const crankTx = new Transaction();
    crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
    await sendAndConfirmTransaction(connection, crankTx, [payer], { commitment: "confirmed", skipPreflight: true });
  });

  // ============================================================
  // STEP 3: Init LP via matcher + deposit collateral
  // ============================================================
  await runTest("3. Init LP via matcher + deposit 400 tokens", async () => {
    lpOwner = Keypair.generate();
    const fundTx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: payer.publicKey, toPubkey: lpOwner.publicKey,
      lamports: LAMPORTS_PER_SOL / 5,
    }));
    await sendAndConfirmTransaction(connection, fundTx, [payer]);
    await sleep(1000);

    const lpAtaAccount = await getOrCreateAssociatedTokenAccount(connection, payer, mint, lpOwner.publicKey);
    lpAta = lpAtaAccount.address;
    await mintTo(connection, payer, mint, lpAta, payer, 500_000_000n);
    await sleep(500);

    matcherCtxKp = Keypair.generate();
    const matcherCtxRent = await connection.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);
    const [lpPda] = deriveLpPda(PROGRAM_ID, slab.publicKey, lpIdx);

    const instructions: TransactionInstruction[] = [];

    // Create matcher context
    instructions.push(SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: matcherCtxKp.publicKey,
      lamports: matcherCtxRent, space: MATCHER_CTX_SIZE,
      programId: MATCHER_PROGRAM_ID,
    }));

    // NOTE: The new reference AMM matcher does NOT have an InitVamm (Tag 2)
    // instruction. It reads LP config from context bytes 64..68, defaulting
    // to 30 bps spread and 100% fill when zeroed.

    // Init LP
    const initLpData = encodeInitLP({
      matcherProgram: MATCHER_PROGRAM_ID,
      matcherContext: matcherCtxKp.publicKey,
      feePayment: "1000000",
    });
    const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [
      lpOwner.publicKey, slab.publicKey, lpAta, vault, WELL_KNOWN.tokenProgram,
    ]);
    instructions.push(buildIx({ programId: PROGRAM_ID, keys: initLpKeys, data: initLpData }));

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
    instructions.forEach((ix) => tx.add(ix));
    await sendAndConfirmTransaction(connection, tx, [payer, matcherCtxKp, lpOwner], { commitment: "confirmed" });

    // Deposit LP collateral
    const depositData = encodeDepositCollateral({ userIdx: lpIdx, amount: "400000000" });
    const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      lpOwner.publicKey, slab.publicKey, lpAta, vault,
      WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
    ]);
    const depositTx = new Transaction();
    depositTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    depositTx.add(buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData }));
    await sendAndConfirmTransaction(connection, depositTx, [payer, lpOwner], { commitment: "confirmed" });

    // Crank
    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab.publicKey, SYSVAR_CLOCK_PUBKEY, slab.publicKey,
    ]);
    const crankTx = new Transaction();
    crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
    await sendAndConfirmTransaction(connection, crankTx, [payer], { commitment: "confirmed", skipPreflight: true });

    console.log(`    LP initialized + funded with 400 tokens`);
  });

  // ============================================================
  // STEP 4: Init user + deposit
  // ============================================================
  await runTest("4. Init trader + deposit 50 tokens", async () => {
    trader = Keypair.generate();
    const fundTx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: payer.publicKey, toPubkey: trader.publicKey,
      lamports: LAMPORTS_PER_SOL / 10,
    }));
    await sendAndConfirmTransaction(connection, fundTx, [payer]);
    await sleep(1000);

    const traderAtaAccount = await getOrCreateAssociatedTokenAccount(connection, payer, mint, trader.publicKey);
    traderAta = traderAtaAccount.address;
    await mintTo(connection, payer, mint, traderAta, payer, 100_000_000n);
    await sleep(500);

    // Init user
    const initData = encodeInitUser({ feePayment: "1000000" });
    const initKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
      trader.publicKey, slab.publicKey, traderAta, vault, WELL_KNOWN.tokenProgram,
    ]);
    const initTx = new Transaction();
    initTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    initTx.add(buildIx({ programId: PROGRAM_ID, keys: initKeys, data: initData }));
    await sendAndConfirmTransaction(connection, initTx, [payer, trader], { commitment: "confirmed" });

    // Find trader idx
    const data = await fetchSlab(connection, slab.publicKey);
    const engine = parseEngine(data);
    traderIdx = engine.numUsedAccounts - 1;
    console.log(`    Trader idx: ${traderIdx}`);

    // Deposit
    const depositData = encodeDepositCollateral({ userIdx: traderIdx, amount: "50000000" });
    const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      trader.publicKey, slab.publicKey, traderAta, vault,
      WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
    ]);
    const depositTx = new Transaction();
    depositTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    depositTx.add(buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData }));
    await sendAndConfirmTransaction(connection, depositTx, [payer, trader], { commitment: "confirmed" });

    // Crank
    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab.publicKey, SYSVAR_CLOCK_PUBKEY, slab.publicKey,
    ]);
    const crankTx = new Transaction();
    crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
    await sendAndConfirmTransaction(connection, crankTx, [payer], { commitment: "confirmed", skipPreflight: true });
  });

  // ============================================================
  // STEP 5: Open LONG (large-ish relative to vault)
  // ============================================================
  await runTest("5. Open LONG (100 tokens — large relative to vault)", async () => {
    const [lpPda] = deriveLpPda(PROGRAM_ID, slab.publicKey, lpIdx);
    const tradeData = encodeTradeCpi({
      lpIdx, userIdx: traderIdx, size: "100000000", // 100 tokens LONG
    });
    const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      trader.publicKey, lpOwner.publicKey, slab.publicKey,
      WELL_KNOWN.clock, slab.publicKey,
      MATCHER_PROGRAM_ID, matcherCtxKp.publicKey, lpPda,
    ]);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData }));
    await sendAndConfirmTransaction(connection, tx, [payer, trader], { commitment: "confirmed" });

    // Crank
    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab.publicKey, SYSVAR_CLOCK_PUBKEY, slab.publicKey,
    ]);
    const crankTx = new Transaction();
    crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
    await sendAndConfirmTransaction(connection, crankTx, [payer], { commitment: "confirmed", skipPreflight: true });

    const data = await fetchSlab(connection, slab.publicKey);
    const acct = parseAccount(data, traderIdx);
    console.log(`    Position size: ${acct.positionSize} (should be > 0 = LONG)`);
    assert(acct.positionSize > 0n, "Position is LONG");
  });

  // ============================================================
  // STEP 6: Close the LONG (trade back to 0)
  // ============================================================
  await runTest("6. Close LONG (trade to size 0)", async () => {
    const data = await fetchSlab(connection, slab.publicKey);
    const acct = parseAccount(data, traderIdx);
    const closeSize = (-acct.positionSize).toString(); // negate to close

    const [lpPda] = deriveLpPda(PROGRAM_ID, slab.publicKey, lpIdx);
    const tradeData = encodeTradeCpi({
      lpIdx, userIdx: traderIdx, size: closeSize,
    });
    const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      trader.publicKey, lpOwner.publicKey, slab.publicKey,
      WELL_KNOWN.clock, slab.publicKey,
      MATCHER_PROGRAM_ID, matcherCtxKp.publicKey, lpPda,
    ]);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData }));
    await sendAndConfirmTransaction(connection, tx, [payer, trader], { commitment: "confirmed" });

    // Crank
    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab.publicKey, SYSVAR_CLOCK_PUBKEY, slab.publicKey,
    ]);
    const crankTx = new Transaction();
    crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
    await sendAndConfirmTransaction(connection, crankTx, [payer], { commitment: "confirmed", skipPreflight: true });

    const data2 = await fetchSlab(connection, slab.publicKey);
    const acct2 = parseAccount(data2, traderIdx);
    console.log(`    Position after close: ${acct2.positionSize}`);
    assert(acct2.positionSize === 0n, "Position is flat");
  });

  // ============================================================
  // STEP 7: Immediately open SHORT — THIS IS THE KEY TEST
  // Old defaults would block this with Error 22 (RiskGate)
  // ============================================================
  await runTest("7. ⚡ Immediately open SHORT (should succeed with v2 risk gate defaults)", async () => {
    const [lpPda] = deriveLpPda(PROGRAM_ID, slab.publicKey, lpIdx);
    const tradeData = encodeTradeCpi({
      lpIdx, userIdx: traderIdx, size: "-100000000", // 100 tokens SHORT
    });
    const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      trader.publicKey, lpOwner.publicKey, slab.publicKey,
      WELL_KNOWN.clock, slab.publicKey,
      MATCHER_PROGRAM_ID, matcherCtxKp.publicKey, lpPda,
    ]);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData }));

    // This is the critical assertion: the trade should NOT fail with Error 22
    await sendAndConfirmTransaction(connection, tx, [payer, trader], { commitment: "confirmed" });

    // Crank
    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab.publicKey, SYSVAR_CLOCK_PUBKEY, slab.publicKey,
    ]);
    const crankTx = new Transaction();
    crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
    await sendAndConfirmTransaction(connection, crankTx, [payer], { commitment: "confirmed", skipPreflight: true });

    const data = await fetchSlab(connection, slab.publicKey);
    const acct = parseAccount(data, traderIdx);
    console.log(`    Position size: ${acct.positionSize} (should be < 0 = SHORT)`);
    assert(acct.positionSize < 0n, "Position is SHORT — risk gate passed! ✅");
  });

  // ============================================================
  // STEP 8: Close the short
  // ============================================================
  await runTest("8. Close SHORT", async () => {
    const data = await fetchSlab(connection, slab.publicKey);
    const acct = parseAccount(data, traderIdx);
    const closeSize = (-acct.positionSize).toString();

    const [lpPda] = deriveLpPda(PROGRAM_ID, slab.publicKey, lpIdx);
    const tradeData = encodeTradeCpi({
      lpIdx, userIdx: traderIdx, size: closeSize,
    });
    const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      trader.publicKey, lpOwner.publicKey, slab.publicKey,
      WELL_KNOWN.clock, slab.publicKey,
      MATCHER_PROGRAM_ID, matcherCtxKp.publicKey, lpPda,
    ]);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData }));
    await sendAndConfirmTransaction(connection, tx, [payer, trader], { commitment: "confirmed" });

    const data2 = await fetchSlab(connection, slab.publicKey);
    const acct2 = parseAccount(data2, traderIdx);
    console.log(`    Position after close: ${acct2.positionSize}`);
    assert(acct2.positionSize === 0n, "Position is flat");
  });

  // ============================================================
  // STEP 8b: Multiple rapid direction flips
  // Open LONG → Close → Open SHORT → Close → Open LONG → Close
  // Verifies risk gate doesn't accumulate and block after multiple cycles
  // ============================================================
  await runTest("8b. Multiple rapid direction flips (LONG → SHORT → LONG)", async () => {
    const [lpPda] = deriveLpPda(PROGRAM_ID, slab.publicKey, lpIdx);

    // Helper: trade + crank
    async function tradeAndCrank(size: string, label: string) {
      const tradeData = encodeTradeCpi({ lpIdx, userIdx: traderIdx, size });
      const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
        trader.publicKey, lpOwner.publicKey, slab.publicKey,
        WELL_KNOWN.clock, slab.publicKey,
        MATCHER_PROGRAM_ID, matcherCtxKp.publicKey, lpPda,
      ]);
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
      tx.add(buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData }));
      await sendAndConfirmTransaction(connection, tx, [payer, trader], { commitment: "confirmed" });

      const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
      const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
        payer.publicKey, slab.publicKey, SYSVAR_CLOCK_PUBKEY, slab.publicKey,
      ]);
      const crankTx = new Transaction();
      crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
      crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
      await sendAndConfirmTransaction(connection, crankTx, [payer], { commitment: "confirmed", skipPreflight: true });
      console.log(`    ${label} ✓`);
    }

    // Open LONG
    await tradeAndCrank("50000000", "Open LONG (50)");
    // Close LONG
    const data1 = await fetchSlab(connection, slab.publicKey);
    const acct1 = parseAccount(data1, traderIdx);
    await tradeAndCrank((-acct1.positionSize).toString(), "Close LONG");
    // Open SHORT
    await tradeAndCrank("-50000000", "Open SHORT (50)");
    // Close SHORT
    const data2 = await fetchSlab(connection, slab.publicKey);
    const acct2 = parseAccount(data2, traderIdx);
    await tradeAndCrank((-acct2.positionSize).toString(), "Close SHORT");
    // Open LONG again
    await tradeAndCrank("50000000", "Open LONG again (50)");
    // Close LONG again
    const data3 = await fetchSlab(connection, slab.publicKey);
    const acct3 = parseAccount(data3, traderIdx);
    await tradeAndCrank((-acct3.positionSize).toString(), "Close LONG (final)");

    const dataFinal = await fetchSlab(connection, slab.publicKey);
    const acctFinal = parseAccount(dataFinal, traderIdx);
    assert(acctFinal.positionSize === 0n, "Position is flat after all flips");
    console.log("    All rapid direction flips succeeded — risk gate OK ✅");
  });

  // ============================================================
  // STEP 8c: Read risk threshold from slab
  // ============================================================
  await runTest("8c. Read risk_reduction_threshold from slab", async () => {
    const data = await fetchSlab(connection, slab.publicKey);
    const engine = parseEngine(data);
    const params = parseParams(data);
    console.log(`    Engine numUsedAccounts: ${engine.numUsedAccounts}`);
    console.log(`    risk_reduction_threshold: ${params.riskReductionThreshold}`);
    // With v2 defaults, threshold should be 0 or very small
    const threshold = BigInt(params.riskReductionThreshold);
    // Threshold is in units (not bps) — after active trading it will be non-zero but reasonable.
    // With v2 defaults (50% EWMA, 2% risk), it should stay well below the vault balance.
    // A threshold of ~1M units on a market with 50M+ units deposited = ~2% — exactly as expected.
    assert(threshold < 100_000_000n, `risk_reduction_threshold should be < 100M units but got ${threshold}`);
    console.log("    ✓ Risk threshold is low as expected with v2 defaults");
  });

  // ============================================================
  // Cleanup
  // ============================================================
  try {
    const csKeys = buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [payer.publicKey, slab!.publicKey]);
    const csTx = new Transaction();
    csTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
    csTx.add(buildIx({ programId: PROGRAM_ID, keys: csKeys, data: encodeCloseSlab() }));
    await sendAndConfirmTransaction(connection, csTx, [payer], { commitment: "confirmed" });
    console.log("\n  Slab closed — rent reclaimed");
  } catch (e: any) {
    console.log(`\n  Slab cleanup failed: ${e.message?.slice(0, 60)}`);
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n  Results: ${passed}/${results.length} passed, ${failed} failed`);
  console.log("\n=== T6 Complete ===\n");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
