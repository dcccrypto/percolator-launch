# Percolator Launch — Backend Architecture Audit & Plan

*Created: 2026-02-08 by Cobra*

---

## 1. Current State Comparison: Us vs MidTermDev

### What MidTermDev Has (That We Already Ported)
| Component | MidTermDev | Us | Status |
|-----------|-----------|-----|--------|
| DEX Oracle (TS) | `src/solana/dex-oracle.ts` — PumpSwap, Raydium CLMM, Meteora DLMM | `packages/core/src/solana/dex-oracle.ts` — same 3 DEXes + bug fixes | ✅ Better (precision fix, bounds checking, mint validation) |
| Slab Parser | `src/solana/slab.ts` — header, config, engine, accounts | `packages/core/src/solana/slab.ts` — same + haircut fields, LP aggregates | ✅ Better (newer layout with O(1) haircut ratio) |
| CLI Commands | 30+ commands (init-market, deposit, trade, crank, etc.) | Separate `percolator-app` repo with same commands | ✅ Equivalent |
| Create Market Wizard | `app/components/create/CreateMarketWizard.tsx` | Same component ported | ✅ Equivalent |
| Trade Components | `app/components/trade/` (7 components) | Same + enhanced (leverage slider, ROE, USD PnL) | ✅ Better |
| Market Browser | `app/components/market/` (5 components) | Same + search/sort/activity feed | ✅ Better |
| Crank Bot Scripts | `scripts/crank-bot.ts`, `scripts/mainnet-crank-bot.ts` | `scripts/auto-crank-service.ts` + API routes | ✅ Better (API-driven + standalone) |
| Test Harness | `tests/harness.ts` (22 test suites, devnet integration) | `packages/core/test/` (unit tests only) | ❌ They're better here |
| Audit Scripts | 20+ pentest/stress/adversarial scripts | None | ❌ Missing entirely |
| DEX Oracle (Rust) | `program/src/percolator.rs` with DEX oracle integration | Ported but build blocked | ⏳ Blocked |

### What MidTermDev Does NOT Have (We Do)
| Component | Details |
|-----------|---------|
| Supabase Market Registry | DB-backed market tracking with stats, trades, prices |
| API Routes | REST endpoints for markets, crank, stats |
| Indexer Service | Railway-deployed, backfills from on-chain |
| Keeper Bot Service | Multi-market with dry-run support |
| Oracle Pusher Service | Jupiter-powered price pushing |
| Network Toggle | Mainnet/devnet switch in UI |
| Portfolio View | Multi-market position aggregation |
| My Markets Dashboard | Admin view with crank health |
| Toast System | User notification layer |
| Quick Launch Hook | Auto-detect pool, suggest parameters |
| DEX Pool Search | DexScreener integration for pool discovery |

### What Neither Of Us Has (And We Need)
| Component | Why It Matters |
|-----------|---------------|
| WebSocket Price Streaming | Polling is slow, inconsistent, rate-limited |
| Event Bus / Pub-Sub | Services are disconnected islands |
| Market Lifecycle Manager | The "pump.fun" zero-friction experience |
| Trade Execution Engine | Simulate → retry → confirm pipeline |
| Risk Monitoring Dashboard | Real-time health, insurance fund, funding anomalies |
| Integration Test Suite | MidTermDev has one, but on their devnet — we need our own |
| Helius Webhooks | Real-time tx indexing instead of polling |
| Priority Fee Estimation | Dynamic fees based on network congestion |

---

## 2. What MidTermDev Does Better (Honest Assessment)

### A. Integration Test Suite (CRITICAL GAP)
MidTermDev has a **comprehensive devnet test harness** (`tests/harness.ts`, 600+ lines) with:
- 22 test suites covering: market boot, user lifecycle, capital, trading, oracle, liquidation, socialization, crank, determinism, adversarial, inverted markets, CPI trading, withdrawal, funding, risk reduction, edge cases, Pyth live prices, Chainlink, live trading, devnet stress
- Fresh market creation per test (isolation)
- Slot control and waiting
- State snapshots for determinism checks
- Automatic slab cleanup after tests
- CU measurement per operation

**We have:** Unit tests for the `@percolator/core` package (format, health, encode, PDA, slab, validation) — 22 tests total. No integration tests against devnet at all.

### B. Audit/Security Scripts
MidTermDev has 20+ adversarial scripts:
- `audit-adversarial.ts` — general adversarial testing
- `audit-deep-redteam.ts` — deep security probing
- `audit-funding-warmup.ts` — funding rate manipulation testing
- `audit-oracle-edge.ts` — oracle edge cases
- `audit-timing-attacks.ts` — timing attack vectors
- `bug-fee-debt-trap.ts` — fee-related exploit testing
- `bug-margin-initial-vs-maintenance.ts` — margin system bugs
- `bug-oracle-no-bounds.ts` — oracle bounds testing
- `bug-recovery-overhaircut.ts` — haircut recovery bugs
- `oracle-authority-stress.ts` — oracle authority edge cases
- `pentest-oracle.ts` — oracle penetration testing
- `stress-corner-cases.ts`, `stress-haircut-system.ts`, `stress-worst-case.ts`

