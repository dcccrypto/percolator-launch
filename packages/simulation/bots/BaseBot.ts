/**
 * BaseBot - Foundation for all trading bots
 *
 * Provides:
 * - Solana integration (createAccount, deposit, trade, closePosition)
 * - Position tracking and lifecycle management
 * - Logging for event feed
 *
 * Each bot gets its own Solana keypair and executes real trades on devnet.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SYSVAR_CLOCK_PUBKEY,
  SendOptions,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  encodeInitUser,
  encodeDepositCollateral,
  encodeTradeNoCpi,
  encodeCloseAccount,
  type InitUserArgs,
  type DepositCollateralArgs,
  type TradeNoCpiArgs,
  buildAccountMetas,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TRADE_NOCPI,
  ACCOUNTS_CLOSE_ACCOUNT,
  fetchSlab,
  parseConfig,
  parseEngine,
  deriveVaultAuthority,
  derivePythPushOraclePDA,
  type MarketConfig,
} from "@percolator/core";

export interface BotConfig {
  name: string;
  type: string;
  slabAddress: string;
  programId: string;
  initialCapital: bigint; // Collateral to deposit (lamports)
  maxPositionSize: bigint; // Max position in units
  tradeIntervalMs: number; // How often to check for trades
  params: Record<string, number | string | boolean>;
}

export interface BotState {
  name: string;
  type: string;
  running: boolean;
  keypair: Keypair;
  accountIdx: number | null; // Account index in slab (null until created)
  positionSize: bigint;
  entryPrice: bigint; // Price in e6 format
  capital: bigint; // Deposited collateral
  tradesExecuted: number;
  lastTradeAt: number;
}

/**
 * Cached slab metadata so we don't re-fetch every instruction.
 */
interface SlabMeta {
  slabPubkey: PublicKey;
  programId: PublicKey;
  config: MarketConfig;
  vaultAuthority: PublicKey;
  /** Oracle account — for Hyperp mode this is the slab itself (authority_price); for Pyth, derive from feed ID. */
  oraclePubkey: PublicKey;
}

export abstract class BaseBot {
  protected config: BotConfig;
  protected state: BotState;
  protected connection: Connection;
  protected interval: NodeJS.Timeout | null = null;
  protected slabMeta: SlabMeta | null = null;

  // Price tracking
  protected currentPriceE6: bigint = 0n;
  protected priceHistory: bigint[] = [];

  // Logging callback
  protected onLog?: (message: string) => void;

