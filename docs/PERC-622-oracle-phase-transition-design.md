# PERC-622: Three-Phase Oracle Transition Protocol — Design Doc

**Task:** PERC-622 / PERC-610  
**Author:** coder (Forge)  
**Date:** 2026-03-10  
**Status:** Draft — awaiting PM review before implementation  
**Priority:** P0 / XL  
**Blocks:** PERC-623, PERC-624, PERC-625, PERC-626

---

## 1. Problem Statement

New token markets on Percolator face an oracle cold-start problem: on day 0, Pyth/Switchboard don't carry the feed, DEX liquidity is thin, and price manipulation risk is highest. The current architecture accepts a single oracle price from the keeper with no concept of market maturity. This means either:

- **Too permissive on day 0**: full OI cap + leverage on a manipulatable pump.fun price → LP capital at risk
- **Too restrictive**: defer all markets until mature → no permissionless launch story

The Three-Phase Oracle Transition Protocol solves this by parameterizing risk limits and oracle source selection per market maturity phase, with automatic on-chain transitions triggered by verifiable milestones.

---

## 2. Phase Specification

| | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|
| **Duration trigger** | 0 → 72h after market creation | 72h → 14d OR $100K cumulative volume | >14d AND $100K vol |
| **Oracle source** | pump.fun final price + DEX TWAP (keeper-pushed, signed) | Median of: DEX TWAP + Hyperp mark + Switchboard (if available) | Pyth or Switchboard only |
| **OI cap (USD)** | $10,000 | $100,000 | Full (`oi_cap_multiplier_bps`) |
| **Max leverage** | 2× | 5× | Configured max (default 10×) |
| **Transition trigger** | Automatic when slot age ≥ `PHASE1_SLOTS` | Automatic when slot age ≥ `PHASE2_SLOTS` OR `cumulative_volume_usd ≥ PHASE2_VOL_THRESHOLD` | Same |
| **Admin override** | None — no admin key | None | None |

### Constants
```rust
/// ~72 hours at 400ms/slot (Solana target)
pub const PHASE1_SLOTS: u64 = 648_000;

/// ~14 days at 400ms/slot
pub const PHASE2_SLOTS: u64 = 3_024_000;

/// $100K cumulative volume in e6 USD (= 100_000 * 1_000_000)
pub const PHASE2_VOL_THRESHOLD_E6: u64 = 100_000_000_000;

/// Phase 1 OI cap in e6 USD (= $10K)
pub const PHASE1_OI_CAP_E6: u64 = 10_000_000_000;

/// Phase 2 OI cap in e6 USD (= $100K)
pub const PHASE2_OI_CAP_E6: u64 = 100_000_000_000;

/// Phase 1 max leverage (2×) in bps (200_00 = 2.00×)
pub const PHASE1_MAX_LEVERAGE_BPS: u64 = 20_000;

/// Phase 2 max leverage (5×) in bps
pub const PHASE2_MAX_LEVERAGE_BPS: u64 = 50_000;
```

---

## 3. State Machine

```text
          market_created_slot set
                    │
                    ▼
            ┌───────────────┐
            │   Phase 1     │  OI: $10K  Lev: 2×
            │  (bootstrap)  │  Oracle: keeper-signed TWAP
            └───────┬───────┘
                    │  slot_age ≥ PHASE1_SLOTS
                    │  (no early exit)
                    ▼
            ┌───────────────┐
            │   Phase 2     │  OI: $100K  Lev: 5×
            │  (growth)     │  Oracle: median(DEX,Hyperp,SB)
            └───────┬───────┘
                    │  slot_age ≥ PHASE2_SLOTS
                    │  OR cumulative_volume ≥ PHASE2_VOL_THRESHOLD
                    ▼
            ┌───────────────┐
            │   Phase 3     │  OI: full  Lev: configured
            │  (maturity)   │  Oracle: Pyth/Switchboard
            └───────────────┘
```

**Key properties:**
- Transitions are strictly monotone (Phase 1 → 2 → 3 only, no reversal)
- Triggered lazily on every instruction that checks OI or leverage (no crank needed for transition itself)
- The transition check is O(1): compare `current_slot - market_created_slot` and `cumulative_volume_usd`
- No signer, no admin, no DAO vote required

