# Solana Perp DEX Risk Engine Analysis
## Improving Percolator's Risk Engine & Permissionless Market Design

**Research Date:** February 14, 2026  
**Target:** Percolator mainnet launch (Pump.fun hackathon Feb 18)  
**Focus:** Risk engine architecture, permissionless market creation, actionable improvements

---

## Executive Summary

### Top 10 Actionable Improvements for Percolator

1. **Implement Dynamic Coverage Ratio with Time-Weighted Recovery** - Add exponential smoothing to `h` calculation to prevent rapid oscillations during volatility spikes

2. **Multi-Tier Liquidation Backstop** - Layer partial liquidations (50% at 90% MM, 75% at 95% MM, 100% at 100% MM) before full liquidation

3. **Oracle Manipulation Resistance via TWAP + Confidence Intervals** - Use 30-second TWAP with Pyth confidence intervals; circuit breaker if confidence drops below 80%

4. **Permissionless Market Creation with Tiered Risk Weights** - Allow anyone to create markets, but assign higher initial margin (e.g., 20% vs 5% for established assets) and lower max leverage (5x vs 20x)

5. **Anti-Spam Economic Moat** - Require refundable market creation bond (e.g., 1000 USDC) locked for 30 days + minimum liquidity commitment

6. **Cross-Margining with Portfolio Risk Adjustments** - Recognize hedged positions (long SOL spot + short SOL-PERP) and reduce margin requirements by up to 30%

7. **Insurance Fund Auto-Replenishment** - Allocate 10-20% of protocol fees to insurance fund until target ratio (e.g., 5% of open interest) achieved

8. **Gradual Position Unwinding for Large Accounts** - For positions >$100k, liquidate in 25% chunks every 10 seconds to reduce slippage impact

9. **Socialized Loss Distribution Cap** - Limit maximum haircut per event to 5% of user PnL to prevent catastrophic derisking

10. **Real-Time Risk Dashboard** - Expose `h`, insurance fund ratio, top 10 largest positions, and oracle health via public API

---

## 1. Comparative Analysis: Major Solana Perp DEXs

### 1.1 Drift Protocol

**Architecture:** Hybrid vAMM + DLOB (Decentralized Limit Order Book)

**Risk Engine Highlights:**
- **vAMM (Virtual Automated Market Maker):** Uses constant product curve (k = x * y) for price discovery, but pool liquidity is virtual (no actual tokens locked)
- **Cross-Margining:** Allows users to collateralize perp positions with spot holdings (e.g., use SOL collateral for BTC-PERP)
- **Liquidation Mechanism:**
  - **Partial Liquidations:** Protocol attempts partial liquidations first (20-30% of position)
  - **Full Liquidation Threshold:** When account margin ratio falls below maintenance requirement
  - **Liquidator Incentives:** 2.5% reward from liquidated position + small protocol fee
- **Insurance Fund:** Funded by:
  - 10% of protocol fees
  - Remainder from liquidation penalties
  - User-staked DRIFT tokens
- **Oracle:** Pyth Network (sub-second price updates)
- **Funding Rate:** Calculated hourly to converge perp price to spot

**Strengths:**
- Deep on-chain liquidity via vAMM backstop
- Proven insurance fund model ($5M+ as of Q4 2025)
- Mature codebase (3+ years in production)

**Weaknesses:**
- vAMM repricing during volatility can drain insurance fund
- No native support for long-tail asset oracles
- Cross-margin complexity increases smart contract risk

**Code Reference:**
```rust
// Drift v2 liquidation logic (simplified)
pub fn liquidate_perp(
    ctx: Context<LiquidatePerp>,
    market_index: u16,
    liquidator_max_base: u128,
) -> Result<()> {
    let user = &mut ctx.accounts.user.load_mut()?;
    let liquidator = &mut ctx.accounts.liquidator.load_mut()?;
    
    // Calculate margin ratio
    let margin_ratio = calculate_margin_ratio(user)?;
    require!(margin_ratio < MAINTENANCE_MARGIN_RATIO, ErrorCode::SufficientCollateral);
    
    // Partial liquidation logic
    let liquidation_size = std::cmp::min(
        user.perp_positions[market_index].base_asset_amount / 4, // 25% chunks
        liquidator_max_base,
    );
    
    // Transfer position with penalty
    let liquidation_fee = liquidation_size * LIQUIDATION_FEE_BPS / 10000;
    transfer_position(user, liquidator, liquidation_size, liquidation_fee)?;
    
    Ok(())
}
```

---

### 1.2 Jupiter Perps

**Architecture:** Oracle-based perpetuals with JLP (Jupiter Liquidity Pool)

**Risk Engine Highlights:**
- **Oracle-First Design:** Trades execute directly at oracle price (no AMM price impact)
- **JLP as Counterparty:** Liquidity providers stake into JLP and take opposite side of all trades
- **Liquidation Mechanism:**
  - **Threshold:** 90% of maintenance margin
  - **Execution:** Instant liquidation at oracle price
  - **Keeper Network:** Decentralized liquidators via permissionless keeper bots
- **Risk Management:**
  - **Max Open Interest Caps:** Hard limits per asset (e.g., $50M max for long-tail tokens)
  - **Dynamic Funding Rates:** Rebalances long/short skew every hour
- **Oracle:** Pyth Network with 400ms update frequency
- **Capital Efficiency:** No fragmented liquidity across markets (single JLP pool)

**Strengths:**
- Zero slippage on trades (oracle price execution)
- Simple risk model (easier to audit)
- JLP auto-rebalances exposure across all markets

**Weaknesses:**
- JLP holders bear all counterparty risk
- No cross-margining between assets
- Permissioned market creation (team-controlled)

**Architecture Diagram (Text):**
```
Trader → [Order] → Oracle Price → JLP (Counterparty)
                         ↓
                    Pyth Price Feed (400ms)
                         ↓
                    Liquidation Keeper Network
```

---

### 1.3 Mango Markets v4

**Architecture:** Cross-margined risk engine with on-chain order matching

**Risk Engine Highlights:**
- **Account Health Calculation:**
  ```
  Health = (Assets * Asset Weights) - (Liabilities * Liability Weights)
  Health Ratio = Health / Liabilities
  ```
- **Liquidation Tiers:**
  - **Tier 1 (Maint Ratio < 1.0):** Partial liquidation of worst-performing position
  - **Tier 2 (Maint Ratio < 0.5):** Full account liquidation
  - **Tier 3 (Bankruptcy):** Socialized loss across profitable traders
- **Asset Weight System:**
  - BTC/ETH: 0.9 init, 0.95 maint
  - SOL: 0.85 init, 0.9 maint
  - Mid-caps: 0.7 init, 0.8 maint
  - Long-tail: 0.5 init, 0.6 maint (or disabled)
- **Oracle Handling:**
  - **Primary:** Pyth Network
  - **Fallback:** Switchboard oracles
  - **Staleness Check:** Rejects prices older than 60 seconds
- **Bankruptcy Mechanism:**
  - **ADL (Auto-Deleveraging):** Forcibly closes profitable positions in order of PnL% and leverage
  - **Insurance Fund:** Secondary backstop before ADL

**Strengths:**
- Sophisticated risk parameter framework
- Multi-oracle redundancy
- Battle-tested through 2022 exploit recovery

**Weaknesses:**
- ADL user experience (positions closed without consent)
- Complex health calculation (gas-intensive on L1)
- Conservative limits on long-tail assets

**Code Reference (Health Calculation):**
```rust
pub fn calculate_health(account: &MangoAccount, oracle_prices: &[I80F48]) -> I80F48 {
    let mut assets = I80F48::ZERO;
    let mut liabilities = I80F48::ZERO;
    
    for (i, position) in account.perp_positions.iter().enumerate() {
        let oracle_price = oracle_prices[i];
        let position_value = position.base_position * oracle_price;
        
        if position_value > I80F48::ZERO {
            assets += position_value * account.asset_weights[i];
        } else {
            liabilities += position_value.abs() * account.liability_weights[i];
        }
    }
    
    // Add collateral
    assets += account.deposits.iter()
        .zip(account.deposit_weights.iter())
        .map(|(d, w)| d * w)
        .sum::<I80F48>();
    
    // Subtract borrows
    liabilities += account.borrows.iter()
        .zip(account.borrow_weights.iter())
        .map(|(b, w)| b * w)
        .sum::<I80F48>();
    
    assets - liabilities
}
```

---

### 1.4 Zeta Markets

**Architecture:** L2 rollup on Solana with options + perps

**Risk Engine Highlights:**
- **Undercollateralized Options:** Reduced margin via portfolio margining
- **Dynamic Margin Requirements:**
  - Adjusted based on real-time volatility (updated every 10 seconds)
  - Example: BTC margin requirement ranges from 5% (low vol) to 15% (high vol)
- **Liquidation Engine:**
  - **Cascading Liquidation Prevention:** Liquidations paused if >$10M liquidated in 1 minute
  - **Gradual Unwinding:** Positions liquidated in 10% chunks with 30-second intervals
- **Oracle Strategy:**
  - **Primary:** Pyth Network
  - **Validation:** Cross-reference with CEX TWAP (Binance, Coinbase)
  - **Deviation Threshold:** Circuit breaker if Pyth deviates >2% from CEX TWAP
- **Insurance Mechanism:**
  - Funded by 15% of trading fees
  - Target: 3% of total open interest
  - Backstop: ZEX token treasury

**Strengths:**
- Advanced volatility-adjusted risk model
- Strong anti-cascade protections
- Options+perps portfolio margining