  constructor(
    config: BotConfig,
    connection: Connection,
    keypair: Keypair,
    onLog?: (message: string) => void,
  ) {
    this.config = config;
    this.connection = connection;
    this.onLog = onLog;

    this.state = {
      name: config.name,
      type: config.type,
      running: false,
      keypair,
      accountIdx: null,
      positionSize: 0n,
      entryPrice: 0n,
      capital: 0n,
      tradesExecuted: 0,
      lastTradeAt: 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Slab metadata
  // ---------------------------------------------------------------------------

  /**
   * Fetch and cache slab metadata (vault, mint, oracle, etc.)
   */
  protected async loadSlabMeta(): Promise<SlabMeta> {
    if (this.slabMeta) return this.slabMeta;

    const slabPubkey = new PublicKey(this.config.slabAddress);
    const programId = new PublicKey(this.config.programId);
    const data = await fetchSlab(this.connection, slabPubkey);
    const config = parseConfig(data);

    const [vaultAuthority] = deriveVaultAuthority(programId, slabPubkey);

    // Oracle resolution — mirrors server CrankService logic exactly:
    // If oracleAuthority is set (non-default), the market uses admin-pushed prices
    // and the slab itself is passed as the oracle account (program reads authority_price_e6).
    // If oracleAuthority is default (all zeros), the market uses Pyth and we derive
    // the oracle PDA from the feed ID.
    const isAdminOracle = !config.oracleAuthority.equals(PublicKey.default);
    let oraclePubkey: PublicKey;
    if (isAdminOracle) {
      oraclePubkey = slabPubkey;
    } else {
      const feedHex = Array.from(config.indexFeedId.toBytes())
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      [oraclePubkey] = derivePythPushOraclePDA(feedHex);
    }

    this.slabMeta = { slabPubkey, programId, config, vaultAuthority, oraclePubkey };
    return this.slabMeta;
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  /**
   * Initialize bot account on-chain.
   * Creates user account in the slab and deposits initial capital.
   */
  async initialize(): Promise<void> {
    this.log(`Initializing account...`);

    // Step 1: Create user account
    const userIdx = await this.createAccount();
    this.state.accountIdx = userIdx;
    this.log(`Account created at index ${userIdx}`);

    // Step 2: Deposit collateral
    await this.deposit(this.config.initialCapital);
    this.state.capital = this.config.initialCapital;
    this.log(`Deposited ${this.config.initialCapital} lamports`);
  }

  /**
   * Create user account in the slab.
   * Returns the assigned account index by querying nextAccountId before the tx.
   */
  protected async createAccount(): Promise<number> {
    const meta = await this.loadSlabMeta();

    // Read nextAccountId BEFORE the InitUser tx so we know which index gets assigned.
    const preData = await fetchSlab(this.connection, meta.slabPubkey);
    const preEngine = parseEngine(preData);
    const assignedIdx = Number(preEngine.nextAccountId);

    // Build InitUser instruction
    // InitUser accounts: user(signer,w), slab(w), userAta(w), vault(w), tokenProgram
    const feePayment = 100_000_000n; // 0.1 SOL account creation fee
    const data = encodeInitUser({ feePayment });

    const userAta = getAssociatedTokenAddressSync(
      meta.config.collateralMint,
      this.state.keypair.publicKey,
    );

    const keys = buildAccountMetas(ACCOUNTS_INIT_USER, [
      this.state.keypair.publicKey, // user
      meta.slabPubkey, // slab
      userAta, // userAta
      meta.config.vaultPubkey, // vault
      TOKEN_PROGRAM_ID, // tokenProgram
    ]);

    const ix = new TransactionInstruction({
      programId: meta.programId,
      keys,
      data: Buffer.from(data),
    });

    const sig = await this.sendWithRetry(ix);
    this.log(`Account created: ${sig}`);

    return assignedIdx;
  }

  /**
   * Deposit collateral into account.
   *
   * DepositCollateral accounts: user(signer,w), slab(w), userAta(w), vault(w), tokenProgram, clock
   */
  protected async deposit(amount: bigint): Promise<void> {
    if (this.state.accountIdx === null) {
      throw new Error("Account not initialized");
    }

    const meta = await this.loadSlabMeta();

    const data = encodeDepositCollateral({
      userIdx: this.state.accountIdx,
      amount,
    });

    const userAta = getAssociatedTokenAddressSync(
      meta.config.collateralMint,
      this.state.keypair.publicKey,
    );

    const keys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      this.state.keypair.publicKey, // user
      meta.slabPubkey, // slab
      userAta, // userAta
      meta.config.vaultPubkey, // vault
      TOKEN_PROGRAM_ID, // tokenProgram
      SYSVAR_CLOCK_PUBKEY, // clock
    ]);

    const ix = new TransactionInstruction({
      programId: meta.programId,
      keys,
      data: Buffer.from(data),
    });

    const sig = await this.sendWithRetry(ix);
    this.log(`Deposited ${amount}: ${sig}`);
  }

  /**
   * Execute a trade (TradeNoCpi).
   *
   * TradeNoCpi accounts: user(signer,w), lp(signer,w), slab(w), clock, oracle
   *
   * NOTE: TradeNoCpi requires *both* the user AND the LP to sign.
   * In production the LP owner keypair is needed. For devnet bots the caller
   * must also control the LP keypair, or use TradeCpi which doesn't require LP sig.
   * Here we pass the bot keypair as lp signer — this only works if the bot IS the LP.
   * If separate LP keys are needed, pass them via `lpKeypair` param in the future.
   */
  protected async trade(
    lpIdx: number,
    size: bigint,
    lpKeypair?: Keypair,
  ): Promise<boolean> {
    if (this.state.accountIdx === null) {
      this.log("ERROR: Account not initialized");
      return false;
    }

    try {
      const meta = await this.loadSlabMeta();

      const data = encodeTradeNoCpi({
        lpIdx,
        userIdx: this.state.accountIdx,
        size,
      });

      const lpSigner = lpKeypair ?? this.state.keypair;

      const keys = buildAccountMetas(ACCOUNTS_TRADE_NOCPI, [
        this.state.keypair.publicKey, // user
        lpSigner.publicKey, // lp (must sign)
        meta.slabPubkey, // slab
        SYSVAR_CLOCK_PUBKEY, // clock
        meta.oraclePubkey, // oracle
      ]);

      const ix = new TransactionInstruction({
        programId: meta.programId,
        keys,
        data: Buffer.from(data),
      });

      const signers =
        lpSigner === this.state.keypair
          ? [this.state.keypair]
          : [this.state.keypair, lpSigner];

      const sig = await this.sendWithRetry(ix, signers);

      // Update state
      this.state.positionSize += size;
      this.state.tradesExecuted++;
      this.state.lastTradeAt = Date.now();

      const direction = size > 0n ? "LONG" : "SHORT";
      const absSize = size < 0n ? -size : size;
      this.log(
        `${direction} ${absSize} units @ ${this.currentPriceE6 / 1_000_000n} | tx: ${sig.slice(0, 8)}`,
      );

      return true;
    } catch (error) {
      this.log(
        `Trade failed: ${error instanceof Error ? error.message : error}`,
      );
      return false;
    }
  }

  /**
   * Close position (trade opposite direction).
   */
  protected async closePosition(): Promise<boolean> {
    if (this.state.positionSize === 0n) {
      return true; // Already flat
    }

    const closeSize = -this.state.positionSize;
    const success = await this.trade(1, closeSize); // lpIdx=1 (default LP)

    if (success) {
      this.state.positionSize = 0n;
      this.state.entryPrice = 0n;
    }

    return success;
  }

  // ---------------------------------------------------------------------------
  // Trading loop
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.state.running) {
      this.log("Already running");
      return;
    }

