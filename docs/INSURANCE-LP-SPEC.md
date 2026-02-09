# Insurance LP Token System — Full Implementation Spec

**Status:** Planning  
**Author:** Cobra  
**Date:** 2026-02-09  
**Design source:** toly's confirmation — "Some spl-token is a claim on insurance → LPs earn the token based on value at risk"

---

## 1. Overview

Insurance LPs deposit collateral into a market's insurance fund. In return, they receive SPL tokens (claim tokens) representing their proportional share of the insurance pool. The pool earns yield from:
- Trading fees (a portion routes to insurance)
- Liquidation profits
- Maintenance fees

Yield accrues passively — the insurance fund balance grows while the LP token supply stays constant, so each LP token's redemption value increases over time.

---

## 2. Architecture Decision

**On-chain (Option A)** — Two new program instructions handle mint/burn atomically alongside vault transfers. No off-chain trust required.

### Why not off-chain?
An off-chain minter would need a separate authority keypair, creating a trust point. On-chain PDAs eliminate this. The insurance fund is the most security-critical pool in the system — it backstops all trader positions.

---

## 3. New On-Chain State

### 3a. MarketConfig additions (appended after `last_effective_price_e6`)

```rust
/// Insurance LP mint address (created at InitMarket or via new instruction)
pub insurance_lp_mint: [u8; 32],

/// Total insurance LP tokens minted (tracked on-chain for share calculation)
/// Redundant with SPL supply but avoids a CPI to read supply during withdraw.
pub insurance_lp_supply: u64,
```

**Layout impact:** +40 bytes to MarketConfig. This is inside the slab (before ENGINE_OFF), so SLAB_LEN changes. All 4 variants must be rebuilt.

**Alternative (zero layout change):** Store `insurance_lp_mint` as a PDA derived from `["ins_lp", slab_pubkey]`. The supply can be read from the SPL mint account (passed as an account). This avoids changing SLAB_LEN.

**→ Decision: PDA-derived mint + read SPL supply from account.** Zero slab layout change. More robust.

### 3b. Insurance LP Mint (PDA)

```
Seeds: ["ins_lp", slab_pubkey]
Bump: derived
```

- **Decimals:** Same as collateral mint (typically 9 for SOL-based)
- **Mint authority:** PDA `["vault", slab_pubkey]` (same authority that controls the vault — this PDA already exists and is used for vault token transfers)
- **Freeze authority:** None (tokens are freely transferable)

---

## 4. New Instructions

### Tag 24: `CreateInsuranceMint`

Creates the SPL mint for a market's insurance LP tokens. Can only be called once per market. Admin only.

**Accounts:**
| # | Account | Writable | Signer | Description |
|---|---------|----------|--------|-------------|
| 0 | admin | ✗ | ✓ | Market admin |
| 1 | slab | ✓ | ✗ | Market slab |
| 2 | ins_lp_mint | ✓ | ✗ | PDA: `["ins_lp", slab]` — will be created |
| 3 | vault_authority | ✗ | ✗ | PDA: `["vault", slab]` — becomes mint authority |
| 4 | system_program | ✗ | ✗ | For account creation |
| 5 | token_program | ✗ | ✗ | SPL Token |
| 6 | rent | ✗ | ✗ | Rent sysvar |
| 7 | payer | ✓ | ✓ | Pays rent for mint account |

**Logic:**
1. Verify admin signer, slab guard, initialized
2. Derive PDA `["ins_lp", slab]` and verify account 2 matches
3. Check mint doesn't already exist (account 2 data len == 0)
4. Create mint account (CPI to system_program)
5. Initialize mint (CPI to spl_token::initialize_mint) with:
   - Decimals: read from collateral mint (pass as additional account, or hardcode)
   - Mint authority: vault_authority PDA
   - Freeze authority: None
6. **No slab state changes** (mint is externally tracked via PDA derivation)