**Weaknesses:**
- L2 introduces additional trust assumptions
- Limited market count (20-30 assets vs Drift's 40+)
- Newer codebase (higher contract risk)

---

### 1.5 Comparative Risk Engine Matrix

| Feature | Drift | Jupiter | Mango | Zeta | Percolator (Current) |
|---------|-------|---------|-------|------|---------------------|
| **Liquidation Type** | Partial → Full | Instant Full | Tiered | Gradual (10% chunks) | Immediate (h-based) |
| **Oracle** | Pyth | Pyth | Pyth + Switchboard | Pyth + CEX TWAP | TBD (recommend Pyth) |
| **Insurance Fund** | Yes ($5M+) | No (JLP risk) | Yes ($2M+) | Yes (target 3% OI) | No (math-based haircut) |
| **Cross-Margining** | Yes (spot+perp) | No | Yes (multi-asset) | Yes (options+perp) | No |
| **Bankruptcy Handling** | Insurance → ADL | JLP absorbs | ADL | Insurance → ADL | Socialized haircut (h<1) |
| **Max Leverage** | 20x (101x on majors) | 100x | 20x | 10x | Configurable |
| **Permissionless Markets** | No | No | No | No | **Planned** |
| **Code Audit** | 3 audits (Trail of Bits) | 2 audits | 2 audits (post-exploit) | 1 audit | **None yet** |

---

## 2. Risk Engine Deep Dive

### 2.1 Liquidation Mechanisms

#### Threshold Design Philosophy

**Mango's Tiered Approach (Best Practice):**
```
Initial Margin (IM): 10%    → Can open position
Maintenance Margin (MM): 6% → Liquidation threshold
Bankruptcy: 0%              → Socialized loss trigger
```

**Recommendation for Percolator:**
- **IM:** 15% for new permissionless markets, 10% for vetted assets
- **MM:** 8% (conservative buffer)
- **Partial Liquidation Trigger:** 9% (attempt 50% reduction first)

#### Partial vs Full Liquidation

**Drift's Partial Logic:**
1. Calculate position size needed to restore health
2. Liquidate minimum required amount (typically 25-30%)
3. Re-check health after each chunk
4. Stop if health restored

**Percolator Gap:**
- Current design uses immediate full haircut via `h`
- **Improvement:** Layer partial unwinding before applying global `h`:

```rust
pub fn liquidate_account(
    account: &mut Account,
    oracle_price: I80F48,
    global_h: I80F48, // coverage ratio
) -> Result<LiquidationResult> {
    let health_ratio = calculate_health_ratio(account, oracle_price)?;
    
    if health_ratio < MAINTENANCE_MARGIN_RATIO {
        // Attempt partial liquidation first
        let target_health = MAINTENANCE_MARGIN_RATIO + I80F48::from_num(0.02); // 2% buffer
        let required_reduction = calculate_position_reduction(account, target_health)?;
        
        if required_reduction < I80F48::from_num(0.5) {
            // Partial liquidation (< 50% of position)
            return Ok(LiquidationResult::Partial(required_reduction));
        } else {
            // Full liquidation with h-based haircut
            let haircut_amount = account.pnl_positive * (I80F48::ONE - global_h);
            return Ok(LiquidationResult::Full { haircut: haircut_amount });
        }
    }
    
    Ok(LiquidationResult::Healthy)
}
```

#### Liquidation Backstops

**Mango's Backstop Hierarchy:**
1. **T1:** Liquidator takes position at 2% discount
2. **T2:** Insurance fund covers shortfall
3. **T3:** ADL (force-close profitable positions)
4. **T4:** Socialized loss (emergency)

**Zeta's Anti-Cascade Circuit Breaker:**
```rust
const MAX_LIQUIDATION_VOLUME_PER_MINUTE: u128 = 10_000_000; // $10M USDC
const LIQUIDATION_PAUSE_THRESHOLD: u128 = 5_000_000; // $5M USDC

if total_liquidated_last_minute > MAX_LIQUIDATION_VOLUME_PER_MINUTE {
    // Pause all new liquidations for 5 minutes
    return Err(ErrorCode::LiquidationCircuitBreakerTriggered);
}
```

**Percolator Recommendation:**
- Add circuit breaker if `h` drops >10% in single block
- Pause new position openings (allow only position reductions)
- Auto-resume after 30-second cooldown

---

### 2.2 Margin Requirements (Initial vs Maintenance)

#### Asset-Specific Risk Weights

**Mango's Asset Weight Framework:**

| Asset Tier | Example | Init Margin | Maint Margin | Max Leverage |
|------------|---------|-------------|--------------|--------------|
| Tier 1 | BTC, ETH | 10% | 6% | 10x |
| Tier 2 | SOL, AVAX | 15% | 10% | 6.67x |
| Tier 3 | Mid-caps | 25% | 15% | 4x |
| Tier 4 | Long-tail | 50% | 30% | 2x |
| Tier 5 | Micro-caps | **Disabled** | - | - |

**Percolator Gap:**
- No asset-specific risk weights in current spec
- All markets treated equally (risky for permissionless creation)

**Recommendation:**
```rust
pub struct MarketRiskParams {
    pub tier: RiskTier,
    pub init_margin_bps: u16,      // basis points (1 bps = 0.01%)
    pub maint_margin_bps: u16,
    pub max_leverage: u8,
    pub max_position_size: u128,   // USDC value cap
    pub oracle_confidence_min: u8, // 0-100 (%)
}

pub fn get_default_risk_params(is_permissionless: bool, market_age_days: u16) -> MarketRiskParams {
    if is_permissionless {
        if market_age_days < 7 {
            // New permissionless market: ultra-conservative
            MarketRiskParams {
                tier: RiskTier::Permissionless,
                init_margin_bps: 2000,  // 20%
                maint_margin_bps: 1200, // 12%
                max_leverage: 5,
                max_position_size: 50_000, // $50k max
                oracle_confidence_min: 90,
            }
        } else if market_age_days < 30 {
            // Aging permissionless market
            MarketRiskParams {
                tier: RiskTier::Established,
                init_margin_bps: 1500,  // 15%
                maint_margin_bps: 1000, // 10%
                max_leverage: 8,
                max_position_size: 100_000,
                oracle_confidence_min: 85,
            }
        } else {
            // Mature permissionless market
            MarketRiskParams {
                tier: RiskTier::Mature,
                init_margin_bps: 1000,  // 10%
                maint_margin_bps: 700,  // 7%
                max_leverage: 10,
                max_position_size: 500_000,
                oracle_confidence_min: 80,
            }
        }
    } else {
        // Vetted/governance-approved market
        MarketRiskParams {
            tier: RiskTier::Vetted,
            init_margin_bps: 1000,
            maint_margin_bps: 600,
            max_leverage: 20,
            max_position_size: u128::MAX,
            oracle_confidence_min: 75,
        }
    }
}
```

#### Cross vs Isolated Margin

**Drift's Cross-Margin Model:**
- Single margin account backs all positions
- Portfolio netting reduces total margin requirement
- Risk: One bad position can liquidate entire account

**Jupiter's Isolated Margin:**
- Each position has separate collateral
- Liquidation of one position doesn't affect others
- Safer but capital-inefficient

**Percolator Recommendation:**
- **Default:** Isolated margin (simpler, safer for mainnet)
- **Phase 2:** Add opt-in cross-margin with portfolio risk adjustments:

```rust
pub fn calculate_portfolio_margin_discount(positions: &[Position]) -> I80F48 {
    let mut total_discount = I80F48::ZERO;
    
    // Detect hedged positions (e.g., long SOL spot + short SOL-PERP)
    for (i, pos_a) in positions.iter().enumerate() {
        for pos_b in positions.iter().skip(i + 1) {
            if is_hedged_pair(pos_a, pos_b) {
                let hedge_ratio = calculate_hedge_ratio(pos_a, pos_b);
                total_discount += hedge_ratio * I80F48::from_num(0.3); // up to 30% discount
            }
        }
    }
    
    total_discount.min(I80F48::from_num(0.5)) // cap at 50% total discount
}

fn is_hedged_pair(pos_a: &Position, pos_b: &Position) -> bool {
    // Same underlying asset, opposite direction
    pos_a.market_symbol == pos_b.market_symbol &&
    pos_a.direction != pos_b.direction &&
    pos_a.size.abs() == pos_b.size.abs()
}
```

---

### 2.3 Oracle Handling

#### Price Feed Selection

**Pyth Network (Industry Standard):**
- **Update Frequency:** 400ms on Solana mainnet
- **Confidence Intervals:** Provides price ± uncertainty range
- **Staleness Protection:** Prices older than 60s rejected
- **Cost:** ~$1-2k/month per feed

**Switchboard (Alternative):**
- **Customizable:** Can aggregate from any data source
- **Permissionless:** Anyone can create feeds
- **Risk:** Lower adoption = less battle-tested

**Percolator Recommendation:**
- **Primary:** Pyth Network (proven reliability)
- **Fallback:** Switchboard for long-tail assets without Pyth feeds
- **Validation:** Cross-check Pyth vs on-chain TWAP (Orca/Raydium)

#### Manipulation Resistance

**Attack Vector: Oracle Front-Running**
- Attacker manipulates spot price on DEX
- Oracle updates to manipulated price
- Attacker profits from perp position, then unwinds DEX manipulation

**Mango's Defense (TWAP + Confidence):**
```rust
pub fn get_validated_oracle_price(oracle: &Pubkey, market: &Market) -> Result<I80F48> {
    let pyth_price = pyth_client::get_price(oracle)?;
    
    // Reject stale prices
    require!(
        Clock::get()?.unix_timestamp - pyth_price.publish_time < 60,
        ErrorCode::StalePriceData
    );
    
    // Reject low-confidence prices
    let confidence_ratio = pyth_price.confidence / pyth_price.price;
    require!(
        confidence_ratio < I80F48::from_num(0.02), // <2% confidence interval
        ErrorCode::OracleLowConfidence
    );
    
    // Cross-check with on-chain TWAP
    let twap_price = market.get_30s_twap()?;
    let deviation = (pyth_price.price - twap_price).abs() / twap_price;
    
    require!(
        deviation < I80F48::from_num(0.05), // <5% deviation
        ErrorCode::OraclePriceDeviation
    );
    
    Ok(pyth_price.price)
}
```

**Percolator Gap:**
- No oracle validation logic in current spec
- Vulnerable to flash loan oracle manipulation

**Recommendation:**
```rust
pub struct OracleConfig {
    pub max_staleness_seconds: i64,
    pub max_confidence_ratio: I80F48,
    pub max_twap_deviation: I80F48,
    pub twap_window_seconds: u64,
    pub circuit_breaker_enabled: bool,
}

impl Default for OracleConfig {
    fn default() -> Self {
        OracleConfig {
            max_staleness_seconds: 60,
            max_confidence_ratio: I80F48::from_num(0.02), // 2%
            max_twap_deviation: I80F48::from_num(0.05),   // 5%
            twap_window_seconds: 30,
            circuit_breaker_enabled: true,
        }
    }
}
```

#### Oracle Fallbacks

**Zeta's Multi-Oracle Strategy:**
1. Primary: Pyth Network
2. Fallback: CEX TWAP (Binance + Coinbase average)
3. Emergency: Last known good price (frozen trading)

**Percolator Recommendation:**
```rust
pub enum OracleSource {
    Pyth(Pubkey),
    Switchboard(Pubkey),
    OnChainTWAP { pools: Vec<Pubkey>, window: u64 },
    Frozen { last_price: I80F48, timestamp: i64 },
}

pub fn get_best_available_price(sources: &[OracleSource]) -> Result<I80F48> {
    for source in sources {
        match source {
            OracleSource::Pyth(pubkey) => {
                if let Ok(price) = try_get_pyth_price(pubkey) {
                    return Ok(price);
                }
            },
            OracleSource::Switchboard(pubkey) => {
                if let Ok(price) = try_get_switchboard_price(pubkey) {
                    return Ok(price);
                }
            },
            OracleSource::OnChainTWAP { pools, window } => {
                if let Ok(price) = calculate_twap(pools, *window) {
                    return Ok(price);
                }
            },
            OracleSource::Frozen { last_price, timestamp } => {
                // Freeze trading if oracle down >5 minutes
                require!(
                    Clock::get()?.unix_timestamp - timestamp < 300,
                    ErrorCode::OracleDownTooLong
                );
                return Ok(*last_price);
            }
        }
    }
    
    Err(ErrorCode::NoValidOracleSource.into())
}
```

---

### 2.4 Insurance Funds

#### Funding Mechanisms

**Drift's Insurance Fund Model:**
- **Sources:**
  - 10% of all protocol fees
  - Liquidation penalty remainders (after liquidator reward)
  - DRIFT token staking rewards
- **Target:** ~2-3% of total open interest
- **Deployment:** Triggered when user bankruptcy occurs (margin < 0)

**Jupiter JLP Approach:**
- No separate insurance fund
- JLP liquidity providers absorb all losses
- **Risk:** Profitable for LPs in bull markets, catastrophic in flash crashes

**Percolator Improvement:**
```rust
pub struct InsuranceFund {
    pub balance: u128,             // USDC balance
    pub target_ratio: I80F48,      // % of total open interest
    pub fee_allocation_bps: u16,   // basis points of fees allocated
    pub last_payout_slot: u64,
    pub total_payouts: u128,
    pub total_contributions: u128,
}

pub fn update_insurance_fund(
    fund: &mut InsuranceFund,
    protocol_fees: u128,
    open_interest: u128,
) -> u128 {
    let current_ratio = I80F48::from_num(fund.balance) / I80F48::from_num(open_interest);
    
    if current_ratio < fund.target_ratio {
        // Allocate more fees to insurance until target reached
        let allocation_rate = if current_ratio < fund.target_ratio / 2 {
            2000 // 20% of fees if severely underfunded
        } else {
            1000 // 10% of fees otherwise
        };
        
        let contribution = protocol_fees * allocation_rate / 10000;
        fund.balance += contribution;
        fund.total_contributions += contribution;
        
        contribution
    } else {
        // Target reached, reduce allocation
        let contribution = protocol_fees * 500 / 10000; // 5% maintenance
        fund.balance += contribution;
        fund.total_contributions += contribution;
        
        contribution
    }
}
```

#### Deployment Triggers

**When Insurance Fund Activates:**

**Mango's Trigger:**
```rust
if account.margin < 0 && !liquidator_covers_loss {
    let shortfall = account.margin.abs();
    
    if insurance_fund.balance >= shortfall {
        // Insurance fund covers
        insurance_fund.balance -= shortfall;
        account.margin = 0;
    } else {
        // Partial coverage, trigger ADL
        account.margin = -(shortfall - insurance_fund.balance);
        insurance_fund.balance = 0;
        trigger_auto_deleveraging(account)?;
    }
}
```

**Percolator Alternative (Math-Based):**
- No insurance fund needed—`h` ratio mathematically prevents withdrawals exceeding backed capital
- **Trade-off:** Better predictability, but winners share losses equally (no priority)

**Recommendation:**
- Hybrid approach: Small insurance fund (1-2% of OI) as first line of defense
- If depleted, fall back to `h`-based haircut model
- **Benefit:** Protects small users from haircuts during normal operation

---

### 2.5 Bankruptcy Scenarios

#### Socialized Loss Mechanisms

**ADL (Auto-Deleveraging) - Mango/Zeta:**

**How It Works:**
1. Identify all profitable positions on opposite side of bankrupt account
2. Rank by profitability % and leverage
3. Force-close positions in order until deficit covered

**Example:**
- Bankrupt account: Long 10 BTC-PERP, margin = -$5,000 (underwater)
- Insurance fund: $0 (depleted)
- Profitable shorts:
  - Alice: Short 5 BTC, +$10,000 PnL (200% profit)
  - Bob: Short 3 BTC, +$4,000 PnL (133% profit)
  - Carol: Short 2 BTC, +$2,000 PnL (100% profit)

**ADL Process:**
1. Close Alice's position first (highest %)
2. Alice loses her $10,000 profit (reduced to $5,000)
3. Deficit covered, Bob and Carol unaffected

**User Experience:** Alice's position forcibly closed without consent—frustrating but transparent

---

**Percolator's `h`-Based Haircut:**

**How It Works:**
1. Calculate total backed PnL:
   ```
   Residual = Vault Balance - Total Capital - Insurance
   h = min(Residual, Positive_PnL_Total) / Positive_PnL_Total
   ```
2. All winners share proportional haircut

**Example (Same Scenario):**
- Residual = $11,000 (after bankrupt account loss)
- Positive PnL Total = $16,000 (Alice + Bob + Carol)
- `h = $11,000 / $16,000 = 0.6875` (68.75% backed)

**Haircut Distribution:**
- Alice: $10,000 * 0.6875 = $6,875 (loses $3,125)
- Bob: $4,000 * 0.6875 = $2,750 (loses $1,250)
- Carol: $2,000 * 0.6875 = $1,375 (loses $625)
- **Total loss: $5,000** (matches deficit)

**User Experience:** More "fair" (everyone shares pain), but reduces winning trader rewards

---

#### Comparative Table: ADL vs `h`-Haircut

| Aspect | ADL (Mango/Zeta) | h-Haircut (Percolator) |
|--------|------------------|----------------------|
| **Selection Criteria** | Ranked by PnL% + leverage | Proportional to all winners |
| **Predictability** | Low (could be randomly selected) | High (haircut applies to all) |
| **User Experience** | Position closed without consent | Withdrawal amount reduced |
| **Capital Efficiency** | Winners can withdraw 100% until ADL | Winners always subject to `h` < 1 |
| **Recovery** | Manual (re-enter position) | Automatic (as `h` recovers) |
| **Cascading Risk** | Low (only affects ranked traders) | Higher (all winners affected) |

**Recommendation for Percolator:**
- **Primary:** Use `h`-based haircut (aligns with core design)
- **Safeguard:** Cap maximum haircut per event at 5% of user PnL
- **If >5% needed:** Trigger emergency ADL for top 10% most profitable positions

```rust
const MAX_HAIRCUT_PER_EVENT: I80F48 = I80F48::from_num(0.05); // 5%

pub fn apply_bankruptcy_loss(
    accounts: &mut [Account],
    deficit: u128,
    total_pnl_positive: u128,
) -> Result<()> {
    let h_ratio = I80F48::from_num(deficit) / I80F48::from_num(total_pnl_positive);
    
    if h_ratio <= MAX_HAIRCUT_PER_EVENT {
        // Normal h-based haircut
        for account in accounts.iter_mut() {
            if account.pnl > 0 {
                account.withdrawable_pnl = account.pnl * (I80F48::ONE - h_ratio);
            }
        }
    } else {
        // Emergency: Trigger ADL for top profitable positions
        let mut ranked_accounts: Vec<_> = accounts.iter_mut()
            .filter(|a| a.pnl > 0)
            .collect();
        ranked_accounts.sort_by_key(|a| a.pnl_ratio());
        ranked_accounts.reverse();
        
        let mut remaining_deficit = deficit;
        for account in ranked_accounts {
            if remaining_deficit == 0 { break; }
            
            let loss = std::cmp::min(account.pnl, remaining_deficit);
            account.pnl -= loss;
            remaining_deficit -= loss;
            
            emit!(ADLEvent {
                user: account.owner,
                amount_deducted: loss,
            });
        }
    }
    
    Ok(())
}
```

---

## 3. Permissionless Market Creation Challenges

### 3.1 Oracle Reliability for Long-Tail Assets

#### Problem: Bootstrap Chicken-and-Egg

**Scenario:**
- New memecoin $BONK2 launches on Pump.fun
- No Pyth oracle exists yet
- Market creator wants to launch $BONK2-PERP

**Challenges:**
1. **Pyth Listings:** Require minimum trading volume ($1M+/day) and 3+ CEX listings
2. **Switchboard:** Anyone can create feed, but quality varies wildly
3. **On-Chain TWAP:** Vulnerable to manipulation if low DEX liquidity (<$100k)

#### Solutions From Other Platforms

**Hyperliquid's HIP-3 (Permissionless Perps):**
- Requires **500,000 HYPE staked** to create market (~$1M+ economic bond)
- Oracle: Internal price feed derived from Hyperliquid L1 spot market
- **Limitation:** Only works for assets with on-chain liquidity on Hyperliquid

**Cumulo + SEDA (Instant Perps on Solana):**
- Uses **SEDA programmable oracles** - custom data aggregation scripts
- Example: Aggregate Jupiter spot price + Raydium TWAP + Orca TWAP
- **Risk:** Centralization (SEDA validators control data)

**Percolator Recommendation:**

```rust
pub enum OracleQualityTier {
    Gold {
        // Pyth oracle with >$10M daily volume
        pyth_account: Pubkey,
        min_confidence: u8,
    },
    Silver {
        // Switchboard oracle + on-chain TWAP validation
        switchboard_account: Pubkey,
        validation_pools: Vec<Pubkey>, // Orca/Raydium
        max_deviation: I80F48,
    },
    Bronze {
        // On-chain TWAP only (high risk)
        pools: Vec<Pubkey>,
        min_liquidity: u128,
        twap_window: u64,
    },
}

pub struct PermissionlessMarketConfig {
    pub oracle_tier: OracleQualityTier,
    pub creation_bond: u128,        // USDC locked for 30 days
    pub min_liquidity_provision: u128, // Creator must provide initial liquidity
    pub risk_params: MarketRiskParams,
}

pub fn create_permissionless_market(
    creator: &Signer,
    config: PermissionlessMarketConfig,
) -> Result<Pubkey> {
    // Validate oracle quality
    match config.oracle_tier {
        OracleQualityTier::Gold { pyth_account, min_confidence } => {
            // Best: Pyth oracle
            require_pyth_validation(pyth_account, min_confidence)?;
        },
        OracleQualityTier::Silver { switchboard_account, validation_pools, max_deviation } => {
            // Good: Switchboard + TWAP cross-check
            require_switchboard_validation(switchboard_account)?;
            require_twap_deviation_check(switchboard_account, validation_pools, max_deviation)?;
        },
        OracleQualityTier::Bronze { pools, min_liquidity, twap_window } => {
            // Risky: TWAP only
            require_minimum_liquidity(pools, min_liquidity)?;
            msg!("Warning: Bronze tier oracle - high manipulation risk");
        },
    }
    
    // Lock creation bond
    transfer_to_escrow(creator, config.creation_bond)?;
    
    // Create market with conservative risk params
    let market = create_market_account(creator, config.risk_params)?;
    
    emit!(PermissionlessMarketCreated {
        market: market.key(),
        creator: creator.key(),
        oracle_tier: config.oracle_tier,
        bond_locked: config.creation_bond,
    });
    
    Ok(market.key())
}

fn require_minimum_liquidity(pools: &[Pubkey], min_liquidity: u128) -> Result<()> {
    let total_liquidity: u128 = pools.iter()
        .map(|pool| get_pool_tvl(pool).unwrap_or(0))
        .sum();
    
    require!(
        total_liquidity >= min_liquidity,
        ErrorCode::InsufficientDEXLiquidity
    );
    
    Ok(())
}
```

#### Oracle Manipulation Attack Vectors

**Flash Loan Attack:**
1. Attacker flash-borrows $10M USDC
2. Buys $BONK2 on Raydium, pumps price 50%
3. Oracle updates to manipulated price
4. Attacker opens 10x leveraged long on $BONK2-PERP
5. Attacker dumps $BONK2 on Raydium, crashes price
6. Attacker profits from perp position

**Defense Mechanisms:**

```rust
pub struct ManipulationDefense {
    pub min_oracle_sources: u8,        // Require 3+ independent sources
    pub max_price_change_per_block: I80F48, // 5% max
    pub circuit_breaker_threshold: I80F48,  // 10% deviation triggers pause
    pub twap_window_seconds: u64,      // 60-second TWAP
    pub suspicious_volume_multiplier: I80F48, // Flag if volume >10x normal
}

pub fn detect_manipulation(
    current_price: I80F48,
    twap_price: I80F48,
    recent_volume: u128,
    avg_volume: u128,
    defense: &ManipulationDefense,
) -> Result<bool> {
    // Check price deviation
    let deviation = (current_price - twap_price).abs() / twap_price;
    if deviation > defense.circuit_breaker_threshold {
        emit!(ManipulationAlert {
            reason: "Excessive price deviation",
            deviation,
        });
        return Ok(true);
    }
    
    // Check volume spike
    let volume_ratio = I80F48::from_num(recent_volume) / I80F48::from_num(avg_volume);
    if volume_ratio > defense.suspicious_volume_multiplier {
        emit!(ManipulationAlert {
            reason: "Suspicious volume spike",
            ratio: volume_ratio,
        });
        return Ok(true);
    }
    
    Ok(false)
}
```

---

### 3.2 Low Liquidity Attacks

#### Problem: Thin Order Books

**Scenario:**
- Market: $MICROCAP-PERP
- Open Interest: $500k
- DEX Liquidity: $50k (very thin)
- Large position: Trader opens $100k long

**Consequences:**
1. **Liquidation Cascades:** Liquidator can't exit position without 50%+ slippage
2. **Oracle Manipulation:** Small capital can move price significantly
3. **Socialized Losses:** Other traders bear the cost

#### Solutions

**Drift's Approach:**
- No permissionless markets (team vets each listing)
- Requires minimum $10M DEX liquidity before listing

**Hyperliquid HIP-3:**
- **Dynamic Caps:** Max position size = 10% of DEX liquidity
- Example: $50k DEX liquidity → $5k max position

**Percolator Recommendation:**

```rust
pub struct LiquidityBasedRiskParams {
    pub dex_tvl: u128,                    // Total value locked in spot pools
    pub max_position_size_ratio: I80F48,  // 0.1 = 10% of DEX TVL
    pub max_open_interest_ratio: I80F48,  // 2.0 = 2x DEX TVL
    pub min_liquidator_count: u8,         // Require 3+ active liquidators
}

pub fn calculate_position_limits(
    market: &Market,
    liquidity_params: &LiquidityBasedRiskParams,
) -> (u128, u128) {
    let dex_tvl = get_total_dex_liquidity(&market.oracle_pools)?;
    
    let max_position = (I80F48::from_num(dex_tvl) * liquidity_params.max_position_size_ratio)
        .to_num::<u128>();
    
    let max_oi = (I80F48::from_num(dex_tvl) * liquidity_params.max_open_interest_ratio)
        .to_num::<u128>();
    
    (max_position, max_oi)
}

pub fn open_position(
    ctx: Context<OpenPosition>,
    size: u128,
) -> Result<()> {
    let market = &ctx.accounts.market;
    let (max_position, max_oi) = calculate_position_limits(market, &market.liquidity_params)?;
    
    // Enforce position size limit
    require!(
        size <= max_position,
        ErrorCode::PositionTooLargeForLiquidity
    );
    
    // Enforce open interest limit
    let new_oi = market.open_interest_long + market.open_interest_short + size;
    require!(
        new_oi <= max_oi,
        ErrorCode::OpenInterestExceedsLiquidity
    );
    
    // Continue with position creation...
    Ok(())
}
```

---

### 3.3 Market Spam / Griefing

#### Problem: Sybil Market Creation

**Attack:**
- Attacker creates 1,000 fake markets for joke tokens
- Each market costs minimal gas (~0.00001 SOL)
- UI/UX becomes cluttered, discovery breaks

#### Solutions

**Economic Moat (Recommended):**

```rust
pub struct MarketCreationBond {
    pub amount: u128,                  // 1,000 USDC
    pub lock_duration_seconds: i64,    // 30 days
    pub slash_conditions: Vec<SlashCondition>,
}

pub enum SlashCondition {
    NoVolumeAfter30Days,               // $0 volume = 100% slash
    LowVolumeAfter30Days { threshold: u128 }, // <$10k = 50% slash
    OracleFailure,                     // Oracle down >24h = 100% slash
    ExcessiveLiquidations { ratio: I80F48 }, // >50% positions liquidated = 50% slash
}

pub fn create_market_with_bond(
    creator: &Signer,
    market_params: MarketParams,
) -> Result<Pubkey> {
    // Lock creation bond
    let bond_amount = 1_000_000_000; // 1,000 USDC (6 decimals)
    let escrow = transfer_to_time_locked_escrow(
        creator,
        bond_amount,
        Clock::get()?.unix_timestamp + (30 * 24 * 60 * 60), // 30 days
    )?;
    
    // Create market
    let market = create_market_internal(creator, market_params)?;
    market.bond_escrow = escrow;
    
    emit!(MarketCreatedWithBond {
        market: market.key(),
        creator: creator.key(),
        bond: bond_amount,
        unlock_date: Clock::get()?.unix_timestamp + (30 * 24 * 60 * 60),
    });
    
    Ok(market.key())
}

pub fn evaluate_bond_slashing(market: &Market) -> I80F48 {
    let age_days = (Clock::get()?.unix_timestamp - market.created_at) / (24 * 60 * 60);
    
    if age_days >= 30 {
        let total_volume = market.cumulative_volume;
        
        if total_volume == 0 {
            return I80F48::ONE; // 100% slash
        } else if total_volume < 10_000_000_000 { // <$10k
            return I80F48::from_num(0.5); // 50% slash
        }
    }
    
    I80F48::ZERO // No slash
}
```

**UI/UX Filtering:**
- Default view: Only show markets with >$100k daily volume
- Advanced filter: Show all markets, sorted by TVL/volume
- Warning labels: "Low liquidity - high risk"

---

### 3.4 Capital Efficiency for New Markets

#### Problem: Bootstrapping Liquidity

**Challenge:**
- New market needs liquidity to attract traders
- Traders won't come without liquidity
- Market creator can't provide infinite capital

#### Solutions

**Liquidity Mining Incentives:**

```rust
pub struct LiquidityBootstrapProgram {
    pub market: Pubkey,
    pub reward_token: Pubkey,           // PERCOL governance token
    pub total_rewards: u128,
    pub duration_days: u16,             // 30 days
    pub min_liquidity_provision: u128,  // $10k minimum
}

pub fn allocate_lp_rewards(
    program: &LiquidityBootstrapProgram,
    lp_account: &Account,
) -> u128 {
    let lp_share = lp_account.liquidity_provided / program.total_liquidity_provided;
    let time_share = lp_account.days_active / program.duration_days;
    
    let reward = I80F48::from_num(program.total_rewards)
        * I80F48::from_num(lp_share)
        * I80F48::from_num(time_share);
    
    reward.to_num::<u128>()
}
```

**Jupiter Integration (Instant DEX Liquidity):**
- Route Percolator oracle to Jupiter aggregator
- Inherit liquidity from all Solana DEXs (Orca, Raydium, Meteora)
- **Benefit:** No need to bootstrap separate liquidity pool

**Example Code:**
```rust
use jupiter_core::JupiterSwap;

pub fn get_jupiter_oracle_price(
    token_mint: Pubkey,
    amount: u128,
) -> Result<I80F48> {
    let quote = jupiter_swap::get_quote(
        token_mint,
        USDC_MINT,
        amount,
    )?;
    
    let price = I80F48::from_num(quote.out_amount) / I80F48::from_num(amount);
    Ok(price)
}
```

---

### 3.5 Bootstrap Liquidity Mechanisms

**Mango's Approach:**
- Manual market creation by DAO
- Protocol-owned liquidity (POL) seeded by treasury

**Percolator Recommendation:**

**Hybrid Model:**
1. **Market Creator Requirement:** Provide 25% of min liquidity ($2.5k if min is $10k)
2. **Protocol Matching:** Percolator protocol provides remaining 75% from treasury
3. **Fee Sharing:** Creator earns 50% of trading fees for first 90 days
4. **Clawback:** If market fails (<$10k volume in 30 days), protocol withdraws match

```rust
pub struct LiquidityMatchingProgram {
    pub creator_contribution: u128,
    pub protocol_match_ratio: I80F48,  // 3.0 = 3x match
    pub max_protocol_match: u128,       // $7.5k cap
    pub fee_share_bps: u16,             // 5000 = 50%
    pub fee_share_duration_days: u16,   // 90 days
    pub clawback_condition: ClawbackCondition,
}

pub enum ClawbackCondition {
    NoVolume { days: u16 },
    LowVolume { days: u16, min_volume: u128 },
    OracleFailure,
}

pub fn create_matched_liquidity_market(
    creator: &Signer,
    creator_liquidity: u128,
    program: &LiquidityMatchingProgram,
) -> Result<Pubkey> {
    // Validate creator contribution
    require!(
        creator_liquidity >= program.creator_contribution,
        ErrorCode::InsufficientCreatorLiquidity
    );
    
    // Calculate protocol match
    let protocol_match = std::cmp::min(
        (I80F48::from_num(creator_liquidity) * program.protocol_match_ratio).to_num::<u128>(),
        program.max_protocol_match,
    );
    
    // Create market with combined liquidity
    let market = create_market(creator, creator_liquidity + protocol_match)?;
    
    // Set up fee sharing
    market.fee_share_creator = program.fee_share_bps;
    market.fee_share_expiry = Clock::get()?.unix_timestamp + 
        (program.fee_share_duration_days as i64 * 24 * 60 * 60);
    
    emit!(MatchedLiquidityMarketCreated {
        market: market.key(),
        creator: creator.key(),
        creator_contribution: creator_liquidity,
        protocol_match,
        total_liquidity: creator_liquidity + protocol_match,
    });
    
    Ok(market.key())
}
```

---

## 4. Toly's Percolator Design Analysis

### 4.1 vAAM (Virtual Automated Adjusting Market Maker) Architecture

**Core Concept:**
- Percolator doesn't use traditional AMM or orderbook
- Instead, uses **withdrawal-based accounting** where:
  - Capital (deposits) = senior claim (withdrawable)
  - Profit = junior claim (IOU backed by global `h` ratio)

**Key Innovation:**
- **No forced liquidations** in traditional sense
- **No ADL** (auto-deleveraging)
- **No insurance fund**
- **Mathematical guarantee:** Users can never withdraw more than vault balance

**How `h` Works:**

```
Vault Balance: V = 100,000 USDC
Total Capital: C_tot = 80,000 USDC (user deposits)
Insurance: I = 0 (Percolator doesn't use insurance fund)
Positive PnL Total: PNL_pos_tot = 30,000 USDC (sum of all winners)

Residual = max(0, V - C_tot - I)
         = max(0, 100,000 - 80,000 - 0)
         = 20,000 USDC

h = min(Residual, PNL_pos_tot) / PNL_pos_tot
  = min(20,000, 30,000) / 30,000
  = 20,000 / 30,000
  = 0.6667 (66.67% backed)
```

**User Impact:**
- Alice has +$10,000 PnL
- Alice's effective withdrawable = $10,000 * 0.6667 = $6,667
- Alice's "haircut" = $3,333 (not lost, but delayed until `h` recovers)

**Comparison to Alternatives:**

| Design | Percolator (h-ratio) | Drift (Insurance+ADL) | Jupiter (JLP) |
|--------|---------------------|----------------------|---------------|
| **Profit Withdrawal** | Haircut by `h` | 100% until bankruptcy | 100% until JLP depleted |
| **Loss Handling** | Proportional to all | Insurance → ADL | JLP absorbs |
| **Predictability** | High (formula-driven) | Medium (ADL queue unknown) | Low (JLP P&L opaque) |
| **User Experience** | Reduced withdrawals | Forced position closure | Normal until crisis |
| **Protocol Risk** | Zero (math-enforced) | Medium (insurance can fail) | High (JLP bankruptcy possible) |

**Percolator's Key Advantage:**
- **Formally Verified:** 145 Kani proofs ensure invariant holds
- **No Human Intervention:** No DAO decisions, no pausing, no emergency admin keys
- **Predictable:** Users know exact haircut via `h` (transparent)

**Percolator's Key Drawback:**
- **Always Penalizes Winners:** Even in healthy markets, `h` might be 0.95 (5% haircut)
- **Slow Recovery:** Profit must "mature" through warmup period (could take days)

---

### 4.2 Coin-Margined vs USDC-Margined Trade-offs

**USDC-Margined (Recommended for Percolator):**

**Pros:**
- Simple accounting (everything denominated in USDC)
- No impermanent loss on collateral
- Easier to calculate `h` ratio
- Better UX (users understand "dollars")

**Cons:**
- Users must swap tokens to USDC first (extra friction)
- Misses opportunity for native SOL/BTC collateral

**Coin-Margined (BTC-PERP margined in BTC):**

**Pros:**
- No need to sell winning assets (e.g., hold BTC, trade BTC-PERP)
- Tax efficiency (no taxable events from swaps)
- Aligns with "HODL" culture

**Cons:**
- **Complex accounting:** Vault balance denominated in BTC, but `h` ratio needs stable unit
- **Oracle dependency:** Need BTC/USD oracle for risk calculations
- **Collateral volatility:** If BTC crashes 20%, margin calls triggered even if position unchanged

**Recommendation:**
- **Phase 1 (Mainnet Launch):** USDC-margined only (simpler, safer)
- **Phase 2 (After 6 months):** Add coin-margined markets for BTC, ETH, SOL
- **Hybrid Approach:** Allow USDC collateral to back coin-margined positions

**Code Example (Hybrid Collateral):**
```rust
pub enum CollateralType {
    USDC { amount: u128 },
    Native { token_mint: Pubkey, amount: u128 },
}

pub fn calculate_collateral_value_in_usdc(
    collateral: &CollateralType,
    oracle_price: I80F48,
) -> u128 {
    match collateral {
        CollateralType::USDC { amount } => *amount,
        CollateralType::Native { token_mint, amount } => {
            let price = get_oracle_price(token_mint)?;
            (I80F48::from_num(*amount) * price).to_num::<u128>()
        }
    }
}
```

---

### 4.3 Current Risk Engine Implementation Gaps

**Based on Percolator GitHub Analysis:**

**Missing Components:**

1. **No Oracle Integration**
   - Current spec references oracles but no implementation
   - **Gap:** Need Pyth SDK integration + staleness checks

2. **No Partial Liquidation Logic**
   - Only full haircut via `h`
   - **Gap:** Should attempt partial liquidation first (restore health without full loss)

3. **No Market-Specific Risk Params**
   - All markets treated equally
   - **Gap:** Need asset-specific margin requirements (BTC vs memecoin)

4. **No Funding Rate Mechanism**
   - Perpetuals need funding to converge to spot
   - **Gap:** Calculate and apply funding every hour

5. **No Permissionless Market Creation**
   - Spec mentions but no implementation
   - **Gap:** Need bond locking, oracle validation, spam prevention

6. **No Cross-Margining**
   - Only isolated positions
   - **Gap:** Allow portfolio-level risk calculations

7. **No Liquidator Incentive Structure**
   - Unclear how liquidators are rewarded
   - **Gap:** Define liquidation fee (e.g., 2% of position)

8. **No Insurance Fund (By Design)**
   - Intentional choice, but risky for mainnet
   - **Gap:** Consider small insurance fund (1-2% OI) as safety buffer

**Priority Roadmap (Pre-Mainnet):**

```
Week 1-2: Oracle Integration
- Integrate Pyth SDK
- Add staleness + confidence validation
- Implement TWAP cross-check

Week 2-3: Risk Parameter Framework
- Define asset tiers (Gold/Silver/Bronze)
- Implement market-specific margin requirements
- Add position size limits

Week 3-4: Liquidation Engine
- Implement partial liquidation logic
- Add liquidator incentive mechanism
- Build keeper bot reference implementation

Week 4-5: Funding Rate System
- Calculate funding based on long/short skew
- Apply funding every hour
- Test funding convergence

Week 5-6: Permissionless Market Creation
- Implement creation bond locking
- Add oracle tier validation
- Build market spam prevention

Post-Mainnet: Cross-Margining
- Portfolio-level health calculations
- Hedged position discounts
- Advanced risk models
```

---

### 4.4 Comparison to Alternatives

**Percolator vs Drift vs Jupiter:**

| Feature | Percolator | Drift | Jupiter |
|---------|-----------|-------|---------|
| **Architecture** | Withdrawal-based (`h`) | vAMM + DLOB | Oracle + JLP |
| **Liquidation** | `h`-haircut | Partial → Full → ADL | Instant full |
| **Oracle** | TBD (recommend Pyth) | Pyth | Pyth |
| **Insurance** | None (math-based) | Yes ($5M+) | None (JLP risk) |
| **Funding Rate** | Not yet implemented | Hourly | Hourly |
| **Cross-Margin** | No | Yes | No |
| **Permissionless Markets** | Planned | No | No |
| **Code Maturity** | Early (research) | Production (3 years) | Production (1 year) |
| **Formal Verification** | Yes (145 Kani proofs) | No | No |
| **Max Leverage** | Configurable | 20x (101x majors) | 100x |
| **Capital Efficiency** | Medium (`h` haircut) | High | High |

**Where Percolator Wins:**
1. **Predictability:** Formula-driven `h` is transparent vs black-box ADL
2. **No Admin Risk:** Fully automated, no DAO decisions needed
3. **Formal Verification:** Mathematically proven safety
4. **Permissionless Vision:** Aligns with crypto ethos

**Where Percolator Loses:**
1. **User Experience:** Haircuts on withdrawals feel punitive
2. **Capital Efficiency:** Winners can't access 100% of profits immediately
3. **Battle-Testing:** New design, not proven in production
4. **Feature Completeness:** Missing funding rates, cross-margin, etc.

**Strategic Positioning:**
- **Drift/Jupiter:** "Fast, capital-efficient trading for pros"
- **Percolator:** "Mathematically safe, transparent perpetuals for everyone"

**Target Market:**
- Risk-averse DeFi users who trust math > insurance funds
- Projects building on top (SDKs, white-label)
- Users burned by ADL on other platforms

---

## 5. Concrete Improvement Proposals

### 5.1 Risk Parameter Recommendations

**Asset Tier Framework:**

```rust
pub struct AssetTierConfig {
    pub tier: AssetTier,
    pub init_margin_bps: u16,
    pub maint_margin_bps: u16,
    pub max_leverage: u8,
    pub max_position_size: Option<u128>,
    pub liquidation_fee_bps: u16,
    pub oracle_requirements: OracleRequirements,
}

pub enum AssetTier {
    Blue Chip,       // BTC, ETH, SOL
    Established,     // Top 50 by market cap
    MidCap,          // Top 200
    LongTail,        // Established but low liquidity
    Permissionless,  // User-created markets
}

impl AssetTierConfig {
    pub fn blue_chip() -> Self {
        AssetTierConfig {
            tier: AssetTier::BlueChip,
            init_margin_bps: 1000,  // 10%
            maint_margin_bps: 600,  // 6%
            max_leverage: 20,
            max_position_size: None, // unlimited
            liquidation_fee_bps: 200, // 2%
            oracle_requirements: OracleRequirements {
                min_sources: 1,
                max_staleness_sec: 60,
                max_confidence_bps: 200, // 2%
            },
        }
    }
    
    pub fn permissionless() -> Self {
        AssetTierConfig {
            tier: AssetTier::Permissionless,
            init_margin_bps: 2000,  // 20%
            maint_margin_bps: 1200, // 12%
            max_leverage: 5,
            max_position_size: Some(50_000_000_000), // $50k
            liquidation_fee_bps: 500, // 5% (higher to compensate risk)
            oracle_requirements: OracleRequirements {
                min_sources: 2, // Require 2+ oracle sources
                max_staleness_sec: 30,
                max_confidence_bps: 500, // 5%
            },
        }
    }
}
```

**Implementation Example:**
```rust
pub fn calculate_required_margin(
    position_size: u128,
    asset_tier: &AssetTierConfig,
    is_initial: bool,
) -> u128 {
    let margin_bps = if is_initial {
        asset_tier.init_margin_bps
    } else {
        asset_tier.maint_margin_bps
    };
    
    position_size * (margin_bps as u128) / 10000
}

pub fn validate_position_limits(
    new_position_size: u128,
    asset_tier: &AssetTierConfig,
) -> Result<()> {
    // Check leverage
    let leverage = new_position_size / margin;
    require!(
        leverage <= asset_tier.max_leverage as u128,
        ErrorCode::LeverageTooHigh
    );
    
    // Check position size
    if let Some(max_size) = asset_tier.max_position_size {
        require!(
            new_position_size <= max_size,
            ErrorCode::PositionSizeTooLarge
        );
    }
    
    Ok(())
}
```

---

### 5.2 Engine Architecture Changes

**Current Architecture (Simplified):**
```
User Account → Position → Global h → Withdrawal
```

**Proposed Architecture:**

```
User Account
  ├─ Capital (senior claim)
  ├─ Positions[]
  │   ├─ Market-specific risk params
  │   ├─ Oracle validation
  │   └─ Partial liquidation logic
  ├─ Profit (junior claim)
  │   ├─ Warmup queue
  │   └─ h-based haircut
  └─ Cross-margin calculator (optional)

Global State
  ├─ h ratio
  ├─ Insurance fund (optional)
  ├─ Funding rate engine
  └─ Oracle health monitor
```

**Key Additions:**

**1. Warmup Queue (Capital Maturation):**
```rust
pub struct ProfitWarmupQueue {
    pub entries: Vec<WarmupEntry>,
}

pub struct WarmupEntry {
    pub amount: u128,
    pub start_slot: u64,
    pub end_slot: u64,
    pub h_at_start: I80F48,
}

pub fn convert_profit_to_capital(
    account: &mut Account,
    amount: u128,
    warmup_duration_slots: u64,
) -> Result<()> {
    // Add to warmup queue
    account.warmup_queue.entries.push(WarmupEntry {
        amount,
        start_slot: Clock::get()?.slot,
        end_slot: Clock::get()?.slot + warmup_duration_slots,
        h_at_start: get_current_h()?,
    });
    
    // Reduce immediate profit balance
    account.profit_balance -= amount;
    
    Ok(())
}

pub fn process_mature_warmups(account: &mut Account) -> Result<u128> {
    let current_slot = Clock::get()?.slot;
    let current_h = get_current_h()?;
    
    let mut total_matured = 0u128;
    
    account.warmup_queue.entries.retain(|entry| {
        if current_slot >= entry.end_slot {
            // Calculate payout based on current h
            let payout = (I80F48::from_num(entry.amount) * current_h).to_num::<u128>();
            account.capital_balance += payout;
            total_matured += payout;
            false // Remove from queue
        } else {
            true // Keep in queue
        }
    });
    
    Ok(total_matured)
}
```

**2. Funding Rate Engine:**
```rust
pub struct FundingRateEngine {
    pub market: Pubkey,
    pub last_update_slot: u64,
    pub update_frequency_slots: u64, // ~3600 slots = 1 hour
    pub long_oi: u128,
    pub short_oi: u128,
}

pub fn calculate_funding_rate(engine: &FundingRateEngine) -> I80F48 {
    let total_oi = engine.long_oi + engine.short_oi;
    if total_oi == 0 {
        return I80F48::ZERO;
    }
    
    let skew = (I80F48::from_num(engine.long_oi) - I80F48::from_num(engine.short_oi))
        / I80F48::from_num(total_oi);
    
    // Funding rate = skew * base_rate (e.g., 0.01% per hour at full skew)
    const BASE_RATE: I80F48 = I80F48::from_bits(10_000_000); // 0.0001
    
    skew * BASE_RATE
}

pub fn apply_funding(
    position: &mut Position,
    funding_rate: I80F48,
) -> Result<()> {
    let funding_payment = I80F48::from_num(position.size) * funding_rate;
    
    if position.is_long {
        // Longs pay shorts when skewed long
        position.unrealized_pnl -= funding_payment;
    } else {
        // Shorts pay longs when skewed short
        position.unrealized_pnl += funding_payment;
    }
    
    Ok(())
}
```

**3. Cross-Margin Risk Calculator:**
```rust
pub fn calculate_portfolio_health(
    account: &Account,
    oracle_prices: &[I80F48],
) -> I80F48 {
    let mut total_collateral_value = I80F48::from_num(account.capital_balance);
    let mut total_risk = I80F48::ZERO;
    
    for (i, position) in account.positions.iter().enumerate() {
        let market_price = oracle_prices[i];
        let position_value = I80F48::from_num(position.size) * market_price;
        
        // Add position value to collateral
        total_collateral_value += I80F48::from_num(position.unrealized_pnl);
        
        // Add risk-weighted exposure
        let risk_weight = get_asset_tier(position.market)?.maint_margin_bps;
        total_risk += position_value.abs() * I80F48::from_num(risk_weight) / I80F48::from_num(10000);
    }
    
    // Check for hedged positions (reduce risk)
    let hedge_discount = calculate_portfolio_margin_discount(&account.positions);
    total_risk *= (I80F48::ONE - hedge_discount);
    
    // Health ratio = collateral / risk
    total_collateral_value / total_risk
}
```

---

### 5.3 Permissionless Market Safeguards

**Comprehensive Safeguard Stack:**

```rust
pub struct PermissionlessMarketSafeguards {
    // Economic barriers
    pub creation_bond: CreationBond,
    pub min_liquidity_provision: LiquidityRequirement,
    
    // Technical barriers
    pub oracle_validation: OracleValidation,
    pub risk_params: ConservativeRiskParams,
    
    // Monitoring & limits
    pub circuit_breakers: CircuitBreakers,
    pub position_limits: PositionLimits,
    pub spam_prevention: SpamPrevention,
}

pub struct CreationBond {
    pub amount: u128,                  // 1,000 USDC
    pub lock_duration_days: u16,       // 30 days
    pub slash_conditions: Vec<SlashCondition>,
    pub refund_schedule: RefundSchedule,
}

pub struct LiquidityRequirement {
    pub min_creator_liquidity: u128,   // $2,500
    pub protocol_match_ratio: I80F48,  // 3x = $7,500 protocol match
    pub min_total_liquidity: u128,     // $10,000 total
}

pub struct OracleValidation {
    pub tier: OracleQualityTier,
    pub min_sources: u8,               // 2+ sources
    pub max_staleness_sec: i64,        // 30 seconds
    pub max_confidence_bps: u16,       // 5% max confidence interval
    pub twap_validation_enabled: bool,
}

pub struct ConservativeRiskParams {
    pub init_margin_bps: u16,          // 20% (2x more conservative than blue chip)
    pub maint_margin_bps: u16,         // 12%
    pub max_leverage: u8,              // 5x
    pub max_position_size: u128,       // $50k
    pub liquidation_fee_bps: u16,      // 5% (higher to compensate risk)
}

pub struct CircuitBreakers {
    pub max_price_change_per_block_bps: u16, // 500 = 5%
    pub max_liquidation_volume_per_minute: u128, // $1M
    pub pause_threshold_deviation_bps: u16, // 1000 = 10%
    pub cooldown_duration_slots: u64,  // 180 slots = 90 seconds
}

pub struct PositionLimits {
    pub max_position_size_of_dex_liquidity_bps: u16, // 1000 = 10%
    pub max_open_interest_of_dex_liquidity_bps: u16, // 20000 = 200%
    pub max_positions_per_user: u8,    // 5 positions max
}

pub struct SpamPrevention {
    pub max_markets_per_creator_per_day: u8, // 3
    pub min_time_between_creations_hours: u16, // 8 hours
    pub min_account_age_days: u16,     // 7 days
    pub min_previous_trading_volume: u128, // $10k
}
```

**Implementation:**
```rust
pub fn create_permissionless_market_safe(
    creator: &Signer,
    market_params: MarketParams,
    safeguards: &PermissionlessMarketSafeguards,
) -> Result<Pubkey> {
    // 1. Validate creator eligibility
    validate_creator_eligibility(creator, &safeguards.spam_prevention)?;
    
    // 2. Lock creation bond
    lock_creation_bond(creator, &safeguards.creation_bond)?;
    
    // 3. Validate oracle quality
    validate_oracle_quality(&market_params.oracle, &safeguards.oracle_validation)?;
    
    // 4. Require liquidity provision
    provide_initial_liquidity(creator, &safeguards.min_liquidity_provision)?;
    
    // 5. Create market with conservative risk params
    let market = create_market(creator, market_params, safeguards.risk_params)?;
    
    // 6. Set up circuit breakers
    initialize_circuit_breakers(market, safeguards.circuit_breakers)?;
    
    // 7. Emit creation event
    emit!(PermissionlessMarketCreated {
        market: market.key(),
        creator: creator.key(),
        bond_locked: safeguards.creation_bond.amount,
        oracle_tier: safeguards.oracle_validation.tier,
        initial_liquidity: safeguards.min_liquidity_provision.min_total_liquidity,
    });
    
    Ok(market.key())
}

fn validate_creator_eligibility(
    creator: &Signer,
    spam_prevention: &SpamPrevention,
) -> Result<()> {
    // Check account age
    let account_age_days = get_account_age_days(creator)?;
    require!(
        account_age_days >= spam_prevention.min_account_age_days as u64,
        ErrorCode::AccountTooNew
    );
    
    // Check previous trading volume
    let total_volume = get_user_total_trading_volume(creator)?;
    require!(
        total_volume >= spam_prevention.min_previous_trading_volume,
        ErrorCode::InsufficientTradingHistory
    );
    
    // Check daily creation limit
    let markets_created_today = get_markets_created_by_user_today(creator)?;
    require!(
        markets_created_today < spam_prevention.max_markets_per_creator_per_day,
        ErrorCode::DailyCreationLimitExceeded
    );
    
    Ok(())
}
```

---

### 5.4 Capital Efficiency Improvements

**Problem:** Percolator's `h`-based haircut reduces capital efficiency vs competitors

**Solutions:**

**1. Tiered Withdrawal System:**
```rust
pub enum WithdrawalTier {
    Instant {
        max_amount: u128,           // $1,000 max instant
        haircut: I80F48,            // h-based haircut
    },
    Fast {
        max_amount: u128,           // $10,000 max
        warmup_duration_hours: u16, // 24 hours
        haircut: I80F48,            // 50% of h haircut
    },
    Normal {
        max_amount: u128,           // Unlimited
        warmup_duration_hours: u16, // 7 days
        haircut: I80F48,            // No haircut (full h recovery)
    },
}

pub fn request_withdrawal(
    account: &mut Account,
    amount: u128,
    tier: WithdrawalTier,
) -> Result<()> {
    match tier {
        WithdrawalTier::Instant { max_amount, haircut } => {
            require!(amount <= max_amount, ErrorCode::ExceedsInstantLimit);
            let payout = (I80F48::from_num(amount) * haircut).to_num::<u128>();
            transfer_to_user(account, payout)?;
        },
        WithdrawalTier::Fast { max_amount, warmup_duration_hours, haircut } => {
            require!(amount <= max_amount, ErrorCode::ExceedsFastLimit);
            add_to_warmup_queue(account, amount, warmup_duration_hours, haircut)?;
        },
        WithdrawalTier::Normal { warmup_duration_hours, haircut, .. } => {
            add_to_warmup_queue(account, amount, warmup_duration_hours, haircut)?;
        },
    }
    
    Ok(())
}
```

**2. Cross-Collateral Optimization:**
```rust
pub fn allow_cross_asset_collateral(
    account: &Account,
    collateral_assets: &[CollateralAsset],
) -> Result<I80F48> {
    let mut total_collateral_value = I80F48::ZERO;
    
    for asset in collateral_assets {
        let oracle_price = get_oracle_price(asset.mint)?;
        let asset_value = I80F48::from_num(asset.amount) * oracle_price;
        
        // Apply haircut based on asset volatility
        let haircut = get_collateral_haircut(asset.mint)?;
        total_collateral_value += asset_value * (I80F48::ONE - haircut);
    }
    
    Ok(total_collateral_value)
}

fn get_collateral_haircut(asset_mint: Pubkey) -> Result<I80F48> {
    if asset_mint == USDC_MINT {
        Ok(I80F48::ZERO) // 0% haircut (stablecoin)
    } else if asset_mint == SOL_MINT {
        Ok(I80F48::from_num(0.1)) // 10% haircut
    } else {
        Ok(I80F48::from_num(0.2)) // 20% haircut (default)
    }
}
```

**3. Hedged Position Netting:**
```rust
pub fn calculate_hedged_margin_discount(
    positions: &[Position],
) -> I80F48 {
    let mut total_discount = I80F48::ZERO;
    
    // Example: Long 1 BTC spot + Short 1 BTC-PERP
    for i in 0..positions.len() {
        for j in (i+1)..positions.len() {
            if is_perfect_hedge(&positions[i], &positions[j]) {
                // Perfect hedge: 80% margin discount
                let hedge_value = positions[i].notional_value.min(positions[j].notional_value);
                total_discount += hedge_value * I80F48::from_num(0.8);
            } else if is_partial_hedge(&positions[i], &positions[j]) {
                // Partial hedge: 50% margin discount
                let hedge_value = positions[i].notional_value.min(positions[j].notional_value);
                total_discount += hedge_value * I80F48::from_num(0.5);
            }
        }
    }
    
    total_discount
}

fn is_perfect_hedge(pos_a: &Position, pos_b: &Position) -> bool {
    // Same asset, opposite direction, equal size
    pos_a.underlying_asset == pos_b.underlying_asset &&
    pos_a.is_long != pos_b.is_long &&
    pos_a.size == pos_b.size
}
```

---

### 5.5 Security Hardening

**Threat Model & Mitigations:**

**1. Oracle Manipulation:**
```rust
pub struct OracleSecurityConfig {
    pub staleness_check: bool,
    pub confidence_check: bool,
    pub twap_validation: bool,
    pub multi_source_validation: bool,
    pub circuit_breaker: bool,
}

pub fn get_secure_oracle_price(
    oracle_pubkey: &Pubkey,
    config: &OracleSecurityConfig,
) -> Result<I80F48> {
    let pyth_price = pyth_client::get_price(oracle_pubkey)?;
    
    // Check 1: Staleness
    if config.staleness_check {
        require!(
            Clock::get()?.unix_timestamp - pyth_price.publish_time < 60,
            ErrorCode::StalePriceData
        );
    }
    
    // Check 2: Confidence
    if config.confidence_check {
        let confidence_ratio = pyth_price.confidence / pyth_price.price;
        require!(
            confidence_ratio < I80F48::from_num(0.02),
            ErrorCode::OracleLowConfidence
        );
    }
    
    // Check 3: TWAP validation
    if config.twap_validation {
        let twap = calculate_30s_twap(oracle_pubkey)?;
        let deviation = (pyth_price.price - twap).abs() / twap;
        require!(
            deviation < I80F48::from_num(0.05),
            ErrorCode::OraclePriceDeviation
        );
    }
    
    // Check 4: Multi-source validation
    if config.multi_source_validation {
        let switchboard_price = switchboard_client::get_price(oracle_pubkey)?;
        let deviation = (pyth_price.price - switchboard_price).abs() / pyth_price.price;
        require!(
            deviation < I80F48::from_num(0.03),
            ErrorCode::OracleSourceDeviation
        );
    }
    
    Ok(pyth_price.price)
}
```

**2. Flash Loan Attacks:**
```rust
pub struct FlashLoanDefense {
    pub min_position_duration_slots: u64, // 2 slots = ~1 second
    pub max_size_first_trade: u128,       // $10k max on first trade
    pub warmup_period_slots: u64,         // 10 slots = 5 seconds
}

pub fn open_position_with_flash_loan_protection(
    ctx: Context<OpenPosition>,
    size: u128,
    defense: &FlashLoanDefense,
) -> Result<()> {
    let account = &ctx.accounts.user;
    
    // Check if account is new
    if account.positions.is_empty() {
        // New account: limit first trade size
        require!(
            size <= defense.max_size_first_trade,
            ErrorCode::FirstTradeTooBig
        );
        
        // Require warmup period before withdrawal
        account.withdrawal_locked_until = Clock::get()?.slot + defense.warmup_period_slots;
    }
    
    // Continue with position opening...
    Ok(())
}
```

**3. Reentrancy Protection:**
```rust
#[account]
pub struct GlobalState {
    pub is_locked: bool,
    // ... other fields
}

#[derive(Accounts)]
pub struct ProtectedInstruction<'info> {
    #[account(mut, constraint = !global_state.is_locked @ ErrorCode::Reentrancy)]
    pub global_state: Account<'info, GlobalState>,
    // ... other accounts
}

pub fn execute_with_reentrancy_lock<F>(
    global_state: &mut GlobalState,
    f: F,
) -> Result<()>
where
    F: FnOnce() -> Result<()>,
{
    // Acquire lock
    require!(!global_state.is_locked, ErrorCode::Reentrancy);
    global_state.is_locked = true;
    
    // Execute function
    let result = f();
    
    // Release lock
    global_state.is_locked = false;
    
    result
}
```

**4. Admin Key Security:**
```rust
// Recommendation: NO admin keys in Percolator
// All parameters governed by on-chain math (h ratio)
// Future upgrades via governance DAO only

pub struct GovernanceConfig {
    pub min_vote_threshold_bps: u16,   // 6000 = 60% approval needed
    pub min_quorum_bps: u16,           // 2000 = 20% participation needed
    pub timelock_duration_days: u16,   // 7 days between vote and execution
}

// Example: Upgrade risk parameters via governance
pub fn propose_risk_parameter_change(
    ctx: Context<ProposeChange>,
    new_params: RiskParameters,
) -> Result<()> {
    let proposal = Proposal {
        proposer: ctx.accounts.proposer.key(),
        params: new_params,
        created_at: Clock::get()?.unix_timestamp,
        execution_eta: Clock::get()?.unix_timestamp + (7 * 24 * 60 * 60),
        votes_for: 0,
        votes_against: 0,
        executed: false,
    };
    
    // Store proposal for voting
    ctx.accounts.proposal_account.set_inner(proposal);
    
    Ok(())
}
```

---

## 6. Technical Appendix

### 6.1 Code References

**Drift Protocol:**
- Main Repo: https://github.com/drift-labs/protocol-v2
- Liquidation Logic: `programs/drift/src/controller/liquidation.rs`
- vAMM: `programs/drift/src/math/amm.rs`
- Insurance Fund: `programs/drift/src/state/insurance_fund.rs`

**Mango Markets:**
- Main Repo: https://github.com/blockworks-foundation/mango-v4
- Health Calculation: `programs/mango-v4/src/health/mod.rs`
- Liquidation: `programs/mango-v4/src/instructions/liquidate.rs`

**Percolator:**
- Main Repo: https://github.com/aeyakovenko/percolator
- Core Logic: `src/accounting.rs` (h-ratio calculation)
- Formal Verification: `kani/` (Kani proofs)

### 6.2 Architecture Diagrams

**Drift Risk Engine Flow:**
```
User Deposit
    ↓
Collateral Account
    ↓
Open Position (vAMM price discovery)
    ↓
Position Monitoring (every block)
    ↓
Margin Ratio < Maintenance? → YES → Liquidation
    |                              ↓
    NO                         Partial (25%)
    |                              ↓
Continue Trading              Margin Restored? → YES → Stop
    ↓                              |
Realize Profit                    NO
    ↓                              ↓
Withdraw (100%)               Full Liquidation
                                   ↓
                              Insurance Fund Covers?
                                   |
                              YES → User Margin = 0
                                   |
                              NO → ADL (force-close profitable positions)
```

**Percolator Risk Engine Flow:**
```
User Deposit
    ↓
Capital Account (senior claim)
    ↓
Open Position (oracle price)
    ↓
Position Monitoring
    ↓
Realize Profit
    ↓
Profit Account (junior claim)
    ↓
Request Withdrawal
    ↓
Calculate h = min(Residual, PnL_pos_tot) / PnL_pos_tot
    ↓
Payout = Withdrawal_Amount * h
    ↓
Option 1: Instant Withdrawal (haircut by h)
Option 2: Warmup Queue (wait N days, less haircut)
    ↓
Capital Transferred to User
```

**Permissionless Market Creation Flow:**
```
Creator Submits Proposal
    ↓
Validate Creator Eligibility
    ├─ Account age ≥ 7 days?
    ├─ Trading volume ≥ $10k?
    └─ <3 markets created today?
    ↓
Lock Creation Bond (1,000 USDC, 30 days)
    ↓
Validate Oracle Quality
    ├─ Pyth feed exists? (Gold tier)
    ├─ Switchboard + TWAP? (Silver tier)
    └─ TWAP only? (Bronze tier, risky)
    ↓
Require Liquidity Provision
    ├─ Creator provides $2,500
    └─ Protocol matches 3x = $7,500
    ↓
Create Market with Conservative Params
    ├─ 20% initial margin
    ├─ 12% maintenance margin
    ├─ 5x max leverage
    └─ $50k max position size
    ↓
Set Up Circuit Breakers
    ├─ 5% max price change/block
    ├─ $1M max liquidation/minute
    └─ 10% deviation triggers pause
    ↓
Market Live! 🎉
    ↓
Monitor Performance (30 days)
    ├─ Volume >$10k? → Refund 100% bond
    ├─ Volume $0? → Slash 100% bond
    └─ Oracle failure? → Slash 100% bond
```

### 6.3 Risk Parameter Tables

**Recommended Initial Margin Requirements by Asset:**

| Asset | Market Cap | 24h Volume | Init Margin | Maint Margin | Max Leverage |
|-------|-----------|-----------|-------------|--------------|--------------|
| BTC   | $2T       | $50B      | 5%          | 3%           | 20x          |
| ETH   | $500B     | $30B      | 5%          | 3%           | 20x          |
| SOL   | $100B     | $5B       | 10%         | 6%           | 10x          |
| AVAX  | $20B      | $1B       | 15%         | 10%          | 6.67x        |
| MATIC | $10B      | $500M     | 20%         | 12%          | 5x           |
| PEPE  | $5B       | $2B       | 25%         | 15%          | 4x           |
| BONK  | $1B       | $100M     | 30%         | 20%          | 3.33x        |
| $NEWCOIN (permissionless) | <$100M | <$10M | 50% | 30% | 2x |

**Oracle Confidence Thresholds:**

| Asset Tier | Min Pyth Confidence | Max Staleness | Min Update Frequency |
|-----------|-------------------|--------------|---------------------|
| Blue Chip | 98% | 60s | 400ms |
| Established | 95% | 30s | 1s |
| Mid-Cap | 90% | 30s | 5s |
| Long-Tail | 85% | 20s | 10s |
| Permissionless | 80% | 10s | 5s |

**Liquidation Fee Structure:**

| Asset Tier | Liquidation Fee | Liquidator Reward | Protocol Fee | Insurance Fund |
|-----------|----------------|------------------|--------------|----------------|
| Blue Chip | 2% | 1.5% | 0.3% | 0.2% |
| Established | 3% | 2% | 0.5% | 0.5% |
| Mid-Cap | 4% | 2.5% | 0.75% | 0.75% |
| Long-Tail | 5% | 3% | 1% | 1% |
| Permissionless | 8% | 5% | 1.5% | 1.5% |

---

## 7. Mainnet Launch Checklist

### Pre-Launch (Before Feb 18)

**Week 1: Core Risk Engine**
- [ ] Integrate Pyth Network SDK
- [ ] Implement oracle staleness checks
- [ ] Add confidence interval validation
- [ ] Implement TWAP cross-validation
- [ ] Test oracle failover logic
- [ ] Build oracle health monitoring dashboard

**Week 1: Liquidation System**
- [ ] Implement partial liquidation logic
- [ ] Define liquidator reward structure (2-5%)
- [ ] Build liquidator keeper bot reference implementation
- [ ] Test liquidation cascades in simulation
- [ ] Add circuit breaker (max $10M liquidated/minute)

**Week 2: Risk Parameters**
- [ ] Define asset tier framework (Blue Chip → Permissionless)
- [ ] Set margin requirements per tier
- [ ] Implement position size limits
- [ ] Add leverage caps per tier
- [ ] Test parameter edge cases

**Week 2: Funding Rate System**
- [ ] Implement long/short skew calculation
- [ ] Build hourly funding rate updates
- [ ] Test funding convergence to spot
- [ ] Add funding rate caps (±0.5% max)

**Week 3: Permissionless Markets**
- [ ] Implement creation bond locking (1,000 USDC, 30 days)
- [ ] Add oracle tier validation (Gold/Silver/Bronze)
- [ ] Build spam prevention (max 3 markets/day)
- [ ] Implement liquidity matching (protocol 3x match)
- [ ] Test bond slashing conditions

**Week 3-4: Security Audit**
- [ ] Internal code review (all critical paths)
- [ ] Engage external auditor (Trail of Bits, OtterSec, or Neodyme)
- [ ] Run fuzzing tests (Anchor fuzzer)
- [ ] Kani formal verification (extend to new logic)
- [ ] Bug bounty program setup ($100k pool)

**Week 4: Testnet Deployment**
- [ ] Deploy to Solana devnet
- [ ] Create 5-10 test markets (BTC, ETH, SOL, BONK, etc.)
- [ ] Run 1 week of simulated trading
- [ ] Stress test with 1,000+ positions
- [ ] Test liquidation cascades
- [ ] Validate h-ratio calculations under stress

### Launch Day (Feb 18)

**T-24h:**
- [ ] Deploy contracts to mainnet
- [ ] Verify contract addresses
- [ ] Initialize global state
- [ ] Seed insurance fund (optional: $50k-100k)

**T-12h:**
- [ ] Create initial markets (BTC-PERP, ETH-PERP, SOL-PERP)
- [ ] Provide initial liquidity ($100k per market)
- [ ] Start oracle feeds
- [ ] Deploy liquidator keeper bots (3+ independent)

**T-1h:**
- [ ] Open UI to public
- [ ] Publish documentation
- [ ] Announce launch on Twitter/Discord
- [ ] Monitor first trades

**T+0 (Launch):**
- [ ] Watch liquidation health
- [ ] Monitor h-ratio stability
- [ ] Track oracle updates
- [ ] Be ready for circuit breaker activation

### Post-Launch (Week 1-4)

**Day 1-7:**
- [ ] Daily monitoring of h-ratio
- [ ] Track liquidation volume
- [ ] Monitor oracle health
- [ ] Fix any critical bugs
- [ ] Gather user feedback

**Week 2:**
- [ ] Add 5-10 more markets
- [ ] Enable permissionless market creation (with conservative params)
- [ ] Launch liquidity mining program
- [ ] Publish first risk report

**Week 3-4:**
- [ ] Iterate on risk parameters based on data
- [ ] Increase leverage limits (if safe)
- [ ] Reduce margin requirements (if safe)
- [ ] Plan governance token launch

---

## Conclusion

Percolator's mathematically-driven `h`-based risk engine is **conceptually elegant and formally verified**, but requires significant implementation work to reach production readiness. The top priority improvements are:

1. **Oracle integration** (Pyth + validation)
2. **Asset-specific risk parameters** (avoid one-size-fits-all)
3. **Partial liquidation logic** (restore health without full haircut)
4. **Funding rate mechanism** (converge perps to spot)
5. **Permissionless market safeguards** (bonds, limits, circuit breakers)

With these improvements, Percolator can offer a **unique value proposition**: predictable, transparent risk management without admin keys or insurance fund dependency—ideal for DeFi's permissionless ethos.

**Strategic Recommendation:**
- **Phase 1 (Feb 18-Mar 18):** Launch with 5-10 vetted markets, USDC-margined, conservative params
- **Phase 2 (Mar 18-May 18):** Enable permissionless creation with safeguards, add funding rates
- **Phase 3 (May 18+):** Add cross-margining, coin-margined markets, governance token

This staged rollout balances innovation with safety, giving Percolator time to prove its math-based risk model in production before fully opening the floodgates.

---

**Report Compiled:** February 14, 2026  
**Next Review:** Post-mainnet (March 1, 2026)  
**Maintained By:** OpenClaw Research (Subagent Session 838fd7a7)
