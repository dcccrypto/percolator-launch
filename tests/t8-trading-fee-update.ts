/**
 * T8: Trading Fee Update — Test UpdateRiskParams with optional trading fee field
 *
 * Verifies:
 * - OLD format (17 bytes: tag + initialMarginBps + maintenanceMarginBps) still works
 * - OLD format does NOT change trading_fee_bps
 * - NEW format (25 bytes: + tradingFeeBps) updates the fee
 * - tradingFeeBps > 1000 is rejected (InvalidConfigParam)
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
} from "@solana/spl-token";
import * as fs from "fs";

import {
  encodeInitMarket,
  encodeKeeperCrank,
  encodePushOraclePrice,
  encodeSetOracleAuthority,
  encodeUpdateRiskParams,
  encodeCloseSlab,
  buildAccountMetas,
  buildIx,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_CLOSE_SLAB,
  WELL_KNOWN,
  parseParams,
  fetchSlab,
} from "@percolator/sdk";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? "4dvCZrrPHmimQLDUBLme5CRqa81nGVLzGMwKUAPfXKih");
const SLAB_SIZE = Number(process.env.SLAB_SIZE ?? 62_808);

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
function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`);
}

/**
 * Build a raw UpdateRiskParams instruction manually (to control exact byte length).
 * Tag 22 = UpdateRiskParams
 */
function encodeUpdateRiskParamsRaw(
  initialMarginBps: bigint,
  maintenanceMarginBps: bigint,
  tradingFeeBps?: bigint,
): Uint8Array {
  const hasNewFee = tradingFeeBps !== undefined;
  const size = hasNewFee ? 25 : 17;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  buf[0] = 22; // IX_TAG.UpdateRiskParams
  dv.setBigUint64(1, initialMarginBps, true);
  dv.setBigUint64(9, maintenanceMarginBps, true);
  if (hasNewFee) {
    dv.setBigUint64(17, tradingFeeBps!, true);
  }
  return buf;
}

