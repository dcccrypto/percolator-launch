# Percolator Simulation Mode - Technical Design Document

**Version:** 1.0  
**Date:** February 14, 2026  
**Program ID:** `FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD` (Solana Devnet)

---

## 1. Executive Summary

### What is Simulation Mode?

Simulation Mode is a **permanent, live trading environment** on Solana devnet where users can experience Percolator's perpetual futures trading with zero financial risk. Unlike traditional paper trading systems that simulate trades off-chain, Simulation Mode executes **real on-chain transactions** on devnet, creating an authentic trading experience indistinguishable from mainnet operations.

### Why Build This?

**User Acquisition:**
- Zero-barrier entry: Users get devnet tokens instantly via faucet
- Learn perpetual futures mechanics without risking capital
- Build confidence before moving to mainnet

**Product Validation:**
- Stress-test infrastructure under realistic market conditions
- Identify UX friction points with real user behavior
- Gather data on feature usage and trading patterns

**Marketing & Virality:**
- Leaderboards create competition and social proof
- Hackathon demo showcases live, working product
- "Try before you buy" reduces conversion friction

### Competitive Advantage

| Feature | Percolator Simulation | Competitor Paper Trading |
|---------|----------------------|--------------------------|
| **Execution** | Real on-chain transactions | Database updates |
| **Market Depth** | Live bot fleet creates liquidity | Static orderbook |
| **Price Action** | Dynamic oracle with scenarios | Historical replay or random |
| **Funding Rates** | Real inventory-based calculation | Approximated or ignored |
| **Liquidations** | Actual on-chain liquidations | Simulated logic |
| **Transferability** | Same codebase as mainnet | Separate simulation engine |

**Key Differentiator:** When users graduate to mainnet, they're already familiar with the exact same interface, mechanics, and program behavior. No learning curve.

---

## 2. Architecture Overview

### System Components

```
┌─────────────────────────────────────────────────────────────────┐
│                         FRONTEND (Next.js 14)                    │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────────┐   │
│  │ /trade page  │  │ /simulate    │  │  /leaderboard       │   │
│  │ (mainnet)    │  │ (devnet)     │  │  (simulation PnL)   │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬──────────┘   │
└─────────┼──────────────────┼─────────────────────┼──────────────┘
          │                  │                     │
          │                  │                     │
┌─────────▼──────────────────▼─────────────────────▼──────────────┐
│              BACKEND API (Express on Railway)                    │
│  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────────┐│
│  │ PercolatorSDK   │  │ FaucetService    │  │ LeaderboardSvc  ││
│  │ (mainnet/devnet)│  │ (devnet only)    │  │ (Supabase read) ││
│  └─────────────────┘  └──────────────────┘  └─────────────────┘│
│                                                                  │
│  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────────┐│
│  │ OraclePriceEng  │  │ BotFleet         │  │ ScenarioManager ││
│  │ (price mover)   │  │ (5 bot types)    │  │ (orchestrator)  ││
│  └─────────────────┘  └──────────────────┘  └─────────────────┘│
└──────────────────────────────┬───────────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────┐
│                     SUPABASE (PostgreSQL)                         │
│  ┌──────────────┐  ┌─────────────┐  ┌──────────────────────────┐│
│  │ sim_wallets  │  │ sim_trades  │  │ sim_leaderboard_entries  ││
│  └──────────────┘  └─────────────┘  └──────────────────────────┘│
│  ┌──────────────┐  ┌─────────────┐  ┌──────────────────────────┐│
│  │ sim_scenarios│  │ sim_events  │  │ sim_faucet_claims        ││
│  └──────────────┘  └─────────────┘  └──────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────┐
│                    SOLANA DEVNET                                  │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ Percolator Program: FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                   │
│  Market Slab PDA (e.g., SOL-PERP)                                │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ idx 0: Admin Account (authorityPriceE6, insurance fund)     │ │
│  │ idx 1: LP Account #1 (liquidity provider)                   │ │
│  │ idx 2: Trader Account #1 (user or bot)                      │ │
│  │ idx 3: Trader Account #2                                    │ │
│  │ ...                                                          │ │
│  │ idx N: Trader Account #N                                    │ │
│  └─────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

### Component Interactions

1. **User Flow (Human Trader):**
   - User visits `/simulate` → connects wallet → clicks "Get Devnet Tokens"
   - Frontend calls `FaucetService.claimTokens(walletPubkey)`
   - Backend airdrops SOL + USDC, creates trader account in market slab
   - User trades via standard Percolator SDK (devnet mode)
   - Trades stored in `sim_trades` table for leaderboard calculation

2. **Bot Fleet Flow:**
   - `ScenarioManager` loads scenario (e.g., "Bull Run")
   - Spawns 5 bot types with scenario-specific parameters
   - Each bot runs independent trading loop:
     - Read current price from slab (`authorityPriceE6`)
     - Execute strategy (market maker posts limit orders, trend follower goes long, etc.)
     - Submit transactions to devnet
   - Bots create market depth and volatility

3. **Oracle Price Flow:**
   - `OraclePriceEngine` runs on interval (configurable: 1-60 seconds)
   - Reads current scenario phase (e.g., "Bull Run - Phase 2: Acceleration")
   - Calculates next price using model (trend + volatility)
   - Submits `setAuthorityPrice` transaction as admin
   - Price update triggers crank to check liquidations

4. **Crank Flow:**
   - Scheduled job (every 5-10 seconds) calls `crankMarket` instruction
   - Program calculates funding rate from net LP position
   - Applies funding payments to all open positions
   - Checks each position for liquidation threshold
   - Liquidated positions transfer collateral to insurance fund

---

## 3. Oracle Price Engine

### Purpose

The Oracle Price Engine is the "market god" — it sets `authorityPriceE6` to simulate realistic price action. Unlike mainnet (where price comes from Pyth/Chainlink), simulation mode gives us full control to create scenarios from calm markets to flash crashes.

### Price Movement Models

#### 3.1 Random Walk (Geometric Brownian Motion)
```typescript
interface RandomWalkConfig {
  drift: number;        // Annual drift (e.g., 0.1 = 10% upward bias)
  volatility: number;   // Annual volatility (e.g., 0.8 = 80%)
  dtSeconds: number;    // Time step in seconds
}

function randomWalk(currentPrice: number, config: RandomWalkConfig): number {
  const dt = config.dtSeconds / (365 * 24 * 60 * 60); // Convert to years
  const drift = config.drift * dt;
  const diffusion = config.volatility * Math.sqrt(dt) * randomNormal();
  
  return currentPrice * Math.exp(drift + diffusion);
}

function randomNormal(): number {
  // Box-Muller transform
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
```

**Use Case:** Calm market, sideways trading

#### 3.2 Mean-Reverting Model (Ornstein-Uhlenbeck)
```typescript
interface MeanRevertConfig {
  meanPrice: number;      // Long-term equilibrium price
  reversionSpeed: number; // How fast price returns to mean (0-1)
  volatility: number;
  dtSeconds: number;
}

function meanRevert(currentPrice: number, config: MeanRevertConfig): number {
  const dt = config.dtSeconds / (365 * 24 * 60 * 60);
  const reversion = config.reversionSpeed * (config.meanPrice - currentPrice) * dt;
  const diffusion = config.volatility * Math.sqrt(dt) * randomNormal();
  
  return currentPrice + reversion + diffusion * currentPrice;
}
```

**Use Case:** Range-bound market, funding squeeze scenarios

#### 3.3 Trend Model (Directional Momentum)
```typescript
interface TrendConfig {
  direction: 'up' | 'down';
  strength: number;       // 0-1, where 1 = strong trend
  volatility: number;
  dtSeconds: number;
}

function trendMove(currentPrice: number, config: TrendConfig): number {
  const dt = config.dtSeconds / (365 * 24 * 60 * 60);
  const trendDrift = (config.direction === 'up' ? 1 : -1) * config.strength * 2.0; // 200% annualized
  const drift = trendDrift * dt;
  const diffusion = config.volatility * Math.sqrt(dt) * randomNormal();
  
  return currentPrice * Math.exp(drift + diffusion);
}
```

**Use Case:** Bull run, bear market scenarios

#### 3.4 Flash Crash Model
```typescript
interface FlashCrashConfig {
  crashDepth: number;     // Percentage drop (e.g., 0.15 = 15% crash)
  crashDuration: number;  // Seconds from start to bottom
  recoveryDuration: number; // Seconds from bottom to recovery
}

function flashCrash(
  currentPrice: number,
  config: FlashCrashConfig,
  elapsedSeconds: number
): number {
  if (elapsedSeconds < config.crashDuration) {
    // Crash phase: exponential decay
    const progress = elapsedSeconds / config.crashDuration;
    const depthMultiplier = 1 - config.crashDepth * Math.pow(progress, 2);
    return currentPrice * depthMultiplier;
  } else if (elapsedSeconds < config.crashDuration + config.recoveryDuration) {
    // Recovery phase: exponential recovery
    const recoveryStart = currentPrice * (1 - config.crashDepth);
    const progress = (elapsedSeconds - config.crashDuration) / config.recoveryDuration;
    const recovered = config.crashDepth * Math.pow(progress, 1.5);
    return recoveryStart * (1 + recovered / (1 - config.crashDepth));
  } else {
    // Post-recovery: return to normal model
    return currentPrice;
  }
}
```

**Use Case:** Black swan, liquidation cascade simulation

### Update Frequency

| Scenario Type | Update Interval | Rationale |
|--------------|----------------|-----------|
| Calm Market | 30-60 seconds | Mimics low-volatility periods |
| Normal Trading | 10-15 seconds | Balanced realism vs. RPC load |
| High Volatility | 2-5 seconds | Fast-moving markets |
| Flash Crash | 1 second | Capture rapid price movement |

### Implementation

```typescript
// backend/src/services/OraclePriceEngine.ts

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { PercolatorSDK } from '../sdk/percolator';

interface PriceUpdate {
  timestamp: number;
  price: number;
  model: string;
  scenarioId?: string;
}

export class OraclePriceEngine {
  private sdk: PercolatorSDK;
  private adminKeypair: Keypair;
  private updateInterval: NodeJS.Timeout | null = null;
  private currentPrice: number;
  private priceHistory: PriceUpdate[] = [];
  
  constructor(
    connection: Connection,
    adminKeypair: Keypair,
    marketPubkey: PublicKey,
    initialPrice: number
  ) {
    this.sdk = new PercolatorSDK(connection, marketPubkey);
    this.adminKeypair = adminKeypair;
    this.currentPrice = initialPrice;
  }
  
  /**
   * Start price updates with a given model and interval
   */
  start(model: PriceModel, intervalMs: number) {
    if (this.updateInterval) {
      throw new Error('Price engine already running');
    }
    
    console.log(`[OraclePriceEngine] Starting with model: ${model.type}, interval: ${intervalMs}ms`);
    
    this.updateInterval = setInterval(async () => {
      try {
        await this.tick(model);
      } catch (error) {
        console.error('[OraclePriceEngine] Update failed:', error);
      }
    }, intervalMs);
  }
  
  /**
   * Execute one price update
   */
  private async tick(model: PriceModel) {
    // Calculate next price
    const nextPrice = this.calculateNextPrice(model);
    
    // Convert to E6 format (price * 1e6)
    const priceE6 = Math.round(nextPrice * 1_000_000);
    
    // Submit to chain
    const signature = await this.sdk.setAuthorityPrice(
      this.adminKeypair,
      priceE6
    );
    
    // Record update
    const update: PriceUpdate = {
      timestamp: Date.now(),
      price: nextPrice,
      model: model.type,
      scenarioId: model.scenarioId
    };
    
    this.priceHistory.push(update);
    this.currentPrice = nextPrice;
    
    console.log(`[OraclePriceEngine] Price updated to $${nextPrice.toFixed(2)} (${priceE6} E6) - Tx: ${signature}`);
    
    // Keep last 1000 updates in memory
    if (this.priceHistory.length > 1000) {
      this.priceHistory.shift();
    }
    
    // Persist to database for analytics
    await this.persistUpdate(update);
  }
  
  private calculateNextPrice(model: PriceModel): number {
    switch (model.type) {
      case 'random_walk':
        return randomWalk(this.currentPrice, model.config);
      case 'mean_revert':
        return meanRevert(this.currentPrice, model.config);
      case 'trend':
        return trendMove(this.currentPrice, model.config);
      case 'flash_crash':
        return flashCrash(this.currentPrice, model.config, model.elapsedSeconds);
      default:
        throw new Error(`Unknown model type: ${model.type}`);
    }
  }
  
  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      console.log('[OraclePriceEngine] Stopped');
    }
  }
  
  getCurrentPrice(): number {
    return this.currentPrice;
  }
  
  getPriceHistory(limit: number = 100): PriceUpdate[] {
    return this.priceHistory.slice(-limit);
  }
  
  private async persistUpdate(update: PriceUpdate) {
    // Store in Supabase for charting and analytics
    await supabase.from('sim_events').insert({
      event_type: 'price_update',
      timestamp: new Date(update.timestamp).toISOString(),
      data: {
        price: update.price,
        model: update.model,
        scenario_id: update.scenarioId
      }
    });
  }
}

