/**
 * MarketMakerBot - High-frequency liquidity provider
 * 
 * Strategy:
 * - Places opposing long/short positions around current price
 * - Maintains spread (configurable 0.5-2%)
 * - Adjusts position size based on volatility
 * - Closes and reopens positions periodically
 * - Stays delta-neutral (net position near 0)
 * 
 * Params:
 * - spreadBps: Target spread in basis points (default 50 = 0.5%)
 * - rebalanceThreshold: Position size ratio to trigger rebalance (default 0.3)
 * - profitTargetBps: PnL target to close position (default 100 = 1%)
 */

import { Connection, Keypair } from "@solana/web3.js";
import { BaseBot, type BotConfig } from "./BaseBot.js";

export class MarketMakerBot extends BaseBot {
  private spreadBps: number;
  private rebalanceThreshold: number;
  private profitTargetBps: number;
  private lastSide: "long" | "short" | null = null;
  private tradeCount: number = 0;
  
  constructor(
    config: BotConfig,
    connection: Connection,
    keypair: Keypair,
    onLog?: (message: string) => void
  ) {
    super(config, connection, keypair, onLog);
    
    this.spreadBps = (config.params.spreadBps as number) ?? 50;
    this.rebalanceThreshold = (config.params.rebalanceThreshold as number) ?? 0.3;
    this.profitTargetBps = (config.params.profitTargetBps as number) ?? 100;
  }
  
  protected decide(): bigint {
    // Need price history
    if (this.priceHistory.length < 2) {
      return 0n;
    }
    
    const pnl = this.calculatePnL();
    const absPosition = this.state.positionSize < 0n ? -this.state.positionSize : this.state.positionSize;
    const positionRatio = Number(absPosition) / Number(this.config.maxPositionSize);
    
    // Take profit if PnL exceeds target
    if (this.state.positionSize !== 0n) {
      const pnlBps = this.state.entryPrice > 0n
        ? Number((pnl * 10000n * 1_000_000n) / (absPosition * this.state.entryPrice))
        : 0;
      
      if (Math.abs(pnlBps) >= this.profitTargetBps) {
        this.log(`💰 Taking profit: ${pnlBps.toFixed(2)} bps`);
        return -this.state.positionSize;
      }
    }
    
    // Rebalance if position too large
    if (positionRatio > this.rebalanceThreshold) {
      const rebalanceSize = -(this.state.positionSize / 2n); // Reduce by 50%
      this.log(`⚖️ Rebalancing position (${(positionRatio * 100).toFixed(1)}% of max)`);
      return rebalanceSize;
    }
    
    // Alternate sides to stay delta-neutral
    let side: "long" | "short";
    
    if (this.state.positionSize > 0n) {
      // Currently long, bias toward short
      side = Math.random() < 0.7 ? "short" : "long";
    } else if (this.state.positionSize < 0n) {
      // Currently short, bias toward long
      side = Math.random() < 0.7 ? "long" : "short";
    } else {
      // Flat, alternate from last trade
      if (this.lastSide === "long") {
        side = "short";
      } else if (this.lastSide === "short") {
        side = "long";
      } else {
        side = Math.random() < 0.5 ? "long" : "short";
      }
    }
    
    // Calculate volatility (std dev of recent prices)
    const volatility = this.calculateVolatility();
    
    // Adjust trade size based on volatility
    // High volatility = smaller sizes, low volatility = larger sizes
    const volatilityFactor = Math.max(0.5, Math.min(1.5, 1 / (1 + volatility)));
    
    // Trade small size (10-30% of max, adjusted for volatility)
    const baseSizeRatio = 0.1 + Math.random() * 0.2;
    const sizeRatio = baseSizeRatio * volatilityFactor;
    const tradeSize = BigInt(Math.floor(Number(this.config.maxPositionSize) * sizeRatio));
    
    const signedSize = side === "long" ? tradeSize : -tradeSize;
    
    // Don't exceed max position
    const newPosition = this.state.positionSize + signedSize;
    const absNewPosition = newPosition < 0n ? -newPosition : newPosition;
    
    if (absNewPosition > this.config.maxPositionSize) {
      return 0n;
    }
    
    this.lastSide = side;
    this.tradeCount++;
    
    return signedSize;
  }
  
  /**
   * Calculate recent price volatility (normalized)
   */
  private calculateVolatility(): number {
    if (this.priceHistory.length < 5) {
      return 0.5; // Default moderate volatility
    }
    
    const recentPrices = this.priceHistory.slice(-20); // Last 20 prices
    const avg = recentPrices.reduce((sum, p) => sum + p, 0n) / BigInt(recentPrices.length);
    
    // Calculate variance
    let variance = 0n;
    for (const price of recentPrices) {
      const diff = price - avg;
      variance += diff * diff;
    }
    variance = variance / BigInt(recentPrices.length);
    
    // Standard deviation
    const stdDev = Number(variance) ** 0.5;
    
    // Normalize by average price (coefficient of variation)
    const cv = stdDev / Number(avg);
    
    return cv;
  }
}