**We have:** The DEX oracle bug fixes we found auditing their code, but no systematic testing scripts.

### C. Market Setup Scripts
They have scripted end-to-end market creation:
- `setup-devnet-market.ts` — creates a complete devnet market
- `setup-mainnet-sov.ts` — mainnet deployment script
- `complete-setup.ts` — full setup automation
- `create-market.ts` / `create-slab.ts` — modular creation

**We have:** `scripts/create-market.ts` and the CreateMarketWizard UI, but no scripted end-to-end flow.

---

## 3. Our Technical Advantages

### A. DEX Oracle Bug Fixes
We found and fixed 4 bugs in MidTermDev's DEX oracle code:

1. **CRITICAL — Raydium CLMM Precision Loss**
   - Their code: `sqrtHi = sqrt_price_x64 >> 64n` → returns 0 for micro-priced tokens (most memecoins!)
   - Our fix: Scale by 1e6 BEFORE right-shifting: `scaledSqrt = sqrtPriceX64 * 1_000_000n; term = scaledSqrt >> 64n`
   - Impact: Their oracle literally returns price=0 for any token where `sqrtPriceX64 < 2^64`

2. **MEDIUM — PumpSwap No Mint Validation**
   - They define `BASE_MINT`/`QUOTE_MINT` offsets but never use them
   - Our code adds bounds checking on all vault data

3. **MEDIUM — No Bounds Checking (TS)**
   - Their parser functions don't check `data.length` before slicing
   - We added minimum length constants and explicit throws for all 3 DEX types

4. **Documentation — Flash Loan Vulnerability**
   - Neither codebase protects against single-tx manipulation of DEX prices
   - We documented this clearly in JSDoc comments

### B. Architecture (Supabase + Services + API)
They have ZERO backend infrastructure. No database, no API, no services. Just a frontend and scripts.
We have a full backend stack (Supabase, Railway indexer, API routes, keeper, oracle).

### C. Newer On-Chain Layout
Our slab parser handles the haircut-ratio refactor (O(1) aggregates: `c_tot`, `pnl_pos_tot`, LP aggregates) which replaced the older ADL/socialization system. This matches toly's latest spec v7.

---

## 4. Architecture Plan: What To Build

### Phase 1: Foundation (NOW)
**Goal:** Solid backend that won't break, proper testing, GitHub Actions for Rust build.

#### 1a. GitHub Actions CI for Custom Rust Build
- Workflow that compiles `program/` and `matcher/` with SBF target
- Test with MAX_ACCOUNTS=64 (small slab) and MAX_ACCOUNTS=4096 (full)
- Upload `.so` binaries as artifacts
- Unblocks: smaller slabs, DEX oracle on-chain, custom features

#### 1b. Integration Test Suite (Port from MidTermDev)
Port their test harness adapted to our codebase:
- `tests/harness.ts` — adapted to use our `@percolator/core` package
- Core test suites: market boot, user lifecycle, trading, liquidation, crank
- Run against devnet with our program ID
- Add to CI pipeline

#### 1c. Backend Service (`packages/server`)
Proper standalone server (Hono on Railway):
```
packages/server/
  src/
    index.ts          — Hono app entry
    config.ts         — env vars, program IDs, RPC URLs
    services/
      crank.ts        — multi-market crank loop
      oracle.ts       — price pusher (Jupiter + DexScreener fallback)  
      indexer.ts      — Helius webhook receiver + backfill
      lifecycle.ts    — market creation orchestrator
    routes/
      markets.ts      — CRUD + stats
      prices.ts       — current prices, history
      crank.ts        — crank status, trigger
      launch.ts       — one-click market launch
      ws.ts           — WebSocket price streaming
    db/
      supabase.ts     — typed Supabase client
      queries.ts      — common queries
    utils/
      solana.ts       — connection, keypair loading
      priority-fee.ts — Helius priority fee estimation
      retry.ts        — tx retry with backoff
```

### Phase 2: Market Lifecycle Manager
**Goal:** Paste a token mint → market is live in 30 seconds.

Flow:
1. `POST /api/launch` with `{ mint, collateralMint?, leverage? }`
2. Server: fetch token metadata (Jupiter API)
3. Server: find best DEX pool (DexScreener)
4. Server: determine optimal parameters based on liquidity tier
5. Server: build InitMarket tx (server keypair pays slab rent)
6. Server: submit tx, wait for confirmation
7. Server: register market in Supabase
8. Server: add to oracle rotation + crank rotation
9. Server: emit `market.created` event
10. Return: `{ slabAddress, txSignature, marketUrl }`

