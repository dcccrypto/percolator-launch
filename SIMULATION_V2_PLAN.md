# Percolator Risk Engine Simulator v2 — Full Plan

**Status:** Planning
**Author:** Cobra
**Date:** 2026-02-17

---

## 1. Why This Exists

The risk engine is Percolator's competitive edge. But nobody can SEE it working unless they're actively trading. The simulator lets anyone — Toly, hackathon judges, traders, investors — watch the engine handle stress, liquidations, funding rates, and haircuts in real-time with real on-chain transactions.

**v1 failed** because it tried to do everything at once with buggy bot infrastructure and silent failures. v2 is designed for reliability first, features second.

---

## 2. What It Does

A **shared, always-on simulation world** running on Solana devnet where:
- **30 bots** trade across **3 markets** (SOL/USD, BTC/USD, ETH/USD) 24/7
- **Users connect wallets** and trade alongside bots
- **Anyone can trigger scenarios** (crash, squeeze, black swan) that affect the shared world
- **The risk engine's behavior is narrated** in real-time with explanations
- **A leaderboard** tracks PnL, best trades, and risk-adjusted returns
- **Guided walkthroughs** teach non-experts what's happening

---

## 3. Architecture

### 3.1 Markets (3 Slabs)

Each market is a separate slab on devnet with the **admin oracle** pattern:

| Market | Oracle Source | Collateral |
|--------|-------------|------------|
| SOL/USD | Real Pyth SOL/USD + scenario overlay | Wrapped SOL |
| BTC/USD | Real Pyth BTC/USD + scenario overlay | Wrapped SOL |
| ETH/USD | Real Pyth ETH/USD + scenario overlay | Wrapped SOL |

All 3 markets use **Wrapped SOL** as collateral (simplifies onboarding — users only need devnet SOL).

**Oracle approach:** Each market uses `setOracleAuthority` to set our simulation service as the oracle authority. The service:
1. Fetches real Pyth prices every 2 seconds via Hermes API
2. Applies any active scenario overlay (e.g., -40% crash)
3. Pushes the modified price via `pushOraclePrice` instruction
4. Price cap (`setOraclePriceCap`) limits max change per update to prevent instant jumps — scenarios play out over time

### 3.2 SOL Budget & Sustainability

**Transaction costs (all devnet):**
- Base fee: 0.000005 SOL per transaction (5000 lamports)
- No priority fees needed on devnet
- Account creation (init-user): ~0.001 SOL rent

**Daily SOL consumption estimate:**

| Component | Txs/day | SOL/day |
|-----------|---------|---------|
| Oracle updates (3 markets × 30/min) | 129,600 | 0.65 |
| Bot trades (30 bots × ~50 trades/day) | 1,500 | 0.0075 |
| Keeper cranks (3 markets × 2/min) | 8,640 | 0.043 |
| User onboarding (est. 20 users/day) | 60 | 0.0003 |
| User trades (est. 200/day) | 200 | 0.001 |
| **Total** | **~140,000** | **~0.70 SOL/day** |

**Faucet strategy:**
- Devnet faucet: **2 SOL per request, max 2 requests per 8 hours** per IP/wallet
- That's 12 SOL/day from a single source
- We need **~1 SOL/day** for infrastructure → well within limits
- Alternative faucets: DevnetFaucet.org (separate rate limits)
- **Pre-accumulation:** Farm 50+ SOL before launch (4-5 days of daily airdrops to multiple wallets)

**Treasury design:**
- One master treasury wallet holds the SOL pool
- Bot wallets funded from treasury
- Users get **0.1 SOL airdropped** when they join (enough for ~20,000 transactions)
- Users' trading capital is Wrapped SOL they create from their airdropped SOL
- If a user runs out, they can request another 0.1 SOL (rate limited to 1 per 8 hours)

### 3.3 Service Architecture

