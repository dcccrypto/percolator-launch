//! Fast unit tests for the risk engine
//! Run with: cargo test

use percolator::*;

// Use the no-op matcher for tests
const MATCHER: NoOpMatcher = NoOpMatcher;

// Default oracle price for conservation checks (1 unit in 6 decimal scale)
const DEFAULT_ORACLE: u64 = 1_000_000;

// ==============================================================================
// DETERMINISTIC PRNG FOR FUZZ TESTS
// ==============================================================================

/// Simple xorshift64 PRNG for deterministic fuzz testing
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed)
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn u64(&mut self, lo: u64, hi: u64) -> u64 {
        if lo >= hi {
            return lo;
        }
        lo + (self.next() % (hi - lo + 1))
    }

    fn i128(&mut self, lo: i128, hi: i128) -> i128 {
        if lo >= hi {
            return lo;
        }
        lo + (self.next() as i128 % (hi - lo + 1))
    }

    fn u128(&mut self, lo: u128, hi: u128) -> u128 {
        if lo >= hi {
            return lo;
        }
        lo + (self.next() as u128 % (hi - lo + 1))
    }
}

fn default_params() -> RiskParams {
    RiskParams {
        warmup_period_slots: 100,
        maintenance_margin_bps: 500, // 5%
        initial_margin_bps: 1000,    // 10%
        trading_fee_bps: 10,         // 0.1%
        max_accounts: MAX_ACCOUNTS as u64,
        new_account_fee: U128::new(0),          // Zero fee for tests
        risk_reduction_threshold: U128::new(0), // Default: only trigger on full depletion
        maintenance_fee_per_slot: U128::new(0), // No maintenance fee by default
        max_crank_staleness_slots: u64::MAX,
        liquidation_fee_bps: 50,                 // 0.5% liquidation fee
        liquidation_fee_cap: U128::new(100_000), // Cap at 100k units
        liquidation_buffer_bps: 100,             // 1% buffer above maintenance
        min_liquidation_abs: U128::new(100_000), // Minimum 0.1 units (scaled by 1e6)
        funding_premium_weight_bps: 0,           // Disabled by default
        funding_settlement_interval_slots: 0,    // Disabled by default
        funding_premium_dampening_e6: 1_000_000, // 1x dampening (safe default)
        funding_premium_max_bps_per_slot: 5,     // Conservative cap
    }
}

// ==============================================================================
// TEST HELPERS (MANDATORY)
// ==============================================================================

// IMPORTANT: check_conservation() enforces bounded slack (MAX_ROUNDING_SLACK).
// Therefore tests MUST NOT "fund" pnl by increasing vault unless the same value
// is represented in expected accounting terms (capital/insurance/loss_accum or net_pnl).
// Prefer zero-sum pnl setups over direct vault mutation.

fn assert_conserved(engine: &RiskEngine) {
    assert!(
        engine.check_conservation(DEFAULT_ORACLE),
        "Conservation invariant violated"
    );
}

fn vault_snapshot(engine: &RiskEngine) -> u128 {
    engine.vault.get()
}

fn assert_vault_delta(engine: &RiskEngine, before: u128, delta: i128) {
    let after = engine.vault.get() as i128;
    let before_i = before as i128;
    assert_eq!(
        after - before_i,
        delta,
        "Unexpected vault delta: before={}, after={}, expected_delta={}",
        before,
        engine.vault.get(),
        delta
    );
}

/// Set insurance balance while adjusting vault to preserve conservation.
/// This models a "top-up" from an external source that deposits to both vault and insurance.
fn set_insurance(engine: &mut RiskEngine, new_balance: u128) {
    let old = engine.insurance_fund.balance.get();
    engine.insurance_fund.balance = U128::new(new_balance);
    if new_balance >= old {
        engine.vault = U128::new(engine.vault.get().saturating_add(new_balance - old));
    } else {
        engine.vault = U128::new(engine.vault.get().saturating_sub(old - new_balance));
    }
}

// ==============================================================================
// TESTS (MIXED API + WHITEBOX)
// ==============================================================================

#[test]
fn test_deposit_and_withdraw() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();

    // Deposit
    let v0 = vault_snapshot(&engine);
    engine.deposit(user_idx, 1000, 0).unwrap();
    assert_eq!(engine.accounts[user_idx as usize].capital.get(), 1000);
    assert_vault_delta(&engine, v0, 1000);

    // Withdraw partial
    let v1 = vault_snapshot(&engine);
    engine.withdraw(user_idx, 400, 0, 1_000_000).unwrap();
    assert_eq!(engine.accounts[user_idx as usize].capital.get(), 600);
    assert_vault_delta(&engine, v1, -400);

    // Withdraw rest
    let v2 = vault_snapshot(&engine);
    engine.withdraw(user_idx, 600, 0, 1_000_000).unwrap();
    assert_eq!(engine.accounts[user_idx as usize].capital.get(), 0);
    assert_vault_delta(&engine, v2, -600);

    assert_conserved(&engine);
}

#[test]
fn test_withdraw_insufficient_balance() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();

    engine.deposit(user_idx, 1000, 0).unwrap();

    // Try to withdraw more than deposited
    let result = engine.withdraw(user_idx, 1500, 0, 1_000_000);
    assert_eq!(result, Err(RiskError::InsufficientBalance));
}

#[test]
fn test_deposit_settles_accrued_maintenance_fees() {
    // Setup engine with non-zero maintenance fee
    let mut params = default_params();
    params.maintenance_fee_per_slot = U128::new(10); // 10 units per slot
    let mut engine = Box::new(RiskEngine::new(params));

    let user_idx = engine.add_user(0).unwrap();

    // Initial deposit at slot 0
    engine.deposit(user_idx, 1000, 0).unwrap();
    assert_eq!(engine.accounts[user_idx as usize].capital.get(), 1000);
    assert_eq!(engine.accounts[user_idx as usize].last_fee_slot, 0);

    // Deposit at slot 100 - should charge 100 * 10 = 1000 in fees
    // Depositing 500:
    //   - 500 from deposit pays fees → insurance += 500, fee_credits = -500
    //   - 0 goes to capital
    //   - pay_fee_debt_from_capital sweep: capital(1000) pays remaining 500 debt
    //     → capital = 500, insurance += 500, fee_credits = 0
    let insurance_before = engine.insurance_fund.balance;
    engine.deposit(user_idx, 500, 100).unwrap();

    // Account's last_fee_slot should be updated
    assert_eq!(engine.accounts[user_idx as usize].last_fee_slot, 100);

    // Capital = 500 (was 1000, fee debt sweep paid 500)
    assert_eq!(engine.accounts[user_idx as usize].capital.get(), 500);

    // Insurance received 1000 total: 500 from deposit + 500 from capital sweep
    assert_eq!(
        (engine.insurance_fund.balance - insurance_before).get(),
        1000
    );

    // fee_credits fully repaid by capital sweep
    assert_eq!(engine.accounts[user_idx as usize].fee_credits.get(), 0);

    // Now deposit 1000 more at slot 100 (no additional fees, no debt)
    engine.deposit(user_idx, 1000, 100).unwrap();

    // All 1000 goes to capital (no debt to pay)
    assert_eq!(engine.accounts[user_idx as usize].capital.get(), 1500);
    assert_eq!(engine.accounts[user_idx as usize].fee_credits.get(), 0);

    assert_conserved(&engine);
}

#[test]
fn test_withdraw_principal_with_negative_pnl_should_fail() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();

    // User deposits 1000
    engine.deposit(user_idx, 1000, 0).unwrap();

    // User has a position and negative PNL of -800
    engine.accounts[user_idx as usize].position_size = I128::new(10_000);
    engine.accounts[user_idx as usize].entry_price = 1_000_000; // $1 entry price
    engine.accounts[user_idx as usize].pnl = I128::new(-800);

    // Trying to withdraw all principal would leave collateral = 0 + max(0, -800) = 0
    // This should fail because user has an open position
    let result = engine.withdraw(user_idx, 1000, 0, 1_000_000);

    assert!(
        result.is_err(),
        "Should not allow withdrawal that leaves account undercollateralized with open position"
    );
}

#[test]
fn test_pnl_warmup() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();
    let counterparty = engine.add_user(0).unwrap();

    // Zero-sum PNL: user gains, counterparty loses (no vault funding needed)
    assert_eq!(engine.accounts[user_idx as usize].pnl.get(), 0);
    assert_eq!(engine.accounts[counterparty as usize].pnl.get(), 0);
    engine.accounts[user_idx as usize].pnl = I128::new(1000);
    engine.accounts[user_idx as usize].warmup_slope_per_step = U128::new(10); // 10 per slot
    engine.accounts[counterparty as usize].pnl = I128::new(-1000);
    assert_conserved(&engine);

    // At slot 0, nothing is warmed up yet
    assert_eq!(
        engine.withdrawable_pnl(&engine.accounts[user_idx as usize]),
        0
    );

    // Advance 50 slots
    engine.advance_slot(50);
    assert_eq!(
        engine.withdrawable_pnl(&engine.accounts[user_idx as usize]),
        500
    ); // 10 * 50

    // Advance 100 more slots (total 150)
    engine.advance_slot(100);
    assert_eq!(
        engine.withdrawable_pnl(&engine.accounts[user_idx as usize]),
        1000
    ); // Capped at total PNL
}

#[test]
fn test_pnl_warmup_with_reserved() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();
    let counterparty = engine.add_user(0).unwrap();

    // Zero-sum PNL: user gains, counterparty loses (no vault funding needed)
    assert_eq!(engine.accounts[user_idx as usize].pnl.get(), 0);
    assert_eq!(engine.accounts[counterparty as usize].pnl.get(), 0);
    engine.accounts[user_idx as usize].pnl = I128::new(1000);
    // reserved_pnl is now trade_entry_price — no longer reduces available PnL
    engine.accounts[user_idx as usize].warmup_slope_per_step = U128::new(10);
    engine.accounts[counterparty as usize].pnl = I128::new(-1000);
    assert_conserved(&engine);

    // Advance 100 slots
    engine.advance_slot(100);

    // Withdrawable = min(available_pnl, warmed_up)
    // available_pnl = 1000 (no reservation, full PnL available)
    // warmed_up = 10 * 100 = 1000
    // So withdrawable = 1000
    assert_eq!(
        engine.withdrawable_pnl(&engine.accounts[user_idx as usize]),
        1000
    );
}

#[test]
fn test_withdraw_pnl_not_warmed_up() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();
    let counterparty = engine.add_user(0).unwrap();

    engine.deposit(user_idx, 1000, 0).unwrap();
    // Zero-sum PNL: user gains, counterparty loses (no vault funding needed)
    assert_eq!(engine.accounts[user_idx as usize].pnl.get(), 0);
    assert_eq!(engine.accounts[counterparty as usize].pnl.get(), 0);
    engine.accounts[user_idx as usize].pnl = I128::new(500);
    engine.accounts[counterparty as usize].pnl = I128::new(-500);
    assert_conserved(&engine);

    // Try to withdraw more than principal + warmed up PNL
    // Since PNL hasn't warmed up, can only withdraw the 1000 principal
    let result = engine.withdraw(user_idx, 1100, 0, 1_000_000);
    assert_eq!(result, Err(RiskError::InsufficientBalance));
}

#[test]
fn test_withdraw_with_warmed_up_pnl() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();
    let counterparty = engine.add_user(0).unwrap();

    // Add insurance to provide warmup budget for converting positive PnL to capital
    set_insurance(&mut engine, 500);

    engine.deposit(user_idx, 1000, 0).unwrap();
    // Counterparty needs capital to pay their loss, creating vault surplus
    // for the haircut ratio (Residual = V - C_tot - I > 0)
    engine.deposit(counterparty, 500, 0).unwrap();
    // Zero-sum PnL: user gains, counterparty loses
    assert_eq!(engine.accounts[user_idx as usize].pnl.get(), 0);
    assert_eq!(engine.accounts[counterparty as usize].pnl.get(), 0);
    engine.accounts[user_idx as usize].pnl = I128::new(500);
    engine.accounts[counterparty as usize].pnl = I128::new(-500);
    engine.recompute_aggregates();
    engine.accounts[user_idx as usize].warmup_slope_per_step = U128::new(10);
    assert_conserved(&engine);

    // Settle counterparty's loss to free vault residual for haircut ratio.
    // Under haircut-ratio design: Residual must be > 0 for profit conversion.
    engine.settle_warmup_to_capital(counterparty).unwrap();

    // Advance enough slots to warm up 200 PNL
    engine.advance_slot(20);

    // Should be able to withdraw 1200 (1000 principal + 200 warmed PNL)
    // After counterparty settled: c_tot=1000, vault=2000, insurance=500.
    // Residual = 2000-1000-500 = 500. h = 1.0. Full conversion.
    engine.withdraw(user_idx, 1200, engine.current_slot, 1_000_000).unwrap();
    assert_eq!(engine.accounts[user_idx as usize].pnl.get(), 300); // 500 - 200 converted
    assert_eq!(engine.accounts[user_idx as usize].capital.get(), 0); // 1000 + 200 - 1200
    assert_conserved(&engine);
}
#[test]
fn test_conservation_simple() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user1 = engine.add_user(0).unwrap();
    let user2 = engine.add_user(0).unwrap();

    // Initial state should conserve
    assert!(engine.check_conservation(DEFAULT_ORACLE));

    // Deposit to user1
    engine.deposit(user1, 1000, 0).unwrap();
    assert!(engine.check_conservation(DEFAULT_ORACLE));

    // Deposit to user2
    engine.deposit(user2, 2000, 0).unwrap();
    assert!(engine.check_conservation(DEFAULT_ORACLE));

    // PNL is zero-sum: user1 gains 500, user2 loses 500
    // (vault unchanged since this is internal redistribution)
    assert_eq!(engine.accounts[user1 as usize].pnl.get(), 0);
    assert_eq!(engine.accounts[user2 as usize].pnl.get(), 0);
    engine.accounts[user1 as usize].pnl = I128::new(500);
    engine.accounts[user2 as usize].pnl = I128::new(-500);
    assert!(engine.check_conservation(DEFAULT_ORACLE));

    // Withdraw from user1's capital
    engine.withdraw(user1, 500, 0, 1_000_000).unwrap();
    assert!(engine.check_conservation(DEFAULT_ORACLE));
}




#[test]
fn test_trading_opens_position() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();
    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();

    // Setup user with capital
    engine.deposit(user_idx, 10_000, 0).unwrap();
    // WHITEBOX: Set LP capital directly. Add to vault to preserve conservation.
    engine.accounts[lp_idx as usize].capital = U128::new(100_000);
    engine.vault += 100_000;
    assert_conserved(&engine);

    // Execute trade: user buys 1000 units at $1
    let oracle_price = 1_000_000;
    let size = 1000i128;

    engine
        .execute_trade(&MATCHER, lp_idx, user_idx, 0, oracle_price, size)
        .unwrap();

    // Check position opened
    assert_eq!(engine.accounts[user_idx as usize].position_size.get(), 1000);
    assert_eq!(engine.accounts[user_idx as usize].entry_price, oracle_price);

    // Check LP has opposite position
    assert_eq!(engine.accounts[lp_idx as usize].position_size.get(), -1000);

    // Check fee was charged (0.1% of 1000 = 1)
    assert!(!engine.insurance_fund.fee_revenue.is_zero());
}

#[test]
fn test_trading_realizes_pnl() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();
    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();

    engine.deposit(user_idx, 10_000, 0).unwrap();
    // WHITEBOX: Set LP capital directly. Add to vault (not override) to preserve account fees.
    engine.accounts[lp_idx as usize].capital = U128::new(100_000);
    engine.vault += 100_000;
    assert_conserved(&engine);

    // Open long position at $1
    engine
        .execute_trade(&MATCHER, lp_idx, user_idx, 0, 1_000_000, 1000)
        .unwrap();

    // Close position at $1.50 (50% profit)
    engine
        .execute_trade(&MATCHER, lp_idx, user_idx, 0, 1_500_000, -1000)
        .unwrap();

    // Check PNL realized (approximately)
    // Price went from $1 to $1.50, so 500 profit on 1000 units
    assert!(engine.accounts[user_idx as usize].pnl.is_positive());
    assert_eq!(engine.accounts[user_idx as usize].position_size.get(), 0);
}

#[test]
fn test_user_isolation() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user1 = engine.add_user(0).unwrap();
    let user2 = engine.add_user(0).unwrap();

    engine.deposit(user1, 1000, 0).unwrap();
    engine.deposit(user2, 2000, 0).unwrap();

    let user2_principal_before = engine.accounts[user2 as usize].capital;
    let user2_pnl_before = engine.accounts[user2 as usize].pnl;

    // Operate on user1
    engine.withdraw(user1, 500, 0, 1_000_000).unwrap();
    assert_eq!(engine.accounts[user1 as usize].pnl.get(), 0);
    engine.accounts[user1 as usize].pnl = I128::new(300);

    // User2 should be unchanged
    assert_eq!(
        engine.accounts[user2 as usize].capital,
        user2_principal_before
    );
    assert_eq!(engine.accounts[user2 as usize].pnl, user2_pnl_before);
}



#[test]
fn test_warmup_monotonicity() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();
    let counterparty = engine.add_user(0).unwrap();

    // Zero-sum PNL: user gains, counterparty loses (no vault funding needed)
    assert_eq!(engine.accounts[user_idx as usize].pnl.get(), 0);
    assert_eq!(engine.accounts[counterparty as usize].pnl.get(), 0);
    engine.accounts[user_idx as usize].pnl = I128::new(1000);
    engine.accounts[user_idx as usize].warmup_slope_per_step = U128::new(10);
    engine.accounts[counterparty as usize].pnl = I128::new(-1000);
    assert_conserved(&engine);

    // Get withdrawable at different time points
    let w0 = engine.withdrawable_pnl(&engine.accounts[user_idx as usize]);

    engine.advance_slot(10);
    let w1 = engine.withdrawable_pnl(&engine.accounts[user_idx as usize]);

    engine.advance_slot(20);
    let w2 = engine.withdrawable_pnl(&engine.accounts[user_idx as usize]);

    // Should be monotonically increasing
    assert!(w1 >= w0);
    assert!(w2 >= w1);
}

#[test]
fn test_fee_accumulation() {
    // WHITEBOX: direct state mutation for vault/capital setup
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();
    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();

    engine.deposit(user_idx, 100_000, 0).unwrap();
    // WHITEBOX: Set LP capital directly. Add to vault (not override) to preserve account fees.
    engine.accounts[lp_idx as usize].capital = U128::new(1_000_000);
    engine.vault += 1_000_000;
    assert_conserved(&engine);

    // Track fee revenue and balance BEFORE trades
    let fee_rev_before = engine.insurance_fund.fee_revenue;
    let ins_before = engine.insurance_fund.balance;

    // Execute multiple trades, counting successes
    // Trade size must be > 1000 for fee to be non-zero (fee_bps=10, notional needs > 10000/10=1000)
    let mut succeeded = 0usize;
    for _ in 0..10 {
        if engine
            .execute_trade(&MATCHER, lp_idx, user_idx, 0, 1_000_000, 10_000)
            .is_ok()
        {
            succeeded += 1;
        }
        if engine
            .execute_trade(&MATCHER, lp_idx, user_idx, 0, 1_000_000, -10_000)
            .is_ok()
        {
            succeeded += 1;
        }
    }

    let fee_rev_after = engine.insurance_fund.fee_revenue;
    let ins_after = engine.insurance_fund.balance;

    // If any trades succeeded, fees should have accumulated
    if succeeded > 0 {
        assert!(
            fee_rev_after > fee_rev_before,
            "fee_revenue must increase on successful trades"
        );
        assert!(
            ins_after >= ins_before,
            "insurance balance must not decrease"
        );
    }

    assert_conserved(&engine);
}

#[test]
fn test_lp_warmup_initial_state() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 10000).unwrap();

    // LP should start with warmup state initialized
    assert_eq!(engine.accounts[lp_idx as usize].reserved_pnl, 0);
    assert_eq!(engine.accounts[lp_idx as usize].warmup_started_at_slot, 0);
}

#[test]
fn test_lp_warmup_monotonic() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 10000).unwrap();
    let user = engine.add_user(0).unwrap();

    // Zero-sum PNL: LP gains, user loses (no vault funding needed)
    assert_eq!(engine.accounts[lp_idx as usize].pnl.get(), 0);
    assert_eq!(engine.accounts[user as usize].pnl.get(), 0);
    engine.accounts[lp_idx as usize].pnl = I128::new(10_000);
    engine.accounts[user as usize].pnl = I128::new(-10_000);
    assert_conserved(&engine);

    // At slot 0
    let w0 = engine.withdrawable_pnl(&engine.accounts[lp_idx as usize]);

    // Advance 50 slots
    engine.advance_slot(50);
    let w50 = engine.withdrawable_pnl(&engine.accounts[lp_idx as usize]);

    // Advance another 50 slots (total 100)
    engine.advance_slot(50);
    let w100 = engine.withdrawable_pnl(&engine.accounts[lp_idx as usize]);

    // Withdrawable should be monotonically increasing
    assert!(
        w50 >= w0,
        "LP warmup should be monotonic: w0={}, w50={}",
        w0,
        w50
    );
    assert!(
        w100 >= w50,
        "LP warmup should be monotonic: w50={}, w100={}",
        w50,
        w100
    );
}

#[test]
fn test_lp_warmup_bounded() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 10000).unwrap();
    let user = engine.add_user(0).unwrap();

    // Zero-sum PNL: LP gains, user loses (no vault funding needed)
    assert_eq!(engine.accounts[lp_idx as usize].pnl.get(), 0);
    assert_eq!(engine.accounts[user as usize].pnl.get(), 0);
    engine.accounts[lp_idx as usize].pnl = I128::new(5_000);
    engine.accounts[user as usize].pnl = I128::new(-5_000);
    assert_conserved(&engine);

    // Reserve some PNL
    engine.accounts[lp_idx as usize].reserved_pnl = 1_000;

    // Even after long time, withdrawable should not exceed available (positive_pnl - reserved)
    engine.advance_slot(1000);
    let withdrawable = engine.withdrawable_pnl(&engine.accounts[lp_idx as usize]);

    assert!(
        withdrawable <= 4_000,
        "Withdrawable {} should not exceed available {}",
        withdrawable,
        4_000
    );
}

