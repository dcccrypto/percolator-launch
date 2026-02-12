# Percolator Stress Testing Plan — Feb 12, 2026

**Goal:** Validate our implementation against Toly's 15 stress test scenarios  
**Timeline:** Before mainnet deployment  
**Owner:** Cobra + Khubair

---

## Problem

Toly's stress test suite (https://github.com/aeyakovenko/percolator-stress-test) is Rust code that tests the Percolator risk engine directly. We can't run it against our TypeScript/Solana implementation.

**Solution:** Manual testing on devnet + automated integration tests

---

## Phase 1: Manual Devnet Validation (Tonight/Tomorrow)

### Scenario 2: Flash Crash + Recovery

**Setup:**
1. Pick a devnet market (e.g., SOL)
2. Create 10 test positions:
   - 5 long 2x leverage
   - 5 short 2x leverage
   - Record initial capital, PnL, residual

**Execute:**
```bash
# 1. Crash price -40% (via admin oracle update)
# 2. Wait 10 slots
# 3. Crank (trigger liquidations)
# 4. Bounce price +30%
# 5. Wait 20 slots
# 6. Crank again
```

**Measure:**
- [ ] Haircut (h) drops during crash
- [ ] Liquidations triggered correctly
- [ ] Insurance fund (residual) decreases
- [ ] h recovers after bounce
- [ ] No protocol insolvency

**Expected Result:**
- h drops to ~0.7-0.8 during crash
- Longs liquidated, shorts profitable
- h recovers to ~0.9+ after bounce
- Residual decreases but remains positive

---

### Scenario 7: Directional Skew (90% Longs)

**Setup:**
1. Create 18 long positions, 2 short
2. All 2x-5x leverage
3. Record initial state

**Execute:**
```bash
# 1. Crash price -30%
# 2. Crank (trigger liquidations)
```

**Measure:**
- [ ] Mass liquidation of longs
- [ ] h drops significantly (more than balanced scenario)
- [ ] Insurance fund heavily used
- [ ] Shorts remain solvent

**Expected Result:**
- h drops to ~0.5-0.6 (worse than balanced)
- 16+ longs liquidated
- Residual significantly reduced
- Demonstrates skew risk

---

## Phase 2: Automated Tests (This Week)

Create integration tests in `/packages/server/tests/stress/`:

### Test 1: Flash Crash
```typescript
describe('Stress: Flash Crash', () => {
  it('should handle 40% drop + 30% bounce', async () => {
    // Setup 10 positions
    // Crash oracle -40%
    // Crank
    // Assert liquidations
    // Assert h < 1.0
    // Bounce +30%
    // Crank
    // Assert h recovers
    // Assert residual > 0
  });
});
```

### Test 2: No Insurance
```typescript
describe('Stress: No Insurance', () => {
  it('should haircut profits when insurance = 0', async () => {
    // Create market with insurance = 0
    // Create profitable positions
    // Crash -30%
    // Assert h drops immediately
    // Assert profits take haircut
    // Assert no insolvency (principal protected)
  });
});
```

### Test 3: Keeper Lag
```typescript
describe('Stress: Keeper Lag', () => {
  it('should accumulate bad debt when crank delayed', async () => {
    // Create undercollateralized positions
    // Crash -30%
    // Wait 5 slots WITHOUT cranking
    // Assert PnL accumulates
    // Crank
    // Assert liquidations delayed
    // Assert worse h than immediate crank
  });
});
```

---

## Phase 3: Production Monitoring (Post-Mainnet)

### Dashboard Metrics

Add to Railway backend `/health` endpoint:

```json
{
  "risk_metrics": {
    "SOL": {
      "haircut": 0.98,  // h value
      "residual": "15000000000",  // Insurance fund
      "directional_skew": 0.65,  // 65% long bias
      "largest_position_pct": 0.12,  // Whale risk
      "avg_leverage": 3.2
    }
  }
}
```

### Alerts

