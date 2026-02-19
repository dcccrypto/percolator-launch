# Percolator Simulator — Full Investigation Report

**Date:** 2026-02-19  
**Branch:** `cobra/feat/simulator`  
**Investigator:** Cobra (automated)

---

## 1. Executive Summary

The simulator is **partially functional** — accounts, bots, leaderboard, and oracle push/crank all work. Three issues need fixing:

| # | Issue | Severity | Root Cause |
|---|-------|----------|------------|
| 1 | "Account must be writable" on trade | **CRITICAL** | Not reproduced from account specs — specs match Rust program. Likely a **stale oracle / crank timing** issue disguised as an account error. See §8. |
| 2 | Leaderboard showing weird data | **MEDIUM** | `total_deposited` accumulates all position sizes across all trades → ROI calculations are meaningless (0.007%). Only bots have data; no real users yet. |
| 3 | Crank stale | **HIGH** | `sim_price_history` table doesn't exist — migration 024 not applied to Supabase. Oracle service can't persist prices. Also: oracle service needs to be running continuously. |

---

## 2. Database State

### Tables Found

| Table | Rows | Status |
|-------|------|--------|
| `sim_leaderboard` | 15 | ✅ Working — all bot entries, composite PK (wallet, week_start) |
| `sim_leaderboard_history` | 0 | ✅ Schema correct (migration 025 applied) |
| `sim_scenarios` | exists | ✅ Voting/activation system works |
| `sim_faucet_claims` | exists | ✅ Rate limiting functional |
| `simulation_sessions` | exists | ✅ Legacy simulation sessions |
| `simulation_price_history` | 22,933+ | ✅ Legacy price data (latest: 2026-02-19 03:26 UTC) |
| **`sim_price_history`** | **MISSING** | ❌ **Migration 024 NOT applied** — oracle writes silently fail |

### Leaderboard Data Quality

All 15 entries are bots. `total_deposited` values are enormous (up to 13.5B raw = $13,500) because each trade adds position size to the running total. ROI calculations are technically correct but misleading:

```
🔄 MeanRevBot #1    PnL=+514,551  Deposited=6,921,329,016  ROI=0.0074%  Trades=124
🔥 TrendBot #1      PnL=-1,318,791 Deposited=12,274,111,351 ROI=-0.0107% Trades=135
```

The leaderboard should sort by PnL (which it does), not ROI. The ROI display is misleading but not broken.

---

## 3. On-Chain State

**Solana CLI not installed on this machine** — could not directly verify on-chain accounts.

From the sim config:
- SOL/USD slab: `AtzJQmxUQitYAuGHeCTbupDkEsv5wDH44hv6ZmDJ8ufR`
- BTC/USD slab: `9U5C3cn5CswQZhbajgJzp4NnQLPksE2w1wuVJEx3wTN3`
- ETH/USD slab: `FRGYFH1LshhBNrRRJUadugyBoTG21Ujjvv29uKHmWPj`

**Evidence accounts exist and work:** The oracle service successfully pushed prices and cranked all 3 markets (bots traded, leaderboard has data). Latest `simulation_price_history` entry is from 03:26 UTC today — **oracle service stopped ~2 hours ago**.

Oracle admin: `DHd11N5JVQmGdMBWf6Mnu1daFGn8j3ChCHwwYAcseD5N` (from config)

---

## 4. API/Service Status

| Service | Status | Notes |
|---------|--------|-------|
| Oracle service (`sim-oracle.ts`) | ⚠️ **STOPPED** | Last price push ~03:26 UTC. Needs to run continuously. |
| Bot fleet (`sim-bots.ts`) | ⚠️ **STOPPED** | Bots produced 15 leaderboard entries but not currently running. |
| Faucet API | ✅ Ready | `POST /api/simulate/faucet` — requires `SIM_MINT_AUTHORITY` and `SIM_USDC_MINT` env vars |
| Leaderboard API | ✅ Working | `GET /api/simulate/leaderboard?period=weekly\|alltime` |
| Leaderboard Update | ✅ Working | `POST /api/simulate/leaderboard/update` (API-key protected) |
| Leaderboard Reset | ✅ Working | `POST /api/simulate/leaderboard/reset` (weekly cron) |
| Scenario APIs | ✅ Working | Propose, vote, activate cycle |

