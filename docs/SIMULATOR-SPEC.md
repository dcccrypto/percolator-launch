# Risk Engine Simulator — Full Technical Specification

**Status:** Draft  
**Date:** 2026-02-17  
**Author:** Cobra 🐍  

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [On-Chain Components](#3-on-chain-components)
4. [Backend Services](#4-backend-services)
5. [Frontend](#5-frontend)
6. [Database Schema](#6-database-schema)
7. [User Flow](#7-user-flow)
8. [Bot Fleet](#8-bot-fleet)
9. [Scenario System](#9-scenario-system)
10. [Leaderboard](#10-leaderboard)
11. [Infrastructure & Costs](#11-infrastructure-costs)
12. [Build Phases](#12-build-phases)
13. [Open Questions](#13-open-questions)

---

## 1. Executive Summary

A **live simulation environment** where users trade on real Percolator devnet markets alongside AI bots. Users experience the risk engine firsthand — seeing funding rates shift, liquidations trigger, insurance fund grow, and haircuts apply — all with real on-chain transactions.

**Key decisions:**
- Users pay their own SOL for gas (trivial cost: ~0.000005 SOL/tx)
- We mint simulation collateral tokens (simUSDC) — free, unlimited supply
- 3 simulation markets: SOL/USD, BTC/USD, ETH/USD
- Admin oracle with real Pyth price feed + scenario overlays
- ~30 bots create realistic order flow 24/7
- Shared world (everyone sees same markets/bots) + scenario voting
- Guided walkthroughs explain risk engine concepts in real-time

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND (/simulate)                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │Trade Panel│ │Risk Dash │ │Scenarios │ │   Leaderboard     │   │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────────┘   │
│       │              │            │              │               │
│       └──────────────┴────────────┴──────────────┘               │
│                           │                                      │
│              ┌────────────┴────────────┐                         │
│              │   Wallet Adapter (user)  │                         │
│              └────────────┬────────────┘                         │
└───────────────────────────┼──────────────────────────────────────┘
                            │
              ┌─────────────▼─────────────┐
              │   Solana Devnet (Helius)    │
              │                            │
              │  ┌────────────────────┐    │
              │  │ Percolator Program  │    │
              │  │ FxfD37s1AZTeWfFQ.. │    │
              │  └────────┬───────────┘    │
              │           │                │
              │  ┌────────┴───────────┐    │
              │  │ Simulation Markets  │    │
              │  │ SOL/USD | BTC/USD  │    │
              │  │ ETH/USD            │    │
              │  │ (Admin Oracle)     │    │
              │  └────────────────────┘    │
              │                            │
              │  ┌────────────────────┐    │
              │  │    simUSDC Mint     │    │
              │  │  (we control auth)  │    │
              │  └────────────────────┘    │
              └────────────────────────────┘
                    ▲           ▲
                    │           │
         ┌──────────┘           └──────────┐
         │                                 │
┌────────┴────────┐              ┌─────────┴────────┐
│  Oracle Service  │              │   Bot Fleet       │
│  (Railway)       │              │   (Railway)       │
│                  │              │                   │
│  Pyth Hermes →   │              │  30 bots across   │
│  + Scenario      │              │  3 markets        │
│  Multipliers →   │              │  Reactive to      │
│  PushOraclePrice │              │  scenarios        │
└──────────────────┘              └───────────────────┘
```

---

## 3. On-Chain Components

### 3.1 simUSDC Token

We create a single SPL token on devnet to serve as collateral for all simulation markets.

| Property | Value |
|----------|-------|
| Name | Simulation USDC |
| Symbol | simUSDC |
| Decimals | 6 (matches real USDC) |
| Mint Authority | Our backend keypair (we can mint unlimited) |
| Initial Supply | Irrelevant — we mint on-demand |

**Creation:** Use the existing `/devnet-mint` page flow, or a one-time CLI script:
```bash
spl-token create-token --decimals 6  # Save mint address
spl-token create-account <MINT>       # Create vault ATA
spl-token mint <MINT> 1000000000      # Initial 1B supply
```

**Faucet flow:** User clicks "Get simUSDC" → backend API mints tokens to their wallet:
```
POST /api/simulate/faucet
Body: { wallet: "<pubkey>" }
→ Server signs mint-to instruction with mint authority keypair
→ 10,000 simUSDC sent to user's ATA (creates ATA if needed)
```

Rate limit: 10,000 simUSDC per wallet per 24h. Can request more (up to 50k total balance).

### 3.2 Simulation Markets

Three new markets deployed on the existing Percolator devnet program (`FxfD37s1AZTeWfFQ...`).

All markets share the **same simUSDC collateral mint** — users deposit once per market.

| Market | Oracle Feed (Pyth) | Feed ID |
|--------|-------------------|---------|
| SOL/USD | Crypto.SOL/USD | `ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d` |
| BTC/USD | Crypto.BTC/USD | `e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43` |
| ETH/USD | Crypto.ETH/USD | `ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace` |

**Oracle mode: Admin Oracle** (not direct Pyth). We set `oracleAuthority` to our oracle service keypair. The oracle service:
1. Fetches real price from Pyth Hermes API (free, no key needed)
2. Applies any active scenario multiplier
3. Pushes via `PushOraclePrice` instruction to each slab

**Market parameters:**
```
initialMarginBps:       500   (20x max leverage)
maintenanceMarginBps:   250   (40x before liquidation)
tradingFeeBps:          10    (0.1%)
maxAccounts:            256   (small slab — enough for sim)
newAccountFee:          0     (free account creation)
warmupPeriod:           10    (fast warmup for sim)
maxCrankStaleness:      400   (standard ~3 min)
liquidationFeeBps:      50    (0.5% liq fee)
liquidationBufferBps:   50
minLiquidationAbs:      1000000 (1 simUSDC min)
```

**LP setup per market:**
- 1 LP account (the platform vAMM) with 100,000 simUSDC collateral
- vAMM params: spread 20bps, max total 100bps, passive mode
- Insurance fund: 10,000 simUSDC initial topup

### 3.3 Market Deployment Script

One-time script that:
1. Creates simUSDC mint (if not exists)
2. Mints initial supply (1B tokens)
3. For each of SOL/USD, BTC/USD, ETH/USD:
   a. Create slab account (256-slot tier)
   b. Init market with simUSDC as collateral, zero feed ID (admin oracle)
   c. SetOracleAuthority to oracle service keypair
   d. Push initial price from Pyth
   e. UpdateConfig (funding params)
   f. KeeperCrank
   g. Init LP with vAMM matcher
   h. Deposit LP collateral (100k simUSDC)
   i. TopUp insurance (10k simUSDC)
   j. Final crank
   k. Create insurance LP mint
   l. Register in Supabase `sim_markets` table
4. Save all addresses to `sim-config.json`

---

## 4. Backend Services

### 4.1 Oracle Service (Node.js / Railway)

Runs continuously. Pushes prices every ~2 seconds.

```typescript
// Pseudocode
while (true) {
  for (const market of SIM_MARKETS) {
    // 1. Fetch real price from Pyth
    const pythPrice = await fetchPythPrice(market.feedId);
    
    // 2. Apply scenario multiplier (if active)
    const scenario = getActiveScenario();
    const adjustedPrice = applyScenario(pythPrice, scenario, market);
    
    // 3. Push to on-chain
    await pushOraclePrice(market.slab, adjustedPrice);
  }
  
  // 4. Crank all markets
  for (const market of SIM_MARKETS) {
    await keeperCrank(market.slab);
  }
  
  await sleep(2000);
}
```

**Scenario overlay logic:**
```typescript
function applyScenario(basePrice: number, scenario: Scenario, market: Market): number {
  if (!scenario) return basePrice;
  
  const elapsed = Date.now() - scenario.startedAt;
  const progress = Math.min(elapsed / scenario.durationMs, 1);
  
  switch (scenario.type) {
    case 'crash':
      // Gradual crash: e.g. -40% over 60s
      return basePrice * (1 - scenario.magnitude * easeInOut(progress));
    case 'squeeze':
      // Rapid pump then fade
      const peak = progress < 0.3 ? progress / 0.3 : 1 - (progress - 0.3) / 0.7;
      return basePrice * (1 + scenario.magnitude * peak);
    case 'volatile':
      // Random walk with high amplitude
      return basePrice * (1 + scenario.magnitude * Math.sin(progress * 20) * Math.random());
    case 'flash_crash':
      // Instant drop, quick recovery
      const drop = progress < 0.1 ? progress / 0.1 : 1;
      const recovery = progress > 0.1 ? (progress - 0.1) / 0.9 : 0;
      return basePrice * (1 - scenario.magnitude * drop * (1 - recovery));
    default:
      return basePrice;
  }
}
```

**Cost:** Pyth Hermes API is free. Oracle pushes cost ~0.000005 SOL each.
- 3 markets × every 2s = 1,800 pushes/hour = 0.009 SOL/hour = 0.216 SOL/day

### 4.2 Bot Fleet Service (Node.js / Railway)

~30 bots with different personalities trading across 3 markets.

**Bot types:**

| Type | Count | Behavior |
|------|-------|----------|
| Trend follower | 8 | Buy on price up, sell on price down. SMA crossover logic. |
| Mean reversion | 8 | Bet against big moves. Fade pumps, buy dips. |
| Momentum | 6 | Aggressive directional bets. High leverage. |
| Random/noise | 4 | Small random trades for volume. |
| Market maker | 4 | Maintain both long and short. Tight spreads. |

**Bot lifecycle:**
1. Each bot has a pre-funded devnet wallet with SOL + simUSDC
2. At startup: InitUser on each market, deposit simUSDC
3. Every 5-30 seconds (randomized per bot type): evaluate and possibly trade
4. Bots react to scenarios (crash → trend followers panic sell, mean reversion bots buy)

**Scenario reactions:**
```typescript
class TrendFollowerBot {
  async onScenario(scenario: Scenario) {
    if (scenario.type === 'crash') {
      // Panic sell — close longs, open shorts
      await this.closeAllLongs();
      await this.openShort(this.maxSize * 0.5);
    } else if (scenario.type === 'squeeze') {
      // FOMO — close shorts, go heavy long
      await this.closeAllShorts();
      await this.openLong(this.maxSize * 0.8);
    }
  }
}
```

**Capital per bot:** 5,000 simUSDC each = 150,000 simUSDC total for bots
**SOL per bot:** 0.5 SOL each (100 trades/day × 0.000005 SOL = 0.0005 SOL/day per bot)
**Total bot SOL needed:** 15 SOL initial (lasts months)

### 4.3 Faucet API (Next.js API Route)

```
POST /api/simulate/faucet
```

Mints simUSDC to the user's wallet. Server holds the mint authority keypair.

**Flow:**
1. Validate wallet address
2. Check rate limit (10k per 24h per wallet)
3. Create user's ATA if needed (server pays ~0.002 SOL rent)
4. Mint tokens to user's ATA
5. Return tx signature

**Server keypair needs:**
- simUSDC mint authority
- ~5 SOL for ATA creation costs (reusable — ATAs persist)

---

## 5. Frontend

### 5.1 Page: `/simulate`

Single-page experience with tabs/sections:

```
┌─────────────────────────────────────────────────────┐
│  🧪 Risk Engine Simulator                          │
│  ─────────────────────────────────────────────────  │
│  [SOL/USD ▼] [BTC/USD] [ETH/USD]     [Get simUSDC] │
│                                                     │
│  ┌───────────────┐  ┌────────────────────────────┐  │
│  │  Trade Panel   │  │  Live Risk Dashboard       │  │
│  │               │  │                            │  │
│  │  Long / Short │  │  ┌──────┐ ┌──────┐        │  │
│  │  Size: [____] │  │  │Vault │ │Insur.│        │  │
│  │  Leverage: 5x │  │  │$250k │ │$10k  │        │  │
│  │               │  │  └──────┘ └──────┘        │  │
│  │  [Execute]    │  │                            │  │
│  │               │  │  Funding: +0.003%/8h      │  │
│  │  Your Position│  │  Open Interest: $45,230    │  │
│  │  ────────────│  │  Haircut Ratio: 0.98       │  │
│  │  Entry: $195  │  │  Liquidations: 3          │  │
│  │  PnL: +$23.40│  │                            │  │
│  │  Margin: 12%  │  │  [▓▓▓▓▓░░░] Health: 85%   │  │
│  └───────────────┘  └────────────────────────────┘  │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │  📖 What's Happening Right Now               │   │
│  │  ─────────────────────────────────────────── │   │
│  │  "The funding rate just turned positive      │   │
│  │   because more traders are long than short.  │   │
│  │   This means longs pay shorts 0.003% every   │   │
│  │   8 hours to rebalance the market."          │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  ┌─────────────────┐  ┌────────────────────────┐   │
│  │  🌪️ Scenarios    │  │  🏆 Leaderboard        │   │
│  │  ──────────────  │  │  ──────────────────── │   │
│  │  [Flash Crash]  │  │  1. whale.sol  +$5.2k  │   │
│  │  [Short Squeeze]│  │  2. degen42    +$3.1k  │   │
│  │  [Black Swan]   │  │  3. You        +$23.40 │   │
│  │  [Volatile]     │  │  ...                   │   │
│  │                 │  │  ROI leader: anon +340% │   │
│  │  Vote: 3/5     │  │                         │   │
│  │  Next in: 2:34 │  └────────────────────────┘   │
│  └─────────────────┘                               │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │  📊 Price Chart (TradingView lightweight)    │   │
│  │  ──────────────────────────────────────────  │   │
│  │  [=================================]         │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### 5.2 Key Components

**New components (under `app/components/simulate/`):**
- `SimulatorPage.tsx` — Main page layout
- `SimMarketSelector.tsx` — Market tab selector
- `SimTradePanel.tsx` — Simplified trade execution (reuses existing hooks!)
- `SimRiskDashboard.tsx` — Live risk engine metrics (reuses `useEngineState()`)
- `SimExplainer.tsx` — Real-time commentary on risk engine events
- `SimScenarioPanel.tsx` — Scenario voting/triggering
- `SimLeaderboard.tsx` — PnL rankings
- `SimFaucet.tsx` — Get simUSDC button
- `SimOnboarding.tsx` — First-time guided walkthrough
- `SimPriceChart.tsx` — Lightweight chart with scenario overlay

**Reused existing infrastructure:**
- `useEngineState()` hook — reads slab data, already has vault, OI, funding, etc.
- `useTrade()` hook — builds trade instructions (works with any slab)
- `useInitUser()` hook — creates user account on slab
- `useDeposit()` hook — deposits collateral
- `useWithdraw()` hook — withdraws collateral
- `useLivePrice()` hook — price display
- `useBestLp()` hook — finds LP for trades
- `SlabProvider` — wraps everything with slab data
- `@percolator/core` package — all ABI, instructions, slab parsing

**This is critical: we DON'T need to rebuild any trading logic. The existing hooks work with any slab address. We just point them at simulation slabs instead of regular ones.**

### 5.3 Explainer System

Real-time commentary that watches risk engine state changes and explains them:

```typescript
function generateExplanation(prev: EngineState, curr: EngineState): string[] {
  const explanations = [];
  
  // Funding rate change
  if (curr.fundingRateBpsPerSlotLast !== prev.fundingRateBpsPerSlotLast) {
    const rate = Number(curr.fundingRateBpsPerSlotLast);
    if (rate > 0) {
      explanations.push("📈 Funding rate turned positive — longs are paying shorts. " +
        "This happens when more capital is betting on price going up.");
    } else if (rate < 0) {
      explanations.push("📉 Funding rate turned negative — shorts are paying longs. " +
        "The market is bearish, so shorts pay a premium.");
    }
  }
  
  // Liquidation
  if (curr.lifetimeLiquidations > prev.lifetimeLiquidations) {
    const count = Number(curr.lifetimeLiquidations - prev.lifetimeLiquidations);
    explanations.push(`💀 ${count} position(s) liquidated! When margin drops below ` +
      `${prev.maintenanceMarginBps / 100}%, the risk engine automatically closes positions ` +
      "to protect the system.");
  }
  
  // Haircut ratio change
  const [hNum, hDen] = computeHaircutRatio(curr);
  if (hNum < hDen) {
    explanations.push("⚠️ Haircut ratio < 1.0 — the vault can't cover all positive PnL. " +
      "Winners get proportionally reduced payouts. This is how Percolator avoids " +
      "socialized losses without ADL!");
  }
  
  // Insurance fund growth
  const insGrowth = curr.insuranceFund.balance - prev.insuranceFund.balance;
  if (insGrowth > 0n) {
    explanations.push(`🛡️ Insurance fund grew by $${formatUsd(insGrowth)} from trading fees. ` +
      "This buffer protects against extreme market events.");
  }
  
  return explanations;
}
```

---

## 6. Database Schema

New tables (migration `0XX_simulation.sql`):

```sql
-- Simulation markets (separate from regular markets)
CREATE TABLE IF NOT EXISTS sim_markets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  slab_address TEXT UNIQUE NOT NULL,
  symbol TEXT NOT NULL,              -- SOL/USD, BTC/USD, ETH/USD
  feed_id TEXT NOT NULL,             -- Pyth feed ID (hex)
  collateral_mint TEXT NOT NULL,     -- simUSDC mint address
  oracle_authority TEXT NOT NULL,    -- Oracle service keypair
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Simulation leaderboard
CREATE TABLE IF NOT EXISTS sim_leaderboard (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet TEXT NOT NULL,
  display_name TEXT,                 -- Optional ENS/SNS name
  total_pnl_e6 BIGINT DEFAULT 0,    -- Total PnL across all markets (in simUSDC e6)
  total_trades INTEGER DEFAULT 0,
  total_volume_e6 BIGINT DEFAULT 0,
  best_trade_pnl_e6 BIGINT DEFAULT 0,
  worst_trade_pnl_e6 BIGINT DEFAULT 0,
  liquidation_count INTEGER DEFAULT 0,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(wallet)
);

-- Simulation faucet tracking (rate limiting)
CREATE TABLE IF NOT EXISTS sim_faucet_claims (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet TEXT NOT NULL,
  amount_e6 BIGINT NOT NULL,
  tx_signature TEXT,
  claimed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Scenario history
CREATE TABLE IF NOT EXISTS sim_scenarios (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  scenario_type TEXT NOT NULL,       -- crash, squeeze, volatile, flash_crash, black_swan
  magnitude NUMERIC NOT NULL,        -- 0.0-1.0 (e.g. 0.4 = 40%)
  duration_ms BIGINT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  triggered_by TEXT,                 -- wallet that voted/triggered
  votes INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active'       -- active, completed, cancelled
);

-- Scenario votes (prevent double-voting)
CREATE TABLE IF NOT EXISTS sim_scenario_votes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  scenario_id UUID REFERENCES sim_scenarios(id),
  wallet TEXT NOT NULL,
  voted_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(scenario_id, wallet)
);
```

---

## 7. User Flow

### First-Time User

1. **Land on `/simulate`** → See overview: "Trade with real on-chain execution. Test the risk engine."
2. **Connect wallet** (Phantom/Solflare, devnet network)
3. **Get devnet SOL** → Link to Solana faucet + programmatic airdrop button
4. **Get simUSDC** → Click "Get 10,000 simUSDC" → backend mints to their wallet
5. **Select market** → SOL/USD (default)
6. **Init account** → Auto-prompted on first trade attempt (uses `useInitUser`)
7. **Deposit simUSDC** → Enter amount, confirm tx
8. **Place trade** → Long/Short with size + leverage slider
9. **Watch risk dashboard** → See how their trade affects the system
10. **Read explainers** → "Your long position increased the open interest by X..."

### Returning User

1. Connect wallet → already has simUSDC and account
2. See current position, PnL, leaderboard rank
3. Trade, manage positions, vote on scenarios

### Guided Walkthrough (Optional)

Step-by-step overlay that highlights each concept:
1. "This is the **vault** — all deposited collateral sits here"
2. "The **funding rate** keeps longs and shorts balanced"
3. "When a position gets liquidated, the **insurance fund** absorbs losses"
4. "The **haircut ratio** protects against systemic risk without ADL"
5. "Let's trigger a crash scenario and watch what happens..."

---

## 8. Bot Fleet

### Wallet Setup

30 bot wallets, pre-funded:
```
bot-sol-trend-1 through bot-sol-trend-3  (SOL/USD trend followers)
bot-sol-mean-1 through bot-sol-mean-3    (SOL/USD mean reversion)
bot-sol-mom-1 through bot-sol-mom-2      (SOL/USD momentum)
bot-sol-noise-1                          (SOL/USD noise)
bot-sol-mm-1                             (SOL/USD market maker)
[repeat for BTC and ETH]
```

Each wallet needs:
- 0.5 SOL (lasts months at ~100 trades/day)
- 5,000 simUSDC (we mint freely)

### Bot Framework

```typescript
interface Bot {
  name: string;
  wallet: Keypair;
  type: 'trend' | 'mean_reversion' | 'momentum' | 'noise' | 'market_maker';
  market: SimMarket;
  userIdx: number;
  
  // Config
  maxPositionSize: bigint;   // Max position in base units
  tradeFrequencyMs: number;  // How often to evaluate
  leverage: number;          // Target leverage
  
  // State
  currentPosition: bigint;
  lastTradeTime: number;
  
  // Methods
  evaluate(): Promise<TradeDecision>;
  onScenario(scenario: Scenario): void;
  onPriceUpdate(price: number): void;
}

interface TradeDecision {
  action: 'buy' | 'sell' | 'hold';
  size: bigint;
  reason: string;
}
```

### Bot SOL Funding

- 30 bots × 0.5 SOL = 15 SOL total
- Source: Devnet faucet (5 SOL per request, 2x per 8h per address)
- 3 faucet requests = 15 SOL (done in minutes)
- Bots barely spend SOL: 100 trades/day = 0.0005 SOL/day
- 15 SOL lasts: 15 / (0.0005 × 30) = 1,000 days

---

## 9. Scenario System

### Pre-built Scenarios

| Scenario | Description | Magnitude | Duration | Effect |
|----------|-------------|-----------|----------|--------|
| Flash Crash | Sudden -30% drop, quick 70% recovery | 0.30 | 60s | Tests liquidation cascade |
| Short Squeeze | Rapid +50% pump | 0.50 | 120s | Tests funding rate spike |
| Black Swan | -60% over 10 min | 0.60 | 600s | Tests insurance fund depletion |
| High Volatility | ±20% random oscillation | 0.20 | 300s | Tests crank staleness |
| Gentle Trend | Slow +15% over 30 min | 0.15 | 1800s | Tests funding rate adjustment |

### Voting Mechanics

1. Any user can propose a scenario (select from presets)
2. Requires 3 votes within 5 minutes to activate
3. Cooldown: 5 minutes between scenarios
4. Active scenario visible to all users
5. Bots react when scenario activates

### Manual Override

Admin (Khubair/oracle authority) can force-trigger any scenario via API:
```
POST /api/simulate/scenario
Body: { type: "crash", magnitude: 0.4, durationMs: 60000, apiKey: "..." }
```

---

## 10. Leaderboard

### Metrics

Primary: **Total PnL** (simUSDC) — sum of realized + unrealized across all markets.

Secondary metrics displayed:
- ROI% (PnL / total deposited)
- Trade count
- Win rate
- Best/worst trade
- Liquidation count (lower is better)
- Time in market

### Update Mechanism

1. On each trade: update `sim_leaderboard` via API
2. Every 30 seconds: recalculate unrealized PnL from on-chain state
3. Display updates every 5 seconds on frontend (WebSocket or polling)

### Anti-Gaming

- Leaderboard resets weekly (archive to `sim_leaderboard_history`)
- Fresh start each week encourages new players
- "All-time" leaderboard kept separately for bragging rights

---

## 11. Infrastructure & Costs

### Railway Services

| Service | Purpose | Est. Cost |
|---------|---------|-----------|
| Oracle Service | Push prices every 2s + crank | $5/mo |
| Bot Fleet | 30 bots trading | $7/mo |
| **Total** | | **~$12/mo** |

### On-Chain Costs

| Item | SOL/day | SOL/month |
|------|---------|-----------|
| Oracle pushes (3 markets × 2s) | 0.22 | 6.5 |
| Cranks (3 markets × 2s) | 0.22 | 6.5 |
| Bot trades (~3000/day) | 0.015 | 0.45 |
| User ATA creation (~20/day) | 0.04 | 1.2 |
| **Total** | **~0.5** | **~15** |

Devnet SOL is free from faucet. We need ~0.5 SOL/day total.
Faucet gives ~24 SOL/day per address. One address covers everything.

### Total Monthly Cost

- Railway: ~$12/mo
- Devnet SOL: Free
- Supabase: Already paying
- **Total: ~$12/mo**

---

## 12. Build Phases

### Phase 1: Foundation (3-4 days)

**Goal:** Simulation markets exist and users can trade manually.

Tasks:
- [ ] Deploy script: Create simUSDC mint + 3 markets
- [ ] Faucet API route (`/api/simulate/faucet`)
- [ ] `/simulate` page with market selector
- [ ] Trade panel (reuse existing hooks with sim slab addresses)
- [ ] Risk dashboard (reuse `useEngineState()`)
- [ ] Database migration for sim tables
- [ ] Basic onboarding flow (connect → get SOL → get simUSDC → trade)

### Phase 2: Oracle + Bots (2-3 days)

**Goal:** Markets are alive with real prices and bot activity.

Tasks:
- [ ] Oracle service (Pyth → push to sim markets)
- [ ] Bot framework (base class + personality configs)
- [ ] Deploy 30 bots with funded wallets
- [ ] Real-time price chart (TradingView lightweight)
- [ ] Verify risk engine behavior (funding, liquidations, crank)

### Phase 3: Scenarios + Explainers (2-3 days)

**Goal:** Interactive scenarios that demonstrate risk engine concepts.

Tasks:
- [ ] Scenario overlay logic in oracle service
- [ ] Scenario voting UI + API
- [ ] Bot scenario reactions
- [ ] Real-time explainer system
- [ ] Guided walkthrough overlay
- [ ] Scenario history display

### Phase 4: Leaderboard + Polish (1-2 days)

**Goal:** Competitive element + production-ready polish.

Tasks:
- [ ] Leaderboard backend (PnL tracking, updates)
- [ ] Leaderboard UI (rankings, stats, weekly reset)
- [ ] Performance optimization
- [ ] Mobile responsive
- [ ] Error handling + edge cases
- [ ] Landing section on homepage linking to simulator

**Total estimated: 8-12 days**

---

## 13. Open Questions

### Decided ✅
- [x] Capital model → Users pay own SOL, we mint simUSDC
- [x] Oracle approach → Admin oracle with Pyth base + scenario overlays
- [x] Market count → 3 (SOL/USD, BTC/USD, ETH/USD)
- [x] Session model → Shared world + scenario voting
- [x] Bot count → ~30 across 3 markets

### Needs Decision ❓
1. **Starting simUSDC amount per user?**
   - Proposal: 10,000 simUSDC (equivalent to $10k USDC)
   - Refill: 10k per 24h, max 50k balance
   
2. **Leaderboard reset frequency?**
   - Proposal: Weekly reset + all-time archive
   
3. **Scenario voting threshold?**
   - Proposal: 3 votes to activate, 5 min cooldown
   
4. **Slab size tier?**
   - Proposal: 256-account slabs (enough for ~200 users + 30 bots per market)
   - If we need more: 1024-account slabs (but larger on-chain account = more rent)

5. **Separate Supabase project or same?**
   - Proposal: Same project, new tables with `sim_` prefix
   - Keeps infrastructure simple

---

## Appendix: Key Addresses & Config

```json
{
  "network": "devnet",
  "programId": "FxfD37s1AZTeWfFQ...",
  "matcherProgramId": "4HcGCsyjAqnFua5...",
  "rpcUrl": "https://devnet.helius-rpc.com/?api-key=...",
  
  "simUSDC": {
    "mint": "TBD",
    "decimals": 6,
    "mintAuthority": "TBD (oracle service keypair)"
  },
  
  "markets": {
    "SOL/USD": {
      "slab": "TBD",
      "feedId": "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"
    },
    "BTC/USD": {
      "slab": "TBD", 
      "feedId": "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"
    },
    "ETH/USD": {
      "slab": "TBD",
      "feedId": "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"
    }
  },
  
  "oracleService": {
    "pushIntervalMs": 2000,
    "crankIntervalMs": 2000
  },
  
  "botFleet": {
    "totalBots": 30,
    "botsPerMarket": 10,
    "capitalPerBot": 5000000000
  }
}
```
