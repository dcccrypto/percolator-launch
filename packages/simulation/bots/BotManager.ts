/**
 * BotManager - Orchestrates the trading bot fleet
 * 
 * Responsibilities:
 * - Creates and manages bot instances
 * - Funds bots via devnet faucet (requests SOL airdrop)
 * - Distributes price updates to all bots
 * - Coordinates bot lifecycle (initialize/start/stop)
 * - Configures bot behavior per scenario
 * - Aggregates and logs bot activity
 */

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { BaseBot } from "./BaseBot.js";
import { MarketMakerBot } from "./MarketMakerBot.js";
import { TrendFollowerBot } from "./TrendFollowerBot.js";
import { LiquidationBot } from "./LiquidationBot.js";
import { WhaleBot } from "./WhaleBot.js";

export interface ScenarioConfig {
  name: string;
  enabledBots: string[]; // Which bot types to activate
  aggressiveness: number; // 0-1 scale (affects trade frequency, size)
  duration?: number;      // Scenario duration in milliseconds
}

export interface BotManagerConfig {
  slabAddress: string;
  programId: string;
  rpcUrl: string;
  scenario: ScenarioConfig;
  priceUpdateIntervalMs?: number;
}

export class BotManager {
  private config: BotManagerConfig;
  private connection: Connection;
  private bots: BaseBot[] = [];
  private running: boolean = false;
  private logs: string[] = [];
  