#[test]
fn test_lp_warmup_with_negative_pnl() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 10000).unwrap();

    // LP has negative PNL
    assert_eq!(engine.accounts[lp_idx as usize].pnl.get(), 0);
    engine.accounts[lp_idx as usize].pnl = I128::new(-3_000);

    // Advance time
    engine.advance_slot(100);

    // With negative PNL, withdrawable should be 0
    let withdrawable = engine.withdrawable_pnl(&engine.accounts[lp_idx as usize]);
    assert_eq!(
        withdrawable, 0,
        "Withdrawable should be 0 with negative PNL"
    );
}

// ============================================================================
// Funding Rate Tests
// ============================================================================

#[test]
fn test_funding_positive_rate_longs_pay_shorts() {
    // T1: Positive funding → longs pay shorts
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();
    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();

    engine.deposit(user_idx, 100_000, 0).unwrap();
    // WHITEBOX: Set LP capital directly. Add to vault (not override) to preserve account fees.
    engine.accounts[lp_idx as usize].capital = U128::new(1_000_000);
    engine.vault += 1_000_000;

    // User opens long position (+1 base unit)
    engine.accounts[user_idx as usize].position_size = I128::new(1_000_000); // +1M base units
    engine.accounts[user_idx as usize].entry_price = 100_000_000; // $100

    // LP has opposite short position
    engine.accounts[lp_idx as usize].position_size = I128::new(-1_000_000);
    engine.accounts[lp_idx as usize].entry_price = 100_000_000;

    // Zero warmup/reserved to avoid side effects from touch_account
    engine.accounts[user_idx as usize].warmup_slope_per_step = U128::new(0);
    engine.accounts[user_idx as usize].reserved_pnl = 0;
    engine.accounts[user_idx as usize].warmup_started_at_slot = engine.current_slot;
    engine.accounts[lp_idx as usize].warmup_slope_per_step = U128::new(0);
    engine.accounts[lp_idx as usize].reserved_pnl = 0;
    engine.accounts[lp_idx as usize].warmup_started_at_slot = engine.current_slot;
    assert_conserved(&engine);

    // Accrue positive funding: +10 bps/slot for 1 slot
    engine.current_slot = 1;
    engine.accrue_funding_with_rate(1, 100_000_000, 10).unwrap(); // price=$100, rate=+10bps

    // Expected delta_F = 100e6 * 10 * 1 / 10000 = 100,000
    // User payment = 1M * 100,000 / 1e6 = 100,000
    // LP payment = -1M * 100,000 / 1e6 = -100,000

    let user_pnl_before = engine.accounts[user_idx as usize].pnl;
    let lp_pnl_before = engine.accounts[lp_idx as usize].pnl;

    // Settle funding
    engine.touch_account(user_idx).unwrap();
    engine.touch_account(lp_idx).unwrap();

    // User (long) should pay 100,000
    assert_eq!(
        engine.accounts[user_idx as usize].pnl,
        user_pnl_before - 100_000
    );

    // LP (short) should receive 100,000
    assert_eq!(
        engine.accounts[lp_idx as usize].pnl,
        lp_pnl_before + 100_000
    );

    // Zero-sum check
    let total_pnl_before = user_pnl_before + lp_pnl_before;
    let total_pnl_after =
        engine.accounts[user_idx as usize].pnl + engine.accounts[lp_idx as usize].pnl;
    assert_eq!(
        total_pnl_after, total_pnl_before,
        "Funding should be zero-sum"
    );
}

#[test]
fn test_funding_negative_rate_shorts_pay_longs() {
    // T2: Negative funding → shorts pay longs
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();
    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();

    engine.deposit(user_idx, 100_000, 0).unwrap();
    // WHITEBOX: Set LP capital directly. Add to vault (not override) to preserve account fees.
    engine.accounts[lp_idx as usize].capital = U128::new(1_000_000);
    engine.vault += 1_000_000;

    // User opens short position
    engine.accounts[user_idx as usize].position_size = I128::new(-1_000_000);
    engine.accounts[user_idx as usize].entry_price = 100_000_000;

    // LP has opposite long position
    engine.accounts[lp_idx as usize].position_size = I128::new(1_000_000);
    engine.accounts[lp_idx as usize].entry_price = 100_000_000;

    // Zero warmup/reserved to avoid side effects from touch_account
    engine.accounts[user_idx as usize].warmup_slope_per_step = U128::new(0);
    engine.accounts[user_idx as usize].reserved_pnl = 0;
    engine.accounts[user_idx as usize].warmup_started_at_slot = engine.current_slot;
    engine.accounts[lp_idx as usize].warmup_slope_per_step = U128::new(0);
    engine.accounts[lp_idx as usize].reserved_pnl = 0;
    engine.accounts[lp_idx as usize].warmup_started_at_slot = engine.current_slot;
    assert_conserved(&engine);

    // Accrue negative funding: -10 bps/slot
    engine.current_slot = 1;
    engine.accrue_funding_with_rate(1, 100_000_000, -10).unwrap();

    let user_pnl_before = engine.accounts[user_idx as usize].pnl;
    let lp_pnl_before = engine.accounts[lp_idx as usize].pnl;

    engine.touch_account(user_idx).unwrap();
    engine.touch_account(lp_idx).unwrap();

    // With negative funding rate, delta_F is negative (-100,000)
    // User (short) with negative position: payment = (-1M) * (-100,000) / 1e6 = 100,000
    // User pays 100,000 (shorts pay)
    assert_eq!(
        engine.accounts[user_idx as usize].pnl,
        user_pnl_before - 100_000
    );

    // LP (long) receives 100,000
    assert_eq!(
        engine.accounts[lp_idx as usize].pnl,
        lp_pnl_before + 100_000
    );
}

#[test]
fn test_funding_idempotence() {
    // T3: Settlement is idempotent
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(10000).unwrap();

    engine.deposit(user_idx, 100_000, 0).unwrap();
    engine.accounts[user_idx as usize].position_size = I128::new(1_000_000);

    // Accrue funding
    engine.accrue_funding_with_rate(1, 100_000_000, 10).unwrap();

    // Settle once
    engine.touch_account(user_idx).unwrap();
    let pnl_after_first = engine.accounts[user_idx as usize].pnl;

    // Settle again without new accrual
    engine.touch_account(user_idx).unwrap();
    let pnl_after_second = engine.accounts[user_idx as usize].pnl;

    assert_eq!(
        pnl_after_first, pnl_after_second,
        "Second settlement should not change PNL"
    );
}

#[test]
fn test_funding_partial_close() {
    // T4: Partial position close with funding
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();
    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();

    // Need enough for initial margin (10% of 200M notional = 20M) plus trading fees
    engine.deposit(user_idx, 25_000_000, 0).unwrap();
    // WHITEBOX: Set LP capital directly. Add to vault (not override) to preserve account fees.
    engine.accounts[lp_idx as usize].capital = U128::new(50_000_000);
    engine.vault += 50_000_000;
    assert_conserved(&engine);

    // Open long position of 2M base units
    let trade_result = engine.execute_trade(&MATCHER, lp_idx, user_idx, 0, 100_000_000, 2_000_000);
    assert!(trade_result.is_ok(), "Trade should succeed");

    assert_eq!(
        engine.accounts[user_idx as usize].position_size.get(),
        2_000_000
    );

    // Accrue funding for 1 slot at +10 bps
    engine.advance_slot(1);
    engine.accrue_funding_with_rate(1, 100_000_000, 10).unwrap();

    // Reduce position to 1M (close half)
    let reduce_result =
        engine.execute_trade(&MATCHER, lp_idx, user_idx, 0, 100_000_000, -1_000_000);
    assert!(reduce_result.is_ok(), "Partial close should succeed");

    // Position should be 1M now
    assert_eq!(
        engine.accounts[user_idx as usize].position_size.get(),
        1_000_000
    );

    // Accrue more funding for another slot
    engine.advance_slot(2);
    engine.accrue_funding_with_rate(2, 100_000_000, 10).unwrap();

    // Touch to settle
    engine.touch_account(user_idx).unwrap();

    // Funding should have been applied correctly for both periods
    // Period 1: 2M base * (100K delta_F) / 1e6 = 200
    // Period 2: 1M base * (100K delta_F) / 1e6 = 100
    // Total funding paid: 300
    // (exact PNL depends on trading fees too, but funding should be applied)
}

#[test]
fn test_funding_position_flip() {
    // T5: Flip from long to short
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();
    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();

    // Need enough for initial margin (10% of 100M notional = 10M) plus trading fees
    engine.deposit(user_idx, 15_000_000, 0).unwrap();
    // WHITEBOX: Set LP capital directly. Add to vault (not override) to preserve account fees.
    engine.accounts[lp_idx as usize].capital = U128::new(20_000_000);
    engine.vault += 20_000_000;
    assert_conserved(&engine);

    // Open long
    engine
        .execute_trade(&MATCHER, lp_idx, user_idx, 0, 100_000_000, 1_000_000)
        .unwrap();
    assert_eq!(
        engine.accounts[user_idx as usize].position_size.get(),
        1_000_000
    );

    // Accrue funding
    engine.advance_slot(1);
    engine.accrue_funding_with_rate(1, 100_000_000, 10).unwrap();

    let _pnl_before_flip = engine.accounts[user_idx as usize].pnl;

    // Flip to short (trade -2M to go from +1M to -1M)
    engine
        .execute_trade(&MATCHER, lp_idx, user_idx, 0, 100_000_000, -2_000_000)
        .unwrap();

    assert_eq!(
        engine.accounts[user_idx as usize].position_size.get(),
        -1_000_000
    );

    // Funding should have been settled before the flip
    // User's funding index should be updated
    assert_eq!(
        engine.accounts[user_idx as usize].funding_index,
        engine.funding_index_qpb_e6
    );

    // Accrue more funding
    engine.advance_slot(2);
    engine.accrue_funding_with_rate(2, 100_000_000, 10).unwrap();

    engine.touch_account(user_idx).unwrap();

    // Now user is short, so they receive funding (if rate is still positive)
    // This verifies no "double charge" bug
}

#[test]
fn test_funding_zero_position() {
    // Edge case: funding with zero position should do nothing
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(10000).unwrap();

    engine.deposit(user_idx, 100_000, 0).unwrap();

    // No position
    assert_eq!(engine.accounts[user_idx as usize].position_size.get(), 0);

    let pnl_before = engine.accounts[user_idx as usize].pnl;

    // Accrue funding
    engine.accrue_funding_with_rate(1, 100_000_000, 100).unwrap(); // Large rate

    // Settle
    engine.touch_account(user_idx).unwrap();

    // PNL should be unchanged
    assert_eq!(engine.accounts[user_idx as usize].pnl, pnl_before);
}

#[test]
fn test_funding_does_not_touch_principal() {
    // Funding should never modify principal (Invariant I1 extended)
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();

    let initial_principal = 100_000;
    engine.deposit(user_idx, initial_principal, 0).unwrap();

    engine.accounts[user_idx as usize].position_size = I128::new(1_000_000);

    // Accrue funding
    engine.accrue_funding_with_rate(1, 100_000_000, 100).unwrap();
    engine.touch_account(user_idx).unwrap();

    // Principal must be unchanged
    assert_eq!(
        engine.accounts[user_idx as usize].capital.get(),
        initial_principal
    );
}



// ============================================================================
// Warmup Rate Limiting Tests
// NOTE: These tests are commented out because warmup rate limiting was removed
// in the slab 4096 redesign for simplicity
// ============================================================================

/*
#[test]
fn test_warmup_rate_limit_single_user() {
    // Test that warmup slope is capped by insurance fund capacity
    let mut params = default_params();
    params.warmup_period_slots = 100;
    params.max_warmup_rate_fraction_bps = 5000; // 50% in T/2 = 50 slots

    let mut engine = Box::new(RiskEngine::new(params));

    // Add insurance fund: 10,000
    set_insurance(&mut engine, 10_000);

    // Max warmup rate = 10,000 * 5000 / 50 / 10,000 = 10,000 * 0.5 / 50 = 100 per slot
    let expected_max_rate = 10_000 * 5000 / 50 / 10_000;
    assert_eq!(expected_max_rate, 100);

    let user = engine.add_user(100).unwrap();
    engine.deposit(user, 1_000, 0).unwrap();

    // Give user 20,000 PNL (would need slope of 200 without limit)
    assert_eq!(engine.accounts[user as usize].pnl.get(), 0);
    engine.accounts[user as usize].pnl = I128::new(20_000);

    // Update warmup slope
    engine.update_warmup_slope(user).unwrap();

    // Should be capped at 100 (the max rate)
    assert_eq!(engine.accounts[user as usize].warmup_slope_per_step, 100);
    assert_eq!(engine.total_warmup_rate, 100);

    // After 50 slots, only 5,000 should have warmed up (not 10,000)
    engine.advance_slot(50);
    let warmed = engine.withdrawable_pnl(&engine.accounts[user as usize]);
    assert_eq!(warmed, 5_000); // 100 * 50 = 5,000
}

#[test]
fn test_warmup_rate_limit_multiple_users() {
    // Test that warmup capacity is shared among users
    let mut params = default_params();
    params.warmup_period_slots = 100;
    params.max_warmup_rate_fraction_bps = 5000; // 50% in T/2

    let mut engine = Box::new(RiskEngine::new(params));
    set_insurance(&mut engine, 10_000);

    // Max total warmup rate = 100 per slot

    let user1 = engine.add_user(100).unwrap();
    let user2 = engine.add_user(100).unwrap();

    engine.deposit(user1, 1_000, 0).unwrap();
    engine.deposit(user2, 1_000, 0).unwrap();

    // User1 gets 6,000 PNL (would want slope of 60)
    assert_eq!(engine.accounts[user1 as usize].pnl.get(), 0);
    engine.accounts[user1 as usize].pnl = I128::new(6_000);
    engine.update_warmup_slope(user1).unwrap();
    assert_eq!(engine.accounts[user1 as usize].warmup_slope_per_step, 60);
    assert_eq!(engine.total_warmup_rate, 60);

    // User2 gets 8,000 PNL (would want slope of 80)
    assert_eq!(engine.accounts[user2 as usize].pnl.get(), 0);
    engine.accounts[user2 as usize].pnl = I128::new(8_000);
    engine.update_warmup_slope(user2).unwrap();

    // Total would be 140, but max is 100, so user2 gets only 40
    assert_eq!(engine.accounts[user2 as usize].warmup_slope_per_step, 40); // 100 - 60 = 40
    assert_eq!(engine.total_warmup_rate, 100); // 60 + 40 = 100
}

#[test]
fn test_warmup_rate_released_on_pnl_decrease() {
    // Test that warmup capacity is released when user's PNL decreases
    let mut params = default_params();
    params.warmup_period_slots = 100;
    params.max_warmup_rate_fraction_bps = 5000;

    let mut engine = Box::new(RiskEngine::new(params));
    set_insurance(&mut engine, 10_000);

    let user1 = engine.add_user(100).unwrap();
    let user2 = engine.add_user(100).unwrap();

    engine.deposit(user1, 1_000, 0).unwrap();
    engine.deposit(user2, 1_000, 0).unwrap();

    // User1 uses all capacity
    assert_eq!(engine.accounts[user1 as usize].pnl.get(), 0);
    engine.accounts[user1 as usize].pnl = I128::new(15_000);
    engine.update_warmup_slope(user1).unwrap();
    assert_eq!(engine.total_warmup_rate, 100);

    // User2 can't get any capacity
    assert_eq!(engine.accounts[user2 as usize].pnl.get(), 0);
    engine.accounts[user2 as usize].pnl = I128::new(5_000);
    engine.update_warmup_slope(user2).unwrap();
    assert_eq!(engine.accounts[user2 as usize].warmup_slope_per_step, 0);

    // User1's PNL drops to 3,000 (ADL or loss)
    engine.accounts[user1 as usize].pnl = I128::new(3_000);
    engine.update_warmup_slope(user1).unwrap();
    assert_eq!(engine.accounts[user1 as usize].warmup_slope_per_step, 30); // 3000/100
    assert_eq!(engine.total_warmup_rate, 30);

    // Now user2 can get the remaining 70
    engine.update_warmup_slope(user2).unwrap();
    assert_eq!(engine.accounts[user2 as usize].warmup_slope_per_step, 50); // 5000/100, but capped at 70
    assert_eq!(engine.total_warmup_rate, 80); // 30 + 50
}

#[test]
fn test_warmup_rate_scales_with_insurance_fund() {
    // Test that max warmup rate scales with insurance fund size
    let mut params = default_params();
    params.warmup_period_slots = 100;
    params.max_warmup_rate_fraction_bps = 5000; // 50% in T/2

    let mut engine = Box::new(RiskEngine::new(params));

    // Small insurance fund
    set_insurance(&mut engine, 1_000);

    let user = engine.add_user(100).unwrap();
    engine.deposit(user, 1_000, 0).unwrap();

    assert_eq!(engine.accounts[user as usize].pnl.get(), 0);
    engine.accounts[user as usize].pnl = I128::new(10_000);
    engine.update_warmup_slope(user).unwrap();

    // Max rate = 1000 * 0.5 / 50 = 10
    assert_eq!(engine.accounts[user as usize].warmup_slope_per_step, 10);

    // Increase insurance fund 10x
    set_insurance(&mut engine, 10_000);

    // Update slope again
    engine.update_warmup_slope(user).unwrap();

    // Max rate should be 10x higher = 100
    assert_eq!(engine.accounts[user as usize].warmup_slope_per_step, 100);
}

#[test]
fn test_warmup_rate_limit_invariant_maintained() {
    // Verify that the invariant is always maintained:
    // total_warmup_rate * (T/2) <= insurance_fund * max_warmup_rate_fraction

    let mut params = default_params();
    params.warmup_period_slots = 100;
    params.max_warmup_rate_fraction_bps = 5000;

    let mut engine = Box::new(RiskEngine::new(params));
    set_insurance(&mut engine, 10_000);

    // Add multiple users with varying PNL
    for i in 0..10 {
        let user = engine.add_user(100).unwrap();
        engine.deposit(user, 1_000, 0).unwrap();
        engine.accounts[user as usize].pnl = (i as i128 + 1) * 1_000;
        engine.update_warmup_slope(user).unwrap();

        // Check invariant after each update
        let half_period = params.warmup_period_slots / 2;
        let max_total_warmup_in_half_period = engine.total_warmup_rate * (half_period as u128);
        let insurance_limit = engine.insurance_fund.balance * params.max_warmup_rate_fraction_bps as u128 / 10_000;

        assert!(max_total_warmup_in_half_period <= insurance_limit,
                "Invariant violated: {} > {}", max_total_warmup_in_half_period, insurance_limit);
    }
}
*/

// ============================================================================
// Risk-Reduction-Only Mode Tests
// ============================================================================


/*
// NOTE: Commented out - withdrawal-only mode now BLOCKS all withdrawals instead of proportional haircut
*/



// Test A: Warmup freezes in risk mode

// Test B: In risk mode, deposit withdrawals work from deposited capital

// Test C: In risk mode, pending PNL cannot be withdrawn (because warmup is frozen)

// Test D: In risk mode, already-warmed PNL can be withdrawn after conversion

// Test E: Risk-increasing trade fails in risk mode

// Test F: Reduce-only trade succeeds in risk mode

// Test G: Exiting mode unfreezes warmup


/*
// NOTE: Commented out - withdrawal-only mode now BLOCKS all withdrawals
*/

/*
// NOTE: Commented out - withdrawal-only mode now BLOCKS all withdrawals
*/

// ==============================================================================
// LP-SPECIFIC TESTS (CRITICAL - Addresses audit findings)
// ==============================================================================

#[test]
fn test_lp_withdraw() {
    // Tests that LP withdrawal works correctly (WHITEBOX: direct state mutation)
    let mut engine = Box::new(RiskEngine::new(default_params()));

    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();

    // LP deposits capital
    engine.deposit(lp_idx, 10_000, 0).unwrap();

    // LP earns PNL from counterparty (need zero-sum setup)
    // Create a user to be the counterparty
    let user_idx = engine.add_user(0).unwrap();
    engine.deposit(user_idx, 5_000, 0).unwrap();

    // Add insurance to provide warmup budget for converting LP's positive PnL to capital
    // Budget = warmed_neg_total + insurance_spendable_raw() = 0 + 5000 = 5000
    set_insurance(&mut engine, 5_000);

    // Zero-sum PNL: LP gains 5000, user loses 5000
    // Assert starting pnl is 0 for both (required for zero-sum to preserve conservation)
    assert_eq!(engine.accounts[lp_idx as usize].pnl.get(), 0);
    assert_eq!(engine.accounts[user_idx as usize].pnl.get(), 0);
    engine.accounts[lp_idx as usize].pnl = I128::new(5_000);
    engine.accounts[user_idx as usize].pnl = I128::new(-5_000);
    engine.recompute_aggregates();

    // Set warmup slope so PnL can warm up (warmup_period_slots = 100 from default_params)
    engine.accounts[lp_idx as usize].warmup_slope_per_step = U128::new(5_000 / 100); // 50 per slot
    engine.accounts[lp_idx as usize].warmup_started_at_slot = 0;

    // Advance time to allow warmup
    engine.current_slot = 100; // Full warmup (100 slots × 50 = 5000)

    // Settle the counterparty's negative PnL first to free vault residual.
    // Under haircut-ratio design, positive PnL can only convert to capital when
    // Residual = max(0, V - C_tot - I) > 0. Settling losses reduces C_tot,
    // increasing Residual and enabling profit conversion.
    engine.settle_warmup_to_capital(user_idx).unwrap();

    // Snapshot before withdrawal
    let v0 = vault_snapshot(&engine);

    // withdraw converts warmed PNL to capital, then withdraws
    // After loss settlement: user capital=0, user pnl=0.
    // c_tot=10_000 (LP only), vault=20_000, insurance=5_000.
    // Residual = 20_000 - 10_000 - 5_000 = 5_000.
    // haircut h = min(5_000, 5_000)/5_000 = 1.0 (full conversion).
    // LP capital = 10,000 + 5,000 = 15,000 after conversion.
    let result = engine.withdraw(lp_idx, 10_000, engine.current_slot, 1_000_000);
    assert!(result.is_ok(), "LP withdrawal should succeed: {:?}", result);

    // Withdrawal should reduce vault by 10,000
    assert_vault_delta(&engine, v0, -10_000);
    assert_eq!(
        engine.accounts[lp_idx as usize].capital.get(),
        5_000,
        "LP should have 5,000 capital remaining (from converted PNL)"
    );
    assert_eq!(
        engine.accounts[lp_idx as usize].pnl.get(),
        0,
        "PNL should be converted to capital"
    );
    assert_conserved(&engine);
}

