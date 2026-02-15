/**
 * WhaleBot - Massive position trader
 * 
 * Strategy:
 * - Opens HUGE positions (max size allowed)
 * - Tests insurance fund and system capital limits
 * - Can manipulate market price via large trades
 * - Only activates in specific scenarios (manual trigger)
 * - Simulates institutional/whale trading behavior
 * 
 * Params:
 * - onlyOnTrigger: Only trade when manually triggered (default true)
 * - manipulationMode: Intentionally move market (default false)
 * - targetPriceMoveBps: Target price impact in bps (default 1000 = 10%)
 */

import { Connection, Keypair } from "@solana/web3.js";
import { BaseBot, type BotConfig } from "./BaseBot.js";

export class WhaleBot extends BaseBot {
  private onlyOnTrigger: boolean;
  private manipulationMode: boolean;
  private targetPriceMoveBps: number;
  private triggered: boolean = false;
  private actionPhase: "accumulate" | "dump" | "idle" = "idle";
  private accumulatedSize: bigint = 0n;
  
  constructor(
    config: BotConfig,
    connection: Connection,
    keypair: Keypair,
    onLog?: (message: string) => void
  ) {
    super(config, connection, keypair, onLog);
    
    this.onlyOnTrigger = (config.params.onlyOnTrigger as boolean) ?? true;
    this.manipulationMode = (config.params.manipulationMode as boolean) ?? false;
    this.targetPriceMoveBps = (config.params.targetPriceMoveBps as number) ?? 1000;
  }
  
  /**
   * Manually trigger whale action
   */
  trigger(action: "buy" | "sell" | "manipulate"): void {
    this.triggered = true;
    
    if (action === "manipulate") {
      this.manipulationMode = true;
      this.actionPhase = "accumulate";
      this.log(`🐋 WHALE MANIPULATION MODE ACTIVATED`);
    } else {
      this.actionPhase = action === "buy" ? "accumulate" : "dump";
      this.log(`🐋 WHALE ${action.toUpperCase()} TRIGGERED`);
    }
  }
  
  protected decide(): bigint {
    // Wait for manual trigger if configured
    if (this.onlyOnTrigger && !this.triggered) {
      return 0n;
    }
    
    // Need price data
    if (this.priceHistory.length < 2) {
      return 0n;
    }
    
    // Execute based on phase
    switch (this.actionPhase) {
      case "accumulate":
        return this.accumulate();
      
      case "dump":
        return this.dump();
      
      case "idle":
      default:
        return this.idle();
    }
  }
  
  /**
   * Accumulate phase: Buy massive position
   */
  private accumulate(): bigint {
    // Already accumulated enough?
    if (this.state.positionSize >= this.config.maxPositionSize) {
      if (this.manipulationMode) {
        // Switch to dump phase
        this.actionPhase = "dump";
        this.log(`🐋 Accumulated ${this.state.positionSize} units. Switching to DUMP phase...`);
        return 0n;
      } else {
        // Done accumulating
        this.actionPhase = "idle";
        this.triggered = false;
        this.log(`🐋 Accumulation complete. Holding ${this.state.positionSize} units.`);
        return 0n;
      }
    }
    
    // Buy max allowed per trade (25% of max position)
    const tradeSize = this.config.maxPositionSize / 4n;
    
    this.log(`🐋 ACCUMULATING: Buying ${tradeSize} units`);
    return tradeSize;
  }
  
  /**
   * Dump phase: Sell massive position
   */
  private dump(): bigint {
    // Already dumped everything?
    if (this.state.positionSize <= 0n) {
      this.actionPhase = "idle";
      this.triggered = false;
      this.manipulationMode = false;
      this.log(`🐋 Dump complete. Position closed.`);
      return 0n;
    }
    
    // Sell max allowed per trade (50% of current position for faster dump)
    const dumpSize = -(this.state.positionSize / 2n);
    
    this.log(`🐋 DUMPING: Selling ${-dumpSize} units`);
    return dumpSize;
  }
  
  /**
   * Idle phase: Hold position or random whale behavior
   */
  private idle(): bigint {
    // Random chance to make a whale move (5%)
    if (!this.onlyOnTrigger && Math.random() < 0.05) {
      const action = Math.random() < 0.5 ? "accumulate" : "dump";
      this.actionPhase = action;
      this.log(`🐋 Random whale action: ${action.toUpperCase()}`);
      return 0n; // Will execute next tick
    }
    
    // Hold current position
    return 0n;
  }
  
  /**
   * Calculate current market impact
   */
  private calculateMarketImpact(): number {
    if (this.priceHistory.length < 2) {
      return 0;
    }
    
    const oldPrice = this.priceHistory[0];
    const currentPrice = this.currentPriceE6;
    
    const changeBps = Number((currentPrice - oldPrice) * 10000n / oldPrice);
    return changeBps;
  }
}
