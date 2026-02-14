import type { 
  PriceEngineConfig, 
  PriceEngineState, 
  PriceModel, 
  PriceModelParams, 
  PriceUpdate 
} from './types.js';
import { randomWalk, meanRevert, trending, crash, squeeze } from './models.js';

/**
 * Oracle Price Engine for simulation mode
 * 
 * Generates price movements based on configurable models and emits updates
 * via callback. Does not handle Solana transactions directly.
 * 
 * @example
 * ```typescript
 * const engine = new PriceEngine(
 *   {
 *     slabAddress: 'ABC123...',
 *     startPriceE6: 5000000,
 *     model: 'random-walk',
 *     intervalMs: 2000,
 *     params: { volatility: 0.01 }
 *   },
 *   (update) => {
 *     console.log(`New price: $${update.priceE6 / 1e6}`);
 *     // Handle Solana transaction here
 *   }
 * );
 * 
 * engine.start();
 * ```
 */
export class PriceEngine {
  private interval: ReturnType<typeof setInterval> | null = null;
  private state: PriceEngineState;
  private config: PriceEngineConfig;
  private onUpdate?: (update: PriceUpdate) => void;
  
  // Event timing for crash/squeeze
  private eventStartTime: number = 0;
  private eventDuration: number = 0;
  private eventActive: boolean = false;
  private eventType: 'crash' | 'squeeze' | null = null;
  private preEventPrice: number = 0;
  
  /**
   * Create a new price engine
   * 
   * @param config - Engine configuration
   * @param onUpdate - Callback invoked on each price update
   */
  constructor(config: PriceEngineConfig, onUpdate?: (update: PriceUpdate) => void) {
    this.config = {
      ...config,
      intervalMs: config.intervalMs ?? 2000, // Default 2 seconds
    };
    
    this.onUpdate = onUpdate;
    
    // Initialize state
    this.state = {
      running: false,
      currentPriceE6: config.startPriceE6,
      startPriceE6: config.startPriceE6,
      model: config.model,
      slabAddress: config.slabAddress,
      updatesCount: 0,
      startedAt: 0,
      lastUpdateAt: 0,
    };
  }
  
  /**
   * Start the price update loop
   */
  public start(): void {
    if (this.state.running) {
      console.warn('PriceEngine already running');
      return;
    }
    
    this.state.running = true;
    this.state.startedAt = Date.now();
    this.state.lastUpdateAt = Date.now();
    
    // Emit initial price
    this.tick();
    
    // Start interval
    this.interval = setInterval(() => {
      this.tick();
    }, this.config.intervalMs);
    
    console.log(`PriceEngine started: ${this.config.model} @ $${this.state.currentPriceE6 / 1e6}`);
  }
  
  /**
   * Stop the price update loop
   */
  public stop(): void {
    if (!this.state.running) {
      console.warn('PriceEngine not running');
      return;
    }
    
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    
    this.state.running = false;
    console.log(`PriceEngine stopped after ${this.state.updatesCount} updates`);
  }
  
  /**
   * Get current engine state
   * 
   * @returns Current state snapshot
   */
  public getState(): PriceEngineState {
    return { ...this.state };
  }
  
  /**
   * Switch price model on the fly
   * 
   * @param model - New model to use
   * @param params - Optional new parameters (merges with existing)
   */
  public setModel(model: PriceModel, params?: PriceModelParams): void {
    this.config.model = model;
    this.state.model = model;
    
    if (params) {
      this.config.params = {
        ...this.config.params,
        ...params,
      };
    }
    
    console.log(`PriceEngine model changed to: ${model}`);
  }
  
  /**
   * Trigger a crash event
   * Temporarily overrides the current model
   * 
   * @param magnitude - Crash magnitude (0-1, default from params or 0.3)
   * @param durationMs - Crash duration in milliseconds (default from params or 10000)
   */
  public triggerCrash(magnitude?: number, durationMs?: number): void {
    this.eventType = 'crash';
    this.eventActive = true;
    this.eventStartTime = Date.now();
    this.preEventPrice = this.state.currentPriceE6;
    
    // Update params for the crash
    const crashMagnitude = magnitude ?? this.config.params.crashMagnitude ?? 0.3;
    const crashDurationMs = durationMs ?? this.config.params.crashDurationMs ?? 10000;
    
    this.eventDuration = crashDurationMs;
    this.config.params = {
      ...this.config.params,
      crashMagnitude,
      crashDurationMs,
    };
    
    console.log(`Crash triggered: ${crashMagnitude * 100}% over ${crashDurationMs}ms`);
  }
  