---

## 5. Code Issues Found

### Issue 5.1: `sim_price_history` table missing — oracle price persistence fails silently

**File:** `services/sim-oracle.ts`, line ~280 (flushPriceHistory)  
**Problem:** Oracle writes to `sim_price_history` but migration 024 hasn't been applied to production Supabase.  
**Impact:** All oracle price history is lost. TradingChart can't show simulator price data.

**Fix:** Apply migration 024:
```bash
cd supabase && supabase db push
# Or manually run 024_sim_price_history.sql against Supabase
```

### Issue 5.2: Leaderboard ROI calculation misleading

**File:** `app/app/api/simulate/leaderboard/route.ts`, line 62  
**Problem:** `roi_pct = total_pnl / total_deposited * 100` where `total_deposited` accumulates over all trades.  
**Impact:** ROI shows 0.007% even for profitable bots. Users will see near-zero ROI regardless of performance.

**Fix Option A:** Change `total_deposited` to track max concurrent deposit (collateral balance), not cumulative.  
**Fix Option B:** Remove ROI column, sort by PnL only (simpler, more honest).  
**Fix Option C:** Track `initial_deposit` separately (the faucet amount, typically 10,000 simUSDC).

### Issue 5.3: Oracle price format mismatch between tables

**File:** `services/sim-oracle.ts` writes to `sim_price_history` with columns: `slab_address, symbol, price_e6 (text), raw_price_e6 (text), scenario_type, timestamp (bigint ms)`

But `simulation_price_history` has different columns: `session_id, slab_address, price_e6 (bigint), model (text), timestamp (timestamptz)`

These are **two separate systems** — the old simulation_price_history (migration 011) and the new sim_price_history (migration 024). The TradingChart component needs to know which table to query.

### Issue 5.4: `useTrade.ts` — non-authority users can't push oracle price before crank

**File:** `app/hooks/useTrade.ts`, lines 80-100  
**Problem:** When `userIsOracleAuth` is false (most users), the trade tx only includes crank + trade. The crank reads the on-chain oracle price, which goes stale if the oracle service isn't running. After ~400 slots (~3 min), the crank will reject due to stale oracle.

**Impact:** If oracle service is down, ALL user trades fail with stale oracle errors.

