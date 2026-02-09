# Spec v4–v7 Security Fixes — Port Audit

Audit of toly's commits against our `percolator/src/percolator.rs` risk engine.

**Branch:** `cobra/fix/toly-spec-v7`  
**Date:** 2026-02-09  
**Source:** `/tmp/toly-check/` (6 commits, oldest-first)

---

## Commit Summary

### 1. `f0adfad` — Spec v4: Funding anti-retroactivity fix
**Vulnerability:** Adversary delays a crank, manipulates state to change funding rate, then the new rate is applied retroactively to the entire elapsed interval.  
**Fix:** Store `funding_rate_bps_per_slot_last` field. `accrue_funding()` uses stored rate. `keeper_crank` accrues with old rate THEN stores new rate via `set_funding_rate_for_next_interval()`.  
**Status:** ✅ Already applied

### 2. `e838580` — Warmup touch in crank + fee debt as liability in margin equity
**Vulnerability:** (a) Zombie accounts with positive PnL never settle warmup, permanently inflating `pnl_pos_tot` and degrading haircut ratios. (b) Accounts with `fee_credits < 0` appear over-collateralized because fee debt isn't subtracted from equity.  
**Fix:** (a) Crank calls `touch_account` + `settle_warmup_to_capital_for_crank` per visited account. (b) Fee debt subtracted in `account_equity_mtm_at_oracle`, `execute_trade` margin checks, and `withdraw` margin check.  
**Status:** ✅ Already applied

### 3. `9731300` — Require initial margin for risk-increasing trades (Finding L)
**Vulnerability:** All trades only required maintenance margin, allowing positions at liquidation boundary.  
**Fix:** `execute_trade` uses `initial_margin_bps` when `|new_pos| > |old_pos|`, `maintenance_margin_bps` otherwise. Both user and LP.  
**Status:** ✅ Already applied

### 4. `d27f281` — Treat position flips as risk-increasing (spec v5)
**Vulnerability:** Position flips (long→short) bypassed initial margin since `|new_pos|` could be ≤ `|old_pos|`.  
**Fix:** `crosses_zero` detection + `risk_increasing = |new| > |old| || crosses_zero`. Both user and LP.  
**Status:** ✅ Already applied

### 5. `9cdc92b` — Ceiling division for trade fees (Finding J, spec v6)
**Vulnerability:** Micro-trade fee evasion via splitting trades where floor division rounds fee to 0.  
**Fix:** `(notional * fee_bps + 9999) / 10000` ensuring minimum 1 atomic unit. Both trade and liquidation fees.  
**Status:** ✅ Already applied

### 6. `45a7be9` — Warmup cap stale slope fix (Review Finding [1], spec v7)
**Vulnerability:** Mark settlement increases `avail_gross` but old warmup slope still used, allowing over-withdrawal.  
**Fix:** Capture old/new `avail_gross` around mark settlement; call `update_warmup_slope()` if increased. In both `touch_account_full` and `execute_trade`.  
**Status:** ✅ Already applied

---

## Program Side (`program/src/percolator.rs`)

The on-chain program imports the `percolator` crate as a dependency. All risk engine logic is delegated to the crate. No separate porting needed.

## Build Verification

- `cargo check` in `percolator/` — ✅ passes
- `cargo check --features test` in `program/` — ✅ passes

## Conclusion

All 6 security fixes from toly's spec v4–v7 are already present in our codebase. No code changes required.