---

## 4. Account Structure Changes

### 4.1 `MarketConfig` additions (percolator-prog)

```rust
// ========================================
// Three-Phase Oracle Transition (PERC-622)
// ========================================

/// Current oracle phase (0=Phase1, 1=Phase2, 2=Phase3).
/// Stored so UI/indexers can read it without recomputing; updated lazily.
pub oracle_phase: u8,

/// Padding
pub _oracle_phase_pad: [u8; 7],

/// Cumulative volume traded in this market (e6 USD equivalent).
/// Incremented on every matched trade in percolator-prog trade handler.
/// Used as Phase 2 → 3 trigger (alongside slot age).
pub cumulative_volume_usd_e6: u64,

/// Phase 1 oracle: public key of the trusted keeper allowed to push
/// pump.fun final price + DEX TWAP. Only valid in Phase 1.
/// Must be a known Percolator keeper signer. Set at InitMarket.
pub phase1_oracle_authority: [u8; 32],

/// Phase 1 anchor price (pump.fun final price at market creation, e6).
/// Set once at InitMarket. Used as TWAP anchor in Phase 1 price validation.
pub phase1_anchor_price_e6: u64,

/// Phase 1 timestamp of anchor price (unix seconds).
pub phase1_anchor_timestamp: i64,

/// Phase 2 Switchboard feed pubkey (optional — zeros = not available).
/// Used as third input in Phase 2 median computation.
pub phase2_switchboard_feed: [u8; 32],
```

### 4.2 Size impact
Current `MarketConfig` is 1,024 bytes (padded). New fields add:
- `oracle_phase` (1) + `_pad` (7) + `cumulative_volume_usd_e6` (8) + `phase1_oracle_authority` (32) + `phase1_anchor_price_e6` (8) + `phase1_anchor_timestamp` (8) + `phase2_switchboard_feed` (32) = **96 bytes**

Total: 1,024 + 96 = 1,120 bytes. Within 10KB account limit comfortably. Needs `realloc` guard in migration.

### 4.3 Migration / backward compat
- Existing markets (pre-PERC-622) default to `oracle_phase = 2` (Phase 3 / mature) via a fallback: if `market_created_slot` is from before the protocol upgrade slot, treat as Phase 3.
- New markets start at `oracle_phase = 0` (Phase 1) from InitMarket.

---

## 5. Oracle Source Logic Per Phase

### Phase 1: Keeper-Signed TWAP
- Keeper signs a price message: `{market_pubkey, price_e6, slot, source: PumpFunDexTwap}`
- Validated in percolator-prog: signature must be from `phase1_oracle_authority`
- Price validated against anchor: `|price - anchor| / anchor < MAX_PHASE1_DEVIATION_BPS` (e.g., 50% = 5000 bps) to prevent oracle gaming
- TWAP smoothing: keeper MUST provide ≥3 price samples per slot window; percolator-prog takes EMA over last 5 samples stored in a ring buffer in `PriceHistory`
- Stale detection: reject if sample slot age > 10 slots

### Phase 2: Median of Three Sources
- Three inputs: (1) keeper DEX TWAP, (2) Hyperp mark price (oracle authority push), (3) Switchboard feed (if `phase2_switchboard_feed` non-zero)
- If only 2 inputs available: median = average of 2
- If only 1: reject trade (insufficient oracle coverage)
- Validation: all inputs must be within 10% of each other, else reject
- Stale detection: each input rejected if slot age > 20 slots

### Phase 3: Pyth/Switchboard (existing)
- Unchanged from current implementation (Pyth Pull with `index_feed_id`, conf filter)
- `oracle_authority` signer path also valid in Phase 3

---

## 6. OI Cap Enforcement Changes

Current: `OI cap = vault_balance * oi_cap_multiplier_bps / 10_000`

New: Phase-gated cap wraps the existing calculation:

```rust
pub fn effective_oi_cap_e6(
    &self,
    vault_balance: u64,
    current_slot: u64,
    oracle_price_e6: u64,
) -> u64 {
    let phase = self.compute_oracle_phase(current_slot);
    let phase_cap_usd_e6: Option<u64> = match phase {
        OraclePhase::Phase1 => Some(PHASE1_OI_CAP_E6),
        OraclePhase::Phase2 => Some(PHASE2_OI_CAP_E6),
        OraclePhase::Phase3 => None, // no phase cap — use existing logic
    };

    // Convert USD cap to units using oracle price
    let phase_cap_units = phase_cap_usd_e6.map(|cap_usd| {
        // units = (usd_e6 * unit_scale) / oracle_price_e6
        (cap_usd as u128 * self.unit_scale as u128 / oracle_price_e6.max(1) as u128) as u64
    });

    // Existing vault-based cap
    let vault_cap = if self.oi_cap_multiplier_bps == 0 {
        u64::MAX // no cap
    } else {
        (vault_balance as u128 * self.oi_cap_multiplier_bps as u128 / 10_000) as u64
    };

    // Take the minimum of phase cap and vault cap
    match phase_cap_units {
        Some(pc) => pc.min(vault_cap),
        None => vault_cap,
    }
}
```

### Leverage Cap
Add to trade validation in percolator core:

```rust
pub fn max_leverage_bps(phase: OraclePhase, configured_max_bps: u64) -> u64 {
    match phase {
        OraclePhase::Phase1 => PHASE1_MAX_LEVERAGE_BPS.min(configured_max_bps),
        OraclePhase::Phase2 => PHASE2_MAX_LEVERAGE_BPS.min(configured_max_bps),
        OraclePhase::Phase3 => configured_max_bps,
    }
}
```

---

## 7. Phase Transition Logic (On-Chain, Lazy)

```rust
pub fn compute_oracle_phase(&self, current_slot: u64) -> OraclePhase {
    let age = current_slot.saturating_sub(self.market_created_slot);
    
    if age >= PHASE2_SLOTS 
        || self.cumulative_volume_usd_e6 >= PHASE2_VOL_THRESHOLD_E6 
    {
        OraclePhase::Phase3
    } else if age >= PHASE1_SLOTS {
        OraclePhase::Phase2
    } else {
        OraclePhase::Phase1
    }
}

/// Called on every instruction that touches OI/leverage.
/// Updates stored `oracle_phase` if transition has occurred (for indexers/UI).
pub fn maybe_advance_phase(&mut self, current_slot: u64) {
    let new_phase = self.compute_oracle_phase(current_slot);
    let new_u8 = new_phase as u8;
    if new_u8 > self.oracle_phase {
        self.oracle_phase = new_u8;
        // emit OraclePhaseTransition event (via log_msg)
    }
}
```

**Lazy vs eager:** Transition is computed inline on every relevant instruction. No separate `AdvancePhase` crank instruction needed. The stored `oracle_phase` byte is for indexer/UI convenience only — the authoritative state is always recomputed from `market_created_slot` + `cumulative_volume_usd_e6` + `current_slot`.

---

## 8. Instruction Changes

### `InitMarket` (new fields)
```text
phase1_oracle_authority: [u8; 32]
phase1_anchor_price_e6: u64
phase1_anchor_timestamp: i64
phase2_switchboard_feed: [u8; 32]  // optional, zeros = not available
```

### `TradeCpi` / `TradeNoCpi`
1. Call `maybe_advance_phase(current_slot)` before OI/leverage validation
2. Fetch oracle price via phase-appropriate logic
3. Check leverage: `margin_ratio_bps ≥ 10_000 / max_leverage_bps(phase, configured)`
4. Check OI: `new_oi ≤ effective_oi_cap_e6(vault_balance, current_slot, oracle_price)`

### No new instruction needed for transition
Transitions are fully automatic on-chain via the lazy `maybe_advance_phase` call.

---

## 9. Kani Proof Strategy

### 9.1 Proof targets