**Why separate from InitMarket?** Existing markets can upgrade. New markets can include it in their setup transaction.

### Tag 25: `DepositInsurance { amount: u64 }`

User deposits collateral → receives LP tokens proportional to their share.

**Accounts:**
| # | Account | Writable | Signer | Description |
|---|---------|----------|--------|-------------|
| 0 | depositor | ✗ | ✓ | User depositing |
| 1 | slab | ✓ | ✗ | Market slab |
| 2 | depositor_ata | ✓ | ✗ | User's collateral token account |
| 3 | vault | ✓ | ✗ | Market vault |
| 4 | token_program | ✗ | ✗ | SPL Token |
| 5 | ins_lp_mint | ✓ | ✗ | Insurance LP mint (PDA) |
| 6 | depositor_lp_ata | ✓ | ✗ | User's LP token account |
| 7 | vault_authority | ✗ | ✗ | PDA (mint authority for LP tokens) |

**Logic:**
1. Verify slab guard, initialized, not resolved
2. Verify vault, token accounts
3. Verify `ins_lp_mint` matches PDA `["ins_lp", slab]`
4. Transfer `amount` collateral from depositor → vault
5. Convert to units: `(units, dust) = base_to_units(amount, unit_scale)`
6. Calculate LP tokens to mint:
   - Read current insurance fund balance (units) from engine
   - Read current LP supply from `ins_lp_mint` account
   - If supply == 0: mint `units` LP tokens (1:1 initial ratio)
   - If supply > 0: mint `units * supply / insurance_balance` LP tokens
7. Top up insurance fund: `engine.top_up_insurance_fund(units)`
8. Mint LP tokens to depositor (CPI to spl_token::mint_to, signed by vault_authority PDA)

**Share calculation (critical — must be exact):**
```
lp_tokens_to_mint = deposit_units * total_lp_supply / insurance_balance_before_deposit
```