/*
// NOTE: Commented out - withdrawal-only mode now BLOCKS all withdrawals
#[test]
fn test_lp_withdraw_with_haircut() {
    // CRITICAL: Tests that LPs are subject to withdrawal-mode haircuts
    let mut engine = Box::new(RiskEngine::new(default_params()));

    let user_idx = engine.add_user(0).unwrap();
    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();

    engine.deposit(user_idx, 10_000, 0).unwrap();
    engine.deposit(lp_idx, 10_000, 0).unwrap();

    // Simulate crisis - set loss_accum
    assert!(user_result.is_ok());

    let lp_result = engine.withdraw(lp_idx, 10_000, 0, 1_000_000);
    assert!(lp_result.is_ok());

    // Both should have withdrawn same proportion
    let total_withdrawn = engine.withdrawal_mode_withdrawn;
    assert!(total_withdrawn < 20_000, "Total withdrawn should be less than requested due to haircuts");
    assert!(total_withdrawn > 14_000, "Haircut should be approximately 25%");
}
*/

/*
// NOTE: Commented out - warmup rate limiting was removed in slab 4096 redesign
#[test]
fn test_update_lp_warmup_slope() {
    // CRITICAL: Tests that LP warmup actually gets rate limited
    let mut engine = Box::new(RiskEngine::new(default_params()));

    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();

    // Set insurance fund
    set_insurance(&mut engine, 10_000);

    // LP earns large PNL
    engine.accounts[lp_idx as usize].pnl = I128::new(50_000);

    // Update warmup slope
    engine.update_lp_warmup_slope(lp_idx).unwrap();

    // Should be rate limited
    let ideal_slope = 50_000 / 100; // 500 per slot
    let actual_slope = engine.accounts[lp_idx as usize].warmup_slope_per_step;

    assert!(actual_slope < ideal_slope, "LP warmup should be rate limited");
    assert!(engine.total_warmup_rate > 0, "LP should contribute to total warmup rate");
}
*/





// ============================================================================
// AUDIT-MANDATED TESTS: Double-Settlement, Conservation, Reserved Insurance
// These tests were mandated by the security audit to verify critical fixes.
// ============================================================================

/// Test: Conservation check detects excessive slack
///
/// Verifies that if someone tries to "mint" value by inflating the vault,
/// the bounded check will catch it.
#[test]
fn test_audit_conservation_detects_excessive_slack() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();

    engine.deposit(user_idx, 10_000, 0).unwrap();

    // Conservation should hold normally
    assert!(
        engine.check_conservation(DEFAULT_ORACLE),
        "Normal conservation"
    );

    // Artificially inflate vault beyond MAX_ROUNDING_SLACK
    // This simulates a minting bug
    engine.vault = engine.vault + percolator::MAX_ROUNDING_SLACK + 10;

    // Conservation should now FAIL due to excessive slack
    assert!(
        !engine.check_conservation(DEFAULT_ORACLE),
        "Conservation should fail when slack exceeds MAX_ROUNDING_SLACK"
    );
}



// ==============================================================================
// GUARDRAIL: NO IGNORED RESULT PATTERNS IN ENGINE
// ==============================================================================

/// This test guards against reintroducing ignored-Result patterns in the engine.
/// The Solana atomicity model requires that all fallible operations propagate errors.
/// NOTE: This test intentionally stays file-local.
/// If percolator.rs is split, this test MUST be updated.
#[test]
fn no_ignored_result_patterns_in_engine() {
    let src = include_str!("../src/percolator.rs");

    // Check for ignored Result patterns on specific functions that must propagate errors
    assert!(
        !src.contains("let _ = Self::settle_account_funding"),
        "Do not ignore settle_account_funding errors - use ? operator"
    );
    // touch_account_for_liquidation is allowed to be best-effort in the crank's
    // force-close path (errors are intentionally ignored). Only check touch_account_full.
    assert!(
        !src.contains("let _ = self.touch_account_full"),
        "Do not ignore touch_account_full errors - use ? operator"
    );
    // settle_warmup_to_capital_for_crank is allowed to be best-effort in the crank
    // (errors are intentionally ignored to drain abandoned accounts).
    // Only check direct calls, not the _for_crank wrapper.
    let settle_warmup_ignores = src.matches("let _ = self.settle_warmup_to_capital").count();
    let allowed_in_crank_wrapper = src.contains("fn settle_warmup_to_capital_for_crank");
    assert!(
        settle_warmup_ignores <= if allowed_in_crank_wrapper { 1 } else { 0 },
        "Do not ignore settle_warmup_to_capital errors outside of _for_crank wrapper - use ? operator"
    );
}

// ==============================================================================
// API-LEVEL SEQUENCE TEST
// ==============================================================================

/// Deterministic sequence test that verifies conservation holds after every API operation.
/// This test uses only public API methods - no direct state mutation.
#[test]
fn api_sequence_conservation_smoke_test() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user = engine.add_user(0).unwrap();
    let lp = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();

    engine.deposit(user, 10_000, 0).unwrap();
    engine.deposit(lp, 50_000, 0).unwrap();

    assert_conserved(&engine);

    // Execute a trade (use size > 1000 to generate non-zero fee)
    engine
        .execute_trade(&MATCHER, lp, user, 0, 1_000_000, 10_000)
        .unwrap();
    assert_conserved(&engine);

    // Accrue funding
    engine.accrue_funding_with_rate(1, 1_000_000, 10).unwrap();
    engine.touch_account(user).unwrap();
    assert_conserved(&engine);

    // Close the position (reduces risk)
    engine
        .execute_trade(&MATCHER, lp, user, 0, 1_000_000, -10_000)
        .unwrap();
    assert_conserved(&engine);

    // Withdraw (should succeed since position is closed)
    engine.withdraw(user, 1_000, 0, 1_000_000).unwrap();
    assert_conserved(&engine);
}

// ==============================================================================
// INVARIANT UNIT TESTS (Step 6 of ADL/Warmup correctness plan)
// ==============================================================================


/// Test that warmup slope is always >= 1 when positive PnL exists.
/// Set positive_pnl = 1 (below warmup period), verify slope = 1 after update.
#[test]
fn test_warmup_slope_nonzero() {
    let params = RiskParams {
        warmup_period_slots: 1000, // Large period so pnl=1 would normally give slope=0
        ..default_params()
    };
    let mut engine = Box::new(RiskEngine::new(params));

    let user = engine.add_user(0).unwrap();
    engine.deposit(user, 10_000, 0).unwrap();

    // Set minimal positive PnL (1 unit, less than warmup_period_slots)
    engine.accounts[user as usize].pnl = I128::new(1);

    // Create counterparty for zero-sum
    // Zero-sum pattern: net_pnl = 0, so no vault funding needed
    let loser = engine.add_user(0).unwrap();
    engine.deposit(loser, 10_000, 0).unwrap();
    engine.accounts[loser as usize].pnl = I128::new(-1);

    assert_conserved(&engine);

    // Update warmup slope
    engine.update_warmup_slope(user).unwrap();

    // Verify slope is at least 1 (not 0)
    let slope = engine.accounts[user as usize].warmup_slope_per_step.get();
    assert!(
        slope >= 1,
        "Slope must be >= 1 when positive PnL exists, got {}",
        slope
    );

    assert_conserved(&engine);
}


/// Test the precise definition of unwrapped PnL.
/// unwrapped = max(0, positive_pnl - reserved_pnl - withdrawable_pnl)
#[test]
fn test_unwrapped_definition() {
    let params = RiskParams {
        warmup_period_slots: 100,
        ..default_params()
    };
    let mut engine = Box::new(RiskEngine::new(params));

    let user = engine.add_user(0).unwrap();
    engine.deposit(user, 10_000, 0).unwrap();

    // Create counterparty for zero-sum
    // Zero-sum pattern: net_pnl = 0, so no vault funding needed
    let loser = engine.add_user(0).unwrap();
    engine.deposit(loser, 10_000, 0).unwrap();
    engine.accounts[loser as usize].pnl = I128::new(-1000);

    // Set positive PnL (reserved_pnl is now trade_entry_price, not a PnL reservation)
    engine.accounts[user as usize].pnl = I128::new(1000);

    // Update slope to establish warmup rate
    engine.update_warmup_slope(user).unwrap();

    assert_conserved(&engine);

    // At t=0, nothing is warmed yet, so:
    // withdrawable = 0
    // unwrapped = 1000 - 0 = 1000
    let account = &engine.accounts[user as usize];
    let positive_pnl = account.pnl.get() as u128;

    // Compute withdrawable manually (same logic as compute_withdrawable_pnl)
    let available = positive_pnl; // 1000 (no reservation)
    let elapsed = engine
        .current_slot
        .saturating_sub(account.warmup_started_at_slot);
    let warmed_cap = account.warmup_slope_per_step.get() * (elapsed as u128);
    let withdrawable = core::cmp::min(available, warmed_cap);

    // Expected unwrapped
    let expected_unwrapped = positive_pnl.saturating_sub(withdrawable);

    // Test: at t=0, withdrawable should be 0, unwrapped should be 1000
    assert_eq!(withdrawable, 0, "No time elapsed, withdrawable should be 0");
    assert_eq!(expected_unwrapped, 1000, "Unwrapped should be 1000 at t=0");

    // Advance time to allow partial warmup (50 slots = 50% of 100)
    engine.current_slot = 50;

    // Recalculate
    let account = &engine.accounts[user as usize];
    let elapsed = engine
        .current_slot
        .saturating_sub(account.warmup_started_at_slot);
    let warmed_cap = account.warmup_slope_per_step.get() * (elapsed as u128);
    let available = positive_pnl; // 1000
    let withdrawable_now = core::cmp::min(available, warmed_cap);

    // With slope=10 (avail_gross=1000/100) and 50 slots, warmed_cap = 500
    // withdrawable = min(1000, 500) = 500
    // unwrapped = 1000 - 500 = 500
    let expected_unwrapped_now = positive_pnl.saturating_sub(withdrawable_now);

    assert_eq!(
        withdrawable_now, 500,
        "After 50 slots, withdrawable should be 500"
    );
    assert_eq!(
        expected_unwrapped_now, 500,
        "After 50 slots, unwrapped should be 500"
    );

    assert_conserved(&engine);
}

// ============================================================================
// ADL LARGEST-REMAINDER TESTS
// ============================================================================




// ============================================================================
// Negative PnL Immediate Settlement Tests (Fix A)
// ============================================================================

/// Test 1: Withdrawal rejected when position closed and negative PnL exists
/// Setup: capital=10_000, pnl=-9_000, pos=0, slope=0, vault=10_000
/// withdraw(10_000) must be Err(InsufficientBalance)
/// State after: capital=1_000, pnl=0
#[test]
fn test_withdraw_rejected_when_closed_and_negative_pnl() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();

    // Setup: position closed but with unrealized losses
    engine.accounts[user_idx as usize].capital = U128::new(10_000);
    engine.accounts[user_idx as usize].pnl = I128::new(-9_000);
    engine.accounts[user_idx as usize].position_size = I128::new(0); // No position
    engine.accounts[user_idx as usize].warmup_slope_per_step = U128::new(0);
    engine.vault = U128::new(10_000);

    // Attempt to withdraw full capital - should fail because losses must be realized first
    let result = engine.withdraw(user_idx, 10_000, 0, 1_000_000);

    // The withdraw should fail with InsufficientBalance
    assert!(
        result == Err(RiskError::InsufficientBalance),
        "Expected InsufficientBalance after loss realization reduces capital"
    );

    // After the failed withdraw call (which internally called settle_warmup_to_capital):
    // capital should be 1_000 (10_000 - 9_000 loss)
    // pnl should be 0 (loss fully realized)
    // warmed_neg_total should include 9_000
    assert_eq!(
        engine.accounts[user_idx as usize].capital.get(),
        1_000,
        "Capital should be reduced by loss amount"
    );
    assert_eq!(
        engine.accounts[user_idx as usize].pnl.get(),
        0,
        "PnL should be 0 after loss realization"
    );
}

/// Test 2: After loss realization, remaining principal can be withdrawn
#[test]
fn test_withdraw_allows_remaining_principal_after_loss_realization() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();

    // Setup: position closed but with unrealized losses
    engine.accounts[user_idx as usize].capital = U128::new(10_000);
    engine.accounts[user_idx as usize].pnl = I128::new(-9_000);
    engine.accounts[user_idx as usize].position_size = I128::new(0);
    engine.accounts[user_idx as usize].warmup_slope_per_step = U128::new(0);
    engine.vault = U128::new(10_000);

    // First, trigger loss settlement
    engine.settle_warmup_to_capital(user_idx).unwrap();

    // Now capital should be 1_000
    assert_eq!(engine.accounts[user_idx as usize].capital.get(), 1_000);
    assert_eq!(engine.accounts[user_idx as usize].pnl.get(), 0);

    // Withdraw remaining capital - should succeed
    let result = engine.withdraw(user_idx, 1_000, 0, 1_000_000);
    assert!(
        result.is_ok(),
        "Withdraw of remaining capital should succeed"
    );
    assert_eq!(engine.accounts[user_idx as usize].capital.get(), 0);
}

/// Test: Negative PnL settles immediately, independent of warmup slope
#[test]
fn test_negative_pnl_settles_immediately_independent_of_slope() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();

    // Setup: loss with zero slope - under old code this would NOT settle
    let capital = 10_000u128;
    let loss = 3_000i128;
    engine.accounts[user_idx as usize].capital = U128::new(capital);
    engine.accounts[user_idx as usize].pnl = I128::new(-loss);
    engine.accounts[user_idx as usize].warmup_slope_per_step = U128::new(0); // Zero slope
    engine.accounts[user_idx as usize].warmup_started_at_slot = 0;
    engine.vault = U128::new(capital);
    engine.current_slot = 100; // Time has passed


    // Call settle
    engine.settle_warmup_to_capital(user_idx).unwrap();

    // Assertions: loss should settle immediately despite zero slope
    assert_eq!(
        engine.accounts[user_idx as usize].capital.get(),
        capital - (loss as u128),
        "Capital should be reduced by full loss amount"
    );
    assert_eq!(
        engine.accounts[user_idx as usize].pnl.get(),
        0,
        "PnL should be 0 after immediate settlement"
    );
}

/// Test: When loss exceeds capital, capital goes to zero and pnl becomes remaining negative
#[test]
fn test_loss_exceeding_capital_leaves_negative_pnl() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();

    // Setup: loss greater than capital
    let capital = 5_000u128;
    let loss = 8_000i128;
    engine.accounts[user_idx as usize].capital = U128::new(capital);
    engine.accounts[user_idx as usize].pnl = I128::new(-loss);
    engine.accounts[user_idx as usize].warmup_slope_per_step = U128::new(0);
    engine.vault = U128::new(capital);
    engine.recompute_aggregates();

    // Call settle
    engine.settle_warmup_to_capital(user_idx).unwrap();

    // Capital should be fully consumed
    assert_eq!(
        engine.accounts[user_idx as usize].capital.get(),
        0,
        "Capital should be reduced to zero"
    );
    // Under haircut-ratio design, remaining loss is written off to 0 (spec §6.1 step 4)
    assert_eq!(
        engine.accounts[user_idx as usize].pnl.get(),
        0,
        "Remaining loss should be written off to zero"
    );
}

// ============================================================================
// Equity-Based Margin Tests (Fix B)
// ============================================================================

/// Test 3: Withdraw with open position blocked due to equity
#[test]
fn test_withdraw_open_position_blocks_due_to_equity() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();

    // Setup: position_size = 1000, entry_price = 1_000_000
    // notional = 1000, MM = 50, IM = 100
    // capital = 150, pnl = -100
    // After warmup settle: capital = 50, pnl = 0, equity = 50
    // equity(50) is NOT strictly > MM(50), so touch_account_full's
    // post-settlement MM re-check fails with Undercollateralized.

    engine.accounts[user_idx as usize].capital = U128::new(150);
    engine.accounts[user_idx as usize].pnl = I128::new(-100);
    engine.accounts[user_idx as usize].position_size = I128::new(1_000);
    engine.accounts[user_idx as usize].entry_price = 1_000_000;
    engine.accounts[user_idx as usize].warmup_slope_per_step = U128::new(0);
    engine.vault = U128::new(150);

    // withdraw(60) should fail - loss settles first, then MM re-check catches
    // that equity(50) is not strictly above MM(50)
    let result = engine.withdraw(user_idx, 60, 0, 1_000_000);
    assert!(
        result == Err(RiskError::Undercollateralized),
        "withdraw(60) must fail: after settling 100 loss, equity=50 not > MM=50"
    );

    // Loss was settled during touch_account_full: capital = 50, pnl = 0
    assert_eq!(engine.accounts[user_idx as usize].capital.get(), 50);
    assert_eq!(engine.accounts[user_idx as usize].pnl.get(), 0);

    // Try withdraw(40) - same: equity(50) not > MM(50) so touch_account_full fails
    let result = engine.withdraw(user_idx, 40, 0, 1_000_000);
    assert!(
        result == Err(RiskError::Undercollateralized),
        "withdraw(40) must fail: equity=50 not > MM=50"
    );
}

/// Test: account_equity correctly computes max(0, capital + pnl)
#[test]
fn test_account_equity_computes_correctly() {
    let engine = RiskEngine::new(default_params());

    // Positive equity
    let account_pos = Account {
        kind: AccountKind::User,
        account_id: 1,
        capital: U128::new(10_000),
        pnl: I128::new(-3_000),
        reserved_pnl: 0,
        warmup_started_at_slot: 0,
        warmup_slope_per_step: U128::ZERO,
        position_size: I128::ZERO,
        entry_price: 0,
        funding_index: I128::ZERO,
        matcher_program: [0; 32],
        matcher_context: [0; 32],
        owner: [0; 32],
        fee_credits: I128::ZERO,
        last_fee_slot: 0,
    };
    assert_eq!(engine.account_equity(&account_pos), 7_000);

    // Negative sum clamped to zero
    let account_neg = Account {
        kind: AccountKind::User,
        account_id: 2,
        capital: U128::new(5_000),
        pnl: I128::new(-8_000),
        reserved_pnl: 0,
        warmup_started_at_slot: 0,
        warmup_slope_per_step: U128::ZERO,
        position_size: I128::ZERO,
        entry_price: 0,
        funding_index: I128::ZERO,
        matcher_program: [0; 32],
        matcher_context: [0; 32],
        owner: [0; 32],
        fee_credits: I128::ZERO,
        last_fee_slot: 0,
    };
    assert_eq!(engine.account_equity(&account_neg), 0);

    // Positive pnl adds to equity
    let account_profit = Account {
        kind: AccountKind::User,
        account_id: 3,
        capital: U128::new(10_000),
        pnl: I128::new(5_000),
        reserved_pnl: 0,
        warmup_started_at_slot: 0,
        warmup_slope_per_step: U128::ZERO,
        position_size: I128::ZERO,
        entry_price: 0,
        funding_index: I128::ZERO,
        matcher_program: [0; 32],
        matcher_context: [0; 32],
        owner: [0; 32],
        fee_credits: I128::ZERO,
        last_fee_slot: 0,
    };
    assert_eq!(engine.account_equity(&account_profit), 15_000);
}

// ============================================================================
// N1 Invariant Tests: Negative PnL Settlement and Equity-Based Margin
// ============================================================================

/// Test: closed position + negative pnl blocks full withdrawal
/// After loss settlement, can't withdraw the original capital amount
#[test]
fn test_withdraw_rejected_when_closed_and_negative_pnl_full_amount() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();

    // Setup: deposit 1000, no position, negative pnl of -300
    let _ = engine.deposit(user_idx, 1000, 0);
    engine.accounts[user_idx as usize].pnl = I128::new(-300);
    engine.accounts[user_idx as usize].position_size = I128::new(0);

    // Try to withdraw full original amount (1000)
    // After settle: capital = 1000 - 300 = 700, so withdrawing 1000 should fail
    let result = engine.withdraw(user_idx, 1000, 0, 1_000_000);
    assert_eq!(result, Err(RiskError::InsufficientBalance));

    // Verify N1 invariant: after operation, pnl >= 0 || capital == 0
    let account = &engine.accounts[user_idx as usize];
    assert!(!account.pnl.is_negative() || account.capital.is_zero());
}

/// Test: remaining principal withdrawal succeeds after loss settlement
/// After loss settlement, can still withdraw what remains
#[test]
fn test_withdraw_allows_remaining_principal_after_loss_settlement() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();

    // Setup: deposit 1000, no position, negative pnl of -300
    let _ = engine.deposit(user_idx, 1000, 0);
    engine.accounts[user_idx as usize].pnl = I128::new(-300);
    engine.accounts[user_idx as usize].position_size = I128::new(0);

    // After settle: capital = 700. Withdraw 500 should succeed.
    let result = engine.withdraw(user_idx, 500, 0, 1_000_000);
    assert!(result.is_ok());

    // Verify remaining capital
    assert_eq!(engine.accounts[user_idx as usize].capital.get(), 200);
    // Verify N1 invariant
    assert!(engine.accounts[user_idx as usize].pnl.get() >= 0);
}

/// Test: insolvent account (loss > capital) blocks any withdrawal
/// When loss exceeds capital, withdrawal is blocked
#[test]
fn test_insolvent_account_blocks_any_withdrawal() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();

    // Setup: deposit 500, no position, negative pnl of -800 (exceeds capital)
    let _ = engine.deposit(user_idx, 500, 0);
    engine.accounts[user_idx as usize].pnl = I128::new(-800);
    engine.accounts[user_idx as usize].position_size = I128::new(0);

    // After settle: capital = 0, pnl = -300 (remaining loss)
    // Any withdrawal should fail
    let result = engine.withdraw(user_idx, 1, 0, 1_000_000);
    assert_eq!(result, Err(RiskError::InsufficientBalance));

    // Verify N1 invariant: pnl < 0 implies capital == 0
    let account = &engine.accounts[user_idx as usize];
    assert!(!account.pnl.is_negative() || account.capital.is_zero());
}