type PriceModel = 
  | { type: 'random_walk'; config: RandomWalkConfig; scenarioId?: string }
  | { type: 'mean_revert'; config: MeanRevertConfig; scenarioId?: string }
  | { type: 'trend'; config: TrendConfig; scenarioId?: string }
  | { type: 'flash_crash'; config: FlashCrashConfig; elapsedSeconds: number; scenarioId?: string };
```

### Keypair Management

**Admin Keypair Storage:**
- Store in environment variable `SIM_ADMIN_PRIVATE_KEY` (base58 encoded)
- Load on backend startup:
  ```typescript
  const adminKeypair = Keypair.fromSecretKey(
    bs58.decode(process.env.SIM_ADMIN_PRIVATE_KEY!)
  );
  ```
- **Never expose in frontend or API responses**
- Rotate quarterly and fund with devnet SOL via faucet

**Security:**
- Admin keypair only signs `setAuthorityPrice` and admin instructions
- Rate limit: max 1 price update per second (prevent abuse if leaked)
- Monitor wallet balance — if drained, alert and halt

---

## 4. Bot Fleet

### Purpose

Bots create **market depth** and **trading activity** so users aren't trading in a vacuum. They provide:
- Liquidity (limit orders on both sides)
- Volatility (random market orders)
- Realistic slippage
- Funding rate pressure (directional position imbalance)

### Bot Types

#### 4.1 Market Maker Bot
**Strategy:** Post limit orders around current price to provide liquidity

```typescript
interface MarketMakerConfig {
  spreadBps: number;        // Spread in basis points (e.g., 10 = 0.1%)
  orderSize: number;        // Size in USD per order
  numLevels: number;        // How many price levels (1-5)
  refreshInterval: number;  // How often to cancel/replace orders (ms)
}

class MarketMakerBot {
  async run(config: MarketMakerConfig) {
    while (true) {
      const currentPrice = await this.sdk.getCurrentPrice();
      
      // Cancel all existing orders
      await this.cancelAllOrders();
      
      // Place buy and sell orders at each level
      for (let level = 1; level <= config.numLevels; level++) {
        const spreadMultiplier = level * (config.spreadBps / 10000);
        const buyPrice = currentPrice * (1 - spreadMultiplier);
        const sellPrice = currentPrice * (1 + spreadMultiplier);
        
        await this.placeOrder('buy', buyPrice, config.orderSize);
        await this.placeOrder('sell', sellPrice, config.orderSize);
      }
      
      await sleep(config.refreshInterval);
    }
  }
}
```

**Scenario Tuning:**
- Calm: tight spread (5 bps), many levels (5)
- Volatile: wide spread (50 bps), few levels (2)

#### 4.2 Trend Follower Bot
**Strategy:** Follow momentum — buy when price rising, sell when falling

```typescript
interface TrendFollowerConfig {
  lookbackPeriod: number;   // How many price updates to analyze
  momentumThreshold: number; // Min % change to trigger trade
  positionSize: number;     // USD size per trade
  maxLeverage: number;      // Max leverage multiplier
}

class TrendFollowerBot {
  private priceHistory: number[] = [];
  
  async run(config: TrendFollowerConfig) {
    while (true) {
      const currentPrice = await this.sdk.getCurrentPrice();
      this.priceHistory.push(currentPrice);
      
      if (this.priceHistory.length >= config.lookbackPeriod) {
        const momentum = this.calculateMomentum(config.lookbackPeriod);
        
        if (Math.abs(momentum) > config.momentumThreshold) {
          const direction = momentum > 0 ? 'long' : 'short';
          await this.adjustPosition(direction, config.positionSize, config.maxLeverage);
        }
      }
      
      await sleep(5000); // Check every 5 seconds
    }
  }
  
  private calculateMomentum(lookback: number): number {
    const recent = this.priceHistory.slice(-lookback);
    const startPrice = recent[0];
    const endPrice = recent[recent.length - 1];
    return (endPrice - startPrice) / startPrice;
  }
}
```

**Scenario Tuning:**
- Bull Run: lower threshold (0.5%), bias long
- Flash Crash: higher threshold (2%), quick exits

#### 4.3 Degen Bot
**Strategy:** Random chaotic trades — market orders, high leverage, YOLO

```typescript
interface DegenConfig {
  tradeFrequency: number;   // Avg seconds between trades
  minSize: number;          // Min trade size (USD)
  maxSize: number;          // Max trade size (USD)
  maxLeverage: number;      // Max leverage (can go to 100x)
  closeChance: number;      // Probability of closing position (0-1)
}

class DegenBot {
  async run(config: DegenConfig) {
    while (true) {
      const action = Math.random();
      
      if (action < config.closeChance && this.hasPosition()) {
        // Close existing position
        await this.closePosition();
      } else {
        // Open random position
        const direction = Math.random() > 0.5 ? 'long' : 'short';
        const size = randomBetween(config.minSize, config.maxSize);
        const leverage = randomBetween(1, config.maxLeverage);
        
        await this.openPosition(direction, size, leverage);
      }
      
      const waitTime = exponentialRandom(config.tradeFrequency);
      await sleep(waitTime);
    }
  }
}
```

**Scenario Tuning:**
- Calm: low frequency, low leverage
- Black Swan: high frequency, max leverage, many liquidations

#### 4.4 LP Provider Bot
**Strategy:** Provide liquidity to the pool, earn funding fees

```typescript
interface LPConfig {
  liquidityAmount: number;  // Total USD to provide
  rebalanceThreshold: number; // Net position % to trigger rebalance
}

class LPProviderBot {
  async run(config: LPConfig) {
    // Initial deposit to LP account (idx 1+ in slab)
    await this.depositLiquidity(config.liquidityAmount);
    
    while (true) {
      const netPosition = await this.getNetPosition();
      const liquidityTotal = await this.getTotalLiquidity();
      const netPercentage = Math.abs(netPosition / liquidityTotal);
      
      if (netPercentage > config.rebalanceThreshold) {
        // Hedge net position to reduce exposure
        await this.hedgePosition(netPosition);
      }
      
      await sleep(30000); // Check every 30 seconds
    }
  }
}
```

**Scenario Tuning:**
- All scenarios: constant liquidity provider
- Funding Squeeze: delay rebalancing to create large net position

#### 4.5 Arbitrageur Bot (Future Enhancement)
**Strategy:** Arbitrage between simulation price and external reference (e.g., Binance)

```typescript
interface ArbitrageConfig {
  referenceSource: 'binance' | 'coinbase';
  minSpread: number;        // Min % difference to trade
  positionSize: number;
}

// Simplified for simulation — in reality would need external exchange integration
class ArbitrageurBot {
  async run(config: ArbitrageConfig) {
    while (true) {
      const simPrice = await this.sdk.getCurrentPrice();
      const refPrice = await this.fetchReferencePrice(config.referenceSource);
      
      const spread = (simPrice - refPrice) / refPrice;
      
      if (Math.abs(spread) > config.minSpread) {
        const direction = spread > 0 ? 'short' : 'long'; // Sell high, buy low
        await this.openPosition(direction, config.positionSize, 1);
      }
      
      await sleep(10000);
    }
  }
}
```

### Wallet Management

**Wallet Pool:**
- Pre-generate 50 bot wallets on backend startup
- Store in database `sim_wallets` table
- Each bot gets exclusive access to 1-2 wallets (some bots need multiple accounts)

```typescript
// backend/src/services/BotWalletManager.ts

export class BotWalletManager {
  private wallets: Map<string, Keypair> = new Map();
  
  async initialize(count: number = 50) {
    console.log(`[BotWalletManager] Generating ${count} wallets...`);
    
    for (let i = 0; i < count; i++) {
      const keypair = Keypair.generate();
      const walletId = `bot_${i.toString().padStart(3, '0')}`;
      
      this.wallets.set(walletId, keypair);
      
      // Fund with devnet SOL
      await this.airdropSol(keypair.publicKey);
      
      // Store in database
      await supabase.from('sim_wallets').insert({
        wallet_id: walletId,
        pubkey: keypair.publicKey.toBase58(),
        private_key: bs58.encode(keypair.secretKey), // Encrypted in production
        bot_type: null,
        is_assigned: false
      });
    }
    
    console.log(`[BotWalletManager] Wallets ready`);
  }
  
  async assignWallet(botType: string): Promise<Keypair> {
    const { data, error } = await supabase
      .from('sim_wallets')
      .select('*')
      .eq('is_assigned', false)
      .limit(1)
      .single();
    
    if (error || !data) {
      throw new Error('No available wallets');
    }
    
    await supabase
      .from('sim_wallets')
      .update({ bot_type: botType, is_assigned: true })
      .eq('wallet_id', data.wallet_id);
    
    return Keypair.fromSecretKey(bs58.decode(data.private_key));
  }
  
  releaseWallet(walletId: string) {
    // Mark wallet as unassigned for reuse
  }
}
```

### Position Sizing

| Bot Type | Typical Size | Max Leverage | Risk Tolerance |
|----------|--------------|--------------|----------------|
| Market Maker | $100-500 per order | 1x (no leverage) | Low |
| Trend Follower | $1,000-5,000 | 5x | Medium |
| Degen | $100-10,000 | 20x | Extreme |
| LP Provider | $50,000+ | N/A (providing liquidity) | Low |
| Arbitrageur | $2,000-10,000 | 2x | Low |

### Concurrency & Orchestration

```typescript
// backend/src/services/BotFleet.ts

export class BotFleet {
  private bots: Bot[] = [];
  private isRunning = false;
  
  async start(scenario: Scenario) {
    this.isRunning = true;
    
    // Spawn bots based on scenario config
    const configs = scenario.botConfigs;
    
    // Market makers (2-3 bots for depth)
    for (let i = 0; i < configs.marketMakerCount; i++) {
      const wallet = await walletManager.assignWallet('market_maker');
      const bot = new MarketMakerBot(wallet, configs.marketMaker);
      this.bots.push(bot);
      bot.start(); // Non-blocking
    }
    
    // Trend followers (3-5 bots)
    for (let i = 0; i < configs.trendFollowerCount; i++) {
      const wallet = await walletManager.assignWallet('trend_follower');
      const bot = new TrendFollowerBot(wallet, configs.trendFollower);
      this.bots.push(bot);
      bot.start();
    }
    
    // Degens (5-10 bots for chaos)
    for (let i = 0; i < configs.degenCount; i++) {
      const wallet = await walletManager.assignWallet('degen');
      const bot = new DegenBot(wallet, configs.degen);
      this.bots.push(bot);
      bot.start();
    }
    
    // LP provider (1 bot with large capital)
    const lpWallet = await walletManager.assignWallet('lp_provider');
    const lpBot = new LPProviderBot(lpWallet, configs.lpProvider);
    this.bots.push(lpBot);
    lpBot.start();
    
    console.log(`[BotFleet] Started ${this.bots.length} bots`);
  }
  
