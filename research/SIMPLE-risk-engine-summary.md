# Percolator Risk Engine - Simple Summary

**What this is:** Research on how to make Percolator safer and better than Drift/Jupiter/Mango before mainnet launch.

---

## The Big Finding

**Percolator is the ONLY truly permissionless perp DEX on Solana.**

- **Drift:** Requires team approval to add new markets
- **Jupiter:** Same - team controls everything
- **Mango:** Governance vote needed for new assets

**Percolator:** Anyone can create a market for any token. That's the edge.

---

## The Trade-Off

**Good:** Mathematically proven safe (145 Kani proofs), no admin keys, can't rug  
**Bad:** Winners can't immediately withdraw 100% of profits (haircut mechanism feels punitive)

Users want safety AND freedom. Right now they get safety but feel restricted.

---

## Top 5 Fixes for Feb 18 Launch

### 1. Add Pyth Oracle Integration
**What:** Use Pyth Network for real-time price feeds  
**Why:** Right now there's no oracle fallback if price data is stale  
**How:** Check if Pyth price is <1 second old + confidence interval >80%  
**Impact:** Prevents price manipulation attacks

### 2. Asset-Specific Risk Parameters
**What:** Different margin requirements for different tokens  
**Why:** Bitcoin is safer than a random memecoin  
**How:**
- BTC/ETH/SOL: 10% margin (10x leverage max)
- Established alts: 15% margin (6.67x leverage)
- Permissionless markets: 20% margin (5x leverage)

**Impact:** More capital efficient for safe assets, protected against risky ones

### 3. Partial Liquidation
**What:** Try to liquidate 50% of position before nuking the whole thing  
**Why:** Full liquidation is brutal - kills positions that could recover  
**How:** Liquidate in stages:
- 50% at 90% maintenance margin
- 75% at 95% maintenance margin  
- 100% at 100% maintenance margin

**Impact:** Fewer angry users, more positions saved

### 4. Funding Rates
**What:** Hourly fee that balances longs vs shorts  
**Why:** Keeps perp price close to spot price  
**How:** If longs > shorts, longs pay shorts (and vice versa)  
**Formula:** `funding_rate = (perp_price - spot_price) / spot_price * 0.01`

**Impact:** Arbitrageurs keep prices honest

### 5. Market Creation Bonds
**What:** Require 1000 USDC deposit to create a market  
**Why:** Prevents spam markets (memecoins with no liquidity)  
**How:**
- Pay 1000 USDC to create market
- Get it back after 30 days if market has >$10k volume
- Lose it if market is spam

**Impact:** Only serious markets get created

---

## Why Percolator is Different

| Feature | Drift | Jupiter | Mango | Percolator |
|---------|-------|---------|-------|------------|
| **Permissionless markets** | ❌ | ❌ | ❌ | ✅ |
| **Coin-margined** | ❌ | ❌ | ❌ | ✅ |
| **No admin keys** | ❌ | ❌ | ❌ | ✅ |
| **Mathematical proofs** | ❌ | ❌ | ❌ | ✅ (145 Kani proofs) |
| **Insurance fund** | ✅ | ✅ | ✅ | ⚠️ (needs building) |

---

## How Other DEXs Handle Risk

### Drift
- Uses insurance fund ($5M+) to cover bad debt
- Partial liquidations (25% chunks)
- Pyth oracles with 1-second updates
- Cross-margin (use SOL collateral for BTC perps)

### Jupiter
- JLP liquidity pool backs all trades
- Oracle-based pricing (no AMM)
- Max 100x leverage (risky!)
- Simple: open/close, no fancy features

### Mango
- Health-based system (like Aave)
- Multi-collateral (use any token as margin)
- Advanced: limit orders, stop losses
- Complex risk calculation (hard to audit)

---

## What Needs to Happen Now

### Before Feb 18 (Pump.fun Hackathon)
1. ✅ **Pyth oracle integration** (critical)
2. ✅ **Asset-specific margins** (easy win)
3. ⚠️ **Partial liquidation** (medium difficulty)
4. ⚠️ **Funding rates** (medium difficulty)
5. ⚠️ **Market creation bonds** (easy but needs UI)

### After Mainnet Launch
6. Cross-margining (let users use multiple assets as collateral)
7. Insurance fund auto-replenishment (10-20% of fees)
8. Real-time risk dashboard (show `h` ratio, top positions, oracle health)
9. Gradual liquidation for whales (>$100k positions)
10. Socialized loss caps (max 5% haircut per event)

---

## The Pitch for Feb 18

**Percolator = First truly permissionless perp DEX on Solana**

- Anyone can create a market for any token
- No admin keys = can't rug
- Mathematically proven safe (145 Kani proofs)
- Coin-margined = no USDC dependency

**The competition (Drift/Jupiter/Mango):**
- Require team approval for new markets
- Centralized control
- No formal safety proofs

**The narrative:** "Percolator is to perps what Uniswap was to spot trading — permissionless, trustless, unstoppable."

---

## Questions to Answer

1. **How do we make haircuts feel less punitive?**
   - Show users their "available profit" clearly
   - Let them withdraw partial profits more frequently
   - Make the UX explain WHY haircuts exist (safety)

2. **How do we prevent spam markets?**
   - Market creation bond (1000 USDC)
   - Require minimum liquidity commitment
   - Auto-delist if no volume after 7 days

3. **How do we compete with Drift's deep liquidity?**
   - Bootstrap liquidity via incentives (tokens, fee rebates)
   - Partner with market makers
   - Start with high-volume pairs (SOL, BTC, ETH)

4. **What if oracle fails?**
   - Fallback to TWAP (30-second average)
   - Circuit breaker if Pyth confidence <80%
   - Pause trading if no price update >10 seconds

---

## Bottom Line

Percolator has a **massive competitive advantage** (permissionless markets) but needs **better UX around safety features**.

The 5 fixes above make it:
1. Safer (oracles, partial liquidations)
2. More capital efficient (asset-specific margins)
3. More balanced (funding rates)
4. Less spammy (creation bonds)

Ship these before Feb 18 and you have a killer demo for the hackathon.

---

**Full technical report:** 77KB with Rust code examples, risk formulas, and competitor deep dives. This summary is the TL;DR.
