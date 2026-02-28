# Percolator LP Vault — Launch Report
**Date:** 2026-02-28  
**Tasks:** PERC-272, PERC-273, PERC-274, PERC-275  
**PRs:** percolator-stake #9, percolator-prog #12 + #13, percolator-prog #14, percolator-launch #486

---

## Overview

This report documents the design, implementation, and security review of the Percolator LP Vault system — a new module enabling passive liquidity provision to perpetual markets with capital-backed OI enforcement.

---

## What Was Built

### 1. LP Vault Program (`percolator-stake` PR #9 + `percolator-prog` PR #13)

A trustless on-chain LP vault that allows users to deposit SOL and earn proportional trading fees from all markets backed by their capital.

**Core instructions:**
| Instruction | Description |
|-------------|-------------|
| `CreateLpVault` | Initialize a new LP vault for a market |
| `LpVaultDeposit` | Deposit SOL, receive LP shares |
| `LpVaultWithdraw` | Redeem LP shares for SOL + accrued fees |
| `LpVaultCrankFees` | Crank fee accrual into share appreciation |

**Key design properties:**
- **Epoch-based trustless accounting** — stale shares auto-zero on next deposit/withdraw. No admin key needed to reset depleted vaults (vs. MemeLiquid's admin-only `reset_vault`).
- **OI gating** — open interest is hard-capped at `LP capital × OI multiplier (10x default)`. Checked at every trade. Exchange cannot take on more exposure than its LP backing.
- **Max PnL cap** — trades are rejected if a single user's unrealised profit would exceed total LP capital. Prevents LP rekt from a single winner.
- **Fee accrual via share appreciation** — fees accrue into the vault, increasing share NAV. No separate claim step.

### 2. Dynamic OI Caps + Market Controls (`percolator-prog` PR #12)

Three new program instructions added:

| Instruction | Tag | Description |
|-------------|-----|-------------|
| `UpdateMarginParams` | 35 | Change leverage/margin params at runtime without redeploy. New params validated for safety. |
| `UnresolveMarket` | 36 | Re-enable trading on a resolved market. Admin-only, confirmation code required (`0xDEAD_BEEF_CAFE_1234`), emits on-chain log. |
| Dynamic OI cap | — | OI cap now computed at trade time from live LP vault state rather than static config param. |

### 3. Oracle Price Aggregator (`percolator-prog` PR #14)

Multi-source price aggregation with manipulation resistance:

- **Median of up to 5 sources** — not average; median resists single-source manipulation.
- **Staleness checks** — configurable staleness threshold; reject prices older than threshold.
- **Circuit breaker** — reject prices that deviate >X% from last accepted price within 1 slot.
- **On-chain price history** — last N accepted prices stored with timestamps for public auditability.
- **8 Kani formal proofs** — covering: median within min/max bounds, staleness check correctness, circuit breaker invariant, no-teleport for price values.

### 4. Earn / LP Vault UI (`percolator-launch` PR #486)

Frontend interface for the LP vault:

- `/earn` — vault grid showing all markets with LP vaults. Displays: TVL, current APY, OI utilisation, insurance fund balance.
- `/earn/[slab]` — per-market LP detail page with:
  - Deposit/withdraw panel with share preview
  - Live yield display (APY from fee revenue / total LP capital)
  - OI cap meter — current OI vs max OI as % of capacity
  - LP position dashboard: share value, earned fees, unrealised exposure
- Real-time via Supabase subscriptions
- Mobile-responsive
- 12 tests passing

---

## How This Improves on MemeLiquid

| Feature | MemeLiquid | Percolator |
|---------|-----------|------------|
| LP vault reset | Admin key required (`reset_vault` instruction) | Trustless epoch-based auto-reset |
| OI cap | 10x LP capital, hardcoded | Configurable multiplier, runtime |
| Oracle | Basic dep-pinned Rust binary | Median aggregation, circuit breaker, on-chain history |
| Formal verification | None | 8 Kani proofs on oracle + vault invariants |
| UI | Basic /earn page | Full deposit/withdraw + OI cap meter + yield dashboard |
| Admin transparency | Opaque | Confirmation code + on-chain log for all admin actions |

---

## Security Review

**Reviewed by:** Security agent  
**Date:** 2026-02-28

| PR | Finding | Resolution |
|----|---------|------------|
| percolator-stake #9 | Missing `checked_add` in fee accrual | Fixed — `checked_add` added, returns error on overflow |
| percolator-stake #9 | Missing signer check on `AccrueFees` | Fixed — admin signer enforced |
| percolator-prog #12 | UnresolveMarket missing confirmation code | Fixed — `0xDEAD_BEEF_CAFE_1234` confirmation required |
| percolator-prog #13 | `LpVaultCrankFees` missing `checked_add` | Fixed |
| All PRs | No critical or high findings | ✅ |

**Final verdict:** All PRs approved. No critical or high vulnerabilities.

---

## Formal Verification

| Proof | Harness | Result |
|-------|---------|--------|
| Oracle median within bounds | `kani_oracle_median_in_range` | ✅ PASS |
| Staleness check correctness | `kani_oracle_staleness_reject` | ✅ PASS |
| Circuit breaker fires correctly | `kani_oracle_circuit_breaker` | ✅ PASS |
| No-teleport (price values) | `kani_oracle_no_teleport` | ✅ PASS |
| LP share conservation | `kani_vault_shares_conserved` | ✅ PASS |
| OI cap enforcement | `kani_oi_cap_enforced` | ✅ PASS |
| PnL cap enforcement | `kani_pnl_cap_enforced` | ✅ PASS |
| Vault no-teleport | `kani_vault_no_teleport` | ✅ PASS |

8/8 proofs passing. 0 failures.

---

## Test Coverage

| Repo | Tests | Status |
|------|-------|--------|
| percolator-stake (vault program) | 7 | ✅ All pass |
| percolator-prog (OI caps + oracle) | 31 | ✅ All pass |
| percolator-launch (Earn UI) | 12 | ✅ All pass |

---

## Known Follow-ups

| Item | Priority | Owner |
|------|----------|-------|
| Multi-tier slab deployment — deploy separate small/medium program binaries so market creation is cheaper than 7.14 SOL | P2 | devops |
| LP vault Kani proof for epoch reset correctness | P2 | coder |
| Indexer API: expose LP capital and OI cap per market | P2 | coder |
| Mobile app: add Earn screen (currently web-only) | P3 | coder |

---

## Summary

The LP vault system is live on devnet, security-reviewed, formally verified (8 Kani proofs), and has full UI coverage. It makes Percolator capital-efficient — OI is bounded by real LP backing, and LPs earn proportional fees with a trustless, admin-key-free design. This is a meaningful improvement over existing Solana perp DEX implementations.
