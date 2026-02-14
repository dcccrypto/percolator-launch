# Hidden Features Analysis - Percolator

**Found:** Production-ready features in Toly's code that exist on-chain but aren't exposed in UI

**Method:** Systematic analysis of RiskEngine struct + test suite

---

## 🔥 HIGH IMPACT (Implement These)

### 1. **PNL Warmup Period** ⭐⭐⭐

**What it is:**
- When you close a profitable position, profits are "locked" for ~1000 slots (~8 minutes)
- Gradually "warms up" and becomes withdrawable over time
- Prevents oracle manipulation attacks (open position → manipulate oracle → close → instant withdraw)

**On-chain state:**
```rust
pub warmup_started_at_slot: u64,        // When warmup began
pub warmup_slope_per_step: U128,        // Vesting rate per slot
pub warmup_period_slots: u64,           // Total warmup duration (config)
```

**Currently showing:** NOTHING ❌

**What we should show:**
- Position panel: "Profit Warming Up: $123.45 (75% unlocked)"
- Progress bar showing warmup completion
- Countdown: "Fully withdrawable in 3m 42s"
- Explainer: "Warmup protects against oracle manipulation"

**Test evidence:**
- `test_attack_warmup_prevents_immediate_profit_withdrawal` ✅
- `test_attack_warmup_zero_period_instant` ✅
- `test_zombie_pnl_crank_driven_warmup_conversion` ✅

**Hackathon angle:**
> "Most perp DEXs are vulnerable to oracle manipulation. Percolator has PNL warmup built-in—profits lock for 8 minutes, giving the market time to react. 145 Kani proofs guarantee this can't be bypassed. We're the only permissionless perp DEX with oracle attack protection baked into every trade."

---

### 2. **Total Open Interest** ⭐⭐

**What it is:**
- Sum of absolute position sizes across all accounts
- Real-time measure of total risk exposure in the system
- Critical for understanding market depth

**On-chain state:**
```rust
pub total_open_interest: U128,  // Σ |position_size|
```

**Currently showing:** Partially (might be in market browser, not on trade page)

**What we should show:**
- Market stats card: "Total OI: $5.2M"
- Historical OI chart (24h)
- OI vs liquidity ratio (health metric)
- Breakdown: Long OI vs Short OI

**Why it matters:**
- Traders want to know if market is deep enough
- LPs want to know their risk exposure
- Helps identify which markets are actually being used

---

### 3. **Insurance Fund Health** ⭐⭐

**What it is:**
- Safety net that protects LPs from bankruptcy
- Accumulates from trading fees + liquidation fees
- Can be topped up by anyone (community insurance!)

**On-chain state:**
```rust
pub struct InsuranceFund {
    pub balance: U128,       // Current insurance balance
    pub fee_revenue: U128,   // Accumulated trading fees
}
```

**Currently showing:** Balance only (in some places)

**What we should show:**
- Insurance fund dashboard:
  - Current balance (in USD)
  - Fee revenue accumulation rate
  - Insurance ratio (insurance / total_risk)
  - Historical balance chart
  - "Top Up Insurance" button (anyone can contribute!)
- Health indicator: 🟢 Healthy / 🟡 Low / 🔴 Critical

**Test evidence:**
- `test_comprehensive_insurance_fund_topup` ✅
- `test_attack_trading_fee_insurance_conservation` ✅
- `test_insurance_fund_traps_funds_preventing_closeslab` ✅

**Hackathon angle:**
> "Insurance funds are invisible on most DEXs. Percolator makes it transparent—see exactly how protected your positions are. And here's the kicker: Anyone can top up the insurance fund. Community-funded safety nets for permissionless markets."

---

### 4. **Maintenance Fee Drain** ⭐

**What it is:**
- Inactive accounts pay small fees per slot
- Prevents "zombie accounts" from cluttering state
- Fees go to insurance fund

**On-chain state:**
```rust
pub maintenance_fee_per_slot: U128,  // Config param
pub fee_credits: I128,               // Per-account fee balance
pub last_fee_slot: u64,              // Last time fees were charged
```

**Currently showing:** NOTHING ❌

**What we should show:**
- Account panel: "Maintenance fees: $0.12/day"
- Fee credit balance: "Prepaid fees: $2.50 (20 days remaining)"
- Warning: "Low fee balance - account may be closed"

**Why it matters:**
- Users don't know they're being charged
- Prevents surprise account closures
- Opportunity to explain fee→insurance flow

---

### 5. **Lifetime Liquidation Stats** ⭐

**What it is:**
- Running counter of total liquidations ever
- Running counter of force-realize closes
- Shows how battle-tested the market is

**On-chain state:**
```rust
pub lifetime_liquidations: u64,           // Total liq events
pub lifetime_force_realize_closes: u64,   // Total force-closes
```

**Currently showing:** NOTHING ❌

**What we should show:**
- Market stats: "Lifetime Liquidations: 1,234"
- Safety score: "0.05% of positions liquidated (healthy)"
- Recent activity: "3 liquidations in last 24h"