```
┌─────────────────────────────────────────────┐
│               Railway Service                │
│  "percolator-simulation"                     │
│                                              │
│  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Oracle Engine │  │ Bot Fleet Manager    │  │
│  │ - Pyth fetch  │  │ - 30 bot wallets     │  │
│  │ - Scenario    │  │ - Trading strategies │  │
│  │   overlay     │  │ - Scenario reactions │  │
│  │ - Price push  │  │ - Risk management    │  │
│  └──────────────┘  └──────────────────────┘  │
│                                              │
│  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Crank Service │  │ Event Logger         │  │
│  │ - 3 markets   │  │ - Liquidation events │  │
│  │ - Every 30s   │  │ - Funding accruals   │  │
│  │ - Sweep cycle │  │ - Scenario triggers  │  │
│  └──────────────┘  │ - Broadcast via WS    │  │
│                     └──────────────────────┘  │
└─────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────┐
│          Next.js Frontend (Vercel)            │
│                                              │
│  /simulate                                   │
│  ├── Dashboard (shared world overview)       │
│  ├── Trade Panel (user places trades)        │
│  ├── Scenario Control (trigger events)       │
│  ├── Risk Engine Narration (live feed)       │
│  ├── Leaderboard (PnL ranking)              │
│  └── Guided Walkthrough (tutorial overlay)   │
└─────────────────────────────────────────────┘
```

