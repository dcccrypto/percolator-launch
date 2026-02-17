# Mainnet Readiness

**Last updated:** 2026-02-17

---

## Backend Infrastructure ✅ DONE

The backend rebuild (monolith → 3-service split) is merged to `main`:

- ✅ `packages/api` — Hono REST API + WebSocket, read-only, stateless
- ✅ `packages/keeper` — CrankService, OracleService, LiquidationService
- ✅ `packages/indexer` — MarketDiscovery, StatsCollector, TradeIndexer, InsuranceLPService, HeliusWebhookManager
- ✅ `packages/shared` — shared config, DB, queries, events, retry, logger, validation, sentry
- ✅ 381 tests passing across all packages
- ✅ CI: unit, integration, e2e, security, type check, coverage gate
- ✅ Sentry on all services (frontend + backend)
- ✅ Security hardening: CORS, rate limiting, Zod validation, input sanitization, WS auth, security headers
- ✅ Devnet: 51 markets, 14,500+ cranks, zero failures

---

## On-Chain Program

### Current State

| Feature | Status |
|---------|--------|
| Core trading (init/deposit/withdraw/trade/liquidate/crank) | ✅ |
| Admin oracle (PushOraclePrice) | ✅ |
| DEX oracle (PumpSwap, Raydium CLMM, Meteora DLMM) | ✅ |
| AdminForceClose (tag 14) | ✅ |
| SetRiskThreshold (tag 15) | ✅ |
| RenounceAdmin (tag 23) | ✅ |
| CreateInsuranceMint (tag 24) | ✅ |
| DepositInsuranceLP (tag 25) | ✅ |
| WithdrawInsuranceLP (tag 26) | ✅ |
| PauseMarket / UnpauseMarket (tags 27/28) | ✅ |
| Variable slab sizes (small/medium/large) | ✅ |
| Insurance LP PR | ⏳ PR submitted |

### Deployed Programs (Devnet)

| Tier | Max Accounts | Program ID |
|------|-------------|------------|
| Small | 256 | `FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD` |
| Medium | 1024 | `FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn` |
| Large | 4096 | `g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in` |

Matcher (vAMM): `4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy`

**Mainnet (Toly's):**
- Program: `GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24` (large slab only, ~6.87 SOL/market)
- Matcher: `DHP6DtwXP1yJsz8YzfoeigRFPB979gzmumkmCxDLSkUX`

Toly's mainnet program supports large slabs only. Deploying our own program is required for smaller slab tiers. See [MAINNET-ROADMAP.md](./MAINNET-ROADMAP.md) for deployment plan.

---

## Remaining Blockers

### Critical

| # | Item | Status |
|---|------|--------|
| 1 | Deploy our program to mainnet (for small/medium slabs) | ❌ Not done |
| 2 | Fund + configure mainnet crank wallet | ❌ Not done |
| 3 | Verify admin oracle / DEX oracle work with toly's mainnet program | ❌ Needs testing |

### High Priority

| # | Item | Status |
|---|------|--------|
| 4 | Helius paid plan for mainnet RPC | ❌ |
| 5 | Verify toly's vAMM matcher is CPI-compatible with our program | ❌ |
| 6 | Switch frontend default network to mainnet | ❌ |

### Medium Priority

| # | Item | Status |
|---|------|--------|
| 7 | Real Pyth oracle feeds (for tokens with Pyth support) | ❌ |
| 8 | Uptime monitoring + alerting | ❌ |
| 9 | Production crank wallet SOL top-up automation | ❌ |

---

## Mainnet Launch Checklist

### Phase 1: Program Deployment
- [ ] Fund deployer wallet with 3+ SOL
- [ ] Deploy small-tier program to mainnet (recommended: 256 accounts, ~0.44 SOL/market)
- [ ] Record new mainnet program ID
- [ ] Verify matcher compatibility or deploy own matcher
- [ ] Update config with mainnet program ID

### Phase 2: Infrastructure
- [ ] Generate fresh crank wallet keypair
- [ ] Fund crank wallet (0.5+ SOL)
- [ ] Configure `CRANK_KEYPAIR` in Railway keeper service
- [ ] Configure `CORS_ORIGINS` with production domain
- [ ] Switch `NEXT_PUBLIC_NETWORK=mainnet-beta` in Vercel
- [ ] Sentry DSN configured for all services

### Phase 3: Test on Mainnet
- [ ] Create test market (small slab, any token with DEX pool)
- [ ] Test full flow: InitMarket → InitLP → InitUser → Deposit → Trade → Withdraw
- [ ] Test crank running
- [ ] Test admin oracle price push
- [ ] Verify frontend discovers and displays mainnet market

### Phase 4: Launch
- [ ] Create first production market
- [ ] Monitor: crank health, oracle freshness, insurance fund
- [ ] Announce on X / community

---

## Slab Cost Reference

| Tier | MAX_ACCOUNTS | Slab Size | Rent |
|------|-------------|-----------|------|
| Small | 256 | ~62 KB | ~0.44 SOL |
| Medium | 1024 | ~249 KB | ~1.73 SOL |
| Large | 4096 | ~993 KB | ~6.87 SOL |

**Recommendation:** Launch with Small tier. Low rent cost, 256 trader slots per market — enough for early traction.