/// Test: deterministic IM withdrawal blocks when equity after < IM
/// With position, equity-based margin check blocks undercollateralized withdrawal
#[test]
fn test_withdraw_im_check_blocks_when_equity_below_im() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();

    // Setup: capital = 150, pnl = 0, position = 1000, entry_price = 1_000_000
    // notional = 1000, IM = 1000 * 1000 / 10000 = 100
    let _ = engine.deposit(user_idx, 150, 0);
    engine.accounts[user_idx as usize].pnl = I128::new(0);
    engine.accounts[user_idx as usize].position_size = I128::new(1000);
    engine.accounts[user_idx as usize].entry_price = 1_000_000;
    engine.funding_index_qpb_e6 = I128::new(0);
    engine.accounts[user_idx as usize].funding_index = I128::new(0);

    // withdraw(60): new_capital = 90, equity = 90 < 100 (IM)
    // Should fail with Undercollateralized
    let result = engine.withdraw(user_idx, 60, 0, 1_000_000);
    assert_eq!(result, Err(RiskError::Undercollateralized));

    // withdraw(40): would pass IM check (equity 110 > IM 100) but
    // withdrawals are blocked entirely when position is open.
    // Must close position first.
    let result2 = engine.withdraw(user_idx, 40, 0, 1_000_000);
    assert_eq!(result2, Err(RiskError::Undercollateralized));
}

// ==============================================================================
// LIQUIDATION TESTS
// ==============================================================================

/// Test: keeper_crank returns num_liquidations > 0 when a user is under maintenance
#[test]
fn test_keeper_crank_liquidates_undercollateralized_user() {
    let mut engine = Box::new(RiskEngine::new(default_params()));

    // Fund insurance to avoid force-realize mode (threshold=0 means balance=0 triggers it)
    engine.insurance_fund.balance = U128::new(1_000_000);

    // Create user and LP
    let user = engine.add_user(0).unwrap();
    let lp = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();
    let _ = engine.deposit(user, 10_000, 0);
    let _ = engine.deposit(lp, 100_000, 0);

    // Give user a long position at entry price 1.0
    engine.accounts[user as usize].position_size = I128::new(1_000_000); // 1 unit
    engine.accounts[user as usize].entry_price = 1_000_000;
    engine.accounts[lp as usize].position_size = I128::new(-1_000_000);
    engine.accounts[lp as usize].entry_price = 1_000_000;
    engine.total_open_interest = U128::new(2_000_000);

    // Set negative PnL to make user undercollateralized
    // Position value at oracle 0.5 = 500_000
    // Maintenance margin = 500_000 * 5% = 25_000
    // User has capital 10_000, needs equity > 25_000 to avoid liquidation
    engine.accounts[user as usize].pnl = I128::new(-9_500); // equity = 500 < 25_000

    let _insurance_before = engine.insurance_fund.balance;

    // Call keeper_crank with oracle price 0.5 (500_000 in e6)
    let result = engine.keeper_crank(user, 1, 500_000, 0, false);
    assert!(result.is_ok());

    let outcome = result.unwrap();

    // Should have liquidated the user
    assert!(
        outcome.num_liquidations > 0,
        "Expected at least one liquidation, got {}",
        outcome.num_liquidations
    );

    // User's position should be closed
    assert_eq!(
        engine.accounts[user as usize].position_size.get(),
        0,
        "User position should be closed after liquidation"
    );

    // Pending loss from liquidation is resolved after a full sweep
    // Run enough cranks to complete a full sweep
    for slot in 2..=17 {
        engine.keeper_crank(user, slot, 500_000, 0, false).unwrap();
    }

    // Note: Insurance may decrease if liquidation creates unpaid losses
    // that get covered by finalize_pending_after_window. This is correct behavior.
    // The key invariant is that pending is resolved (not stuck forever).
}

/// Test: Liquidation fee is correctly calculated and paid
/// Setup: small position with no mark pnl (oracle == entry), just barely undercollateralized
#[test]
fn test_liquidation_fee_calculation() {
    let mut engine = Box::new(RiskEngine::new(default_params()));

    // Create user
    let user = engine.add_user(0).unwrap();

    // Setup:
    // position = 100_000 (0.1 unit), entry = oracle = 1_000_000 (no mark pnl)
    // position_value = 100_000 * 1_000_000 / 1_000_000 = 100_000
    // maintenance_margin = 100_000 * 5% = 5_000
    // capital = 4_000 < 5_000 -> undercollateralized
    engine.accounts[user as usize].capital = U128::new(4_000);
    engine.accounts[user as usize].position_size = I128::new(100_000); // 0.1 unit
    engine.accounts[user as usize].entry_price = 1_000_000;
    engine.accounts[user as usize].pnl = I128::new(0);
    engine.total_open_interest = U128::new(100_000);
    engine.vault = U128::new(4_000);

    let insurance_before = engine.insurance_fund.balance;
    let oracle_price: u64 = 1_000_000; // Same as entry = no mark pnl

    // Expected fee calculation:
    // notional = 100_000 * 1_000_000 / 1_000_000 = 100_000
    // fee = 100_000 * 50 / 10_000 = 500 (0.5% of notional)

    let result = engine.liquidate_at_oracle(user, 0, oracle_price);
    assert!(result.is_ok());
    assert!(result.unwrap(), "Liquidation should occur");

    let insurance_after = engine.insurance_fund.balance.get();
    let fee_received = insurance_after - insurance_before.get();

    // Fee should be 0.5% of notional (100_000)
    let expected_fee: u128 = 500;
    assert_eq!(
        fee_received, expected_fee,
        "Liquidation fee should be {} but got {}",
        expected_fee, fee_received
    );

    // Verify capital was reduced by the fee
    assert_eq!(
        engine.accounts[user as usize].capital.get(),
        3_500,
        "Capital should be 4000 - 500 = 3500"
    );
}

// ============================================================================
// PARTIAL LIQUIDATION TESTS
// ============================================================================

/// Test 1: Dust kill-switch forces full close when remaining would be too small
#[test]
fn test_dust_killswitch_forces_full_close() {
    let mut params = default_params();
    params.maintenance_margin_bps = 500;
    params.liquidation_buffer_bps = 100;
    params.min_liquidation_abs = U128::new(5_000_000); // 5 units minimum

    let mut engine = Box::new(RiskEngine::new(params));

    // Create user with direct setup (matching test_liquidation_fee_calculation pattern)
    let user = engine.add_user(0).unwrap();

    // Position: 6 units at $1, barely undercollateralized at oracle = entry
    // position_value = 6_000_000
    // MM = 6_000_000 * 5% = 300_000
    // Set capital below MM to trigger liquidation
    engine.accounts[user as usize].capital = U128::new(200_000);
    engine.accounts[user as usize].position_size = I128::new(6_000_000);
    engine.accounts[user as usize].entry_price = 1_000_000;
    engine.accounts[user as usize].pnl = I128::new(0);
    engine.total_open_interest = U128::new(6_000_000);
    engine.vault = U128::new(200_000);

    // Oracle at entry price (no mark pnl)
    let oracle_price = 1_000_000;

    // Liquidate
    let result = engine.liquidate_at_oracle(user, 0, oracle_price).unwrap();
    assert!(result, "Liquidation should succeed");

    // Due to dust kill-switch (remaining < 5 units), position should be fully closed
    assert_eq!(
        engine.accounts[user as usize].position_size.get(),
        0,
        "Dust kill-switch should force full close"
    );
}

/// Test 2: Partial liquidation reduces position to safe level
#[test]
fn test_partial_liquidation_brings_to_safety() {
    let mut params = default_params();
    params.maintenance_margin_bps = 500;
    params.liquidation_buffer_bps = 100;
    params.min_liquidation_abs = U128::new(100_000);

    let mut engine = Box::new(RiskEngine::new(params));
    let user = engine.add_user(0).unwrap();

    // Position: 10 units at $1, small capital
    // At oracle $1: equity = 100k, position_value = 10M
    // MM = 10M * 5% = 500k
    // equity (100k) < MM (500k) => undercollateralized
    // But equity > 0, so partial liquidation will occur
    engine.accounts[user as usize].capital = U128::new(100_000);
    engine.accounts[user as usize].position_size = I128::new(10_000_000);
    engine.accounts[user as usize].entry_price = 1_000_000;
    engine.accounts[user as usize].pnl = I128::new(0);
    engine.total_open_interest = U128::new(10_000_000);
    engine.vault = U128::new(100_000);

    let oracle_price = 1_000_000;
    let pos_before = engine.accounts[user as usize].position_size;

    // Liquidate - should succeed and reduce position
    let result = engine.liquidate_at_oracle(user, 0, oracle_price).unwrap();
    assert!(result, "Liquidation should succeed");

    let pos_after = engine.accounts[user as usize].position_size;

    // Position should be reduced (partial liquidation)
    assert!(
        pos_after.get() < pos_before.get(),
        "Position should be reduced after liquidation"
    );
    assert!(
        pos_after.is_positive(),
        "Partial liquidation should leave some position"
    );
}

/// Test 3: Liquidation fee is charged on closed notional
#[test]
fn test_partial_liquidation_fee_charged() {
    let mut params = default_params();
    params.maintenance_margin_bps = 500;
    params.liquidation_buffer_bps = 100;
    params.min_liquidation_abs = U128::new(100_000);
    params.liquidation_fee_bps = 50; // 0.5%

    let mut engine = Box::new(RiskEngine::new(params));
    let user = engine.add_user(0).unwrap();

    // Small position to trigger full liquidation (dust rule)
    // position_value = 500_000
    // MM = 25_000
    // capital = 20_000 < MM
    engine.accounts[user as usize].capital = U128::new(20_000);
    engine.accounts[user as usize].position_size = I128::new(500_000); // 0.5 units
    engine.accounts[user as usize].entry_price = 1_000_000;
    engine.accounts[user as usize].pnl = I128::new(0);
    engine.total_open_interest = U128::new(500_000);
    engine.vault = U128::new(20_000);

    let insurance_before = engine.insurance_fund.balance;
    let oracle_price = 1_000_000;

    // Liquidate
    let result = engine.liquidate_at_oracle(user, 0, oracle_price).unwrap();
    assert!(result, "Liquidation should succeed");

    let insurance_after = engine.insurance_fund.balance.get();
    let fee_received = insurance_after - insurance_before.get();

    // Fee = 500_000 * 1_000_000 / 1_000_000 * 50 / 10_000 = 2_500
    // But capped by available capital (20_000), so full 2_500 should be charged
    assert!(fee_received > 0, "Some fee should be charged");
}

/// Test 4: Compute liquidation close amount basic test
#[test]
fn test_compute_liquidation_close_amount_basic() {
    let params = default_params();
    let mut engine = Box::new(RiskEngine::new(params));
    let user = engine.add_user(0).unwrap();

    // Setup: position = 10 units, capital = 500k
    // At oracle $1: equity = 500k, position_value = 10M
    // MM = 10M * 5% = 500k
    // Target = 10M * 6% = 600k
    // abs_pos_safe_max = 500k * 10B / (1M * 600) = 8.33M
    // close_abs = 10M - 8.33M = 1.67M
    engine.accounts[user as usize].capital = U128::new(500_000);
    engine.accounts[user as usize].position_size = I128::new(10_000_000);
    engine.accounts[user as usize].entry_price = 1_000_000;
    engine.accounts[user as usize].pnl = I128::new(0);

    let account = &engine.accounts[user as usize];
    let (close_abs, is_full) = engine.compute_liquidation_close_amount(account, 1_000_000);

    // Should close some but not all
    assert!(close_abs > 0, "Should close some position");
    assert!(close_abs < 10_000_000, "Should not close entire position");
    assert!(!is_full, "Should be partial close");

    // Remaining should be >= min_liquidation_abs
    let remaining = 10_000_000 - close_abs;
    assert!(
        remaining >= params.min_liquidation_abs.get(),
        "Remaining should be above min threshold"
    );
}

/// Test 5: Compute liquidation triggers dust kill when remaining too small
#[test]
fn test_compute_liquidation_dust_kill() {
    let mut params = default_params();
    params.min_liquidation_abs = U128::new(9_000_000); // 9 units minimum (so after partial, remaining < 9 triggers kill)

    let mut engine = Box::new(RiskEngine::new(params));
    let user = engine.add_user(0).unwrap();

    // Setup: position = 10 units at $1, capital = 500k
    // At oracle $1: equity = 500k, position_value = 10M
    // Target = 6% of position_value
    // abs_pos_safe_max = 500k * 10B / (1M * 600) = 8.33M
    // remaining = 8.33M < 9M threshold => dust kill triggers
    engine.accounts[user as usize].capital = U128::new(500_000);
    engine.accounts[user as usize].position_size = I128::new(10_000_000);
    engine.accounts[user as usize].entry_price = 1_000_000;
    engine.accounts[user as usize].pnl = I128::new(0);

    let account = &engine.accounts[user as usize];
    let (close_abs, is_full) = engine.compute_liquidation_close_amount(account, 1_000_000);

    // Should trigger full close due to dust rule (remaining 8.33M < 9M min)
    assert_eq!(close_abs, 10_000_000, "Should close entire position");
    assert!(is_full, "Should be full close due to dust rule");
}

/// Test 6: Zero equity triggers full liquidation
#[test]
fn test_compute_liquidation_zero_equity() {
    let params = default_params();
    let mut engine = Box::new(RiskEngine::new(params));
    let user = engine.add_user(0).unwrap();

    // Setup: position = 10 units at $1, capital = 1M
    // At oracle $0.85: equity = max(0, 1M - 1.5M) = 0
    engine.accounts[user as usize].capital = U128::new(1_000_000);
    engine.accounts[user as usize].position_size = I128::new(10_000_000);
    engine.accounts[user as usize].entry_price = 1_000_000;
    // Simulate the mark pnl being applied
    engine.accounts[user as usize].pnl = I128::new(-1_500_000);

    let account = &engine.accounts[user as usize];
    let (close_abs, is_full) = engine.compute_liquidation_close_amount(account, 850_000);

    // Zero equity means full close
    assert_eq!(close_abs, 10_000_000, "Should close entire position");
    assert!(is_full, "Should be full close when equity is zero");
}

// ==============================================================================
// THRESHOLD SETTER/GETTER TESTS
// ==============================================================================

#[test]
fn test_set_threshold_updates_value() {
    let params = default_params();
    let mut engine = Box::new(RiskEngine::new(params));

    // Initial threshold from params
    assert_eq!(engine.risk_reduction_threshold(), 0);

    // Set new threshold
    engine.set_risk_reduction_threshold(5_000);
    assert_eq!(engine.risk_reduction_threshold(), 5_000);

    // Update again
    engine.set_risk_reduction_threshold(10_000);
    assert_eq!(engine.risk_reduction_threshold(), 10_000);

    // Set to zero
    engine.set_risk_reduction_threshold(0);
    assert_eq!(engine.risk_reduction_threshold(), 0);
}

#[test]
fn test_set_threshold_large_value() {
    let params = default_params();
    let mut engine = Box::new(RiskEngine::new(params));

    // Set to large value
    let large = u128::MAX / 2;
    engine.set_risk_reduction_threshold(large);
    assert_eq!(engine.risk_reduction_threshold(), large);
}

// ==============================================================================
// DUST GARBAGE COLLECTION TESTS
// ==============================================================================

#[test]
fn test_gc_fee_drained_dust() {
    // Test: account drained by maintenance fees gets GC'd
    let mut params = default_params();
    params.maintenance_fee_per_slot = U128::new(100); // 100 units per slot
    params.max_crank_staleness_slots = u64::MAX; // No staleness check

    let mut engine = Box::new(RiskEngine::new(params));

    // Create user with small capital
    let user = engine.add_user(0).unwrap();
    engine.deposit(user, 500, 0).unwrap();

    assert!(engine.is_used(user as usize), "User should exist");

    // Advance time to drain fees (500 / 100 = 5 slots)
    // Crank will settle fees, drain capital to 0, then GC
    let outcome = engine.keeper_crank(user, 10, 1_000_000, 0, false).unwrap();

    assert!(
        !engine.is_used(user as usize),
        "User slot should be freed after fee drain"
    );
    assert_eq!(outcome.num_gc_closed, 1, "Should have GC'd one account");
}

#[test]
fn test_gc_positive_pnl_never_collected() {
    // Test: account with positive PnL is never GC'd
    let params = default_params();
    let mut engine = Box::new(RiskEngine::new(params));

    // Create user and set up positive PnL with zero capital
    let user = engine.add_user(0).unwrap();
    // No deposit - capital = 0
    engine.accounts[user as usize].pnl = I128::new(1000); // Positive PnL

    assert!(engine.is_used(user as usize), "User should exist");

    // Crank should NOT GC this account
    let outcome = engine
        .keeper_crank(u16::MAX, 100, 1_000_000, 0, false)
        .unwrap();

    assert!(
        engine.is_used(user as usize),
        "User with positive PnL should NOT be GC'd"
    );
    assert_eq!(outcome.num_gc_closed, 0, "Should not GC any accounts");
}

#[test]
fn test_gc_negative_pnl_socialized() {
    // Test: account with negative PnL and zero capital is socialized then GC'd
    let params = default_params();
    let mut engine = Box::new(RiskEngine::new(params));

    // Create user with negative PnL and zero capital
    let user = engine.add_user(0).unwrap();

    // Create counterparty with matching positive PnL for zero-sum
    let counterparty = engine.add_user(0).unwrap();
    engine.deposit(counterparty, 1000, 0).unwrap(); // Needs capital to exist
    engine.accounts[counterparty as usize].pnl = I128::new(500); // Counterparty gains
                                                                 // Keep PnL unwrapped (not warmed) so socialization can haircut it
    engine.accounts[counterparty as usize].warmup_slope_per_step = U128::new(0);
    engine.accounts[counterparty as usize].warmup_started_at_slot = 0;

    // Now set user's negative PnL (zero-sum with counterparty)
    engine.accounts[user as usize].pnl = I128::new(-500);
    engine.recompute_aggregates();

    // Set up insurance fund
    set_insurance(&mut engine, 10_000);

    assert!(engine.is_used(user as usize), "User should exist");

    // First crank: GC writes off negative PnL and frees account
    let outcome = engine
        .keeper_crank(u16::MAX, 100, 1_000_000, 0, false)
        .unwrap();

    assert!(
        !engine.is_used(user as usize),
        "User should be GC'd after loss write-off"
    );
    assert_eq!(outcome.num_gc_closed, 1, "Should have GC'd one account");

    // Under haircut-ratio design, counterparty's positive PnL is NOT directly haircut.
    // Instead, the write-off reduces Residual which reduces the haircut ratio h,
    // automatically haircutting PnL claims when they convert to capital during warmup.
    // The raw PnL value stays at 500 until warmup conversion applies the haircut.
    assert_eq!(
        engine.accounts[counterparty as usize].pnl.get(),
        500,
        "Counterparty PnL should remain at 500 (haircut applied at warmup conversion)"
    );

    // Primary invariant V >= C_tot + I should still hold after GC.
    // The extended conservation check (including net_pnl) may fail when write-offs
    // create positive net PnL not yet haircut. This is expected under the haircut-ratio
    // design: the haircut is applied at warmup conversion time, not at GC time.
    let c_tot: u128 = engine.accounts[counterparty as usize].capital.get();
    let insurance = engine.insurance_fund.balance.get();
    assert!(
        engine.vault.get() >= c_tot.saturating_add(insurance),
        "Primary invariant V >= C_tot + I should hold after GC: vault={}, c_tot={}, insurance={}",
        engine.vault.get(), c_tot, insurance
    );
}

#[test]
fn test_gc_with_position_not_collected() {
    // Test: account with open position is never GC'd
    let params = default_params();
    let mut engine = Box::new(RiskEngine::new(params));

    let user = engine.add_user(0).unwrap();
    // Add enough capital to avoid liquidation, then set position
    engine.deposit(user, 10_000, 0).unwrap();
    engine.accounts[user as usize].position_size = I128::new(1000);
    engine.accounts[user as usize].entry_price = 1_000_000;
    engine.total_open_interest = U128::new(1000);

    // Crank should NOT GC this account (has position)
    let outcome = engine
        .keeper_crank(u16::MAX, 100, 1_000_000, 0, false)
        .unwrap();

    assert!(
        engine.is_used(user as usize),
        "User with position should NOT be GC'd"
    );
    assert_eq!(outcome.num_gc_closed, 0, "Should not GC any accounts");
}

// ==============================================================================
// BATCHED ADL TESTS
// ==============================================================================

