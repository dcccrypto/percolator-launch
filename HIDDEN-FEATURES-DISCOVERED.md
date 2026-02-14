# 🔥 Hidden Features Discovered in Toly's RiskEngine

**Discovery Date**: Feb 14, 2026 17:22 UTC  
**Source**: `/mnt/volume-hel1-1/toly-percolator/src/percolator.rs` (line 291)  
**Impact**: 10+ production-ready features already implemented, zero exposed in UI

---

## TL;DR

The RiskEngine tracks **extensive production-grade metrics** that no other perp DEX exposes:
- Real-time liquidation stats
- Insurance fund health
- Crank staleness monitoring
- LP aggregate analytics
- Force-realize events
- System-wide capital tracking

**All data is already on-chain. We just need to show it.**

---

## The Full List (Organized by Value)

### 🎯 Tier 1: Immediate Trader Value

#### 1. Total Open Interest
```rust
pub total_open_interest: U128
```
**What it is**: Sum of `abs(position_size)` across ALL accounts  
**Why traders care**: Measures total market risk exposure  
**UI**: Display on markets page: "Total OI: $X.XX"  
**Competitive edge**: Most DEXs don't show this

#### 2. Vault Balance
```rust
pub vault: U128
```
**What it is**: Total deposited funds backing all positions  
**Why traders care**: Shows market liquidity depth  
**UI**: "Total Liquidity: $X.XX" on market stats  
**Trust signal**: Higher vault = more confidence

#### 3. Liquidation Analytics
```rust
pub lifetime_liquidations: u64
pub liquidation_fee_bps: u64  // in params
pub liquidation_buffer_bps: u64  // in params
```
**What it is**: Counter of all liquidations + fee structure  
**Why traders care**: Shows market health (frequent liquidations = risky conditions)  
**UI**: 
- "Liquidations (24h): X"
- "Safety Buffer: X%"
- "Liquidation Fee: X%"

#### 4. Crank Staleness Monitoring
```rust
pub last_crank_slot: u64
pub max_crank_staleness_slots: u64
```
**What it is**: Real-time crank health  
**Why traders care**: Stale cranks = prices not updating = risky to trade  
**UI**: 
- "Last Update: X seconds ago"
- Status badge: 🟢 Fresh | 🟡 Stale | 🔴 Critical

---

### 💎 Tier 2: LP Value (Differentiation)

#### 5. LP Aggregate Analytics
```rust
pub net_lp_pos: I128       // Already used for funding
pub lp_sum_abs: U128       // Sum of all LP position sizes
pub lp_max_abs: U128       // Largest LP position
```
**What it is**: O(1) maintained aggregates of ALL LP positions  
**Why LPs care**: 
- `net_lp_pos` → Shows market imbalance (used for funding)
- `lp_sum_abs` → Total LP capital at risk
- `lp_max_abs` → Whale concentration risk

**UI** (LP Dashboard):
```
LP Market Health
├─ Net Position: +1,234 SOL (long bias)
├─ Total LP Risk: 15,678 SOL
├─ Largest LP: 5,432 SOL (34.6% of total)
└─ Your Share: 2.1%
```

#### 6. Insurance Fund Tracking
```rust
pub insurance_fund: InsuranceFund  // Entire struct available
```
**What it is**: Backstop for bad debt  
**Why LPs care**: Protects LPs from underwater positions  
**UI**: 
- "Insurance Fund: $X.XX"
- "Coverage Ratio: X%" (insurance / total_open_interest)

#### 7. Force Realize Events
```rust
pub lifetime_force_realize_closes: u64
pub force_realize_needed: bool  // from CrankOutcome
```
**What it is**: Emergency position closures when insurance low  
**Why LPs care**: Indicates system stress  
**UI**: 
- "Force Closes (lifetime): X"
- Alert banner when `force_realize_needed = true`

---

### 📊 Tier 3: Market Health (Trust Building)

#### 8. System Capital Aggregates
```rust
pub c_tot: U128          // Total capital across all accounts
pub pnl_pos_tot: U128    // Sum of all positive PnL
```
**What it is**: O(1) maintained system-wide stats  
**Why it matters**: Shows overall market health  
**UI**:
```
Market Overview
├─ Total Capital: $X.XX
├─ Positive PnL: $X.XX
└─ Market Efficiency: XX% (pnl_pos_tot / c_tot)
```

#### 9. Maintenance Fees
```rust
pub maintenance_fee_per_slot: U128  // in params
```
**What it is**: Ongoing fee per slot for open positions  
**Why traders care**: Hidden cost that compounds over time  
**UI**:
- "Holding Cost: X% per day"
- Position panel: "Estimated daily fee: $X.XX"

#### 10. Market Warmup Status
```rust
pub current_slot: u64
pub last_full_sweep_start_slot: u64
pub last_full_sweep_completed_slot: u64
```
**What it is**: Full account sweep tracking (for lp_max_abs reset, etc.)  
**Why it matters**: Shows crank activity frequency  
**UI**: "Last Full Sweep: X minutes ago"

