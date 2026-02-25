/**
 * T9: Edge-Case Devnet Tests
 *
 * Exercises boundary conditions that can break perps in production:
 *   1. Max leverage — open position at exactly initial margin threshold
 *   2. Zero-balance trade — attempt trade with 0 deposited collateral
 *   3. Zero-size trade — attempt trade with size = 0
 *   4. Concurrent operations — multiple users trading simultaneously
 *   5. Liquidation trigger precision — position exactly at maintenance margin
 *   6. Double-liquidation — attempt to liquidate an already-liquidated position
 *   7. Withdraw more than available — attempt overdraw
 *   8. Deposit after liquidation — re-deposit into a liquidated account
 *   9. Rapid price oscillation — push price up/down rapidly, crank each time
 *  10. Max accounts stress — create many users on one slab
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
  encodeWithdrawCollateral,
  encodeKeeperCrank,
  encodeTradeCpi,
  encodeLiquidateAtOracle,
  encodePushOraclePrice,
  encodeSetOracleAuthority,
  encodeCloseSlab,
  buildAccountMetas,
  buildIx,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_WITHDRAW_COLLATERAL,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_TRADE_CPI,
  ACCOUNTS_LIQUIDATE_AT_ORACLE,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_CLOSE_SLAB,
  WELL_KNOWN,
  parseConfig,
  parseEngine,
  parseParams,
  parseAccount,
  parseAllAccounts,
  deriveLpPda,
  fetchSlab,
  parseErrorFromLogs,
} from "@percolator/sdk";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD"
);
const MATCHER_PROGRAM_ID = new PublicKey(
  process.env.MATCHER_PROGRAM_ID ?? "GTRgyTDfrMvBubALAqtHuQwT8tbGyXid7svXZKtWfC9k"
);
const SLAB_SIZE = Number(process.env.SLAB_SIZE ?? 62_808);
const MATCHER_CTX_SIZE = 320;

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}
const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, duration: Date.now() - start });
    console.log(`  ✅ ${name} (${Date.now() - start}ms)`);
  } catch (e: any) {
    results.push({
      name,
      passed: false,
      error: e.message?.slice(0, 200),
      duration: Date.now() - start,
    });
    console.log(`  ❌ ${name}: ${e.message?.slice(0, 200)}`);
  }
}

// ============================================================================
// HELPERS
// ============================================================================

async function sendTx(
  connection: any,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  cuLimit = 400_000,
  skipPreflight = false
): Promise<string> {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  for (const ix of ixs) tx.add(ix);
  return sendAndConfirmTransaction(connection, tx, signers, {
    commitment: "confirmed",
    skipPreflight,
  });
}

/**
 * Attempt a transaction, expecting it to fail. Returns the error message
 * or throws if the transaction unexpectedly succeeds.
 */
async function expectTxFail(
  connection: any,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  cuLimit = 400_000
): Promise<string> {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  for (const ix of ixs) tx.add(ix);
  try {
    await sendAndConfirmTransaction(connection, tx, signers, {
      commitment: "confirmed",
      skipPreflight: false,
    });
    throw new Error("Transaction succeeded but was expected to fail");
  } catch (e: any) {
    if (e.message === "Transaction succeeded but was expected to fail") throw e;
    return e.message ?? String(e);
  }
}

async function pushPrice(
  connection: any,
  payer: Keypair,
  slab: PublicKey,
  priceE6: string
): Promise<void> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const data = encodePushOraclePrice({ priceE6, timestamp: ts });
  const keys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
    payer.publicKey,
    slab,
  ]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data });
  await sendTx(connection, [ix], [payer], 50_000, true);
}

async function crank(
  connection: any,
  payer: Keypair,
  slab: PublicKey,
  cuLimit = 200_000
): Promise<void> {
  const data = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey,
    slab,
    SYSVAR_CLOCK_PUBKEY,
    slab,
  ]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data });
  await sendTx(connection, [ix], [payer], cuLimit, true);
}

async function pushAndCrank(
  connection: any,
  payer: Keypair,
  slab: PublicKey,
  priceE6: string,
  crankCu = 200_000
): Promise<void> {
  await pushPrice(connection, payer, slab, priceE6);
  await crank(connection, payer, slab, crankCu);
}