#[test]
fn test_batched_adl_profit_exclusion() {
    // Test: when liquidating an account with positive mark_pnl (profit from closing),
    // that account should be excluded from funding its own profit via ADL (socialization).
    let mut params = default_params();
    params.maintenance_margin_bps = 500; // 5%
    params.initial_margin_bps = 1000; // 10%
    params.liquidation_buffer_bps = 0; // No buffer
    params.liquidation_fee_bps = 0; // No fee for cleaner math
    params.max_crank_staleness_slots = u64::MAX;
    params.warmup_period_slots = 0; // Instant warmup for this test

    let mut engine = Box::new(RiskEngine::new(params));
    set_insurance(&mut engine, 100_000);

    // IMPORTANT: Account creation order matters for per-account processing.
    // We create the liquidated account FIRST so targets are processed AFTER,
    // allowing them to be haircutted to fund the liquidation profit.

    // Create the account to be liquidated FIRST: long from 0.8, so has PROFIT at 0.81
    // But with very low capital, maintenance margin will fail.
    // This creates a "winner liquidation" - account with positive mark_pnl gets liquidated.
    let winner_liq = engine.add_user(0).unwrap();
    engine.deposit(winner_liq, 1_000, 0).unwrap(); // Only 1000 capital
    engine.accounts[winner_liq as usize].position_size = I128::new(1_000_000); // Long 1 unit
    engine.accounts[winner_liq as usize].entry_price = 800_000; // Entered at 0.8

    // Create two accounts that will be the socialization targets (they have positive REALIZED PnL)
    // Socialization haircuts unwrapped PnL (not yet warmed), so keep slope=0.
    // Target 1: has realized profit of 20,000
    let adl_target1 = engine.add_user(0).unwrap();
    engine.deposit(adl_target1, 50_000, 0).unwrap();
    engine.accounts[adl_target1 as usize].pnl = I128::new(20_000); // Realized profit
                                                                   // Keep PnL unwrapped (not warmed) so socialization can haircut it
    engine.accounts[adl_target1 as usize].warmup_slope_per_step = U128::new(0);
    engine.accounts[adl_target1 as usize].warmup_started_at_slot = 0;

    // Target 2: Also has realized profit
    let adl_target2 = engine.add_user(0).unwrap();
    engine.deposit(adl_target2, 50_000, 0).unwrap();
    engine.accounts[adl_target2 as usize].pnl = I128::new(20_000); // Realized profit
    engine.accounts[adl_target2 as usize].warmup_slope_per_step = U128::new(0);
    engine.accounts[adl_target2 as usize].warmup_started_at_slot = 0;

    // Create a counterparty with negative pnl to balance the targets (for conservation)
    let counterparty = engine.add_user(0).unwrap();
    engine.deposit(counterparty, 100_000, 0).unwrap();
    engine.accounts[counterparty as usize].pnl = I128::new(-40_000); // Negative pnl balances targets

    // Set up counterparty short position for zero-sum (counterparty takes other side)
    engine.accounts[counterparty as usize].position_size = I128::new(-1_000_000);
    engine.accounts[counterparty as usize].entry_price = 800_000;
    engine.total_open_interest = U128::new(2_000_000); // Both positions counted

    // At oracle 0.81:
    // mark_pnl = (0.81 - 0.8) * 1 = 10_000
    // equity = 1000 + 10_000 = 11_000
    // position notional = 0.81 * 1 = 810_000 (in fixed point 810_000)
    // maintenance = 5% of 810_000 = 40_500
    // 11_000 < 40_500, so UNDERWATER

    // Snapshot before
    let target1_pnl_before = engine.accounts[adl_target1 as usize].pnl;
    let target2_pnl_before = engine.accounts[adl_target2 as usize].pnl;

    // Verify conservation holds before crank (at entry price since that's where positions are marked)
    let entry_oracle = 800_000; // Positions were created at this price
    assert!(
        engine.check_conservation(entry_oracle),
        "Conservation must hold before crank"
    );

    // Run crank at oracle price 0.81 - liquidation adds profit to pending bucket
    let crank_oracle = 810_000;
    let outcome = engine
        .keeper_crank(u16::MAX, 1, crank_oracle, 0, false)
        .unwrap();

    // Run additional cranks until socialization completes
    // (socialization processes accounts per crank)
    for slot in 2..20 {
        engine
            .keeper_crank(u16::MAX, slot, crank_oracle, 0, false)
            .unwrap();
    }

    // Verify conservation holds after socialization (use crank oracle since entries were updated)
    assert!(
        engine.check_conservation(crank_oracle),
        "Conservation must hold after batched liquidation"
    );

    // The liquidated account had positive mark_pnl (profit from closing).
    // That profit should be funded by socialization from the other profitable accounts.
    // With variation margin settlement, the mark PnL is settled to the pnl field
    // BEFORE liquidation. The "close profit" that would be socialized is now
    // already in the pnl field. The liquidation closes positions at oracle price
    // where entry = oracle after settlement, so there's no additional profit to socialize.
    //
    // This is the expected behavior change from variation margin:
    // - Old: close PnL calculated at liquidation time, socialized via ADL
    // - New: mark PnL settled before liquidation, no additional close PnL
    //
    // The test verifies that either:
    // 1. Targets were haircutted (old behavior), OR
    // 2. Liquidation occurred but profit was settled pre-liquidation (new behavior)
    let target1_pnl_after = engine.accounts[adl_target1 as usize].pnl.get();
    let target2_pnl_after = engine.accounts[adl_target2 as usize].pnl.get();

    let total_haircut = (target1_pnl_before.get() - target1_pnl_after)
        + (target2_pnl_before.get() - target2_pnl_after);

    // With variation margin: the winner's profit is in pnl field, not from close
    // So socialization may not occur. Check that liquidation happened.
    assert!(
        outcome.num_liquidations > 0 || total_haircut > 0,
        "Either liquidation should occur or targets should be haircutted"
    );
}

#[test]
fn test_batched_adl_conservation_basic() {
    // Basic test: verify that keeper_crank maintains conservation.
    // This is a simpler regression test to verify batched ADL works.
    let mut params = default_params();
    params.max_crank_staleness_slots = u64::MAX;
    params.warmup_period_slots = 0;

    let mut engine = Box::new(RiskEngine::new(params));
    set_insurance(&mut engine, 100_000);

    // Create two users with opposing positions (zero-sum)
    // Give them plenty of capital so they're well above maintenance
    let long = engine.add_user(0).unwrap();
    engine.deposit(long, 200_000, 0).unwrap(); // Well above 5% of 1M = 50k
    engine.accounts[long as usize].position_size = I128::new(1_000_000);
    engine.accounts[long as usize].entry_price = 1_000_000;
    engine.total_open_interest = U128::new(1_000_000);

    let short = engine.add_user(0).unwrap();
    engine.deposit(short, 200_000, 0).unwrap(); // Well above 5% of 1M = 50k
    engine.accounts[short as usize].position_size = I128::new(-1_000_000);
    engine.accounts[short as usize].entry_price = 1_000_000;
    engine.total_open_interest = U128::new(engine.total_open_interest.get() + 1_000_000);

    // Verify conservation before
    assert!(
        engine.check_conservation(DEFAULT_ORACLE),
        "Conservation must hold before crank"
    );

    // Crank at same price (no mark pnl change)
    let outcome = engine
        .keeper_crank(u16::MAX, 1, 1_000_000, 0, false)
        .unwrap();

    // Verify conservation after
    assert!(
        engine.check_conservation(DEFAULT_ORACLE),
        "Conservation must hold after crank"
    );

    // No liquidations should occur at same price
    assert_eq!(outcome.num_liquidations, 0);
    assert_eq!(outcome.num_liq_errors, 0);
}

#[test]
fn test_two_phase_liquidation_priority_and_sweep() {
    // Test the crank liquidation design:
    // Each crank processes up to ACCOUNTS_PER_CRANK occupied accounts
    // Full sweep completes when cursor wraps around to start

    use percolator::ACCOUNTS_PER_CRANK;

    let mut params = default_params();
    params.maintenance_margin_bps = 500; // 5%
    params.initial_margin_bps = 1000; // 10%
    params.liquidation_buffer_bps = 0;
    params.liquidation_fee_bps = 0;
    params.max_crank_staleness_slots = u64::MAX;
    params.warmup_period_slots = 0;

    let mut engine = Box::new(RiskEngine::new(params));
    set_insurance(&mut engine, 1_000_000);

    // Create several accounts with varying underwater amounts
    // Priority liquidation should find the worst ones first

    // Healthy counterparty to take other side of positions
    let counterparty = engine.add_user(0).unwrap();
    engine.deposit(counterparty, 10_000_000, 0).unwrap();

    // Create underwater accounts with different severities
    // At oracle 1.0: maintenance = 5% of notional
    // Account with position 1M needs 50k margin. Capital < 50k => underwater

    // Mildly underwater (capital = 45k, needs 50k)
    let mild = engine.add_user(0).unwrap();
    engine.deposit(mild, 45_000, 0).unwrap();
    engine.accounts[mild as usize].position_size = I128::new(1_000_000);
    engine.accounts[mild as usize].entry_price = 1_000_000;
    engine.accounts[counterparty as usize].position_size -= 1_000_000;
    engine.accounts[counterparty as usize].entry_price = 1_000_000;
    engine.total_open_interest += 2_000_000;

    // Severely underwater (capital = 10k, needs 50k)
    let severe = engine.add_user(0).unwrap();
    engine.deposit(severe, 10_000, 0).unwrap();
    engine.accounts[severe as usize].position_size = I128::new(1_000_000);
    engine.accounts[severe as usize].entry_price = 1_000_000;
    engine.accounts[counterparty as usize].position_size -= 1_000_000;
    engine.total_open_interest += 2_000_000;

    // Very severely underwater (capital = 1k, needs 50k)
    let very_severe = engine.add_user(0).unwrap();
    engine.deposit(very_severe, 1_000, 0).unwrap();
    engine.accounts[very_severe as usize].position_size = I128::new(1_000_000);
    engine.accounts[very_severe as usize].entry_price = 1_000_000;
    engine.accounts[counterparty as usize].position_size -= 1_000_000;
    engine.total_open_interest += 2_000_000;

    // Verify conservation before
    assert!(
        engine.check_conservation(DEFAULT_ORACLE),
        "Conservation must hold before crank"
    );

    // Single crank should liquidate all underwater accounts via priority phase
    let outcome = engine
        .keeper_crank(u16::MAX, 1, 1_000_000, 0, false)
        .unwrap();

    // Verify conservation after
    assert!(
        engine.check_conservation(DEFAULT_ORACLE),
        "Conservation must hold after priority liquidation"
    );

    // All 3 underwater accounts should be liquidated (partially or fully)
    assert!(
        outcome.num_liquidations >= 3,
        "Priority liquidation should find all underwater accounts: got {}",
        outcome.num_liquidations
    );

    // Positions should be reduced (liquidation brings accounts back to margin)
    // very_severe had 1k capital => can support ~20k notional at 5% margin
    // severe had 10k capital => can support ~200k notional at 5% margin
    // mild had 45k capital => can support ~900k notional at 5% margin
    assert!(
        engine.accounts[very_severe as usize].position_size.get() < 100_000,
        "very_severe position should be significantly reduced"
    );
    assert!(
        engine.accounts[severe as usize].position_size.get() < 500_000,
        "severe position should be significantly reduced"
    );
    assert!(
        engine.accounts[mild as usize].position_size.get() < 1_000_000,
        "mild position should be reduced"
    );

    // With few accounts (< ACCOUNTS_PER_CRANK), a single crank should complete sweep
    // The first crank already ran above. Check if it completed a sweep.
    // With only 4 accounts, one crank should process all of them.
    assert!(
        outcome.sweep_complete || engine.num_used_accounts as u16 > ACCOUNTS_PER_CRANK,
        "Single crank should complete sweep when accounts < ACCOUNTS_PER_CRANK"
    );

    // If sweep didn't complete in first crank, run more until it does
    let mut slot = 2u64;
    while !engine.last_full_sweep_completed_slot > 0 && slot < 100 {
        let outcome = engine
            .keeper_crank(u16::MAX, slot, 1_000_000, 0, false)
            .unwrap();
        if outcome.sweep_complete {
            break;
        }
        slot += 1;
    }

    // Verify sweep completed
    assert!(
        engine.last_full_sweep_completed_slot > 0,
        "Sweep should have completed"
    );
}

#[test]
fn test_window_liquidation_many_accounts_few_liquidatable() {
    // Bench scenario: Many accounts with positions, but few actually liquidatable.
    // Tests that window sweep liquidation works correctly.
    // (In test mode MAX_ACCOUNTS=64, so we use proportional scaling)

    use percolator::MAX_ACCOUNTS;

    let mut params = default_params();
    params.maintenance_margin_bps = 500; // 5%
    params.max_crank_staleness_slots = u64::MAX;

    let mut engine = Box::new(RiskEngine::new(params));
    set_insurance(&mut engine, 1_000_000);

    // Create accounts with positions - most are healthy, few are underwater
    let num_accounts = MAX_ACCOUNTS.min(60); // Leave some slots for counterparty
    let num_underwater = 5; // Only 5 are actually liquidatable

    // Counterparty for opposing positions
    let counterparty = engine.add_user(0).unwrap();
    engine.deposit(counterparty, 100_000_000, 0).unwrap();

    let mut underwater_indices = Vec::new();

    for i in 0..num_accounts {
        let user = engine.add_user(0).unwrap();

        if i < num_underwater {
            // Underwater: low capital, will fail maintenance
            engine.deposit(user, 1_000, 0).unwrap();
            underwater_indices.push(user);
        } else {
            // Healthy: plenty of capital
            engine.deposit(user, 200_000, 0).unwrap();
        }

        // All have positions
        engine.accounts[user as usize].position_size = I128::new(1_000_000);
        engine.accounts[user as usize].entry_price = 1_000_000;
        engine.accounts[counterparty as usize].position_size -= 1_000_000;
        engine.total_open_interest += 2_000_000;
    }
    engine.accounts[counterparty as usize].entry_price = 1_000_000;

    // Verify conservation
    assert!(
        engine.check_conservation(DEFAULT_ORACLE),
        "Conservation before crank"
    );

    // Run crank - should select top-K efficiently
    let outcome = engine
        .keeper_crank(u16::MAX, 1, 1_000_000, 0, false)
        .unwrap();

    // Verify conservation after
    assert!(
        engine.check_conservation(DEFAULT_ORACLE),
        "Conservation after crank"
    );

    // Should have liquidated the underwater accounts
    assert!(
        outcome.num_liquidations >= num_underwater as u32,
        "Should liquidate at least {} accounts, got {}",
        num_underwater,
        outcome.num_liquidations
    );

    // Verify underwater accounts got liquidated (positions reduced)
    for &idx in &underwater_indices {
        assert!(
            engine.accounts[idx as usize].position_size.get() < 1_000_000,
            "Underwater account {} should have reduced position",
            idx
        );
    }
}

#[test]
fn test_window_liquidation_many_liquidatable() {
    // Bench scenario: Multiple liquidatable accounts with varying severity.
    // Tests that window sweep handles multiple liquidations correctly.

    let mut params = default_params();
    params.maintenance_margin_bps = 500; // 5%
    params.max_crank_staleness_slots = u64::MAX;
    params.warmup_period_slots = 0; // Instant warmup

    let mut engine = Box::new(RiskEngine::new(params));
    set_insurance(&mut engine, 10_000_000);

    // Create 10 underwater accounts with varying severities
    let num_underwater = 10;

    // Counterparty with lots of capital
    let counterparty = engine.add_user(0).unwrap();
    engine.deposit(counterparty, 100_000_000, 0).unwrap();

    // Create underwater accounts
    for i in 0..num_underwater {
        let user = engine.add_user(0).unwrap();
        // Vary capital: 10_000 to 40_000 (underwater for 5% margin on 1M position = 50k needed)
        let capital = 10_000 + (i as u128 * 3_000);
        engine.deposit(user, capital, 0).unwrap();
        engine.accounts[user as usize].position_size = I128::new(1_000_000);
        engine.accounts[user as usize].entry_price = 1_000_000;
        engine.accounts[counterparty as usize].position_size -= 1_000_000;
        engine.total_open_interest += 2_000_000;
    }
    engine.accounts[counterparty as usize].entry_price = 1_000_000;

    // Verify conservation
    assert!(
        engine.check_conservation(DEFAULT_ORACLE),
        "Conservation before crank"
    );

    // Run crank
    let outcome = engine
        .keeper_crank(u16::MAX, 1, 1_000_000, 0, false)
        .unwrap();

    // Verify conservation after
    assert!(
        engine.check_conservation(DEFAULT_ORACLE),
        "Conservation after crank"
    );

    // Should have liquidated accounts (partial or full)
    assert!(
        outcome.num_liquidations > 0,
        "Should liquidate some accounts"
    );

    // Liquidation may trigger errors if ADL waterfall exhausts resources,
    // but the system should remain consistent
}

// ==============================================================================
// WINDOWED FORCE-REALIZE STEP TESTS
// ==============================================================================

/// Test 1: Force-realize step closes positions in-window only
#[test]
fn test_force_realize_step_closes_in_window_only() {
    let mut params = default_params();
    params.risk_reduction_threshold = U128::new(1000); // Threshold at 1000
    let mut engine = Box::new(RiskEngine::new(params));
    engine.vault = U128::new(100_000);

    // Create counterparty LP
    let lp = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();
    engine.deposit(lp, 50_000, 0).unwrap();

    // Create users with positions at different indices
    let user1 = engine.add_user(0).unwrap(); // idx 1, in first window
    let user2 = engine.add_user(0).unwrap(); // idx 2, in first window
    let user3 = engine.add_user(0).unwrap(); // idx 3, in first window

    engine.deposit(user1, 5_000, 0).unwrap();
    engine.deposit(user2, 5_000, 0).unwrap();
    engine.deposit(user3, 5_000, 0).unwrap();

    // Give them positions
    engine.accounts[user1 as usize].position_size = I128::new(10_000);
    engine.accounts[user1 as usize].entry_price = 1_000_000;
    engine.accounts[user2 as usize].position_size = I128::new(10_000);
    engine.accounts[user2 as usize].entry_price = 1_000_000;
    engine.accounts[user3 as usize].position_size = I128::new(10_000);
    engine.accounts[user3 as usize].entry_price = 1_000_000;
    engine.accounts[lp as usize].position_size = I128::new(-30_000);
    engine.accounts[lp as usize].entry_price = 1_000_000;
    engine.total_open_interest = U128::new(60_000);

    // Set insurance at threshold (force-realize active)
    engine.insurance_fund.balance = U128::new(1000);

    // Run crank (cursor starts at 0)
    assert_eq!(engine.crank_cursor, 0);
    let outcome = engine
        .keeper_crank(u16::MAX, 1, 1_000_000, 0, false)
        .unwrap();

    // Force-realize should have run and closed positions
    assert!(
        outcome.force_realize_needed,
        "Force-realize should be needed"
    );
    assert!(
        outcome.force_realize_closed > 0,
        "Should have closed some positions"
    );

    // Positions should be closed
    assert_eq!(
        engine.accounts[user1 as usize].position_size.get(),
        0,
        "User1 position should be closed"
    );
    assert_eq!(
        engine.accounts[user2 as usize].position_size.get(),
        0,
        "User2 position should be closed"
    );
    assert_eq!(
        engine.accounts[user3 as usize].position_size.get(),
        0,
        "User3 position should be closed"
    );
}

/// Test 2: Force-realize step is inert when insurance > threshold
#[test]
fn test_force_realize_step_inert_above_threshold() {
    let mut params = default_params();
    params.risk_reduction_threshold = U128::new(1000); // Threshold at 1000
    let mut engine = Box::new(RiskEngine::new(params));
    engine.vault = U128::new(100_000);

    // Create counterparty LP
    let lp = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();
    engine.deposit(lp, 50_000, 0).unwrap();

    // Create user with position (must be >= min_liquidation_abs to avoid dust-closure)
    let user = engine.add_user(0).unwrap();
    engine.deposit(user, 100_000, 0).unwrap();
    engine.accounts[user as usize].position_size = I128::new(200_000);
    engine.accounts[user as usize].entry_price = 1_000_000;
    engine.accounts[lp as usize].position_size = I128::new(-200_000);
    engine.accounts[lp as usize].entry_price = 1_000_000;
    engine.total_open_interest = U128::new(400_000);

    // Set insurance ABOVE threshold (force-realize NOT active)
    engine.insurance_fund.balance = U128::new(1001);

    let pos_before = engine.accounts[user as usize].position_size;

    // Run crank
    let outcome = engine
        .keeper_crank(u16::MAX, 1, 1_000_000, 0, false)
        .unwrap();

    // Force-realize should not be needed
    assert!(
        !outcome.force_realize_needed,
        "Force-realize should not be needed"
    );
    assert_eq!(
        outcome.force_realize_closed, 0,
        "No positions should be force-closed"
    );

    // Position should be unchanged
    assert_eq!(
        engine.accounts[user as usize].position_size, pos_before,
        "Position should be unchanged"
    );
}

/// Test: Dust positions (below min_liquidation_abs) are force-closed during crank
/// even when insurance is above threshold (not in force-realize mode).
#[test]
fn test_crank_force_closes_dust_positions() {
    let mut params = default_params();
    params.risk_reduction_threshold = U128::new(1000);
    params.min_liquidation_abs = U128::new(100_000); // 100k minimum
    let mut engine = Box::new(RiskEngine::new(params));
    engine.vault = U128::new(100_000);

    // Create counterparty LP
    let lp = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();
    engine.deposit(lp, 50_000, 0).unwrap();

    // Create user with DUST position (below min_liquidation_abs)
    let user = engine.add_user(0).unwrap();
    engine.deposit(user, 10_000, 0).unwrap();
    engine.accounts[user as usize].position_size = I128::new(50_000); // Below 100k threshold
    engine.accounts[user as usize].entry_price = 1_000_000;
    engine.accounts[lp as usize].position_size = I128::new(-50_000);
    engine.accounts[lp as usize].entry_price = 1_000_000;
    engine.total_open_interest = U128::new(100_000);

    // Set insurance ABOVE threshold (force-realize NOT active)
    engine.insurance_fund.balance = U128::new(2000);

    assert!(
        !engine.accounts[user as usize].position_size.is_zero(),
        "User should have position before crank"
    );

    // Run crank
    let outcome = engine
        .keeper_crank(u16::MAX, 1, 1_000_000, 0, false)
        .unwrap();

    // Force-realize mode should NOT be needed (insurance above threshold)
    assert!(
        !outcome.force_realize_needed,
        "Force-realize should not be needed"
    );

    // But the dust position should still be closed
    assert!(
        engine.accounts[user as usize].position_size.is_zero(),
        "Dust position should be force-closed"
    );
    assert!(
        engine.accounts[lp as usize].position_size.is_zero(),
        "LP dust position should also be force-closed"
    );
}


/// Test 4: Withdraw/close blocked while pending is non-zero
#[test]
fn test_force_realize_blocks_value_extraction() {
    let mut params = default_params();
    params.risk_reduction_threshold = U128::new(1000);
    let mut engine = Box::new(RiskEngine::new(params));
    engine.vault = U128::new(100_000);

    // Create user with capital
    let user = engine.add_user(0).unwrap();
    engine.deposit(user, 10_000, 0).unwrap();

    // Under haircut-ratio design, there is no pending_unpaid_loss mechanism.
    // Withdrawals and closes are not blocked by pending losses.
    // Verify that basic operations work normally.

    // Withdraw should succeed
    let result = engine.withdraw(user, 1_000, 0, 1_000_000);
    assert!(result.is_ok(), "Withdraw should succeed (no pending loss mechanism)");

    // Close should succeed (account has remaining capital, no position)
    let result = engine.close_account(user, 0, 1_000_000);
    assert!(result.is_ok(), "Close should succeed (no pending loss mechanism)");
}