  /**
   * Trigger a squeeze (pump) event
   * Temporarily overrides the current model
   * 
   * @param magnitude - Squeeze magnitude (default from params or 0.5)
   * @param durationMs - Squeeze duration in milliseconds (default from params or 10000)
   */
  public triggerSqueeze(magnitude?: number, durationMs?: number): void {
    this.eventType = 'squeeze';
    this.eventActive = true;
    this.eventStartTime = Date.now();
    this.preEventPrice = this.state.currentPriceE6;
    
    // Update params for the squeeze
    const squeezeMagnitude = magnitude ?? this.config.params.squeezeMagnitude ?? 0.5;
    const squeezeDurationMs = durationMs ?? this.config.params.squeezeDurationMs ?? 10000;
    
    this.eventDuration = squeezeDurationMs;
    this.config.params = {
      ...this.config.params,
      squeezeMagnitude,
      squeezeDurationMs,
    };
    
    console.log(`Squeeze triggered: ${squeezeMagnitude * 100}% over ${squeezeDurationMs}ms`);
  }
  
  /**
   * Execute a single price update tick
   */
  private tick(): void {
    // Compute next price
    const newPrice = this.computeNextPrice();
    
    // Update state
    this.state.currentPriceE6 = newPrice;
    this.state.lastUpdateAt = Date.now();
    this.state.updatesCount++;
    
    // Create update event
    const update: PriceUpdate = {
      priceE6: newPrice,
      timestamp: this.state.lastUpdateAt,
      model: this.state.model,
      slabAddress: this.config.slabAddress,
    };
    
    // Emit update via callback
    if (this.onUpdate) {
      try {
        this.onUpdate(update);
      } catch (error) {
        console.error('Error in price update callback:', error);
      }
    }
  }
  
  /**
   * Compute the next price based on current model
   * Handles event overrides (crash/squeeze)
   * 
   * @returns New price in E6 format
   */
  private computeNextPrice(): number {
    const currentPrice = this.state.currentPriceE6;
    const params = this.config.params;
    
    // Check if we're in an active event (crash/squeeze)
    if (this.eventActive && this.eventType) {
      const elapsed = Date.now() - this.eventStartTime;
      
      if (elapsed >= this.eventDuration) {
        // Event finished
        this.eventActive = false;
        console.log(`${this.eventType} event completed`);
        this.eventType = null;
      } else {
        // Event still active - use event model
        if (this.eventType === 'crash') {
          return crash(this.preEventPrice, params, elapsed, this.eventDuration);
        } else if (this.eventType === 'squeeze') {
          return squeeze(this.preEventPrice, params, elapsed, this.eventDuration);
        }
      }
    }
    
    // Normal model execution
    switch (this.config.model) {
      case 'random-walk':
        return randomWalk(currentPrice, params);
      
      case 'mean-revert':
        return meanRevert(currentPrice, params);
      
      case 'trending':
        return trending(currentPrice, params);
      
      case 'crash':
        // For static crash model, use time since start
        const crashElapsed = Date.now() - this.state.startedAt;
        const crashDuration = params.crashDurationMs ?? 10000;
        return crash(this.state.startPriceE6, params, crashElapsed, crashDuration);
      
      case 'squeeze':
        // For static squeeze model, use time since start
        const squeezeElapsed = Date.now() - this.state.startedAt;
        const squeezeDuration = params.squeezeDurationMs ?? 10000;
        return squeeze(this.state.startPriceE6, params, squeezeElapsed, squeezeDuration);
      
      case 'custom':
        // For custom models, fall back to random walk
        console.warn('Custom model not implemented, using random-walk');
        return randomWalk(currentPrice, params);
      
      default:
        console.warn(`Unknown model: ${this.config.model}, using random-walk`);
        return randomWalk(currentPrice, params);
    }
  }
}
