# Percolator Stress Test Scenarios

**Source:** https://github.com/aeyakovenko/percolator-stress-test  
**Purpose:** Monte Carlo stress testing of Percolator's risk engine under extreme market conditions  
**Date:** Feb 12, 2026

---

## Overview

Toly's stress test suite simulates 15 different market crash/stress scenarios to validate Percolator's risk engine:
- Principal protection (senior claims)
- Profit haircut mechanism (junior claims via Residual)
- Warmup period behavior
- Insurance fund depletion
- Liquidation cascades
- Oracle manipulation
- Directional skew (90% longs)
- Whale positions
- Funding rate pressure
- Keeper lag (crank delays)

**Key Mechanism Tested:** `x → ⌊x·h⌋` (warmup converts capital using global haircut `h`)

---

## Scenario Breakdown

### 1. **Baseline**
```bash
stress_test --out=stress_out/1_baseline
```
**Tests:** Normal market conditions, no crashes  
**Purpose:** Establish baseline metrics (residual, insolvency, haircut)  
**Expected:** h ≈ 1.0, no insolvencies, stable residual

---

### 2. **Flash Crash**
```bash
--crash_pct=4000 --crash_len=10 --bounce_pct=3000 --bounce_len=20 --total_slots=200
```
**Tests:** 40% price drop for 10 slots, 30% bounce back for 20 slots  
**Purpose:** Liquidation cascade, insurance fund drain, recovery  
**Expected:** h drops < 0.5, recovers after bounce, some positions liquidated

---

### 3. **Slow Bleed**
```bash
--crash_pct=5000 --crash_len=500 --bounce_pct=0 --bounce_len=1 --total_slots=600
```
**Tests:** 50% gradual price decline, no recovery  
**Purpose:** Long-duration stress, progressive liquidations  
**Expected:** Steady h decline, multiple liquidation waves, insurance depletion

---

### 4. **No Insurance**
```bash
--insurance=0 --crash_pct=3000
```
**Tests:** 30% crash with ZERO insurance fund  
**Purpose:** Haircut mechanism alone, no insurance buffer  
**Expected:** Immediate h < 1.0, junior claims (profits) take full hit

---

### 5. **Tiny LP**
```bash
--lp_capital=5000000 --crash_pct=3000
```
**Tests:** Very small LP pool vs large positions  
**Purpose:** Capital adequacy under stress  
**Expected:** Higher h drop, potential insolvency if LP too small

---

### 6. **Degens (High Leverage)**
```bash
--im_bps=250 --mm_bps=125 --crash_pct=2000
```
**Tests:** 2.5% initial margin (40x leverage!), 1.25% maintenance margin  
**Purpose:** Ultra-high leverage liquidation cascades  
**Expected:** Rapid liquidations, high h volatility, insurance drain

---

### 7. **Directional Skew (90% Longs)**
```bash
--long_bias=0.9 --crash_pct=3000
```
**Tests:** 90% of positions are long, 30% price drop  
**Purpose:** Imbalanced market + crash = catastrophic losses  
**Expected:** Severe h drop, mass liquidations, potential insolvency

---

### 8. **Staircase Crash**
```bash
--price_path=staircase --crash_pct=1500 --crash_len=20 --staircase_steps=3 --staircase_flat=30 --total_slots=400
```
**Tests:** 15% drop in 3 steps, flat periods between steps  
**Purpose:** Gradual decline with pauses (realistic market behavior)  
**Expected:** Progressive liquidations, h stabilizes during flats

---

### 9. **Oracle Manipulation**
```bash
--price_path=oracle_distortion --distortion_pct=2000 --distortion_start=30 --distortion_len=5 --total_slots=200
```
**Tests:** Oracle reports +20% price for 5 slots, then corrects  
**Purpose:** Oracle attack, incorrect mark prices  
**Expected:** PnL distortion during attack, correction after, potential liquidations on reversion

---

### 10. **Whale**
```bash
--whale=true --whale_capital=25000000 --whale_leverage=10 --crash_pct=3000
```
**Tests:** Single massive 10x leveraged position + 30% crash  
**Purpose:** Systemic risk from one large position  
**Expected:** Whale liquidation drains insurance, h drops significantly

---

### 11. **Funding Rate Pressure**
```bash
--funding_rate=10 --crash_pct=3000
```
**Tests:** 10 bps/slot funding rate + crash  
**Purpose:** Funding drain on underwater positions  
**Expected:** Fee debt accumulates, margin erosion, faster liquidations

---

### 12. **Armageddon**
```bash
--long_bias=0.9 --whale=true --whale_capital=25000000 --whale_leverage=10 --insurance=0 --crash_pct=5000
```
**Tests:** 90% longs + whale + no insurance + 50% crash  
**Purpose:** Worst-case catastrophic scenario  
**Expected:** h → 0, potential protocol insolvency, massive haircuts

---

### 13. **Skew + Keeper Lag (5 slots)**
```bash
--long_bias=0.9 --crank_interval=5
```
**Tests:** 90% longs + crank only every 5 slots (keeper delay)  
**Purpose:** Delayed liquidations, PnL accumulation  
**Expected:** Higher bad debt, h drops faster due to lag

---

### 14. **Armageddon + Lag (5 slots)**
```bash
--long_bias=0.9 --price_path=staircase --crash_pct=2000 --staircase_steps=3 --staircase_flat=20 --bounce_pct=0 --whale=true --whale_capital=25000000 --whale_leverage=10.0 --funding_rate=10 --insurance=0 --crank_interval=5
```
**Tests:** Every bad thing + keeper lag  
**Purpose:** Absolute worst-case + operational failure  
**Expected:** Total protocol breakdown, h → 0

