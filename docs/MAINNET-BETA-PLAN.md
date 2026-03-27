# Mainnet Beta Launch Plan

**Target:** mainnet.percolatorlaunch.com
**Oracle:** HYPERP (on-chain DEX pool reads, EMA-smoothed)
**Infrastructure:** Separate Railway environment (mainnet)
**Status:** Code ready, 5-day sprint to wire + deploy

---

## Architecture

```
mainnet.percolatorlaunch.com
  ├── Frontend (Vercel) — NEXT_PUBLIC_DEFAULT_NETWORK=mainnet
  ├── API (Railway mainnet env) — percolator-api
  ├── Keeper (Railway mainnet env) — percolator-keeper (HYPERP mode)
  ├── Indexer (Railway mainnet env) — percolator-indexer
  └── Supabase (mainnet project or schema)

Existing devnet stays untouched:
  percolatorlaunch.com → devnet (current)
  mainnet.percolatorlaunch.com → mainnet (new)
```

---

## Infrastructure Setup

### 1. Railway — New Mainnet Environment

Create a separate Railway environment (not project — same project, new env) for each service:

| Service | Repo | Railway Env |
|---------|------|-------------|
| API | dcccrypto/percolator-api | `mainnet` |
| Keeper | dcccrypto/percolator-keeper | `mainnet` |
| Indexer | dcccrypto/percolator-indexer | `mainnet` |

**Environment variables (mainnet):**
```env
# Network
NETWORK=mainnet
SOLANA_RPC_URL=<Helius mainnet RPC>
HELIUS_API_KEY=<mainnet key>

# Program IDs
PROGRAM_ID=GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24
# MATCHER_PROGRAM_ID= (not deployed yet)

# Keeper-specific
CRANK_KEYPAIR=<mainnet keeper keypair (funded with SOL)>
CRANK_INTERVAL_MS=10000
ORACLE_MODE=hyperp

# Supabase
SUPABASE_URL=<mainnet project URL>
SUPABASE_SERVICE_KEY=<mainnet service key>

# Sentry
SENTRY_DSN=<mainnet DSN>
```

### 2. Vercel — Mainnet Frontend

| Domain | Branch/Env | Network |
|--------|-----------|---------|
| percolatorlaunch.com | main / production | devnet |
| mainnet.percolatorlaunch.com | main / preview (mainnet env) | mainnet |

**Vercel environment variables (mainnet preview):**
```env
NEXT_PUBLIC_DEFAULT_NETWORK=mainnet
NEXT_PUBLIC_HELIUS_RPC_URL=<Helius mainnet RPC>
NEXT_PUBLIC_API_URL=<Railway mainnet API URL>
NEXT_PUBLIC_WS_URL=<Railway mainnet WS URL>
```

### 3. Supabase — Mainnet Schema

Option A: New Supabase project for mainnet (cleaner isolation)
Option B: Same project, `mainnet_` prefixed tables

**Recommended: Option A** — separate project. Avoids cross-contamination with devnet data.

Run all migrations from `supabase/migrations/` against the new project.

### 4. Keeper Wallet

- Generate new keypair for mainnet keeper
- Fund with ~10 SOL (covers weeks of crank fees at ~0.5 SOL/day for initial markets)
- Store encrypted in Railway env var (CRANK_KEYPAIR)
- This keypair does NOT need to be oracle authority for HYPERP markets (permissionless cranks)

---

## 5-Day Sprint

### Day 1: Keeper HYPERP Wiring
- Wire `encodeUpdateHyperpMark()` into keeper crank service
- Keeper detects oracle mode per market and calls correct instruction
- Pass pool accounts (Raydium/PumpSwap/Meteora) from on-chain config
- Unit tests for HYPERP crank path
- **Owner:** coder
- **PR to:** dcccrypto/percolator-keeper

### Day 2: Market Creation + Frontend Mainnet Mode
- Update create market wizard for HYPERP defaults
- Auto-detect token decimals from mint metadata
- Pool liquidity validation (≥$2M) at creation time
- Frontend mainnet env config (API URL, RPC, network flag)
- Hide devnet faucet when NETWORK=mainnet
- **Owner:** coder
- **PR to:** dcccrypto/percolator-launch