async function main() {
  console.log("\n=== T8: Trading Fee Update via UpdateRiskParams ===\n");
  console.log(`  Program: ${PROGRAM_ID.toBase58()}\n`);

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

  // ============================================================
  // STEP 1: Create market with default fees (tradingFeeBps=10)
  // ============================================================
  await runTest("1. Create market with default fees (tradingFeeBps=10)", async () => {
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
      admin: payer.publicKey, collateralMint: mint,
      indexFeedId: "0".repeat(64), maxStalenessSecs: "100000000",
      confFilterBps: 200, invert: 0, unitScale: 0,
      initialMarkPriceE6: "1000000", warmupPeriodSlots: "10",
      maintenanceMarginBps: "500", initialMarginBps: "1000",
      tradingFeeBps: "10", maxAccounts: "256",
      newAccountFee: "1000000", riskReductionThreshold: "0",
      maintenanceFeePerSlot: "0", maxCrankStalenessSlots: "200",
      liquidationFeeBps: "100", liquidationFeeCap: "1000000000",
      liquidationBufferBps: "50", minLiquidationAbs: "100000",
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

    // Set oracle + push price + crank
    const setOracleData = encodeSetOracleAuthority({ newAuthority: payer.publicKey });
    const setOracleKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, slab.publicKey]);
    const setOracleTx = new Transaction();
    setOracleTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    setOracleTx.add(buildIx({ programId: PROGRAM_ID, keys: setOracleKeys, data: setOracleData }));
    await sendAndConfirmTransaction(connection, setOracleTx, [payer], { commitment: "confirmed" });

    const ts = Math.floor(Date.now() / 1000).toString();
    const pushData = encodePushOraclePrice({ priceE6: "1000000", timestamp: ts });
    const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slab.publicKey]);
    const pushTx = new Transaction();
    pushTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    pushTx.add(buildIx({ programId: PROGRAM_ID, keys: pushKeys, data: pushData }));
    await sendAndConfirmTransaction(connection, pushTx, [payer], { commitment: "confirmed" });

    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab.publicKey, SYSVAR_CLOCK_PUBKEY, slab.publicKey,
    ]);
    const crankTx = new Transaction();
    crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
    await sendAndConfirmTransaction(connection, crankTx, [payer], { commitment: "confirmed", skipPreflight: true });

    console.log(`    Slab: ${slab.publicKey.toBase58()}`);
  });

  // ============================================================
  // STEP 2: Read current trading_fee_bps
  // ============================================================
  await runTest("2. Read initial trading_fee_bps = 10", async () => {
    const data = await fetchSlab(connection, slab.publicKey);
    const params = parseParams(data);
    console.log(`    trading_fee_bps: ${params.tradingFeeBps}`);
    assertEqual(Number(params.tradingFeeBps), 10, "Initial trading fee");
  });

  // ============================================================
  // STEP 3: UpdateRiskParams OLD format (17 bytes) → should work
  // ============================================================
  await runTest("3. UpdateRiskParams OLD format (17 bytes) → margins change, fee unchanged", async () => {
    // Change margins: initial=1200, maintenance=600
    const updateData = encodeUpdateRiskParamsRaw(1200n, 600n);
    assert(updateData.length === 17, `Expected 17 bytes, got ${updateData.length}`);

    const updateKeys = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: slab.publicKey, isSigner: false, isWritable: true },
    ];
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys: updateKeys, data: updateData }));
    await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });

    const data = await fetchSlab(connection, slab.publicKey);
    const params = parseParams(data);
    assertEqual(Number(params.initialMarginBps), 1200, "Initial margin updated");
    assertEqual(Number(params.maintenanceMarginBps), 600, "Maintenance margin updated");
    assertEqual(Number(params.tradingFeeBps), 10, "Trading fee UNCHANGED");
    console.log(`    Margins updated to 1200/600, fee still 10 ✓`);
  });

  // ============================================================
  // STEP 4: Read trading_fee_bps again → unchanged
  // ============================================================
  await runTest("4. Confirm trading_fee_bps still = 10", async () => {
    const data = await fetchSlab(connection, slab.publicKey);
    const params = parseParams(data);
    assertEqual(Number(params.tradingFeeBps), 10, "Fee unchanged after old format");
  });

  // ============================================================
  // STEP 5: UpdateRiskParams NEW format (25 bytes) → should update fee
  // ============================================================
  await runTest("5. UpdateRiskParams NEW format (25 bytes) → fee updated to 50", async () => {
    const updateData = encodeUpdateRiskParamsRaw(1200n, 600n, 50n);
    assert(updateData.length === 25, `Expected 25 bytes, got ${updateData.length}`);

    const updateKeys = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: slab.publicKey, isSigner: false, isWritable: true },
    ];
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys: updateKeys, data: updateData }));
    await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });

    const data = await fetchSlab(connection, slab.publicKey);
    const params = parseParams(data);
    assertEqual(Number(params.tradingFeeBps), 50, "Trading fee updated to 50");
    console.log(`    Trading fee updated: 10 → 50 ✓`);
  });

  // ============================================================
  // STEP 6: Confirm trading_fee_bps = 50
  // ============================================================
  await runTest("6. Confirm trading_fee_bps = 50", async () => {
    const data = await fetchSlab(connection, slab.publicKey);
    const params = parseParams(data);
    assertEqual(Number(params.tradingFeeBps), 50, "Fee is 50");
  });

  // ============================================================
  // STEP 7: Try trading_fee > 1000 → should fail
  // ============================================================
  await runTest("7. UpdateRiskParams with fee=1500 → should fail (InvalidConfigParam)", async () => {
    const updateData = encodeUpdateRiskParamsRaw(1200n, 600n, 1500n);

    const updateKeys = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: slab.publicKey, isSigner: false, isWritable: true },
    ];
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys: updateKeys, data: updateData }));

    try {
      await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
      throw new Error("Expected failure but tx succeeded — fee > 1000 should be rejected!");
    } catch (e: any) {
      const msg = e.message || String(e);
      // Accept any program error (the specific code depends on implementation)
      const isExpectedError =
        msg.includes("custom program error") ||
        msg.includes("Custom(") ||
        msg.includes("InvalidConfigParam");
      if (msg.includes("Expected failure but tx succeeded")) {
        throw e; // Re-throw our assertion error
      }
      assert(isExpectedError, `Expected program error but got: ${msg.slice(0, 200)}`);
      console.log(`    ✓ Correctly rejected fee=1500 (> 1000 cap)`);
    }

    // Verify fee was NOT changed
    const data = await fetchSlab(connection, slab.publicKey);
    const params = parseParams(data);
    assertEqual(Number(params.tradingFeeBps), 50, "Fee still 50 after rejected update");
  });

  // ============================================================
  // BONUS: Test with core's encodeUpdateRiskParams (uses optional field)
  // ============================================================
  await runTest("8. (Bonus) Core encodeUpdateRiskParams with tradingFeeBps", async () => {
    const updateData = encodeUpdateRiskParams({
      initialMarginBps: "1000",
      maintenanceMarginBps: "500",
      tradingFeeBps: "25",
    });

    const updateKeys = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: slab.publicKey, isSigner: false, isWritable: true },
    ];
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys: updateKeys, data: updateData }));
    await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });

    const data = await fetchSlab(connection, slab.publicKey);
    const params = parseParams(data);
    assertEqual(Number(params.tradingFeeBps), 25, "Fee updated via core encoder");
    assertEqual(Number(params.initialMarginBps), 1000, "Initial margin restored");
    assertEqual(Number(params.maintenanceMarginBps), 500, "Maintenance margin restored");
    console.log(`    Core encoder works: fee=25, margins=1000/500 ✓`);
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
  console.log("\n=== T8 Complete ===\n");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