  async stop() {
    this.isRunning = false;
    
    // Gracefully stop all bots
    await Promise.all(this.bots.map(bot => bot.stop()));
    
    // Close all positions
    await Promise.all(this.bots.map(bot => bot.closeAllPositions()));
    
    this.bots = [];
    console.log('[BotFleet] All bots stopped');
  }
  
  getStats() {
    return {
      totalBots: this.bots.length,
      activePositions: this.bots.reduce((sum, bot) => sum + bot.getPositionCount(), 0),
      totalVolume24h: this.bots.reduce((sum, bot) => sum + bot.getVolume24h(), 0)
    };
  }
}
```

**Concurrency Strategy:**
- Each bot runs in separate async loop (non-blocking)
- Rate limiting: max 10 transactions per second per bot (avoid RPC throttling)
- Transaction retry logic with exponential backoff
- Circuit breaker: halt bot if 5 consecutive failures

---

## 5. Scenario Engine

### Purpose

Scenarios are **pre-configured market conditions** that combine price models, bot behaviors, and event triggers. They allow users to experience specific trading situations without waiting for them to occur naturally.

### Predefined Scenarios

#### 5.1 Calm Market
**Description:** Low volatility, tight spreads, minimal liquidations

**Configuration:**
```typescript
const calmMarketScenario: Scenario = {
  id: 'calm_market',
  name: 'Calm Market',
  description: 'Low volatility sideways trading — ideal for beginners',
  duration: 30 * 60 * 1000, // 30 minutes
  
  priceModel: {
    type: 'random_walk',
    config: {
      drift: 0.0,
      volatility: 0.2, // 20% annualized
      dtSeconds: 30
    },
    updateInterval: 30000 // 30 seconds
  },
  
  botConfigs: {
    marketMakerCount: 3,
    marketMaker: { spreadBps: 5, orderSize: 500, numLevels: 5, refreshInterval: 60000 },
    
    trendFollowerCount: 2,
    trendFollower: { lookbackPeriod: 10, momentumThreshold: 0.02, positionSize: 1000, maxLeverage: 2 },
    
    degenCount: 3,
    degen: { tradeFrequency: 120, minSize: 100, maxSize: 500, maxLeverage: 5, closeChance: 0.3 },
    
    lpProvider: { liquidityAmount: 100000, rebalanceThreshold: 0.1 }
  },
  
  events: [] // No special events
};
```

#### 5.2 Bull Run
**Description:** Strong upward trend, FOMO trading, funding rate goes negative

**Configuration:**
```typescript
const bullRunScenario: Scenario = {
  id: 'bull_run',
  name: 'Bull Run',
  description: 'Strong uptrend — catch the wave or get liquidated shorting',
  duration: 60 * 60 * 1000, // 1 hour
  
  phases: [
    {
      name: 'Accumulation',
      duration: 15 * 60 * 1000,
      priceModel: {
        type: 'random_walk',
        config: { drift: 0.1, volatility: 0.3, dtSeconds: 15 }
      }
    },
    {
      name: 'Acceleration',
      duration: 30 * 60 * 1000,
      priceModel: {
        type: 'trend',
        config: { direction: 'up', strength: 0.8, volatility: 0.5, dtSeconds: 10 }
      }
    },
    {
      name: 'Blow-off Top',
      duration: 15 * 60 * 1000,
      priceModel: {
        type: 'trend',
        config: { direction: 'up', strength: 1.0, volatility: 1.0, dtSeconds: 5 }
      }
    }
  ],
  
  botConfigs: {
    marketMakerCount: 2,
    marketMaker: { spreadBps: 20, orderSize: 1000, numLevels: 3, refreshInterval: 30000 },
    
    trendFollowerCount: 5,
    trendFollower: { lookbackPeriod: 5, momentumThreshold: 0.01, positionSize: 5000, maxLeverage: 10 },
    
    degenCount: 8,
    degen: { tradeFrequency: 30, minSize: 500, maxSize: 5000, maxLeverage: 20, closeChance: 0.1 },
    
    lpProvider: { liquidityAmount: 200000, rebalanceThreshold: 0.2 }
  },
  
  events: [
    { time: 20 * 60 * 1000, type: 'news', message: '📰 Breaking: Major exchange lists SOL-PERP' },
    { time: 45 * 60 * 1000, type: 'whale_long', size: 100000 }
  ]
};
```

#### 5.3 Flash Crash
**Description:** Sudden 20% drop in 30 seconds, liquidation cascade, recovery

**Configuration:**
```typescript
const flashCrashScenario: Scenario = {
  id: 'flash_crash',
  name: 'Flash Crash',
  description: '20% crash in 30 seconds — manage risk or get rekt',
  duration: 10 * 60 * 1000, // 10 minutes total
  
  priceModel: {
    type: 'flash_crash',
    config: {
      crashDepth: 0.20,
      crashDuration: 30,
      recoveryDuration: 120
    },
    updateInterval: 1000 // 1 second for rapid movement
  },
  
  botConfigs: {
    marketMakerCount: 1, // MMs pull liquidity during crash
    marketMaker: { spreadBps: 100, orderSize: 200, numLevels: 1, refreshInterval: 5000 },
    
    trendFollowerCount: 3,
    trendFollower: { lookbackPeriod: 3, momentumThreshold: 0.05, positionSize: 2000, maxLeverage: 3 },
    
    degenCount: 15, // Max chaos
    degen: { tradeFrequency: 5, minSize: 100, maxSize: 10000, maxLeverage: 50, closeChance: 0.5 },
    
    lpProvider: { liquidityAmount: 150000, rebalanceThreshold: 0.3 }
  },
  
  events: [
    { time: 0, type: 'news', message: '🚨 ALERT: Large liquidation cascade incoming' },
    { time: 30000, type: 'news', message: '📉 Crash bottomed — recovery beginning' }
  ]
};
```

#### 5.4 Funding Squeeze
**Description:** Net position heavily skewed, funding rate spikes

**Configuration:**
```typescript
const fundingSqueezeScenario: Scenario = {
  id: 'funding_squeeze',
  name: 'Funding Rate Squeeze',
  description: 'Extreme funding rate — test your cost of carry',
  duration: 45 * 60 * 1000,
  
  priceModel: {
    type: 'mean_revert',
    config: {
      meanPrice: 50000, // SOL at $50k (example)
      reversionSpeed: 0.3,
      volatility: 0.4,
      dtSeconds: 20
    },
    updateInterval: 20000
  },
  
  botConfigs: {
    marketMakerCount: 2,
    marketMaker: { spreadBps: 15, orderSize: 500, numLevels: 4, refreshInterval: 45000 },
    
    trendFollowerCount: 8, // All biased long to create net position
    trendFollower: { 
      lookbackPeriod: 8, 
      momentumThreshold: 0.005, 
      positionSize: 10000, 
      maxLeverage: 5,
      bias: 'long' // Force long positions
    },
    
    degenCount: 5,
    degen: { tradeFrequency: 60, minSize: 1000, maxSize: 5000, maxLeverage: 10, closeChance: 0.2 },
    
    lpProvider: { 
      liquidityAmount: 100000, 
      rebalanceThreshold: 0.5, // Delay hedging to amplify net position
      hedgingDelay: 300000 // 5 minutes
    }
  },
  
  events: [
    { time: 10 * 60 * 1000, type: 'funding_update', rate: 0.05 }, // 5% funding per 8h
    { time: 30 * 60 * 1000, type: 'news', message: '📊 Funding rate at 15% APR — shorts paying longs' }
  ]
};
```

#### 5.5 Whale Entry
**Description:** Large player enters market, creates volatility and alpha

**Configuration:**
```typescript
const whaleEntryScenario: Scenario = {
  id: 'whale_entry',
  name: 'Whale Entry',
  description: 'Big money enters — can you front-run or follow?',
  duration: 20 * 60 * 1000,
  
  priceModel: {
    type: 'random_walk',
    config: { drift: 0.05, volatility: 0.6, dtSeconds: 10 },
    updateInterval: 10000
  },
  
  botConfigs: {
    marketMakerCount: 3,
    marketMaker: { spreadBps: 10, orderSize: 800, numLevels: 4, refreshInterval: 40000 },
    
    trendFollowerCount: 4,
    trendFollower: { lookbackPeriod: 6, momentumThreshold: 0.015, positionSize: 3000, maxLeverage: 5 },
    
    degenCount: 6,
    degen: { tradeFrequency: 45, minSize: 200, maxSize: 3000, maxLeverage: 15, closeChance: 0.25 },
    
    lpProvider: { liquidityAmount: 120000, rebalanceThreshold: 0.15 },
    
    // Special whale bot
    whale: {
      entryTime: 5 * 60 * 1000, // Enters at 5 minutes
      size: 500000, // $500k position
      entryDuration: 2 * 60 * 1000, // Accumulates over 2 minutes
      leverage: 3,
      direction: 'long'
    }
  },
  
  events: [
    { time: 5 * 60 * 1000, type: 'whale_alert', message: '🐋 Whale wallet detected — large position opening' },
    { time: 7 * 60 * 1000, type: 'news', message: '📈 Volume spike — whale accumulation in progress' }
  ]
};
```

#### 5.6 Black Swan
**Description:** Extreme volatility, circuit breakers, multiple liquidation cascades

**Configuration:**
```typescript
const blackSwanScenario: Scenario = {
  id: 'black_swan',
  name: 'Black Swan Event',
  description: 'Chaos — 50% crash, recovery, then crash again',
  duration: 30 * 60 * 1000,
  
  phases: [
    {
      name: 'Initial Crash',
      duration: 2 * 60 * 1000,
      priceModel: {
        type: 'flash_crash',
        config: { crashDepth: 0.50, crashDuration: 60, recoveryDuration: 60 }
      }
    },
    {
      name: 'Dead Cat Bounce',
      duration: 8 * 60 * 1000,
      priceModel: {
        type: 'trend',
        config: { direction: 'up', strength: 0.6, volatility: 1.5, dtSeconds: 5 }
      }
    },
    {
      name: 'Second Leg Down',
      duration: 5 * 60 * 1000,
      priceModel: {
        type: 'trend',
        config: { direction: 'down', strength: 0.8, volatility: 2.0, dtSeconds: 3 }
      }
    },
    {
      name: 'Stabilization',
      duration: 15 * 60 * 1000,
      priceModel: {
        type: 'mean_revert',
        config: { meanPrice: 30000, reversionSpeed: 0.5, volatility: 0.8, dtSeconds: 10 }
      }
    }
  ],
  
  botConfigs: {
    marketMakerCount: 1, // Most MMs offline
    marketMaker: { spreadBps: 200, orderSize: 100, numLevels: 1, refreshInterval: 10000 },
    
    trendFollowerCount: 2,
    trendFollower: { lookbackPeriod: 2, momentumThreshold: 0.1, positionSize: 1000, maxLeverage: 2 },
    
    degenCount: 20, // Maximum chaos
    degen: { tradeFrequency: 2, minSize: 50, maxSize: 20000, maxLeverage: 100, closeChance: 0.7 },
    
    lpProvider: { liquidityAmount: 80000, rebalanceThreshold: 0.5 }
  },
  
  events: [
    { time: 0, type: 'news', message: '🚨 BLACK SWAN: Critical vulnerability discovered' },
    { time: 2 * 60 * 1000, type: 'circuit_breaker', message: '⏸️ Trading halted — insurance fund depleted' },
    { time: 10 * 60 * 1000, type: 'news', message: '📰 False alarm — vulnerability patched' },
    { time: 15 * 60 * 1000, type: 'news', message: '📉 Contagion spreading — second crash imminent' }
  ]
};
```

### Custom Scenario Builder

**Frontend UI Component:**
```typescript
// frontend/src/components/ScenarioBuilder.tsx