**Single Railway service** (not 3 separate ones — v1's mistake was too many services). One process handles:
- Oracle price pushing (3 markets)
- Bot fleet management
- Keeper cranking
- Event logging + WebSocket broadcast

### 3.4 Database (Supabase)

```sql
-- Simulation-specific tables (separate from production)
CREATE TABLE sim_scenarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT NOT NULL, -- 'crash', 'squeeze', 'blackswan', 'volatile', 'custom'
  params JSONB NOT NULL, -- { targetPrice: -0.4, durationSec: 120, market: 'SOL/USD' }
  triggered_by TEXT, -- wallet address
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  status TEXT DEFAULT 'pending' -- pending, active, completed
);

CREATE TABLE sim_events (
  id BIGSERIAL PRIMARY KEY,
  market TEXT NOT NULL,
  event_type TEXT NOT NULL, -- 'liquidation', 'funding', 'haircut', 'adl_prevented', 'insurance_draw', 'scenario_start', 'scenario_end', 'trade'
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE sim_leaderboard (
  wallet TEXT PRIMARY KEY,
  display_name TEXT,
  total_pnl BIGINT DEFAULT 0,
  total_trades INT DEFAULT 0,
  win_rate NUMERIC(5,2),
  best_trade BIGINT DEFAULT 0,
  worst_trade BIGINT DEFAULT 0,
  last_trade_at TIMESTAMPTZ,
  joined_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE sim_bot_wallets (
  wallet TEXT PRIMARY KEY,
  bot_type TEXT NOT NULL, -- 'trend_follower', 'mean_reverter', 'market_maker', 'degen'
  market TEXT NOT NULL,
  strategy_config JSONB,
  is_active BOOLEAN DEFAULT true
);
```

---

## 4. Bot Fleet Design

### 4.1 Bot Types (30 total, 10 per market)

| Type | Count/Market | Behavior | Position Size |
|------|-------------|----------|---------------|
| **Trend Follower** | 3 | Follows momentum, enters on breakouts | Medium |
| **Mean Reverter** | 3 | Counter-trades extremes, fades moves | Medium |
| **Market Maker** | 2 | Provides liquidity both sides, tight stops | Small-Medium |
| **Degen** | 2 | High leverage, YOLO entries, panic exits | Large |

### 4.2 Scenario Reactions

When a scenario triggers, bots react realistically:

| Scenario | Trend Follower | Mean Reverter | Market Maker | Degen |
|----------|---------------|---------------|--------------|-------|
| **Crash -40%** | Short immediately | Wait, then buy dip at -30% | Widen spreads, reduce size | Panic close, then FOMO short |
| **Squeeze +80%** | Long on breakout | Short at +50% | Reduce exposure | Max leverage long |
| **Black Swan -60%** | Close all, go short | Stay flat, wait | Stop trading | Get liquidated |
| **High Volatility** | Reduce size, wider stops | Active mean reversion | Tighten spreads for volume | Increase leverage |

### 4.3 Bot Trading Logic

Each bot runs a simple state machine:
1. **Evaluate** — Check current price, position, scenario
2. **Decide** — Should I trade? What direction? What size?
3. **Execute** — Submit transaction via CLI SDK (init-user, deposit, trade-nocpi)
4. **Log** — Record trade in sim_events

Bots don't need to be smart. They need to be **realistic enough to generate interesting risk engine behavior** — liquidations, funding rate swings, insurance fund draws.

---

## 5. Scenario System

### 5.1 Presets

| Scenario | Description | Duration | Effect |
|----------|-------------|----------|--------|
| **Flash Crash** | Price drops 30-50% | 30-120s | Tests liquidation cascade |
| **Short Squeeze** | Price pumps 50-100% | 60-180s | Tests funding rate spike |
| **Black Swan** | Price drops 60%+ instantly | 10-30s | Tests insurance fund + haircuts |
| **Volatile Chop** | ±20% oscillations | 300s | Tests funding payments |
| **Calm Market** | Normal movement ±2% | 600s | Baseline comparison |

### 5.2 Custom Scenarios

Users can configure:
- **Target market** (SOL, BTC, ETH, or all)
- **Price change** (-80% to +200%)
- **Duration** (10s to 600s)
- **Shape** (linear, exponential, step)

### 5.3 Scenario Queue

- Only 1 scenario active at a time
- 60-second cooldown between scenarios
- Any connected user can trigger (no voting — keep it simple)
- Scenario shows who triggered it + countdown timer

---

## 6. Risk Engine Narration

The killer feature. Real-time commentary on what the engine is doing.

### 6.1 Event Feed

A live feed showing events with explanations:

```
⚡ LIQUIDATION — @trader42 long 5000 SOL/USD liquidated at $95.20
   → Maintenance margin (5%) breached at $94.80
   → Insurance fund absorbed $12.50 shortfall
   → 3 other positions now at risk (health < 20%)

📊 FUNDING RATE — SOL/USD funding spiked to 0.08%/hr
   → Longs paying shorts because long OI is 3.2x short OI
   → This incentivizes new shorts and discourages new longs

🛡️ HAIRCUT PREVENTED — Auto-deleveraging NOT triggered
   → Insurance fund covered the liquidation loss
   → Fund balance: 8.2 SOL → 7.9 SOL (96% healthy)

🔄 CRANK — Sweep completed (16/16 steps)
   → Scanned 45 accounts, found 2 below maintenance margin
   → Liquidated 1, warning issued to 1
```

### 6.2 Tooltips & Explanations

Every metric has a tooltip explaining what it means in plain English:
- "**Funding Rate**: The cost of holding a position. When more people are long, longs pay shorts."
- "**Insurance Fund**: Safety net that absorbs losses when liquidated positions can't cover their debt."
- "**Haircut**: Last resort — all profitable traders lose a % to cover system insolvency."

---

## 7. Leaderboard

### 7.1 Metrics

| Metric | Description |
|--------|-------------|
| **Total PnL** | Net profit/loss in SOL |
| **ROI %** | Return on deposited capital |
| **Win Rate** | % of profitable trades |
| **Best Trade** | Largest single profit |
| **Trades** | Total trade count |
| **Survived Scenarios** | How many scenarios they lived through |

### 7.2 Special Awards

- 🏆 **Top Trader** — Highest PnL
- 💀 **Most Liquidated** — Badge of honor for degens
- 🛡️ **Risk Manager** — Best risk-adjusted returns (Sharpe-like)
- 🌊 **Storm Survivor** — Profited during a Black Swan scenario

---

## 8. Frontend Design (`/simulate`)

### 8.1 Layout

```
┌─────────────────────────────────────────────────────┐
│  PERCOLATOR SIMULATION ENGINE          [Connect]     │
├─────────┬───────────────────────────────┬───────────┤
│         │                               │           │
│ Markets │    Real-time Chart            │  Risk     │
│ SOL ●   │    (TradingView lightweight)  │  Engine   │
│ BTC ●   │                               │  Stats    │
│ ETH ●   │                               │           │
│         │                               │  Vault    │
│ Scenario├───────────────────────────────┤  OI       │
│ Control │                               │  Funding  │
│         │    Trade Panel                │  Ins Fund │
│ [Crash] │    [Long] [Short]             │  Liq Ct   │
│ [Squeeze│    Size: [____]               │  Haircuts │
│ [Custom]│    Leverage: [5x]             │           │
│         │                               │  Crank    │
├─────────┴───────────────────────────────┴───────────┤
│  Event Feed (scrolling narration)                    │
│  ⚡ Liquidation... 📊 Funding rate... 🛡️ Insurance... │
├─────────────────────────────────────────────────────┤
│  Leaderboard                                         │
│  #1 @trader42 +2.5 SOL  #2 @bot_mm +1.8 SOL  ...   │
└─────────────────────────────────────────────────────┘
```

### 8.2 Guided Walkthrough

First-time users see an overlay tutorial:
1. "Welcome to the Risk Engine Simulator"
2. "These 3 markets are running with real on-chain transactions"
3. "Connect your wallet to get 0.1 devnet SOL and start trading"
4. "Try triggering a 'Flash Crash' scenario — watch how the engine handles it"
5. "See the Event Feed? That's the risk engine working in real-time"

---

## 9. User Onboarding Flow

1. User visits `/simulate`
2. Sees live simulation running (no wallet needed to watch)
3. Clicks "Connect Wallet"
4. Backend checks if user has a sim account:
   - **New user:** Airdrop 0.1 SOL → auto-wrap → init-user → deposit → ready
   - **Returning user:** Check balance, top up if needed
5. User can trade immediately

**Airdrop rate limiting:**
- 0.1 SOL per new user
- Max 1 airdrop per wallet per 8 hours
- Treasury must maintain 10+ SOL reserve (alert if below)

---

## 10. Implementation Phases

### Phase 1: Foundation (3-4 days)
- [ ] Deploy 3 simulation market slabs on devnet
- [ ] Oracle service: Pyth fetch + push (no scenarios yet)
- [ ] Keeper crank service for 3 markets
- [ ] Basic `/simulate` page: market overview + live prices
- [ ] User onboarding: airdrop + init + deposit

### Phase 2: Bots & Trading (3-4 days)
- [ ] Bot wallet generation + funding
- [ ] 4 bot strategy implementations
- [ ] Trading panel: users can place trades
- [ ] Position display + PnL tracking
- [ ] Real-time chart (TradingView lightweight)

### Phase 3: Scenarios & Narration (2-3 days)
- [ ] Scenario engine: preset triggers
- [ ] Oracle overlay: modify prices based on active scenario
- [ ] Bot scenario reactions
- [ ] Event feed: live narration of engine events
- [ ] Risk engine stats panel (vault, OI, funding, insurance, liquidations)

### Phase 4: Polish (2-3 days)
- [ ] Leaderboard with awards
- [ ] Custom scenario builder
- [ ] Guided walkthrough / tutorial
- [ ] Tooltips and explanations
- [ ] Mobile responsive
- [ ] Error handling + resilience

**Total: ~10-14 days** for full feature

### MVP (Demo-ready): Phases 1 + 2 = ~7 days
- Live markets with bots trading
- Users can trade
- Real-time data
- No scenarios yet, but engine behavior is visible

---

## 11. Infrastructure Costs

| Service | Provider | Cost/mo |
|---------|----------|---------|
| Simulation service | Railway | ~$10-15 |
| Supabase (shared) | Supabase | $0 (existing) |
| Frontend | Vercel | $0 (existing) |
| Devnet SOL | Faucet | $0 |
| **Total** | | **~$10-15/mo** |

---

## 12. Risk & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Devnet instability | Simulation breaks | Auto-retry + status indicator |
| Faucet rate limits | Can't onboard users | Pre-accumulate + multiple faucets |
| Bot transactions fail | Dead-looking sim | Retry logic + fallback strategies |
| Too many users | SOL depleted | Rate limit airdrops, monitor treasury |
| Oracle staleness | Crank rejects trades | Aggressive push frequency (every 2s) |

---

## 13. Success Metrics

1. **Toly sees liquidations cascade correctly** during a crash scenario
2. **Hackathon judges** can connect wallet, trade, trigger scenario in < 2 min
3. **Funding rates** visibly adjust based on long/short imbalance
4. **Insurance fund** absorbs losses and users can see the balance change
5. **Zero haircuts in normal operation** (proves engine health)
6. **Leaderboard** has 10+ entries within first week

---

## 14. What We're NOT Building (Scope Cuts)

- ❌ Per-user isolated simulations (too complex, too expensive)
- ❌ Historical replay (cool but not MVP)
- ❌ Token rewards / real incentives (devnet only)
- ❌ Mobile app (responsive web is enough)
- ❌ Multi-collateral (all SOL-denominated for simplicity)

---

## 15. Open Questions for Khubair

1. **Timeline pressure?** Is this for a specific demo date or general readiness?
2. **Bot names?** Should bots have fun names/avatars on the leaderboard?
3. **Branding?** "Simulation" or something cooler like "War Room" / "Stress Lab" / "The Arena"?
4. **Public vs gated?** Anyone can use it, or require Discord/Twitter auth?