**Critical (h < 0.5):**
- Pause trading
- Alert Discord/Telegram
- Manual intervention required

**Warning (h < 0.8):**
- Alert team
- Monitor closely
- Reduce max leverage

**Risk (skew > 80%):**
- Alert team
- Consider incentivizing opposite side
- Increase margin requirements

---

## Phase 4: Quarterly Stress Tests

**Every 3 months after mainnet:**

1. Run full 15-scenario suite manually
2. Document worst-case h per market
3. Adjust risk parameters if needed:
   - Initial margin requirements
   - Maintenance margin
   - Max leverage
   - Max position size
4. Publish results (transparency)

---

## Immediate Actions (Tonight)

### Step 1: Manual Flash Crash Test (30 min)

```bash
# 1. SSH into your machine
cd /path/to/percolator-launch

# 2. Create test positions on devnet
# (Use app UI or SDK)

# 3. Crash oracle (admin function)
# (Via app admin panel or SDK)

# 4. Monitor crank logs
tail -f logs/crank.log

# 5. Check residual/haircut
curl https://percolator-api-production.up.railway.app/markets/<market_address>
```

**Document:**
- Screenshot initial state
- Screenshot crashed state
- Screenshot recovered state
- Note h values, liquidations, residual changes

### Step 2: Create Test Script (1 hour)

```typescript
// scripts/stress-test-flash-crash.ts
import { Connection, Keypair } from '@solana/web3.js';
import { createMarket, createPosition, crashOracle, crank } from './lib';

async function testFlashCrash() {
  // 1. Setup
  const market = await createMarket({ symbol: 'TEST' });
  const positions = await createTestPositions(market);
  
  // 2. Record baseline
  const baseline = await getMarketState(market);
  console.log('Baseline h:', baseline.haircut);
  
  // 3. Crash
  await crashOracle(market, -40);
  await sleep(10_000); // 10 slots
  await crank(market);
  
  // 4. Measure crash
  const crashed = await getMarketState(market);
  console.log('Crashed h:', crashed.haircut);
  console.log('Liquidations:', crashed.liquidations);
  
  // 5. Bounce
  await crashOracle(market, +30);
  await sleep(20_000); // 20 slots
  await crank(market);
  
  // 6. Measure recovery
  const recovered = await getMarketState(market);
  console.log('Recovered h:', recovered.haircut);
  
  // 7. Assert
  assert(crashed.haircut < baseline.haircut);
  assert(recovered.haircut > crashed.haircut);
  assert(recovered.residual > 0);
}
```

---

## Questions for Khubair

1. **Priority:** Manual test tonight or automated tests first?
2. **Market:** Which devnet market to use for testing? (SOL? Create fresh test market?)
3. **Admin access:** Do we have oracle update authority on devnet markets?
4. **Timeline:** How urgent? (Toly tweeted this → implies we should test ASAP)
5. **Scope:** All 15 scenarios or just critical ones (2, 7, 12)?

---

## Expected Outcomes

### ✅ If Tests Pass
- Confidence in risk engine
- Document results publicly
- Tweet: "Ran Toly's stress tests on devnet. h behaved as expected. Zero insolvencies. Insurance fund worked."
- Ship mainnet with confidence

### ❌ If Tests Fail
- Identify bugs BEFORE mainnet
- Fix risk engine issues
- Re-test until passing
- Delay mainnet if critical failures

---

## Resources Needed

1. **Devnet SOL:** Faucet for test transactions
2. **Admin keys:** Oracle update authority
3. **Time:** 30 min manual test + 4h automated tests
4. **Documentation:** Screenshots + metrics

---

## Bottom Line

**Toly created these stress tests for a reason.** If we're building on Percolator, we need to validate our implementation handles these scenarios.

**Option A (Fast):** Manual flash crash test tonight (30 min)  
**Option B (Thorough):** Full automated test suite this week (1-2 days)  
**Option C (Both):** Manual tonight to validate quickly, automated for CI

**What's the call?**