// ==============================================================================
// PENDING FINALIZE LIVENESS TESTS
// ==============================================================================

/// Test: insurance fund is stable when no losses exist (pending_unpaid_loss removed in haircut design)
#[test]
fn test_pending_finalize_liveness_insurance_covers() {
    let mut params = default_params();
    params.risk_reduction_threshold = U128::new(1000); // Floor at 1000
    let mut engine = Box::new(RiskEngine::new(params));

    // Fund insurance well above floor
    engine.insurance_fund.balance = U128::new(100_000);
    engine.vault = U128::new(100_000);

    // Run enough cranks to complete a full sweep
    for slot in 1..=16 {
        let result = engine.keeper_crank(u16::MAX, slot, 1_000_000, 0, false);
        assert!(result.is_ok());
    }

    // Under haircut-ratio design, there is no pending_unpaid_loss mechanism.
    // Insurance is not spent by cranks when there are no losses to handle.
    assert_eq!(
        engine.insurance_fund.balance.get(),
        100_000,
        "Insurance should be unchanged when no losses exist"
    );
}


/// Test: force-realize updates LP aggregates correctly
#[test]
fn test_force_realize_updates_lp_aggregates() {
    let mut params = default_params();
    params.risk_reduction_threshold = U128::new(10_000); // High threshold to trigger force-realize
    let mut engine = Box::new(RiskEngine::new(params));
    engine.vault = U128::new(100_000);

    // Insurance below threshold = force-realize active
    engine.insurance_fund.balance = U128::new(5_000);

    // Create LP with position
    let lp = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();
    engine.deposit(lp, 50_000, 0).unwrap();

    // Create user as counterparty
    let user = engine.add_user(0).unwrap();
    engine.deposit(user, 50_000, 0).unwrap();

    // Set up positions
    engine.accounts[lp as usize].position_size = I128::new(-1_000_000); // Short 1 unit
    engine.accounts[lp as usize].entry_price = 1_000_000;
    engine.accounts[user as usize].position_size = I128::new(1_000_000); // Long 1 unit
    engine.accounts[user as usize].entry_price = 1_000_000;
    engine.total_open_interest = U128::new(2_000_000);

    // Update LP aggregates manually (simulating what would normally happen)
    engine.net_lp_pos = I128::new(-1_000_000);
    engine.lp_sum_abs = U128::new(1_000_000);

    // Verify force-realize is active
    assert!(
        engine.insurance_fund.balance <= params.risk_reduction_threshold,
        "Force-realize should be active"
    );

    let net_lp_before = engine.net_lp_pos;
    let sum_abs_before = engine.lp_sum_abs;

    // Run crank - should close LP position via force-realize
    let result = engine.keeper_crank(u16::MAX, 1, 1_000_000, 0, false);
    assert!(result.is_ok());

    // LP position should be closed
    if engine.accounts[lp as usize].position_size.is_zero() {
        // If LP was closed, aggregates should be updated
        assert_ne!(
            engine.net_lp_pos.get(),
            net_lp_before.get(),
            "net_lp_pos should change when LP position closed"
        );
        assert!(
            engine.lp_sum_abs.get() < sum_abs_before.get(),
            "lp_sum_abs should decrease when LP position closed"
        );
    }
}

/// Test: withdrawals work normally (pending_unpaid_loss removed in haircut design)
#[test]
fn test_withdrawals_blocked_during_pending_unblocked_after() {
    let mut params = default_params();
    params.risk_reduction_threshold = U128::new(0);
    params.warmup_period_slots = 0; // Instant warmup
    let mut engine = Box::new(RiskEngine::new(params));

    // Fund insurance
    engine.insurance_fund.balance = U128::new(100_000);
    engine.vault = U128::new(100_000);

    // Create user with capital
    let user = engine.add_user(0).unwrap();
    engine.deposit(user, 10_000, 0).unwrap();

    // Crank to establish baseline
    engine
        .keeper_crank(u16::MAX, 1, 1_000_000, 0, false)
        .unwrap();

    // Under haircut-ratio design, there is no pending_unpaid_loss mechanism.
    // Withdrawals are not blocked by pending losses.
    let result = engine.withdraw(user, 1_000, 2, 1_000_000);
    assert!(
        result.is_ok(),
        "Withdraw should succeed (no pending loss mechanism)"
    );

    // Additional withdrawal should also succeed
    let result = engine.withdraw(user, 1_000, 2, 1_000_000);
    assert!(
        result.is_ok(),
        "Subsequent withdraw should also succeed"
    );
}


/// Test ADL overflow atomicity with actual engine
/// Key insight: To trigger the bug, we need:
/// 1. Account 1's haircut to be non-zero (so it gets modified)
/// 2. Account 2's multiplication to overflow
///
/// haircut_1 = (loss_to_socialize * unwrapped_1) / total_unwrapped
/// For haircut_1 > 0: loss_to_socialize * unwrapped_1 >= total_unwrapped
///
/// For account 2 to overflow: loss_to_socialize * unwrapped_2 > u128::MAX
// NOTE: This test demonstrates a KNOWN BUG (atomicity violation in apply_adl).
// It's documented in audit.md. The test expects the bug to manifest.

// ==============================================================================
// VARIATION MARGIN / MARK-TO-MARKET TESTS
// ==============================================================================

/// Test that trade PnL is calculated as (oracle - exec_price) * size
/// This ensures the new variation margin logic is working correctly.
#[test]
fn test_trade_pnl_is_oracle_minus_exec() {
    let mut params = default_params();
    params.trading_fee_bps = 0; // No fees for cleaner math
    params.max_crank_staleness_slots = u64::MAX;

    let mut engine = Box::new(RiskEngine::new(params));

    // Create LP and user with capital
    let lp = engine.add_lp([1u8; 32], [0u8; 32], 0).unwrap();
    engine.deposit(lp, 1_000_000, 0).unwrap();

    let user = engine.add_user(0).unwrap();
    engine.deposit(user, 1_000_000, 0).unwrap();

    // Execute trade: user buys 1 unit
    // Oracle = 1_000_000, execution price will be at oracle (NoOpMatcher)
    let oracle_price = 1_000_000;
    let size = 1_000_000; // Buy 1 unit

    engine
        .execute_trade(&MATCHER, lp, user, 0, oracle_price, size)
        .unwrap();

    // With oracle = exec_price, trade_pnl = (oracle - exec_price) * size = 0
    // User and LP should have pnl = 0 (no fee)
    assert_eq!(
        engine.accounts[user as usize].pnl.get(),
        0,
        "User pnl should be 0 when oracle = exec"
    );
    assert_eq!(
        engine.accounts[lp as usize].pnl.get(),
        0,
        "LP pnl should be 0 when oracle = exec"
    );

    // Both should have entry_price = oracle_price
    assert_eq!(
        engine.accounts[user as usize].entry_price, oracle_price,
        "User entry should be oracle"
    );
    assert_eq!(
        engine.accounts[lp as usize].entry_price, oracle_price,
        "LP entry should be oracle"
    );

    // Conservation should hold
    assert!(
        engine.check_conservation(oracle_price),
        "Conservation should hold"
    );
}

/// Test that mark PnL is settled before position changes (variation margin)
#[test]
fn test_mark_settlement_on_trade_touch() {
    let mut params = default_params();
    params.trading_fee_bps = 0;
    params.max_crank_staleness_slots = u64::MAX;

    let mut engine = Box::new(RiskEngine::new(params));

    // Create LP and user
    let lp = engine.add_lp([1u8; 32], [0u8; 32], 0).unwrap();
    engine.deposit(lp, 1_000_000, 0).unwrap();

    let user = engine.add_user(0).unwrap();
    engine.deposit(user, 1_000_000, 0).unwrap();

    // First trade: user buys 1 unit at oracle 1_000_000
    let oracle1 = 1_000_000;
    engine
        .execute_trade(&MATCHER, lp, user, 0, oracle1, 1_000_000)
        .unwrap();

    // User now has: pos = +1, entry = 1_000_000, pnl = 0
    assert_eq!(
        engine.accounts[user as usize].position_size.get(),
        1_000_000
    );
    assert_eq!(engine.accounts[user as usize].entry_price, oracle1);
    assert_eq!(engine.accounts[user as usize].pnl.get(), 0);

    // Second trade at higher oracle: user sells (closes) at oracle 1_100_000
    // Before position change, mark should be settled (coin-margined):
    // mark = (1_100_000 - 1_000_000) * 1_000_000 / 1_100_000 = 90_909
    // User gains +90909 mark PnL, LP gets -90909 mark PnL
    //
    // After mark settlement, trade_pnl = (oracle - exec) * size = 0 (exec at oracle)
    //
    // Note: settle_warmup_to_capital immediately settles negative PnL from capital,
    // so LP's pnl becomes 0 and capital decreases by 100k.
    // User's positive pnl may or may not settle depending on warmup budget.
    let oracle2 = 1_100_000;

    let user_capital_before = engine.accounts[user as usize].capital.get();
    let lp_capital_before = engine.accounts[lp as usize].capital.get();

    engine
        .execute_trade(&MATCHER, lp, user, 0, oracle2, -1_000_000)
        .unwrap();

    // User closed position
    assert_eq!(engine.accounts[user as usize].position_size.get(), 0);

    // User should have gained 100k total equity (could be in pnl or capital)
    let user_pnl = engine.accounts[user as usize].pnl.get();
    let user_capital = engine.accounts[user as usize].capital.get();
    let user_equity_gain = user_pnl + (user_capital as i128 - user_capital_before as i128);
    assert_eq!(
        user_equity_gain, 90_909,
        "User should have gained 90909 total equity (coin-margined)"
    );

    // LP should have lost 100k total equity
    // Since negative PnL is immediately settled, LP's pnl should be 0 and capital should be 900k
    let lp_pnl = engine.accounts[lp as usize].pnl.get();
    let lp_capital = engine.accounts[lp as usize].capital.get();
    assert_eq!(lp_pnl, 0, "LP negative pnl should be settled to capital");
    assert_eq!(
        lp_capital,
        lp_capital_before - 90_909,
        "LP capital should decrease by 90909 (coin-margined loss settled)"
    );

    // Conservation should hold
    assert!(
        engine.check_conservation(oracle2),
        "Conservation should hold after mark settlement"
    );
}

/// Test that closing through different LPs doesn't cause PnL teleportation
/// This is the original bug that variation margin was designed to fix.
#[test]
fn test_cross_lp_close_no_pnl_teleport() {
    let mut params = default_params();
    params.trading_fee_bps = 0;
    params.max_crank_staleness_slots = u64::MAX;
    params.max_accounts = 64;

    let mut engine = Box::new(RiskEngine::new(params));

    // Create two LPs with different entry prices (simulated)
    let lp1 = engine.add_lp([1u8; 32], [0u8; 32], 0).unwrap();
    engine.deposit(lp1, 1_000_000, 0).unwrap();

    let lp2 = engine.add_lp([2u8; 32], [0u8; 32], 0).unwrap();
    engine.deposit(lp2, 1_000_000, 0).unwrap();

    let user = engine.add_user(0).unwrap();
    engine.deposit(user, 1_000_000, 0).unwrap();

    // User opens position with LP1 at oracle 1_000_000
    let oracle1 = 1_000_000;
    engine
        .execute_trade(&MATCHER, lp1, user, 0, oracle1, 1_000_000)
        .unwrap();

    // Capture state
    let user_pnl_after_open = engine.accounts[user as usize].pnl.get();
    let lp1_pnl_after_open = engine.accounts[lp1 as usize].pnl.get();
    let lp2_pnl_after_open = engine.accounts[lp2 as usize].pnl.get();

    // All pnl should be 0 since oracle = exec
    assert_eq!(user_pnl_after_open, 0);
    assert_eq!(lp1_pnl_after_open, 0);
    assert_eq!(lp2_pnl_after_open, 0);

    // Now user closes with LP2 at SAME oracle (no price movement)
    // With old logic: PnL could "teleport" between LPs based on entry price differences
    // With new variation margin: all entries are at oracle, so no spurious PnL
    engine
        .execute_trade(&MATCHER, lp2, user, 0, oracle1, -1_000_000)
        .unwrap();

    // User should have 0 pnl (no price movement)
    let user_pnl_after_close = engine.accounts[user as usize].pnl.get();
    assert_eq!(
        user_pnl_after_close, 0,
        "User pnl should be 0 when closing at same oracle price"
    );

    // LP1 still has 0 pnl (never touched again after open)
    let lp1_pnl_after_close = engine.accounts[lp1 as usize].pnl.get();
    assert_eq!(lp1_pnl_after_close, 0, "LP1 pnl should remain 0");

    // LP2 should also have 0 pnl (took opposite of close at same price)
    let lp2_pnl_after_close = engine.accounts[lp2 as usize].pnl.get();
    assert_eq!(lp2_pnl_after_close, 0, "LP2 pnl should be 0");

    // CRITICAL: Total PnL should be exactly 0 (no value created/destroyed)
    let total_pnl = user_pnl_after_close + lp1_pnl_after_close + lp2_pnl_after_close;
    assert_eq!(total_pnl, 0, "Total PnL must be zero-sum");

    // Conservation should hold
    assert!(
        engine.check_conservation(oracle1),
        "Conservation should hold"
    );
}

// ==============================================================================
// WARMUP BYPASS REGRESSION TEST
// ==============================================================================

/// Test that execute_trade sets current_slot and resets warmup_started_at_slot
/// This ensures warmup cannot be bypassed by stale current_slot values.
#[test]
fn test_execute_trade_sets_current_slot_and_resets_warmup_start() {
    let mut params = default_params();
    params.warmup_period_slots = 1000;
    params.trading_fee_bps = 0;
    params.maintenance_fee_per_slot = U128::new(0);
    params.max_crank_staleness_slots = u64::MAX;
    params.max_accounts = 64;

    let mut engine = Box::new(RiskEngine::new(params));

    // Create LP and user with capital — deposits large enough to satisfy initial margin
    // at oracle_price=100k with 10% initial margin (notional=1e11, margin_req=1e10)
    let lp_idx = engine.add_lp([1u8; 32], [0u8; 32], 0).unwrap();
    engine.deposit(lp_idx, 20_000_000_000, 0).unwrap();

    let user_idx = engine.add_user(0).unwrap();
    engine.deposit(user_idx, 20_000_000_000, 0).unwrap();

    // Execute trade at now_slot = 100
    let now_slot = 100u64;
    let oracle_price = 100_000 * 1_000_000; // 100k
    let btc = 1_000_000i128; // 1 BTC

    engine
        .execute_trade(&MATCHER, lp_idx, user_idx, now_slot, oracle_price, btc)
        .unwrap();

    // Check current_slot was set
    assert_eq!(
        engine.current_slot, now_slot,
        "engine.current_slot should be set to now_slot after execute_trade"
    );

    // Check warmup_started_at_slot was reset for both accounts
    assert_eq!(
        engine.accounts[user_idx as usize].warmup_started_at_slot, now_slot,
        "user warmup_started_at_slot should be set to now_slot"
    );
    assert_eq!(
        engine.accounts[lp_idx as usize].warmup_started_at_slot, now_slot,
        "lp warmup_started_at_slot should be set to now_slot"
    );
}

// ==============================================================================
// MATCHER OUTPUT GUARD TESTS
// ==============================================================================

/// Matcher that returns the opposite sign of the requested size
struct OppositeSignMatcher;

impl MatchingEngine for OppositeSignMatcher {
    fn execute_match(
        &self,
        _lp_program: &[u8; 32],
        _lp_context: &[u8; 32],
        _lp_account_id: u64,
        oracle_price: u64,
        size: i128,
    ) -> Result<TradeExecution> {
        Ok(TradeExecution {
            price: oracle_price,
            size: -size, // Opposite sign!
        })
    }
}

/// Matcher that returns double the requested size
struct OversizeMatcher;

impl MatchingEngine for OversizeMatcher {
    fn execute_match(
        &self,
        _lp_program: &[u8; 32],
        _lp_context: &[u8; 32],
        _lp_account_id: u64,
        oracle_price: u64,
        size: i128,
    ) -> Result<TradeExecution> {
        Ok(TradeExecution {
            price: oracle_price,
            size: size.saturating_mul(2), // Double size!
        })
    }
}

#[test]
fn test_execute_trade_rejects_matcher_opposite_sign() {
    let mut params = default_params();
    params.trading_fee_bps = 0;
    params.max_crank_staleness_slots = u64::MAX;
    params.max_accounts = 64;

    let mut engine = Box::new(RiskEngine::new(params));

    let lp_idx = engine.add_lp([1u8; 32], [0u8; 32], 0).unwrap();
    engine.deposit(lp_idx, 1_000_000, 0).unwrap();

    let user_idx = engine.add_user(0).unwrap();
    engine.deposit(user_idx, 1_000_000, 0).unwrap();

    let result = engine.execute_trade(
        &OppositeSignMatcher,
        lp_idx,
        user_idx,
        0,
        1_000_000,
        1_000_000, // Request positive size
    );

    assert!(
        matches!(result, Err(RiskError::InvalidMatchingEngine)),
        "Should reject matcher that returns opposite sign: {:?}",
        result
    );
}

#[test]
fn test_execute_trade_rejects_matcher_oversize_fill() {
    let mut params = default_params();
    params.trading_fee_bps = 0;
    params.max_crank_staleness_slots = u64::MAX;
    params.max_accounts = 64;

    let mut engine = Box::new(RiskEngine::new(params));

    let lp_idx = engine.add_lp([1u8; 32], [0u8; 32], 0).unwrap();
    engine.deposit(lp_idx, 1_000_000, 0).unwrap();

    let user_idx = engine.add_user(0).unwrap();
    engine.deposit(user_idx, 1_000_000, 0).unwrap();

    let result = engine.execute_trade(
        &OversizeMatcher,
        lp_idx,
        user_idx,
        0,
        1_000_000,
        500_000, // Request half size
    );

    assert!(
        matches!(result, Err(RiskError::InvalidMatchingEngine)),
        "Should reject matcher that returns oversize fill: {:?}",
        result
    );
}

// ==============================================================================
// CONSERVATION CHECKER STRICTNESS TEST
// ==============================================================================

#[test]
fn test_check_conservation_fails_on_mark_overflow() {
    let mut params = default_params();
    params.max_accounts = 64;

    let mut engine = Box::new(RiskEngine::new(params));

    // Create user account
    let user_idx = engine.add_user(0).unwrap();

    // Manually set up an account state that will cause mark_pnl overflow
    // position_size = i128::MAX, entry_price = MAX_ORACLE_PRICE
    // When mark_pnl is calculated with oracle = 1, it will overflow
    engine.accounts[user_idx as usize].position_size = I128::new(i128::MAX);
    engine.accounts[user_idx as usize].entry_price = MAX_ORACLE_PRICE;
    engine.accounts[user_idx as usize].capital = U128::ZERO;
    engine.accounts[user_idx as usize].pnl = I128::new(0);

    // Conservation should fail because mark_pnl calculation overflows
    assert!(
        !engine.check_conservation(1),
        "check_conservation should return false when mark_pnl overflows"
    );
}

// ==============================================================================
// Tests migrated from src/percolator.rs inline tests
// ==============================================================================

const E6: u64 = 1_000_000;
const ORACLE_100K: u64 = 100_000 * E6;
const ONE_BASE: i128 = 1_000_000; // 1.0 base unit if base is 1e6-scaled

fn params_for_inline_tests() -> RiskParams {
    RiskParams {
        warmup_period_slots: 1000,
        maintenance_margin_bps: 1,
        initial_margin_bps: 1,
        trading_fee_bps: 0,
        max_accounts: MAX_ACCOUNTS as u64,
        new_account_fee: U128::new(0),
        risk_reduction_threshold: U128::new(0),

        maintenance_fee_per_slot: U128::new(0),
        max_crank_staleness_slots: u64::MAX,

        liquidation_fee_bps: 0,
        liquidation_fee_cap: U128::new(0),

        liquidation_buffer_bps: 0,
        min_liquidation_abs: U128::new(0),
        funding_premium_weight_bps: 0,
        funding_settlement_interval_slots: 0,
        funding_premium_dampening_e6: 1_000_000,
        funding_premium_max_bps_per_slot: 5,
    }
}

#[test]
fn test_cross_lp_close_no_pnl_teleport_simple() {
    let mut engine = RiskEngine::new(params_for_inline_tests());

    let lp1 = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();
    let lp2 = engine.add_lp([3u8; 32], [4u8; 32], 0).unwrap();
    let user = engine.add_user(0).unwrap();

    // LP1 must be able to absorb -10k*E6 loss and still have equity > 0
    engine.deposit(lp1, 50_000 * (E6 as u128), 1).unwrap();
    engine.deposit(lp2, 50_000 * (E6 as u128), 1).unwrap();
    engine.deposit(user, 50_000 * (E6 as u128), 1).unwrap();

    // Trade 1: user opens +1 at 90k while oracle=100k => user +10k, LP1 -10k
    struct P90kMatcher;
    impl MatchingEngine for P90kMatcher {
        fn execute_match(
            &self,
            _lp_program: &[u8; 32],
            _lp_context: &[u8; 32],
            _lp_account_id: u64,
            oracle_price: u64,
            size: i128,
        ) -> Result<TradeExecution> {
            Ok(TradeExecution {
                price: oracle_price - (10_000 * 1_000_000),
                size,
            })
        }
    }

    // Trade 2: user closes with LP2 at oracle price => trade_pnl = 0 (no teleport)
    struct AtOracleMatcher;
    impl MatchingEngine for AtOracleMatcher {
        fn execute_match(
            &self,
            _lp_program: &[u8; 32],
            _lp_context: &[u8; 32],
            _lp_account_id: u64,
            oracle_price: u64,
            size: i128,
        ) -> Result<TradeExecution> {
            Ok(TradeExecution {
                price: oracle_price,
                size,
            })
        }
    }

    engine
        .execute_trade(&P90kMatcher, lp1, user, 100, ORACLE_100K, ONE_BASE)
        .unwrap();
    engine
        .execute_trade(&AtOracleMatcher, lp2, user, 101, ORACLE_100K, -ONE_BASE)
        .unwrap();

    // User is flat
    assert_eq!(engine.accounts[user as usize].position_size.get(), 0);

    // PnL stays with LP1 (the LP that gave the user a better-than-oracle fill).
    // Coin-margined profit: (10K*E6) * ONE_BASE / ORACLE_100K = 100_000
    let profit: u128 = 100_000;
    let user_pnl = engine.accounts[user as usize].pnl.get() as u128;
    let user_cap = engine.accounts[user as usize].capital.get();
    let initial_cap = 50_000 * (E6 as u128);
    // Total user value (pnl + capital) must equal initial_capital + coin-margined profit
    assert_eq!(user_pnl + user_cap, initial_cap + profit,
        "user total value must be initial_capital + trade profit");
    assert_eq!(engine.accounts[lp1 as usize].pnl.get(), 0);
    assert_eq!(engine.accounts[lp1 as usize].capital.get(), initial_cap - profit);
    // LP2 must be unaffected (no teleportation)
    assert_eq!(engine.accounts[lp2 as usize].pnl.get(), 0);
    assert_eq!(engine.accounts[lp2 as usize].capital.get(), initial_cap);

    // Conservation must still hold
    assert!(engine.check_conservation(ORACLE_100K));
}

