import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { pushOraclePrice, loadOracleKeypair } from './solana';
import { getConfig } from '@/lib/config';
import { getServiceClient } from '@/lib/supabase';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- simulation tables added by migration 011, types not yet regenerated
type SimSupabase = ReturnType<typeof getServiceClient> & { from(table: string): any };
import { SCENARIOS, ScenarioName } from './scenarios';
import { getPythPriceManager, PythFeedName } from './pyth';

/**
 * Box-Muller transform for Gaussian random numbers
 * Returns a random number from a standard normal distribution (mean=0, stddev=1)
 */
function gaussianRandom(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random(); // Converting [0,1) to (0,1)
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

interface SimulationConfig {
  slabAddress: string;
  startPriceE6: number;
  model: string;
  scenario?: ScenarioName;
  intervalMs?: number;
  params?: Record<string, number>;
  pythFeed?: PythFeedName; // For Pyth-correlated modes
}

interface SimulationState {
  running: boolean;
  slabAddress: string | null;
  currentPriceE6: number;
  model: string;
  scenario: ScenarioName | null;
  startedAt: number;
  updatesCount: number;
  sessionId: number | null;
  params: Record<string, number>;
  pythFeed: PythFeedName | null;
  pythBasePrice: number | null; // Last known Pyth base price
}

/** Tracks a self-service simulation session's on-chain assets */
export interface SelfServiceSession {
  /** Oracle authority keypair (generated server-side, used to push prices) */
  oracleKeypair: Keypair;
  /** SPL token mint keypair (we are mint authority) */
  mintKeypair: Keypair;
  /** The slab/market address on-chain */
  slabAddress: string;
  /** Token metadata */
  tokenName: string;
  tokenSymbol: string;
  /** The user's wallet that funded this session */
  payerPublicKey: string;
  /** Timestamp when session was created */
  createdAt: number;
}

/**
 * Singleton manager for simulation mode
 * 
 * Handles:
 * - Price model execution (random walk, mean revert, crash, squeeze, etc.)
 * - Periodic price updates via PushOraclePrice
 * - Simulation state management
 * - Database session tracking
 * - Self-service session keypair storage (oracle + mint)
 */
export class SimulationManager {
  private static instance: SimulationManager;
  
  private state: SimulationState = {
    running: false,
    slabAddress: null,
    currentPriceE6: 0,
    model: 'random-walk',
    scenario: null,
    startedAt: 0,
    updatesCount: 0,
    sessionId: null,
    params: {},
    pythFeed: null,
    pythBasePrice: null,
  };
  
  private priceInterval: NodeJS.Timeout | null = null;
  private connection: Connection | null = null;
  
  // Scenario-specific state
  private meanPrice = 0;
  private scenarioStartTime = 0;
  private scenarioDuration = 0;

  // Self-service session storage (in-memory, keyed by payer pubkey)
  private selfServiceSessions = new Map<string, SelfServiceSession>();
  
  private constructor() {}
  
  static getInstance(): SimulationManager {
    if (!SimulationManager.instance) {
      SimulationManager.instance = new SimulationManager();
    }
    return SimulationManager.instance;
  }

  // ─── Self-Service Session Management ───────────────────────────────

  /**
   * Store a self-service session's keypairs and metadata.
   */
  storeSelfServiceSession(session: SelfServiceSession): void {
    this.selfServiceSessions.set(session.payerPublicKey, session);
  }

  /**
   * Get a self-service session by payer public key.
   */
  getSelfServiceSession(payerPublicKey: string): SelfServiceSession | undefined {
    return this.selfServiceSessions.get(payerPublicKey);
  }

  /**
   * Remove a self-service session.
   */
  removeSelfServiceSession(payerPublicKey: string): void {
    this.selfServiceSessions.delete(payerPublicKey);
  }

  /**
   * Get the oracle keypair for price pushing.
   * Checks self-service sessions first, then falls back to env var.
   */
  getOracleKeypair(slabAddress?: string): Keypair | null {
    // Check self-service sessions
    if (slabAddress) {
      for (const session of this.selfServiceSessions.values()) {
        if (session.slabAddress === slabAddress) {
          return session.oracleKeypair;
        }
      }
    }
    // Fallback to env-based keypair
    return loadOracleKeypair();
  }
  
  /**
   * Start a new simulation session
   */
  async start(config: SimulationConfig): Promise<void> {
    if (this.state.running) {
      throw new Error('Simulation already running. Stop it first.');
    }
    
    const keypair = this.getOracleKeypair(config.slabAddress);
    if (!keypair) {
      throw new Error('No oracle keypair available. Create a market first or set SIMULATION_ORACLE_KEYPAIR.');
    }
    
    const cfg = getConfig();
    this.connection = new Connection(cfg.rpcUrl, 'confirmed');
    
    // Apply scenario parameters if scenario is provided
    let model = config.model;
    let params = config.params || {};
    
    if (config.scenario) {
      const scenario = SCENARIOS[config.scenario];
      model = scenario.model;
      params = { ...scenario.params, ...params }; // Allow override
      this.scenarioDuration = scenario.durationMs;
      this.scenarioStartTime = Date.now();
    }
    
    // Set default params based on model
    if (model === 'random-walk' && !params.volatility) {
      params.volatility = 0.005;
    }
    if (model === 'mean-revert') {
      if (!params.volatility) params.volatility = 0.002;
      if (!params.revertSpeed) params.revertSpeed = 0.1;
      this.meanPrice = config.startPriceE6;
    }
    
    // Initialize Pyth if model uses it
    const isPythMode = model.startsWith('pyth-');
    let pythFeed: PythFeedName | null = null;
    let pythBasePrice: number | null = null;
    
    if (isPythMode) {
      pythFeed = config.pythFeed || 'SOL/USD'; // Default to SOL/USD
      
      // Start Pyth polling
      const pythManager = getPythPriceManager();
      pythManager.startPolling([pythFeed], config.intervalMs || 3000);
      
      // Get initial price
      pythBasePrice = pythManager.getLatestPrice(pythFeed);
      
      if (!pythBasePrice) {
        console.log(`Fetching initial Pyth price for ${pythFeed}...`);
        pythBasePrice = await pythManager.fetchSinglePrice(pythFeed);
        
        if (!pythBasePrice) {
          throw new Error(`Failed to fetch initial Pyth price for ${pythFeed}`);
        }
      }
      
      console.log(`Pyth mode initialized: ${pythFeed} = $${pythBasePrice.toFixed(2)}`);
    }
    
    this.state = {
      running: true,
      slabAddress: config.slabAddress,
      currentPriceE6: config.startPriceE6,
      model,
      scenario: config.scenario || null,
      startedAt: Date.now(),
      updatesCount: 0,
      sessionId: null,
      params,
      pythFeed,
      pythBasePrice,
    };
    
    // Create database session record
    try {
      const supabase = getServiceClient() as SimSupabase;
      const { data, error } = await supabase
        .from('simulation_sessions')
        .insert({
          slab_address: config.slabAddress,
          scenario: config.scenario || null,
          model,
          start_price_e6: config.startPriceE6,
          current_price_e6: config.startPriceE6,
          status: 'running',
          config: params,
        })
        .select('id')
        .single();
      
      if (error) {
        console.error('Failed to create simulation session:', error);
      } else {
        this.state.sessionId = data.id;
      }
    } catch (err) {
      console.error('Database error creating session:', err);
    }
    
    // Start price update loop
    const intervalMs = config.intervalMs || 5000; // Default 5 seconds
    this.priceInterval = setInterval(() => {
      this.updatePrice().catch(console.error);
    }, intervalMs);
    
    // Send initial price
    await this.sendPriceToChain(config.startPriceE6);
  }
  
  /**
   * Stop the current simulation
   */
  stop(): void {
    if (!this.state.running) {
      return;
    }
    
    if (this.priceInterval) {
      clearInterval(this.priceInterval);
      this.priceInterval = null;
    }
    
    // Stop Pyth polling if active
    if (this.state.pythFeed) {
      const pythManager = getPythPriceManager();
      pythManager.stopPolling();
    }
    
    // Update database session to completed
    if (this.state.sessionId) {
      const supabase = getServiceClient() as SimSupabase;
      supabase
        .from('simulation_sessions')
        .update({
          status: 'completed',
          ended_at: new Date().toISOString(),
          current_price_e6: this.state.currentPriceE6,
          updates_count: this.state.updatesCount,
        })
        .eq('id', this.state.sessionId)
        .then(() => { /* noop */ });
    }
    
    this.state.running = false;
    this.connection = null;
  }
  
  /**
   * Get current simulation state
   */
  getState(): SimulationState {
    return {
      ...this.state,
      // Add runtime info
    };
  }
  
  /**
   * Manually set price (bypasses model)
   */
  async setPrice(priceE6: number): Promise<void> {
    if (!this.state.running) {
      throw new Error('Simulation not running');
    }
    
    this.state.currentPriceE6 = priceE6;
    await this.sendPriceToChain(priceE6);
  }
  
  /**
   * Change the price model
   */
  setModel(model: string, params?: Record<string, number>): void {
    this.state.model = model;
    if (params) {
      this.state.params = { ...this.state.params, ...params };
    }
  }
  
  /**
   * Switch to a different scenario
   */
  triggerScenario(scenario: ScenarioName): void {
    const config = SCENARIOS[scenario];
    this.state.scenario = scenario;
    this.state.model = config.model;
    this.state.params = { ...config.params };
    this.scenarioStartTime = Date.now();
    this.scenarioDuration = config.durationMs;
    
    if (config.model === 'mean-revert') {
      this.meanPrice = this.state.currentPriceE6;
    }
  }
  
  /**
   * Execute one price update step based on current model
   */
  private async updatePrice(): Promise<void> {
    if (!this.state.running) return;
    
    // Check if scenario has expired
    if (this.state.scenario && this.scenarioDuration > 0) {
      const elapsed = Date.now() - this.scenarioStartTime;
      if (elapsed >= this.scenarioDuration) {
        console.log(`Scenario ${this.state.scenario} completed, stopping simulation`);
        this.stop();
        return;
      }
    }
    
    let newPrice = this.state.currentPriceE6;
    
    switch (this.state.model) {
      case 'random-walk':
        newPrice = this.randomWalk(this.state.currentPriceE6);
        break;
      case 'mean-revert':
        newPrice = this.meanRevert(this.state.currentPriceE6);
        break;
      case 'trending':
        newPrice = this.trending(this.state.currentPriceE6);
        break;
      case 'crash':
        newPrice = this.crash(this.state.currentPriceE6);
        break;
      case 'squeeze':
        newPrice = this.squeeze(this.state.currentPriceE6);
        break;
      case 'pyth-calm':
        newPrice = this.pythCalm();
        break;
      case 'pyth-crash':
        newPrice = this.pythCrash();
        break;
      case 'pyth-squeeze':
        newPrice = this.pythSqueeze();
        break;
      case 'pyth-blackswan':
        newPrice = this.pythBlackSwan();
        break;
      case 'pyth-volatile':
        newPrice = this.pythVolatile();
        break;
      default:
        newPrice = this.randomWalk(this.state.currentPriceE6);
    }
    
    // Ensure price doesn't go negative
    newPrice = Math.max(newPrice, 1);
    
    this.state.currentPriceE6 = Math.round(newPrice);
    this.state.updatesCount++;
    
    await this.sendPriceToChain(this.state.currentPriceE6);
    await this.recordPriceHistory(this.state.currentPriceE6);
  }
  
  /**
   * Random walk: price * (1 + volatility * gaussianRandom())
   */
  private randomWalk(price: number): number {
    const volatility = this.state.params.volatility || 0.005;
    return price * (1 + volatility * gaussianRandom());
  }
  
  /**
   * Mean revert: price + revertSpeed * (meanPrice - price) + noise
   */
  private meanRevert(price: number): number {
    const volatility = this.state.params.volatility || 0.002;
    const revertSpeed = this.state.params.revertSpeed || 0.1;
    const noise = volatility * price * gaussianRandom();
    return price + revertSpeed * (this.meanPrice - price) + noise;
  }
  
  /**
   * Trending: random walk with drift
   */
  private trending(price: number): number {
    const volatility = this.state.params.volatility || 0.005;
    const drift = this.state.params.driftPerStep || 0.001;
    return price * (1 + drift + volatility * gaussianRandom());
  }
  
  /**
   * Crash: exponential decay to target
   */
  private crash(price: number): number {
    const magnitude = this.state.params.crashMagnitude || 0.4;
    const volatility = this.state.params.volatility || 0.02;
    const elapsed = Date.now() - this.scenarioStartTime;
    const duration = this.scenarioDuration || 120000;
    const progress = Math.min(elapsed / duration, 1);
    
    // Exponential decay
    const targetMultiplier = 1 - magnitude;
    const decay = 1 - (1 - targetMultiplier) * (1 - Math.exp(-5 * progress));
    
    return price * decay * (1 + volatility * gaussianRandom());
  }
  
  /**
   * Squeeze: exponential rise then decay
   */
  private squeeze(price: number): number {
    const magnitude = this.state.params.squeezeMagnitude || 0.5;
    const volatility = this.state.params.volatility || 0.01;
    const elapsed = Date.now() - this.scenarioStartTime;
    const duration = this.scenarioDuration || 180000;
    const progress = Math.min(elapsed / duration, 1);
    
    // Rise to peak at 50%, then decay
    let multiplier: number;
    if (progress < 0.5) {
      // Rising phase
      const riseProgress = progress * 2;
      multiplier = 1 + magnitude * (1 - Math.exp(-5 * riseProgress));
    } else {
      // Decay phase
      const decayProgress = (progress - 0.5) * 2;
      multiplier = 1 + magnitude * Math.exp(-3 * decayProgress);
    }
    
    return price * multiplier * (1 + volatility * gaussianRandom());
  }
  
  /**
   * Get current Pyth base price with fallback
   */
  private getPythBasePrice(): number {
    if (!this.state.pythFeed) {
      console.error('Pyth feed not configured');
      return this.state.currentPriceE6 / 1e6; // Fallback to current price
    }
    
    const pythManager = getPythPriceManager();
    const livePrice = pythManager.getLatestPrice(this.state.pythFeed);
    
    if (livePrice) {
      this.state.pythBasePrice = livePrice;
      return livePrice;
    }
    
    // Fallback to last known price
    if (this.state.pythBasePrice) {
      console.warn(`Using cached Pyth price: $${this.state.pythBasePrice.toFixed(2)}`);
      return this.state.pythBasePrice;
    }
    
    // Last resort: use current simulation price
    console.error('No Pyth price available, using simulation price');
    return this.state.currentPriceE6 / 1e6;
  }
  
  /**
   * Pyth-Calm: Live price + small random noise
   */
  private pythCalm(): number {
    const basePrice = this.getPythBasePrice();
    const volatility = this.state.params.volatility || 0.001;
    const noise = volatility * basePrice * gaussianRandom();
    return (basePrice + noise) * 1e6; // Convert to E6
  }
  
  /**
   * Pyth-Crash: Live price * crash multiplier (ramps down over time)
   */
  private pythCrash(): number {
    const basePrice = this.getPythBasePrice();
    const magnitude = this.state.params.crashMagnitude || 0.4;
    const volatility = this.state.params.volatility || 0.02;
    const elapsed = Date.now() - this.scenarioStartTime;
    const duration = this.scenarioDuration || 120000;
    const progress = Math.min(elapsed / duration, 1);
    
    // Exponential decay from base price
    const targetMultiplier = 1 - magnitude;
    const decay = 1 - (1 - targetMultiplier) * (1 - Math.exp(-5 * progress));
    
    const crashPrice = basePrice * decay * (1 + volatility * gaussianRandom());
    return crashPrice * 1e6;
  }
  
  /**
   * Pyth-Squeeze: Live price * squeeze multiplier (spikes up)
   */
  private pythSqueeze(): number {
    const basePrice = this.getPythBasePrice();
    const magnitude = this.state.params.squeezeMagnitude || 0.5;
    const volatility = this.state.params.volatility || 0.01;
    const elapsed = Date.now() - this.scenarioStartTime;
    const duration = this.scenarioDuration || 180000;
    const progress = Math.min(elapsed / duration, 1);
    
    // Rise to peak at 50%, then decay
    let multiplier: number;
    if (progress < 0.5) {
      const riseProgress = progress * 2;
      multiplier = 1 + magnitude * (1 - Math.exp(-5 * riseProgress));
    } else {
      const decayProgress = (progress - 0.5) * 2;
      multiplier = 1 + magnitude * Math.exp(-3 * decayProgress);
    }
    
    const squeezePrice = basePrice * multiplier * (1 + volatility * gaussianRandom());
    return squeezePrice * 1e6;
  }
  
  /**
   * Pyth-BlackSwan: Live price * -40% sudden drop
   */
  private pythBlackSwan(): number {
    const basePrice = this.getPythBasePrice();
    const magnitude = this.state.params.crashMagnitude || 0.4;
    const volatility = this.state.params.volatility || 0.05;
    const elapsed = Date.now() - this.scenarioStartTime;
    const duration = this.scenarioDuration || 60000;
    const progress = Math.min(elapsed / duration, 1);
    
    // Sharp initial drop, then stabilize with high volatility
    let multiplier: number;
    if (progress < 0.1) {
      // First 10%: sharp drop
      const dropProgress = progress * 10;
      multiplier = 1 - magnitude * dropProgress;
    } else {
      // After drop: stabilize at reduced level with high vol
      multiplier = 1 - magnitude;
    }
    
    const blackSwanPrice = basePrice * multiplier * (1 + volatility * gaussianRandom());
    return blackSwanPrice * 1e6;
  }
  
  /**
   * Pyth-Volatile: Live price * amplified volatility (2-3x real moves)
   */
  private pythVolatile(): number {
    const basePrice = this.getPythBasePrice();
    const amplification = this.state.params.volatilityAmplification || 2.5;
    
    // Calculate change from last Pyth base price
    const lastBase = this.state.pythBasePrice || basePrice;
    const realChange = (basePrice - lastBase) / lastBase;
    
    // Amplify the change
    const amplifiedChange = realChange * amplification;
    
    // Add extra noise
    const volatility = this.state.params.volatility || 0.01;
    const noise = volatility * basePrice * gaussianRandom();
    
    const volatilePrice = basePrice * (1 + amplifiedChange) + noise;
    return volatilePrice * 1e6;
  }
  
  /**
   * Send price update to Solana via PushOraclePrice
   */
  private async sendPriceToChain(priceE6: number): Promise<void> {
    if (!this.connection || !this.state.slabAddress) return;
    
    const keypair = this.getOracleKeypair(this.state.slabAddress);
    if (!keypair) {
      console.error('Oracle keypair not available');
      return;
    }
    
    try {
      const sig = await pushOraclePrice(
        this.connection,
        keypair,
        this.state.slabAddress,
        priceE6
      );
      console.log(`Price updated: ${priceE6 / 1e6} USDC (${sig.slice(0, 8)}...)`);
    } catch (error) {
      console.error('Failed to push oracle price:', error);
    }
  }
  
  /**
   * Record price in database history
   */
  private async recordPriceHistory(priceE6: number): Promise<void> {
    if (!this.state.sessionId) return;
    
    try {
      const supabase = getServiceClient() as SimSupabase;
      await supabase.from('simulation_price_history').insert({
        session_id: this.state.sessionId,
        slab_address: this.state.slabAddress!,
        price_e6: priceE6,
        model: this.state.model,
      });
    } catch (error) {
      console.error('Failed to record price history:', error);
    }
  }
}
