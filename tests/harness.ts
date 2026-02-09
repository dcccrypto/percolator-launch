/**
 * Devnet Integration Test Harness for Percolator Launch
 *
 * Adapted from MidTermDev/percolator-sov test harness.
 * Uses @percolator/core for all on-chain interactions.
 *
 * Provides:
 * - Fresh market creation per test
 * - Slot control and waiting
 * - State snapshots with determinism checks
 * - CU measurement
 * - Automatic slab cleanup
 *
 * Usage:
 *   SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=... npx tsx tests/runner.ts
 */

import {
  Connection,
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
  getAssociatedTokenAddress,
  createMint,
  mintTo,
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as crypto from "crypto";

import {
  encodeInitMarket,
  encodeInitUser,
  encodeInitLP,
  encodeDepositCollateral,
  encodeWithdrawCollateral,
  encodeKeeperCrank,
  encodeTradeNoCpi,
  encodeTradeCpi,
  encodeLiquidateAtOracle,
  encodeCloseAccount,
  encodeCloseSlab,
  encodeTopUpInsurance,
  encodePushOraclePrice,
  encodeSetOracleAuthority,
  type InitMarketArgs,
} from "@percolator/core";

import {
  buildAccountMetas,
  buildIx,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_WITHDRAW_COLLATERAL,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_TRADE_NOCPI,
  ACCOUNTS_TRADE_CPI,
  ACCOUNTS_LIQUIDATE_AT_ORACLE,
  ACCOUNTS_CLOSE_ACCOUNT,
  ACCOUNTS_CLOSE_SLAB,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  WELL_KNOWN,
} from "@percolator/core";

import {
  parseHeader,
  parseConfig,
  parseEngine,
  parseParams,
  parseAllAccounts,
  parseUsedIndices,
  type SlabHeader,
  type MarketConfig,
  type EngineState,
  type RiskParams,
  type Account,
} from "@percolator/core";

// ============================================================================
// CONSTANTS
// ============================================================================

export const RPC_URL =
  process.env.SOLANA_RPC_URL ??
  `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY ?? ""}`;

// Active devnet program
export const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "EXsr2Tfz8ntWYP3vgCStdknFBoafvJQugJKAh4nFdo8f"
);

export const CRANK_NO_CALLER = 65535;

// Slab size is fixed at 992,560 for the deployed program (MAX_ACCOUNTS=4096)
// Slab sizes by tier: Small=62808, Medium=248760, Large=992560
// Default to small to conserve devnet SOL
export const SLAB_SIZE = Number(process.env.SLAB_SIZE ?? 62_808);

// Default test parameters
export const DEFAULT_FEE_PAYMENT = "2000000"; // 2 tokens

// ============================================================================
// TYPES
// ============================================================================

export interface TestContext {
  connection: Connection;
  payer: Keypair;
  programId: PublicKey;
  slab: Keypair;
  mint: PublicKey;
  vault: PublicKey;
  vaultPda: PublicKey;
  users: Map<string, UserContext>;
  lps: Map<string, UserContext>;
}

export interface UserContext {
  keypair: Keypair;
  ata: PublicKey;
  accountIndex: number;
}

export interface SlabSnapshot {
  slot: number;
  header: SlabHeader;
  config: MarketConfig;
  engine: EngineState;
  params: RiskParams;
  accounts: { idx: number; account: Account }[];
  usedIndices: number[];
  rawHash: string;
}

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

// ============================================================================
// HARNESS
// ============================================================================

// Cache mints across tests to avoid rate limits
const MINT_CACHE: Map<number, PublicKey> = new Map();

export class TestHarness {
  private connection: Connection;
  private payer: Keypair;
  private results: TestResult[] = [];
  private createdSlabs: Keypair[] = [];

  constructor(payerPath?: string) {
    this.connection = new Connection(RPC_URL, "confirmed");
    const keyPath =
      payerPath || `${process.env.HOME}/.config/solana/id.json`;
    const payerData = JSON.parse(fs.readFileSync(keyPath, "utf8"));
    this.payer = Keypair.fromSecretKey(new Uint8Array(payerData));
  }

  get payerPubkey(): PublicKey {
    return this.payer.publicKey;
  }

  // ==========================================================================
  // MARKET SETUP
  // ==========================================================================