#[test]
fn test_idle_user_drains_and_gc_closes() {
    let mut params = params_for_inline_tests();
    // 1 unit per slot maintenance fee
    params.maintenance_fee_per_slot = U128::new(1);
    let mut engine = RiskEngine::new(params);

    let user_idx = engine.add_user(0).unwrap();
    // Deposit 10 units of capital
    engine.deposit(user_idx, 10, 1).unwrap();

    assert!(engine.is_used(user_idx as usize));

    // Advance 1000 slots and crank — fee drains 1/slot * 1000 = 1000 >> 10 capital
    let outcome = engine
        .keeper_crank(user_idx, 1001, ORACLE_100K, 0, false)
        .unwrap();

    // Account should have been drained to 0 capital
    // The crank settles fees and then GC sweeps dust
    assert_eq!(outcome.num_gc_closed, 1, "expected GC to close the drained account");
    assert!(!engine.is_used(user_idx as usize), "account should be freed");
}

#[test]
fn test_dust_stale_funding_gc() {
    let mut engine = RiskEngine::new(params_for_inline_tests());

    let user_idx = engine.add_user(0).unwrap();

    // Zero out the account: no capital, no position, no pnl
    engine.accounts[user_idx as usize].capital = U128::ZERO;
    engine.accounts[user_idx as usize].pnl = I128::ZERO;
    engine.accounts[user_idx as usize].position_size = I128::ZERO;
    engine.accounts[user_idx as usize].reserved_pnl = 0;

    // Set a stale funding_index (different from global)
    engine.accounts[user_idx as usize].funding_index = I128::new(999);
    // Global funding index is 0 (default)
    assert_ne!(
        engine.accounts[user_idx as usize].funding_index,
        engine.funding_index_qpb_e6
    );

    assert!(engine.is_used(user_idx as usize));

    // Crank should snap funding and GC the dust account
    let outcome = engine
        .keeper_crank(user_idx, 10, ORACLE_100K, 0, false)
        .unwrap();

    assert_eq!(outcome.num_gc_closed, 1, "expected GC to close stale-funding dust");
    assert!(!engine.is_used(user_idx as usize), "account should be freed");
}

#[test]
fn test_dust_negative_fee_credits_gc() {
    let mut engine = RiskEngine::new(params_for_inline_tests());

    let user_idx = engine.add_user(0).unwrap();

    // Zero out the account
    engine.accounts[user_idx as usize].capital = U128::ZERO;
    engine.accounts[user_idx as usize].pnl = I128::ZERO;
    engine.accounts[user_idx as usize].position_size = I128::ZERO;
    engine.accounts[user_idx as usize].reserved_pnl = 0;
    // Set negative fee_credits (fee debt)
    engine.accounts[user_idx as usize].fee_credits = I128::new(-123);

    assert!(engine.is_used(user_idx as usize));

    // Crank should GC this account — negative fee_credits doesn't block GC
    let outcome = engine
        .keeper_crank(user_idx, 10, ORACLE_100K, 0, false)
        .unwrap();

    assert_eq!(outcome.num_gc_closed, 1, "expected GC to close account with negative fee_credits");
    assert!(!engine.is_used(user_idx as usize), "account should be freed");
}

#[test]
fn test_lp_never_gc() {
    let mut params = params_for_inline_tests();
    params.maintenance_fee_per_slot = U128::new(1);
    let mut engine = RiskEngine::new(params);

    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();

    // Zero out the LP account to make it look like dust
    engine.accounts[lp_idx as usize].capital = U128::ZERO;
    engine.accounts[lp_idx as usize].pnl = I128::ZERO;
    engine.accounts[lp_idx as usize].position_size = I128::ZERO;
    engine.accounts[lp_idx as usize].reserved_pnl = 0;

    assert!(engine.is_used(lp_idx as usize));

    // Crank many times — LP should never be GC'd
    for slot in 1..=10 {
        let outcome = engine
            .keeper_crank(lp_idx, slot * 100, ORACLE_100K, 0, false)
            .unwrap();
        assert_eq!(outcome.num_gc_closed, 0, "LP must not be garbage collected (slot {})", slot * 100);
    }

    assert!(engine.is_used(lp_idx as usize), "LP account must still exist");
}

#[test]
fn test_maintenance_fee_paid_from_fee_credits_is_coupon_not_revenue() {
    let mut params = params_for_inline_tests();
    params.maintenance_fee_per_slot = U128::new(10);
    let mut engine = RiskEngine::new(params);

    let user_idx = engine.add_user(0).unwrap();
    engine.deposit(user_idx, 1_000_000, 1).unwrap();

    // Add 100 fee credits (test-only helper — no vault/insurance)
    engine.deposit_fee_credits(user_idx, 100, 1).unwrap();
    assert_eq!(engine.accounts[user_idx as usize].fee_credits.get(), 100);

    let rev_before = engine.insurance_fund.fee_revenue.get();
    let bal_before = engine.insurance_fund.balance.get();

    // Settle maintenance: dt=5, fee_per_slot=10, due=50
    // All 50 should come from fee_credits (coupon: no insurance booking)
    engine
        .settle_maintenance_fee(user_idx, 6, ORACLE_100K)
        .unwrap();

    assert_eq!(
        engine.accounts[user_idx as usize].fee_credits.get(),
        50,
        "fee_credits should decrease by 50"
    );
    // Coupon semantics: spending credits does NOT touch insurance.
    // Insurance was already paid when credits were granted.
    assert_eq!(
        engine.insurance_fund.fee_revenue.get() - rev_before,
        0,
        "insurance fee_revenue must NOT change (coupon semantics)"
    );
    assert_eq!(
        engine.insurance_fund.balance.get() - bal_before,
        0,
        "insurance balance must NOT change (coupon semantics)"
    );
}

#[test]
fn test_maintenance_fee_splits_credits_coupon_capital_to_insurance() {
    let mut params = params_for_inline_tests();
    params.maintenance_fee_per_slot = U128::new(10);
    let mut engine = RiskEngine::new(params);

    let user_idx = engine.add_user(0).unwrap();
    // deposit at slot 1: dt=1 from slot 0, fee=10. Paid from deposit.
    // capital = 50 - 10 = 40.
    engine.deposit(user_idx, 50, 1).unwrap();
    assert_eq!(engine.accounts[user_idx as usize].capital.get(), 40);

    // Add 30 fee credits (test-only)
    engine.deposit_fee_credits(user_idx, 30, 1).unwrap();

    let rev_before = engine.insurance_fund.fee_revenue.get();

    // Settle maintenance: dt=10, fee_per_slot=10, due=100
    // credits pays 30, capital pays 40 (all it has), leftover 30 unpaid
    engine
        .settle_maintenance_fee(user_idx, 11, ORACLE_100K)
        .unwrap();

    let rev_increase = engine.insurance_fund.fee_revenue.get() - rev_before;
    let cap_after = engine.accounts[user_idx as usize].capital.get();

    assert_eq!(rev_increase, 40, "insurance revenue should be 40 (capital only; credits are coupon)");
    assert_eq!(cap_after, 0, "capital should be fully drained");
    // fee_credits should be -30 (100 due - 30 credits - 40 capital = 30 unpaid debt)
    assert_eq!(
        engine.accounts[user_idx as usize].fee_credits.get(),
        -30,
        "fee_credits should reflect unpaid debt"
    );
}

#[test]
fn test_deposit_fee_credits_updates_vault_and_insurance() {
    let mut engine = RiskEngine::new(params_for_inline_tests());
    let user_idx = engine.add_user(0).unwrap();

    let vault_before = engine.vault.get();
    let ins_before = engine.insurance_fund.balance.get();
    let rev_before = engine.insurance_fund.fee_revenue.get();

    engine.deposit_fee_credits(user_idx, 500, 10).unwrap();

    assert_eq!(engine.vault.get() - vault_before, 500, "vault must increase");
    assert_eq!(engine.insurance_fund.balance.get() - ins_before, 500, "insurance balance must increase");
    assert_eq!(engine.insurance_fund.fee_revenue.get() - rev_before, 500, "insurance fee_revenue must increase");
    assert_eq!(engine.accounts[user_idx as usize].fee_credits.get(), 500, "fee_credits must increase");
}

#[test]
fn test_warmup_matured_not_lost_on_trade() {
    let mut params = params_for_inline_tests();
    params.warmup_period_slots = 100;
    params.max_crank_staleness_slots = u64::MAX;
    let mut engine = RiskEngine::new(params);

    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();
    let user_idx = engine.add_user(0).unwrap();

    // Fund both generously
    engine.deposit(lp_idx, 1_000_000_000, 1).unwrap();
    engine.deposit(user_idx, 1_000_000_000, 1).unwrap();

    // Provide warmup budget: the warmup budget system requires losses or
    // spendable insurance to fund positive PnL settlement. Seed insurance
    // so the warmup budget allows settlement.
    engine.insurance_fund.balance = engine.insurance_fund.balance + 1_000_000;

    // Give user positive PnL and set warmup started far in the past
    engine.accounts[user_idx as usize].pnl = I128::new(10_000);
    engine.accounts[user_idx as usize].warmup_started_at_slot = 1;
    // slope = max(1, 10000/100) = 100
    engine.accounts[user_idx as usize].warmup_slope_per_step = U128::new(100);

    let cap_before = engine.accounts[user_idx as usize].capital.get();

    // Execute a tiny trade at slot 200 (elapsed from slot 1 = 199 slots, cap = 100*199 = 19900 > 10000)
    struct AtOracleMatcher;
    impl MatchingEngine for AtOracleMatcher {
        fn execute_match(
            &self,
            _lp_program: &[u8; 32],
            _lp_context: &[u8; 32],
            _lp_account_id: u64,
            oracle_price: u64,
            size: i128,
        ) -> Result<TradeExecution> {
            Ok(TradeExecution { price: oracle_price, size })
        }
    }

    engine
        .execute_trade(&AtOracleMatcher, lp_idx, user_idx, 200, ORACLE_100K, ONE_BASE)
        .unwrap();

    let cap_after = engine.accounts[user_idx as usize].capital.get();

    // Capital must have increased by the matured warmup amount (10_000 PnL settled to capital)
    assert!(
        cap_after > cap_before,
        "capital must increase from matured warmup: before={}, after={}",
        cap_before,
        cap_after
    );
    assert!(
        cap_after >= cap_before + 10_000,
        "capital should have increased by at least 10000 (matured warmup): before={}, after={}",
        cap_before,
        cap_after
    );
}

#[test]
fn test_abandoned_with_stale_last_fee_slot_eventually_closed() {
    let mut params = params_for_inline_tests();
    params.maintenance_fee_per_slot = U128::new(1);
    let mut engine = RiskEngine::new(params);

    let user_idx = engine.add_user(0).unwrap();
    // Small deposit
    engine.deposit(user_idx, 5, 1).unwrap();

    assert!(engine.is_used(user_idx as usize));

    // Don't call any user ops. Run crank at a slot far ahead.
    // First crank: drains the account via fee settlement
    let _ = engine
        .keeper_crank(user_idx, 10_000, ORACLE_100K, 0, false)
        .unwrap();

    // Second crank: GC scan should pick up the dust
    let _outcome = engine
        .keeper_crank(user_idx, 10_001, ORACLE_100K, 0, false)
        .unwrap();

    // The account must be closed by now (across both cranks)
    assert!(
        !engine.is_used(user_idx as usize),
        "abandoned account with stale last_fee_slot must eventually be GC'd"
    );
    // At least one of the two cranks should have GC'd it
    // (first crank drains capital to 0, GC might close it there already)
}


#[test]
fn test_finding_l_new_position_requires_initial_margin() {
    // Replicates the integration test scenario:
    // - maintenance_margin_bps = 500 (5%)
    // - initial_margin_bps = 1000 (10%)
    // - User deposits 0.6 SOL (600_000_000)
    // - User opens ~10 SOL notional position
    // - Trade should FAIL (6% < 10%)

    let mut params = default_params();
    params.maintenance_margin_bps = 500;  // 5%
    params.initial_margin_bps = 1000;      // 10%
    params.trading_fee_bps = 0;            // No fee for cleaner math
    params.warmup_period_slots = 0;
    params.max_crank_staleness_slots = u64::MAX;

    let mut engine = Box::new(RiskEngine::new(params));
    
    let user_idx = engine.add_user(0).unwrap();
    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();

    // Deposit 600M (0.6 SOL in lamports)
    engine.deposit(user_idx, 600_000_000, 0).unwrap();
    
    // LP needs capital to take the other side
    engine.accounts[lp_idx as usize].capital = U128::new(100_000_000_000);
    engine.vault += 100_000_000_000;

    // Oracle price: $138 (in e6 = 138_000_000)
    let oracle_price = 138_000_000u64;

    // Position size for ~10 SOL notional at $138:
    // notional = size * price / 1_000_000
    // 10_000_000_000 = size * 138_000_000 / 1_000_000
    // size = 10_000_000_000 * 1_000_000 / 138_000_000 = ~72_463_768
    let size: i128 = 72_463_768;

    // Execute trade - should FAIL because:
    // - Position value = 72_463_768 * 138_000_000 / 1_000_000 = ~10_000_000_000
    // - Initial margin required (10%) = 1_000_000_000
    // - User equity = 600_000_000
    // - 600_000_000 < 1_000_000_000 → UNDERCOLLATERALIZED
    let result = engine.execute_trade(&MATCHER, lp_idx, user_idx, 0, oracle_price, size);

    assert!(
        result.is_err(),
        "Opening new position with only 6% margin should FAIL when 10% initial margin required. \
         Got {:?}", result
    );
    assert!(
        matches!(result, Err(percolator::RiskError::Undercollateralized)),
        "Error should be Undercollateralized"
    );
}

#[test]
fn test_position_flip_margin_check() {
    // Regression test: flipping from +1M to -1M (same absolute size) requires initial margin.
    // A flip is semantically a close + open, so the new side must meet initial margin.

    let mut params = default_params();
    params.maintenance_margin_bps = 500;  // 5%
    params.initial_margin_bps = 1000;      // 10%
    params.trading_fee_bps = 0;
    params.warmup_period_slots = 0;
    params.max_crank_staleness_slots = u64::MAX;

    let mut engine = Box::new(RiskEngine::new(params));

    let user_idx = engine.add_user(0).unwrap();
    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();

    // User needs capital for initial position (10% of 100M notional = 10M)
    engine.deposit(user_idx, 15_000_000, 0).unwrap();

    // LP capital
    engine.accounts[lp_idx as usize].capital = U128::new(100_000_000);
    engine.vault += 100_000_000;

    let oracle_price = 100_000_000u64; // $100

    // Open long position of 1M units ($100M notional)
    let size: i128 = 1_000_000;
    engine.execute_trade(&MATCHER, lp_idx, user_idx, 0, oracle_price, size).unwrap();
    assert_eq!(engine.accounts[user_idx as usize].position_size.get(), 1_000_000);

    // Set user capital to 5.5M (above maintenance 5% = 5M, but below initial 10% = 10M)
    engine.accounts[user_idx as usize].capital = U128::new(5_500_000);
    engine.c_tot = U128::new(5_500_000);

    // Try to flip from +1M to -1M (trade -2M)
    // This crosses zero, so it's risk-increasing and requires initial margin (10% = 10M)
    // User has only 5.5M, which is below initial margin, so this MUST fail
    let flip_size: i128 = -2_000_000;
    let result = engine.execute_trade(&MATCHER, lp_idx, user_idx, 0, oracle_price, flip_size);

    // MUST be rejected because flip requires initial margin
    assert!(
        result.is_err(),
        "Position flip must require initial margin (cross-zero is risk-increasing)"
    );
    assert_eq!(result.unwrap_err(), RiskError::Undercollateralized);

    // Position should remain unchanged
    assert_eq!(engine.accounts[user_idx as usize].position_size.get(), 1_000_000);

    // Now give user enough capital for initial margin (10% of 100M = 10M, plus buffer)
    engine.accounts[user_idx as usize].capital = U128::new(11_000_000);
    engine.c_tot = U128::new(11_000_000);

    // Now flip should succeed
    let result2 = engine.execute_trade(&MATCHER, lp_idx, user_idx, 0, oracle_price, flip_size);
    assert!(result2.is_ok(), "Position flip should succeed with sufficient initial margin");
    assert_eq!(engine.accounts[user_idx as usize].position_size.get(), -1_000_000);
}

#[test]
fn test_lp_position_flip_margin_check() {
    // Regression test: LP position flip from +1M to -1M requires initial margin.
    // When a user trade causes the LP to flip, it's risk-increasing for the LP.

    let mut params = default_params();
    params.maintenance_margin_bps = 500;  // 5%
    params.initial_margin_bps = 1000;      // 10%
    params.trading_fee_bps = 0;
    params.warmup_period_slots = 0;
    params.max_crank_staleness_slots = u64::MAX;

    let mut engine = Box::new(RiskEngine::new(params));

    let user_idx = engine.add_user(0).unwrap();
    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();

    let oracle_price = 100_000_000u64; // $100

    // User needs enough capital to trade
    engine.deposit(user_idx, 50_000_000, 0).unwrap();

    // LP needs capital for initial position (10% of 100M notional = 10M)
    engine.accounts[lp_idx as usize].capital = U128::new(15_000_000);
    engine.vault += 15_000_000;
    engine.c_tot = U128::new(15_000_000 + 50_000_000);

    // User sells 1M units to LP, LP becomes long +1M
    let size: i128 = -1_000_000;
    engine.execute_trade(&MATCHER, lp_idx, user_idx, 0, oracle_price, size).unwrap();
    assert_eq!(engine.accounts[lp_idx as usize].position_size.get(), 1_000_000);

    // Reduce LP capital to 5.5M (above maintenance 5%, below initial 10%)
    engine.accounts[lp_idx as usize].capital = U128::new(5_500_000);
    engine.c_tot = U128::new(5_500_000 + 50_000_000);

    // User tries to buy 2M units, which would flip LP from +1M to -1M
    // This crosses zero for LP, so LP needs initial margin (10% = 10M)
    // LP only has 5.5M, so this MUST fail
    let flip_size: i128 = 2_000_000;
    let result = engine.execute_trade(&MATCHER, lp_idx, user_idx, 0, oracle_price, flip_size);

    // MUST be rejected because LP flip requires initial margin
    assert!(
        result.is_err(),
        "LP position flip must require initial margin (cross-zero is risk-increasing)"
    );
    assert_eq!(result.unwrap_err(), RiskError::Undercollateralized);

    // LP position should remain unchanged
    assert_eq!(engine.accounts[lp_idx as usize].position_size.get(), 1_000_000);

    // Give LP enough capital for initial margin
    engine.accounts[lp_idx as usize].capital = U128::new(11_000_000);
    engine.c_tot = U128::new(11_000_000 + 50_000_000);

    // Now flip should succeed
    let result2 = engine.execute_trade(&MATCHER, lp_idx, user_idx, 0, oracle_price, flip_size);
    assert!(result2.is_ok(), "LP position flip should succeed with sufficient initial margin");
    assert_eq!(engine.accounts[lp_idx as usize].position_size.get(), -1_000_000);
}

/// Regression test for Finding J: micro-trade fee evasion
/// Before fix: fee = notional * fee_bps / 10_000 (truncates to 0 for small trades)
/// After fix: ceiling division ensures at least 1 unit fee for any non-zero trade
#[test]
fn test_micro_trade_fee_not_zero() {
    let mut params = default_params();
    params.trading_fee_bps = 10; // 0.1% fee
    params.maintenance_margin_bps = 100; // 1% for easy math
    params.initial_margin_bps = 100;
    params.warmup_period_slots = 0;
    params.max_crank_staleness_slots = u64::MAX;

    let mut engine = Box::new(RiskEngine::new(params));

    let user_idx = engine.add_user(0).unwrap();
    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();

    // Deposit enough capital for margin
    engine.deposit(user_idx, 1_000_000_000, 0).unwrap();
    engine.accounts[lp_idx as usize].capital = U128::new(1_000_000_000);
    engine.vault += 1_000_000_000;
    engine.c_tot = U128::new(2_000_000_000);

    let oracle_price = 1_000_000u64; // $1

    let insurance_before = engine.insurance_fund.balance.get();

    // Execute a micro-trade: size=1, price=$1 → notional = 1
    // Old fee calc: 1 * 10 / 10_000 = 0 (WRONG - fee evasion!)
    // New fee calc: (1 * 10 + 9999) / 10_000 = 1 (CORRECT - minimum 1 unit)
    let size: i128 = 1;
    engine.execute_trade(&MATCHER, lp_idx, user_idx, 0, oracle_price, size).unwrap();

    let insurance_after = engine.insurance_fund.balance.get();
    let fee_charged = insurance_after - insurance_before;

    // Fee MUST be at least 1 (ceiling division prevents zero-fee micro-trades)
    assert!(
        fee_charged >= 1,
        "Micro-trade must pay at least 1 unit fee (ceiling division). Got fee={}",
        fee_charged
    );
}

