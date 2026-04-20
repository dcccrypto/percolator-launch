/**
 * Localnet Integration Test Harness
 *
 * Manages a solana-test-validator process with all four Percolator program .so
 * files deployed at their keypair-derived program IDs.  The harness provides
 * the same market/user/LP operations used by the devnet tests but targets the
 * local validator instead of a remote RPC.
 *
 * Program IDs (from target/deploy/*-keypair.json):
 *   percolator: EbDCoGo4RK4oup8LdSawYYxY2aWCAg9ZrHbmB4knu64c
 *   matcher:    AhwKdHjzeE9rn5LtbKLmLpthhRyvtptGCCCqyqKw1Nt7
 *   stake:      9tbLt8fs1C7cJRXAyiGY7Ub88AT7MLWpxLqFNVCkqzA6
 *   nft:        2kYRqexMf5JnwTK15Vj8qxQX3qkBDzBZvH45SVFRmKYU
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
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  ACCOUNT_SIZE as TOKEN_ACCOUNT_SIZE,
} from "@solana/spl-token";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";

import {
  encodeInitMarket,
  encodeInitUser,
  encodeInitLP,
  encodeInitMatcherCtx,
  encodeDepositCollateral,
  encodeKeeperCrank,
  encodeTradeCpi,
  buildAccountMetas,
  buildIx,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_INIT_MATCHER_CTX,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_TRADE_CPI,
  parseHeader,
  parseConfig,
  parseEngine,
  parseParams,
  parseAllAccounts,
  parseUsedIndices,
  deriveLpPda,
  type SlabHeader,
  type MarketConfig,
  type EngineState,
  type RiskParams,
  type Account,
} from "@percolatorct/sdk";

// ============================================================================
// CONSTANTS
// ============================================================================

export const LOCALNET_RPC = "http://127.0.0.1:8899";

/** Program IDs derived from keypair files in each repo's target/deploy/ */
export const LOCAL_PROGRAM_IDS = {
  percolator: new PublicKey("EbDCoGo4RK4oup8LdSawYYxY2aWCAg9ZrHbmB4knu64c"),
  matcher:    new PublicKey("AhwKdHjzeE9rn5LtbKLmLpthhRyvtptGCCCqyqKw1Nt7"),
  stake:      new PublicKey("9tbLt8fs1C7cJRXAyiGY7Ub88AT7MLWpxLqFNVCkqzA6"),
  nft:        new PublicKey("2kYRqexMf5JnwTK15Vj8qxQX3qkBDzBZvH45SVFRmKYU"),
} as const;

/** .so paths relative to each program repo */
const SO_FILES: { programId: PublicKey; soPath: string; keypairPath: string }[] = [
  {
    programId: LOCAL_PROGRAM_IDS.percolator,
    soPath: `${os.homedir()}/percolator-prog/target/deploy/percolator_prog.so`,
    keypairPath: `${os.homedir()}/percolator-prog/target/deploy/percolator_prog-keypair.json`,
  },
  {
    programId: LOCAL_PROGRAM_IDS.matcher,
    soPath: `${os.homedir()}/percolator-match/target/deploy/percolator_match.so`,
    keypairPath: `${os.homedir()}/percolator-match/target/deploy/percolator_match-keypair.json`,
  },
  {
    programId: LOCAL_PROGRAM_IDS.stake,
    soPath: `${os.homedir()}/percolator-stake/target/deploy/percolator_stake.so`,
    keypairPath: `${os.homedir()}/percolator-stake/target/deploy/percolator_stake-keypair.json`,
  },
  {
    programId: LOCAL_PROGRAM_IDS.nft,
    soPath: `${os.homedir()}/percolator-nft/target/deploy/percolator_nft.so`,
    keypairPath: `${os.homedir()}/percolator-nft/target/deploy/percolator_nft-keypair.json`,
  },
];