**Fix:** The oracle service MUST run continuously. Alternatively, have the frontend fetch a fresh price from Pyth/backend and let the user push it (but this requires oracle authority, which users don't have).

---

## 6. Account Spec Verification

### TradeCpi (8 accounts) — ✅ MATCHES

| # | TS Name | TS Signer | TS Writable | Rust Check |
|---|---------|-----------|-------------|------------|
| 0 | user | ✓ | ✓ | `expect_signer` |
| 1 | lpOwner | ✗ | ✗ | (no check needed) |
| 2 | slab | ✗ | ✓ | `expect_writable` |
| 3 | clock | ✗ | ✗ | (read only) |
| 4 | oracle | ✗ | ✗ | (read only) |
| 5 | matcherProg | ✗ | ✗ | (executable check) |
| 6 | matcherCtx | ✗ | ✓ | `expect_writable` |
| 7 | lpPda | ✗ | ✗ | (PDA validation) |

### KeeperCrank (4 accounts) — ✅ MATCHES

| # | TS Name | TS Signer | TS Writable | Rust Check |
|---|---------|-----------|-------------|------------|
| 0 | caller | ✓ | ✓ | `expect_signer` (unless permissionless) |
| 1 | slab | ✗ | ✓ | `expect_writable` |
| 2 | clock | ✗ | ✗ | (read only) |
| 3 | oracle | ✗ | ✗ | (read only) |

### PushOraclePrice (2 accounts) — ✅ MATCHES

| # | TS Name | TS Signer | TS Writable | Rust Check |
|---|---------|-----------|-------------|------------|
| 0 | authority | ✓ | ✓ | `expect_signer` |
| 1 | slab | ✗ | ✓ | `expect_writable` |

**No account spec mismatches found.** The "Account must be writable" error does NOT come from incorrect TS specs.

---

## 7. Test Results

**25 test files, 347 tests — ALL PASSING ✅**

Test suites cover:
- Oracle: scenario multipliers, Pyth price fetch, push/crank flow
- Bots: trend/mean-revert/market-maker signals, config validation
- Integration: scenario lifecycle, leaderboard tracking, faucet rate limiting, market switching
- API: vote cooldown, faucet validation
- Components: ScenarioPanel, vote URL correctness

---

## 8. Root Cause Analysis

### Issue 1: "Account must be writable" on trade

**Most likely cause: Stale oracle → crank failure → confusing error message.**

The account specs are correct (verified against Rust source). The error is likely:

1. Oracle service stops → on-chain `authority_price_e6` becomes stale (>400 slots old)
2. User submits tx: [crank, trade]
3. Crank reads stale authority price → falls back to Pyth oracle → but oracle account is `slabPk` (not a Pyth account) → Solana runtime rejects the Pyth oracle read attempt
4. Error surfaces as "Account must be writable" from the Pyth account validation path OR a confusing Solana error

**Alternative cause:** If the user has never been initialized on the slab (no `InitUser` call), the program may attempt to modify a non-existent user slot, triggering a different error path.

**To verify:** Restart the oracle service and test a trade. If it works → root cause is stale oracle.

### Issue 2: Leaderboard showing weird data

**Root cause:** `total_deposited` in `sim_leaderboard` is the sum of ALL `deposited_delta` values from every trade update call. Each trade adds the position size to this cumulative total. For a bot making 130 trades of ~$100M notional each, `total_deposited` reaches billions.

The ROI formula `total_pnl / total_deposited * 100` then shows near-zero percentages even for profitable traders.

### Issue 3: Crank stale

**Root cause (compound):**
1. Oracle service (`sim-oracle.ts`) is not running — prices haven't been pushed since 03:26 UTC
2. `sim_price_history` table doesn't exist — migration 024 not applied — price persistence silently fails
3. Without fresh oracle prices, the crank processor rejects trades as stale

---

## 9. Recommended Fixes (Priority Order)

### P0 — Critical: Apply migration 024 and restart oracle service

```bash
# 1. Apply the missing migration
cd /Users/khubair/.openclaw/workspace/percolator-launch
# Run against Supabase:
# supabase db push OR manually execute 024_sim_price_history.sql

# 2. Restart oracle service (Railway or local)
# Ensure env vars: RPC_URL, SIM_ADMIN_KEYPAIR, SUPABASE_URL, SUPABASE_SERVICE_KEY
```

### P1 — High: Keep oracle service running as persistent Railway service

The oracle service must run 24/7. It pushes prices every 5s and cranks all 3 markets. Without it, ALL trades fail.

Options:
- Railway persistent service (recommended)
- PM2 on a VPS
- Cron-triggered (not ideal — needs continuous push)

### P2 — Medium: Fix leaderboard ROI calculation

**Option A (recommended):** Track `initial_deposit` (faucet amount) and compute ROI against that:

```typescript
// In leaderboard update route, change:
// total_deposited: newDeposited,  // cumulative
// To track initial deposit only (set once, on first trade):
// initial_deposit: existing.initial_deposit ?? deposited,
```

**Option B:** Simply remove the ROI column from the leaderboard display:

```typescript
// In SimLeaderboard.tsx, remove:
// fmtPct(e.roi_pct)
// Replace with absolute PnL display only
```

### P3 — Low: Better error messages for stale oracle

In `useTrade.ts`, catch the specific error and display a helpful message:

```typescript
// After trade fails:
if (msg.includes("Account must be writable") || msg.includes("stale")) {
  setError("Oracle prices are stale — the simulator service may be down. Try again in a moment.");
}
```

### P4 — Low: Ensure TradingChart reads from correct table

Verify the TradingChart component reads from `sim_price_history` (new, per-symbol, bigint timestamp) for simulator markets, not `simulation_price_history` (old, per-session, timestamptz).