interface CustomScenarioParams {
  duration: number;
  initialPrice: number;
  priceModel: 'calm' | 'trend_up' | 'trend_down' | 'volatile' | 'crash';
  botIntensity: 'low' | 'medium' | 'high' | 'extreme';
  volatilityMultiplier: number; // 0.5 - 3.0
  leverage: 'conservative' | 'moderate' | 'aggressive';
}

export function ScenarioBuilder() {
  const [params, setParams] = useState<CustomScenarioParams>({
    duration: 30,
    initialPrice: 50,
    priceModel: 'calm',
    botIntensity: 'medium',
    volatilityMultiplier: 1.0,
    leverage: 'moderate'
  });
  
  const handleLaunch = async () => {
    const response = await fetch('/api/simulation/scenario/custom', {
      method: 'POST',
      body: JSON.stringify(params)
    });
    
    const { scenarioId } = await response.json();
    router.push(`/simulate?scenario=${scenarioId}`);
  };
  
  return (
    <div className="scenario-builder">
      <h2>Build Custom Scenario</h2>
      
      <div className="param-group">
        <label>Duration (minutes)</label>
        <Slider min={5} max={120} value={params.duration} onChange={v => setParams({...params, duration: v})} />
      </div>
      
      <div className="param-group">
        <label>Price Action</label>
        <Select value={params.priceModel} onChange={v => setParams({...params, priceModel: v})}>
          <option value="calm">Calm (sideways)</option>
          <option value="trend_up">Bull Trend</option>
          <option value="trend_down">Bear Trend</option>
          <option value="volatile">High Volatility</option>
          <option value="crash">Flash Crash</option>
        </Select>
      </div>
      
      <div className="param-group">
        <label>Bot Activity</label>
        <ButtonGroup>
          <Button active={params.botIntensity === 'low'} onClick={() => setParams({...params, botIntensity: 'low'})}>Low</Button>
          <Button active={params.botIntensity === 'medium'} onClick={() => setParams({...params, botIntensity: 'medium'})}>Medium</Button>
          <Button active={params.botIntensity === 'high'} onClick={() => setParams({...params, botIntensity: 'high'})}>High</Button>
          <Button active={params.botIntensity === 'extreme'} onClick={() => setParams({...params, botIntensity: 'extreme'})}>Extreme</Button>
        </ButtonGroup>
      </div>
      
      <button onClick={handleLaunch}>Launch Scenario</button>
    </div>
  );
}
```

### Timing & Phases

**Phase Transitions:**
```typescript
export class ScenarioManager {
  private currentPhaseIndex = 0;
  private phaseStartTime = Date.now();
  
  async runScenario(scenario: Scenario) {
    console.log(`[ScenarioManager] Starting scenario: ${scenario.name}`);
    
    // If scenario has phases, iterate through them
    if (scenario.phases) {
      for (let i = 0; i < scenario.phases.length; i++) {
        this.currentPhaseIndex = i;
        this.phaseStartTime = Date.now();
        const phase = scenario.phases[i];
        
        console.log(`[ScenarioManager] Phase ${i + 1}: ${phase.name}`);
        
        // Update oracle price model
        await this.oracleEngine.updateModel(phase.priceModel);
        
        // Wait for phase duration
        await sleep(phase.duration);
      }
    } else {
      // Single-phase scenario
      await this.oracleEngine.updateModel(scenario.priceModel);
      await sleep(scenario.duration);
    }
    
    console.log(`[ScenarioManager] Scenario complete`);
    await this.cleanup();
  }
  
  getCurrentPhase() {
    return this.scenario.phases?.[this.currentPhaseIndex] || null;
  }
  
  getProgress(): number {
    const elapsed = Date.now() - this.phaseStartTime;
    const phase = this.getCurrentPhase();
    return phase ? Math.min(elapsed / phase.duration, 1.0) : 1.0;
  }
}
```

---

## 6. Faucet System

### Purpose

Provide **instant devnet tokens** to users so they can start trading immediately. No wallet setup, no devnet SOL hunting — one click and you're trading.

### Token Airdrop Flow

```typescript
// backend/src/services/FaucetService.ts

export class FaucetService {
  private faucetKeypair: Keypair;
  private rateLimiter: Map<string, number> = new Map();
  
  constructor(faucetKeypair: Keypair) {
    this.faucetKeypair = faucetKeypair;
  }
  
  /**
   * Airdrop devnet tokens to user wallet
   */
  async claimTokens(userPubkey: PublicKey): Promise<ClaimResult> {
    const userKey = userPubkey.toBase58();
    
    // Check rate limit
    if (this.isRateLimited(userKey)) {
      throw new Error('Rate limit exceeded — try again in 1 hour');
    }
    
    try {
      // 1. Airdrop SOL for transaction fees (if balance < 0.1 SOL)
      const solBalance = await connection.getBalance(userPubkey);
      if (solBalance < 0.1 * LAMPORTS_PER_SOL) {
        await this.airdropSol(userPubkey, 0.5); // 0.5 SOL
      }
      
      // 2. Send USDC for trading (e.g., 10,000 USDC)
      const usdcAmount = 10_000 * 1e6; // 10k USDC (6 decimals)
      const usdcMint = new PublicKey(process.env.DEVNET_USDC_MINT!);
      
      const signature = await this.transferSPLToken(
        this.faucetKeypair,
        usdcMint,
        userPubkey,
        usdcAmount
      );
      
      // 3. Auto-create trader account in market slab (if not exists)
      await this.ensureTraderAccount(userPubkey);
      
      // 4. Record claim in database
      await supabase.from('sim_faucet_claims').insert({
        user_pubkey: userKey,
        amount_usdc: 10000,
        amount_sol: 0.5,
        timestamp: new Date().toISOString(),
        tx_signature: signature
      });
      
      // 5. Update rate limit
      this.rateLimiter.set(userKey, Date.now());
      
      return {
        success: true,
        amountUSDC: 10000,
        amountSOL: 0.5,
        signature
      };
    } catch (error) {
      console.error('[FaucetService] Claim failed:', error);
      throw error;
    }
  }
  
  private isRateLimited(userKey: string): boolean {
    const lastClaim = this.rateLimiter.get(userKey);
    if (!lastClaim) return false;
    
    const ONE_HOUR = 60 * 60 * 1000;
    return Date.now() - lastClaim < ONE_HOUR;
  }
  
  private async airdropSol(pubkey: PublicKey, amount: number) {
    // Request airdrop from devnet faucet
    const signature = await connection.requestAirdrop(
      pubkey,
      amount * LAMPORTS_PER_SOL
    );
    
    await connection.confirmTransaction(signature);
  }
  
  private async transferSPLToken(
    from: Keypair,
    mint: PublicKey,
    to: PublicKey,
    amount: number
  ): Promise<string> {
    const fromATA = await getAssociatedTokenAddress(mint, from.publicKey);
    const toATA = await getAssociatedTokenAddress(mint, to);
    
    // Create destination ATA if doesn't exist
    const toAccount = await connection.getAccountInfo(toATA);
    if (!toAccount) {
      const createIx = createAssociatedTokenAccountInstruction(
        from.publicKey,
        toATA,
        to,
        mint
      );
      
      const tx = new Transaction().add(createIx);
      await sendAndConfirmTransaction(connection, tx, [from]);
    }
    
    // Transfer tokens
    const transferIx = createTransferInstruction(
      fromATA,
      toATA,
      from.publicKey,
      amount
    );
    
    const tx = new Transaction().add(transferIx);
    return await sendAndConfirmTransaction(connection, tx, [from]);
  }
  
  private async ensureTraderAccount(userPubkey: PublicKey) {
    const sdk = new PercolatorSDK(connection, marketPubkey);
    
    // Check if user has trader account in slab
    const hasAccount = await sdk.hasTraderAccount(userPubkey);
    
    if (!hasAccount) {
      // Create trader account (idx 2+)
      await sdk.createTraderAccount(userPubkey);
      console.log(`[FaucetService] Created trader account for ${userPubkey.toBase58()}`);
    }
  }
}
```

### Rate Limiting

| Limit Type | Threshold | Window | Action |
|-----------|-----------|--------|--------|
| Per Wallet | 1 claim | 1 hour | Reject with error message |
| Per IP | 5 claims | 1 hour | Show CAPTCHA |
| Global | 1000 claims | 1 hour | Alert admin (potential abuse) |

**Implementation:**
```typescript
// Use Redis for distributed rate limiting
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

async function checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const current = await redis.incr(key);
  
  if (current === 1) {
    await redis.expire(key, windowSeconds);
  }
  
  return current <= limit;
}

// Usage in API endpoint
app.post('/api/faucet/claim', async (req, res) => {
  const { walletPubkey } = req.body;
  const ip = req.ip;
  
  // Check wallet limit
  const walletAllowed = await checkRateLimit(`faucet:wallet:${walletPubkey}`, 1, 3600);
  if (!walletAllowed) {
    return res.status(429).json({ error: 'Rate limit exceeded — try again in 1 hour' });
  }
  
  // Check IP limit
  const ipAllowed = await checkRateLimit(`faucet:ip:${ip}`, 5, 3600);
  if (!ipAllowed) {
    return res.status(429).json({ error: 'Too many claims from this IP — complete CAPTCHA' });
  }
  
  // Proceed with claim...
});
```

### Auto-Create Accounts

**Trader Account Creation:**
- When user claims tokens, automatically create their trader account in market slab
- Uses program instruction `InitializeTraderAccount`
- Funded by faucet keypair (pays account rent)

```rust
// Pseudo-code for on-chain instruction (Rust)
pub fn initialize_trader_account(ctx: Context<InitTraderAccount>) -> Result<()> {
    let trader_account = &mut ctx.accounts.trader_account;
    trader_account.owner = ctx.accounts.user.key();
    trader_account.collateral = 0;
    trader_account.position_size = 0;
    trader_account.entry_price = 0;
    trader_account.liquidation_price = 0;
    
    Ok(())
}
```

**Frontend Integration:**
```typescript
// frontend/src/components/FaucetButton.tsx