/**
 * Slab size for the program built with --features small (MAX_ACCOUNTS=256, SBF layout).
 * Verified empirically from the deployed program's sol_log_64 in verify_slab:
 *   Program log: 0x16fd8 = 94168 (SLAB_LEN) vs 0x167d8 = 92120 (SDK tier).
 * The percolator_prog.so in target/deploy/ is rebuilt with `cargo build-sbf -- --features small`
 * which sets MAX_ACCOUNTS=256 and keeps InitMarket within the 1.4M CU limit.
 */
export const SLAB_SIZE = 94_168;

/** Matcher context account size: 64-byte MatcherReturn + 256-byte vAMM state = 320 bytes */
const MATCHER_CTX_SIZE = 320;

export const CRANK_NO_CALLER = 65535;
// InitUser fee_payment must satisfy the deposit_not_atomic materialization
// gate: amount >= min_initial_deposit + new_account_fee. With the InitMarket
// values below (min_initial_deposit=2_000_000, new_account_fee=1_000_000),
// the minimum is 3_000_000. Anything smaller trips InsufficientBalance (0xd)
// at percolator.rs:3024. Real user capital is topped up by a separate
// DepositCollateral call after materialization.
export const DEFAULT_FEE_PAYMENT = "3000000"; // 3 tokens (u64 raw) = min_initial_deposit + new_account_fee

// ============================================================================
// TYPES
// ============================================================================

export interface LocalnetContext {
  connection: Connection;
  payer: Keypair;
  programId: PublicKey;
  matcherProgramId: PublicKey;
  slab: Keypair;
  matcherCtx: Keypair;
  mint: PublicKey;
  vault: PublicKey;
  vaultPda: PublicKey;
  lpPda: PublicKey;
  users: Map<string, UserContext>;
}

export interface UserContext {
  keypair: Keypair;
  ata: PublicKey;
  accountIndex: number;
  isLP: boolean;
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
// VALIDATOR MANAGER
// ============================================================================

/** Manages a solana-test-validator process lifetime. */
export class LocalValidator {
  private proc: ChildProcess | null = null;
  private ledgerDir: string;