If `insurance_balance == 0 && supply > 0`: Error (shouldn't happen — means fund was drained). Reject deposit.
If `insurance_balance > 0 && supply == 0`: Error (orphaned fund — admin topped up without LP mint). Allow admin to create mint and initial deposit.

### Tag 26: `WithdrawInsuranceLP { lp_amount: u64 }`

User burns LP tokens → receives proportional share of insurance fund.

**Accounts:**
| # | Account | Writable | Signer | Description |
|---|---------|----------|--------|-------------|
| 0 | withdrawer | ✗ | ✓ | User withdrawing |
| 1 | slab | ✓ | ✗ | Market slab |
| 2 | withdrawer_ata | ✓ | ✗ | User's collateral token account |
| 3 | vault | ✓ | ✗ | Market vault |
| 4 | token_program | ✗ | ✗ | SPL Token |
| 5 | ins_lp_mint | ✓ | ✗ | Insurance LP mint (PDA) |
| 6 | withdrawer_lp_ata | ✓ | ✗ | User's LP token account |
| 7 | vault_authority | ✗ | ✗ | PDA (vault + mint authority) |

**Logic:**
1. Verify slab guard, initialized
2. Verify vault, token accounts, LP mint PDA
3. Read insurance balance and LP supply
4. Calculate collateral to return:
   ```
   units_to_return = lp_amount * insurance_balance / total_lp_supply
   ```
5. Convert units to base tokens: `base_amount = units_to_base(units_to_return, unit_scale)`
6. **Safety check:** `insurance_balance - units_to_return >= minimum_insurance_reserve`
   - Minimum reserve = risk_reduction_threshold (already in engine params)
   - If withdrawal would drop below threshold → reject (prevents draining insurance during active trading)
7. Reduce insurance fund: `engine.insurance_fund.balance -= units_to_return`
8. Burn LP tokens from withdrawer (CPI to spl_token::burn, user is authority over their own tokens)
9. Transfer collateral from vault → withdrawer (CPI signed by vault_authority PDA)

**Anti-drain protections:**
- Cannot withdraw below `risk_reduction_threshold`
- Cannot withdraw from resolved markets (use existing Tag 20 WithdrawInsurance for that)
- Withdrawal respects the insurance fund's role as backstop

---

## 5. Yield Mechanics

**No separate yield distribution instruction needed.** The insurance fund balance grows naturally from:

1. **Trading fees** — `fee_payment` on InitUser, InitLP, and per-trade fees all route partially to `insurance_fund.balance`
2. **Liquidation profits** — when liquidations result in surplus, it goes to insurance
3. **Maintenance fees** — periodic fees from all accounts

Since LP token supply only changes on deposit/withdraw, and insurance balance grows from fees, the **redemption ratio (insurance_balance / lp_supply) increases over time**. This is the yield.

Example:
- Deposit 100 SOL when insurance = 100, supply = 100 → get 100 LP tokens
- After trading fees accumulate: insurance = 150, supply = 100
- Each LP token now redeemable for 1.5 SOL
- APY = observable from (current_ratio / initial_ratio - 1) * annualization_factor

---

## 6. VaR-Based Yield Weighting (Future Enhancement)

Toly mentioned "LPs earn the token based on value at risk." In the initial implementation, all LP depositors earn equally (pro-rata share of the pool). 

**Phase 2 (future):** Different markets have different risk profiles. A global insurance pool across markets could weight yield distribution by each market's VaR. This requires:
- Cross-market insurance aggregation
- VaR calculation per market (already in risk engine)
- More complex token mechanics

**For now:** Per-market insurance pools with simple pro-rata yield is the right starting point.

---

## 7. UI Components

### 7a. Insurance LP Panel (on trade page)

```
┌─────────────────────────────────────┐
│  🛡️ Insurance Pool                  │
│                                     │
│  Pool Size:      1,234.56 SOL       │
│  Your Share:     45.23 LP (3.7%)    │
│  Redemption:     1.0234 SOL/LP      │
│  Est. APY:       12.4%              │
│                                     │
│  ┌─────────┐  ┌──────────────┐      │
│  │ Deposit  │  │  Withdraw    │      │
│  └─────────┘  └──────────────┘      │
│                                     │
│  Amount: [________] SOL             │
│  You receive: ~XX.XX LP tokens      │
│                                     │
│  [ Provide Insurance ]              │
└─────────────────────────────────────┘
```

### 7b. Portfolio Integration

Add insurance LP positions to the portfolio view:
- Show LP token balance per market
- Show current redemption value
- Show unrealized yield (current value - deposit value)

### 7c. Market Stats

Add to market cards / stats:
- Insurance pool size
- Insurance APY (trailing 7d/30d)
- Number of insurance LPs

---

## 8. Backend / Server Integration

### 8a. Supabase Schema

```sql
-- Insurance LP events (deposits/withdrawals)
CREATE TABLE insurance_lp_events (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    slab TEXT NOT NULL,
    user_wallet TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('deposit', 'withdraw')),
    collateral_amount BIGINT NOT NULL,
    lp_tokens BIGINT NOT NULL,
    insurance_balance_before BIGINT NOT NULL,
    lp_supply_before BIGINT NOT NULL,
    tx_signature TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insurance LP snapshots (for APY calculation)
CREATE TABLE insurance_snapshots (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    slab TEXT NOT NULL,
    insurance_balance BIGINT NOT NULL,
    lp_supply BIGINT NOT NULL,
    redemption_rate_e6 BIGINT NOT NULL, -- balance/supply * 1e6
    snapshot_slot BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 8b. Server Service: InsuranceLPService

- Polls insurance fund balance + LP mint supply every 30s
- Records snapshots for APY calculation
- Computes trailing 7d/30d APY from snapshot history
- Exposes via API:
  - `GET /api/markets/[slab]/insurance` → pool stats, APY
  - `GET /api/markets/[slab]/insurance/history` → deposit/withdraw events

---

## 9. Implementation Order

| Phase | Task | Files | Estimate |
|-------|------|-------|----------|
| **P1** | Add `CreateInsuranceMint` (Tag 24) to Rust program | `program/src/percolator.rs` | 2h |
| **P2** | Add `DepositInsurance` (Tag 25) to Rust program | `program/src/percolator.rs` | 3h |
| **P3** | Add `WithdrawInsuranceLP` (Tag 26) to Rust program | `program/src/percolator.rs` | 3h |
| **P4** | Build & deploy all 3 slab variants to devnet | CI + deploy scripts | 1h |
| **P5** | TypeScript instruction builders + hooks | `app/lib/insurance-lp.ts`, `app/hooks/useInsuranceLP.ts` | 3h |
| **P6** | Insurance LP UI panel | `app/components/trade/InsuranceLPPanel.tsx` | 2h |
| **P7** | Portfolio integration | `app/components/portfolio/` | 1h |
| **P8** | Backend service + API routes + Supabase schema | `packages/server/`, `supabase/` | 2h |
| **P9** | End-to-end testing on devnet | Scripts + manual | 2h |

**Total:** ~19 hours of focused work

---

## 10. Security Considerations

1. **Integer overflow:** All share calculations use u128 intermediate values. `deposit * supply` could overflow u128 if both are near u64::MAX — use checked_mul + checked_div.

2. **Rounding:** Always round LP tokens DOWN on deposit (user gets fewer tokens), round collateral DOWN on withdrawal (user gets less back). This ensures the pool is never underfunded.

3. **First depositor attack:** Classic ERC-4626 issue. Attacker deposits 1 wei, donates a large amount directly, then next depositor gets 0 tokens. **Mitigation:** On first deposit (supply == 0), mint tokens 1:1 with units. The insurance fund can only grow via the program's own fee routes (direct token transfers to vault don't affect engine balance), so donation attacks aren't possible.

4. **Re-entrancy:** Not applicable on Solana (no re-entrancy in BPF).

5. **Insurance drain:** Withdrawal is gated by `risk_reduction_threshold`. Cannot withdraw below it.

6. **Resolved market:** Deposits blocked on resolved markets. Withdrawals use the existing Tag 20 mechanism.

7. **Dust accumulation:** Same dust handling as existing TopUpInsurance — track in header reserved bytes.

---

## 11. Testing Plan

### Unit Tests (Rust)
- CreateInsuranceMint: success, double-create fails, non-admin fails
- DepositInsurance: first deposit 1:1, second deposit proportional, resolved market blocks
- WithdrawInsuranceLP: proportional redemption, below-threshold rejected, full withdrawal
- Share math: edge cases (very large/small amounts, rounding)

### Integration Tests (TypeScript)
- Full flow: create mint → deposit → verify LP balance → trade (generate fees) → verify pool grew → withdraw → verify collateral returned
- Multi-user: 2 depositors, verify proportional shares
- Edge: deposit 1 lamport, withdraw all

### Devnet E2E
- Deploy all 3 tier variants
- Create markets with insurance mint
- Deposit/withdraw via UI
- Verify APY accrual after trades

---

## 12. Open Questions

1. **Should CreateInsuranceMint be auto-called in market creation flow?** For new markets via Quick Launch, yes. Add it as step 7 in the creation pipeline. For existing markets, admin calls it separately.

2. **Decimals for LP mint:** Match collateral mint decimals (9 for SOL). This keeps the math clean.

3. **Transferability:** LP tokens are freely transferable (no freeze authority). This enables secondary market trading of insurance positions. Is this desired? **Decision: Yes** — it's a feature, not a bug. Makes insurance positions composable.

4. **Minimum deposit:** Should there be a minimum? The first depositor sets the initial ratio. A very small first deposit is fine because donation attacks aren't possible (see security #3).

---

*Ready for implementation on Khubair's approval.*
