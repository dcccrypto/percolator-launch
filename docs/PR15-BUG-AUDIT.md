# PR #15 Bug Audit: Stranded Funds Detection & Automatic Insurance Recovery

**Repository:** `aeyakovenko/percolator`  
**PR:** #15 — "Add stranded funds detection and automatic insurance recovery"  
**Status:** MERGED (commit `bb9474e`)  
**Auditor:** Cobra (automated deep audit)  
**Date:** 2026-02-17  

---

## Overall Assessment

### ⚠️ NEEDS FIXES — Do not rely on post-recovery state without patching

The core recovery logic is **mathematically sound** — conservation is preserved, the haircut distribution is fair, and the deadlock-breaking mechanism is correct. However, a **HIGH severity aggregate coherence bug** means the engine's internal bookkeeping (`pnl_pos_tot`) becomes stale after recovery, corrupting all subsequent margin checks, haircut ratios, and warmup conversions until the aggregate is manually recomputed. This must be fixed before production use.

The PR also adds **zero Kani formal proofs** for the new code, which is a significant gap for a codebase that markets itself as "formally verified."

---

## Functions Added/Modified

### New Functions
| Function | Location | Purpose |
|----------|----------|---------|
| `stranded_funds()` | `src/percolator.rs` ~L4760 | Compute inaccessible vault tokens: `vault - Σcapital - insurance` |
| `recover_stranded_to_insurance()` | `src/percolator.rs` ~L4810 | Haircut positive PnL → clear loss_accum + top up insurance |

### Modified Functions
| Function | Change |
|----------|--------|
| `keeper_crank()` | Added stranded recovery call after GC, new `stranded_recovery` field in `CrankOutcome` |

### Modified Structs
| Struct | Change |
|--------|--------|
| `CrankOutcome` | Added `pub stranded_recovery: u128` field |

---

## Findings

### Finding 1: `pnl_pos_tot` Aggregate Not Updated During Recovery

**Severity:** HIGH  
**Location:** `src/percolator.rs`, `recover_stranded_to_insurance()`, Pass 2 and leftover distribution  

**Description:**  
The recovery function modifies account PnL directly:
```rust
// Pass 2 (line ~4897):
self.accounts[idx].pnl = self.accounts[idx].pnl.saturating_sub(floor_haircut as i128);

// Leftover (line ~4928):
self.accounts[idx].pnl = self.accounts[idx].pnl.saturating_sub(1);
```

This bypasses the mandatory `self.set_pnl()` helper, which the codebase explicitly requires:
> "Mandatory helper: set account PnL and maintain pnl_pos_tot aggregate (spec §4.2). **All code paths that modify PnL MUST call this.**"

After recovery, `pnl_pos_tot` retains its pre-recovery value while actual positive PnL across accounts has been reduced by `haircut`. This stale aggregate corrupts:

1. **`haircut_ratio()`** → `h_den = stale pnl_pos_tot` (too large) → `h = h_num/h_den` too small
2. **`effective_pos_pnl()`** → returns less than actual → accounts appear less solvent
3. **`account_equity_mtm_at_oracle()`** → understates equity for all accounts
4. **Margin checks** → may incorrectly flag accounts as undercollateralized
5. **`settle_warmup_to_capital()`** → haircut ratio `h` too low → profit conversion undervalues

The error is **persistent and cumulative**. Subsequent `set_pnl()` calls on individual accounts correctly compute their own delta but operate on the inflated base value, so `pnl_pos_tot` remains permanently inflated.

**Impact:**
- Legitimate withdrawals blocked (equity understated)
- Unnecessary liquidations triggered
- Warmup profit conversion undervalues what users receive
- In the common case (ALL positive PnL zeroed), individual `effective_pos_pnl(0)` returns 0 regardless of stale aggregate, so practical impact is **limited to the partial haircut case**
- In the partial haircut case (negative PnL accounts exist when OI==0, which is unusual), all accounts' margin calculations are wrong

