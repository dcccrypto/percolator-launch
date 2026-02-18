# Simulator Feature — Handoff Document

**Date:** 2026-02-18
**Branch:** `cobra/feat/simulator`
**PR:** #214 (70 files, 14,261 insertions)
**Status:** Deployed on Vercel preview + Railway devnet, all 13/13 CI green

---

## 1. What It Is

A full **Risk Engine Simulator** for Percolator — users trade perpetuals on devnet with simulated USDC, competing on a weekly leaderboard. 15 automated bots provide market activity. Real on-chain trades, real funding rates, real risk engine mechanics.

**Live preview:** https://percolator-launch-git-cobra-feat-7cc7c7-khubair-nasirs-projects.vercel.app/simulate

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    FRONTEND (Vercel)                 │
│  /simulate page — 3-column trading terminal layout  │
│  10 components + reused trade components             │
│  API routes for leaderboard, prices, scenarios       │
└────────────────────┬────────────────────────────────┘
                     │ reads from
┌────────────────────▼────────────────────────────────┐
│              SUPABASE (ygvbajglkrwk...)              │
│  simulation_price_history — oracle price snapshots   │
│  sim_leaderboard — weekly/alltime rankings           │
│  sim_scenarios — scenario voting                     │
│  sim_faucet_claims — rate limiting                   │
└────────────────────▲────────────────────────────────┘
                     │ writes to
┌────────────────────┴────────────────────────────────┐
│           RAILWAY (sim-oracle-bots service)          │
│  sim-service.ts — orchestrator                       │
│  sim-oracle.ts — Pyth price feed + scenario overlay  │
│  sim-bots.ts — 15 bots across 3 markets              │
└────────────────────┬────────────────────────────────┘
                     │ on-chain txs
┌────────────────────▼────────────────────────────────┐
│              SOLANA DEVNET                           │
│  Program: DxoMuuiUy5TymJRwALizxb5X8GwnQB7pUv1x..   │
│  3 slabs (SOL/BTC/ETH), 64 accounts each            │
│  simUSDC mint, deployer wallet                       │
└─────────────────────────────────────────────────────┘
```

---

## 3. On-Chain Deployment

| Asset | Address |
|-------|---------|
| **Sim Program** | `DxoMuuiUy5TymJRwALizxb5X8GwnQB7pUv1x2z3oLjDJ` |
| **simUSDC Mint** | `2ruZ9ESkn7XAx1c94McDv4QKTMcUasADsxsGSJW1LenF` |
| **SOL/USD Slab** | `AtzJQmxUQitYAuGHeCTbupDkEsv5wDH44hv6ZmDJ8ufR` |
| **BTC/USD Slab** | `9U5C3cn5CswQZhbajgJzp4NnQLPksE2w1wuVJEx3wTN3` |
| **ETH/USD Slab** | `FRGYFH1LshhBNrRRJUadugyBoTG21Ujjvv29uKHmWPj` |
| **Deployer** | `DHd11N5JVQmGdMBWf6Mnu1daFGn8j3ChCHwwYAcseD5N` (~0.80 SOL) |

**Market params:** `initialMarginBps=500` (20x max leverage), `maxStalenessSecs=3600`, `newAccountFee=1_000_000` (1 simUSDC), `MAX_ACCOUNTS=64` (small build)

**Important:** The sim program uses the `small` feature flag which produces **unaligned slab layouts** (accountsOff=568, not 576). All slab parsing code must handle both aligned and unaligned variants.

---

## 4. File Structure

### Services (Railway)
```
services/
├── sim-service.ts      — Orchestrator: starts oracle + bots, connects to Supabase
├── sim-oracle.ts       — Pyth Hermes price feed, admin oracle push, scenario multipliers
└── sim-bots.ts         — 15-bot fleet, 3 strategies, leaderboard writes
```

### Frontend
```
app/app/simulate/
├── page.tsx            — Main page: 3-column desktop, tabbed mobile
├── layout.tsx          — SEO metadata
└── components/
    ├── SimulatorHeader.tsx      — Market selector + wallet balance
    ├── SimulatorHero.tsx        — Hero CTA (hidden once engaged)
    ├── SimOnboarding.tsx        — 3-step: connect → faucet → trade
    ├── ScenarioPanel.tsx        — Vote on scenarios (flash-crash, squeeze, etc.)
    ├── SimLeaderboard.tsx       — Weekly/alltime rankings with countdown
    ├── SimRiskDashboard.tsx     — Wraps existing risk components for sim context
    ├── SimExplainer.tsx         — Educational: how perp risk works
    ├── RiskConceptCards.tsx     — Concept cards for key mechanics
    ├── EventFeed.tsx            — Live event feed (placeholder)
    └── GuidedWalkthrough.tsx    — 7-step interactive tour