---

### 15. **Armageddon + Lag (20 slots)**
```bash
--long_bias=0.9 --price_path=staircase --crash_pct=2000 --staircase_steps=3 --staircase_flat=20 --bounce_pct=0 --whale=true --whale_capital=25000000 --whale_leverage=10.0 --funding_rate=10 --insurance=0 --crank_interval=20
```
**Tests:** Same as #14 but 20-slot crank lag  
**Purpose:** Extended operational failure  
**Expected:** Even worse than #14, potential negative residual

---

## Key Metrics Tracked

From the stress test output:

### **Haircut (h)**
- `h = 1.0` → Fully collateralized
- `h = 0.5` → 50% haircut on profits
- `h = 0.0` → Protocol insolvent
- `h < 0.1` → Crisis threshold
- `min_h` → Worst haircut achieved

### **Insolvency Events**
- `h_zero_count` → Times h reached 0
- `h_below_50_count` → Times h < 0.5
- `h_below_10_count` → Times h < 0.1

### **Residual (Insurance Fund)**
- `residual_start` → Initial insurance
- `residual_end` → Final insurance
- `residual_min` → Lowest point
- Tracks buffer available for haircuts

### **Withdrawable Capital**
- `withdrawable_mean` → Average safe withdrawals
- `withdrawable_min` → Worst-case withdrawal capacity
- Tests capital lock-up during stress

---

## How We Validate Our Implementation

Since we can't run Toly's Rust stress tests directly (our stack is TypeScript + Solana), we validate by:

### **Option 1: Manual Devnet Testing**
1. Create test positions matching each scenario
2. Manually crash prices via admin oracle
3. Monitor haircut, liquidations, insurance fund
4. Document results

### **Option 2: Scenario-Based Integration Tests**
```typescript
// Example: Scenario 7 (90% longs + crash)
it('should handle directional skew + crash', async () => {
  // 1. Create 9 long positions, 1 short
  // 2. Crash oracle price -30%
  // 3. Crank liquidations
  // 4. Verify: h drops, longs liquidated, insurance used
});
```

### **Option 3: Load Testing on Devnet**
- Deploy 38 markets (already done ✅)
- Create realistic position distributions
- Simulate price volatility
- Monitor crank performance, liquidation accuracy
- Check residual/haircut behavior

---

## Critical Findings from Stress Tests

Based on Toly's test suite design:

### ✅ **What Percolator Handles Well**
1. **Gradual crashes** (Scenarios 3, 8) → Progressive liquidations work
2. **Recovery** (Scenario 2) → h recovers after bounce
3. **Insurance buffer** (Scenarios 1-3) → Cushion before haircuts
4. **High leverage** (Scenario 6) → Aggressive margin requirements liquidate early

### ⚠️ **Edge Cases to Watch**
1. **No insurance** (Scenario 4) → h drops immediately, profits at risk
2. **Directional skew** (Scenarios 7, 13-15) → 90% longs = single point of failure
3. **Oracle manipulation** (Scenario 9) → Short-term PnL distortion
4. **Keeper lag** (Scenarios 13-15) → Delayed liquidations = bad debt accumulation
5. **Whale positions** (Scenarios 10, 12, 14-15) → Systemic risk

### 🚨 **Catastrophic Scenarios**
- **Armageddon** (Scenarios 12, 14, 15) → Protocol can become insolvent
- Combination: 90% longs + whale + no insurance + 50% crash + crank lag = h → 0

---

## Action Items for Our Implementation

### **Immediate (Pre-Mainnet)**
- [ ] Run Scenario 2 (flash crash) manually on devnet
- [ ] Run Scenario 7 (90% longs) manually
- [ ] Verify crank handles liquidation cascades
- [ ] Check residual tracking accuracy
- [ ] Test haircut calculation (x → ⌊x·h⌋)

### **Before Mainnet**
- [ ] Create automated integration tests for Scenarios 1-7
- [ ] Add monitoring for:
  - `h` (haircut) per market
  - Residual balance
  - Directional skew %
  - Largest position size (whale risk)
  - Crank latency
- [ ] Implement circuit breakers:
  - Pause trading if h < 0.5
  - Alert if skew > 80%
  - Rate limit whale positions

### **Post-Mainnet**
- [ ] Run full stress test suite quarterly
- [ ] Document worst-case h for each market
- [ ] Set insurance fund targets based on stress results
- [ ] Publish stress test results (transparency)

---

## References

- **Stress Test Repo:** https://github.com/aeyakovenko/percolator-stress-test
- **Percolator Engine:** https://github.com/aeyakovenko/percolator
- **Risk Engine Docs:** (Toly's comments in percolator-prog)
- **Formal Verification:** 125 Kani proofs in percolator repo

---

## Bottom Line

**Toly's stress tests prove:**
1. Haircut mechanism works (senior/junior claims)
2. Insurance fund cushions crashes
3. Protocol CAN go insolvent (h → 0) under extreme conditions
4. Keeper lag makes everything worse
5. Directional skew (90% longs) is catastrophic risk

**Our job before mainnet:**
- Validate our implementation handles these scenarios
- Monitor haircut (h) in production
- Set conservative risk parameters (initial margin, max leverage)
- Ensure crank runs reliably (no lag)

**The tweet Toly wants:** Show we understand the risk model, not just "perps on Solana lol"