  constructor(config: BotManagerConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl, "confirmed");
  }
  
  /**
   * Initialize all bots
   * - Creates keypairs
   * - Requests devnet SOL airdrops
   * - Creates on-chain accounts
   * - Deposits initial capital
   */
  async initializeBots(): Promise<void> {
    console.log(`[BotManager] Initializing bots for scenario: ${this.config.scenario.name}`);
    
    const botConfigs = this.getBotConfigsForScenario();
    
    for (const config of botConfigs) {
      try {
        // Generate keypair
        const keypair = Keypair.generate();
        console.log(`[BotManager] Created keypair for ${config.name}: ${keypair.publicKey.toBase58()}`);
        
        // Request airdrop (devnet only!)
        const airdropAmount = 2 * LAMPORTS_PER_SOL; // 2 SOL for trading
        await this.requestAirdrop(keypair.publicKey, airdropAmount);
        
        // Create bot instance
        const bot = this.createBot(config, keypair);
        if (!bot) continue;
        
        // Initialize on-chain account
        await bot.initialize();
        
        this.bots.push(bot);
        console.log(`[BotManager] ✅ Initialized ${config.name} (${config.type})`);
      } catch (error) {
        console.error(`[BotManager] Failed to initialize ${config.name}:`, error);
        // Continue with other bots
      }
    }
    
    console.log(`[BotManager] Initialized ${this.bots.length} bots`);
  }
  
  /**
   * Start all bots
   */
  start(): void {
    if (this.running) {
      console.warn("[BotManager] Already running");
      return;
    }
    
    this.running = true;
    
    for (const bot of this.bots) {
      bot.start();
    }
    
    console.log(`[BotManager] Started ${this.bots.length} bots`);
  }
  
  /**
   * Stop all bots
   */
  stop(): void {
    if (!this.running) {
      return;
    }
    
    for (const bot of this.bots) {
      bot.stop();
    }
    
    this.running = false;
    console.log("[BotManager] Stopped all bots");
  }
  
  /**
   * Update price for all bots
   * Called by PriceOracle when price changes
   */
  updatePrice(priceE6: bigint): void {
    for (const bot of this.bots) {
      bot.updatePrice(priceE6);
    }
  }
  
  /**
   * Get current state of all bots
   */
  getBotStates(): any[] {
    return this.bots.map(bot => bot.getState());
  }
  
  /**
   * Get recent logs
   */
  getLogs(limit: number = 100): string[] {
    return this.logs.slice(-limit);
  }
  
  /**
   * Request devnet SOL airdrop
   */
  private async requestAirdrop(publicKey: PublicKey, amount: number): Promise<void> {
    console.log(`[BotManager] Requesting ${amount / LAMPORTS_PER_SOL} SOL airdrop for ${publicKey.toBase58()}`);
    
    try {
      const signature = await this.connection.requestAirdrop(publicKey, amount);
      await this.connection.confirmTransaction(signature, "confirmed");
      console.log(`[BotManager] Airdrop confirmed: ${signature}`);
    } catch (error) {
      console.error("[BotManager] Airdrop failed:", error);
      throw new Error(`Failed to fund bot keypair: ${error}`);
    }
  }
  
  /**
   * Create bot instance based on type
   */
  private createBot(config: any, keypair: Keypair): BaseBot | null {
    const onLog = (message: string) => {
      this.logs.push(message);
      // Keep only last 1000 logs
      if (this.logs.length > 1000) {
        this.logs.shift();
      }
    };
    
    switch (config.type) {
      case "market-maker":
        return new MarketMakerBot(config, this.connection, keypair, onLog);
      
      case "trend-follower":
        return new TrendFollowerBot(config, this.connection, keypair, onLog);
      
      case "liquidation":
        return new LiquidationBot(config, this.connection, keypair, onLog);
      
      case "whale":
        return new WhaleBot(config, this.connection, keypair, onLog);
      
      default:
        console.error(`[BotManager] Unknown bot type: ${config.type}`);
        return null;
    }
  }
  
  /**
   * Get bot configurations for the active scenario
   */
  private getBotConfigsForScenario(): any[] {
    const { scenario } = this.config;
    const aggression = scenario.aggressiveness;
    
    const configs: any[] = [];
    
    // MarketMaker: Always active for liquidity
    if (scenario.enabledBots.includes("market-maker")) {
      configs.push({
        type: "market-maker",
        name: "MM-Alpha",
        slabAddress: this.config.slabAddress,
        programId: this.config.programId,
        initialCapital: BigInt(500_000_000), // 0.5 SOL
        maxPositionSize: BigInt(1_000_000), // 1M units
        tradeIntervalMs: Math.floor(5000 / aggression), // Faster when aggressive
        params: {
          spreadBps: 50,
          rebalanceThreshold: 0.3,
        },
      });
    }
    
    // TrendFollower: Medium-term trader
    if (scenario.enabledBots.includes("trend-follower")) {
      configs.push({
        type: "trend-follower",
        name: "Trend-1",
        slabAddress: this.config.slabAddress,
        programId: this.config.programId,
        initialCapital: BigInt(300_000_000), // 0.3 SOL
        maxPositionSize: BigInt(2_000_000), // 2M units
        tradeIntervalMs: 15000,
        params: {
          maPeriod: 20,
          stopLossBps: 200,
          takeProfitBps: 500,
        },
      });
    }
    
    // LiquidationBot: Intentionally risky
    if (scenario.enabledBots.includes("liquidation")) {
      configs.push({
        type: "liquidation",
        name: "Liq-Degen",
        slabAddress: this.config.slabAddress,
        programId: this.config.programId,
        initialCapital: BigInt(100_000_000), // 0.1 SOL (small capital)
        maxPositionSize: BigInt(5_000_000), // 5M units (high leverage)
        tradeIntervalMs: 30000,
        params: {
          targetLeverage: 15, // 15x leverage
          triggerOnCrash: true,
        },
      });
    }
    
    // WhaleBot: Only in specific scenarios
    if (scenario.enabledBots.includes("whale")) {
      configs.push({
        type: "whale",
        name: "Moby-Dick",
        slabAddress: this.config.slabAddress,
        programId: this.config.programId,
        initialCapital: BigInt(5_000_000_000), // 5 SOL
        maxPositionSize: BigInt(100_000_000), // 100M units
        tradeIntervalMs: 60000,
        params: {
          onlyOnTrigger: true, // Manual trigger via scenario
        },
      });
    }
    
    return configs;
  }
  
  /**
   * Predefined scenarios
   */
  static SCENARIOS = {
    NORMAL: {
      name: "Normal Market",
      enabledBots: ["market-maker", "trend-follower"],
      aggressiveness: 0.5,
    },
    VOLATILE: {
      name: "Volatile Market",
      enabledBots: ["market-maker", "trend-follower", "liquidation"],
      aggressiveness: 0.8,
    },
    CRASH: {
      name: "Market Crash",
      enabledBots: ["market-maker", "trend-follower", "liquidation"],
      aggressiveness: 1.0,
      duration: 300_000, // 5 minutes
    },
    WHALE_ATTACK: {
      name: "Whale Manipulation",
      enabledBots: ["market-maker", "whale"],
      aggressiveness: 0.7,
      duration: 180_000, // 3 minutes
    },
    STRESS_TEST: {
      name: "System Stress Test",
      enabledBots: ["market-maker", "trend-follower", "liquidation", "whale"],
      aggressiveness: 1.0,
    },
  };
}