**Recommendation:**  
Add `self.recompute_aggregates()` after the haircut is applied and before the warmup/insurance logic:

```rust
// After the leftover distribution block and the debug_assert:
self.recompute_aggregates(); // Fix pnl_pos_tot and c_tot
```

Or equivalently, replace the direct `.pnl =` assignments with `self.set_pnl(idx, new_value)` calls throughout the function (requires restructuring the bitmap iteration since `set_pnl` borrows `self` mutably).

---

### Finding 2: No Kani Formal Proofs for Stranded Recovery

**Severity:** MEDIUM  
**Location:** `tests/kani.rs` — no new harnesses added  

**Description:**  
The PR adds 0 Kani harnesses for the new `recover_stranded_to_insurance()` function. The existing Kani proofs cover deposit, withdraw, trade, liquidation, funding, GC, and warmup — but NOT stranded recovery. Only unit tests are provided.

Key properties that need formal proofs:
- Conservation preservation: `vault + loss_accum >= C + P + I` before and after recovery
- Aggregate coherence: `pnl_pos_tot == Σmax(pnl_i, 0)` after recovery (currently violated!)
- Canonical INV preservation: `canonical_inv(s) ∧ pre ⇒ canonical_inv(recover(s))`
- No-value-creation: `applied == haircut` (exact distribution)
- Idempotency: second call returns Ok(0)
- Frame property: only PnL and insurance/loss_accum change; capital/positions untouched

**Impact:**  
The stranded recovery touches safety-critical state (PnL, insurance, loss_accum, warmup). Without formal verification, subtle bugs (like Finding 1) can slip through unit tests that only check specific scenarios.

**Recommendation:**  
Add at minimum:
1. `proof_stranded_recovery_preserves_canonical_inv` — symbolic inputs, asserts `canonical_inv` before and after
2. `proof_stranded_recovery_conservation` — vault+loss_accum relationship preserved
3. `proof_stranded_recovery_idempotent` — second call is noop
4. `proof_stranded_recovery_frame` — non-target accounts' capital unchanged

---

### Finding 3: `unwrap_or(0)` Silently Swallows Recovery Errors in Crank

**Severity:** LOW  
**Location:** `src/percolator.rs`, `keeper_crank()`, ~L1774  

**Description:**  
```rust
let stranded_recovery = if self.risk_reduction_only
    && !self.loss_accum.is_zero()
    && self.total_open_interest.is_zero()
{
    self.recover_stranded_to_insurance().unwrap_or(0)
} else {
    0
};
```

If `recover_stranded_to_insurance()` returns `Err` (from `require_no_pending_socialization` or `checked_mul` overflow), the error is silently swallowed. The crank proceeds as if no recovery was needed.

**Impact:**  
- If pending socialization is non-zero, recovery correctly defers — this is intentional
- If `checked_mul` overflows (astronomically large PnL values), recovery permanently fails silently
- The `stranded_recovery` field in `CrankOutcome` reports 0, giving callers no indication that recovery was attempted but failed

**Recommendation:**  
Consider logging the error or exposing it in `CrankOutcome`:
```rust
pub stranded_recovery: u128,
pub stranded_recovery_error: bool, // NEW: true if recovery attempted but failed
```

---

### Finding 4: Algebraic Confusion in Conservation Comment

**Severity:** INFO  
**Location:** `src/percolator.rs`, `recover_stranded_to_insurance()` doc comment  

**Description:**  
The conservation proof in the doc comment trails off with:
```
///   So RHS = C + P + I - L + slack... wait, let's just verify:
```

The "wait, let's just verify" suggests the author got confused mid-derivation. While the final conservation proof at the bottom of the function (in the code, not the doc) is correct, the doc comment's incomplete algebra is misleading for reviewers.

**Impact:** Documentation quality only. The actual conservation math is correct.