**Fee model:** Platform takes X% of trading fees from markets it creates. Creator gets admin rights (can update config, push oracle, close market).

### Phase 3: Real-Time Price Engine
**Goal:** Sub-second price updates to all clients.

Architecture:
- Server subscribes to DEX pool accounts via Helius `accountSubscribe`
- On account change: recompute price using our `computeDexSpotPriceE6`
- Broadcast via WebSocket to all connected clients
- Same price feeds the oracle pusher (no extra API call)
- Fallback: Jupiter API polling every 10s if WebSocket drops

### Phase 4: Trade Execution Engine
**Goal:** Reliable trade execution with retry and confirmation.

Pipeline:
1. **Validate:** Check margin requirements client-side
2. **Simulate:** `simulateTransaction` to catch errors before sending
3. **Fee estimate:** Query Helius priority fee API for optimal CU price
4. **Submit:** `sendTransaction` with priority fee
5. **Confirm:** Subscribe to tx via WebSocket, timeout after 30s
6. **Retry:** If dropped, rebuild with higher priority fee (up to 3 attempts)
7. **Record:** Log trade in Supabase, update market stats

### Phase 5: Risk Monitoring
**Goal:** Know when things are going wrong before they explode.

Components:
- Real-time insurance fund tracking (alert if < X% of OI)
- Funding rate anomaly detection (alert if > 100bps/slot)
- Oracle circuit breaker (pause if price moves > 20% in one update)
- Market health dashboard (admin-only page)
- Liquidation cascade detection (alert if > 3 liquidations in 1 minute)

---

## 5. File Structure After Changes

```
percolator-launch/
  app/                    — Next.js frontend (existing)
  packages/
    core/                 — Shared SDK (existing)
    server/               — NEW: Backend service
  services/
    keeper/               — Existing (to be merged into packages/server)
    oracle/               — Existing (to be merged into packages/server)
  scripts/                — Existing utility scripts
  tests/                  — NEW: Integration test suite
  program/                — Rust on-chain program (existing)
  .github/
    workflows/
      build-program.yml   — NEW: Rust build CI
      test.yml            — NEW: Integration test CI
  docs/
    BACKEND-ARCHITECTURE.md  — This document
```

---

## 6. Slab Size & Custom Program

### Current Constraint
The deployed programs (toly's mainnet `GM8z...` and devnet `EXsr...`, `2SSn...`) have `MAX_ACCOUNTS = 4096` hardcoded. This means:
- Slab size: 992,560 bytes (fixed)
- Rent: ~6.85 SOL (~$924)
- Cannot create smaller slabs

### Custom Program Solution
The Rust source uses a Cargo feature flag:
```rust
#[cfg(feature = "test")]
const MAX_ACCOUNTS: usize = 64;

#[cfg(not(feature = "test"))]
const MAX_ACCOUNTS: usize = 4096;
```

We can compile with different `MAX_ACCOUNTS` values:
| MAX_ACCOUNTS | Slab Size | Rent (SOL) | Rent (USD) | Use Case |
|-------------|-----------|------------|------------|----------|
| 64 | ~25K | ~0.17 | ~$23 | Micro markets, testing |
| 256 | ~80K | ~0.55 | ~$74 | Small markets |
| 1024 | ~270K | ~1.86 | ~$251 | Medium markets |
| 4096 | ~993K | ~6.85 | ~$924 | Full markets |

### Blocker
`cargo-build-sbf` ships with cargo 1.79, but the `blake3` dependency (via percolator risk engine crate) requires edition2024 which needs cargo 1.85+.

### Solutions (in order of effort)
1. **GitHub Actions** — use a newer Rust toolchain in CI, build there
2. **Pin blake3 to older version** — `blake3 = "=1.5.0"` (pre-edition2024)
3. **Build on Mac** — Khubair's Mac may have newer toolchain
4. **Docker** — custom container with newer Rust + SBF target

---

## 7. Risk Assessment

### What Could Break
| Action | Risk | Mitigation |
|--------|------|------------|
| Adding packages/server | None — new package, doesn't touch existing code | — |
| Moving services/keeper into server | Low — keeper currently not deployed in production | Keep standalone scripts as fallback |
| Adding GitHub Actions | None — new files, CI-only | — |
| Porting test harness | None — test files only | — |
| Modifying API routes | Medium — frontend depends on them | Don't change existing route signatures, only add new ones |
| Custom program deploy | High — different slab size = different program ID | Deploy alongside existing, don't replace |

### Safety Rules
1. **Never modify existing API route signatures** — add new routes instead
2. **Never change program IDs in config** — add new IDs alongside existing
3. **Test on devnet before mainnet** — always
4. **Feature branch everything** — `cobra/backend/*` branches
5. **Run existing tests before pushing** — `pnpm test` must pass

---

*This is a living document. Update as we build.*