```

### API Routes
```
app/app/api/
├── simulate/
│   ├── faucet/route.ts             — POST: mint 10k simUSDC per wallet per 24h
│   └── leaderboard/
│       ├── route.ts                — GET: weekly/alltime rankings
│       ├── update/route.ts         — POST: bot writes
│       └── reset/route.ts         — POST: weekly reset
├── scenarios/
│   ├── state/route.ts              — GET: current scenario votes
│   └── vote/route.ts              — POST: cast vote
└── markets/[slab]/
    ├── prices/route.ts             — GET: price history (1000 most recent)
    ├── trades/route.ts             — GET: trade history
    └── route.ts                    — GET: market info
```

### Config & Deploy
```
app/config/sim-markets.json         — Slab addresses + market config
config/sim-bot-wallets.json         — 15 bot keypairs (GITIGNORED, SENSITIVE)
scripts/deploy-sim.ts               — Deploy script (slabs + mint + LP)
.keys/deployer.json                 — Deployer keypair (GITIGNORED, SENSITIVE)
Dockerfile.sim                      — Railway container for oracle+bots
```

### Database (Supabase)
```
supabase/migrations/
├── 023_simulator_tables.sql        — sim_leaderboard, sim_scenarios, sim_faucet_claims
└── 024_sim_price_history.sql       — simulation_price_history
```

### Tests (266 passing)
```
app/__tests__/simulate/
├── components/SimulatePage.test.tsx         — 27 tests (layout, market switching, tabs)
├── api/prices.test.ts                      — 13 tests
├── api/leaderboard.test.ts                 — 12 tests
├── api/scenarios.test.ts                   — 12 tests
└── integration/simulator-flow.test.ts      — 15 tests (candles, positions, config)
```

---

## 5. Bot System

### 15 Bots (5 per market)
| Type | Count | Strategy | Trade Size | Leverage |
|------|-------|----------|------------|----------|
| Trend Follower | 5 | Follow 1-min price momentum (0.5% threshold) | $500-2000 | 4-8x |
| Mean Reverter | 5 | Fade deviations from 1-min average (0.5%) | $500-1500 | 3-6x |
| Market Maker | 5 | Alternate long/short randomly | $300-1000 | 2-4x |

### Bot Lifecycle
1. **Init:** On startup, check slab for existing account → recover state or create new
2. **Trade:** Every 5-15s, evaluate strategy → open position if flat
3. **Hold:** 30s-3 min random hold time
4. **Close:** Send opposite-size trade → calculate PnL → buffer to leaderboard
5. **Flush:** Every 15s, write buffered PnL to Supabase `sim_leaderboard`

### Bot Wallets
Stored in `config/sim-bot-wallets.json` (gitignored). On Railway, the entire JSON is in the `SIM_BOT_WALLETS` env var. Each bot has 0.05 SOL for tx fees.

---

## 6. Oracle System

- **Source:** Pyth Hermes API (`hermes.pyth.network`) for SOL, BTC, ETH
- **Push interval:** Every 2 seconds per market
- **Mode:** Admin oracle (non-zero dummy feedId `"0100..."` to disable hyperp mode)
- **Scenario overlay:** Multiplier applied to Pyth price based on active scenario
- **Price persistence:** Every 30s, batch-writes to `simulation_price_history` table
- **Crank:** Separate transaction after price push (split to prevent atomic rollback)

### Scenario Multipliers
| Scenario | Duration | Effect |
|----------|----------|--------|
| flash-crash | 60s | -30% crash then 70% recovery |
| short-squeeze | 120s | +50% ramp |
| black-swan | 600s | -60% sustained drop |
| high-vol | 300s | ±20% random noise |
| gentle-trend | 1800s | +15% slow climb |

Scenarios activate when they get 3+ votes via `/api/scenarios/vote`.

---

## 7. Supabase Tables

### `sim_leaderboard`
| Column | Type | Notes |
|--------|------|-------|
| wallet | text PK | Solana pubkey |
| display_name | text | Bot name or null |
| total_pnl | bigint | Cumulative PnL in 6-decimal units |
| total_deposited | bigint | Cumulative deposits |
| trade_count | int | Total trades |
| win_count | int | Winning trades |
| liquidation_count | int | Times liquidated |
| best_trade | bigint | Highest single PnL |
| worst_trade | bigint | Lowest single PnL |
| week_start | timestamptz | Monday 00:00 UTC |
| last_trade_at | timestamptz | |
| updated_at | timestamptz | |

**Note:** PnL values are in raw 6-decimal token units. Frontend `fmtPnl()` divides by 1e6 for display.

### `simulation_price_history`
| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| slab_address | text | Market slab pubkey |
| price_e6 | bigint | Price × 10^6 |
| model | text | Always "pyth" |
| timestamp | timestamptz | |

### `sim_scenarios`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| scenario_type | text | flash-crash, short-squeeze, etc. |
| proposed_by | text | Wallet or "anonymous" |
| votes | text[] | Array of voter wallets |
| vote_count | int | |
| status | text | voting / active / completed |

### `sim_faucet_claims`
| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| wallet | text | |
| amount | bigint | Always 10_000_000_000 (10k simUSDC) |
| claimed_at | timestamptz | Rate limit: 1 claim per wallet per 24h |

---

## 8. Environment Variables

### Vercel Preview
| Var | Value | Notes |
|-----|-------|-------|
| `SIM_MINT_AUTHORITY` | Deployer keypair (base58) | For faucet minting |
| `SIM_USDC_MINT` | `2ruZ9ESkn7XAx1c94McDv4QKTMcUasADsxsGSJW1LenF` | |
| `RPC_URL` | Devnet RPC endpoint | |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key | |
| `SUPABASE_SERVICE_ROLE_KEY` | Service key (bypasses RLS) | |

### Railway (sim-oracle-bots)
| Var | Value | Notes |
|-----|-------|-------|
| `RPC_URL` | Devnet RPC endpoint | |
| `ADMIN_KEYPAIR` | Deployer keypair (base58) | Oracle push + LP signing |
| `SIM_BOT_WALLETS` | Full JSON blob | 15 bot keypairs |
| `SUPABASE_URL` | Supabase project URL | |
| `SUPABASE_SERVICE_KEY` | Service role key | |
| `SIM_MARKETS_CONFIG` | JSON with slab addresses | |

---

## 9. Known Issues & Gotchas

### Critical — Must Know
1. **Unaligned slab layout:** Sim program's `small` build doesn't pad `accountsOff` to 16 bytes. Use `detectSlabLayout()` (not just `slabAccountsOffset()`). Offset is 568, not 576. Off-by-8 causes ALL account lookups to fail silently.

2. **RLS on sim tables:** All API routes reading simulator data MUST use `getServiceClient()` (service role key), NOT `getSupabase()` (anon key). Anon key returns empty results due to RLS.

3. **TradeNoCpi requires LP owner co-signing:** Both bot keypair AND admin/deployer must sign every trade transaction. The admin is the LP owner.

4. **Non-zero feedId for admin oracle:** `"0100000000000000..."` disables hyperp mode. All-zeros feedId enables it and bans TradeNoCpi.

5. **Split push and crank transactions:** Oracle push and crank MUST be separate txs. Atomic combo = crank failure rolls back push = permanently stale oracle.

### Operational
6. **Railway restarts lose bot state:** Fixed with recovery code that reads on-chain positions, but each restart causes a brief gap in leaderboard writes.

7. **Deployer SOL:** Currently ~0.80 SOL. Each new user account costs ~0.002 SOL (rent). Monitor via `getBalance`.

8. **Price history grows unbounded:** `simulation_price_history` gets ~3 rows/30s × 3 markets. Consider adding a retention policy or CRON cleanup.

9. **Scenario name format:** Frontend uses kebab-case (`flash-crash`), oracle uses `normalizeScenarioType()` to handle both kebab and underscore formats.

---

## 10. How to Operate

### Redeploy Oracle+Bots
Push to `cobra/feat/simulator` → Railway auto-deploys. Or manually:
```bash
cd percolator-launch
railway up --detach --service sim-oracle-bots
```

### Check Bot Health
```bash
# Are bots transacting?
curl -s https://api.devnet.solana.com -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSignaturesForAddress",
       "params":["G1tUauE1jchYMo9fCcYjz5ebjWbN2kRJwDXhrLoToUeh",{"limit":3}]}'

