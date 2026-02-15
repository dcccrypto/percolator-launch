/**
 * MarketMakerBot - High-frequency liquidity provider
 * 
 * Strategy:
 * - Places alternating long/short positions to provide liquidity
 * - Stays delta-neutral (net position near 0)
 * - Trades small sizes frequently
 * - Takes profit at tight spread (0.1-0.5%)
 * - Closes positions when PnL threshold exceeded
 * 
 * Params:
 * - spreadBps: Target spread in basis points (default 50 = 0.5%)
 * - rebalanceThreshold: Position size ratio to trigger rebalance (default 0.3)
 */

import { BaseBot } from './BaseBot.js';
import type { BotConfig, TradeIntent } from './types.js';

export class MarketMakerBot extends BaseBot {
  private spreadBps: number;
  private rebalanceThreshold: number;
  private lastSide: 'long' | 'short' | null = null;
  private rng: () => number;
  
  constructor(
    config: BotConfig,
    accountIdx: number,
    onTrade?: (intent: TradeIntent) => Promise<boolean>
  ) {
    super(config, accountIdx, onTrade);
    
    this.spreadBps = (config.params.spreadBps as number) ?? 50;
    this.rebalanceThreshold = (config.params.rebalanceThreshold as number) ?? 0.3;
    
    // Seeded RNG for determinism
    const seed = this.hashString(config.name);
    this.rng = this.createSeededRng(seed);
  }
  
  protected decide(currentPriceE6: number, priceHistory: number[]): TradeIntent | null {
    // Need some price history
    if (priceHistory.length < 2) {
      return null;
    }
    
    const pnl = this.calculatePnL(currentPriceE6);
    const positionRatio = Math.abs(this.state.positionSize) / this.config.maxPositionSize;
    
    // Take profit if PnL exceeds spread target
    const spreadTarget = (this.spreadBps / 10000) * Math.abs(this.state.positionSize) * this.state.entryPrice / 1e6;
    
    if (this.state.positionSize !== 0 && Math.abs(pnl) >= spreadTarget) {
      // Close position
      const closeSize = BigInt(-this.state.positionSize);
      return this.createIntent(closeSize);
    }
    
    // Rebalance if position too large
    if (positionRatio > this.rebalanceThreshold) {
      const rebalanceSize = -Math.sign(this.state.positionSize) * Math.floor(Math.abs(this.state.positionSize) * 0.5);
      return this.createIntent(BigInt(rebalanceSize));
    }
    
    // Alternate sides to stay delta-neutral
    let side: 'long' | 'short';
    
    if (this.state.positionSize > 0) {
      // Currently long, bias toward short
      side = this.rng() < 0.7 ? 'short' : 'long';
    } else if (this.state.positionSize < 0) {
      // Currently short, bias toward long
      side = this.rng() < 0.7 ? 'long' : 'short';
    } else {
      // Flat, alternate from last trade
      if (this.lastSide === 'long') {
        side = 'short';
      } else if (this.lastSide === 'short') {
        side = 'long';
      } else {
        side = this.rng() < 0.5 ? 'long' : 'short';
      }
    }
    
    // Trade small size (10-30% of max)
    const sizeRatio = 0.1 + this.rng() * 0.2;
    const tradeSize = Math.floor(this.config.maxPositionSize * sizeRatio);
    const signedSize = side === 'long' ? tradeSize : -tradeSize;
    
    // Don't exceed max position
    if (Math.abs(this.state.positionSize + signedSize) > this.config.maxPositionSize) {
      return null;
    }
    
    this.lastSide = side;
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
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }
  
  /**
   * Seeded RNG using LCG (Linear Congruential Generator)
   */
  private createSeededRng(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 2147483647;
      return state / 2147483647;
    };
  }
}