export function FaucetButton() {
  const wallet = useWallet();
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);
  
  const handleClaim = async () => {
    if (!wallet.publicKey) {
      toast.error('Connect wallet first');
      return;
    }
    
    setClaiming(true);
    
    try {
      const response = await fetch('/api/faucet/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletPubkey: wallet.publicKey.toBase58() })
      });
      
      if (!response.ok) {
        const { error } = await response.json();
        throw new Error(error);
      }
      
      const result = await response.json();
      
      toast.success(`Claimed ${result.amountUSDC} USDC + ${result.amountSOL} SOL!`);
      setClaimed(true);
      
      // Redirect to trading page
      setTimeout(() => router.push('/simulate'), 2000);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setClaiming(false);
    }
  };
  
  return (
    <button 
      onClick={handleClaim} 
      disabled={claiming || claimed}
      className="faucet-btn"
    >
      {claiming ? 'Claiming...' : claimed ? 'Claimed ✓' : 'Get Free Tokens'}
    </button>
  );
}
```

---

## 7. Frontend `/simulate` Page

### UI Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  PERCOLATOR SIMULATION MODE                    [Get Tokens] [?] │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────┐  ┌────────────────────────────────┐ │
│  │  SCENARIO PICKER       │  │  LIVE MARKET DATA              │ │
│  │                        │  │                                │ │
│  │  ○ Calm Market         │  │  SOL-PERP                      │ │
│  │  ● Bull Run            │  │  Price: $52,341.23   ▲ 2.3%   │ │
│  │  ○ Flash Crash         │  │  24h Vol: $2.4M               │ │
│  │  ○ Funding Squeeze     │  │  Funding: -0.05% (8h)         │ │
│  │  ○ Whale Entry         │  │  Open Interest: $12.3M        │ │
│  │  ○ Black Swan          │  │                                │ │
│  │  ○ Custom...           │  │  [Price Chart - Last 1h]      │ │
│  │                        │  │  ┌──────────────────────────┐ │ │
│  │  Time Remaining:       │  │  │         ╱╲    ╱╲          │ │ │
│  │  ⏱️ 38:24              │  │  │    ╱╲  ╱  ╲  ╱  ╲╱╲       │ │ │
│  │                        │  │  │───╱──╲╱────╲╱────────────│ │ │
│  │  Phase 2/3:            │  │  └──────────────────────────┘ │ │
│  │  "Acceleration"        │  │                                │ │
│  │  [████████░░░░] 67%    │  │                                │ │
│  │                        │  │                                │ │
│  │  [Stop Scenario]       │  └────────────────────────────────┘ │
│  └────────────────────────┘                                     │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │  TRADING INTERFACE (identical to mainnet /trade page)       ││
│  │                                                              ││
│  │  [Buy] [Sell]  Size: ____ USDC   Leverage: [5x ▼]          ││
│  │                                                              ││
│  │  Current Position:                                           ││
│  │  • Long 2.5 SOL @ $51,200 (5x leverage)                     ││
│  │  • Unrealized PnL: +$285.75 (+5.6%)                         ││
│  │  • Liquidation Price: $46,080                               ││
│  │                                                              ││
│  │  [Close Position]  [Add Collateral]                         ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌────────────────────────┐  ┌────────────────────────────────┐ │
│  │  BOT ACTIVITY          │  │  YOUR STATS                    │ │
│  │                        │  │                                │ │
│  │  🤖 15 active bots     │  │  Total PnL: +$1,247.32        │ │
│  │  📊 $124k volume (1h)  │  │  Win Rate: 62%                │ │
│  │  🔥 8 liquidations     │  │  Trades: 23                   │ │
│  │                        │  │  Rank: #42 / 218              │ │
│  │  Top Trader:           │  │                                │ │
│  │  degen_007             │  │  [View Leaderboard]           │ │
│  │  +$8,234 (12h)         │  │                                │ │
│  └────────────────────────┘  └────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### Scenario Picker Component

```typescript
// frontend/src/components/ScenarioPicker.tsx

import { useState, useEffect } from 'react';

interface ScenarioOption {
  id: string;
  name: string;
  description: string;
  difficulty: 'Beginner' | 'Intermediate' | 'Advanced' | 'Expert';
  duration: number; // minutes
}

const SCENARIOS: ScenarioOption[] = [
  {
    id: 'calm_market',
    name: 'Calm Market',
    description: 'Low volatility sideways trading — ideal for beginners',
    difficulty: 'Beginner',
    duration: 30
  },
  {
    id: 'bull_run',
    name: 'Bull Run',
    description: 'Strong uptrend — catch the wave or get liquidated shorting',
    difficulty: 'Intermediate',
    duration: 60
  },
  {
    id: 'flash_crash',
    name: 'Flash Crash',
    description: '20% crash in 30 seconds — manage risk or get rekt',
    difficulty: 'Advanced',
    duration: 10
  },
  {
    id: 'funding_squeeze',
    name: 'Funding Rate Squeeze',
    description: 'Extreme funding rate — test your cost of carry',
    difficulty: 'Advanced',
    duration: 45
  },
  {
    id: 'whale_entry',
    name: 'Whale Entry',
    description: 'Big money enters — can you front-run or follow?',
    difficulty: 'Intermediate',
    duration: 20
  },
  {
    id: 'black_swan',
    name: 'Black Swan Event',
    description: 'Chaos — 50% crash, recovery, then crash again',
    difficulty: 'Expert',
    duration: 30
  }
];

export function ScenarioPicker() {
  const [selected, setSelected] = useState<string>('calm_market');
  const [isRunning, setIsRunning] = useState(false);
  
  const handleStart = async () => {
    const response = await fetch('/api/simulation/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenarioId: selected })
    });
    
    if (response.ok) {
      setIsRunning(true);
      toast.success('Scenario started!');
    }
  };
  
  return (
    <div className="scenario-picker">
      <h3>Choose Your Scenario</h3>
      
      {SCENARIOS.map(scenario => (
        <div 
          key={scenario.id}
          className={`scenario-card ${selected === scenario.id ? 'selected' : ''}`}
          onClick={() => setSelected(scenario.id)}
        >
          <div className="scenario-header">
            <h4>{scenario.name}</h4>
            <span className={`difficulty ${scenario.difficulty.toLowerCase()}`}>
              {scenario.difficulty}
            </span>
          </div>
          <p>{scenario.description}</p>
          <div className="scenario-meta">
            <span>⏱️ {scenario.duration} min</span>
          </div>
        </div>
      ))}
      
      <button 
        onClick={handleStart} 
        disabled={isRunning}
        className="start-btn"
      >
        {isRunning ? 'Running...' : 'Start Scenario'}
      </button>
    </div>
  );
}
```

### Live Dashboard

**Real-time updates via WebSocket:**
```typescript
// frontend/src/hooks/useSimulationData.ts

export function useSimulationData() {
  const [data, setData] = useState({
    price: 0,
    priceChange24h: 0,
    volume24h: 0,
    fundingRate: 0,
    openInterest: 0,
    activeBots: 0,
    liquidationCount: 0
  });
  
  useEffect(() => {
    const ws = new WebSocket('wss://api.percolator.trade/simulation/live');
    
    ws.onmessage = (event) => {
      const update = JSON.parse(event.data);
      setData(prev => ({ ...prev, ...update }));
    };
    
    return () => ws.close();
  }, []);
  
  return data;
}

// Usage in component
export function LiveDashboard() {
  const data = useSimulationData();
  
  return (
    <div className="live-dashboard">
      <div className="stat-card">
        <label>Price</label>
        <div className="value">
          ${data.price.toLocaleString()}
          <span className={data.priceChange24h >= 0 ? 'positive' : 'negative'}>
            {data.priceChange24h >= 0 ? '▲' : '▼'} {Math.abs(data.priceChange24h).toFixed(2)}%
          </span>
        </div>
      </div>
      
      <div className="stat-card">
        <label>24h Volume</label>
        <div className="value">${(data.volume24h / 1e6).toFixed(1)}M</div>
      </div>
      
      <div className="stat-card">
        <label>Funding Rate (8h)</label>
        <div className="value">{(data.fundingRate * 100).toFixed(3)}%</div>
      </div>
      
      <div className="stat-card">
        <label>Bot Activity</label>
        <div className="value">
          🤖 {data.activeBots} bots
          <br />
          🔥 {data.liquidationCount} liquidations
        </div>
      </div>
    </div>
  );
}
```

### Controls

**Scenario Controls:**
- **Pause/Resume:** Temporarily halt price updates and bot trading
- **Stop:** End scenario early, close all positions
- **Speed:** 1x, 2x, 5x time acceleration (compress scenario duration)

```typescript
export function ScenarioControls() {
  const [isPaused, setIsPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  
  const handlePause = async () => {
    await fetch('/api/simulation/pause', { method: 'POST' });
    setIsPaused(true);
  };
  
  const handleResume = async () => {
    await fetch('/api/simulation/resume', { method: 'POST' });
    setIsPaused(false);
  };
  
  const handleStop = async () => {
    if (confirm('Stop scenario? All positions will be closed.')) {
      await fetch('/api/simulation/stop', { method: 'POST' });
      router.push('/leaderboard');
    }
  };
  
  const handleSpeedChange = async (newSpeed: number) => {
    await fetch('/api/simulation/speed', {
      method: 'POST',
      body: JSON.stringify({ speed: newSpeed })
    });
    setSpeed(newSpeed);
  };
  
  return (
    <div className="scenario-controls">
      {isPaused ? (
        <button onClick={handleResume}>▶️ Resume</button>
      ) : (
        <button onClick={handlePause}>⏸️ Pause</button>
      )}
      
      <button onClick={handleStop}>⏹️ Stop</button>
      
      <div className="speed-control">
        <label>Speed:</label>
        <select value={speed} onChange={e => handleSpeedChange(Number(e.target.value))}>
          <option value={1}>1x</option>
          <option value={2}>2x</option>
          <option value={5}>5x</option>
        </select>
      </div>
    </div>
  );
}
```

---

## 8. Leaderboard & Gamification

### PnL Tracking

**Data Collection:**
- Every trade recorded in `sim_trades` table with entry/exit price, size, leverage
- Periodic snapshots of all open positions (mark-to-market PnL)
- Realized PnL calculated on position close
- Unrealized PnL from current price vs. entry price

```typescript
// backend/src/services/LeaderboardService.ts

export class LeaderboardService {
  /**
   * Calculate total PnL for a user
   */
  async calculateUserPnL(userPubkey: string): Promise<PnLData> {
    // Get all closed trades
    const { data: closedTrades } = await supabase
      .from('sim_trades')
      .select('*')
      .eq('user_pubkey', userPubkey)
      .eq('status', 'closed');
    
    const realizedPnL = closedTrades.reduce((sum, trade) => {
      return sum + (trade.exit_price - trade.entry_price) * trade.size * (trade.direction === 'long' ? 1 : -1);
    }, 0);
    
    // Get open positions
    const { data: openTrades } = await supabase
      .from('sim_trades')
      .select('*')
      .eq('user_pubkey', userPubkey)
      .eq('status', 'open');
    
    const currentPrice = await this.getCurrentPrice();
    const unrealizedPnL = openTrades.reduce((sum, trade) => {
      return sum + (currentPrice - trade.entry_price) * trade.size * (trade.direction === 'long' ? 1 : -1);
    }, 0);
    
    const totalPnL = realizedPnL + unrealizedPnL;
    
    // Calculate win rate
    const wins = closedTrades.filter(t => {
      const pnl = (t.exit_price - t.entry_price) * (t.direction === 'long' ? 1 : -1);
      return pnl > 0;
    }).length;
    
    const winRate = closedTrades.length > 0 ? wins / closedTrades.length : 0;
    
    return {
      realizedPnL,
      unrealizedPnL,
      totalPnL,
      winRate,
      totalTrades: closedTrades.length + openTrades.length
    };
  }
  
  /**
   * Get leaderboard rankings
   */
  async getLeaderboard(timeframe: '1h' | '24h' | '7d' | 'all'): Promise<LeaderboardEntry[]> {
    // Calculate PnL for all users
    const { data: users } = await supabase
      .from('sim_faucet_claims')
      .select('user_pubkey')
      .gte('timestamp', this.getTimeframeStart(timeframe));
    
    const uniqueUsers = [...new Set(users.map(u => u.user_pubkey))];
    
    const leaderboard = await Promise.all(
      uniqueUsers.map(async (pubkey) => {
        const pnl = await this.calculateUserPnL(pubkey);
        const username = await this.getUsername(pubkey); // From user profile or default to pubkey
        
        return {
          pubkey,
          username,
          totalPnL: pnl.totalPnL,
          winRate: pnl.winRate,
          totalTrades: pnl.totalTrades
        };
      })
    );
    
    // Sort by total PnL descending
    return leaderboard.sort((a, b) => b.totalPnL - a.totalPnL);
  }
  
  private getTimeframeStart(timeframe: string): Date {
    const now = new Date();
    switch (timeframe) {
      case '1h': return new Date(now.getTime() - 60 * 60 * 1000);
      case '24h': return new Date(now.getTime() - 24 * 60 * 60 * 1000);
      case '7d': return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      default: return new Date(0);
    }
  }
}
```

### Competitions

**Weekly Competition Structure:**
- **Duration:** 7 days (Monday 00:00 UTC to Sunday 23:59 UTC)
- **Entry:** Automatic for anyone who trades during the week
- **Prize:** Top 10 get bragging rights + NFT badge
- **Categories:**
  - Highest PnL (absolute)
  - Highest ROI (percentage return on initial capital)
  - Most Consistent (lowest PnL volatility with positive return)
  - Degen of the Week (most trades, highest leverage)

```typescript
interface Competition {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  category: 'pnl' | 'roi' | 'consistent' | 'degen';
  prizes: Prize[];
}

interface Prize {
  rank: number;
  badge: string;
  nftMetadata?: object;
}

// Example: Monthly competition
const februaryComp: Competition = {
  id: 'feb_2026',
  name: 'February Futures Festival',
  startDate: new Date('2026-02-01'),
  endDate: new Date('2026-02-28'),
  category: 'pnl',
  prizes: [
    { rank: 1, badge: '🥇 Feb Champion', nftMetadata: {/* ... */} },
    { rank: 2, badge: '🥈 Feb Runner-up' },
    { rank: 3, badge: '🥉 Feb Third Place' }
  ]
};
```

### Badges & Achievements

**Achievement System:**
```typescript
interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  requirement: (stats: UserStats) => boolean;
}

