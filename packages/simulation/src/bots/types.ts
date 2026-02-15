/**
 * Bot Fleet Types
 * 
 * Type definitions for the Percolator simulation bot fleet.
 * Bots generate realistic trading activity without executing actual on-chain transactions.
 */

export type BotType = 'market-maker' | 'trend-follower' | 'degen' | 'lp-provider';

/**
 * Configuration for a single bot instance
 */
export interface BotConfig {
  type: BotType;
  name: string;
  slabAddress: string;
  
  // Trading parameters
  tradeIntervalMs: number;      // How often to trade
  maxPositionSize: number;       // Max position in base units
  capitalAllocation: number;     // How much capital this bot uses
  
  // Bot-specific params
  params: Record<string, number | string | boolean>;
}

/**
 * Runtime state of a bot
 */
export interface BotState {
  name: string;
  type: BotType;
  running: boolean;
  positionSize: number;
  entryPrice: number;
  pnl: number;
  tradesExecuted: number;
  lastTradeAt: number;
  accountIdx: number;           // Account index in the slab
}

/**
 * Intent to execute a trade
 * Emitted by bots, executed by integration layer
 */
export interface TradeIntent {
  slabAddress: string;
  lpIdx: number;
  userIdx: number;
  size: bigint;                  // Positive = long, negative = short
  botName: string;
}

/**
 * Configuration for the entire bot fleet
 */
export interface BotFleetConfig {
  slabAddress: string;
  bots: BotConfig[];
  enabled: boolean;
}

/**
 * Runtime state of the bot fleet
 */
export interface BotFleetState {
  running: boolean;
  slabAddress: string;
  bots: BotState[];
  totalTradesExecuted: number;
  startedAt: number;
}