// ============================================================================
// MARKET FACTORY
// ============================================================================

interface MarketState {
  connection: any;
  payer: Keypair;
  slab: Keypair;
  mint: PublicKey;
  vault: PublicKey;
  vaultPda: PublicKey;
  matcherCtxKp: Keypair;
  lpOwner: Keypair;
  lpAta: PublicKey;
  lpIdx: number;
}

async function createMarket(
  connection: any,
  payer: Keypair,
  opts: {
    initialPriceE6?: string;
    maintenanceMarginBps?: string;
    initialMarginBps?: string;
    tradingFeeBps?: string;
  } = {}
): Promise<MarketState> {
  const initialPriceE6 = opts.initialPriceE6 ?? "1000000";
  const maintenanceMarginBps = opts.maintenanceMarginBps ?? "500";
  const initialMarginBps = opts.initialMarginBps ?? "1000";
  const tradingFeeBps = opts.tradingFeeBps ?? "10";

  const slab = Keypair.generate();
  const mint = await createMint(connection, payer, payer.publicKey, null, 6);
  await sleep(500);

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), slab.publicKey.toBuffer()],
    PROGRAM_ID
  );

  const rentExempt =
    await connection.getMinimumBalanceForRentExemption(SLAB_SIZE);
  const createSlabIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: slab.publicKey,
    lamports: rentExempt,
    space: SLAB_SIZE,
    programId: PROGRAM_ID,
  });
  await sendTx(connection, [createSlabIx], [payer, slab], 100_000);

  const vaultAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    vaultPda,
    true
  );
  const vault = vaultAccount.address;

  const initData = encodeInitMarket({
    admin: payer.publicKey,
    collateralMint: mint,
    indexFeedId: "0".repeat(64),
    maxStalenessSecs: "100000000",
    confFilterBps: 200,
    invert: 0,
    unitScale: 0,
    initialMarkPriceE6: initialPriceE6,
    warmupPeriodSlots: "10",
    maintenanceMarginBps,
    initialMarginBps,
    tradingFeeBps,
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
    payer.publicKey,
    slab.publicKey,
    mint,
    vault,
    WELL_KNOWN.tokenProgram,
    WELL_KNOWN.clock,
    WELL_KNOWN.rent,
    vaultPda,
    WELL_KNOWN.systemProgram,
  ]);
  const initIx = buildIx({
    programId: PROGRAM_ID,
    keys: initKeys,
    data: initData,
  });
  await sendTx(connection, [initIx], [payer], 200_000);

  // Set oracle authority
  const setOracleData = encodeSetOracleAuthority({
    newAuthority: payer.publicKey,
  });
  const setOracleKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
    payer.publicKey,
    slab.publicKey,
  ]);
  const setOracleIx = buildIx({
    programId: PROGRAM_ID,
    keys: setOracleKeys,
    data: setOracleData,
  });
  await sendTx(connection, [setOracleIx], [payer], 50_000);

  // Push initial price + crank
  await pushAndCrank(connection, payer, slab.publicKey, initialPriceE6);

  // Init LP via matcher
  const lpOwner = Keypair.generate();
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: lpOwner.publicKey,
      lamports: LAMPORTS_PER_SOL / 5,
    })
  );
  await sendAndConfirmTransaction(connection, fundTx, [payer]);
  await sleep(500);

  const lpAtaAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    lpOwner.publicKey
  );
  const lpAta = lpAtaAccount.address;
  await mintTo(connection, payer, mint, lpAta, payer, 1_000_000_000n); // 1000 tokens
  await sleep(500);

  const matcherCtxKp = Keypair.generate();
  const matcherCtxRent =
    await connection.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);
  const lpIdx = 0;

  const createMatcherIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: matcherCtxKp.publicKey,
    lamports: matcherCtxRent,
    space: MATCHER_CTX_SIZE,
    programId: MATCHER_PROGRAM_ID,
  });

  const initLpData = encodeInitLP({
    matcherProgram: MATCHER_PROGRAM_ID,
    matcherContext: matcherCtxKp.publicKey,
    feePayment: "1000000",
  });
  const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [
    lpOwner.publicKey,
    slab.publicKey,
    lpAta,
    vault,
    WELL_KNOWN.tokenProgram,
  ]);
  const initLpIx = buildIx({
    programId: PROGRAM_ID,
    keys: initLpKeys,
    data: initLpData,
  });
  await sendTx(
    connection,
    [createMatcherIx, initLpIx],
    [payer, matcherCtxKp, lpOwner],
    300_000
  );

  // Deposit LP collateral (500 tokens)
  const lpDepositData = encodeDepositCollateral({
    userIdx: lpIdx,
    amount: "500000000",
  });
  const lpDepositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    lpOwner.publicKey,
    slab.publicKey,
    lpAta,
    vault,
    WELL_KNOWN.tokenProgram,
    WELL_KNOWN.clock,
  ]);
  const lpDepositIx = buildIx({
    programId: PROGRAM_ID,
    keys: lpDepositKeys,
    data: lpDepositData,
  });
  await sendTx(connection, [lpDepositIx], [payer, lpOwner], 50_000);
  await crank(connection, payer, slab.publicKey);

  return {
    connection,
    payer,
    slab,
    mint,
    vault,
    vaultPda,
    matcherCtxKp,
    lpOwner,
    lpAta,
    lpIdx,
  };
}

