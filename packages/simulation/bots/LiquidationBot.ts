/**
 * LiquidationBot - Intentionally risky trader
 * 
 * Strategy:
 * - Opens HIGH leverage positions near liquidation threshold
 * - Purpose: trigger visible liquidations during demo scenarios
 * - Gets liquidated during crash/squeeze scenarios (by design)
 * - Tests insurance fund and liquidation system
 * 
 * Params:
 * - targetLeverage: Target leverage multiplier (default 15x)
 * - triggerOnCrash: Only activate during price crashes (default true)
 * - holdDurationMs: How long to hold risky position (default 60s)
 */

import { Connection, Keypair } from "@solana/web3.js";
import { BaseBot, type BotConfig } from "./BaseBot.js";

export class LiquidationBot extends BaseBot {
  private targetLeverage: number;
  private triggerOnCrash: boolean;
  private holdDurationMs: number;
  private positionOpenedAt: number = 0;
  private lastPriceChange: bigint = 0n;
  
  constructor(
    config: BotConfig,
    connection: Connection,
    keypair: Keypair,
    onLog?: (message: string) => void
  ) {
    super(config, connection, keypair, onLog);
    
    this.targetLeverage = (config.params.targetLeverage as number) ?? 15;
    this.triggerOnCrash = (config.params.triggerOnCrash as boolean) ?? true;
    this.holdDurationMs = (config.params.holdDurationMs as number) ?? 60_000;
  }
  
  protected decide(): bigint {
    // Need price history
    if (this.priceHistory.length < 5) {
      return 0n;
    }
    
    const pnl = this.calculatePnL();
    
    // If in position, check if should close
    if (this.state.positionSize !== 0n) {
      const holdTime = Date.now() - this.positionOpenedAt;
      
      // Close after hold duration
      if (holdTime >= this.holdDurationMs) {
        this.log(`Closing position after ${holdTime}ms (PnL: ${pnl})`);
        return -this.state.positionSize;
      }
      
      // Hold (waiting to get liquidated or hit duration)
      return 0n;
    }
    
    // Flat - decide if should open risky position
    
    // Detect price crash (5% drop in recent history)
    const recentPrices = this.priceHistory.slice(-5);
    const oldPrice = recentPrices[0];
    const newPrice = recentPrices[recentPrices.length - 1];
    const priceChangeBps = ((newPrice - oldPrice) * 10000n) / oldPrice;
    
    const isCrashing = priceChangeBps < -500n; // -5% or worse
    const isPumping = priceChangeBps > 500n;   // +5% or better
    
    // Only trigger on crashes/pumps if configured
    if (this.triggerOnCrash && !isCrashing && !isPumping) {
      return 0n;
    }
    
    // Open highly leveraged position in the OPPOSITE direction
    // (so a crash liquidates us)
    let side: "long" | "short";
    
    if (isCrashing) {
      // Price crashing? Go LONG (will get liquidated)
      side = "long";
      this.log(`🔴 CRASH DETECTED (${priceChangeBps}bps) - Going LONG to get liquidated!`);
    } else if (isPumping) {
      // Price pumping? Go SHORT (will get liquidated)
      side = "short";
      this.log(`🟢 PUMP DETECTED (${priceChangeBps}bps) - Going SHORT to get liquidated!`);
    } else {
      // Random direction
      side = Math.random() < 0.5 ? "long" : "short";
      this.log(`Opening risky ${side.toUpperCase()} position (${this.targetLeverage}x)`);
    }
    
    // Calculate position size based on target leverage
    // Leverage = Position Value / Collateral
    // Position Size (in units) = (Collateral * Leverage * 1e6) / Price
    
    const collateral = this.state.capital;
    const price = this.currentPriceE6;
    
    if (collateral === 0n || price === 0n) {
      return 0n;
    }
    
    // Position value = collateral * leverage
    const targetNotional = collateral * BigInt(this.targetLeverage);
    
    // Position size = (targetNotional * 1e6) / price
    const positionSize = (targetNotional * 1_000_000n) / price;
    
    // Cap at maxPositionSize
    const cappedSize = positionSize > this.config.maxPositionSize
      ? this.config.maxPositionSize
      : positionSize;
    
    const signedSize = side === "long" ? cappedSize : -cappedSize;
    
    this.positionOpenedAt = Date.now();
    
    return signedSize;
  }
}
