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

import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  encodeInitUser,
  encodeDepositCollateral,
  encodeTradeNoCpi,
  encodeCloseAccount,
  type InitUserArgs,
  type DepositCollateralArgs,
  type TradeNoCpiArgs,
} from "@percolator/core/abi/instructions";
import { sendWithRetry } from "../../server/src/utils/solana.js";

export interface BotConfig {
  name: string;
  type: string;
  slabAddress: string;
  programId: string;
  initialCapital: bigint;  // Collateral to deposit (lamports)
  maxPositionSize: bigint; // Max position in units
  tradeIntervalMs: number; // How often to check for trades
  params: Record<string, number | string | boolean>;
}

export interface BotState {
  name: string;
  type: string;
  running: boolean;
  keypair: Keypair;
  accountIdx: number | null;     // Account index in slab (null until created)
  positionSize: bigint;
  entryPrice: bigint;             // Price in e6 format
  capital: bigint;                // Deposited collateral
  tradesExecuted: number;
  lastTradeAt: number;
}

export abstract class BaseBot {
  protected config: BotConfig;
  protected state: BotState;
  protected connection: Connection;
  protected interval: NodeJS.Timeout | null = null;
  
  // Price tracking
  protected currentPriceE6: bigint = 0n;
  protected priceHistory: bigint[] = [];
  
  // Logging callback
  protected onLog?: (message: string) => void;
  
  constructor(
    config: BotConfig,
    connection: Connection,
    keypair: Keypair,
    onLog?: (message: string) => void
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
  
  /**
   * Initialize bot account on-chain
   * Creates user account in the slab and deposits initial capital
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
   * Create user account in the slab
   * Returns the assigned account index
   */
  protected async createAccount(): Promise<number> {
    const slabPubkey = new PublicKey(this.config.slabAddress);
    const programId = new PublicKey(this.config.programId);
    
    // Build InitUser instruction
    const feePayment = 100_000_000n; // 0.1 SOL account creation fee
    const data = encodeInitUser({ feePayment });
    
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: this.state.keypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: slabPubkey, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(data),
    });
    
    const sig = await sendWithRetry(this.connection, ix, [this.state.keypair]);
    this.log(`Account created: ${sig}`);
    
    // TODO: Parse account index from transaction logs or slab state
    // For now, return a placeholder (requires slab state query after tx)
    return 0; // Placeholder - should parse from logs
  }
  
  /**
   * Deposit collateral into account
   */
  protected async deposit(amount: bigint): Promise<void> {
    if (this.state.accountIdx === null) {
      throw new Error("Account not initialized");
    }
    
    const slabPubkey = new PublicKey(this.config.slabAddress);
    const programId = new PublicKey(this.config.programId);
    
    const data = encodeDepositCollateral({
      userIdx: this.state.accountIdx,
      amount,
    });
    
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: this.state.keypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: slabPubkey, isSigner: false, isWritable: true },
        // Add vault, vault authority, token program, etc. (depends on slab config)
      ],
      data: Buffer.from(data),
    });
    
    const sig = await sendWithRetry(this.connection, ix, [this.state.keypair]);
    this.log(`Deposited ${amount}: ${sig}`);
  }
  
  /**
   * Execute a trade (TradeNoCpi)
   */
  protected async trade(lpIdx: number, size: bigint): Promise<boolean> {
    if (this.state.accountIdx === null) {
      this.log("ERROR: Account not initialized");
      return false;
    }
    
    try {
      const slabPubkey = new PublicKey(this.config.slabAddress);
      const programId = new PublicKey(this.config.programId);
      
      const data = encodeTradeNoCpi({
        lpIdx,
        userIdx: this.state.accountIdx,
        size,
      });
      
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: this.state.keypair.publicKey, isSigner: true, isWritable: true },
          { pubkey: slabPubkey, isSigner: false, isWritable: true },
          // Add LP account, clock, oracle, etc.
        ],
        data: Buffer.from(data),
      });
      
      const sig = await sendWithRetry(this.connection, ix, [this.state.keypair]);
      
      // Update state
      this.state.positionSize += size;
      this.state.tradesExecuted++;
      this.state.lastTradeAt = Date.now();
      
      const direction = size > 0n ? "LONG" : "SHORT";
      const absSize = size < 0n ? -size : size;
      this.log(`${direction} ${absSize} units @ ${this.currentPriceE6 / 1_000_000} | tx: ${sig.slice(0, 8)}`);
      
      return true;
    } catch (error) {
      this.log(`Trade failed: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }
  
  /**
   * Close position (trade opposite direction)
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
  
  /**
   * Start the bot's trading loop
   */
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
  
  /**
   * Stop the bot's trading loop
   */
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
  
  /**
   * Get current bot state
   */
  getState(): BotState {
    return { ...this.state };
  }
  
  /**
   * Update price data (called by BotManager)
   */
  updatePrice(priceE6: bigint): void {
    this.currentPriceE6 = priceE6;
    this.priceHistory.push(priceE6);
    
    // Keep last 100 prices
    if (this.priceHistory.length > 100) {
      this.priceHistory.shift();
    }
  }
  
  /**
   * Trading strategy decision logic
   * Must be implemented by subclasses
   * 
   * @returns Trade size (positive=long, negative=short, 0=no trade)
   */
  protected abstract decide(): bigint;
  
  /**
   * Called each interval to potentially execute a trade
   */
  protected async tick(): Promise<void> {
    // Skip if price is invalid or account not initialized
    if (this.currentPriceE6 <= 0n || this.state.accountIdx === null) {
      return;
    }
    
    try {
      const tradeSize = this.decide();
      
      if (tradeSize !== 0n) {
        await this.trade(1, tradeSize); // lpIdx=1 (default LP)
      }
    } catch (error) {
      this.log(`Tick error: ${error instanceof Error ? error.message : error}`);
    }
  }
  
  /**
   * Log a message (forwarded to BotManager)
   */
  protected log(message: string): void {
    const fullMessage = `[${this.state.name}] ${message}`;
    console.log(fullMessage);
    if (this.onLog) {
      this.onLog(fullMessage);
    }
  }
  
  /**
   * Calculate unrealized PnL
   */
  protected calculatePnL(): bigint {
    if (this.state.positionSize === 0n || this.state.entryPrice === 0n) {
      return 0n;
    }
    
    const priceChange = this.currentPriceE6 - this.state.entryPrice;
    return (priceChange * this.state.positionSize) / 1_000_000n;
  }
}