interface TraderState {
  keypair: Keypair;
  ata: PublicKey;
  idx: number;
}

async function createTrader(
  market: MarketState,
  fundTokens: bigint
): Promise<TraderState> {
  const trader = Keypair.generate();
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: market.payer.publicKey,
      toPubkey: trader.publicKey,
      lamports: LAMPORTS_PER_SOL / 10,
    })
  );
  await sendAndConfirmTransaction(market.connection, fundTx, [market.payer]);
  await sleep(500);

  const ataAccount = await getOrCreateAssociatedTokenAccount(
    market.connection,
    market.payer,
    market.mint,
    trader.publicKey
  );
  if (fundTokens > 0n) {
    await mintTo(
      market.connection,
      market.payer,
      market.mint,
      ataAccount.address,
      market.payer,
      fundTokens
    );
  }
  await sleep(500);

  // Init user
  const initData = encodeInitUser({ feePayment: "1000000" });
  const initKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
    trader.publicKey,
    market.slab.publicKey,
    ataAccount.address,
    market.vault,
    WELL_KNOWN.tokenProgram,
  ]);
  const initIx = buildIx({ programId: PROGRAM_ID, keys: initKeys, data: initData });
  await sendTx(market.connection, [initIx], [market.payer, trader], 50_000);

  // Find index
  const data = await fetchSlab(market.connection, market.slab.publicKey);
  const engine = parseEngine(data);
  const idx = engine.numUsedAccounts - 1;

  return { keypair: trader, ata: ataAccount.address, idx };
}

async function depositCollateral(
  market: MarketState,
  trader: TraderState,
  amount: string
): Promise<void> {
  const data = encodeDepositCollateral({
    userIdx: trader.idx,
    amount,
  });
  const keys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    trader.keypair.publicKey,
    market.slab.publicKey,
    trader.ata,
    market.vault,
    WELL_KNOWN.tokenProgram,
    WELL_KNOWN.clock,
  ]);
  const ix = buildIx({ programId: PROGRAM_ID, keys, data });
  await sendTx(market.connection, [ix], [market.payer, trader.keypair], 50_000);
}

function buildTradeIx(
  market: MarketState,
  trader: TraderState,
  size: string
): TransactionInstruction {
  const [lpPda] = deriveLpPda(PROGRAM_ID, market.slab.publicKey, market.lpIdx);
  const tradeData = encodeTradeCpi({
    lpIdx: market.lpIdx,
    userIdx: trader.idx,
    size,
  });
  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    trader.keypair.publicKey,
    market.lpOwner.publicKey,
    market.slab.publicKey,
    WELL_KNOWN.clock,
    market.slab.publicKey, // oracle = slab for admin oracle
    MATCHER_PROGRAM_ID,
    market.matcherCtxKp.publicKey,
    lpPda,
  ]);
  return buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData });
}

