/**
 * LPBot - Liquidity Provider Management
 * 
 * Strategy:
 * - Deposits capital as LP at configurable intervals
 * - Withdraws partially when conditions warrant
 * - Adjusts LP size based on market conditions
 * - Provides counter-party liquidity for traders
 * 
 * Note: This bot uses the Deposit instruction, not TradeNoCpi.
 * The integration layer needs to handle LP operations separately.
 * 
 * Params:
 * - depositSize: Amount to deposit per interval (default 1000000000 = 1 SOL)
 * - withdrawThreshold: Utilization ratio to trigger withdrawal (default 0.1 = 10%)
 * - targetLpSize: Target total LP size (default 10000000000 = 10 SOL)
 */

import { BaseBot } from './BaseBot.js';
import type { BotConfig, TradeIntent } from './types.js';

export class LPBot extends BaseBot {
  private depositSize: number;
  private withdrawThreshold: number;
  private targetLpSize: number;
  private currentLpSize: number = 0;
  private rng: () => number;
  
  constructor(
    config: BotConfig,
    accountIdx: number,
    onTrade?: (intent: TradeIntent) => Promise<boolean>
  ) {
    super(config, accountIdx, onTrade);
    
    this.depositSize = (config.params.depositSize as number) ?? 1_000_000_000;
    this.withdrawThreshold = (config.params.withdrawThreshold as number) ?? 0.1;
    this.targetLpSize = (config.params.targetLpSize as number) ?? 10_000_000_000;
    
    // Seeded RNG
    const seed = this.hashString(config.name);
    this.rng = this.createSeededRng(seed);
  }
  
  protected decide(currentPriceE6: number, priceHistory: number[]): TradeIntent | null {
    // LPBot doesn't trade in the traditional sense
    // It manages LP deposits/withdrawals
    // For now, we'll use TradeIntent with special semantics:
    // - size > 0: Deposit LP capital
    // - size < 0: Withdraw LP capital
    
    // Simulate market conditions
    const volatility = this.calculateVolatility(priceHistory);
    const utilizationRatio = this.rng(); // Mock utilization (in real impl, would query slab state)
    
    // If LP size below target, deposit
    if (this.currentLpSize < this.targetLpSize) {
      const depositAmount = Math.min(
        this.depositSize,
        this.targetLpSize - this.currentLpSize
      );
      
      console.log(`[${this.state.name}] 💰 Depositing LP: ${depositAmount / 1e9} SOL`);
      this.currentLpSize += depositAmount;
      
      // Note: Integration layer should handle this as Deposit instruction
      return this.createIntent(BigInt(depositAmount));
    }
    
    // If utilization low, consider withdrawing
    if (utilizationRatio < this.withdrawThreshold && this.currentLpSize > 0) {
      const withdrawAmount = Math.floor(this.currentLpSize * 0.2); // Withdraw 20%
      
      console.log(`[${this.state.name}] 💸 Withdrawing LP: ${withdrawAmount / 1e9} SOL (low utilization)`);
      this.currentLpSize -= withdrawAmount;
      
      // Negative size = withdrawal
      return this.createIntent(BigInt(-withdrawAmount));
    }
    
    // If high volatility, add more LP to capture fees
    if (volatility > 0.02 && this.currentLpSize < this.targetLpSize * 1.5) {
      const boostAmount = Math.floor(this.depositSize * 0.5);
      
      console.log(`[${this.state.name}] 🚀 Boosting LP on high volatility: ${boostAmount / 1e9} SOL`);
      this.currentLpSize += boostAmount;
      
      return this.createIntent(BigInt(boostAmount));
    }
    
    // Hold
    return null;
  }
  
  /**
   * Calculate price volatility (simple standard deviation)
   */
  private calculateVolatility(priceHistory: number[]): number {
    if (priceHistory.length < 10) return 0;
    
    const recent = priceHistory.slice(-20);
    const mean = recent.reduce((sum, p) => sum + p, 0) / recent.length;
    const variance = recent.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / recent.length;
    const stdDev = Math.sqrt(variance);
    
    return stdDev / mean; // Coefficient of variation
  }
  
  /**
   * Get current LP size
   */
  getLpSize(): number {
    return this.currentLpSize;
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
