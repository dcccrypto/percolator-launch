/**
 * DegenBot - High-risk, high-leverage gambler
 * 
 * Strategy:
 * - Randomly enters large positions
 * - Uses maximum leverage
 * - Often gets liquidated (intentional - demonstrates liquidation system)
 * - Sometimes doubles down on losing positions
 * - Random hold times
 * 
 * This bot is designed to create chaos and test edge cases.
 * 
 * Params:
 * - maxLeverage: Maximum leverage multiplier (default 10)
 * - liquidationChance: Probability of risky behavior (default 0.3)
 * - doubleDownChance: Probability of doubling losing position (default 0.2)
 */

import { BaseBot } from './BaseBot.js';
import type { BotConfig, TradeIntent } from './types.js';

export class DegenBot extends BaseBot {
  private maxLeverage: number;
  private liquidationChance: number;
  private doubleDownChance: number;
  private rng: () => number;
  private tradesSinceEntry: number = 0;
  
  constructor(
    config: BotConfig,
    accountIdx: number,
    onTrade?: (intent: TradeIntent) => Promise<boolean>
  ) {
    super(config, accountIdx, onTrade);
    
    this.maxLeverage = (config.params.maxLeverage as number) ?? 10;
    this.liquidationChance = (config.params.liquidationChance as number) ?? 0.3;
    this.doubleDownChance = (config.params.doubleDownChance as number) ?? 0.2;
    
    // Seeded RNG
    const seed = this.hashString(config.name);
    this.rng = this.createSeededRng(seed);
  }
  
  protected decide(currentPriceE6: number, priceHistory: number[]): TradeIntent | null {
    if (priceHistory.length < 2) {
      return null;
    }
    
    const pnl = this.calculatePnL(currentPriceE6);
    const pnlBps = this.state.entryPrice > 0
      ? (pnl / (Math.abs(this.state.positionSize) * this.state.entryPrice / 1e6)) * 10000
      : 0;
    
    // If in position
    if (this.state.positionSize !== 0) {
      this.tradesSinceEntry++;
      
      // Sometimes double down on losing position (YOLO)
      if (pnlBps < -100 && this.rng() < this.doubleDownChance) {
        const doubleDownSize = this.state.positionSize; // Same direction, same size
        console.log(`[${this.state.name}] 🎲 DOUBLING DOWN on loss!`);
        return this.createIntent(BigInt(doubleDownSize));
      }
      
      // Random exit (hold 1-5 ticks)
      const minHoldTicks = 1;
      const maxHoldTicks = 5;
      const holdTicks = Math.floor(minHoldTicks + this.rng() * (maxHoldTicks - minHoldTicks));
      
      if (this.tradesSinceEntry >= holdTicks) {
        // Close position
        const closeSize = -this.state.positionSize;
        this.tradesSinceEntry = 0;
        
        if (pnl > 0) {
          console.log(`[${this.state.name}] 💰 Taking profit: ${pnl.toFixed(2)}`);
        } else {
          console.log(`[${this.state.name}] 💀 Closing loss: ${pnl.toFixed(2)}`);
        }
        
        return this.createIntent(BigInt(closeSize));
      }
      
      // Hold
      return null;
    }
    
    // Flat - maybe enter a new position
    const shouldTrade = this.rng() < 0.4; // 40% chance each tick
    
    if (!shouldTrade) {
      return null;
    }
    
    // Random side
    const side = this.rng() < 0.5 ? 'long' : 'short';
    
    // Random leverage (1x to maxLeverage)
    const leverage = 1 + this.rng() * (this.maxLeverage - 1);
    
    // Size based on leverage (higher leverage = larger position)
    const baseSize = this.config.maxPositionSize;
    const leveragedSize = Math.floor(baseSize * leverage);
    
    // Cap at max position (prevents over-leveraging beyond capital)
    const tradeSize = Math.min(leveragedSize, this.config.maxPositionSize * this.maxLeverage);
    const signedSize = side === 'long' ? tradeSize : -tradeSize;
    
    const leverageLabel = leverage.toFixed(1);
    console.log(`[${this.state.name}] 🎰 Opening ${side} ${leverageLabel}x leverage`);
    
    this.tradesSinceEntry = 0;
    return this.createIntent(BigInt(signedSize));
  }
  
  /**
   * Simple string hash for seeding
   */
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }
  
  /**
   * Seeded RNG using LCG
   */
  private createSeededRng(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 2147483647;
      return state / 2147483647;
    };
  }
}