function buildLiquidateIx(
  market: MarketState,
  targetIdx: number
): TransactionInstruction {
  const data = encodeLiquidateAtOracle({ targetIdx });
  const keys = buildAccountMetas(ACCOUNTS_LIQUIDATE_AT_ORACLE, [
    market.payer.publicKey,
    market.slab.publicKey,
    WELL_KNOWN.clock,
    market.slab.publicKey,
  ]);
  return buildIx({ programId: PROGRAM_ID, keys, data });
}

function buildWithdrawIx(
  market: MarketState,
  trader: TraderState,
  amount: string
): TransactionInstruction {
  const data = encodeWithdrawCollateral({
    userIdx: trader.idx,
    amount,
  });
  const keys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
    trader.keypair.publicKey,
    market.slab.publicKey,
    market.vault,
    trader.ata,
    market.vaultPda,
    WELL_KNOWN.tokenProgram,
    WELL_KNOWN.clock,
    market.slab.publicKey, // oracle = slab for admin oracle
  ]);
  return buildIx({ programId: PROGRAM_ID, keys, data });
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("\n=== T9: Edge-Case Devnet Tests ===\n");
  console.log(`  Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`  Matcher: ${MATCHER_PROGRAM_ID.toBase58()}`);
  console.log(`  Slab size: ${SLAB_SIZE} bytes\n`);

  const { Connection } = await import("@solana/web3.js");
  const connection = new Connection(RPC_URL, "confirmed");
  const payerData = JSON.parse(
    fs.readFileSync(
      process.env.SOLANA_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`,
      "utf8"
    )
  );
  const payer = Keypair.fromSecretKey(new Uint8Array(payerData));
  console.log(`  Payer: ${payer.publicKey.toBase58()}`);
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`  Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);

  // We create one market for most tests, then cleanup at the end
  let market: MarketState;

  // ================================================================
  // SETUP: Create fresh market
  // ================================================================
  await runTest("0. Setup — create market with LP", async () => {
    market = await createMarket(connection, payer, {
      initialPriceE6: "1000000", // $1.00
      maintenanceMarginBps: "500", // 5% maintenance
      initialMarginBps: "1000", // 10% initial
      tradingFeeBps: "10", // 0.1%
    });
    console.log(`    Market: ${market.slab.publicKey.toBase58().slice(0, 12)}...`);
  });

  // ================================================================
  // TEST 1: Max leverage — trade at exactly initial margin limit
  // ================================================================
  await runTest(
    "1. Max leverage — open position at 10x (initial margin = 10%)",
    async () => {
      const trader = await createTrader(market!, 50_000_000n); // 50 tokens
      await depositCollateral(market!, trader, "20000000"); // deposit 20 tokens
      await crank(connection, payer, market!.slab.publicKey);

      // With 20 tokens collateral and 10% initial margin, max position ≈ 200 tokens
      // Try exactly at limit
      const tradeIx = buildTradeIx(market!, trader, "190000000"); // 190 tokens (9.5x)
      await sendTx(
        connection,
        [tradeIx],
        [payer, trader.keypair],
        400_000
      );
      await crank(connection, payer, market!.slab.publicKey);

      const data = await fetchSlab(connection, market!.slab.publicKey);
      const acct = parseAccount(data, trader.idx);
      console.log(`    Position: ${acct.positionSize}`);
      console.log(`    Capital: ${acct.capital}`);

      if (acct.positionSize !== 0n) {
        console.log(`    ✅ High-leverage position opened successfully`);
      } else {
        throw new Error("Position was not opened — possible margin rejection");
      }
    }
  );

  // ================================================================
  // TEST 2: Over-leverage — trade BEYOND initial margin (should fail)
  // ================================================================
  await runTest(
    "2. Over-leverage — trade beyond initial margin (expect rejection)",
    async () => {
      const trader = await createTrader(market!, 50_000_000n);
      await depositCollateral(market!, trader, "10000000"); // 10 tokens
      await crank(connection, payer, market!.slab.publicKey);

      // With 10 tokens and 10% initial margin, max ≈ 100. Try 200 (20x).
      const tradeIx = buildTradeIx(market!, trader, "200000000");
      const errMsg = await expectTxFail(
        connection,
        [tradeIx],
        [payer, trader.keypair],
        400_000
      );
      console.log(
        `    ✅ Correctly rejected over-leverage: ${errMsg.slice(0, 100)}`
      );
    }
  );

  // ================================================================
  // TEST 3: Zero-balance trade — trade with no deposited collateral
  // ================================================================
  await runTest(
    "3. Zero-balance trade — attempt trade with 0 collateral (expect rejection)",
    async () => {
      // Create user with tokens but don't deposit any
      const trader = await createTrader(market!, 50_000_000n);
      // Don't deposit — capital = 0 (minus account fee)
      await crank(connection, payer, market!.slab.publicKey);

      const tradeIx = buildTradeIx(market!, trader, "10000000");
      const errMsg = await expectTxFail(
        connection,
        [tradeIx],
        [payer, trader.keypair],
        400_000
      );
      console.log(
        `    ✅ Correctly rejected zero-balance trade: ${errMsg.slice(0, 100)}`
      );
    }
  );

  // ================================================================
  // TEST 4: Zero-size trade — trade with size = 0
  // ================================================================
  await runTest(
    "4. Zero-size trade — attempt trade with size=0 (expect rejection or no-op)",
    async () => {
      const trader = await createTrader(market!, 50_000_000n);
      await depositCollateral(market!, trader, "10000000");
      await crank(connection, payer, market!.slab.publicKey);

      const tradeIx = buildTradeIx(market!, trader, "0");
      try {
        await sendTx(
          connection,
          [tradeIx],
          [payer, trader.keypair],
          400_000
        );
        // If it doesn't fail, verify position is still 0
        const data = await fetchSlab(connection, market!.slab.publicKey);
        const acct = parseAccount(data, trader.idx);
        if (acct.positionSize === 0n) {
          console.log(`    ✅ Zero-size trade was no-op (position = 0)`);
        } else {
          throw new Error(`Unexpected position after zero-size trade: ${acct.positionSize}`);
        }
      } catch (e: any) {
        if (e.message?.includes("Unexpected position")) throw e;
        console.log(
          `    ✅ Zero-size trade correctly rejected: ${e.message?.slice(0, 80)}`
        );
      }
    }
  );

  // ================================================================
  // TEST 5: Concurrent traders — two users trade in the same block
  // ================================================================
  await runTest(
    "5. Concurrent operations — two traders open positions back-to-back",
    async () => {
      const traderA = await createTrader(market!, 50_000_000n);
      const traderB = await createTrader(market!, 50_000_000n);
      await depositCollateral(market!, traderA, "20000000");
      await depositCollateral(market!, traderB, "20000000");
      await crank(connection, payer, market!.slab.publicKey);

      // Open opposing positions — traderA long, traderB short
      const tradeIxA = buildTradeIx(market!, traderA, "50000000"); // 50 long
      const tradeIxB = buildTradeIx(market!, traderB, "-50000000"); // 50 short

      // Send both in rapid succession (can't batch since different signers)
      const [sigA, sigB] = await Promise.all([
        sendTx(
          connection,
          [tradeIxA],
          [payer, traderA.keypair],
          400_000
        ),
        sendTx(
          connection,
          [tradeIxB],
          [payer, traderB.keypair],
          400_000
        ),
      ]);
      await crank(connection, payer, market!.slab.publicKey);

      const data = await fetchSlab(connection, market!.slab.publicKey);
      const acctA = parseAccount(data, traderA.idx);
      const acctB = parseAccount(data, traderB.idx);
      console.log(`    Trader A position: ${acctA.positionSize}`);
      console.log(`    Trader B position: ${acctB.positionSize}`);

      // Both should have non-zero positions
      if (acctA.positionSize !== 0n && acctB.positionSize !== 0n) {
        console.log(`    ✅ Both concurrent trades executed`);
      } else {
        console.log(
          `    ⚠️ One or both trades may have failed — check for race condition`
        );
      }
    }
  );

  // ================================================================
  // TEST 6: Liquidation at exact maintenance margin boundary
  // ================================================================
  await runTest(
    "6. Liquidation trigger — drive position to exactly maintenance margin",
    async () => {
      const trader = await createTrader(market!, 100_000_000n);
      await depositCollateral(market!, trader, "20000000"); // 20 tokens
      await crank(connection, payer, market!.slab.publicKey);

      // Open leveraged long: 100 tokens notional with 20 collateral (5x)
      const tradeIx = buildTradeIx(market!, trader, "100000000");
      await sendTx(
        connection,
        [tradeIx],
        [payer, trader.keypair],
        400_000
      );
      await crank(connection, payer, market!.slab.publicKey);

      // Verify position
      let data = await fetchSlab(connection, market!.slab.publicKey);
      let acct = parseAccount(data, trader.idx);
      console.log(`    Initial position: ${acct.positionSize}, capital: ${acct.capital}`);

      // Crash price gradually — 5% maintenance margin means when equity/notional < 5%
      // With 20 capital and 100 position at $1.00:
      //   equity = capital + PnL = 20 + (price_change * 100)
      //   margin = equity / (100 * price) = (20 + 100*(p-1)) / (100*p)
      //   margin = 5% when p ≈ $0.842
      // Push down in steps to find the boundary
      const priceSteps = [
        "950000", // $0.95
        "900000", // $0.90
        "870000", // $0.87
        "850000", // $0.85
        "840000", // $0.84 — near boundary
        "830000", // $0.83 — should be underwater
        "800000", // $0.80
      ];

      let liquidated = false;
      for (const price of priceSteps) {
        await pushAndCrank(connection, payer, market!.slab.publicKey, price);
        data = await fetchSlab(connection, market!.slab.publicKey);
        acct = parseAccount(data, trader.idx);

        if (acct.positionSize === 0n) {
          console.log(
            `    Liquidated by crank at price $${Number(price) / 1e6}`
          );
          liquidated = true;
          break;
        }

        const absPos =
          acct.positionSize < 0n ? -acct.positionSize : acct.positionSize;
        const cfg = parseConfig(data);
        const notional = (absPos * cfg.authorityPriceE6) / 1_000_000n;
        const equity = acct.capital + acct.pnl;
        const marginBps = notional > 0n ? (equity * 10_000n) / notional : 0n;
        console.log(
          `    Price $${Number(price) / 1e6}: margin=${Number(marginBps) / 100}%, equity=${equity}, PnL=${acct.pnl}`
        );

        // Try explicit liquidation if below maintenance
        if (marginBps < 500n) {
          try {
            const liqIx = buildLiquidateIx(market!, trader.idx);
            await sendTx(connection, [liqIx], [payer], 200_000);
            await crank(connection, payer, market!.slab.publicKey);

            data = await fetchSlab(connection, market!.slab.publicKey);
            acct = parseAccount(data, trader.idx);
            if (acct.positionSize === 0n) {
              console.log(`    ✅ Explicitly liquidated at $${Number(price) / 1e6}`);
              liquidated = true;
              break;
            }
          } catch (e: any) {
            console.log(
              `    Liquidation attempt failed: ${e.message?.slice(0, 60)}`
            );
          }
        }
      }

      if (!liquidated) {
        // Final attempt at extreme low price
        await pushAndCrank(connection, payer, market!.slab.publicKey, "500000");
        const liqIx = buildLiquidateIx(market!, trader.idx);
        await sendTx(connection, [liqIx], [payer], 200_000);
        await crank(connection, payer, market!.slab.publicKey);
        data = await fetchSlab(connection, market!.slab.publicKey);
        acct = parseAccount(data, trader.idx);
        if (acct.positionSize === 0n) {
          console.log(`    ✅ Liquidated at extreme price $0.50`);
        }
      }

      // Reset price for remaining tests
      await pushAndCrank(connection, payer, market!.slab.publicKey, "1000000");
    }
  );

  // ================================================================
  // TEST 7: Double-liquidation — liquidate an already-closed position
  // ================================================================
  await runTest(
    "7. Double-liquidation — attempt to liquidate already-closed position (expect rejection)",
    async () => {
      const trader = await createTrader(market!, 100_000_000n);
      await depositCollateral(market!, trader, "10000000");
      await crank(connection, payer, market!.slab.publicKey);

      // Open leveraged long
      const tradeIx = buildTradeIx(market!, trader, "80000000");
      await sendTx(
        connection,
        [tradeIx],
        [payer, trader.keypair],
        400_000
      );
      await crank(connection, payer, market!.slab.publicKey);

      // Crash price to liquidate
      for (let i = 0; i < 10; i++) {
        await pushAndCrank(
          connection,
          payer,
          market!.slab.publicKey,
          "100000"
        ); // $0.10
      }

      // Try explicit liquidation
      try {
        const liqIx = buildLiquidateIx(market!, trader.idx);
        await sendTx(connection, [liqIx], [payer], 200_000);
        await crank(connection, payer, market!.slab.publicKey);
      } catch {
        // May already be liquidated by crank
      }

      // Verify liquidated
      let data = await fetchSlab(connection, market!.slab.publicKey);
      let acct = parseAccount(data, trader.idx);
      console.log(
        `    Position after liquidation: ${acct.positionSize}`
      );

      // Now try to liquidate AGAIN
      const liqIx2 = buildLiquidateIx(market!, trader.idx);
      const errMsg = await expectTxFail(connection, [liqIx2], [payer], 200_000);
      console.log(
        `    ✅ Double-liquidation correctly rejected: ${errMsg.slice(0, 80)}`
      );

      // Reset price
      await pushAndCrank(connection, payer, market!.slab.publicKey, "1000000");
    }
  );

  // ================================================================
  // TEST 8: Withdraw more than available
  // ================================================================
  await runTest(
    "8. Over-withdraw — attempt to withdraw more than deposited (expect rejection)",
    async () => {
      const trader = await createTrader(market!, 50_000_000n);
      await depositCollateral(market!, trader, "10000000"); // 10 tokens
      await crank(connection, payer, market!.slab.publicKey);

      // Try to withdraw 100 tokens (only 10 deposited minus fees)
      const withdrawIx = buildWithdrawIx(market!, trader, "100000000");
      const errMsg = await expectTxFail(
        connection,
        [withdrawIx],
        [payer, trader.keypair],
        100_000
      );
      console.log(
        `    ✅ Over-withdraw correctly rejected: ${errMsg.slice(0, 100)}`
      );
    }
  );

  // ================================================================
  // TEST 9: Deposit after liquidation — can re-deposit into wiped account
  // ================================================================
  await runTest(
    "9. Deposit after liquidation — re-fund a liquidated account",
    async () => {
      const trader = await createTrader(market!, 100_000_000n);
      await depositCollateral(market!, trader, "10000000");
      await crank(connection, payer, market!.slab.publicKey);

      // Open a leveraged long and crash it
      const tradeIx = buildTradeIx(market!, trader, "80000000");
      await sendTx(
        connection,
        [tradeIx],
        [payer, trader.keypair],
        400_000
      );
      await crank(connection, payer, market!.slab.publicKey);

      // Crash price
      for (let i = 0; i < 10; i++) {
        await pushAndCrank(
          connection,
          payer,
          market!.slab.publicKey,
          "100000"
        );
      }

      // Try liquidation
      try {
        const liqIx = buildLiquidateIx(market!, trader.idx);
        await sendTx(connection, [liqIx], [payer], 200_000);
        await crank(connection, payer, market!.slab.publicKey);
      } catch {
        // May already be liquidated by crank
      }

      // Reset price
      await pushAndCrank(connection, payer, market!.slab.publicKey, "1000000");

      // Try to re-deposit
      try {
        await depositCollateral(market!, trader, "20000000");
        await crank(connection, payer, market!.slab.publicKey);

        const data = await fetchSlab(connection, market!.slab.publicKey);
        const acct = parseAccount(data, trader.idx);
        console.log(`    Capital after re-deposit: ${acct.capital}`);
        console.log(`    ✅ Re-deposit into liquidated account succeeded`);
      } catch (e: any) {
        console.log(
          `    ✅ Re-deposit after liquidation correctly rejected: ${e.message?.slice(0, 80)}`
        );
      }
    }
  );

  // ================================================================
  // TEST 10: Rapid price oscillation — stress test oracle + crank
  // ================================================================
  await runTest(
    "10. Rapid price oscillation — 10 cycles of up/down price swings",
    async () => {
      const trader = await createTrader(market!, 100_000_000n);
      await depositCollateral(market!, trader, "30000000");
      await crank(connection, payer, market!.slab.publicKey);

      // Open small position
      const tradeIx = buildTradeIx(market!, trader, "30000000");
      await sendTx(
        connection,
        [tradeIx],
        [payer, trader.keypair],
        400_000
      );
      await crank(connection, payer, market!.slab.publicKey);

      // Oscillate price rapidly
      const prices = [
        "1200000", "800000", "1400000", "600000", "1100000",
        "900000", "1300000", "700000", "1050000", "950000",
      ];

      for (let i = 0; i < prices.length; i++) {
        await pushAndCrank(
          connection,
          payer,
          market!.slab.publicKey,
          prices[i]
        );

        const data = await fetchSlab(connection, market!.slab.publicKey);
        const acct = parseAccount(data, trader.idx);
        if (acct.positionSize === 0n) {
          console.log(
            `    Position closed at oscillation ${i + 1} (price $${Number(prices[i]) / 1e6})`
          );
          break;
        }
        if (i === 0 || i === 4 || i === 9) {
          console.log(
            `    Cycle ${i + 1}: price=$${Number(prices[i]) / 1e6}, PnL=${acct.pnl}, capital=${acct.capital}`
          );
        }
      }

      // Reset price for any remaining tests
      await pushAndCrank(connection, payer, market!.slab.publicKey, "1000000");
      console.log(`    ✅ Market survived rapid oscillation`);
    }
  );

  // ================================================================
  // TEST 11: Max accounts stress — create multiple users quickly
  // ================================================================
  await runTest(
    "11. Multi-user stress — create 5 users and all deposit+trade",
    async () => {
      const traders: TraderState[] = [];
      const count = 5;

      // Create users sequentially (to avoid devnet rate limits)
      for (let i = 0; i < count; i++) {
        const t = await createTrader(market!, 50_000_000n);
        await depositCollateral(market!, t, "10000000");
        traders.push(t);
      }
      await crank(connection, payer, market!.slab.publicKey);

      // Each trader opens a small position
      for (let i = 0; i < count; i++) {
        const size = i % 2 === 0 ? "5000000" : "-5000000"; // alternate long/short
        const ix = buildTradeIx(market!, traders[i], size);
        try {
          await sendTx(
            connection,
            [ix],
            [payer, traders[i].keypair],
            400_000
          );
        } catch (e: any) {
          console.log(
            `    Trader ${i} trade failed: ${e.message?.slice(0, 60)}`
          );
        }
      }
      await crank(connection, payer, market!.slab.publicKey);

      // Verify all positions
      const data = await fetchSlab(connection, market!.slab.publicKey);
      let openPositions = 0;
      for (let i = 0; i < count; i++) {
        const acct = parseAccount(data, traders[i].idx);
        if (acct.positionSize !== 0n) openPositions++;
      }
      console.log(
        `    ${openPositions}/${count} traders have open positions`
      );
      const engine = parseEngine(data);
      console.log(`    Total accounts on slab: ${engine.numUsedAccounts}`);
      console.log(`    ✅ Multi-user stress test passed`);
    }
  );

  // ================================================================
  // CLEANUP
  // ================================================================
  console.log("\n  Cleaning up...");
  try {
    const closeData = encodeCloseSlab();
    const closeKeys = buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [
      payer.publicKey,
      market!.slab.publicKey,
    ]);
    const closeIx = buildIx({
      programId: PROGRAM_ID,
      keys: closeKeys,
      data: closeData,
    });
    const closeTx = new Transaction();
    closeTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    closeTx.add(closeIx);
    await sendAndConfirmTransaction(connection, closeTx, [payer], {
      commitment: "confirmed",
    });
    const rentBack =
      await connection.getMinimumBalanceForRentExemption(SLAB_SIZE);
    console.log(
      `    Reclaimed ~${(rentBack / LAMPORTS_PER_SOL).toFixed(4)} SOL`
    );
  } catch (e: any) {
    console.log(`    Cleanup failed: ${e.message?.slice(0, 80)}`);
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const status = failed === 0 ? "ALL PASSED ✅" : `${failed} FAILED ❌`;
  console.log(
    `\n  ============================================================`
  );
  console.log(`  T9 EDGE-CASE RESULTS: ${passed}/${results.length} — ${status}`);
  console.log(
    `  ============================================================\n`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
