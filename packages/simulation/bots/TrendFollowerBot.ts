/**
 * TrendFollowerBot - Momentum-based trading strategy
 * 
 * Strategy:
 * - Monitors price direction over N slots
 * - Goes long on uptrend, short on downtrend
 * - Uses trailing stop logic (close when trend reverses)
 * - Tracks moving average (MA) for trend detection
 * - Stop loss and take profit at configurable levels
 * 
 * Params:
 * - maPeriod: Moving average period (default 20)
 * - stopLossBps: Stop loss in basis points (default 200 = 2%)
 * - takeProfitBps: Take profit in basis points (default 500 = 5%)
 * - trendThresholdBps: Min price move to confirm trend (default 100 = 1%)
 */

import { Connection, Keypair } from "@solana/web3.js";
import { BaseBot, type BotConfig } from "./BaseBot.js";

export class TrendFollowerBot extends BaseBot {
  private maPeriod: number;
  private stopLossBps: number;
  private takeProfitBps: number;
  private trendThresholdBps: number;
  private lastMa: bigint = 0n;
  private lastPrice: bigint = 0n;
  private trendDirection: "up" | "down" | "none" = "none";
  
  constructor(
    config: BotConfig,
    connection: Connection,
    keypair: Keypair,
    onLog?: (message: string) => void
  ) {
    super(config, connection, keypair, onLog);
    
    this.maPeriod = (config.params.maPeriod as number) ?? 20;
    this.stopLossBps = (config.params.stopLossBps as number) ?? 200;
    this.takeProfitBps = (config.params.takeProfitBps as number) ?? 500;
    this.trendThresholdBps = (config.params.trendThresholdBps as number) ?? 100;
  }
  
  protected decide(): bigint {
    // Need enough history for MA
    if (this.priceHistory.length < this.maPeriod) {
      return 0n;
    }
    
    // Calculate moving average
    const recentPrices = this.priceHistory.slice(-this.maPeriod);
    const sum = recentPrices.reduce((acc, p) => acc + p, 0n);
    const ma = sum / BigInt(this.maPeriod);
    
    const pnl = this.calculatePnL();
    
    // Check stop loss and take profit
    if (this.state.positionSize !== 0n && this.state.entryPrice > 0n) {
      const absPosition = this.state.positionSize < 0n ? -this.state.positionSize : this.state.positionSize;
      const pnlBps = Number((pnl * 10000n * 1_000_000n) / (absPosition * this.state.entryPrice));
      
      // Stop loss
      if (pnlBps < -this.stopLossBps) {
        this.log(`🛑 Stop loss hit: ${pnlBps.toFixed(2)} bps`);
        return -this.state.positionSize;
      }
      
      // Take profit
      if (pnlBps > this.takeProfitBps) {
        this.log(`💰 Take profit hit: ${pnlBps.toFixed(2)} bps`);
        return -this.state.positionSize;
      }
    }
    
    // Detect trend
    const priceCrossedAbove = this.lastPrice <= this.lastMa && this.currentPriceE6 > ma;
    const priceCrossedBelow = this.lastPrice >= this.lastMa && this.currentPriceE6 < ma;
    
    // Confirm trend with threshold (avoid noise)
    const priceVsMaBps = ((this.currentPriceE6 - ma) * 10000n) / ma;
    const absPriceVsMaBps = priceVsMaBps < 0n ? -priceVsMaBps : priceVsMaBps;
    
    const trendConfirmed = absPriceVsMaBps >= BigInt(this.trendThresholdBps);
    
    // Update state
    this.lastMa = ma;
    this.lastPrice = this.currentPriceE6;
    
    if (trendConfirmed) {
      this.trendDirection = this.currentPriceE6 > ma ? "up" : "down";
    }
    
    // Long signal: price crosses above MA
    if (priceCrossedAbove && trendConfirmed) {
      this.log(`📈 Uptrend detected (price ${Number(priceVsMaBps)}bps above MA)`);
      
      // Close short if any
      if (this.state.positionSize < 0n) {
        return -this.state.positionSize;
      }
      
      // Open long if flat
      if (this.state.positionSize === 0n) {
        const tradeSize = (this.config.maxPositionSize * 60n) / 100n; // 60% of max
        return tradeSize;
      }
    }
    
    // Short signal: price crosses below MA
    if (priceCrossedBelow && trendConfirmed) {
      this.log(`📉 Downtrend detected (price ${Number(priceVsMaBps)}bps below MA)`);
      
      // Close long if any
      if (this.state.positionSize > 0n) {
        return -this.state.positionSize;
      }
      
      // Open short if flat
      if (this.state.positionSize === 0n) {
        const tradeSize = (this.config.maxPositionSize * 60n) / 100n;
        return -tradeSize;
      }
    }
    
    // Trailing stop: close if trend reverses
    if (this.state.positionSize > 0n && this.trendDirection === "down") {
      this.log(`🔄 Trend reversed to DOWN - closing long`);
      return -this.state.positionSize;
    }
    
    if (this.state.positionSize < 0n && this.trendDirection === "up") {
      this.log(`🔄 Trend reversed to UP - closing short`);
      return -this.state.positionSize;
    }
    
    // Hold position
    return 0n;
  }
}