| Harness | What it proves |
|---|---|
| `proof_oracle_phase_monotone` | `compute_oracle_phase` is non-decreasing: if phase=X at slot S, then phase ≥ X at slot S+k for all k≥0 |
| `proof_phase_oi_cap_decreasing` | OI cap in Phase 1 ≤ Phase 2 ≤ Phase 3 (relative to vault) |
| `proof_phase_leverage_cap_decreasing` | Leverage in Phase 1 ≤ Phase 2 ≤ Phase 3 (relative to configured max) |
| `proof_phase1_oi_cap_bounded` | When phase=1, `effective_oi_cap_e6` ≤ `PHASE1_OI_CAP_E6` for all symbolic vault/price values |
| `proof_phase2_oi_cap_bounded` | When phase=2, cap ≤ `PHASE2_OI_CAP_E6` |
| `proof_no_phase_regression` | `maybe_advance_phase` never decrements `oracle_phase` |
| `proof_vol_threshold_triggers_phase3` | If `cumulative_volume_usd_e6 ≥ PHASE2_VOL_THRESHOLD_E6`, phase is always ≥ 2 regardless of slot age |
| `proof_phase_transition_preserves_invariant` | `canonical_inv()` holds after `maybe_advance_phase` + trade sequence |

### 9.2 Key proof sketch (phase monotonicity)
```rust
#[cfg(kani)]
#[kani::proof]
fn proof_oracle_phase_monotone() {
    let market_created_slot: u64 = kani::any();
    let cumulative_volume: u64 = kani::any();
    let slot_a: u64 = kani::any();
    let delta: u64 = kani::any();
    
    kani::assume(slot_a >= market_created_slot);
    kani::assume(delta > 0);
    kani::assume(delta <= u64::MAX - slot_a);
    
    let slot_b = slot_a + delta;
    
    let config = MockMarketConfig {
        market_created_slot,
        cumulative_volume_usd_e6: cumulative_volume,
    };
    
    let phase_a = config.compute_oracle_phase(slot_a) as u8;
    let phase_b = config.compute_oracle_phase(slot_b) as u8;
    
    // Phase can only advance forward
    assert!(phase_b >= phase_a, "Oracle phase regressed!");
}
```

### 9.3 Vacuity protection
All harnesses use `kani::assert` (not just post-condition assume) and include at least one positive + one boundary case as concrete sub-tests to confirm the prover reaches the assertion site.

---

## 10. Open Questions for PM Review

1. **Phase 1 oracle authority:** Should this be a single global Percolator keeper pubkey (config constant) or set per-market at InitMarket? Per-market gives more flexibility for third-party market creators but adds complexity.

2. **Phase 2 Hyperp mark price:** Is the Hyperp oracle an on-chain account we can read CPIs to, or is it pushed by a keeper? Need the Hyperp oracle integration spec.

3. **cumulative_volume_usd_e6 currency:** Volume is tracked in collateral units. Do we need a reference price to convert to USD? Recommend tracking in collateral units and using a constant multiplier (e.g., 1 USDC = $1) to keep it simple and manipulation-resistant.

4. **Phase 1 deviation bound:** 50% max deviation from anchor price feels loose. Confirm acceptable threshold (could tighten to 20-30% for pump.fun tokens which are volatile but not 50% in one update).

5. **Migration:** Existing devnet markets should default to Phase 3. Propose adding a one-time `MigrateMarketPhase` instruction (admin-only, only callable once, sets `oracle_phase = 2` for pre-existing markets).

---

## 11. Implementation Plan (post design-doc approval)

1. **Phase 1 (2d):** Add new fields to `MarketConfig`, implement `compute_oracle_phase` + `maybe_advance_phase`, update `InitMarket` parser, write Kani harnesses
2. **Phase 2 (1d):** Wire phase-gated OI cap into trade validation in percolator-prog
3. **Phase 3 (1d):** Wire phase-gated leverage cap into trade decision logic  
4. **Phase 4 (1d):** Integration tests + Kani proof run
5. **Phase 5 (0.5d):** Update keeper to push phase-appropriate oracle price

**Total estimate:** ~5.5 days (XL effort confirmed)

---

## 12. Files to Modify

| File | Change |
|---|---|
| `percolator-prog/src/percolator.rs` | Add fields to `MarketConfig`, add `OraclePhase` enum, `compute_oracle_phase`, `maybe_advance_phase`, `effective_oi_cap_e6`, `max_leverage_bps`, update `TradeCpi`/`TradeNoCpi` dispatch, update `InitMarket` |
| `percolator/src/percolator.rs` | Add `max_leverage_bps` guard to core trade validation if leverage is enforced in core |
| `percolator-prog/tests/kani.rs` | Add 8 new Kani harnesses |
| `docs/PERC-622-oracle-phase-transition-design.md` | This file |