**Hackathon angle:**
> "Transparency breeds trust. We show you every liquidation that's ever happened. Low liquidation rate = healthy market. High rate = risky market. Other DEXs hide this data."

---

### 6. **LP Position Aggregates** ⭐⭐

**What it is:**
- Net LP position (drives funding rates)
- Sum of LP absolute positions
- Max LP position (risk exposure)

**On-chain state:**
```rust
pub net_lp_pos: I128,       // Net LP inventory (long/short)
pub lp_sum_abs: U128,       // Σ |lp_position|
pub lp_max_abs: U128,       // max(|lp_position|)
pub lp_max_abs_sweep: U128, // max during last sweep
```

**Currently showing:** NOTHING (except indirectly via funding rate)

**What we should show:**
- LP dashboard:
  - "Net LP Position: +1.2M (long)"
  - "Total LP Risk: $5.4M"
  - "Largest LP: $850K"
  - "LP Imbalance: 15% (healthy)"
- Chart: LP position over time

**Why it matters:**
- LPs want to understand their aggregate risk
- Connects to funding rate mechanism
- Shows market balance health

---

### 7. **Crank Staleness / Health** ⭐

**What it is:**
- Markets have maximum "staleness" before crank is required
- Shows how recently market was updated
- Indicates if crank service is working

**On-chain state:**
```rust
pub last_crank_slot: u64,             // Last crank execution
pub max_crank_staleness_slots: u64,   // Max allowed staleness
pub current_slot: u64,                // Current blockchain slot
```

**Currently showing:** NOTHING ❌

**What we should show:**
- Health badge: "Last updated: 12s ago" 🟢
- Warning: "Stale market - crank needed!" 🔴
- Uptime: "99.8% crank reliability (14.5k cranks)"

---

### 8. **Risk Threshold / Safety Gating** ⭐

**What it is:**
- Dynamic risk gate that closes trading when insurance is low
- Prevents cascading failures
- EWMA-based threshold calculation

**On-chain state:**
```rust
pub risk_reduction_threshold: U128,   // Threshold value
pub c_tot: U128,                      // Total capital
pub pnl_pos_tot: U128,                // Total positive PnL
```

**Currently showing:** NOTHING ❌

**What we should show:**
- Market status: "Trading: Open" / "Risk Gate: CLOSED"
- Threshold indicator: "75% to risk threshold"
- Explainer: "Risk gate protects against cascading liquidations"

**Test evidence:**
- `test_critical_set_risk_threshold_authorization` ✅
- `test_attack_threshold_ewma_convergence` ✅
- `test_attack_risk_gate_exact_threshold_boundary` ✅

---

## 🔍 MEDIUM IMPACT (Nice to Have)

### 9. **Sweep Status**
- `last_full_sweep_start_slot`
- `last_full_sweep_completed_slot`
- `crank_cursor`, `sweep_start_idx`

Shows: Background maintenance progress

### 10. **Account Bitmap Usage**
- `used` bitmap array
- `num_used_accounts`
- `free_head`, `next_free`

Shows: Market capacity (how many slots filled)

### 11. **Fee Credits System**
- `fee_credits` per account
- Prepaid maintenance fees

Shows: Account health before auto-close

---

## 📊 PRIORITY IMPLEMENTATION ORDER

1. **PNL Warmup** ⭐⭐⭐ - HUGE differentiator, zero competition
2. **Total Open Interest** ⭐⭐ - Standard metric, easy win
3. **Insurance Fund Dashboard** ⭐⭐ - Transparency + community top-ups
4. **LP Aggregates** ⭐⭐ - Critical for understanding funding
5. **Lifetime Stats** ⭐ - Trust-building
6. **Crank Health** ⭐ - Infrastructure transparency
7. **Maintenance Fees** ⭐ - User education
8. **Risk Gating** ⭐ - Safety story

---

## 🎯 HACKATHON IMPACT

### Current Pitch:
> "Only permissionless perp DEX with funding rates"

### Enhanced Pitch:
> "Only permissionless perp DEX with:
> - ✅ Funding rates (inventory-based, automatic)
> - ✅ PNL warmup (oracle manipulation protection)
> - ✅ Transparent insurance (community-funded safety)
> - ✅ Risk gating (prevents cascading failures)
> - ✅ 145 Kani formal proofs (zero bugs)
>
> Not just permissionless. Production-grade permissionless."

---

## 🚀 NEXT STEPS

1. **Validate with Khubair** - Which features matter most?
2. **Prioritize for Feb 18** - Can't build all 8 in 3 days
3. **Backend first** - StatsCollector already reads RiskEngine
4. **UI components** - Reuse patterns from funding rate work
5. **Documentation** - Each feature needs explainer

---

**The pattern is clear:** Toly built production infrastructure. We're showing 20% of it. The other 80% is sitting there, tested, proven, invisible.

**Time to surface it.**