  constructor() {
    this.ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "perc-localnet-"));
  }

  /**
   * Start the validator, load all four program .so files, wait until healthy.
   * Uses --bpf-program flags to deploy programs at their keypair-derived IDs
   * without requiring upgrade authority signing.
   */
  async start(): Promise<void> {
    const args: string[] = [
      "--ledger", this.ledgerDir,
      "--reset",
      "--quiet",
      // Aggressively short slot time for faster tests
      "--ticks-per-slot", "8",
      // Bind to localhost only
      "--bind-address", "127.0.0.1",
      "--rpc-port", "8899",
      // Disable unnecessary features for integration tests
      "--limit-ledger-size", "50000000",
    ];

    // Add each program via --bpf-program <program_id> <so_path>
    for (const prog of SO_FILES) {
      if (!fs.existsSync(prog.soPath)) {
        throw new Error(
          `[validator] Missing .so file: ${prog.soPath}\n` +
          `Run 'cargo build-sbf' in the corresponding program repo first.`
        );
      }
      args.push("--bpf-program", prog.programId.toBase58(), prog.soPath);
      console.log(`  [validator] Loading ${prog.programId.toBase58().slice(0, 8)}... from ${path.basename(prog.soPath)}`);
    }

    console.log("  [validator] Spawning solana-test-validator...");
    this.proc = spawn("solana-test-validator", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.proc.stdout?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line) process.stdout.write(`  [validator] ${line}\n`);
    });
    this.proc.stderr?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line) process.stderr.write(`  [validator:err] ${line}\n`);
    });
    this.proc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`  [validator] Exited with code ${code}`);
      }
    });

    await this._waitUntilReady();
    console.log("  [validator] Ready on http://127.0.0.1:8899");
  }

  private async _waitUntilReady(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const conn = new Connection(LOCALNET_RPC, "confirmed");
    while (Date.now() < deadline) {
      try {
        await conn.getSlot();
        return;
      } catch {
        await sleep(500);
      }
    }
    throw new Error("[validator] Timed out waiting for validator to become ready");
  }

  async stop(): Promise<void> {
    if (this.proc) {
      console.log("  [validator] Stopping...");
      this.proc.kill("SIGTERM");
      await sleep(1000);
      this.proc.kill("SIGKILL");
      this.proc = null;
    }
    try {
      fs.rmSync(this.ledgerDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

// ============================================================================
// LOCALNET HARNESS
// ============================================================================

export class LocalnetHarness {
  readonly connection: Connection;
  readonly payer: Keypair;
  private results: TestResult[] = [];
  private createdSlabs: Keypair[] = [];

  constructor() {
    this.connection = new Connection(LOCALNET_RPC, "confirmed");
    // Generate a fresh payer for each test run — no secrets on disk
    this.payer = Keypair.generate();
  }

  get payerPubkey(): PublicKey {
    return this.payer.publicKey;
  }

  // ==========================================================================
  // FUNDING
  // ==========================================================================

  /**
   * Request an airdrop and wait for confirmation.
   * The localnet faucet is unlimited, so 100 SOL is fine for test use.
   */
  async airdrop(pubkey: PublicKey, lamports: number = 200 * LAMPORTS_PER_SOL): Promise<void> {
    const sig = await this.connection.requestAirdrop(pubkey, lamports);
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    await this.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  }

  // ==========================================================================
  // MARKET SETUP
  // ==========================================================================

  /**
   * Bootstrap a complete market with LP slot 0 + matcher context initialized.
   *
   * Flow:
   *   1. Create fresh mint (collateral)
   *   2. Allocate slab account
   *   3. InitMarket (admin oracle mode, all-zero feed ID)
   *   4. SetOracleAuthority → payer
   *   5. PushOraclePrice (initial price)
   *   6. Allocate matcher context account (owned by matcher program)
   *   7. InitLP (LP slot 0, links to matcher context)
   *   8. InitMatcherCtx (CPI to matcher to initialize vAMM state)
   *   9. KeeperCrank (first crank)
   *
   * Returns a LocalnetContext ready for user/trade operations.
   */
  async createMarket(options: {
    initialPriceE6?: bigint;
    lpSeedDeposit?: bigint;
    decimals?: number;
  } = {}): Promise<LocalnetContext> {
    const {
      initialPriceE6 = 1_000_000n,   // $1.00
      lpSeedDeposit = 50_000_000n,    // 50 tokens
      decimals = 6,
    } = options;

    const programId = LOCAL_PROGRAM_IDS.percolator;
    const matcherProgramId = LOCAL_PROGRAM_IDS.matcher;

    // Airdrop payer
    await this.airdrop(this.payer.publicKey);

    // Create collateral mint (payer is mint authority)
    console.log("  [market] Creating collateral mint...");
    const mint = await createMint(
      this.connection,
      this.payer,
      this.payer.publicKey,
      null,
      decimals
    );

    // Create admin ATA + mint tokens for LP seed deposit
    const adminAta = (await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.payer,
      mint,
      this.payer.publicKey
    )).address;

    await mintTo(this.connection, this.payer, mint, adminAta, this.payer, lpSeedDeposit + 100_000_000n);

    // Generate fresh keypairs
    const slab = Keypair.generate();
    const matcherCtxKp = Keypair.generate();
    this.createdSlabs.push(slab);

    // Derive PDAs
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), slab.publicKey.toBuffer()],
      programId
    );
    const [lpPda] = deriveLpPda(programId, slab.publicKey, 0);

    // Create vault ATA (owned by vaultPda)
    console.log("  [market] Creating vault ATA...");
    const vaultAccount = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.payer,
      mint,
      vaultPda,
      true
    );
    const vault = vaultAccount.address;

    // ── Step 1: Allocate slab + InitMarket ──────────────────────────────────
    console.log("  [market] Allocating slab + InitMarket...");
    const slabRent = await this.connection.getMinimumBalanceForRentExemption(SLAB_SIZE);

    const initMarketData = encodeInitMarket({
      admin: this.payer.publicKey,
      collateralMint: mint,
      indexFeedId: "0".repeat(64), // all-zeros = admin oracle mode
      maxStalenessSecs: 604_800n,  // 7 days (program maximum: max_staleness_secs <= 7*86400)
      confFilterBps: 0,
      invert: 0,
      unitScale: 0,
      initialMarkPriceE6: initialPriceE6,
      maxInsuranceFloor: 1_000_000_000_000n,
      minOraclePriceCap: 500n,
      hMin: 10n,
      hMax: 100n,
      maintenanceMarginBps: 500n,
      initialMarginBps: 1000n,
      tradingFeeBps: 10n,
      maxAccounts: 256n,
      newAccountFee: 1_000_000n,
      maintenanceFeePerSlot: 0n,
      maxCrankStalenessSlots: 300n,
      liquidationFeeBps: 50n,
      liquidationFeeCap: 100_000_000n,
      minLiquidationAbs: 100n,
      minInitialDeposit: 2_000_000n,   // 2 tokens minimum to open account
      minNonzeroMmReq: 100_000n,
      minNonzeroImReq: 500_000n,
    });

    const tx1 = new Transaction();
    tx1.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    tx1.add(SystemProgram.createAccount({
      fromPubkey: this.payer.publicKey,
      newAccountPubkey: slab.publicKey,
      lamports: slabRent,
      space: SLAB_SIZE,
      programId,
    }));
    tx1.add(new TransactionInstruction({
      programId,
      keys: buildAccountMetas(ACCOUNTS_INIT_MARKET, {
        admin: this.payer.publicKey,
        slab: slab.publicKey,
        mint,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        clock: SYSVAR_CLOCK_PUBKEY,
        rent: SYSVAR_RENT_PUBKEY,
        dummyAta: adminAta,
        systemProgram: SystemProgram.programId,
      }),
      data: Buffer.from(initMarketData),
    }));
    await sendAndConfirmTransaction(this.connection, tx1, [this.payer, slab], { commitment: "confirmed" });
    console.log(`  [market] Slab: ${slab.publicKey.toBase58()}`);

    // ── Step 2: Allocate matcher context account ─────────────────────────────
    // Note: InitMarket with initialMarkPriceE6 sets the oracle price directly in
    // the slab header. No separate oracle push instruction is needed for localnet
    // (encodePushOraclePrice / encodeSetOracleAuthority were removed in SDK beta.29+
    // as part of the Phase G admin-oracle removal).
    console.log("  [market] Allocating matcher context account...");
    const ctxRent = await this.connection.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);
    const allocCtxTx = new Transaction();
    allocCtxTx.add(SystemProgram.createAccount({
      fromPubkey: this.payer.publicKey,
      newAccountPubkey: matcherCtxKp.publicKey,
      lamports: ctxRent,
      space: MATCHER_CTX_SIZE,
      programId: matcherProgramId,
    }));
    await sendAndConfirmTransaction(this.connection, allocCtxTx, [this.payer, matcherCtxKp], { commitment: "confirmed" });
    console.log(`  [market] MatcherCtx: ${matcherCtxKp.publicKey.toBase58()}`);

    // ── Step 5: InitLP ───────────────────────────────────────────────────────
    console.log("  [market] InitLP (LP slot 0)...");
    const tx3 = new Transaction();
    tx3.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
    tx3.add(new TransactionInstruction({
      programId,
      keys: buildAccountMetas(ACCOUNTS_INIT_LP, {
        user: this.payer.publicKey,
        slab: slab.publicKey,
        userAta: adminAta,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        clock: SYSVAR_CLOCK_PUBKEY,
      }),
      data: Buffer.from(encodeInitLP({
        matcherProgram: matcherProgramId,
        matcherContext: matcherCtxKp.publicKey,
        feePayment: lpSeedDeposit,
      })),
    }));
    await sendAndConfirmTransaction(this.connection, tx3, [this.payer], { commitment: "confirmed" });
    console.log("  [market] LP slot 0 registered");

    // ── Step 6: InitMatcherCtx ───────────────────────────────────────────────
    console.log("  [market] InitMatcherCtx (CPI to matcher)...");
    const tx4 = new Transaction();
    tx4.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx4.add(new TransactionInstruction({
      programId,
      keys: buildAccountMetas(ACCOUNTS_INIT_MATCHER_CTX, {
        admin: this.payer.publicKey,
        slab: slab.publicKey,
        matcherCtx: matcherCtxKp.publicKey,
        matcherProg: matcherProgramId,
        lpPda,
      }),
      data: Buffer.from(encodeInitMatcherCtx({
        lpIdx: 0,
        kind: 0,               // Passive matcher
        tradingFeeBps: 30,
        baseSpreadBps: 10,
        maxTotalBps: 200,
        impactKBps: 100,
        liquidityNotionalE6: 1_000_000_000n,
        maxFillAbs: BigInt("170141183460469231731687303715884105727"), // i128::MAX (validate() requires <= i128::MAX)
        maxInventoryAbs: 10_000_000_000n,
        feeToInsuranceBps: 2000,
        skewSpreadMultBps: 5000,
      })),
    }));
    {
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
      tx4.recentBlockhash = blockhash;
      tx4.lastValidBlockHeight = lastValidBlockHeight;
      tx4.feePayer = this.payer.publicKey;
      tx4.sign(this.payer);
      const rawTx = tx4.serialize();
      const sig4 = await this.connection.sendRawTransaction(rawTx, { skipPreflight: true });
      console.log(`  [market] InitMatcherCtx sig: ${sig4}`);
      // Poll for confirmation and collect logs
      let confirmed = false;
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        const status = await this.connection.getSignatureStatuses([sig4]);
        const s = status.value[0];
        if (s) {
          if (s.err) {
            // Fetch full transaction logs
            const txInfo = await this.connection.getTransaction(sig4, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
            if (txInfo?.meta?.logMessages) {
              console.error("  [matcher] Transaction logs:");
              for (const line of txInfo.meta.logMessages) {
                console.error(`    ${line}`);
              }
            }
            throw new Error(`InitMatcherCtx failed: ${JSON.stringify(s.err)}`);
          }
          if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") {
            confirmed = true;
            break;
          }
        }
      }
      if (!confirmed) throw new Error("InitMatcherCtx: confirmation timeout");
    }
    console.log("  [market] Matcher context initialized");

    // ── Step 7: First keeper crank ───────────────────────────────────────────
    await this._keeperCrank(programId, slab.publicKey);

    const ctx: LocalnetContext = {
      connection: this.connection,
      payer: this.payer,
      programId,
      matcherProgramId,
      slab,
      matcherCtx: matcherCtxKp,
      mint,
      vault,
      vaultPda,
      lpPda,
      users: new Map(),
    };

    console.log("  [market] Market ready");
    return ctx;
  }

  // ==========================================================================
  // KEEPER CRANK
  // ==========================================================================

  private async _keeperCrank(
    programId: PublicKey,
    slabPk: PublicKey,
    cuLimit = 400_000
  ): Promise<string> {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    tx.add(buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
        this.payer.publicKey,
        slabPk,
        SYSVAR_CLOCK_PUBKEY,
        slabPk, // oracle = slab for admin oracle
      ]),
      data: encodeKeeperCrank({ callerIdx: CRANK_NO_CALLER }),
    }));
    return sendAndConfirmTransaction(this.connection, tx, [this.payer], {
      commitment: "confirmed",
      skipPreflight: true,
    });
  }

  async keeperCrank(ctx: LocalnetContext): Promise<string> {
    return this._keeperCrank(ctx.programId, ctx.slab.publicKey);
  }

  // ==========================================================================
  // USER OPERATIONS
  // ==========================================================================

  /** Create, fund, init, and deposit collateral for a test user. */
  async createUser(
    ctx: LocalnetContext,
    name: string,
    tokenAmount: bigint,
    depositAmount: bigint
  ): Promise<UserContext> {
    const userKp = Keypair.generate();

    // Fund SOL for tx fees
    await this.airdrop(userKp.publicKey, LAMPORTS_PER_SOL / 2);

    // Create ATA and mint tokens
    const ataAccount = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.payer,
      ctx.mint,
      userKp.publicKey
    );
    await mintTo(this.connection, this.payer, ctx.mint, ataAccount.address, this.payer, tokenAmount);

    const userCtx: UserContext = {
      keypair: userKp,
      ata: ataAccount.address,
      accountIndex: -1,
      isLP: false,
    };

    // InitUser
    console.log(`  [user:${name}] InitUser...`);
    const snapBefore = await this.snapshot(ctx);
    const initData = encodeInitUser({ feePayment: DEFAULT_FEE_PAYMENT });
    const initTx = new Transaction();
    initTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
    initTx.add(buildIx({
      programId: ctx.programId,
      keys: buildAccountMetas(ACCOUNTS_INIT_USER, [
        userKp.publicKey,
        ctx.slab.publicKey,
        ataAccount.address,
        ctx.vault,
        TOKEN_PROGRAM_ID,
        SYSVAR_CLOCK_PUBKEY,
      ]),
      data: initData,
    }));
    const sig = await sendAndConfirmTransaction(
      this.connection,
      initTx,
      [this.payer, userKp],
      { commitment: "confirmed" }
    );
    console.log(`  [user:${name}] InitUser sig: ${sig.slice(0, 20)}...`);

    // Discover account index
    const snapAfter = await this.snapshot(ctx);
    const newIdx = snapAfter.usedIndices.find((idx) => !snapBefore.usedIndices.includes(idx));
    if (newIdx !== undefined) {
      userCtx.accountIndex = newIdx;
    } else {
      throw new Error(`[user:${name}] Could not determine account index after InitUser`);
    }
    console.log(`  [user:${name}] Account index: ${userCtx.accountIndex}`);

    // DepositCollateral
    if (depositAmount > 0n) {
      console.log(`  [user:${name}] Depositing ${depositAmount} tokens...`);
      const depData = encodeDepositCollateral({ userIdx: userCtx.accountIndex, amount: depositAmount });
      const depTx = new Transaction();
      depTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
      depTx.add(buildIx({
        programId: ctx.programId,
        keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
          userKp.publicKey,
          ctx.slab.publicKey,
          ataAccount.address,
          ctx.vault,
          TOKEN_PROGRAM_ID,
          SYSVAR_CLOCK_PUBKEY,
        ]),
        data: depData,
      }));
      const depSig = await sendAndConfirmTransaction(
        this.connection,
        depTx,
        [this.payer, userKp],
        { commitment: "confirmed" }
      );
      console.log(`  [user:${name}] Deposit sig: ${depSig.slice(0, 20)}...`);
    }

    ctx.users.set(name, userCtx);
    return userCtx;
  }

  // ==========================================================================
  // LP OPERATIONS (for TradeCpi — LP slot 0 is the admin, index discovery)
  // ==========================================================================

  /**
   * Read LP account index from the slab (LP slot 0, created by the admin).
   * After InitLP the account at the lowest new index is the LP.
   */
  async getLpAccountIndex(ctx: LocalnetContext, snapBeforeInitLP: SlabSnapshot): Promise<number> {
    const snap = await this.snapshot(ctx);
    const newIdx = snap.usedIndices.find((idx) => !snapBeforeInitLP.usedIndices.includes(idx));
    if (newIdx === undefined) throw new Error("Could not find LP account index after InitLP");
    return newIdx;
  }

  // ==========================================================================
  // TRADE
  // ==========================================================================

  /**
   * Execute TradeCpi — the main perp trade path via the matcher program.
   * userIdx and lpIdx must both be valid account indices.
   * lpOwner is the LP account's owner (the payer/admin for slot 0).
   *
   * For buys: size > 0. For sells: size < 0 (as a bigint negative).
   * limitPriceE6 = 0 accepts any price (no slippage protection).
   */
  async tradeCpi(
    ctx: LocalnetContext,
    traderCtx: UserContext,
    lpIdx: number,
    lpOwner: PublicKey,
    size: bigint,
    limitPriceE6 = 0n
  ): Promise<string> {
    const [lpPda] = deriveLpPda(ctx.programId, ctx.slab.publicKey, 0);
    console.log(`  [trade] TradeCpi: userIdx=${traderCtx.accountIndex} lpIdx=${lpIdx} size=${size}`);

    const tradeTx = new Transaction();
    tradeTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tradeTx.add(buildIx({
      programId: ctx.programId,
      keys: buildAccountMetas(ACCOUNTS_TRADE_CPI, {
        user: traderCtx.keypair.publicKey,
        lpOwner,
        slab: ctx.slab.publicKey,
        clock: SYSVAR_CLOCK_PUBKEY,
        oracle: ctx.slab.publicKey, // admin oracle = slab
        matcherProg: ctx.matcherProgramId,
        matcherCtx: ctx.matcherCtx.publicKey,
        lpPda,
      }),
      data: encodeTradeCpi({
        lpIdx,
        userIdx: traderCtx.accountIndex,
        size,
        limitPriceE6,
      }),
    }));

    const sig = await sendAndConfirmTransaction(
      this.connection,
      tradeTx,
      [this.payer, traderCtx.keypair],
      { commitment: "confirmed" }
    );
    console.log(`  [trade] TradeCpi sig: ${sig.slice(0, 20)}...`);
    return sig;
  }

  // ==========================================================================
  // STATE INSPECTION
  // ==========================================================================

  async snapshot(ctx: LocalnetContext): Promise<SlabSnapshot> {
    const slot = await this.connection.getSlot();
    const info = await this.connection.getAccountInfo(ctx.slab.publicKey);
    if (!info) throw new Error("Slab account not found on localnet");

    const data = new Uint8Array(info.data);
    const rawHash = crypto.createHash("sha256").update(data).digest("hex");

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

  async runTest(name: string, testFn: () => Promise<void>): Promise<TestResult> {
    const start = Date.now();
    try {
      await testFn();
      const result: TestResult = { name, passed: true, duration: Date.now() - start };
      this.results.push(result);
      console.log(`  PASS  ${name} (${result.duration}ms)`);
      return result;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const result: TestResult = { name, passed: false, error: msg, duration: Date.now() - start };
      this.results.push(result);
      console.error(`  FAIL  ${name}: ${msg}`);
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

  /**
   * Cleanup created slabs. On localnet the lamports return to the payer.
   * CloseSlab requires 6 accounts: dest, slab, vault, vaultAuthority, destAta, tokenProgram.
   * We need the vault info from the context — stored per-slab.
   */
  async cleanup(ctxMap?: Map<string, LocalnetContext>): Promise<void> {
    // Best-effort: just log that cleanup is done — on localnet the validator
    // is stopped immediately after, so rent reclamation is not critical.
    // CloseSlab requires vault/ATA which we don't track in cleanup alone.
    console.log(`  [cleanup] Localnet validator stopping — ${this.createdSlabs.length} slab(s) will be released with ledger`);
    this.createdSlabs = [];
  }

  // ==========================================================================
  // ASSERTIONS
  // ==========================================================================

  static assert(condition: boolean, message: string): void {
    if (!condition) throw new Error(`Assertion failed: ${message}`);
  }

  static assertEqual<T>(actual: T, expected: T, message: string): void {
    if (actual !== expected) {
      throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
    }
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
