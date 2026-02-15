/**
 * BotFleet - Manages a fleet of trading bots
 * 
 * Responsibilities:
 * - Creates and manages bot instances
 * - Distributes price updates to all bots
 * - Coordinates bot lifecycle (start/stop)
 * - Aggregates fleet state
 * 
 * The fleet receives price updates from PriceEngine and passes them to bots.
 * Bots emit TradeIntents which are forwarded to the integration layer.
 */

import { BaseBot } from './BaseBot.js';
import { MarketMakerBot } from './MarketMakerBot.js';
import { TrendFollowerBot } from './TrendFollowerBot.js';
import { DegenBot } from './DegenBot.js';
import { LPBot } from './LPBot.js';
import type { BotFleetConfig, BotFleetState, BotConfig, TradeIntent } from './types.js';

export class BotFleet {
  private config: BotFleetConfig;
  private bots: BaseBot[] = [];
  private priceHistory: number[] = [];
  private currentPriceE6: number = 0;
  private startedAt: number = 0;
  private onTrade?: (intent: TradeIntent) => Promise<boolean>;
  
  /**
   * Create a new bot fleet
   * @param config Fleet configuration
   * @param onTrade Callback to execute trades (forwarded to bots)
   */
  constructor(
    config: BotFleetConfig,
    onTrade?: (intent: TradeIntent) => Promise<boolean>
  ) {
    this.config = config;
    this.onTrade = onTrade;
    
    // Create bot instances
    this.initializeBots();
  }
  
  /**
   * Initialize bot instances from config
   */
  private initializeBots(): void {
    let accountIdx = 2; // Start at 2 (0=Admin, 1=LP)
    
    for (const botConfig of this.config.bots) {
      const bot = this.createBot(botConfig, accountIdx);
      if (bot) {
        this.bots.push(bot);
        accountIdx++;
      }
    }
    
    console.log(`[BotFleet] Initialized ${this.bots.length} bots`);
  }
  
  /**
   * Create a bot instance based on type
   */
  private createBot(config: BotConfig, accountIdx: number): BaseBot | null {
    switch (config.type) {
      case 'market-maker':
        return new MarketMakerBot(config, accountIdx, this.onTrade);
      
      case 'trend-follower':
        return new TrendFollowerBot(config, accountIdx, this.onTrade);
      
      case 'degen':
        return new DegenBot(config, accountIdx, this.onTrade);
      
      case 'lp-provider':
        // LP uses accountIdx as lpIdx (1 for first LP)
        return new LPBot(config, 1, this.onTrade);
      
      default:
        console.error(`[BotFleet] Unknown bot type: ${config.type}`);
        return null;
    }
  }
  
  /**
   * Start all bots
   */
  start(): void {
    if (!this.config.enabled) {
      console.warn('[BotFleet] Fleet is disabled in config');
      return;
    }
    
    this.startedAt = Date.now();
    
    for (const bot of this.bots) {
      bot.start();
    }
    
    console.log(`[BotFleet] Started ${this.bots.length} bots`);
  }
  
  /**
   * Stop all bots
   */
  stop(): void {
    for (const bot of this.bots) {
      bot.stop();
    }
    
    console.log('[BotFleet] Stopped all bots');
  }
  
  /**
   * Get current fleet state
   */
  getState(): BotFleetState {
    const botStates = this.bots.map(bot => bot.getState());
    const totalTrades = botStates.reduce((sum, state) => sum + state.tradesExecuted, 0);
    const running = botStates.some(state => state.running);
    
    return {
      running,
      slabAddress: this.config.slabAddress,
      bots: botStates,
      totalTradesExecuted: totalTrades,
      startedAt: this.startedAt,
    };
  }
  
  /**
   * Update price for all bots
   * Called by PriceEngine when price changes
   */
  updatePrice(priceE6: number): void {
    if (priceE6 <= 0) {
      console.warn('[BotFleet] Received invalid price:', priceE6);
      return;
    }
    
    this.currentPriceE6 = priceE6;
    this.priceHistory.push(priceE6);
    
    // Keep last 100 prices
    if (this.priceHistory.length > 100) {
      this.priceHistory.shift();
    }
    
    // Distribute to all bots
    for (const bot of this.bots) {
      bot.updatePrice(priceE6, this.priceHistory);
    }
  }
  
  /**
   * Add a new bot to the fleet
   */
  addBot(config: BotConfig): void {
    const accountIdx = this.bots.length + 2; // Dynamic index assignment
    const bot = this.createBot(config, accountIdx);
    
    if (bot) {
      this.bots.push(bot);
      
      // Start immediately if fleet is running
      const fleetRunning = this.bots.some(b => b.getState().running);
      if (fleetRunning) {
        bot.updatePrice(this.currentPriceE6, this.priceHistory);
        bot.start();
      }
      
      console.log(`[BotFleet] Added bot: ${config.name} (${config.type})`);
    }
  }
  
  /**
   * Remove a bot from the fleet
   */
  removeBot(name: string): void {
    const index = this.bots.findIndex(bot => bot.getState().name === name);
    
    if (index === -1) {
      console.warn(`[BotFleet] Bot not found: ${name}`);
      return;
    }
    
    const bot = this.bots[index];
    bot.stop();
    this.bots.splice(index, 1);
    
    console.log(`[BotFleet] Removed bot: ${name}`);
  }
  
  /**
   * Get bot by name
   */
  getBot(name: string): BaseBot | undefined {
    return this.bots.find(bot => bot.getState().name === name);
  }
  
  /**
   * Get all bots of a specific type
   */
  getBotsByType(type: string): BaseBot[] {
    return this.bots.filter(bot => bot.getState().type === type);
  }
}