---

## Why This Matters for Feb 18 Hackathon

### The Transparency Play

**Most perp DEXs hide this data.** Even Drift/Jupiter don't expose:
- Real-time liquidation counters
- Crank staleness monitoring
- LP concentration metrics
- Force-realize events

**Our pitch:**
> "We're not just permissionless. We're the ONLY perp DEX where you can actually see what's happening under the hood. No black boxes. No hidden risks. Every metric is on-chain and transparent."

### Quick Win Implementation

**Day 1-2** (Feb 15-16): Backend
- [ ] Extend StatsCollector to read ALL RiskEngine fields
- [ ] Add to market_stats table (migration 007)
- [ ] API endpoints: `/api/market-health/:slab`, `/api/lp-analytics/:slab`

**Day 3** (Feb 17): UI Components
- [ ] MarketHealthCard (OI, vault, liquidations, crank status)
- [ ] LPAnalyticsCard (net_lp_pos, lp_sum_abs, lp_max_abs, insurance)
- [ ] SystemMetricsCard (c_tot, pnl_pos_tot, force_realize)

**Day 4** (Feb 18): Demo Polish
- [ ] Add to trade page sidebar
- [ ] LP dashboard integration
- [ ] Documentation: docs/TRANSPARENCY.md

---

## Data Already Available

Every crank execution (14.5k so far) reads these values. We're already querying the RiskEngine. We just need to:
1. Store additional fields (8 lines of code in StatsCollector)
2. Expose via API (1 endpoint)
3. Display in UI (3 React components)

**This is 2-3 days of work for a MASSIVE competitive advantage.**

---

## The Full RiskEngine Struct (Reference)

```rust
pub struct RiskEngine {
    // Balances
    pub vault: U128,                              // ✅ Add to UI
    pub insurance_fund: InsuranceFund,            // ✅ Add to UI

    // Funding (already discovered)
    pub funding_index_qpb_e6: I128,               // ✅ Being added (PR in progress)
    pub last_funding_slot: u64,                   // ✅ Being added
    pub funding_rate_bps_per_slot_last: i64,      // ✅ Being added

    // Crank Health
    pub last_crank_slot: u64,                     // ✅ Add to UI
    pub max_crank_staleness_slots: u64,           // ✅ Add to UI

    // Open Interest
    pub total_open_interest: U128,                // ✅ Add to UI

    // Aggregates
    pub c_tot: U128,                              // ✅ Add to UI
    pub pnl_pos_tot: U128,                        // ✅ Add to UI

    // Liquidations
    pub lifetime_liquidations: u64,               // ✅ Add to UI
    pub lifetime_force_realize_closes: u64,       // ✅ Add to UI

    // LP Aggregates
    pub net_lp_pos: I128,                         // ✅ Being added (funding)
    pub lp_sum_abs: U128,                         // ✅ Add to UI
    pub lp_max_abs: U128,                         // ✅ Add to UI

    // Sweep Status
    pub last_full_sweep_start_slot: u64,          // 🤔 Maybe later
    pub last_full_sweep_completed_slot: u64,      // 🤔 Maybe later

    // Internal state (skip for now)
    pub liq_cursor: u16,
    pub gc_cursor: u16,
    pub crank_cursor: u16,
    pub sweep_start_idx: u16,
    pub lp_max_abs_sweep: U128,
    pub used: [u64; 64],
    pub num_used_accounts: u16,
    pub next_account_id: u64,
    pub free_head: u16,
    pub next_free: [u16; 4096],
    pub accounts: [Account; 4096],
}
```

---

## Implementation Priority (For Feb 18)

### Must Have (Core Differentiators)
1. ✅ **Funding rates** (already in progress)
2. **Total open interest** (1 field)
3. **Vault balance** (1 field)
4. **Liquidation counter** (1 field)
5. **Crank staleness** (2 fields, simple UI badge)

### Should Have (LP Value)
6. **LP aggregates** (lp_sum_abs, lp_max_abs)
7. **Insurance fund** (1 field)

### Nice to Have (Full Transparency)
8. **System aggregates** (c_tot, pnl_pos_tot)
9. **Force realize counter**
10. **Maintenance fees**

---

## Bottom Line

Funding rates were just the tip of the iceberg.

**Toly built a transparency machine.** Every metric a trader or LP could want is already tracked, proven by 145 Kani proofs, and updated every crank.

We just need to surface it.

**The hackathon pitch writes itself:**
> "Percolator: The only permissionless perp DEX where you can actually see everything. No admin keys. No black boxes. No surprises. Just transparent, provable risk management."

This is how we win.

---

**Next Steps:**
1. Create migration 007 (add RiskEngine fields to market_stats)
2. Update StatsCollector to read all fields
3. Build 3 UI components (MarketHealthCard, LPAnalyticsCard, SystemMetricsCard)
4. Demo script showing all metrics updating in real-time

**Timeline:** 3 days (Feb 15-17), polish on Feb 18.

Let's go. 🚀