    this.state.running = true;
    this.interval = setInterval(() => {
      this.tick();
    }, this.config.tradeIntervalMs);

    this.log("Started");
  }

  stop(): void {
    if (!this.state.running) {
      return;
    }

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    this.state.running = false;
    this.log("Stopped");
  }

  getState(): BotState {
    return { ...this.state };
  }

  updatePrice(priceE6: bigint): void {
    this.currentPriceE6 = priceE6;
    this.priceHistory.push(priceE6);

    // Keep last 100 prices
    if (this.priceHistory.length > 100) {
      this.priceHistory.shift();
    }
  }

  /**
   * Trading strategy decision logic — implemented by subclasses.
   * @returns Trade size (positive=long, negative=short, 0=no trade)
   */
  protected abstract decide(): bigint;

  protected async tick(): Promise<void> {
    if (this.currentPriceE6 <= 0n || this.state.accountIdx === null) {
      return;
    }

    try {
      const tradeSize = this.decide();
      if (tradeSize !== 0n) {
        await this.trade(1, tradeSize);
      }
    } catch (error) {
      this.log(
        `Tick error: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  protected log(message: string): void {
    const fullMessage = `[${this.state.name}] ${message}`;
    console.log(fullMessage);
    if (this.onLog) {
      this.onLog(fullMessage);
    }
  }

  protected calculatePnL(): bigint {
    if (this.state.positionSize === 0n || this.state.entryPrice === 0n) {
      return 0n;
    }

    const priceChange = this.currentPriceE6 - this.state.entryPrice;
    return (priceChange * this.state.positionSize) / 1_000_000n;
  }

  // ---------------------------------------------------------------------------
  // Transaction sending with retry (self-contained, no cross-package imports)
  // ---------------------------------------------------------------------------

  protected async sendWithRetry(
    ix: TransactionInstruction,
    signers?: Keypair[],
    maxRetries = 3,
  ): Promise<string> {
    const actualSigners = signers ?? [this.state.keypair];
    let lastErr: unknown;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const tx = new Transaction();
        tx.add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
        );
        tx.add(ix);

        const { blockhash } = await this.connection.getLatestBlockhash(
          "confirmed",
        );
        tx.recentBlockhash = blockhash;
        tx.feePayer = actualSigners[0].publicKey;
        tx.sign(...actualSigners);

        const opts: SendOptions = {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        };
        const sig = await this.connection.sendRawTransaction(
          tx.serialize(),
          opts,
        );

        // Poll for confirmation
        const start = Date.now();
        const TIMEOUT = 30_000;
        while (Date.now() - start < TIMEOUT) {
          const { value } = await this.connection.getSignatureStatuses([sig]);
          const status = value[0];
          if (status) {
            if (status.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
            if (
              status.confirmationStatus === "confirmed" ||
              status.confirmationStatus === "finalized"
            ) {
              return sig;
            }
          }
          await new Promise((r) => setTimeout(r, 2_000));
        }
        throw new Error("Transaction confirmation timeout");
      } catch (err) {
        lastErr = err;
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        this.log(
          `sendWithRetry attempt ${attempt + 1}/${maxRetries} failed, retrying in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }
}