**Recommendation:** Clean up the doc comment to present the proof clearly:
```
/// Conservation proof:
///   Before: vault + L = C + P + I  (definition)
///   Recovery: H = applied haircut, R = min(H, L), T = H - R
///   After:  vault + (L - R) = C + (P - H) + (I + T)
///   Expand RHS: C + P - H + I + H - R = C + P + I - R
///   Expand LHS: vault + L - R
///   Since vault + L = C + P + I (before), both sides equal. QED.
```

---

### Finding 5: Potential `new_pnl as u64` Truncation in reserved_pnl Clamping

**Severity:** LOW  
**Location:** `src/percolator.rs`, Pass 2 reserved_pnl clamping  

**Description:**  
```rust
let new_pnl = self.accounts[idx].pnl.get();
if new_pnl >= 0 {
    let max_reserved = new_pnl as u64;  // truncation if new_pnl > u64::MAX
    if self.accounts[idx].reserved_pnl > max_reserved {
        self.accounts[idx].reserved_pnl = max_reserved;
    }
}
```

If `new_pnl` exceeds `u64::MAX` (which requires PnL > 18.4 quintillion — unrealistic for Solana), the cast truncates, potentially clamping `reserved_pnl` incorrectly.

**Impact:** Zero practical impact. Solana vault sizes are bounded by ~10^18 lamports (u64::MAX). PnL values this large are physically impossible.

**Recommendation:** Add a defensive clamp for correctness:
```rust
let max_reserved = if new_pnl > u64::MAX as i128 { u64::MAX } else { new_pnl as u64 };
```

---

### Finding 6: `checked_mul` Overflow Could Permanently Block Recovery

**Severity:** LOW  
**Location:** `src/percolator.rs`, Pass 2 proportional haircut  

**Description:**  
```rust
let numer = haircut.checked_mul(acct_pnl).ok_or(RiskError::Overflow)?;
```

Both `haircut` and `acct_pnl` are u128. If their product exceeds u128::MAX (~3.4 × 10^38), the function returns `Err(Overflow)`. Since the crank catches this with `unwrap_or(0)`, recovery permanently fails for this engine state.

For practical Solana use (vault ≤ ~10^18), the product can't exceed ~10^36, well within u128 range. This is only a concern for extremely large vaults or pathological state.

**Impact:** Theoretical only. Would require vault > ~10^19 tokens.

**Recommendation:** No immediate action needed. Document the implicit assumption about vault size bounds.

---

## Conservation Proof Walkthrough

### Setup (before recovery)

The conservation invariant in the merged branch is:
```
vault + loss_accum = Σcapital + Σpnl + insurance  (± rounding slack)
```

### Variables
- `H` = total haircut applied to positive PnL
- `R` = `min(H, loss_accum)` — amount that reduces loss_accum
- `T` = `H - R` — amount that tops up insurance

### Step-by-step trace

1. **Pass 1:** Compute `total_positive_pnl` = Σ{pnl_i | pnl_i > 0}
2. **Compute haircut:** `stranded = vault - Σcapital - insurance`; `total_needed = stranded + loss_accum`; `H = min(total_needed, total_positive_pnl)`
3. **Pass 2:** Reduce each positive PnL account proportionally. Σpnl decreases by H.
4. **loss_accum reduction:** `loss_accum -= R` where `R = min(H, loss_accum)`
5. **Insurance top-up:** `insurance += T` where `T = H - R`

### Verification

**Before:** `vault + L = C + P + I` (where L=loss_accum, C=Σcapital, P=Σpnl, I=insurance)

**After:**
- LHS: `vault + (L - R)` (vault unchanged, loss_accum reduced by R)
- RHS: `C + (P - H) + (I + T)` (capital unchanged, PnL reduced by H, insurance increased by T)
- Expand RHS: `C + P - H + I + H - R = C + P + I - R`
- Both sides: original equation minus R. **✓ Conservation preserved.**

### Capital safety (Invariant I1)

No capital fields are modified during recovery. **✓ Capital protected.**

### Value flow

