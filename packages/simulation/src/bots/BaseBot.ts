/**
 * BaseBot - Abstract base class for all trading bots
 * 
 * Provides core functionality:
 * - Lifecycle management (start/stop)
 * - Position tracking
 * - Trade execution flow
 * 
 * Subclasses implement `decide()` to define trading strategy.
 */

import type { BotConfig, BotState, TradeIntent } from './types.js';

export abstract class BaseBot {
  protected config: BotConfig;
  protected state: BotState;
  protected interval: NodeJS.Timeout | null = null;
  protected onTrade?: (intent: TradeIntent) => Promise<boolean>;
  
  // Price tracking
  protected currentPrice: number = 0;
  protected priceHistory: number[] = [];
  
  /**
   * Create a new bot instance
   * @param config Bot configuration
   * @param accountIdx Account index in the slab (userIdx for traders, lpIdx for LPs)
   * @param onTrade Callback to execute trades
   */
  constructor(
    config: BotConfig,
    accountIdx: number,
    onTrade?: (intent: TradeIntent) => Promise<boolean>
  ) {
    this.config = config;
    this.onTrade = onTrade;
    
    this.state = {
      name: config.name,
      type: config.type,
      running: false,
      positionSize: 0,
      entryPrice: 0,
      pnl: 0,
      tradesExecuted: 0,
      lastTradeAt: 0,
      accountIdx,
    };
  }
  
  /**
   * Start the bot's trading loop
   */
  start(): void {
    if (this.state.running) {
      console.warn(`[${this.state.name}] Already running`);
      return;
    }
    
    this.state.running = true;
    this.interval = setInterval(() => {
      this.tick(this.currentPrice, this.priceHistory);
    }, this.config.tradeIntervalMs);
    
    console.log(`[${this.state.name}] Started`);
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
    console.log(`[${this.state.name}] Stopped`);
  }
  
  /**
   * Get current bot state
   */
  getState(): BotState {
    return { ...this.state };
  }
  
  /**
   * Update price data (called by BotFleet)
   */
  updatePrice(priceE6: number, history: number[]): void {
    this.currentPrice = priceE6;
    this.priceHistory = history;
  }
  
  /**
   * Trading strategy decision logic
   * Must be implemented by subclasses
   * 
   * @param currentPriceE6 Current market price (6 decimals)
   * @param priceHistory Recent price history
   * @returns Trade intent or null if no trade
   */
  protected abstract decide(
    currentPriceE6: number,
    priceHistory: number[]
  ): TradeIntent | null;
  
  /**
   * Called each interval to potentially execute a trade
   */
  protected async tick(currentPriceE6: number, priceHistory: number[]): Promise<void> {
    // Skip if price is invalid
    if (currentPriceE6 <= 0) {
      return;
    }
    
    try {
      const intent = this.decide(currentPriceE6, priceHistory);
      
      if (intent && this.onTrade) {
        const success = await this.onTrade(intent);
        
        if (success) {
          this.state.tradesExecuted++;
          this.state.lastTradeAt = Date.now();
          
          // Update position tracking
          const sizeDelta = Number(intent.size);
          const oldPosition = this.state.positionSize;
          this.state.positionSize += sizeDelta;
          
          // Update entry price (weighted average for adds, reset on flips)
          if (oldPosition === 0) {
            this.state.entryPrice = currentPriceE6;
          } else if (Math.sign(oldPosition) !== Math.sign(this.state.positionSize) && this.state.positionSize !== 0) {
            // Position flipped
            this.state.entryPrice = currentPriceE6;
          } else if (Math.sign(sizeDelta) === Math.sign(oldPosition)) {
            // Adding to position - weighted average
            const oldValue = Math.abs(oldPosition) * this.state.entryPrice;
            const newValue = Math.abs(sizeDelta) * currentPriceE6;
            this.state.entryPrice = (oldValue + newValue) / Math.abs(this.state.positionSize);
          }
          
          // Calculate unrealized PnL
          if (this.state.positionSize !== 0) {
            const priceChange = currentPriceE6 - this.state.entryPrice;
            this.state.pnl = (priceChange * this.state.positionSize) / 1e6;
          } else {
            this.state.pnl = 0;
          }
        }
      }
    } catch (error) {
      console.error(`[${this.state.name}] Tick error:`, error);
    }
  }
  
  /**
   * Helper: Create a trade intent
   */
  protected createIntent(size: bigint, lpIdx: number = 1): TradeIntent {
    return {
      slabAddress: this.config.slabAddress,
      lpIdx,
      userIdx: this.state.accountIdx,
      size,
      botName: this.state.name,
    };
  }
  
  /**
   * Helper: Calculate unrealized PnL
   */
  protected calculatePnL(currentPriceE6: number): number {
    if (this.state.positionSize === 0) return 0;
    const priceChange = currentPriceE6 - this.state.entryPrice;
    return (priceChange * this.state.positionSize) / 1e6;
  }
}
