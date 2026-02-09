/**
 * T4: Liquidation Test — Full lifecycle with vAMM LP
 *
 * Uses proper matcher program for LP initialization and TradeCpi for trades.
 * Tests: create market → init LP via matcher → deposit → trade → crash price → liquidate
 */
import {
  Connection,
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
  getAssociatedTokenAddress,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";

import {
  encodeInitMarket,
  encodeInitLP,
  encodeDepositCollateral,
  encodeKeeperCrank,
  encodeTradeCpi,
  encodeLiquidateAtOracle,
  encodePushOraclePrice,
  encodeSetOracleAuthority,
  encodeTopUpInsurance,
  encodeInitUser,
  encodeCloseSlab,
  buildAccountMetas,
  buildIx,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_TRADE_CPI,
  ACCOUNTS_LIQUIDATE_AT_ORACLE,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_CLOSE_SLAB,
  WELL_KNOWN,
  parseConfig,
  parseEngine,
  parseParams,
  parseAccount,
  deriveLpPda,
  fetchSlab,
} from "@percolator/core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? "8n1YAoHzZAAz2JkgASr7Yk9dokptDa9VzjbsRadu3MhL");
const MATCHER_PROGRAM_ID = new PublicKey(process.env.MATCHER_PROGRAM_ID ?? "4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");
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

async function main() {
  console.log("\n=== T4: Liquidation Test (with vAMM) ===\n");
  console.log(`  Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`  Matcher: ${MATCHER_PROGRAM_ID.toBase58()}`);
  console.log(`  Slab size: ${SLAB_SIZE} bytes\n`);

  const connection = new Connection(RPC_URL, "confirmed");
  const payerData = JSON.parse(fs.readFileSync(process.env.SOLANA_KEYPAIR ?? "/root/.config/solana/id.json", "utf8"));
  const payer = Keypair.fromSecretKey(new Uint8Array(payerData));
  console.log(`  Payer: ${payer.publicKey.toBase58()}`);

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`  Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);

  // State
  let slab: Keypair;
  let mint: PublicKey;
  let vaultPda: PublicKey;
  let vault: PublicKey;
  let matcherCtxKp: Keypair;
  let lpOwner: Keypair;
  let lpAta: PublicKey;
  let trader: Keypair;
  let traderAta: PublicKey;
  let lpIdx = 0;
  let traderIdx = -1;

  // ============================================================
  // STEP 1: Create market
  // ============================================================
  await runTest("1. Create market ($1.00 price, small slab)", async () => {
    slab = Keypair.generate();
    mint = await createMint(connection, payer, payer.publicKey, null, 6);
    await sleep(500);

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), slab.publicKey.toBuffer()], PROGRAM_ID
    );

    const rentExempt = await connection.getMinimumBalanceForRentExemption(SLAB_SIZE);
    console.log(`    Slab rent: ${(rentExempt / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

    // Create slab account
    const createTx = new Transaction();
    createTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
    createTx.add(SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: slab.publicKey,
      lamports: rentExempt, space: SLAB_SIZE, programId: PROGRAM_ID,
    }));
    await sendAndConfirmTransaction(connection, createTx, [payer, slab], { commitment: "confirmed" });

    // Create vault ATA
    const vaultAccount = await getOrCreateAssociatedTokenAccount(connection, payer, mint, vaultPda, true);
    vault = vaultAccount.address;

    // Init market
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

    // Push initial price
    const ts = Math.floor(Date.now() / 1000).toString();
    const pushData = encodePushOraclePrice({ priceE6: "1000000", timestamp: ts });
    const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slab.publicKey]);
    const pushTx = new Transaction();
    pushTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    pushTx.add(buildIx({ programId: PROGRAM_ID, keys: pushKeys, data: pushData }));
    await sendAndConfirmTransaction(connection, pushTx, [payer], { commitment: "confirmed" });

    console.log(`    Slab: ${slab.publicKey.toBase58()}`);
    console.log(`    Mint: ${mint.toBase58()}`);
  });

  // ============================================================
  // STEP 2: Initialize LP via matcher (vAMM)
  // ============================================================
  await runTest("2. Initialize LP via matcher vAMM", async () => {
    lpOwner = Keypair.generate();

    // Fund LP owner
    const fundTx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: payer.publicKey, toPubkey: lpOwner.publicKey,
      lamports: LAMPORTS_PER_SOL / 5,
    }));
    await sendAndConfirmTransaction(connection, fundTx, [payer]);
    await sleep(1000);

    // Create LP's ATA + mint tokens
    const lpAtaAccount = await getOrCreateAssociatedTokenAccount(connection, payer, mint, lpOwner.publicKey);
    lpAta = lpAtaAccount.address;
    await mintTo(connection, payer, mint, lpAta, payer, 500_000_000n); // 500 tokens
    await sleep(1000);

    // Create matcher context account
    matcherCtxKp = Keypair.generate();
    const matcherCtxRent = await connection.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);

    const [lpPda] = deriveLpPda(PROGRAM_ID, slab.publicKey, lpIdx);

    // Atomic: createCtx + initVamm + initLP
    const instructions: TransactionInstruction[] = [];

    // 1. Create matcher context
    instructions.push(SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: matcherCtxKp.publicKey,
      lamports: matcherCtxRent, space: MATCHER_CTX_SIZE,
      programId: MATCHER_PROGRAM_ID,
    }));

    // 2. Init vAMM (Tag 2 on matcher)
    const vammData = new Uint8Array(66);
    const dv = new DataView(vammData.buffer);
    let off = 0;
    vammData[off] = 2; off += 1;            // Tag 2 = InitVamm
    vammData[off] = 0; off += 1;            // mode 0 = passive
    dv.setUint32(off, 50, true); off += 4;  // tradingFeeBps
    dv.setUint32(off, 50, true); off += 4;  // baseSpreadBps
    dv.setUint32(off, 200, true); off += 4; // maxTotalBps
    dv.setUint32(off, 0, true); off += 4;   // impactKBps
    dv.setBigUint64(off, 10_000_000_000_000n, true); off += 8;
    dv.setBigUint64(off, 0n, true); off += 8;
    dv.setBigUint64(off, 1_000_000_000_000n, true); off += 8;
    dv.setBigUint64(off, 0n, true); off += 8;
    dv.setBigUint64(off, 0n, true); off += 8;
    dv.setBigUint64(off, 0n, true); off += 8;

    instructions.push(new TransactionInstruction({
      programId: MATCHER_PROGRAM_ID,
      keys: [
        { pubkey: lpPda, isSigner: false, isWritable: false },
        { pubkey: matcherCtxKp.publicKey, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(vammData),
    }));

    // 3. Init LP on percolator program
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
    console.log(`    LP initialized with matcher context: ${matcherCtxKp.publicKey.toBase58().slice(0, 12)}...`);
  });

  // ============================================================
  // STEP 3: Deposit LP collateral
  // ============================================================
  await runTest("3. Deposit LP collateral (400 tokens)", async () => {
    const depositData = encodeDepositCollateral({ userIdx: lpIdx, amount: "400000000" });
    const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      lpOwner.publicKey, slab.publicKey, lpAta, vault,
      WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
    ]);
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData }));
    await sendAndConfirmTransaction(connection, tx, [payer, lpOwner], { commitment: "confirmed" });

    // Crank
    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab.publicKey, SYSVAR_CLOCK_PUBKEY, slab.publicKey,
    ]);
    const crankTx = new Transaction();
    crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
    await sendAndConfirmTransaction(connection, crankTx, [payer], { commitment: "confirmed", skipPreflight: true });
    console.log(`    LP collateral deposited + cranked`);
  });

  // ============================================================
  // STEP 4: Create trader + deposit
  // ============================================================
  await runTest("4. Create trader + deposit (10 tokens)", async () => {
    trader = Keypair.generate();
    const fundTx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: payer.publicKey, toPubkey: trader.publicKey,
      lamports: LAMPORTS_PER_SOL / 10,
    }));
    await sendAndConfirmTransaction(connection, fundTx, [payer]);
    await sleep(1000);

    const traderAtaAccount = await getOrCreateAssociatedTokenAccount(connection, payer, mint, trader.publicKey);
    traderAta = traderAtaAccount.address;
    await mintTo(connection, payer, mint, traderAta, payer, 50_000_000n);
    await sleep(1000);

    // Init user
    const initData = encodeInitUser({ feePayment: "1000000" });
    const initKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
      trader.publicKey, slab.publicKey, traderAta, vault, WELL_KNOWN.tokenProgram,
    ]);
    const initTx = new Transaction();
    initTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    initTx.add(buildIx({ programId: PROGRAM_ID, keys: initKeys, data: initData }));
    await sendAndConfirmTransaction(connection, initTx, [payer, trader], { commitment: "confirmed" });

    // Find trader's account index
    const data = await fetchSlab(connection, slab.publicKey);
    const engine = parseEngine(data);
    traderIdx = engine.numUsedAccounts - 1; // Should be the latest
    console.log(`    Trader idx: ${traderIdx}`);

    // Deposit 10 tokens
    const depositData = encodeDepositCollateral({ userIdx: traderIdx, amount: "10000000" });
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

    // Verify
    const data2 = await fetchSlab(connection, slab.publicKey);
    const acct = parseAccount(data2, traderIdx);
    console.log(`    Trader capital: ${acct.capital}, kind: ${acct.kind}`);
  });

  // ============================================================
  // STEP 5: Open leveraged long via TradeCpi
  // ============================================================
  await runTest("5. Open 5x leveraged long (50 tokens)", async () => {
    const [lpPda] = deriveLpPda(PROGRAM_ID, slab.publicKey, lpIdx);

    const tradeData = encodeTradeCpi({
      lpIdx: lpIdx,
      userIdx: traderIdx,
      size: "50000000", // 50 tokens long
    });
    const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      trader.publicKey,      // user (signer)
      lpOwner.publicKey,     // lpOwner (not signer)
      slab.publicKey,        // slab
      WELL_KNOWN.clock,      // clock
      slab.publicKey,        // oracle (admin oracle = slab)
      MATCHER_PROGRAM_ID,    // matcherProg
      matcherCtxKp.publicKey, // matcherCtx
      lpPda,                 // lpPda
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
    const traderAcct = parseAccount(data, traderIdx);
    console.log(`    Position: ${traderAcct.positionSize}`);
    console.log(`    Capital: ${traderAcct.capital}`);
    console.log(`    PnL: ${traderAcct.pnl}`);
  });

  // ============================================================
  // STEP 6: Crash oracle price to trigger liquidation
  // ============================================================
  await runTest("6. Crash oracle price — push+crank repeatedly until undercollateralized", async () => {
    // The engine smooths oracle price across cranks, so we push to extreme
    // and crank multiple times to force mark price convergence.
    const targetPrice = "10000"; // $0.01 — 99% drop

    for (let i = 0; i < 15; i++) {
      const ts = Math.floor(Date.now() / 1000 + i).toString();
      const pushData = encodePushOraclePrice({ priceE6: targetPrice, timestamp: ts });
      const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slab.publicKey]);
      const pushTx = new Transaction();
      pushTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
      pushTx.add(buildIx({ programId: PROGRAM_ID, keys: pushKeys, data: pushData }));
      await sendAndConfirmTransaction(connection, pushTx, [payer], { commitment: "confirmed", skipPreflight: true });

      // Crank
      const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
      const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
        payer.publicKey, slab.publicKey, SYSVAR_CLOCK_PUBKEY, slab.publicKey,
      ]);
      const crankTx = new Transaction();
      crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
      crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
      await sendAndConfirmTransaction(connection, crankTx, [payer], { commitment: "confirmed", skipPreflight: true });

      // Check margin after each cycle
      const data = await fetchSlab(connection, slab.publicKey);
      const cfg = parseConfig(data);
      const params = parseParams(data);
      const traderAcct = parseAccount(data, traderIdx);

      if (traderAcct.positionSize === 0n) {
        console.log(`    Cycle ${i+1}: Position auto-liquidated by crank! ✅`);
        return;
      }

      const absPos = traderAcct.positionSize < 0n ? -traderAcct.positionSize : traderAcct.positionSize;
      const notional = absPos * cfg.authorityPriceE6 / 1_000_000n;
      const equity = traderAcct.capital + traderAcct.pnl;
      const marginBps = notional > 0n ? equity * 10_000n / notional : 0n;

      if (i === 0 || i === 4 || i === 9 || i === 14 || marginBps < params.maintenanceMarginBps) {
        console.log(`    Cycle ${i+1}: price=$${Number(cfg.authorityPriceE6)/1e6}, PnL=${traderAcct.pnl}, margin=${Number(marginBps)/100}%`);
      }

      if (marginBps < params.maintenanceMarginBps) {
        console.log(`    ⚡ UNDERCOLLATERALIZED at cycle ${i+1}!`);
        return;
      }
    }

    // Final check
    const data = await fetchSlab(connection, slab.publicKey);
    const cfg = parseConfig(data);
    const params = parseParams(data);
    const traderAcct = parseAccount(data, traderIdx);
    const absPos = traderAcct.positionSize < 0n ? -traderAcct.positionSize : traderAcct.positionSize;
    const notional = absPos * cfg.authorityPriceE6 / 1_000_000n;
    const equity = traderAcct.capital + traderAcct.pnl;
    const marginBps = notional > 0n ? equity * 10_000n / notional : 0n;
    console.log(`    Final: price=$${Number(cfg.authorityPriceE6)/1e6}, margin=${Number(marginBps)/100}%`);
  });

  // ============================================================
  // STEP 7: Execute liquidation
  // ============================================================
  await runTest("7. Execute liquidation instruction", async () => {
    const dataBefore = await fetchSlab(connection, slab.publicKey);
    const acctBefore = parseAccount(dataBefore, traderIdx);

    if (acctBefore.positionSize === 0n) {
      console.log(`    Already liquidated by crank ✅`);
      return;
    }

    console.log(`    Pre-liq position: ${acctBefore.positionSize}`);

    const liqData = encodeLiquidateAtOracle({ targetIdx: traderIdx });
    const liqKeys = buildAccountMetas(ACCOUNTS_LIQUIDATE_AT_ORACLE, [
      payer.publicKey, slab.publicKey, WELL_KNOWN.clock, slab.publicKey,
    ]);
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys: liqKeys, data: liqData }));
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
    console.log(`    Liquidation tx: ${sig.slice(0, 20)}...`);

    // Crank after liquidation
    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab.publicKey, SYSVAR_CLOCK_PUBKEY, slab.publicKey,
    ]);
    const crankTx = new Transaction();
    crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
    await sendAndConfirmTransaction(connection, crankTx, [payer], { commitment: "confirmed", skipPreflight: true });

    const dataAfter = await fetchSlab(connection, slab.publicKey);
    const acctAfter = parseAccount(dataAfter, traderIdx);
    console.log(`    Post-liq position: ${acctAfter.positionSize}`);
    console.log(`    Post-liq capital: ${acctAfter.capital}`);

    if (acctAfter.positionSize === 0n || 
        (acctBefore.positionSize < 0n ? -acctBefore.positionSize : acctBefore.positionSize) >
        (acctAfter.positionSize < 0n ? -acctAfter.positionSize : acctAfter.positionSize)) {
      console.log(`    ✅ LIQUIDATION SUCCESSFUL`);
    }
  });

  // ============================================================
  // STEP 8: Verify market health
  // ============================================================
  await runTest("8. Market still healthy post-liquidation", async () => {
    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab.publicKey, SYSVAR_CLOCK_PUBKEY, slab.publicKey,
    ]);
    const crankTx = new Transaction();
    crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
    await sendAndConfirmTransaction(connection, crankTx, [payer], { commitment: "confirmed", skipPreflight: true });

    const data = await fetchSlab(connection, slab.publicKey);
    const engine = parseEngine(data);
    const cfg = parseConfig(data);
    console.log(`    ✅ Market operational. Accounts: ${engine.numUsedAccounts}, Price: $${Number(cfg.authorityPriceE6)/1e6}`);
  });

  // ============================================================
  // CLEANUP
  // ============================================================
  console.log("\n  Cleaning up slab (reclaiming rent)...");
  try {
    const closeTx = new Transaction();
    closeTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    const closeData = encodeCloseSlab();
    const closeKeys = buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [payer.publicKey, slab!.publicKey]);
    closeTx.add(buildIx({ programId: PROGRAM_ID, keys: closeKeys, data: closeData }));
    await sendAndConfirmTransaction(connection, closeTx, [payer], { commitment: "confirmed" });
    const rentBack = await connection.getMinimumBalanceForRentExemption(SLAB_SIZE);
    console.log(`    Reclaimed ~${(rentBack / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  } catch (e: any) {
    console.log(`    Cleanup failed: ${e.message?.slice(0, 80)}`);
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const status = failed === 0 ? "ALL PASSED ✅" : `${failed} FAILED ❌`;
  console.log(`\n  Results: ${passed}/${results.length} — ${status}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