```
Positive PnL (-H) → loss_accum (-R) + insurance (+T)
where H = R + T

No tokens enter or leave the vault. This is purely internal reallocation
of accounting claims on existing vault tokens.
```

---

## State Machine Analysis

### Recovery trigger conditions:
1. `risk_reduction_only == true` — system is in crisis mode
2. `loss_accum > 0` — phantom accounting holes exist
3. `total_open_interest == 0` — all positions closed (no mark PnL uncertainty)
4. `pending_unpaid_loss == 0 && pending_profit_to_fund == 0` — no socialization in flight

### Can conditions be met unexpectedly?
- **Condition 1+2:** Only set during socialization finalization when insurance can't cover losses. This is a genuine crisis path. ✓
- **Condition 3:** OI==0 means all positions were force-closed during the crisis. Normal path. ✓
- **Condition 4:** Pending buckets are cleared during sweep finalization. If a crank hasn't completed a full sweep, pending may be non-zero, correctly blocking recovery. ✓

### Idempotency / repeated calls:
After successful recovery:
- If `haircut == total_positive_pnl`: all positive PnL is zero → Pass 1 returns Ok(0) on next call ✓
- `loss_accum` may be zeroed → gate 2 blocks re-entry ✓
- `risk_reduction_only` may be cleared → gate 1 blocks re-entry ✓

**No drain risk from repeated keeper_crank calls.** ✓

### Edge cases:
| Case | Behavior | Status |
|------|----------|--------|
| vault == 0 | stranded_funds() = 0, total_needed = loss_accum, haircut = min(loss_accum, pnl) | ✓ Safe |
| All accounts closed | for_each_used iterates nothing, total_positive_pnl = 0, returns Ok(0) | ✓ Safe |
| Insurance already at max | exit_risk_reduction checks threshold, won't exit if below | ✓ Safe |
| Only negative PnL accounts | total_positive_pnl = 0, returns Ok(0) | ✓ Safe |
| Single account with all PnL | Proportional haircut = full haircut, no remainder | ✓ Safe |

---

## Haircut System Interaction

The codebase uses a haircut ratio `h = min(Residual, pnl_pos_tot) / pnl_pos_tot` instead of ADL for insolvency handling. The recovery correctly interacts with this:

1. **During recovery:** Uses its own `total_positive_pnl` computation (not `pnl_pos_tot`) for proportional distribution ✓
2. **After recovery:** `pnl_pos_tot` is **stale** (Finding 1), causing incorrect haircut ratios ✗
3. **Haircut direction:** Stale high `pnl_pos_tot` makes `h` too small → conservative (users can't extract more) ✓ (safe direction, but blocks legitimate operations)

---

## Summary of Findings

| # | Severity | Title | Exploitable? |
|---|----------|-------|-------------|
| 1 | **HIGH** | `pnl_pos_tot` aggregate not updated during recovery | No (conservative direction), but blocks legitimate operations |
| 2 | **MEDIUM** | No Kani formal proofs for stranded recovery | N/A — verification gap |
| 3 | **LOW** | `unwrap_or(0)` silently swallows recovery errors | No |
| 4 | **INFO** | Algebraic confusion in conservation doc comment | No |
| 5 | **LOW** | `new_pnl as u64` truncation in reserved_pnl clamping | No (unrealistic values) |
| 6 | **LOW** | `checked_mul` overflow could block recovery | No (unrealistic values) |

---

## Recommended Actions

1. **MUST FIX (Finding 1):** Add `self.recompute_aggregates()` call after haircut application in `recover_stranded_to_insurance()`. One-line fix, resolves all downstream aggregate corruption.

2. **SHOULD FIX (Finding 2):** Add Kani proofs for recovery function covering conservation, aggregate coherence, and canonical INV preservation.

3. **NICE TO HAVE (Finding 3):** Expose recovery errors in `CrankOutcome` for observability.

4. **NICE TO HAVE (Finding 4):** Clean up the doc comment's conservation proof.