# On-chain positions (Python one-liner in docs/check-slab.py)
```

### Check Leaderboard
```bash
curl -s 'https://ygvbajglkrwkbjdjyhxi.supabase.co/rest/v1/sim_leaderboard?select=*&order=total_pnl.desc' \
  -H "apikey: <anon_key>" -H "Authorization: Bearer <service_key>"
```

### Reset Weekly Leaderboard
Automatic via `currentWeekStart()` filter (Monday 00:00 UTC). Manual:
```bash
# Delete all rows for current week
curl -X DELETE 'https://ygvbajglkrwkbjdjyhxi.supabase.co/rest/v1/sim_leaderboard?week_start=eq.2026-02-17T00:00:00.000Z' \
  -H "apikey: <anon_key>" -H "Authorization: Bearer <service_key>"
```

### Fund Deployer
```bash
solana airdrop 2 DHd11N5JVQmGdMBWf6Mnu1daFGn8j3ChCHwwYAcseD5N --url devnet
```

### Deploy New Market
```bash
npx tsx scripts/deploy-sim.ts
# Then update app/config/sim-markets.json with new slab addresses
```

---

## 11. Bugs Fixed During E2E Review (Feb 18)

| # | Bug | Root Cause | Fix |
|---|-----|-----------|-----|
| 1 | Bots never traded | Slab accountsOff 576 vs actual 568 (8-byte misalign) | `detectSlabLayout()` tries both aligned and unaligned |
| 2 | Leaderboard always empty | API used anon key (`getSupabase()`), RLS blocked reads | Switched to `getServiceClient()` |
| 3 | Chart showed stale prices | Ascending order + limit 1000 = oldest data | Descending + reverse |
| 4 | Scenarios had no effect | Frontend kebab-case vs oracle underscore | `normalizeScenarioType()` |
| 5 | Bot state lost on restart | In-memory positions gone after Railway redeploy | On-chain recovery via `readPositionSize()` |
| 6 | Account offsets wrong | `ACCT_OWNER_OFF=176` (missing 8-byte account_id) | Corrected to 184 (from core lib) |
| 7 | PnL displayed as millions | Raw 6-decimal values not divided | `fmtPnl()` now divides by 1e6 |
| 8 | Bots too passive | 5-30 min holds, $50-500 sizes, 1-2% thresholds | 30s-3min holds, $300-2000, 0.2-0.5% |

---

## 12. Commit History

```
f4785a0 feat: aggressive bot parameters for active leaderboard
94f2d0d fix: slab layout detection for unaligned small builds
4222b02 fix: leaderboard RLS bypass + prices API fetch most recent data
be1e4e8 fix: bot state recovery, account offsets, scenario names, leaderboard display
d4f819a fix: correct Railway API URL + restore all components
968f994 fix: complete UI overhaul + stub all broken API routes
460f4a2 feat: bot trades populate leaderboard
5b178b0 fix: resolve funding 404s, hydration error, and error display
a897651 feat: persist oracle prices to Supabase for TradingChart
42e345a fix: use afterFiles rewrites so local API routes take priority
4a0d400 test: add page integration tests
d9a068e test: add prices API tests
9c23e99 feat: /api/markets/[slab]/prices endpoint for chart data
21878b0 feat: 3-column trading terminal layout with TradingChart
71c29bd fix: scenarios API schema alignment
... (+ earlier Phase 1-4 commits)
```

---

## 13. What's Next (Post-Merge)

### Immediate
- [ ] Merge PR #214 → production deploy
- [ ] Verify production `/simulate` page works
- [ ] Monitor deployer SOL balance
- [ ] Watch leaderboard populate over 24h

### Short-term
- [ ] Add EventFeed real data source (currently placeholder)
- [ ] Price history retention policy (CRON to trim old rows)
- [ ] Faucet POST integration with wallet adapter (frontend button)
- [ ] User trade history display (not just bot trades)

### Medium-term
- [ ] More bot wallets (30+) for richer leaderboard
- [ ] Liquidation scenarios (bots with high leverage that get liquidated)
- [ ] Insurance fund stress testing UI
- [ ] Mainnet deployment (requires RPC proxy, ~5 SOL)

---

*Written by Cobra 🐍 — Feb 18, 2026*