  /**
   * Create a fresh market with admin oracle (no Pyth dependency).
   * Uses all-zero feed ID → program uses admin oracle authority.
   */
  async createFreshMarket(options: {
    decimals?: number;
    initialPriceE6?: string;
  } = {}): Promise<TestContext> {
    const decimals = options.decimals ?? 6;
    const initialPriceE6 = options.initialPriceE6 ?? "1000000"; // $1.00

    const slab = Keypair.generate();
    this.createdSlabs.push(slab);

    // Create or reuse mint
    let mint = MINT_CACHE.get(decimals);
    if (!mint) {
      mint = await createMint(
        this.connection,
        this.payer,
        this.payer.publicKey,
        null,
        decimals
      );
      MINT_CACHE.set(decimals, mint);
      await this.sleep(500);
    }

    // Derive vault PDA
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), slab.publicKey.toBuffer()],
      PROGRAM_ID
    );

    // Allocate slab
    const rentExempt =
      await this.connection.getMinimumBalanceForRentExemption(SLAB_SIZE);
    const createSlabTx = new Transaction();
    createSlabTx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 })
    );
    createSlabTx.add(
      SystemProgram.createAccount({
        fromPubkey: this.payer.publicKey,
        newAccountPubkey: slab.publicKey,
        lamports: rentExempt,
        space: SLAB_SIZE,
        programId: PROGRAM_ID,
      })
    );
    await sendAndConfirmTransaction(
      this.connection,
      createSlabTx,
      [this.payer, slab],
      { commitment: "confirmed" }
    );

    // Create vault ATA
    const vaultAccount = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.payer,
      mint,
      vaultPda,
      true
    );
    const vault = vaultAccount.address;

    // Init market with admin oracle (feed ID = all zeros)
    const initData = encodeInitMarket({
      admin: this.payer.publicKey,
      collateralMint: mint,
      indexFeedId: "0".repeat(64), // All zeros = admin oracle mode
      maxStalenessSecs: "100000000",
      confFilterBps: 200,
      invert: 0,
      unitScale: 0,
      initialMarkPriceE6: initialPriceE6,
      warmupPeriodSlots: "10",
      maintenanceMarginBps: "500",
      initialMarginBps: "1000",
      tradingFeeBps: "10",
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
      this.payer.publicKey,
      slab.publicKey,
      mint,
      vault,
      WELL_KNOWN.tokenProgram,
      WELL_KNOWN.clock,
      WELL_KNOWN.rent,
      vaultPda,
      WELL_KNOWN.systemProgram,
    ]);

    const initTx = new Transaction();
    initTx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })
    );
    initTx.add(buildIx({ programId: PROGRAM_ID, keys: initKeys, data: initData }));
    await sendAndConfirmTransaction(this.connection, initTx, [this.payer], {
      commitment: "confirmed",
    });

    // Set oracle authority to payer (so we can push prices)
    const setOracleData = encodeSetOracleAuthority({
      newAuthority: this.payer.publicKey,
    });
    const setOracleKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
      this.payer.publicKey,
      slab.publicKey,
    ]);
    const setOracleTx = new Transaction();
    setOracleTx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 })
    );
    setOracleTx.add(
      buildIx({ programId: PROGRAM_ID, keys: setOracleKeys, data: setOracleData })
    );
    await sendAndConfirmTransaction(
      this.connection,
      setOracleTx,
      [this.payer],
      { commitment: "confirmed" }
    );

    const ctx: TestContext = {
      connection: this.connection,
      payer: this.payer,
      programId: PROGRAM_ID,
      slab,
      mint,
      vault,
      vaultPda,
      users: new Map(),
      lps: new Map(),
    };

    // Push initial price
    await this.pushOraclePrice(ctx, initialPriceE6);

    // Initial crank
    await this.keeperCrank(ctx);

    return ctx;
  }

  // ==========================================================================
  // ORACLE
  // ==========================================================================

  async pushOraclePrice(ctx: TestContext, priceE6: string): Promise<string> {
    const ts = Math.floor(Date.now() / 1000).toString();
    const data = encodePushOraclePrice({ priceE6, timestamp: ts });
    const keys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
      this.payer.publicKey,
      ctx.slab.publicKey,
    ]);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys, data }));

    return sendAndConfirmTransaction(this.connection, tx, [this.payer], {
      commitment: "confirmed",
      skipPreflight: true,
    });
  }

  // ==========================================================================
  // USER OPERATIONS
  // ==========================================================================

  async createUser(
    ctx: TestContext,
    name: string,
    fundAmount: bigint
  ): Promise<UserContext> {
    const userKp = Keypair.generate();

    // Fund SOL
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.payer.publicKey,
        toPubkey: userKp.publicKey,
        lamports: LAMPORTS_PER_SOL / 10,
      })
    );
    await sendAndConfirmTransaction(this.connection, fundTx, [this.payer]);

    // Create ATA + mint tokens
    const ataAccount = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.payer,
      ctx.mint,
      userKp.publicKey
    );

    if (fundAmount > 0n) {
      await mintTo(
        this.connection,
        this.payer,
        ctx.mint,
        ataAccount.address,
        this.payer,
        fundAmount
      );
    }

    const userCtx: UserContext = {
      keypair: userKp,
      ata: ataAccount.address,
      accountIndex: -1,
    };
    ctx.users.set(name, userCtx);
    return userCtx;
  }

  async initUser(
    ctx: TestContext,
    user: UserContext,
    feePayment: string = DEFAULT_FEE_PAYMENT
  ): Promise<string> {
    const snapBefore = await this.snapshot(ctx);

    const data = encodeInitUser({ feePayment });
    const keys = buildAccountMetas(ACCOUNTS_INIT_USER, [
      user.keypair.publicKey,
      ctx.slab.publicKey,
      user.ata,
      ctx.vault,
      WELL_KNOWN.tokenProgram,
    ]);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys, data }));

    const sig = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [this.payer, user.keypair],
      { commitment: "confirmed" }
    );

    const snapAfter = await this.snapshot(ctx);
    const newIdx = snapAfter.usedIndices.find(
      (idx) => !snapBefore.usedIndices.includes(idx)
    );
    if (newIdx !== undefined) user.accountIndex = newIdx;

    return sig;
  }

  async deposit(
    ctx: TestContext,
    user: UserContext,
    amount: string
  ): Promise<string> {
    const data = encodeDepositCollateral({
      userIdx: user.accountIndex,
      amount,
    });
    const keys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      user.keypair.publicKey,
      ctx.slab.publicKey,
      user.ata,
      ctx.vault,
      WELL_KNOWN.tokenProgram,
      WELL_KNOWN.clock,
    ]);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys, data }));

    return sendAndConfirmTransaction(
      this.connection,
      tx,
      [this.payer, user.keypair],
      { commitment: "confirmed" }
    );
  }

  async withdraw(
    ctx: TestContext,
    user: UserContext,
    amount: string
  ): Promise<string> {
    const data = encodeWithdrawCollateral({
      userIdx: user.accountIndex,
      amount,
    });
    const keys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
      user.keypair.publicKey,
      ctx.slab.publicKey,
      ctx.vault,
      user.ata,
      ctx.vaultPda,
      WELL_KNOWN.tokenProgram,
      WELL_KNOWN.clock,
      ctx.slab.publicKey, // oracle = slab for admin oracle
    ]);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys, data }));

    return sendAndConfirmTransaction(
      this.connection,
      tx,
      [this.payer, user.keypair],
      { commitment: "confirmed" }
    );
  }

  async tradeNoCpi(
    ctx: TestContext,
    user: UserContext,
    lp: UserContext,
    size: string
  ): Promise<string> {
    const data = encodeTradeNoCpi({
      lpIdx: lp.accountIndex,
      userIdx: user.accountIndex,
      size,
    });
    const keys = buildAccountMetas(ACCOUNTS_TRADE_NOCPI, [
      user.keypair.publicKey,
      lp.keypair.publicKey,
      ctx.slab.publicKey,
      WELL_KNOWN.clock,
      ctx.slab.publicKey, // oracle = slab for admin oracle
    ]);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys, data }));

    return sendAndConfirmTransaction(
      this.connection,
      tx,
      [this.payer, user.keypair, lp.keypair],
      { commitment: "confirmed" }
    );
  }

  async keeperCrank(ctx: TestContext, cuLimit = 200_000): Promise<string> {
    const data = encodeKeeperCrank({
      callerIdx: CRANK_NO_CALLER,
      allowPanic: false,
    });
    const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      this.payer.publicKey,
      ctx.slab.publicKey,
      SYSVAR_CLOCK_PUBKEY,
      ctx.slab.publicKey, // oracle = slab for admin oracle
    ]);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys, data }));

    return sendAndConfirmTransaction(this.connection, tx, [this.payer], {
      commitment: "confirmed",
      skipPreflight: true,
    });
  }

  async topUpInsurance(
    ctx: TestContext,
    user: UserContext,
    amount: string
  ): Promise<string> {
    const data = encodeTopUpInsurance({ amount });
    const keys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
      user.keypair.publicKey,
      ctx.slab.publicKey,
      user.ata,
      ctx.vault,
      WELL_KNOWN.tokenProgram,
    ]);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys, data }));

    return sendAndConfirmTransaction(
      this.connection,
      tx,
      [this.payer, user.keypair],
      { commitment: "confirmed" }
    );
  }

  async liquidateAtOracle(
    ctx: TestContext,
    targetIdx: number
  ): Promise<string> {
    const data = encodeLiquidateAtOracle({ targetIdx });
    const keys = buildAccountMetas(ACCOUNTS_LIQUIDATE_AT_ORACLE, [
      this.payer.publicKey,
      ctx.slab.publicKey,
      WELL_KNOWN.clock,
      ctx.slab.publicKey, // oracle = slab for admin oracle
    ]);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(buildIx({ programId: PROGRAM_ID, keys, data }));

    return sendAndConfirmTransaction(this.connection, tx, [this.payer], {
      commitment: "confirmed",
    });
  }

  // ==========================================================================
  // STATE INSPECTION
  // ==========================================================================

  async snapshot(ctx: TestContext): Promise<SlabSnapshot> {
    const slot = await this.connection.getSlot();
    const info = await this.connection.getAccountInfo(ctx.slab.publicKey);
    if (!info) throw new Error("Slab account not found");

    const data = new Uint8Array(info.data);
    const rawHash = crypto
      .createHash("sha256")
      .update(data)
      .digest("hex");

    return {
      slot,
      header: parseHeader(data),
      config: parseConfig(data),
      engine: parseEngine(data),
      params: parseParams(data),
      accounts: parseAllAccounts(data),
      usedIndices: parseUsedIndices(data),
      rawHash,
    };
  }

  // ==========================================================================
  // TEST RUNNER
  // ==========================================================================

  async runTest(
    name: string,
    testFn: () => Promise<void>
  ): Promise<TestResult> {
    const start = Date.now();
    try {
      await testFn();
      const result: TestResult = {
        name,
        passed: true,
        duration: Date.now() - start,
      };
      this.results.push(result);
      console.log(`  ✅ ${name} (${result.duration}ms)`);
      return result;
    } catch (e: any) {
      const result: TestResult = {
        name,
        passed: false,
        error: e.message || String(e),
        duration: Date.now() - start,
      };
      this.results.push(result);
      console.log(`  ❌ ${name}: ${result.error}`);
      return result;
    }
  }

  getSummary() {
    const passed = this.results.filter((r) => r.passed).length;
    const failed = this.results.filter((r) => !r.passed).length;
    return { passed, failed, total: this.results.length, results: this.results };
  }

  // ==========================================================================
  // CLEANUP
  // ==========================================================================

  async cleanup(): Promise<void> {
    if (this.createdSlabs.length === 0) return;
    console.log(
      `\n  Cleaning up ${this.createdSlabs.length} slab(s)...`
    );

    for (const slab of this.createdSlabs) {
      try {
        const info = await this.connection.getAccountInfo(slab.publicKey);
        if (!info) continue;

        const data = encodeCloseSlab();
        const keys = buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [
          this.payer.publicKey,
          slab.publicKey,
        ]);

        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
        tx.add(buildIx({ programId: PROGRAM_ID, keys, data }));

        await sendAndConfirmTransaction(this.connection, tx, [this.payer], {
          commitment: "confirmed",
        });
        console.log(
          `    Closed ${slab.publicKey.toBase58().slice(0, 8)}... (${(info.lamports / LAMPORTS_PER_SOL).toFixed(2)} SOL reclaimed)`
        );
      } catch (e: any) {
        console.log(`    Failed to close slab: ${e.message?.slice(0, 50)}`);
      }
    }
    this.createdSlabs = [];
  }

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  async waitSlots(count: number): Promise<number> {
    const start = await this.connection.getSlot();
    const target = start + count;
    while (true) {
      const current = await this.connection.getSlot();
      if (current >= target) return current;
      await this.sleep(400);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  static assert(condition: boolean, message: string): void {
    if (!condition) throw new Error(`Assertion failed: ${message}`);
  }

  static assertEqual<T>(actual: T, expected: T, message: string): void {
    if (actual !== expected)
      throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

export default TestHarness;
