/**
 * Trading Bot Fleet - Exports
 * 
 * Real trading bots that execute on-chain trades via Percolator on Solana devnet.
 */

export { BaseBot, type BotConfig, type BotState } from "./BaseBot.js";
export { BotManager, type ScenarioConfig, type BotManagerConfig } from "./BotManager.js";
export { MarketMakerBot } from "./MarketMakerBot.js";
export { TrendFollowerBot } from "./TrendFollowerBot.js";
export { LiquidationBot } from "./LiquidationBot.js";
export { WhaleBot } from "./WhaleBot.js";