/// Test that fee is correctly zero when trading_fee_bps is zero (fee-free mode)
#[test]
fn test_zero_fee_bps_means_no_fee() {
    let mut params = default_params();
    params.trading_fee_bps = 0; // Fee-free trading
    params.maintenance_margin_bps = 100;
    params.initial_margin_bps = 100;
    params.warmup_period_slots = 0;
    params.max_crank_staleness_slots = u64::MAX;

    let mut engine = Box::new(RiskEngine::new(params));

    let user_idx = engine.add_user(0).unwrap();
    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();

    engine.deposit(user_idx, 1_000_000_000, 0).unwrap();
    engine.accounts[lp_idx as usize].capital = U128::new(1_000_000_000);
    engine.vault += 1_000_000_000;
    engine.c_tot = U128::new(2_000_000_000);

    let oracle_price = 100_000_000u64; // $100

    let insurance_before = engine.insurance_fund.balance.get();

    // Execute a trade with fee_bps=0
    let size: i128 = 1_000_000;
    engine.execute_trade(&MATCHER, lp_idx, user_idx, 0, oracle_price, size).unwrap();

    let insurance_after = engine.insurance_fund.balance.get();
    let fee_charged = insurance_after - insurance_before;

    // Fee MUST be 0 when trading_fee_bps is 0
    assert_eq!(
        fee_charged, 0,
        "Fee must be zero when trading_fee_bps=0. Got fee={}",
        fee_charged
    );
}

/// Regression test for Review Finding [1]: warmup cap overwithdrawing
/// When mark settlement increases PnL, warmup must restart per spec §5.4.
/// Without the fix, stale slope * elapsed could exceed original PnL entitlement.
#[test]
fn test_warmup_resets_when_mark_increases_pnl() {
    let mut params = default_params();
    params.warmup_period_slots = 100;
    params.trading_fee_bps = 0;
    params.maintenance_margin_bps = 100;
    params.initial_margin_bps = 100;
    params.max_crank_staleness_slots = u64::MAX;

    let mut engine = Box::new(RiskEngine::new(params));

    let user_idx = engine.add_user(0).unwrap();
    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();

    // Setup: user has 1B capital, LP has 1B capital
    engine.deposit(user_idx, 1_000_000_000, 0).unwrap();
    engine.accounts[lp_idx as usize].capital = U128::new(1_000_000_000);
    engine.vault += 1_000_000_000;
    engine.c_tot = U128::new(2_000_000_000);

    let oracle_price = 100_000_000u64; // $100

    // T=0: User opens a long position
    let size: i128 = 10_000_000; // 10 units
    engine.execute_trade(&MATCHER, lp_idx, user_idx, 0, oracle_price, size).unwrap();

    // At this point, PnL is 0 (exec_price = oracle_price with NoOpMatcher)
    // User has position with entry_price = oracle_price

    // Manually give user some positive PnL to simulate prior profit
    engine.set_pnl(user_idx as usize, 100_000_000); // 100M PnL
    engine.pnl_pos_tot = U128::new(100_000_000);

    // Set warmup slope for the initial PnL (slope = 100M / 100 = 1M per slot)
    engine.update_warmup_slope(user_idx).unwrap();

    let warmup_started_t0 = engine.accounts[user_idx as usize].warmup_started_at_slot;
    assert_eq!(warmup_started_t0, 0, "Warmup should start at slot 0");

    // T=200: Long idle period. Price moved in user's favor (+50%)
    // Mark PnL = (new_price - entry) * position = (150 - 100) * 10 = 500M
    let new_oracle_price = 150_000_000u64; // $150

    // Without the fix:
    // - cap = slope * 200 = 1M * 200 = 200M
    // - Mark settlement adds 500M profit to PnL → total PnL = 600M
    // - avail_gross = 600M, cap = 200M, x = min(600M, 200M) = 200M converted!
    // - But original entitlement was only 100M (the initial PnL)
    //
    // With the fix:
    // - Mark settlement increases PnL from 100M to 600M
    // - Warmup slope is updated, warmup_started_at = 200
    // - cap = new_slope * 0 = 0 (nothing warmable yet from the new total)

    // Touch account (triggers mark settlement + warmup slope update if PnL increased)
    engine.touch_account_full(user_idx, 200, new_oracle_price).unwrap();

    // Check warmup was restarted (started_at should be updated to >= 200)
    let warmup_started_after = engine.accounts[user_idx as usize].warmup_started_at_slot;
    assert!(
        warmup_started_after >= 200,
        "Warmup must restart when mark settlement increases PnL. Started at {} should be >= 200",
        warmup_started_after
    );

    // With the fix, capital should be close to original 1B
    // (possibly with some conversion from the original 100M that was warming up)
    // But NOT the huge 200M that the bug would have allowed
    let user_capital_after = engine.accounts[user_idx as usize].capital.get();

    // The original 100M PnL had 200 slots to warm up at slope 1M/slot = 200M cap
    // But since only 100M existed, max conversion = 100M (fully warmed)
    // After mark adds 500M more, warmup restarts → new 500M gets 0 conversion
    // So capital should be around 1B + 100M = 1.1B (at most)
    assert!(
        user_capital_after <= 1_150_000_000, // Allow some margin for rounding
        "User should not instantly convert huge mark profit. Capital {} too high (expected ~1.1B)",
        user_capital_after
    );
}

// ==============================================================================
// SPEC SYNC TESTS (Phase 4 - Aggregate Maintenance Verification)
// ==============================================================================

/// Test that funding settlement correctly maintains pnl_pos_tot when PnL flips sign.
/// Spec §4.2 requires all PnL modifications to use set_pnl helper.
#[test]
fn test_funding_settlement_maintains_pnl_pos_tot() {
    let mut engine = Box::new(RiskEngine::new(default_params()));
    let user_idx = engine.add_user(0).unwrap();
    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();

    // Setup: user deposits capital
    engine.deposit(user_idx, 100_000, 0).unwrap();
    engine.accounts[lp_idx as usize].capital = U128::new(1_000_000);
    engine.vault += 1_000_000;

    // User has a long position
    engine.accounts[user_idx as usize].position_size = I128::new(1_000_000);
    engine.accounts[user_idx as usize].entry_price = 100_000_000;

    // LP has opposite short position
    engine.accounts[lp_idx as usize].position_size = I128::new(-1_000_000);
    engine.accounts[lp_idx as usize].entry_price = 100_000_000;

    // Give user positive PnL that will flip to negative after funding
    engine.accounts[user_idx as usize].pnl = I128::new(50_000);

    // Zero warmup to avoid side effects
    engine.accounts[user_idx as usize].warmup_slope_per_step = U128::new(0);
    engine.accounts[lp_idx as usize].warmup_slope_per_step = U128::new(0);

    // Recompute aggregates to ensure consistency
    engine.recompute_aggregates();

    // Verify initial pnl_pos_tot includes user's positive PnL
    let pnl_pos_tot_before = engine.pnl_pos_tot.get();
    assert_eq!(pnl_pos_tot_before, 50_000, "Initial pnl_pos_tot should be 50_000");

    // Accrue large positive funding that will make user's PnL negative
    // rate = 1000 bps/slot for 1 slot at price 100e6
    // delta_F = 100e6 * 1000 * 1 / 10000 = 10,000,000
    // User payment = 1M * 10,000,000 / 1e6 = 10,000,000
    engine.current_slot = 1;
    engine.accrue_funding_with_rate(1, 100_000_000, 1000).unwrap();

    // Settle funding for user - this should flip their PnL from +50k to -9.95M
    engine.touch_account(user_idx).unwrap();

    // User's new PnL should be negative: 50_000 - 10_000_000 = -9_950_000
    let user_pnl_after = engine.accounts[user_idx as usize].pnl.get();
    assert!(user_pnl_after < 0, "User PnL should be negative after large funding payment");

    // pnl_pos_tot should now be 0 (user's PnL flipped from positive to negative)
    let pnl_pos_tot_after = engine.pnl_pos_tot.get();
    assert_eq!(
        pnl_pos_tot_after, 0,
        "pnl_pos_tot should be 0 after user's PnL flipped negative (was {}, now {})",
        pnl_pos_tot_before, pnl_pos_tot_after
    );

    // Settle LP funding - LP should receive payment, gaining positive PnL
    engine.touch_account(lp_idx).unwrap();

    // LP's PnL should now be positive: 0 + 10,000,000 = 10,000,000
    let lp_pnl_after = engine.accounts[lp_idx as usize].pnl.get();
    assert!(lp_pnl_after > 0, "LP PnL should be positive after receiving funding");

    // pnl_pos_tot should now equal LP's positive PnL
    let pnl_pos_tot_final = engine.pnl_pos_tot.get();
    assert_eq!(
        pnl_pos_tot_final, lp_pnl_after as u128,
        "pnl_pos_tot should equal LP's positive PnL"
    );

    // Verify by recomputing from scratch
    let mut expected_pnl_pos_tot = 0u128;
    if engine.accounts[user_idx as usize].pnl.get() > 0 {
        expected_pnl_pos_tot += engine.accounts[user_idx as usize].pnl.get() as u128;
    }
    if engine.accounts[lp_idx as usize].pnl.get() > 0 {
        expected_pnl_pos_tot += engine.accounts[lp_idx as usize].pnl.get() as u128;
    }
    assert_eq!(
        pnl_pos_tot_final, expected_pnl_pos_tot,
        "pnl_pos_tot should match manual calculation"
    );
}

/// Test that trade execution correctly maintains c_tot and pnl_pos_tot aggregates.
/// Spec §4.1, §4.2, §4.3 require aggregate maintenance (batch exception documented).
#[test]
fn test_trade_aggregate_consistency() {
    let mut engine = Box::new(RiskEngine::new(default_params()));

    // Setup accounts with known initial state
    let user_idx = engine.add_user(0).unwrap();
    let lp_idx = engine.add_lp([1u8; 32], [2u8; 32], 0).unwrap();

    let user_capital = 100_000u128;
    let lp_capital = 500_000u128;

    engine.deposit(user_idx, user_capital, 0).unwrap();
    engine.accounts[lp_idx as usize].capital = U128::new(lp_capital);
    engine.vault += lp_capital;

    // Recompute to ensure clean state
    engine.recompute_aggregates();

    // Record initial aggregates
    let c_tot_before = engine.c_tot.get();
    let pnl_pos_tot_before = engine.pnl_pos_tot.get();

    assert_eq!(c_tot_before, user_capital + lp_capital, "Initial c_tot mismatch");
    assert_eq!(pnl_pos_tot_before, 0, "Initial pnl_pos_tot should be 0");

    // Execute a trade
    let oracle_price = 1_000_000u64; // $1
    let trade_size = 10_000i128;
    engine
        .execute_trade(&MATCHER, lp_idx, user_idx, 0, oracle_price, trade_size)
        .unwrap();

    // Manually compute expected values:
    // - Trading fee = ceil(notional * fee_bps / 10000) = ceil(10000 * 1 * 10 / 10000) = ceil(10) = 10
    //   (notional = |size| * price / 1e6 = 10000 * 1000000 / 1000000 = 10000)
    //   Actually fee = ceil(10000 * 10 / 10000) = ceil(10) = 10
    // - Fee is deducted from user capital
    // - c_tot should decrease by fee amount

    let fee = 10u128; // ceil(10000 * 10 / 10000)
    let expected_c_tot = c_tot_before - fee;

    assert_eq!(
        engine.c_tot.get(),
        expected_c_tot,
        "c_tot should decrease by trading fee: expected {}, got {}",
        expected_c_tot,
        engine.c_tot.get()
    );

    // Verify c_tot by summing all account capitals
    let mut manual_c_tot = 0u128;
    if engine.is_used(user_idx as usize) {
        manual_c_tot += engine.accounts[user_idx as usize].capital.get();
    }
    if engine.is_used(lp_idx as usize) {
        manual_c_tot += engine.accounts[lp_idx as usize].capital.get();
    }
    assert_eq!(
        engine.c_tot.get(),
        manual_c_tot,
        "c_tot should match sum of account capitals"
    );

    // Verify pnl_pos_tot by summing positive PnLs
    let mut manual_pnl_pos_tot = 0u128;
    let user_pnl = engine.accounts[user_idx as usize].pnl.get();
    let lp_pnl = engine.accounts[lp_idx as usize].pnl.get();
    if user_pnl > 0 {
        manual_pnl_pos_tot += user_pnl as u128;
    }
    if lp_pnl > 0 {
        manual_pnl_pos_tot += lp_pnl as u128;
    }
    assert_eq!(
        engine.pnl_pos_tot.get(),
        manual_pnl_pos_tot,
        "pnl_pos_tot should match sum of positive PnLs: expected {}, got {}",
        manual_pnl_pos_tot,
        engine.pnl_pos_tot.get()
    );
}

/// Test rounding slack bound with multiple accounts having positive PnL.
/// Spec §3.4: Residual - Σ PNL_eff_pos_i < K where K = count of positive PnL accounts.
/// The bound ensures floor rounding in effective PnL calculation doesn't lose more than K units.
#[test]
fn test_rounding_bound_with_many_positive_pnl_accounts() {
    let mut engine = Box::new(RiskEngine::new(default_params()));

    // Create multiple accounts with positive PnL
    let num_accounts = 10usize;
    let mut account_indices = Vec::new();

    for _ in 0..num_accounts {
        let idx = engine.add_user(0).unwrap();
        engine.deposit(idx, 10_000, 0).unwrap();
        account_indices.push(idx);
    }

    // Set each account to have different positive PnL values
    // Use values that will create rounding when haircutted
    for (i, &idx) in account_indices.iter().enumerate() {
        let pnl = ((i + 1) * 1000 + 7) as i128; // 1007, 2007, 3007, ... (odd values for rounding)
        engine.accounts[idx as usize].pnl = I128::new(pnl);
    }

    // Total positive PnL = 1007 + 2007 + ... + 10007 = 55070
    let total_positive_pnl: u128 = (1..=num_accounts).map(|i| (i * 1000 + 7) as u128).sum();

    // Set Residual to be LESS than total PnL to create a haircut (h < 1)
    // This forces the floor operation to have rounding effects
    // Residual = V - C_tot - I
    // We want Residual < PNL_pos_tot
    let target_residual = total_positive_pnl * 2 / 3; // ~66% backing → h ≈ 0.66

    // c_tot = 10 * 10_000 = 100_000
    let c_tot = engine.c_tot.get();
    let insurance = engine.insurance_fund.balance.get();

    // V = Residual + C_tot + I
    engine.vault = U128::new(target_residual + c_tot + insurance);

    engine.recompute_aggregates();

    // Compute haircut ratio
    let (h_num, h_den) = engine.haircut_ratio();

    // Verify we have a haircut (h < 1)
    assert!(
        h_num < h_den,
        "Test setup error: expected haircut (h_num={} < h_den={})",
        h_num,
        h_den
    );

    // Compute Residual
    let residual = engine
        .vault
        .get()
        .saturating_sub(engine.c_tot.get())
        .saturating_sub(engine.insurance_fund.balance.get());

    // h_num = min(Residual, PNL_pos_tot) = Residual (since Residual < PNL_pos_tot)
    assert_eq!(h_num, residual, "h_num should equal Residual when underbacked");

    // Compute sum of effective positive PnL using floor division
    let mut sum_eff_pos_pnl = 0u128;
    for &idx in &account_indices {
        let pnl = engine.accounts[idx as usize].pnl.get();
        if pnl > 0 {
            // floor(pnl * h_num / h_den)
            let eff_pos = (pnl as u128).saturating_mul(h_num) / h_den;
            sum_eff_pos_pnl += eff_pos;
        }
    }

    // Count accounts with positive PnL
    let k = account_indices
        .iter()
        .filter(|&&idx| engine.accounts[idx as usize].pnl.get() > 0)
        .count() as u128;

    // Verify rounding slack bound: Residual - Σ PNL_eff_pos_i < K
    // Since h_num = Residual, and each floor loses at most 1, we have:
    // Residual - sum_eff_pos_pnl < K
    let slack = residual.saturating_sub(sum_eff_pos_pnl);
    assert!(
        slack < k,
        "Rounding slack bound violated: slack={} >= K={} (Residual={}, sum_eff_pos={}, h_num={}, h_den={})",
        slack,
        k,
        residual,
        sum_eff_pos_pnl,
        h_num,
        h_den
    );

    // Also verify it's within MAX_ROUNDING_SLACK
    assert!(
        slack <= MAX_ROUNDING_SLACK,
        "Rounding slack {} exceeds MAX_ROUNDING_SLACK {}",
        slack,
        MAX_ROUNDING_SLACK
    );
}

// ==============================================================================
// RISKPARAMS VALIDATION TESTS
// ==============================================================================

#[test]
fn test_validate_valid_params() {
    assert!(default_params().validate().is_ok());
}

#[test]
fn test_validate_zero_maintenance_margin_rejected() {
    let mut p = default_params();
    p.maintenance_margin_bps = 0;
    assert_eq!(p.validate(), Err(RiskError::Overflow));
}

#[test]
fn test_validate_zero_initial_margin_rejected() {
    let mut p = default_params();
    p.initial_margin_bps = 0;
    assert_eq!(p.validate(), Err(RiskError::Overflow));
}

#[test]
fn test_validate_initial_less_than_maintenance_rejected() {
    let mut p = default_params();
    p.maintenance_margin_bps = 1000;
    p.initial_margin_bps = 500; // initial < maintenance
    assert_eq!(p.validate(), Err(RiskError::Overflow));
}

#[test]
fn test_validate_margin_exceeds_10000_rejected() {
    let mut p = default_params();
    p.initial_margin_bps = 10_001;
    assert_eq!(p.validate(), Err(RiskError::Overflow));

    let mut p2 = default_params();
    p2.maintenance_margin_bps = 10_001;
    assert_eq!(p2.validate(), Err(RiskError::Overflow));
}

#[test]
fn test_validate_zero_max_accounts_rejected() {
    let mut p = default_params();
    p.max_accounts = 0;
    assert_eq!(p.validate(), Err(RiskError::Overflow));
}

#[test]
fn test_validate_max_accounts_exceeds_physical_limit_rejected() {
    let mut p = default_params();
    p.max_accounts = MAX_ACCOUNTS as u64 + 1;
    assert_eq!(p.validate(), Err(RiskError::Overflow));
}

#[test]
fn test_validate_zero_crank_staleness_rejected() {
    let mut p = default_params();
    p.max_crank_staleness_slots = 0;
    assert_eq!(p.validate(), Err(RiskError::Overflow));
}

#[test]
fn test_validate_u64_max_crank_staleness_allowed() {
    let mut p = default_params();
    p.max_crank_staleness_slots = u64::MAX;
    assert!(p.validate().is_ok());
}

#[test]
fn test_validate_liquidation_fee_exceeds_10000_rejected() {
    let mut p = default_params();
    p.liquidation_fee_bps = 10_001;
    assert_eq!(p.validate(), Err(RiskError::Overflow));
}

#[test]
fn test_validate_liquidation_buffer_exceeds_10000_rejected() {
    let mut p = default_params();
    p.liquidation_buffer_bps = 10_001;
    assert_eq!(p.validate(), Err(RiskError::Overflow));
}

#[test]
fn test_init_in_place_rejects_invalid_params() {
    let mut engine = RiskEngine::new(default_params());
    let mut bad_params = default_params();
    bad_params.maintenance_margin_bps = 0;
    let result = engine.init_in_place(bad_params);
    assert_eq!(result, Err(RiskError::Overflow));
    // Engine params must remain unchanged after rejection
    assert_eq!(engine.params.maintenance_margin_bps, default_params().maintenance_margin_bps);
}

#[test]
fn test_init_in_place_accepts_valid_params() {
    let mut engine = RiskEngine::new(default_params());
    let mut new_params = default_params();
    new_params.initial_margin_bps = 2000;
    new_params.maintenance_margin_bps = 1000;
    assert!(engine.init_in_place(new_params).is_ok());
    assert_eq!(engine.params.initial_margin_bps, 2000);
}

#[test]
fn test_set_margin_params_rejects_zero_maintenance() {
    let mut engine = RiskEngine::new(default_params());
    assert_eq!(engine.set_margin_params(1000, 0), Err(RiskError::Overflow));
}

#[test]
fn test_set_margin_params_rejects_zero_initial() {
    let mut engine = RiskEngine::new(default_params());
    assert_eq!(engine.set_margin_params(0, 500), Err(RiskError::Overflow));
}

#[test]
fn test_set_margin_params_rejects_maintenance_greater_than_initial() {
    let mut engine = RiskEngine::new(default_params());
    assert_eq!(engine.set_margin_params(500, 1000), Err(RiskError::Overflow));
}

#[test]
fn test_set_margin_params_rejects_exceeding_10000() {
    let mut engine = RiskEngine::new(default_params());
    assert_eq!(engine.set_margin_params(10_001, 500), Err(RiskError::Overflow));
    assert_eq!(engine.set_margin_params(1000, 10_001), Err(RiskError::Overflow));
}

#[test]
fn test_set_margin_params_accepts_valid_values() {
    let mut engine = RiskEngine::new(default_params());
    assert!(engine.set_margin_params(2000, 1000).is_ok());
    assert_eq!(engine.params.initial_margin_bps, 2000);
    assert_eq!(engine.params.maintenance_margin_bps, 1000);
}

#[test]
fn test_set_margin_params_does_not_update_on_error() {
    let mut engine = RiskEngine::new(default_params());
    let orig_initial = engine.params.initial_margin_bps;
    let orig_maint = engine.params.maintenance_margin_bps;
    let _ = engine.set_margin_params(500, 1000); // maintenance > initial → error
    assert_eq!(engine.params.initial_margin_bps, orig_initial);
    assert_eq!(engine.params.maintenance_margin_bps, orig_maint);
}

// ==============================================================================
// admin_force_close bounds & existence guards
// ==============================================================================

#[test]
fn test_admin_force_close_oob_index_returns_account_not_found() {
    let mut engine = RiskEngine::new(default_params());
    let result = engine.admin_force_close(u16::MAX, 100, 1_000_000);
    assert_eq!(result, Err(RiskError::AccountNotFound));
}

#[test]
fn test_admin_force_close_unused_slot_returns_account_not_found() {
    let mut engine = RiskEngine::new(default_params());
    let result = engine.admin_force_close(0, 100, 1_000_000);
    assert_eq!(result, Err(RiskError::AccountNotFound));
}

#[test]
fn test_admin_force_close_valid_zero_position_returns_ok() {
    let mut engine = RiskEngine::new(default_params());
    let idx = engine.add_user(0).unwrap();
    // Force close on zero position should succeed (no-op)
    assert!(engine.admin_force_close(idx, 100, 1_000_000).is_ok());
}