const ACHIEVEMENTS: Achievement[] = [
  {
    id: 'first_trade',
    name: 'First Blood',
    description: 'Complete your first trade',
    icon: '🎯',
    requirement: (stats) => stats.totalTrades >= 1
  },
  {
    id: 'profitable_10',
    name: 'Consistent Trader',
    description: '10 profitable trades in a row',
    icon: '📈',
    requirement: (stats) => stats.currentStreak >= 10
  },
  {
    id: 'survived_crash',
    name: 'Crash Survivor',
    description: 'Survive a flash crash scenario with positive PnL',
    icon: '🛡️',
    requirement: (stats) => stats.scenariosCompleted.includes('flash_crash') && stats.totalPnL > 0
  },
  {
    id: 'whale_hunter',
    name: 'Whale Hunter',
    description: 'Make $10k+ profit in Whale Entry scenario',
    icon: '🐋',
    requirement: (stats) => {
      const whaleScenario = stats.scenarioResults.find(s => s.id === 'whale_entry');
      return whaleScenario && whaleScenario.pnl > 10000;
    }
  },
  {
    id: 'liquidation_dodge',
    name: 'Neo',
    description: 'Get within 5% of liquidation price and recover',
    icon: '🥋',
    requirement: (stats) => stats.closeCalls > 0
  },
  {
    id: 'funding_master',
    name: 'Funding Master',
    description: 'Earn $1k+ from funding rate in Funding Squeeze',
    icon: '💰',
    requirement: (stats) => {
      const fundingScenario = stats.scenarioResults.find(s => s.id === 'funding_squeeze');
      return fundingScenario && fundingScenario.fundingEarned > 1000;
    }
  },
  {
    id: 'degen_legend',
    name: 'Certified Degen',
    description: 'Use 50x leverage and make profit',
    icon: '🎰',
    requirement: (stats) => stats.maxLeverageUsed >= 50 && stats.totalPnL > 0
  }
];

// Check and award achievements
async function checkAchievements(userPubkey: string) {
  const stats = await getUserStats(userPubkey);
  
  for (const achievement of ACHIEVEMENTS) {
    if (achievement.requirement(stats)) {
      await awardAchievement(userPubkey, achievement.id);
    }
  }
}
```

**Frontend Display:**
```typescript
// frontend/src/components/AchievementBadges.tsx

