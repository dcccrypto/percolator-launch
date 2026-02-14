/**
 * Price movement model types for the oracle price engine
 */
export type PriceModel = 'random-walk' | 'mean-revert' | 'trending' | 'crash' | 'squeeze' | 'custom';

/**
 * Configuration for the price engine
 */
export interface PriceEngineConfig {
  /** Market to control (Solana address) */
  slabAddress: string;
  
  /** Starting price in E6 format (e.g., 5000000 = $5.00) */
  startPriceE6: number;
  
  /** Price movement model to use */
  model: PriceModel;
  
  /** Update interval in milliseconds (default: 2000 = 2 seconds) */
  intervalMs?: number;
  
  /** Model-specific parameters */
  params: PriceModelParams;
}

/**
 * Parameters for price movement models
 */
export interface PriceModelParams {
  // Random walk parameters
  /** Price change standard deviation as fraction (0.01 = 1%) */
  volatility?: number;
  
  // Mean revert parameters
  /** Target price to revert to (E6 format) */
  meanPrice?: number;
  /** How fast to revert: 0-1 (0.1 = slow, 0.9 = fast) */
  revertSpeed?: number;
  
  // Trending parameters
  /** Price drift per update (E6 format, positive = up, negative = down) */
  driftPerStep?: number;
  
  // Crash parameters
  /** How much to crash (0.5 = 50% drop) */
  crashMagnitude?: number;
  /** How long the crash takes (milliseconds) */
  crashDurationMs?: number;
  /** How fast to recover after crash (0 = no recovery, 1 = instant) */
  recoverySpeed?: number;
  
  // Squeeze parameters
  /** How much to pump (0.5 = 50% increase) */
  squeezeMagnitude?: number;
  /** How long the squeeze takes (milliseconds) */
  squeezeDurationMs?: number;
  
  // General constraints
  /** Floor price in E6 format (default: 1000 = $0.001) */
  minPrice?: number;
  /** Ceiling price in E6 format (default: 1000000000 = $1000) */
  maxPrice?: number;
}

/**
 * Price update event emitted by the engine
 */
export interface PriceUpdate {
  /** New price in E6 format */
  priceE6: number;
  /** Timestamp of the update (milliseconds since epoch) */
  timestamp: number;
  /** Model that generated this price */
  model: PriceModel;
  /** Market slab address */
  slabAddress: string;
}

/**
 * Current state of the price engine
 */
export interface PriceEngineState {
  /** Whether the engine is currently running */
  running: boolean;
  /** Current price in E6 format */
  currentPriceE6: number;
  /** Starting price in E6 format */
  startPriceE6: number;
  /** Currently active model */
  model: PriceModel;
  /** Market slab address */
  slabAddress: string;
  /** Number of price updates generated */
  updatesCount: number;
  /** Timestamp when engine started (milliseconds since epoch) */
  startedAt: number;
  /** Timestamp of last update (milliseconds since epoch) */
  lastUpdateAt: number;
}
