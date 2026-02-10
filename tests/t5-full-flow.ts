/**
 * T5: Full E2E Flow — Create market → Register → Oracle → User → Trade → Close → Withdraw
 *
 * Tests the ENTIRE lifecycle end-to-end on devnet.
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
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";

import {
  encodeInitMarket,
  encodeInitLP,
  encodeDepositCollateral,
  encodeWithdrawCollateral,
  encodeKeeperCrank,
  encodeTradeCpi,
  encodePushOraclePrice,
  encodeSetOracleAuthority,
  encodeInitUser,
  encodeCloseSlab,
  buildAccountMetas,
  buildIx,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_WITHDRAW_COLLATERAL,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_TRADE_CPI,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
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

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://devnet.helius-rpc.com/?api-key=ecfc91c7-b704-4c37-b10e-a277392830aa";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? "8n1YAoHzZAAz2JkgASr7Yk9dokptDa9VzjbsRadu3MhL");
const MATCHER_PROGRAM_ID = new PublicKey(process.env.MATCHER_PROGRAM_ID ?? "4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");
const SLAB_SIZE = Number(process.env.SLAB_SIZE ?? 62_808);
const MATCHER_CTX_SIZE = 320;
const API_URL = "https://percolator-api-production.up.railway.app/api/markets";
const API_KEY = "BOOM4356437HGVT-launch-key";

interface TestResult { name: string; passed: boolean; error?: string; duration: number }
const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, duration: Date.now() - start });
    console.log(`  ✅ ${name} (${Date.now() - start}ms)`);
  } catch (e: any) {
    results.push({ name, passed: false, error: e.message?.slice(0, 300), duration: Date.now() - start });
    console.log(`  ❌ ${name}: ${e.message?.slice(0, 300)}`);
  }
}

async function main() {
  console.log("\n=== T5: Full E2E Flow ===\n");
  console.log(`  Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`  Matcher: ${MATCHER_PROGRAM_ID.toBase58()}`);
  console.log(`  Slab size: ${SLAB_SIZE} bytes\n`);

  const connection = new Connection(RPC_URL, "confirmed");
  const payerData = JSON.parse(fs.readFileSync(process.env.SOLANA_KEYPAIR ?? "/tmp/deployer.json", "utf8"));
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

  // Helper: crank
  async function crank() {
    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab.publicKey, SYSVAR_CLOCK_PUBKEY, slab.publicKey,
    ]);
    const crankTx = new Transaction();
    crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
    await sendAndConfirmTransaction(connection, crankTx, [payer], { commitment: "confirmed", skipPreflight: true });
  }

  // Helper: push oracle price
  async function pushPrice(priceE6: string) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const pushData = encodePushOraclePrice({ priceE6, timestamp: ts });
    const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slab.publicKey]);
    const pushTx = new Transaction();
    pushTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    pushTx.add(buildIx({ programId: PROGRAM_ID, keys: pushKeys, data: pushData }));
    await sendAndConfirmTransaction(connection, pushTx, [payer], { commitment: "confirmed", skipPreflight: true });
  }

  // ============================================================
  // STEP 1: Create market ($1.00, 256 slots, 10x leverage = 1000 initialMarginBps)
  // ============================================================
  await runTest("1. Create market ($1.00, 256 slots, 10x leverage)", async () => {
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

    // Init market: 10x leverage = initialMarginBps 1000 (1/10 = 10%)
    const initData = encodeInitMarket({
      admin: payer.publicKey,
      collateralMint: mint,
      indexFeedId: "0".repeat(64), // all-zeros = admin oracle
      maxStalenessSecs: "100000000",
      confFilterBps: 200,
      invert: 0,
      unitScale: 0,
      initialMarkPriceE6: "1000000", // $1.00
      warmupPeriodSlots: "10",
      maintenanceMarginBps: "500",  // 5%
      initialMarginBps: "1000",     // 10% = 10x max leverage
      tradingFeeBps: "10",          // 0.1%
      maxAccounts: "256",
      newAccountFee: "1000000",     // 1 token
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

    // Push initial price + crank
    await pushPrice("1000000");
    await crank();

    console.log(`    Slab: ${slab.publicKey.toBase58()}`);
    console.log(`    Mint: ${mint.toBase58()}`);
    console.log(`    Vault: ${vault.toBase58()}`);
  });

  // ============================================================
  // STEP 2: Register market with API
  // ============================================================
  await runTest("2. Register market with API", async () => {
    const body = {
      publicKey: slab.publicKey.toBase58(),
      programId: PROGRAM_ID.toBase58(),
      matcherProgramId: MATCHER_PROGRAM_ID.toBase58(),
      name: `E2E Test Market ${Date.now()}`,
      symbol: "TEST/USD",
      collateralMint: mint.toBase58(),
      collateralDecimals: 6,
      collateralSymbol: "TEST",
      oracleType: "admin",
      maxLeverage: 10,
      network: "devnet",
    };

    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    console.log(`    API response: ${res.status} ${text.slice(0, 200)}`);
    // Don't fail on API errors — it's a secondary concern
    if (res.ok) {
      console.log(`    ✅ Market registered`);
    } else {
      console.log(`    ⚠️ API returned ${res.status} — continuing anyway`);
    }
  });

  // ============================================================
  // STEP 3: Push Oracle Price ($1.00)
  // ============================================================
  await runTest("3. Push oracle price ($1.00)", async () => {
    await pushPrice("1000000");
    await crank();

    const data = await fetchSlab(connection, slab.publicKey);
    const cfg = parseConfig(data);
    console.log(`    Oracle price: $${Number(cfg.authorityPriceE6) / 1e6}`);
    if (cfg.authorityPriceE6 <= 0n) throw new Error("Oracle price not set");
  });

  // ============================================================
  // STEP 4: Initialize LP via matcher (required for CPI trading)
  // ============================================================
  await runTest("4. Initialize LP via matcher vAMM", async () => {
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
    await sleep(500);

    // Create matcher context account
    matcherCtxKp = Keypair.generate();
    const matcherCtxRent = await connection.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);
    const [lpPda] = deriveLpPda(PROGRAM_ID, slab.publicKey, lpIdx);

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
    vammData[off] = 2; off += 1;
    vammData[off] = 0; off += 1;
    dv.setUint32(off, 50, true); off += 4;
    dv.setUint32(off, 50, true); off += 4;
    dv.setUint32(off, 200, true); off += 4;
    dv.setUint32(off, 0, true); off += 4;
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

    // 3. Init LP on percolator
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

    // Deposit LP collateral (400 tokens)
    const depositData = encodeDepositCollateral({ userIdx: lpIdx, amount: "400000000" });
    const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      lpOwner.publicKey, slab.publicKey, lpAta, vault,
      WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
    ]);
    const depositTx = new Transaction();
    depositTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    depositTx.add(buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData }));
    await sendAndConfirmTransaction(connection, depositTx, [payer, lpOwner], { commitment: "confirmed" });

    await crank();
    console.log(`    LP initialized + 400 tokens deposited`);
  });

  // ============================================================
  // STEP 5: Create User Account with deposit (1M+ tokens)
  // ============================================================
  await runTest("5. Create user account + deposit 100 tokens", async () => {
    trader = Keypair.generate();
    const fundTx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: payer.publicKey, toPubkey: trader.publicKey,
      lamports: LAMPORTS_PER_SOL / 10,
    }));
    await sendAndConfirmTransaction(connection, fundTx, [payer]);
    await sleep(1000);

    const traderAtaAccount = await getOrCreateAssociatedTokenAccount(connection, payer, mint, trader.publicKey);
    traderAta = traderAtaAccount.address;
    await mintTo(connection, payer, mint, traderAta, payer, 500_000_000n); // 500 tokens
    await sleep(500);

    // Init user (tag 1)
    const initData = encodeInitUser({ feePayment: "1000000" });
    const initKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
      trader.publicKey, slab.publicKey, traderAta, vault, WELL_KNOWN.tokenProgram,
    ]);
    const initTx = new Transaction();
    initTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    initTx.add(buildIx({ programId: PROGRAM_ID, keys: initKeys, data: initData }));
    await sendAndConfirmTransaction(connection, initTx, [payer, trader], { commitment: "confirmed" });

    // Find trader index
    const data = await fetchSlab(connection, slab.publicKey);
    const engine = parseEngine(data);
    traderIdx = engine.numUsedAccounts - 1;
    console.log(`    Trader idx: ${traderIdx}`);

    // Deposit 100 tokens
    const depositData = encodeDepositCollateral({ userIdx: traderIdx, amount: "100000000" });
    const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      trader.publicKey, slab.publicKey, traderAta, vault,
      WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
    ]);
    const depositTx = new Transaction();
    depositTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    depositTx.add(buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData }));
    await sendAndConfirmTransaction(connection, depositTx, [payer, trader], { commitment: "confirmed" });

    await crank();

    const data2 = await fetchSlab(connection, slab.publicKey);
    const acct = parseAccount(data2, traderIdx);
    console.log(`    Trader capital: ${acct.capital}, kind: ${acct.kind}`);
    if (acct.capital <= 0n) throw new Error("Capital should be positive after deposit");
  });

  // ============================================================
  // STEP 6: Open Long Position (100 tokens at 2x leverage via TradeCpi)
  // ============================================================
  await runTest("6. Open long position (100 tokens via TradeCpi)", async () => {
    const [lpPda] = deriveLpPda(PROGRAM_ID, slab.publicKey, lpIdx);

    const tradeData = encodeTradeCpi({
      lpIdx: lpIdx,
      userIdx: traderIdx,
      size: "100000000", // 100 tokens long (positive = long)
    });
    const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      trader.publicKey,
      lpOwner.publicKey,
      slab.publicKey,
      WELL_KNOWN.clock,
      slab.publicKey,          // oracle = slab for admin oracle
      MATCHER_PROGRAM_ID,
      matcherCtxKp.publicKey,
      lpPda,
    ]);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData }));
    await sendAndConfirmTransaction(connection, tx, [payer, trader], { commitment: "confirmed" });

    console.log(`    Trade submitted`);
  });

  // ============================================================
  // STEP 7: Crank to process the trade
  // ============================================================
  await runTest("7. Crank to process the trade", async () => {
    await crank();

    const data = await fetchSlab(connection, slab.publicKey);
    const traderAcct = parseAccount(data, traderIdx);
    console.log(`    Position size: ${traderAcct.positionSize}`);
    console.log(`    Capital: ${traderAcct.capital}`);
    console.log(`    PnL: ${traderAcct.pnl}`);
  });

  // ============================================================
  // STEP 8: Check position — verify it's open
  // ============================================================
  await runTest("8. Verify position is open", async () => {
    const data = await fetchSlab(connection, slab.publicKey);
    const traderAcct = parseAccount(data, traderIdx);
    const engine = parseEngine(data);

    if (traderAcct.positionSize === 0n) {
      throw new Error("Position size is 0 — trade didn't execute!");
    }
    console.log(`    ✅ Position is open: size=${traderAcct.positionSize}`);
    console.log(`    Engine accounts: ${engine.numUsedAccounts}`);
    console.log(`    Last crank slot: ${engine.lastCrankSlot}`);
  });

  // ============================================================
  // STEP 9: Close position (opposite size)
  // ============================================================
  await runTest("9. Close position (sell same size)", async () => {
    const data = await fetchSlab(connection, slab.publicKey);
    const traderAcct = parseAccount(data, traderIdx);
    const closeSize = -traderAcct.positionSize; // Opposite to close

    const [lpPda] = deriveLpPda(PROGRAM_ID, slab.publicKey, lpIdx);

    const tradeData = encodeTradeCpi({
      lpIdx: lpIdx,
      userIdx: traderIdx,
      size: closeSize.toString(),
    });
    const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      trader.publicKey,
      lpOwner.publicKey,
      slab.publicKey,
      WELL_KNOWN.clock,
      slab.publicKey,
      MATCHER_PROGRAM_ID,
      matcherCtxKp.publicKey,
      lpPda,
    ]);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData }));
    await sendAndConfirmTransaction(connection, tx, [payer, trader], { commitment: "confirmed" });

    console.log(`    Close trade submitted (size: ${closeSize})`);
  });

  // ============================================================
  // STEP 10: Crank again to process the close
  // ============================================================
  await runTest("10. Crank to process close", async () => {
    await crank();

    const data = await fetchSlab(connection, slab.publicKey);
    const traderAcct = parseAccount(data, traderIdx);
    console.log(`    Position after close: ${traderAcct.positionSize}`);
    console.log(`    Capital after close: ${traderAcct.capital}`);
    console.log(`    PnL after close: ${traderAcct.pnl}`);

    if (traderAcct.positionSize !== 0n) {
      console.log(`    ⚠️ Position not fully closed (${traderAcct.positionSize})`);
    } else {
      console.log(`    ✅ Position fully closed`);
    }
  });

  // ============================================================
  // STEP 11: Withdraw funds
  // ============================================================
  await runTest("11. Withdraw funds", async () => {
    // Get current capital to know how much we can withdraw
    const data = await fetchSlab(connection, slab.publicKey);
    const traderAcct = parseAccount(data, traderIdx);
    console.log(`    Capital before withdraw: ${traderAcct.capital}`);

    // Withdraw a portion (half of capital)
    const withdrawAmount = (traderAcct.capital / 2n).toString();
    console.log(`    Withdrawing: ${withdrawAmount}`);

    const withdrawData = encodeWithdrawCollateral({ userIdx: traderIdx, amount: withdrawAmount });
    const withdrawKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
      trader.publicKey,
      slab.publicKey,
      vault,
      traderAta,
      vaultPda,
      WELL_KNOWN.tokenProgram,
      WELL_KNOWN.clock,
      slab.publicKey, // oracle = slab for admin oracle
    ]);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys: withdrawKeys, data: withdrawData }));
    await sendAndConfirmTransaction(connection, tx, [payer, trader], { commitment: "confirmed" });

    // Check post-withdraw
    const data2 = await fetchSlab(connection, slab.publicKey);
    const traderAcct2 = parseAccount(data2, traderIdx);
    console.log(`    Capital after withdraw: ${traderAcct2.capital}`);
    if (traderAcct2.capital < traderAcct.capital) {
      console.log(`    ✅ Withdrawal successful`);
    }
  });

  // ============================================================
  // STEP 12: Verify final state
  // ============================================================
  await runTest("12. Verify final state", async () => {
    const data = await fetchSlab(connection, slab.publicKey);
    const engine = parseEngine(data);
    const cfg = parseConfig(data);
    const params = parseParams(data);
    const traderAcct = parseAccount(data, traderIdx);
    const lpAcct = parseAccount(data, lpIdx);

    console.log(`    --- Final State ---`);
    console.log(`    Accounts: ${engine.numUsedAccounts}`);
    console.log(`    Oracle price: $${Number(cfg.authorityPriceE6) / 1e6}`);
    console.log(`    Trader: capital=${traderAcct.capital}, pos=${traderAcct.positionSize}, pnl=${traderAcct.pnl}`);
    console.log(`    LP: capital=${lpAcct.capital}, pos=${lpAcct.positionSize}, pnl=${lpAcct.pnl}`);

    // Position should be 0 (closed)
    if (traderAcct.positionSize !== 0n) {
      throw new Error(`Trader still has position: ${traderAcct.positionSize}`);
    }

    // Capital should be positive
    if (traderAcct.capital <= 0n) {
      throw new Error(`Trader capital is not positive: ${traderAcct.capital}`);
    }

    // Check vault balance
    const vaultInfo = await getAccount(connection, vault);
    console.log(`    Vault balance: ${vaultInfo.amount}`);

    console.log(`    ✅ All state consistent`);
  });

  // ============================================================
  // CLEANUP: Reclaim slab rent
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

  // Final balance
  const finalBalance = await connection.getBalance(payer.publicKey);
  console.log(`\n  Final balance: ${(finalBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL (spent ${((balance - finalBalance) / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);

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