export function AchievementBadges({ userPubkey }: { userPubkey: string }) {
  const [badges, setBadges] = useState<string[]>([]);
  
  useEffect(() => {
    fetch(`/api/users/${userPubkey}/achievements`)
      .then(res => res.json())
      .then(data => setBadges(data.achievements));
  }, [userPubkey]);
  
  return (
    <div className="achievement-badges">
      <h4>Achievements</h4>
      <div className="badges-grid">
        {ACHIEVEMENTS.map(achievement => {
          const earned = badges.includes(achievement.id);
          return (
            <div 
              key={achievement.id}
              className={`badge ${earned ? 'earned' : 'locked'}`}
              title={achievement.description}
            >
              <span className="icon">{earned ? achievement.icon : '🔒'}</span>
              <span className="name">{achievement.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

---

## 9. Backend Services

### Service Architecture

```
Backend (Express.js on Railway)
│
├── services/
│   ├── OraclePriceEngine.ts      // Price movement simulation
│   ├── BotFleet.ts                // Bot orchestration
│   ├── ScenarioManager.ts         // Scenario lifecycle
│   ├── FaucetService.ts           // Token airdrop
│   ├── LeaderboardService.ts      // PnL calculation & rankings
│   └── CrankService.ts            // Periodic on-chain updates
│
├── api/
│   ├── simulation.routes.ts       // /api/simulation/* endpoints
│   ├── leaderboard.routes.ts      // /api/leaderboard/* endpoints
│   └── faucet.routes.ts           // /api/faucet/* endpoints
│
├── sdk/
│   └── percolator.ts              // Solana program SDK wrapper
│
└── workers/
    ├── priceUpdateWorker.ts       // Background job: price updates
    ├── crankWorker.ts             // Background job: crank market
    └── statsWorker.ts             // Background job: aggregate stats
```

### Integration Points

**1. Percolator SDK Wrapper**
```typescript
// backend/src/sdk/percolator.ts

import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet } from '@project-serum/anchor';
import idl from './percolator_idl.json';

export class PercolatorSDK {
  private program: Program;
  private connection: Connection;
  private marketPubkey: PublicKey;
  
  constructor(connection: Connection, marketPubkey: PublicKey) {
    this.connection = connection;
    this.marketPubkey = marketPubkey;
    
    // Initialize program
    const provider = new AnchorProvider(
      connection,
      new Wallet(Keypair.generate()), // Dummy wallet for read-only
      { commitment: 'confirmed' }
    );
    
    this.program = new Program(idl, new PublicKey(idl.metadata.address), provider);
  }
  
  /**
   * Set oracle price (admin only)
   */
  async setAuthorityPrice(adminKeypair: Keypair, priceE6: number): Promise<string> {
    const tx = await this.program.methods
      .setAuthorityPrice(priceE6)
      .accounts({
        admin: adminKeypair.publicKey,
        market: this.marketPubkey
      })
      .signers([adminKeypair])
      .rpc();
    
    return tx;
  }
  
  /**
   * Crank market to update funding and check liquidations
   */
  async crankMarket(crankerKeypair: Keypair): Promise<string> {
    const tx = await this.program.methods
      .crank()
      .accounts({
        cranker: crankerKeypair.publicKey,
        market: this.marketPubkey
      })
      .signers([crankerKeypair])
      .rpc();
    
    return tx;
  }
  
  /**
   * Open position
   */
  async openPosition(
    traderKeypair: Keypair,
    direction: 'long' | 'short',
    size: number,
    leverage: number
  ): Promise<string> {
    const tx = await this.program.methods
      .openPosition({
        direction: direction === 'long' ? { long: {} } : { short: {} },
        size,
        leverage
      })
      .accounts({
        trader: traderKeypair.publicKey,
        market: this.marketPubkey
      })
      .signers([traderKeypair])
      .rpc();
    
    return tx;
  }
  
  /**
   * Close position
   */
  async closePosition(traderKeypair: Keypair): Promise<string> {
    const tx = await this.program.methods
      .closePosition()
      .accounts({
        trader: traderKeypair.publicKey,
        market: this.marketPubkey
      })
      .signers([traderKeypair])
      .rpc();
    
    return tx;
  }
  
  /**
   * Get current price from market admin account
   */
  async getCurrentPrice(): Promise<number> {
    const marketAccount = await this.program.account.market.fetch(this.marketPubkey);
    return marketAccount.authorityPriceE6 / 1_000_000;
  }
  
  /**
   * Get trader account data
   */
  async getTraderAccount(traderPubkey: PublicKey): Promise<TraderAccount | null> {
    const [traderAccountPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('trader'), this.marketPubkey.toBuffer(), traderPubkey.toBuffer()],
      this.program.programId
    );
    
    try {
      const account = await this.program.account.traderAccount.fetch(traderAccountPDA);
      return account;
    } catch {
      return null;
    }
  }
}
```

**2. Background Workers**
```typescript
// backend/src/workers/priceUpdateWorker.ts

import { parentPort } from 'worker_threads';
import { OraclePriceEngine } from '../services/OraclePriceEngine';

const engine = new OraclePriceEngine(/* ... */);

// Listen for commands from main thread
parentPort?.on('message', async (msg) => {
  if (msg.type === 'START') {
    engine.start(msg.priceModel, msg.intervalMs);
  } else if (msg.type === 'STOP') {
    engine.stop();
  } else if (msg.type === 'UPDATE_MODEL') {
    engine.updateModel(msg.priceModel);
  }
});

// Send updates back to main thread
setInterval(() => {
  parentPort?.postMessage({
    type: 'PRICE_UPDATE',
    price: engine.getCurrentPrice()
  });
}, 5000);
```

```typescript
// backend/src/workers/crankWorker.ts

import { CrankService } from '../services/CrankService';

const crankService = new CrankService(/* ... */);

// Run crank every 10 seconds
setInterval(async () => {
  try {
    const result = await crankService.executeCrank();
    console.log('[CrankWorker] Crank executed:', result);
    
    // Report liquidations
    if (result.liquidations.length > 0) {
      parentPort?.postMessage({
        type: 'LIQUIDATIONS',
        count: result.liquidations.length,
        totalValue: result.liquidations.reduce((sum, l) => sum + l.collateral, 0)
      });
    }
  } catch (error) {
    console.error('[CrankWorker] Error:', error);
  }
}, 10000);
```

**3. API Endpoints**
```typescript
// backend/src/api/simulation.routes.ts

import express from 'express';
import { ScenarioManager } from '../services/ScenarioManager';

const router = express.Router();
const scenarioManager = new ScenarioManager();

// Start simulation scenario
router.post('/start', async (req, res) => {
  const { scenarioId } = req.body;
  
  try {
    await scenarioManager.start(scenarioId);
    res.json({ success: true, scenarioId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Pause scenario
router.post('/pause', async (req, res) => {
  scenarioManager.pause();
  res.json({ success: true });
});

// Resume scenario
router.post('/resume', async (req, res) => {
  scenarioManager.resume();
  res.json({ success: true });
});

// Stop scenario
router.post('/stop', async (req, res) => {
  await scenarioManager.stop();
  res.json({ success: true });
});

// Get current scenario status
router.get('/status', async (req, res) => {
  const status = scenarioManager.getStatus();
  res.json(status);
});

// WebSocket for live updates
router.ws('/live', (ws, req) => {
  const interval = setInterval(async () => {
    const data = {
      price: await scenarioManager.getCurrentPrice(),
      activeBots: scenarioManager.getActiveBotCount(),
      volume24h: await scenarioManager.getVolume24h(),
      // ... more data
    };
    
    ws.send(JSON.stringify(data));
  }, 1000);
  
  ws.on('close', () => clearInterval(interval));
});

export default router;
```

---

## 10. Database Schema

### New Tables (SQL)

```sql
-- Simulation wallets (bots and pre-funded accounts)
CREATE TABLE sim_wallets (
  wallet_id VARCHAR(50) PRIMARY KEY,
  pubkey VARCHAR(44) UNIQUE NOT NULL,
  private_key TEXT NOT NULL, -- Encrypted in production
  bot_type VARCHAR(30), -- 'market_maker', 'trend_follower', etc.
  is_assigned BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sim_wallets_bot_type ON sim_wallets(bot_type);
CREATE INDEX idx_sim_wallets_assigned ON sim_wallets(is_assigned);

-- User faucet claims
CREATE TABLE sim_faucet_claims (
  id SERIAL PRIMARY KEY,
  user_pubkey VARCHAR(44) NOT NULL,
  amount_usdc DECIMAL(18, 6) NOT NULL,
  amount_sol DECIMAL(18, 9) NOT NULL,
  timestamp TIMESTAMP NOT NULL,
  tx_signature VARCHAR(88) UNIQUE,
  ip_address VARCHAR(45), -- For rate limiting
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_faucet_user ON sim_faucet_claims(user_pubkey);
CREATE INDEX idx_faucet_timestamp ON sim_faucet_claims(timestamp);
CREATE INDEX idx_faucet_ip ON sim_faucet_claims(ip_address, timestamp);

-- Trade history
CREATE TABLE sim_trades (
  id SERIAL PRIMARY KEY,
  user_pubkey VARCHAR(44) NOT NULL,
  market VARCHAR(20) NOT NULL, -- 'SOL-PERP', etc.
  direction VARCHAR(10) NOT NULL, -- 'long' or 'short'
  size DECIMAL(18, 6) NOT NULL,
  leverage DECIMAL(5, 2) NOT NULL,
  entry_price DECIMAL(18, 6) NOT NULL,
  exit_price DECIMAL(18, 6),
  entry_time TIMESTAMP NOT NULL,
  exit_time TIMESTAMP,
  status VARCHAR(20) NOT NULL, -- 'open', 'closed', 'liquidated'
  realized_pnl DECIMAL(18, 6),
  funding_paid DECIMAL(18, 6) DEFAULT 0,
  tx_entry VARCHAR(88),
  tx_exit VARCHAR(88),
  scenario_id VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_trades_user ON sim_trades(user_pubkey);
CREATE INDEX idx_trades_status ON sim_trades(status);
CREATE INDEX idx_trades_scenario ON sim_trades(scenario_id);
CREATE INDEX idx_trades_entry_time ON sim_trades(entry_time);

-- Leaderboard entries (materialized view for performance)
CREATE TABLE sim_leaderboard_entries (
  id SERIAL PRIMARY KEY,
  user_pubkey VARCHAR(44) UNIQUE NOT NULL,
  username VARCHAR(100),
  total_pnl DECIMAL(18, 6) NOT NULL,
  realized_pnl DECIMAL(18, 6) NOT NULL,
  unrealized_pnl DECIMAL(18, 6) NOT NULL,
  win_rate DECIMAL(5, 4), -- 0.0000 to 1.0000
  total_trades INTEGER DEFAULT 0,
  total_volume DECIMAL(18, 6) DEFAULT 0,
  max_leverage DECIMAL(5, 2) DEFAULT 1,
  scenarios_completed INTEGER DEFAULT 0,
  achievements JSONB DEFAULT '[]',
  rank_1h INTEGER,
  rank_24h INTEGER,
  rank_7d INTEGER,
  rank_all INTEGER,
  last_updated TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_leaderboard_pnl ON sim_leaderboard_entries(total_pnl DESC);
CREATE INDEX idx_leaderboard_user ON sim_leaderboard_entries(user_pubkey);

-- Scenario runs
CREATE TABLE sim_scenarios (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  config JSONB NOT NULL, -- Full scenario configuration
  start_time TIMESTAMP,
  end_time TIMESTAMP,
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'running', 'paused', 'completed'
  participants INTEGER DEFAULT 0,
  total_volume DECIMAL(18, 6) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_scenarios_status ON sim_scenarios(status);
CREATE INDEX idx_scenarios_start ON sim_scenarios(start_time);

-- Events (price updates, news, whale alerts, etc.)
CREATE TABLE sim_events (
  id SERIAL PRIMARY KEY,
  scenario_id VARCHAR(50),
  event_type VARCHAR(50) NOT NULL, -- 'price_update', 'news', 'whale_alert', 'liquidation', etc.
  timestamp TIMESTAMP NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_events_scenario ON sim_events(scenario_id);
CREATE INDEX idx_events_type ON sim_events(event_type);
CREATE INDEX idx_events_timestamp ON sim_events(timestamp);

-- Achievements
CREATE TABLE sim_achievements (
  id SERIAL PRIMARY KEY,
  user_pubkey VARCHAR(44) NOT NULL,
  achievement_id VARCHAR(50) NOT NULL,
  earned_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_pubkey, achievement_id)
);

CREATE INDEX idx_achievements_user ON sim_achievements(user_pubkey);

-- User profiles (optional - for custom usernames, avatars)
CREATE TABLE sim_user_profiles (
  user_pubkey VARCHAR(44) PRIMARY KEY,
  username VARCHAR(100) UNIQUE,
  avatar_url TEXT,
  bio TEXT,
  twitter_handle VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### Materialized View for Leaderboard Performance

```sql
-- Refresh leaderboard every 5 minutes via cron job
CREATE MATERIALIZED VIEW sim_leaderboard_live AS
SELECT 
  t.user_pubkey,
  COALESCE(p.username, SUBSTRING(t.user_pubkey, 1, 8) || '...') as username,
  SUM(CASE WHEN t.status = 'closed' THEN t.realized_pnl ELSE 0 END) as realized_pnl,
  SUM(CASE WHEN t.status = 'open' THEN 
    (current_price.price - t.entry_price) * t.size * (CASE WHEN t.direction = 'long' THEN 1 ELSE -1 END)
  ELSE 0 END) as unrealized_pnl,
  SUM(COALESCE(t.realized_pnl, 0)) + SUM(CASE WHEN t.status = 'open' THEN 
    (current_price.price - t.entry_price) * t.size * (CASE WHEN t.direction = 'long' THEN 1 ELSE -1 END)
  ELSE 0 END) as total_pnl,
  COUNT(*) as total_trades,
  SUM(t.size * t.entry_price) as total_volume,
  SUM(CASE WHEN t.status = 'closed' AND t.realized_pnl > 0 THEN 1 ELSE 0 END)::DECIMAL / 
    NULLIF(SUM(CASE WHEN t.status = 'closed' THEN 1 ELSE 0 END), 0) as win_rate
FROM sim_trades t
LEFT JOIN sim_user_profiles p ON t.user_pubkey = p.user_pubkey
CROSS JOIN (
  SELECT price FROM sim_events 
  WHERE event_type = 'price_update' 
  ORDER BY timestamp DESC 
  LIMIT 1
) current_price
GROUP BY t.user_pubkey, p.username;

CREATE INDEX idx_leaderboard_live_pnl ON sim_leaderboard_live(total_pnl DESC);

-- Refresh function
CREATE OR REPLACE FUNCTION refresh_leaderboard()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY sim_leaderboard_live;
END;
$$ LANGUAGE plpgsql;

-- Schedule refresh (using pg_cron or external cron job)
-- SELECT cron.schedule('refresh-leaderboard', '*/5 * * * *', 'SELECT refresh_leaderboard()');
```

---

## 11. Security

### Keypair Management

**Admin Keypair (Oracle Price Setter):**
- **Storage:** Environment variable `SIM_ADMIN_PRIVATE_KEY` (base58 encoded)
- **Rotation:** Quarterly or if compromised
- **Access:** Backend only, never exposed in API responses or frontend
- **Backup:** Encrypted backup stored in 1Password/Vault

**Bot Wallets:**
- **Generation:** 50 wallets pre-generated on backend startup
- **Storage:** Database `sim_wallets` table with encrypted private keys
- **Encryption:** AES-256 with key from `WALLET_ENCRYPTION_KEY` env var
- **Access Control:** Only `BotFleet` service can decrypt

**Faucet Keypair:**
- **Funding:** Pre-funded with 100k USDC on devnet
- **Monitoring:** Alert if balance drops below 10k USDC
- **Refill:** Auto-request from devnet faucet when SOL < 1

```typescript
// backend/src/utils/encryption.ts

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY = Buffer.from(process.env.WALLET_ENCRYPTION_KEY!, 'hex'); // 32 bytes

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decrypt(encrypted: string): string {
  const parts = encrypted.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encryptedText = parts[2];
  
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}
```

### Abuse Prevention

**Faucet Rate Limiting:**
- **Per Wallet:** 1 claim per hour (stored in Redis)
- **Per IP:** 5 claims per hour (CAPTCHA after 3)
- **Global:** 1000 claims per hour (circuit breaker)

**Sybil Protection:**
- **Wallet Age:** Require wallet to have prior activity on mainnet (optional)
- **Turnstile CAPTCHA:** Cloudflare Turnstile on faucet claim
- **Fingerprinting:** Track browser fingerprint (FingerprintJS) to detect multi-wallet abuse

**Position Limits:**
- **Max Position Size:** $100k per user (prevent single user from dominating)
- **Max Leverage:** 100x (same as mainnet, but extreme)
- **Max Open Positions:** 10 simultaneous positions

**Bot Detection:**
- **Trading Patterns:** Flag accounts with inhuman consistency (e.g., exact same order every 10.000s)
- **API Rate Limits:** Max 100 requests/minute per IP
- **Transaction Signature:** Require wallet signature on all trade submissions (no API keys)

```typescript
// Rate limiting middleware
import rateLimit from 'express-rate-limit';

export const faucetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 requests per IP per hour
  message: 'Too many faucet claims from this IP',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limit if CAPTCHA verified
    return req.body.captchaToken && verifyCaptcha(req.body.captchaToken);
  }
});

// Usage
app.post('/api/faucet/claim', faucetLimiter, async (req, res) => {
  // ... claim logic
});
```

### Access Control

**API Endpoints:**
- **Public:** `/api/leaderboard`, `/api/simulation/status`, `/api/faucet/claim`
- **Authenticated:** `/api/simulation/start`, `/api/simulation/stop` (require wallet signature)
- **Admin Only:** `/api/simulation/config`, `/api/bots/control` (require admin API key)

**WebSocket Security:**
- **Origin Check:** Only allow connections from `percolator.trade` domain
- **Rate Limit:** Max 100 messages per second per connection
- **Authentication:** Optional JWT for authenticated users (to show personalized data)

---

## 12. Build Plan

### Phase 1: Core Infrastructure (Week 1-2) — **40 hours**

**Goal:** Get basic simulation running with manual price control

**Tasks:**
1. **Solana Program Setup** (4h)
   - Verify devnet deployment
   - Test admin price setting
   - Test position opening/closing
   - Document instruction formats

2. **Backend Foundation** (8h)
   - Initialize Express server on Railway
   - Setup Supabase connection
   - Create database tables (schema from section 10)
   - Environment variables and secrets

3. **Percolator SDK Wrapper** (6h)
   - Implement `setAuthorityPrice`
   - Implement `openPosition`, `closePosition`
   - Implement `crankMarket`
   - Add error handling and retries

4. **Oracle Price Engine** (8h)
   - Implement price movement models (random walk, trend, crash)
   - Build price update loop with configurable interval
   - Test price updates on devnet
   - Store price history in database

5. **Faucet Service** (6h)
   - Implement token airdrop (SOL + USDC)
   - Add rate limiting (wallet + IP)
   - Auto-create trader accounts
   - Test with multiple wallets

6. **Frontend `/simulate` Page** (8h)
   - Create basic layout (see section 7)
   - Add wallet connection
   - Display current price
   - Faucet button integration
   - Basic trading interface (reuse from `/trade` page)

**Deliverable:** Users can claim tokens, manually set price, and trade

---

### Phase 2: Bot Fleet & Scenarios (Week 3-4) — **50 hours**

**Goal:** Automated market activity and scenario system

**Tasks:**
1. **Bot Wallet Management** (4h)
   - Generate 50 bot wallets
   - Store in database with encryption
   - Implement assignment/release logic
   - Fund bots with devnet tokens

2. **Bot Implementations** (20h)
   - Market Maker Bot (5h)
   - Trend Follower Bot (4h)
   - Degen Bot (3h)
   - LP Provider Bot (6h)
   - Bot orchestration service (2h)

3. **Scenario Engine** (12h)
   - Define 6 predefined scenarios (configs)
   - Implement `ScenarioManager` with phase transitions
   - Add pause/resume/stop controls
   - Event system (news, whale alerts)

4. **Crank Service** (6h)
   - Implement periodic crank calls
   - Liquidation detection and logging
   - Funding rate calculation verification
   - Integration with scenario lifecycle

5. **Scenario UI** (8h)
   - Scenario picker component
   - Live dashboard with WebSocket
   - Scenario controls (pause, stop, speed)
   - Phase progress indicator

**Deliverable:** Full scenarios with bots creating realistic market activity

---

### Phase 3: Gamification & Polish (Week 5-6) — **30 hours**

**Goal:** Leaderboard, achievements, hackathon-ready demo

**Tasks:**
1. **Leaderboard System** (10h)
   - PnL calculation service
   - Materialized view optimization
   - Leaderboard API endpoints
   - Frontend leaderboard page with filters (1h, 24h, 7d, all)

2. **Achievement System** (8h)
   - Define 10-15 achievements
   - Implement achievement checker
   - Award/store achievements
   - Frontend badge display

3. **Polish & UX** (6h)
   - Toast notifications for events
   - Animations and transitions
   - Responsive design
   - Loading states and error handling

4. **Analytics & Monitoring** (4h)
   - Add logging (Winston/Pino)
   - Error tracking (Sentry)
   - Performance monitoring
   - Dashboard for admin (bot status, scenario stats)

5. **Documentation** (2h)
   - User guide (how to use simulation mode)
   - Developer docs (API endpoints)
   - Deployment runbook

**Deliverable:** Production-ready simulation mode

---

### Total Time Estimate: **120 hours (~3 weeks full-time or 6 weeks part-time)**

**Team Allocation:**
- **1 Backend Engineer:** Phase 1 (Oracle, Faucet, SDK) + Phase 2 (Bots, Scenarios)
- **1 Frontend Engineer:** Phase 1 (UI) + Phase 2 (Scenario UI) + Phase 3 (Leaderboard, Polish)
- **1 Full-Stack:** Phase 3 (Achievements, Analytics) + Testing

**Critical Path:**
1. Oracle Price Engine (blocks bots)
2. Bot Fleet (blocks scenarios)
3. Scenario Engine (blocks demo)

**Parallel Workstreams:**
- Frontend can start with manual price mode while bots are being built
- Leaderboard can be built in parallel with scenarios (uses same trade data)

---

## 13. Hackathon Demo Script (Feb 18, 2026)

**Duration:** 5 minutes  
**Objective:** Show simulation mode as a killer feature for user acquisition

### Script

**[00:00 - 00:30] Hook**
> "Imagine trying to learn perpetual futures trading on a live exchange. You'd blow up your account in minutes. That's why we built **Percolator Simulation Mode** — a risk-free training ground on Solana devnet that feels 100% real."

**[00:30 - 01:30] Problem & Solution**
> "The problem with paper trading on most DEXs? It's fake. Database updates, static orderbooks, no real market dynamics. Our solution? **Real on-chain transactions on devnet, with a live bot fleet creating market depth and volatility.**"

*[Screen share: Navigate to percolator.trade/simulate]*

**[01:30 - 02:30] Demo - Onboarding**
> "Watch this. I connect my wallet — no devnet SOL, no USDC. One click on 'Get Tokens' and..."

*[Click faucet button, show toast notification]*

> "Boom. 10,000 USDC and 0.5 SOL airdropped instantly. Account created on-chain. I'm ready to trade in 10 seconds."

*[Show wallet balance update]*

**[02:30 - 03:30] Demo - Scenario Trading**
> "Now, let's pick a scenario. I'll choose 'Bull Run' — strong uptrend, FOMO trading."

*[Select Bull Run scenario, click Start]*

> "Watch the price chart. This isn't a replay — it's a live simulation using our Oracle Price Engine. Notice the bot activity — 15 bots trading right now, creating liquidity and volatility."

*[Point to bot activity counter, show live price updates]*

> "I'll go long 2 SOL at 5x leverage..."

*[Execute trade, show position opened]*

> "...and as the price pumps, my unrealized PnL goes up. This is identical to mainnet — same program, same mechanics, just on devnet."

**[03:30 - 04:15] Demo - Leaderboard**
> "After trading for a bit, check the leaderboard."

*[Navigate to leaderboard page]*

> "Everyone's ranked by PnL. Top traders get badges and recognition. We're turning learning into competition — and it's viral. Users screenshot their ranks and share on Twitter."

*[Show sample leaderboard with usernames and PnL]*

**[04:15 - 05:00] Closing - Impact**
> "Why does this matter? **User acquisition.** Traders can try Percolator with zero risk. They learn our platform, build confidence, then graduate to mainnet. And because it's real on-chain transactions, they're already comfortable with the exact same UX.
>
> Plus, this is permanent. It's not a hackathon gimmick — it's a core feature that runs 24/7, onboarding users while we sleep.
>
> **Percolator Simulation Mode: Learn, compete, graduate to mainnet.** Thank you."

### Visual Aids

**Slide 1: Title**
- "Percolator Simulation Mode"
- Subtitle: "Risk-free perpetual futures training on Solana"

**Slide 2: Problem/Solution**
- Problem: Traditional paper trading is fake
- Solution: Real on-chain transactions + bot fleet

**Slide 3: Architecture Diagram** (from section 2)

**Slide 4: Key Metrics** (if available by Feb 18)
- "X users trained"
- "Y trades executed on devnet"
- "Z% conversion to mainnet"

**Slide 5: Live Demo** (screen share)

**Slide 6: Roadmap**
- Phase 1: Core infrastructure ✅
- Phase 2: Bot fleet & scenarios ✅
- Phase 3: Tournaments & AI bots 🚀

### Backup Plan (If Live Demo Fails)

1. **Pre-recorded Video:** 2-minute walkthrough of full flow
2. **Fallback Script:** Talk through screenshots
3. **Testnet Link:** Share devnet link for judges to try later

---

## 14. Future Extensions

### Mainnet Paper Trading

**Concept:** Use simulation mode infrastructure on mainnet with "play money"

**Implementation:**
- Shadow accounts (separate from real trading accounts)
- Pull real mainnet price from Pyth oracle
- No bot fleet (real users provide liquidity)
- Leaderboard shows performance against mainnet conditions

**Value Proposition:**
- "Try strategies on live mainnet data without risk"
- Bridge between simulation and real trading
- A/B test strategies before committing capital

**Technical Lift:** Low — reuse existing services, just point to mainnet RPC

---

### AI-Powered Bots

**Concept:** Replace hardcoded bot strategies with RL agents

**Approach:**
- Train reinforcement learning models (PPO, DQN) on historical perp data
- Models learn market-making, trend-following, arbitrage
- Deploy as bots in simulation mode
- Continuously improve via self-play

**Value Proposition:**
- More realistic market dynamics
- Research showcase ("our bots are trained via RL")
- Potential to license AI models to other DEXs

**Technical Lift:** High — requires ML infrastructure, training pipeline

**Timeline:** 3-6 months post-launch

---

### Trading Tournaments

**Concept:** Weekly/monthly competitions with prize pools

**Format:**
- Entry fee: 0.1 SOL (on mainnet)
- All participants start with same simulated capital
- Trade for 7 days in a specific scenario
- Top 10 split prize pool (e.g., 70% to #1, 20% to #2, 10% to #3)

**Prize Pool Funding:**
- Entry fees
- Protocol revenue allocation
- Sponsor partnerships

**Marketing Angle:**
- "Prove your skills and earn real money"
- Influencer tournaments (get YouTubers to compete)
- Twitter hype (live leaderboard updates)

**Technical Lift:** Medium — add payment processing, prize distribution, isolated scenarios per tournament

**Timeline:** 2-3 months post-launch

---

### Social Features

**Concept:** Turn simulation mode into a social trading platform

**Features:**
- **Copytrading:** Follow top traders, mirror their positions
- **Trade Sharing:** Screenshot trades with PnL, share to Twitter
- **Guilds/Teams:** Group competitions (total PnL per team)
- **Chat:** Live chat during scenarios (trash talk, strategy discussion)

**Value Proposition:**
- Increase engagement and retention
- Viral loop (users invite friends to teams)
- Community building

**Technical Lift:** Medium — add social graph, copytrading logic, chat infrastructure

---

### Educational Content Integration

**Concept:** In-app tutorials tied to simulation scenarios

**Features:**
- **Interactive Tutorials:** "Learn Funding Rates" scenario with guided steps
- **Quizzes:** Answer questions to unlock advanced scenarios
- **Certifications:** Complete all scenarios → earn "Percolator Certified Trader" NFT

**Value Proposition:**
- Position Percolator as educational platform (not just DEX)
- SEO opportunity ("how to trade perpetual futures")
- Partnership with educational platforms (Coursera, Udemy)

**Technical Lift:** Low — mostly content creation, some UI work

---

### Cross-Chain Simulation

**Concept:** Simulate trading on other chains (Ethereum, Arbitrum) using same infrastructure

**Implementation:**
- Deploy Percolator program to other chains (if possible)
- Or integrate with existing perp DEXs (GMX, Kwenta) via SDK
- Use same oracle + bot fleet approach

**Value Proposition:**
- "Learn perp trading on any chain, risk-free"
- Expand TAM beyond Solana users
- Marketing: "The Duolingo of perpetual futures"

**Technical Lift:** High — multi-chain infrastructure, different program APIs

---

### Scenario Marketplace

**Concept:** Let users create and share custom scenarios

**Features:**
- Scenario builder UI (extended from section 5)
- Publish to marketplace
- Upvote/downvote scenarios
- Creators earn rewards when their scenario is played

**Value Proposition:**
- Infinite content creation (by community)
- Discover unique market conditions (e.g., "2008 Financial Crisis Simulation")
- Gamification (who can create the hardest scenario?)

**Technical Lift:** Medium — user-generated content moderation, reward system

---

### API for Developers

**Concept:** Expose simulation mode as API for external devs

**Use Cases:**
- **Backtesting:** Test trading strategies on simulated markets
- **Research:** Academic studies on perp DEX mechanics
- **Integration:** Other platforms embed simulation mode (e.g., trading education apps)

**Endpoints:**
- `POST /api/simulation/create` — Create custom scenario
- `POST /api/simulation/{id}/trade` — Execute trade
- `GET /api/simulation/{id}/state` — Get current market state
- `POST /api/simulation/{id}/finish` — End scenario, get results

**Pricing:**
- Free tier: 100 requests/day
- Pro tier: 10k requests/day, $50/month
- Enterprise: Unlimited, custom pricing

**Value Proposition:**
- New revenue stream
- Developer ecosystem around Percolator
- Potential integrations (TradingView, CoinGecko)

**Technical Lift:** Low — wrap existing services in REST API

---

## Conclusion

Percolator Simulation Mode is a **permanent, high-value feature** that solves the core problem of user acquisition for perpetual DEXs: **risk-free onboarding with authentic trading experience.**

By executing real on-chain transactions on devnet, using a live bot fleet to create market dynamics, and gamifying the experience with leaderboards and scenarios, Simulation Mode turns learning into competition — and competition into virality.

**Key Success Metrics:**
- **User Acquisition:** 1,000 simulation users in first month
- **Conversion Rate:** 20% of simulation users trade on mainnet within 30 days
- **Engagement:** Avg. 5 scenarios completed per user
- **Virality:** 30% of users share leaderboard rank on social media

**Build Timeline:** 6 weeks part-time (120 hours)

**Hackathon Pitch:** 5-minute demo showing onboarding → trading → leaderboard flow

**Future:** Tournaments, AI bots, educational content, API for developers

---

**This is not a gimmick. This is a moat.**

*Let's ship it.* 🚀