### Day 3: Safety Nets
- Stale mark auto-pause: block trades if last UpdateHyperpMark > N slots ago
- SetPoolSource admin instruction (pool migration support)
- Mainnet keeper monitoring dashboard (crank success rate, latency, cost)
- **Owner:** coder (on-chain: anchor agent)
- **PR to:** dcccrypto/percolator-prog, dcccrypto/percolator-keeper

### Day 4: Infrastructure + Integration Test
- Railway mainnet environment setup (API, keeper, indexer)
- Supabase mainnet project + migrations
- Vercel mainnet.percolatorlaunch.com domain config
- End-to-end test: create market → crank → trade → liquidate on devnet with HYPERP
- Keeper wallet funded
- **Owner:** devops + coder

### Day 5: Deploy + First Markets
- Build program: `cargo build-sbf --features mainnet`
- Deploy via Squads multisig (or single deploy key initially)
- Create first 3 markets:
  - SOL/USDC (Raydium CLMM pool, ~$500M liquidity)
  - BTC/USDC (wBTC Raydium pool, ~$50M liquidity)
  - ETH/USDC (wETH Raydium pool, ~$50M liquidity)
- Verify Phase 1 caps active ($10K OI, 2x leverage)
- Keeper cranking confirmed
- Frontend live at mainnet.percolatorlaunch.com
- **Owner:** coder + devops + Khubair (deploy authority)

---

## Launch Configuration

### Phase 1 (Week 1) — Guarded Launch
- All markets start in Phase 1: **$10K OI cap, 2x max leverage**
- Open to public — anyone can trade
- Market creation requires $2M+ pool liquidity
- Monitor: crank success rate, oracle deviation, funding rates, liquidations

### Phase 2 (Week 2) — Scaling Up
- Markets auto-advance to Phase 2 after time/volume thresholds:
  - Path A: 72 hours elapsed
  - Path B: 4 hours + $100K cumulative volume
- Phase 2: **$100K OI cap, 5x max leverage**
- Ship OI imbalance hard block + per-wallet position cap
- Add more markets based on demand

### Phase 3 (Week 3+) — Full Operation
- Markets reaching 14 days or mature oracle → Phase 3 (full configured caps)
- Add Pyth as optional cross-check oracle
- Scale keeper infrastructure based on market count

---

## Security Checklist

- [ ] Program built with `--features mainnet` (compile-time gates verified)
- [ ] `devnet` and `unsafe_close` features disabled (compile error if enabled)
- [ ] Oracle staleness + confidence checks enabled (mainnet build)
- [ ] Keeper keypair is NOT the program upgrade authority
- [ ] Program upgrade authority → Squads multisig (or Khubair-only initially)
- [ ] CRANK_KEYPAIR not committed to any repo
- [ ] Railway env vars set, not in code
- [ ] Supabase RLS policies on mainnet tables
- [ ] Rate limiting on mainnet API
- [ ] IP blocklist active on mainnet API
- [ ] Frontend shows mainnet warnings (real money, not devnet)
- [ ] Faucet/airdrop endpoints disabled on mainnet

---

## Rollback Plan

If critical issue found:
1. **Pause all markets** — admin instruction exists per-market
2. **Keeper stop** — Railway service pause (instant)
3. **Frontend fallback** — point mainnet.percolatorlaunch.com to maintenance page
4. **Program freeze** — set upgrade authority to null (permanent, last resort)

---

## Cost Estimates

| Item | Monthly Cost |
|------|-------------|
| Railway (3 services, mainnet env) | ~$20-50 |
| Helius mainnet RPC (Growth plan) | ~$50-100 |
| Keeper SOL (crank fees, ~10 markets) | ~$50-100/month |
| Keeper SOL (100+ markets) | ~$500-2000/month |
| Supabase (Pro plan) | ~$25 |
| Vercel (Pro plan, already have) | $0 incremental |
| **Total (launch)** | **~$150-275/month** |
| **Total (scaled, 100+ markets)** | **~$600-2200/month** |

---

## Success Metrics (Week 1)

- [ ] 3+ markets live and crankable
- [ ] ≤100ms crank latency
- [ ] 0 missed cranks in 24h
- [ ] ≤10 bps oracle deviation on SOL/USDC
- [ ] At least 1 external trade
- [ ] No security incidents
