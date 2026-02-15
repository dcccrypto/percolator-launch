/**
 * TrendFollowerBot - Momentum-based trading strategy
 * 
 * Strategy:
 * - Tracks price moving average (MA)
 * - Goes long when price crosses above MA
 * - Goes short when price crosses below MA
 * - Uses moderate position sizes
 * - Stop loss and take profit at configurable levels
 * 
 * Params:
 * - maPeriod: Moving average period (default 20)
 * - stopLossBps: Stop loss in basis points (default 200 = 2%)
 * - takeProfitBps: Take profit in basis points (default 500 = 5%)
 */

import { BaseBot } from './BaseBot.js';
import type { BotConfig, TradeIntent } from './types.js';

export class TrendFollowerBot extends BaseBot {
  private maPeriod: number;
  private stopLossBps: number;
  private takeProfitBps: number;
  private lastMa: number = 0;
  private lastPrice: number = 0;
  
  constructor(
    config: BotConfig,
    accountIdx: number,
    onTrade?: (intent: TradeIntent) => Promise<boolean>
  ) {
    super(config, accountIdx, onTrade);
    
    this.maPeriod = (config.params.maPeriod as number) ?? 20;
    this.stopLossBps = (config.params.stopLossBps as number) ?? 200;
    this.takeProfitBps = (config.params.takeProfitBps as number) ?? 500;
  }
  
  protected decide(currentPriceE6: number, priceHistory: number[]): TradeIntent | null {
    // Need enough history for MA
    if (priceHistory.length < this.maPeriod) {
      return null;
    }
    
    // Calculate moving average
    const recentPrices = priceHistory.slice(-this.maPeriod);
    const ma = recentPrices.reduce((sum, p) => sum + p, 0) / this.maPeriod;
    
    const pnl = this.calculatePnL(currentPriceE6);
    const pnlBps = this.state.entryPrice > 0 
      ? (pnl / (Math.abs(this.state.positionSize) * this.state.entryPrice / 1e6)) * 10000
      : 0;
    
    // Check stop loss
    if (this.state.positionSize !== 0 && pnlBps < -this.stopLossBps) {
      console.log(`[${this.state.name}] Stop loss hit: ${pnlBps.toFixed(2)} bps`);
      const closeSize = BigInt(-this.state.positionSize);
      return this.createIntent(closeSize);
    }
    
    // Check take profit
    if (this.state.positionSize !== 0 && pnlBps > this.takeProfitBps) {
      console.log(`[${this.state.name}] Take profit hit: ${pnlBps.toFixed(2)} bps`);
      const closeSize = BigInt(-this.state.positionSize);
      return this.createIntent(closeSize);
    }
    
    // Detect crossovers
    const priceCrossedAbove = this.lastPrice <= this.lastMa && currentPriceE6 > ma;
    const priceCrossedBelow = this.lastPrice >= this.lastMa && currentPriceE6 < ma;
    
    this.lastMa = ma;
    this.lastPrice = currentPriceE6;
    
    // Long signal: price crosses above MA
    if (priceCrossedAbove) {
      // Close short if any
      if (this.state.positionSize < 0) {
        return this.createIntent(BigInt(-this.state.positionSize));
      }
      // Open long if flat
      if (this.state.positionSize === 0) {
        const tradeSize = Math.floor(this.config.maxPositionSize * 0.6); // 60% of max
        return this.createIntent(BigInt(tradeSize));
      }
    }
    
    // Short signal: price crosses below MA
    if (priceCrossedBelow) {
      // Close long if any
      if (this.state.positionSize > 0) {
        return this.createIntent(BigInt(-this.state.positionSize));
      }
      // Open short if flat
      if (this.state.positionSize === 0) {
        const tradeSize = Math.floor(this.config.maxPositionSize * 0.6);
        return this.createIntent(BigInt(-tradeSize));
      }
    }
    
    // Hold position
    return null;
  }
}
