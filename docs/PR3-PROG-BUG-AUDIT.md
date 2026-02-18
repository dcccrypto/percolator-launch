# PR #3 Bug Audit: Insurance LP Deposit/Withdraw with Cooldown

**Auditor:** Cobra (automated deep audit)  
**Date:** 2026-02-17  
**PR:** [aeyakovenko/percolator-prog#3](https://github.com/aeyakovenko/percolator-prog/pull/3)  
**Scope:** Tags 24 (InitInsuranceLPConfig), 25 (DepositInsuranceLP), 26 (WithdrawInsuranceLP)  
**Diff:** +1507 lines (src/percolator.rs + tests/unit.rs)

---

## Overall Assessment

### ⚠️ NEEDS FIXES — 1 Critical, 2 High, 3 Medium, 3 Low, 3 Info

The PR is well-structured and follows existing patterns in the codebase. The core pro-rata math is sound, conservation is maintained through the engine's `vault` and `insurance_fund.balance` accounting, and the cooldown mechanism works as designed. However, there is **one critical vulnerability** (missing LP mint validation on withdraw) that must be fixed before merge, and two high-severity issues that should be addressed.

---

## Findings

---

### FINDING 1 — Missing LP Mint Validation on Withdraw

**Severity:** 🔴 CRITICAL  
**Location:** `src/percolator.rs`, Tag 26 (WithdrawInsuranceLP), around line 5133–5260  
**Category:** Account Validation

#### Description

The `WithdrawInsuranceLP` instruction reads LP supply from `a_lp_mint` and burns tokens from it, but **never validates that `a_lp_mint` is the legitimate LP mint** (i.e., the one whose `mint_authority` is the vault authority PDA). The deposit instruction (Tag 25) validates this at line ~4985:

```rust
#[cfg(not(feature = "test"))]
{
    let mint_data = a_lp_mint.try_borrow_data()?;
    let lp_mint_state = spl_token::state::Mint::unpack(&mint_data)?;
    match lp_mint_state.mint_authority {
        solana_program::program_option::COption::Some(ma) if ma == auth => {}
        _ => return Err(PercolatorError::InvalidInsuranceLPMint.into()),
    }
}
```

The withdraw instruction has **no equivalent check**.

#### Impact

An attacker can:
1. Create a **fake SPL mint** with themselves as mint authority
2. Mint tokens to themselves on this fake mint (e.g., supply=1, balance=1)
3. Call `WithdrawInsuranceLP { lp_amount: 1 }` passing their fake mint as `a_lp_mint`
4. The code reads `lp_supply = 1` from the fake mint
5. Reads real `insurance_balance` from the engine (e.g., 1,000,000 units)
6. Calculates `units_to_withdraw = 1 * 1,000,000 / 1 = 1,000,000` — **the entire fund**
7. Burns the fake token (SPL burn succeeds because the token account references the fake mint and user is authority)
8. Debits real insurance fund and vault
9. Transfers real collateral to attacker

**Result: Complete drainage of the insurance fund in a single transaction.**

#### Proof of Concept

```
1. Attacker creates mint M_fake (mint_authority = attacker)
2. Attacker creates token account T_fake for M_fake
3. Attacker mints 1 token to T_fake via M_fake
4. Attacker creates a legitimate deposit (1 lamport) to get a valid stake PDA with old deposit_slot
5. Wait for cooldown to elapse
6. Call WithdrawInsuranceLP {
     lp_amount: 1,
     accounts: [attacker, slab, T_fake, attacker_col_ata, vault, M_fake, stake_pda, config_pda, vault_auth, token_prog, clock]
   }
7. Receives entire insurance fund
```

#### Recommendation

Add the same LP mint authority validation to WithdrawInsuranceLP:

```rust
// Verify LP mint authority is vault_authority (same check as deposit)
{
    let mint_data = a_lp_mint.try_borrow_data()?;
    let lp_mint_state = spl_token::state::Mint::unpack(&mint_data)?;
    match lp_mint_state.mint_authority {
        solana_program::program_option::COption::Some(ma) if ma == auth => {}
        _ => return Err(PercolatorError::InvalidInsuranceLPMint.into()),
    }
}
```

**Even better:** Store the LP mint pubkey in the `InsuranceLPConfig` PDA on first initialization, then validate against it in both deposit and withdraw. This prevents a scenario where the admin changes the vault authority and an old mint becomes stale.

---

### FINDING 2 — Deposit When `insurance_balance == 0` AND `lp_supply > 0` Creates Free Value for Old LP Holders

**Severity:** 🔴 HIGH  
**Location:** `src/percolator.rs`, Tag 25, LP calculation branch (~line 5055)  
**Category:** Logic Bug / Economic Exploit

#### Description

The LP mint formula is:

```rust
let lp_tokens_to_mint: u64 = if lp_supply == 0 || insurance_balance == 0 {
    units  // 1:1 ratio
} else {
    units * lp_supply / insurance_balance
};
```

When `insurance_balance == 0` but `lp_supply > 0` (which happens when the insurance fund is fully drained by liquidations while LP tokens remain outstanding), the code falls into the `1:1` branch and mints `units` new LP tokens.

#### Impact

Consider this scenario:
1. Alice deposits 1,000,000 units, receives 1,000,000 LP tokens
2. Insurance fund is completely drained by liquidation events → `insurance_balance = 0`, but `lp_supply = 1,000,000` (Alice's tokens)
3. Bob deposits 1,000,000 units when `insurance_balance == 0`
4. Bob gets 1,000,000 LP tokens (1:1 because balance is 0)
5. Now: `insurance_balance = 1,000,000`, `lp_supply = 2,000,000`
6. Alice's previously-worthless LP tokens are now worth 500,000 units
7. Bob's deposit of 1,000,000 is now only worth 500,000 in LP terms

**Bob lost 500,000 units to Alice**, who contributed nothing to the current fund.

This is a grief/theft vector. Alice can even be the same person who caused the insurance drain.

#### Recommendation

When `insurance_balance == 0` and `lp_supply > 0`, the new deposit should NOT use 1:1 ratio. Options:

**Option A (Recommended):** Reject deposits when `insurance_balance == 0 && lp_supply > 0`:
```rust
if insurance_balance == 0 && lp_supply > 0 {
    return Err(ProgramError::InvalidAccountData); // stale LP tokens exist
}
```

**Option B:** Treat existing LP supply as worthless and reset:
```rust
if insurance_balance == 0 {
    // All existing LP tokens are worthless; mint 1:1 for new depositor.
    // Existing holders get diluted to 0 (which they already were).
    units
}
```

Option A is safer and simpler. The admin should burn or buyback stale LP tokens before re-enabling deposits.

---

### FINDING 3 — Cooldown Bypass via LP Token Transfer

**Severity:** 🔴 HIGH  
**Location:** `src/percolator.rs`, Tag 26, cooldown enforcement (~line 5207)  
**Category:** Cooldown Bypass / JIT Attack

#### Description

The cooldown is enforced per-user via the `InsuranceLPStake` PDA (keyed by `[slab, user]`). However, LP tokens are **freely transferable SPL tokens**. An attacker can:

1. Deposit via Address A → gets LP tokens, stake PDA records `deposit_slot`
2. Transfer LP tokens from A → Address B (standard SPL transfer, no cooldown check)
3. Address B already has an expired `InsuranceLPStake` PDA (or deposits 1 unit and waits out cooldown)
4. Address B calls `WithdrawInsuranceLP` with the transferred LP tokens

The cooldown check only verifies `stake_pda.deposit_slot + cooldown <= clock.slot`, but the LP tokens being burned may not be the ones that were deposited during that slot.

#### Impact

This allows JIT (Just-In-Time) attacks:
1. Attacker sees a profitable event coming (e.g., scheduled liquidation)
2. Deposits large amount via fresh address A
3. Transfers LP tokens to pre-prepared address B that has an expired cooldown
4. Withdraws via B immediately, capturing profit from the event
5. The cooldown intended to prevent this is completely bypassed

#### Recommendation

**Option A (Recommended):** Track LP token balance at deposit time and enforce that withdrawal amount ≤ balance at cooldown start:
```rust
pub struct InsuranceLPStake {
    pub slab: [u8; 32],
    pub deposit_slot: u64,
    pub lp_balance_at_deposit: u64,  // snapshot of LP balance when cooldown started
    pub _reserved: [u8; 8],
}
```
On withdraw, cap `lp_amount` to `min(lp_amount, lp_balance_at_deposit)` or reject if exceeds.

**Option B:** Make LP tokens non-transferable (freeze authority = vault_authority, set frozen on mint). This is simpler but reduces composability.

**Option C:** Use an escrow model where LP tokens are held by the program, not the user's wallet.

---

### FINDING 4 — Admin Can Retroactively Increase Cooldown to Trap Funds

**Severity:** 🟡 MEDIUM  
**Location:** `src/percolator.rs`, Tag 24 (InitInsuranceLPConfig), config update path  
**Category:** Trust/Governance Risk

#### Description

`InitInsuranceLPConfig` allows the admin to update `cooldown_slots` at any time. If a user deposited under a 2-day cooldown assumption, the admin can retroactively increase it to `u64::MAX`, effectively locking the user's funds forever.

The withdraw instruction reads the **current** config cooldown, not the cooldown at deposit time.

#### Impact

Admin can rug LP depositors by setting cooldown to an astronomically high value. While admin is trusted in this system, it's a design consideration worth noting for Toly's review.

#### Recommendation

Either:
1. Store the effective cooldown in the user's `InsuranceLPStake` PDA at deposit time and use `max(config_cooldown, stake_cooldown)` on withdraw
2. Add an upper bound on cooldown (e.g., max 30 days = ~6.5M slots)
3. Accept as a known admin trust assumption and document it

---

### FINDING 5 — `Rent::default()` Instead of `Rent::get()`

**Severity:** 🟡 MEDIUM  
**Location:** `src/percolator.rs`, lines ~4897 and ~5007  
**Category:** Correctness

#### Description

Both the config PDA and stake PDA creation use `Rent::default()` instead of `Rent::get()`:

```rust
let rent = solana_program::rent::Rent::default();
let lamports = rent.minimum_balance(space);
```

`Rent::default()` uses Solana's hardcoded default values. While these happen to match mainnet today, using `Rent::get()` (reads from the sysvar) is the canonical approach and would be correct if parameters ever change.

#### Impact

If Solana ever changes rent parameters, accounts could be created with insufficient lamports and be garbage-collected. Practically low risk on current mainnet, but violates best practice.

#### Recommendation

Replace with:
```rust
let rent = solana_program::rent::Rent::get()?;
```

Or pass the rent sysvar as an account and use `Rent::from_account_info()`.

---

### FINDING 6 — Rounding Favors Withdrawer Over LP Pool (Dust Leak)

**Severity:** 🟡 MEDIUM  
**Location:** `src/percolator.rs`, Tag 26 withdraw calculation (~line 5238)  
**Category:** Economic / Rounding

#### Description

The withdraw calculation uses integer floor division:

```rust
let units_to_withdraw = (lp_amount as u128) * insurance_balance / (lp_supply as u128);
```

This always rounds DOWN, which is correct (favors the pool, not the withdrawer). ✅

However, the deposit calculation also rounds DOWN:

```rust
let lp_tokens_to_mint = (units as u128) * (lp_supply as u128) / insurance_balance;
```

This means depositors get fewer LP tokens (rounds down), and withdrawers also get fewer units (rounds down). Both operations favor the pool, which means **small dust amounts accumulate in the insurance fund permanently**. Over many deposit/withdraw cycles, this creates a small "phantom surplus" — insurance fund balance not redeemable by any LP holder.

#### Impact

Not exploitable — the rounding consistently favors the pool, which is the correct direction. But if the LP supply ever reaches 0 while insurance_balance > 0 (all LP holders withdrew getting slightly less), those remaining units are stranded.

#### Recommendation

This is acceptable behavior. Document it: "Rounding always favors the insurance fund; small dust amounts may accumulate and are not individually claimable."

If desired, add a `sweep_phantom_surplus` admin function.

---

### FINDING 7 — `cumulative_deposited` Uses `saturating_add` — No Overflow Error

**Severity:** 🟢 LOW  
**Location:** `src/percolator.rs`, Tag 25, stake PDA update (~line 5116)  
**Category:** Accounting Inaccuracy

#### Description

```rust
stake.cumulative_deposited = stake.cumulative_deposited.saturating_add(lp_tokens_to_mint);
```

If a user deposits enough times, `cumulative_deposited` silently saturates at `u64::MAX` instead of returning an error. This field is tracked but never read by the program itself — it's purely informational.

#### Impact

Minimal. The field is not used in any logic. But a downstream indexer relying on it would get incorrect data after saturation.

#### Recommendation

Use `checked_add` and return an error, or accept saturation as documented behavior since the field is informational only.

---

### FINDING 8 — No Minimum Deposit Enforcement (Dust Deposit Attack)

**Severity:** 🟢 LOW  
**Location:** `src/percolator.rs`, Tag 25, amount validation (~line 5051)  
**Category:** Economic / Griefing

#### Description

The only validation is `amount != 0` and `units != 0` after scaling. An attacker can deposit the minimum unit (e.g., 1 unit) to:
1. Create a stake PDA (costs rent, funded by attacker)
2. Get 1 LP token (when `lp_supply == 0`)
3. Start a cooldown timer

While this isn't directly exploitable (the attacker pays rent and gets proportional LP tokens), it could be used to grief by creating many stake PDAs or establishing a cooldown anchor.

#### Impact

Low. The attacker pays for rent and gets proportional value. No economic damage.

#### Recommendation

Consider a minimum deposit amount (e.g., `units >= 1000` or configurable via config PDA). This is optional.

---

### FINDING 9 — No Check That LP Token Account Mint Matches `a_lp_mint` on Withdraw

**Severity:** 🟢 LOW  
**Location:** `src/percolator.rs`, Tag 26, `a_user_lp_ata` validation  
**Category:** Account Validation

#### Description

The withdraw instruction doesn't explicitly verify that `a_user_lp_ata.mint == a_lp_mint.key`. The SPL burn CPI will enforce this (burn fails if token account mint doesn't match the mint account), so this is defense-in-depth only.

However, `verify_token_account` is called on `a_user_col_ata` (the collateral output) but NOT on `a_user_lp_ata`. If the SPL program CPI somehow accepted mismatched mints (which it doesn't today), this would be exploitable.

#### Impact

None in practice — SPL token program enforces mint matching during burn. But explicit validation would be more robust.

#### Recommendation

Add `verify_token_account(a_user_lp_ata, a_user.key, a_lp_mint.key)?;` for defense-in-depth, or at minimum validate in non-test builds.

---

### FINDING 10 — No LP Mint Validation on Withdraw (Test Feature Flag Gap)

**Severity:** ℹ️ INFO  
**Location:** `src/percolator.rs`, Tag 25, `#[cfg(not(feature = "test"))]` block  
**Category:** Testing Gap

#### Description

The LP mint authority validation in the deposit instruction is wrapped in `#[cfg(not(feature = "test"))]`:

```rust
#[cfg(not(feature = "test"))]
{
    let mint_data = a_lp_mint.try_borrow_data()?;
    let lp_mint_state = spl_token::state::Mint::unpack(&mint_data)?;
    match lp_mint_state.mint_authority { ... }
}
```

This means the unit tests with `--features test` never exercise the mint authority check. A bug in this validation path would not be caught by existing tests.

#### Recommendation

Move LP mint validation outside the `#[cfg(not(feature = "test"))]` block, or add a separate integration test (without `test` feature) that verifies the check. The test harness already creates LP mints with the correct authority, so this should work.

---

### FINDING 11 — Blocked on Resolved Markets — Correct but Worth Documenting

**Severity:** ℹ️ INFO  
**Location:** `src/percolator.rs`, Tags 25/26, `is_resolved` check  
**Category:** Design

#### Description

Both deposit and withdraw are blocked when the market is resolved. This means LP holders **cannot withdraw their insurance fund share after market resolution**. The admin's `WithdrawInsurance` (Tag 20) drains the entire fund, and `WithdrawInsuranceLimited` (Tag 23) handles post-resolution withdrawal.

This is the correct design (LP holders should withdraw before resolution, or be handled through the existing admin withdrawal mechanism). But it should be clearly documented so LP depositors understand they must withdraw before market resolution or coordinate with the admin.

#### Recommendation

Document this in the instruction comments and user-facing documentation.

---

### FINDING 12 — No `a_vault` Writable Check in Deposit (Follows Existing Pattern)

**Severity:** ℹ️ INFO  
**Location:** `src/percolator.rs`, Tag 25  
**Category:** Account Validation

#### Description

The deposit instruction doesn't call `accounts::expect_writable(a_vault)` or `accounts::expect_writable(a_user_ata)`. The SPL token transfer CPI will fail if they're not writable, so this is not exploitable. This matches the existing pattern in Tag 9 (TopupInsurance) and other deposit instructions.

#### Recommendation

No action needed — consistent with codebase convention. The CPI acts as the enforcer.

---

## Conservation Proof Walkthrough

### Invariant: `engine.vault = Σ(account.capital) + insurance_fund.balance`

#### Deposit (Tag 25)

1. User sends `amount` base tokens → vault (SPL transfer)
2. `(units, dust) = base_to_units(amount, scale)`
3. `engine.top_up_insurance_fund(units)` → increases **both** `insurance_fund.balance` by `units` and `engine.vault` by `units`
4. LP tokens minted (off-chain from engine's perspective)

**Conservation check:**
- Vault token account: +amount (real tokens)
- engine.vault: +units ✅
- insurance_fund.balance: +units ✅
- engine.vault still = Σcapital + insurance ✅
- Dust tracked separately, periodically swept ✅

#### Withdraw (Tag 26)

1. Read `insurance_balance` from engine
2. Calculate `units_to_withdraw = lp_amount * insurance_balance / lp_supply`
3. Burn LP tokens (user side)
4. `engine.insurance_fund.balance -= units_to_withdraw`
5. `engine.vault -= units_to_withdraw`
6. `base_to_pay = units_to_base_checked(units_to_withdraw, scale)`
7. SPL transfer vault → user: `base_to_pay`

**Conservation check:**
- insurance_fund.balance: −units_to_withdraw ✅
- engine.vault: −units_to_withdraw ✅
- Vault token account: −base_to_pay ✅
- engine.vault still = Σcapital + insurance ✅

**Key concern:** Step 5 checks `req > engine.vault` AFTER subtracting from insurance. If insurance was funded by this LP mechanism, `engine.vault` includes it, so this should be safe. The check order is: subtract insurance first, then verify vault has enough. This is correct — vault should always be ≥ insurance + capital.

**Potential issue with ordering:** The code does:
```rust
engine.insurance_fund.balance = engine.insurance_fund.balance - req;
if req > engine.vault {
    return Err(PercolatorError::EngineInsufficientBalance.into());
}
engine.vault = engine.vault - req;
```

This subtracts from insurance BEFORE checking vault sufficiency. If the check fails, Solana rolls back the entire transaction, so the insurance balance is restored. This is safe. ✅

---

## Pro-Rata Math Verification

### Scenario 1: First Deposit

- `insurance_balance = 0`, `lp_supply = 0`
- User deposits 1,000,000 units
- `lp_tokens_to_mint = 1,000,000` (1:1 initial)
- After: `insurance = 1,000,000`, `lp_supply = 1,000,000`
- LP price = 1,000,000 / 1,000,000 = 1.0 ✅

### Scenario 2: Second Deposit (Fund Appreciated)

- Insurance fund earned 200,000 from fees: `insurance = 1,200,000`, `lp_supply = 1,000,000`
- User B deposits 600,000 units
- `lp_tokens = 600,000 * 1,000,000 / 1,200,000 = 500,000`
- After: `insurance = 1,800,000`, `lp_supply = 1,500,000`
- LP price = 1,800,000 / 1,500,000 = 1.2 ✅
- User A's 1,000,000 LP = 1,000,000 * 1.2 = 1,200,000 units ✅
- User B's 500,000 LP = 500,000 * 1.2 = 600,000 units ✅
- Total: 1,800,000 = insurance balance ✅

### Scenario 3: Partial Withdraw

- User A withdraws 500,000 LP tokens
- `units = 500,000 * 1,800,000 / 1,500,000 = 600,000`
- After: `insurance = 1,200,000`, `lp_supply = 1,000,000`
- User A remaining 500,000 LP = 500,000 * 1,200,000 / 1,000,000 = 600,000 ✅
- User B's 500,000 LP = 500,000 * 1,200,000 / 1,000,000 = 600,000 ✅
- Total: 1,200,000 = insurance balance ✅

### Scenario 4: Full Withdraw

- User A withdraws remaining 500,000 LP → gets 600,000 units
- After: `insurance = 600,000`, `lp_supply = 500,000`
- User B withdraws 500,000 LP → gets 500,000 * 600,000 / 500,000 = 600,000 units
- After: `insurance = 0`, `lp_supply = 0` ✅
- All value accounted for ✅

### Rounding Attack Analysis

**Attack: Deposit 1 unit, withdraw more**
- Deposit 1 unit when `insurance = 1,000,000`, `lp_supply = 1,000,000`
- `lp_tokens = 1 * 1,000,000 / 1,000,000 = 1`
- Withdraw 1 LP: `units = 1 * 1,000,001 / 1,000,001 = 1`
- No profit. ✅

**Attack: First depositor 1 unit, inflate, second depositor gets diluted**
- This is a known "share inflation" attack on vault-style contracts
- User A deposits 1 unit → gets 1 LP token → `insurance = 1`, `lp_supply = 1`
- User A directly top-ups insurance with 1,000,000 (via Tag 9) → `insurance = 1,000,001`, `lp_supply = 1`
- User B deposits 1,000,000 → `lp = 1,000,000 * 1 / 1,000,001 = 0` ← **rounds to 0!**
- Code rejects: `if lp_tokens_to_mint == 0 { return Err }` ✅
- User B deposits 1,000,001 → `lp = 1,000,001 * 1 / 1,000,001 = 1` LP token
- Now: `insurance = 2,000,002`, `lp_supply = 2`
- User B's 1 LP = 2,000,002 / 2 = 1,000,001 (lost ~0 units; rounding is minimal)
- User A's 1 LP = 2,000,002 / 2 = 1,000,001 (gained 1 unit from rounding)

This is the classic ERC-4626 inflation attack. The impact here is minimal because:
1. The attacker must donate real value via Tag 9 topup
2. The rounding gain is at most 1 unit per victim transaction
3. The lp_tokens_to_mint == 0 check prevents the worst case

**Severity: LOW** — The attack is economically unprofitable for the attacker.

---

## Cooldown Bypass Analysis

### Can deposit+withdraw in same transaction bypass cooldown?

No. The deposit sets `deposit_slot = current_slot`, and the withdraw checks `current_slot >= deposit_slot + cooldown`. Since both use the same clock, `current_slot >= current_slot + cooldown` is false when cooldown > 0. ✅

### Can the slot clock be gamed?

No. The Clock sysvar is set by the validator and cannot be spoofed by users. The instruction validates `a_clock` by using `Clock::from_account_info()` which verifies the sysvar. ✅

### Can LP token transfer bypass cooldown? (See Finding 3)

**Yes.** This is the primary bypass vector. Transfer LP tokens to an address with an expired cooldown stake PDA. See Finding 3 for details.

### Can a user avoid cooldown reset by depositing through a new address?

No impact — each address gets its own stake PDA. The new address would have a fresh cooldown starting from its deposit slot.

### Does the admin's ability to set cooldown=0 enable bypass?

Yes, but this requires admin collusion. The admin can set `cooldown_slots = 0`, allowing instant deposit+withdraw. This is a trust assumption.

---

## Summary of Required Changes

| # | Severity | Fix Required? | Description |
|---|----------|---------------|-------------|
| 1 | CRITICAL | **YES** | Add LP mint validation on withdraw |
| 2 | HIGH | **YES** | Handle `insurance_balance == 0 && lp_supply > 0` edge case |
| 3 | HIGH | **YES** | Cooldown bypass via LP token transfer |
| 4 | MEDIUM | Recommended | Admin retroactive cooldown increase |
| 5 | MEDIUM | Recommended | Use `Rent::get()` instead of `Rent::default()` |
| 6 | MEDIUM | No | Rounding direction is correct (document it) |
| 7 | LOW | Optional | `cumulative_deposited` saturation |
| 8 | LOW | Optional | No minimum deposit |
| 9 | LOW | Optional | Explicit LP token account mint check |
| 10 | INFO | Optional | Test coverage for mint authority check |
| 11 | INFO | No | Document resolved market behavior |
| 12 | INFO | No | Consistent with codebase patterns |

### Recommended Fix Priority

1. **[CRITICAL] Finding 1** — Add LP mint authority validation to WithdrawInsuranceLP. This is a 5-line fix that prevents complete fund drainage.
2. **[HIGH] Finding 2** — Add a check to reject deposits when `insurance_balance == 0 && lp_supply > 0`.
3. **[HIGH] Finding 3** — Implement LP balance tracking at deposit time, or use frozen/escrowed LP tokens.

---

*Audit performed by deep-reading the full 1507-line diff against the 4691-line base codebase. All findings verified against existing instruction patterns (Tag 9 TopupInsurance, Tag 20 WithdrawInsurance, Tag 23 WithdrawInsuranceLimited).*
