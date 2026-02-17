# Mainnet Roadmap

**Last updated:** 2026-02-17

---

## Current State

- ✅ Backend rebuild merged to `main` (monolith → 3-service split: api / keeper / indexer)
- ✅ 381 tests passing, CI green
- ✅ Security hardening: CORS, rate limiting, Zod validation, input sanitization, WS auth, Sentry
- ✅ Devnet: 51 markets, 14,500+ cranks, zero failures
- ✅ Insurance LP on-chain instructions implemented (PR submitted)
- ✅ All core on-chain features: force close, risk params, renounce admin, pause/unpause
- ⏳ Insurance LP PR under review
- ❌ Mainnet program not deployed
- ❌ Mainnet crank wallet not configured

---

## Phase 1: Mainnet Program Deployment

**Goal:** Deploy our Percolator program to mainnet so we have full control over slab sizes and features.

**Why not use toly's mainnet program?**
Toly's mainnet program is compiled for 4096-account slabs only (~6.87 SOL/market). We need small/medium tiers for lower-cost markets. Full details in [MAINNET-READINESS.md](./MAINNET-READINESS.md).

**Steps:**
1. Fund deployer wallet (3+ SOL)
2. Build small-tier program: `cargo build-sbf --features small`
3. Deploy to mainnet: `solana program deploy target/deploy/percolator.so --url mainnet-beta`
4. Record program ID, update `config.ts`
5. Verify vAMM matcher compatibility
6. Create first mainnet test market

**Estimated cost:** ~1.6 SOL one-time program deploy + 0.44 SOL per market (small tier)

---

## Phase 2: Insurance LP Launch

**Goal:** Ship Toly's vision — SPL claim tokens for insurance fund deposits.

**Status:** On-chain instructions already implemented (CreateInsuranceMint, DepositInsuranceLP, WithdrawInsuranceLP). PR submitted.

**Remaining work:**
- [ ] Merge insurance LP PR
- [ ] UI: insurance deposit/withdraw flow in `/trade/[slab]`
- [ ] LP token balance display in portfolio
- [ ] APY display (from indexer InsuranceLPService)

---

## Phase 3: Production Hardening

Checklist before going live with real users:

- [ ] Helius paid plan (public devnet rate-limits at ~51 markets)
- [ ] Mainnet crank wallet funded + keypair secured
- [ ] `CORS_ORIGINS` set to production domains in Railway
- [ ] `WS_AUTH_REQUIRED=true` for production WebSocket
- [ ] Uptime monitoring (Railway alerting or UptimeRobot)
- [ ] Sentry DSN configured on all services
- [ ] Frontend default network switched to mainnet
- [ ] Real Pyth oracle feeds for tokens that have them

---

## Phase 4: Growth Features (Post-Launch)

| Feature | Priority | Notes |
|---------|----------|-------|
| VaR-based LP yield distribution | High | Toly's full insurance vision |
| LP withdrawal cooldown | High | Prevents bank-run on insurance fund |
| Mobile UI | Medium | Responsive trade interface |
| Portfolio analytics (historical PnL) | Medium | Trade history export |
| Token2022 support | Low | Most memecoins are classic SPL |
| LP aggregation / smart router | Low | Multi-LP best execution |

---

## Feature Status vs Toly's Vision

| Feature | Status |
|---------|--------|
| Variable slab sizes | ✅ |
| Backend crank (Railway) | ✅ |
| Liquidation scanner | ✅ |
| WebSocket price streaming | ✅ |
| Market discovery (multi-program) | ✅ |
| AdminForceClose | ✅ |
| SetRiskThreshold | ✅ |
| RenounceAdmin | ✅ |
| PauseMarket / UnpauseMarket | ✅ |
| InsuranceMint (on-chain) | ✅ |
| DepositInsuranceLP / WithdrawInsuranceLP | ✅ |
| InsuranceLP UI + indexing | ⏳ |
| VaR-based yield distribution | ❌ |
| LP withdrawal cooldown | ❌ |
| Mainnet deployment | ❌ |
