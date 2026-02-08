//! Kani formal verification harnesses for percolator-prog.
//!
//! Run with: `cargo kani --tests`
//!
//! These harnesses prove PROGRAM-LEVEL security properties:
//! - Matcher ABI validation rejects malformed/malicious returns
//! - Owner/signer enforcement for all account operations
//! - Admin authorization and burned admin handling
//! - CPI identity binding (matcher program/context match LP registration)
//! - Matcher account shape validation
//! - PDA key mismatch rejection
//! - Nonce monotonicity (unchanged on failure, +1 on success)
//! - CPI uses exec_size (not requested size)
//!
//! Note: CPI execution and risk engine internals are NOT modeled.
//! Only wrapper-level authorization and binding logic is proven.

#![cfg(kani)]

extern crate kani;

// Import real types and helpers from the program crate
use percolator_prog::matcher_abi::{
    MatcherReturn, validate_matcher_return, FLAG_VALID, FLAG_PARTIAL_OK, FLAG_REJECTED,
};
use percolator_prog::constants::MATCHER_ABI_VERSION;
use percolator_prog::verify::{
    owner_ok, admin_ok, matcher_identity_ok, matcher_shape_ok, MatcherAccountsShape,
    gate_active, nonce_on_success, nonce_on_failure, pda_key_matches, cpi_trade_size,
    // Account validation helpers
    signer_ok, writable_ok, len_ok,
    LpPdaShape, lp_pda_shape_ok, oracle_feed_id_ok,
    SlabShape, slab_shape_ok,
    // Decision helpers for program-level coupling proofs
    single_owner_authorized, trade_authorized,
    TradeCpiDecision, decide_trade_cpi, decision_nonce,
    TradeNoCpiDecision, decide_trade_nocpi,
    SimpleDecision, decide_single_owner_op, decide_crank, decide_admin_op,
    // ABI validation from real inputs
    MatcherReturnFields, abi_ok, decide_trade_cpi_from_ret,
    // New: allow_panic crank decision
    decide_keeper_crank_with_panic,
    // New: Oracle inversion math
    invert_price_e6, INVERSION_CONSTANT,
    // New: Oracle unit scale math
    scale_price_e6,
    // New: Unit scale conversion math
    base_to_units, units_to_base,
    // New: Withdraw alignment
    withdraw_amount_aligned,
    // New: Dust math
    accumulate_dust, sweep_dust,
    // New: InitMarket scale validation
    init_market_scale_ok,
};
use percolator_prog::constants::MAX_UNIT_SCALE;
use percolator_prog::oracle::clamp_toward_with_dt;

// Kani-specific bounds to avoid SAT explosion on division/modulo.
// MAX_UNIT_SCALE (1 billion) is too large for bit-precise SAT solving.
// Using small bounds keeps proofs tractable while still exercising the logic.
// The actual MAX_UNIT_SCALE bound is proven separately in init_market_scale_* proofs.
const KANI_MAX_SCALE: u32 = 64;
// Cap quotients to keep division/mod tractable
const KANI_MAX_QUOTIENT: u64 = 4096;

// =============================================================================
// Test Fixtures
// =============================================================================

/// Create a MatcherReturn from individual symbolic fields
fn any_matcher_return() -> MatcherReturn {
    MatcherReturn {
        abi_version: kani::any(),
        flags: kani::any(),
        exec_price_e6: kani::any(),
        exec_size: kani::any(),
        req_id: kani::any(),
        lp_account_id: kani::any(),
        oracle_price_e6: kani::any(),
        reserved: kani::any(),
    }
}

/// Create a MatcherReturnFields from individual symbolic fields
fn any_matcher_return_fields() -> MatcherReturnFields {
    MatcherReturnFields {
        abi_version: kani::any(),
        flags: kani::any(),
        exec_price_e6: kani::any(),
        exec_size: kani::any(),
        req_id: kani::any(),
        lp_account_id: kani::any(),
        oracle_price_e6: kani::any(),
        reserved: kani::any(),
    }
}

// =============================================================================
// A. MATCHER ABI VALIDATION (11 proofs - program-level, keep these)
// =============================================================================

/// Prove: wrong ABI version is always rejected
#[kani::proof]
fn kani_matcher_rejects_wrong_abi_version() {
    let mut ret = any_matcher_return();
    kani::assume(ret.abi_version != MATCHER_ABI_VERSION);

    let lp_account_id: u64 = kani::any();
    let oracle_price: u64 = kani::any();
    let req_size: i128 = kani::any();
    let req_id: u64 = kani::any();

    let result = validate_matcher_return(&ret, lp_account_id, oracle_price, req_size, req_id);
    assert!(result.is_err(), "wrong ABI version must be rejected");
}

/// Prove: missing VALID flag is always rejected
#[kani::proof]
fn kani_matcher_rejects_missing_valid_flag() {
    let mut ret = any_matcher_return();
    ret.abi_version = MATCHER_ABI_VERSION;
    kani::assume((ret.flags & FLAG_VALID) == 0);

    let lp_account_id: u64 = kani::any();
    let oracle_price: u64 = kani::any();
    let req_size: i128 = kani::any();
    let req_id: u64 = kani::any();

    let result = validate_matcher_return(&ret, lp_account_id, oracle_price, req_size, req_id);
    assert!(result.is_err(), "missing VALID flag must be rejected");
}

/// Prove: REJECTED flag always causes rejection
#[kani::proof]
fn kani_matcher_rejects_rejected_flag() {
    let mut ret = any_matcher_return();
    ret.abi_version = MATCHER_ABI_VERSION;
    ret.flags |= FLAG_VALID;
    ret.flags |= FLAG_REJECTED;

    let lp_account_id: u64 = kani::any();
    let oracle_price: u64 = kani::any();
    let req_size: i128 = kani::any();
    let req_id: u64 = kani::any();

    let result = validate_matcher_return(&ret, lp_account_id, oracle_price, req_size, req_id);
    assert!(result.is_err(), "REJECTED flag must cause rejection");
}

/// Prove: wrong req_id is always rejected
#[kani::proof]
fn kani_matcher_rejects_wrong_req_id() {
    let mut ret = any_matcher_return();
    ret.abi_version = MATCHER_ABI_VERSION;
    ret.flags = FLAG_VALID;
    ret.reserved = 0;
    kani::assume(ret.exec_price_e6 != 0);

    let lp_account_id: u64 = ret.lp_account_id;
    let oracle_price: u64 = ret.oracle_price_e6;
    let req_size: i128 = kani::any();
    kani::assume(req_size != 0);
    kani::assume(ret.exec_size != 0);
    kani::assume(ret.exec_size.signum() == req_size.signum());
    kani::assume(ret.exec_size.unsigned_abs() <= req_size.unsigned_abs());

    let req_id: u64 = kani::any();
    kani::assume(ret.req_id != req_id);

    let result = validate_matcher_return(&ret, lp_account_id, oracle_price, req_size, req_id);
    assert!(result.is_err(), "wrong req_id must be rejected");
}

/// Prove: wrong lp_account_id is always rejected
#[kani::proof]
fn kani_matcher_rejects_wrong_lp_account_id() {
    let mut ret = any_matcher_return();
    ret.abi_version = MATCHER_ABI_VERSION;
    ret.flags = FLAG_VALID;
    ret.reserved = 0;
    kani::assume(ret.exec_price_e6 != 0);

    let lp_account_id: u64 = kani::any();
    kani::assume(ret.lp_account_id != lp_account_id);

    let oracle_price: u64 = ret.oracle_price_e6;
    let req_size: i128 = kani::any();
    let req_id: u64 = ret.req_id;

    let result = validate_matcher_return(&ret, lp_account_id, oracle_price, req_size, req_id);
    assert!(result.is_err(), "wrong lp_account_id must be rejected");
}

/// Prove: wrong oracle_price is always rejected
#[kani::proof]
fn kani_matcher_rejects_wrong_oracle_price() {
    let mut ret = any_matcher_return();
    ret.abi_version = MATCHER_ABI_VERSION;
    ret.flags = FLAG_VALID;
    ret.reserved = 0;
    kani::assume(ret.exec_price_e6 != 0);

    let lp_account_id: u64 = ret.lp_account_id;
    let oracle_price: u64 = kani::any();
    kani::assume(ret.oracle_price_e6 != oracle_price);

    let req_size: i128 = kani::any();
    let req_id: u64 = ret.req_id;

    let result = validate_matcher_return(&ret, lp_account_id, oracle_price, req_size, req_id);
    assert!(result.is_err(), "wrong oracle_price must be rejected");
}

/// Prove: non-zero reserved field is always rejected
#[kani::proof]
fn kani_matcher_rejects_nonzero_reserved() {
    let mut ret = any_matcher_return();
    ret.abi_version = MATCHER_ABI_VERSION;
    ret.flags = FLAG_VALID;
    kani::assume(ret.exec_price_e6 != 0);
    kani::assume(ret.reserved != 0);

    let lp_account_id: u64 = ret.lp_account_id;
    let oracle_price: u64 = ret.oracle_price_e6;
    let req_size: i128 = kani::any();
    let req_id: u64 = ret.req_id;

    let result = validate_matcher_return(&ret, lp_account_id, oracle_price, req_size, req_id);
    assert!(result.is_err(), "non-zero reserved must be rejected");
}

/// Prove: zero exec_price is always rejected
#[kani::proof]
fn kani_matcher_rejects_zero_exec_price() {
    let mut ret = any_matcher_return();
    ret.abi_version = MATCHER_ABI_VERSION;
    ret.flags = FLAG_VALID;
    ret.reserved = 0;
    ret.exec_price_e6 = 0;

    let lp_account_id: u64 = ret.lp_account_id;
    let oracle_price: u64 = ret.oracle_price_e6;
    let req_size: i128 = kani::any();
    let req_id: u64 = ret.req_id;

    let result = validate_matcher_return(&ret, lp_account_id, oracle_price, req_size, req_id);
    assert!(result.is_err(), "zero exec_price must be rejected");
}

/// Prove: zero exec_size without PARTIAL_OK is rejected
#[kani::proof]
fn kani_matcher_zero_size_requires_partial_ok() {
    let mut ret = any_matcher_return();
    ret.abi_version = MATCHER_ABI_VERSION;
    ret.flags = FLAG_VALID; // No PARTIAL_OK
    ret.reserved = 0;
    kani::assume(ret.exec_price_e6 != 0);
    ret.exec_size = 0;

    let lp_account_id: u64 = ret.lp_account_id;
    let oracle_price: u64 = ret.oracle_price_e6;
    let req_size: i128 = kani::any();
    let req_id: u64 = ret.req_id;

    let result = validate_matcher_return(&ret, lp_account_id, oracle_price, req_size, req_id);
    assert!(result.is_err(), "zero exec_size without PARTIAL_OK must be rejected");
}

/// Prove: exec_size exceeding req_size is rejected
#[kani::proof]
fn kani_matcher_rejects_exec_size_exceeds_req() {
    let mut ret = any_matcher_return();
    ret.abi_version = MATCHER_ABI_VERSION;
    ret.flags = FLAG_VALID;
    ret.reserved = 0;
    kani::assume(ret.exec_price_e6 != 0);
    kani::assume(ret.exec_size != 0);

    let lp_account_id: u64 = ret.lp_account_id;
    let oracle_price: u64 = ret.oracle_price_e6;
    let req_id: u64 = ret.req_id;

    let req_size: i128 = kani::any();
    kani::assume(ret.exec_size.unsigned_abs() > req_size.unsigned_abs());

    let result = validate_matcher_return(&ret, lp_account_id, oracle_price, req_size, req_id);
    assert!(result.is_err(), "exec_size exceeding req_size must be rejected");
}

/// Prove: sign mismatch between exec_size and req_size is rejected
#[kani::proof]
fn kani_matcher_rejects_sign_mismatch() {
    let mut ret = any_matcher_return();
    ret.abi_version = MATCHER_ABI_VERSION;
    ret.flags = FLAG_VALID;
    ret.reserved = 0;
    kani::assume(ret.exec_price_e6 != 0);
    kani::assume(ret.exec_size != 0);

    let lp_account_id: u64 = ret.lp_account_id;
    let oracle_price: u64 = ret.oracle_price_e6;
    let req_id: u64 = ret.req_id;

    let req_size: i128 = kani::any();
    kani::assume(req_size != 0);
    kani::assume(ret.exec_size.signum() != req_size.signum());
    kani::assume(ret.exec_size.unsigned_abs() <= req_size.unsigned_abs());

    let result = validate_matcher_return(&ret, lp_account_id, oracle_price, req_size, req_id);
    assert!(result.is_err(), "sign mismatch must be rejected");
}

// =============================================================================
// B. OWNER/SIGNER ENFORCEMENT (2 proofs)
// =============================================================================

/// Prove: owner mismatch is rejected
#[kani::proof]
fn kani_owner_mismatch_rejected() {
    let stored: [u8; 32] = kani::any();
    let signer: [u8; 32] = kani::any();
    kani::assume(stored != signer);

    assert!(
        !owner_ok(stored, signer),
        "owner mismatch must be rejected"
    );
}

/// Prove: owner match is accepted
#[kani::proof]
fn kani_owner_match_accepted() {
    let owner: [u8; 32] = kani::any();

    assert!(
        owner_ok(owner, owner),
        "owner match must be accepted"
    );
}

// =============================================================================
// C. ADMIN AUTHORIZATION (3 proofs)
// =============================================================================

/// Prove: admin mismatch is rejected
#[kani::proof]
fn kani_admin_mismatch_rejected() {
    let admin: [u8; 32] = kani::any();
    let signer: [u8; 32] = kani::any();
    kani::assume(admin != [0u8; 32]); // Not burned
    kani::assume(admin != signer);

    assert!(
        !admin_ok(admin, signer),
        "admin mismatch must be rejected"
    );
}

/// Prove: admin match is accepted (when not burned)
#[kani::proof]
fn kani_admin_match_accepted() {
    let admin: [u8; 32] = kani::any();
    kani::assume(admin != [0u8; 32]); // Not burned

    assert!(
        admin_ok(admin, admin),
        "admin match must be accepted"
    );
}

/// Prove: burned admin (all zeros) disables all admin ops
#[kani::proof]
fn kani_admin_burned_disables_ops() {
    let burned_admin = [0u8; 32];
    let signer: [u8; 32] = kani::any();

    assert!(
        !admin_ok(burned_admin, signer),
        "burned admin must disable all admin ops"
    );
}

// =============================================================================
// D. CPI IDENTITY BINDING (2 proofs) - CRITICAL
// =============================================================================

/// Prove: CPI matcher identity mismatch (program or context) is rejected
#[kani::proof]
fn kani_matcher_identity_mismatch_rejected() {
    let lp_prog: [u8; 32] = kani::any();
    let lp_ctx: [u8; 32] = kani::any();
    let provided_prog: [u8; 32] = kani::any();
    let provided_ctx: [u8; 32] = kani::any();

    // At least one must mismatch
    kani::assume(lp_prog != provided_prog || lp_ctx != provided_ctx);

    assert!(
        !matcher_identity_ok(lp_prog, lp_ctx, provided_prog, provided_ctx),
        "matcher identity mismatch must be rejected"
    );
}

/// Prove: CPI matcher identity match is accepted
#[kani::proof]
fn kani_matcher_identity_match_accepted() {
    let prog: [u8; 32] = kani::any();
    let ctx: [u8; 32] = kani::any();

    assert!(
        matcher_identity_ok(prog, ctx, prog, ctx),
        "matcher identity match must be accepted"
    );
}

// =============================================================================
// E. MATCHER ACCOUNT SHAPE VALIDATION (5 proofs)
// =============================================================================

/// Prove: non-executable matcher program is rejected
#[kani::proof]
fn kani_matcher_shape_rejects_non_executable_prog() {
    let shape = MatcherAccountsShape {
        prog_executable: false, // BAD
        ctx_executable: false,
        ctx_owner_is_prog: true,
        ctx_len_ok: true,
    };

    assert!(
        !matcher_shape_ok(shape),
        "non-executable matcher program must be rejected"
    );
}

/// Prove: executable matcher context is rejected
#[kani::proof]
fn kani_matcher_shape_rejects_executable_ctx() {
    let shape = MatcherAccountsShape {
        prog_executable: true,
        ctx_executable: true, // BAD
        ctx_owner_is_prog: true,
        ctx_len_ok: true,
    };

    assert!(
        !matcher_shape_ok(shape),
        "executable matcher context must be rejected"
    );
}

/// Prove: context not owned by program is rejected
#[kani::proof]
fn kani_matcher_shape_rejects_wrong_ctx_owner() {
    let shape = MatcherAccountsShape {
        prog_executable: true,
        ctx_executable: false,
        ctx_owner_is_prog: false, // BAD
        ctx_len_ok: true,
    };

    assert!(
        !matcher_shape_ok(shape),
        "context not owned by program must be rejected"
    );
}

/// Prove: insufficient context length is rejected
#[kani::proof]
fn kani_matcher_shape_rejects_short_ctx() {
    let shape = MatcherAccountsShape {
        prog_executable: true,
        ctx_executable: false,
        ctx_owner_is_prog: true,
        ctx_len_ok: false, // BAD
    };

    assert!(
        !matcher_shape_ok(shape),
        "insufficient context length must be rejected"
    );
}

/// Prove: valid matcher shape is accepted
#[kani::proof]
fn kani_matcher_shape_valid_accepted() {
    let shape = MatcherAccountsShape {
        prog_executable: true,
        ctx_executable: false,
        ctx_owner_is_prog: true,
        ctx_len_ok: true,
    };

    assert!(
        matcher_shape_ok(shape),
        "valid matcher shape must be accepted"
    );
}

// =============================================================================
// F. PDA KEY MATCHING (2 proofs)
// =============================================================================

/// Prove: PDA key mismatch is rejected
#[kani::proof]
fn kani_pda_mismatch_rejected() {
    let expected: [u8; 32] = kani::any();
    let provided: [u8; 32] = kani::any();
    kani::assume(expected != provided);

    assert!(
        !pda_key_matches(expected, provided),
        "PDA key mismatch must be rejected"
    );
}

/// Prove: PDA key match is accepted
#[kani::proof]
fn kani_pda_match_accepted() {
    let key: [u8; 32] = kani::any();

    assert!(
        pda_key_matches(key, key),
        "PDA key match must be accepted"
    );
}

// =============================================================================
// G. NONCE MONOTONICITY (3 proofs)
// =============================================================================

/// Prove: nonce unchanged on failure
#[kani::proof]
fn kani_nonce_unchanged_on_failure() {
    let old_nonce: u64 = kani::any();
    let new_nonce = nonce_on_failure(old_nonce);

    assert_eq!(
        new_nonce, old_nonce,
        "nonce must be unchanged on failure"
    );
}

/// Prove: nonce advances by exactly 1 on success
#[kani::proof]
fn kani_nonce_advances_on_success() {
    let old_nonce: u64 = kani::any();
    let new_nonce = nonce_on_success(old_nonce);

    assert_eq!(
        new_nonce,
        old_nonce.wrapping_add(1),
        "nonce must advance by 1 on success"
    );
}

/// Prove: nonce wraps correctly at u64::MAX
#[kani::proof]
fn kani_nonce_wraps_at_max() {
    let old_nonce = u64::MAX;
    let new_nonce = nonce_on_success(old_nonce);

    assert_eq!(
        new_nonce, 0,
        "nonce must wrap to 0 at u64::MAX"
    );
}

// =============================================================================
// H. CPI USES EXEC_SIZE (1 proof) - CRITICAL
// =============================================================================

/// Prove: CPI path uses exec_size from matcher, not requested size
#[kani::proof]
fn kani_cpi_uses_exec_size() {
    let exec_size: i128 = kani::any();
    let requested_size: i128 = kani::any();

    // Even when they differ, cpi_trade_size returns exec_size
    let chosen = cpi_trade_size(exec_size, requested_size);

    assert_eq!(
        chosen, exec_size,
        "CPI must use exec_size, not requested size"
    );
}

// =============================================================================
// I. GATE ACTIVATION LOGIC (3 proofs)
// =============================================================================

/// Prove: gate not active when threshold is zero
#[kani::proof]
fn kani_gate_inactive_when_threshold_zero() {
    let balance: u128 = kani::any();

    assert!(
        !gate_active(0, balance),
        "gate must be inactive when threshold is zero"
    );
}

/// Prove: gate not active when balance exceeds threshold
#[kani::proof]
fn kani_gate_inactive_when_balance_exceeds() {
    let threshold: u128 = kani::any();
    let balance: u128 = kani::any();
    kani::assume(balance > threshold);

    assert!(
        !gate_active(threshold, balance),
        "gate must be inactive when balance > threshold"
    );
}

/// Prove: gate active when threshold > 0 and balance <= threshold
#[kani::proof]
fn kani_gate_active_when_conditions_met() {
    let threshold: u128 = kani::any();
    kani::assume(threshold > 0);
    let balance: u128 = kani::any();
    kani::assume(balance <= threshold);

    assert!(
        gate_active(threshold, balance),
        "gate must be active when threshold > 0 and balance <= threshold"
    );
}

// =============================================================================
// J. PER-INSTRUCTION AUTHORIZATION (4 proofs)
// =============================================================================

/// Prove: single-owner instruction rejects on mismatch
#[kani::proof]
fn kani_single_owner_mismatch_rejected() {
    let stored: [u8; 32] = kani::any();
    let signer: [u8; 32] = kani::any();
    kani::assume(stored != signer);

    assert!(
        !single_owner_authorized(stored, signer),
        "single-owner instruction must reject on mismatch"
    );
}

/// Prove: single-owner instruction accepts on match
#[kani::proof]
fn kani_single_owner_match_accepted() {
    let owner: [u8; 32] = kani::any();

    assert!(
        single_owner_authorized(owner, owner),
        "single-owner instruction must accept on match"
    );
}

/// Prove: trade rejects when user owner mismatch
#[kani::proof]
fn kani_trade_rejects_user_mismatch() {
    let user_owner: [u8; 32] = kani::any();
    let user_signer: [u8; 32] = kani::any();
    let lp_owner: [u8; 32] = kani::any();
    kani::assume(user_owner != user_signer);

    assert!(
        !trade_authorized(user_owner, user_signer, lp_owner, lp_owner),
        "trade must reject when user owner doesn't match"
    );
}

/// Prove: trade rejects when LP owner mismatch
#[kani::proof]
fn kani_trade_rejects_lp_mismatch() {
    let user_owner: [u8; 32] = kani::any();
    let lp_owner: [u8; 32] = kani::any();
    let lp_signer: [u8; 32] = kani::any();
    kani::assume(lp_owner != lp_signer);

    assert!(
        !trade_authorized(user_owner, user_owner, lp_owner, lp_signer),
        "trade must reject when LP owner doesn't match"
    );
}

// =============================================================================
// L. TRADECPI DECISION COUPLING (12 proofs) - CRITICAL
// These prove program-level policies, not just helper semantics
// =============================================================================

/// Helper: create a valid shape for testing other conditions
fn valid_shape() -> MatcherAccountsShape {
    MatcherAccountsShape {
        prog_executable: true,
        ctx_executable: false,
        ctx_owner_is_prog: true,
        ctx_len_ok: true,
    }
}

/// Prove: TradeCpi rejects on bad matcher shape (non-executable prog)
#[kani::proof]
fn kani_tradecpi_rejects_non_executable_prog() {
    let old_nonce: u64 = kani::any();
    let shape = MatcherAccountsShape {
        prog_executable: false, // BAD
        ctx_executable: false,
        ctx_owner_is_prog: true,
        ctx_len_ok: true,
    };
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, shape, true, true, true, true, true, false, false, exec_size
    );

    assert_eq!(decision, TradeCpiDecision::Reject,
        "TradeCpi must reject non-executable matcher program");
}

/// Prove: TradeCpi rejects on bad matcher shape (executable ctx)
#[kani::proof]
fn kani_tradecpi_rejects_executable_ctx() {
    let old_nonce: u64 = kani::any();
    let shape = MatcherAccountsShape {
        prog_executable: true,
        ctx_executable: true, // BAD
        ctx_owner_is_prog: true,
        ctx_len_ok: true,
    };
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, shape, true, true, true, true, true, false, false, exec_size
    );

    assert_eq!(decision, TradeCpiDecision::Reject,
        "TradeCpi must reject executable matcher context");
}

/// Prove: TradeCpi rejects on PDA mismatch (even if everything else valid)
#[kani::proof]
fn kani_tradecpi_rejects_pda_mismatch() {
    let old_nonce: u64 = kani::any();
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, valid_shape(),
        true,  // identity_ok
        false, // pda_ok - BAD
        true,  // abi_ok
        true,  // user_auth_ok
        true,  // lp_auth_ok
        false, // gate_active
        false, // risk_increase
        exec_size
    );

    assert_eq!(decision, TradeCpiDecision::Reject,
        "TradeCpi must reject PDA mismatch");
}

/// Prove: TradeCpi rejects on user auth failure
#[kani::proof]
fn kani_tradecpi_rejects_user_auth_failure() {
    let old_nonce: u64 = kani::any();
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, valid_shape(),
        true,  // identity_ok
        true,  // pda_ok
        true,  // abi_ok
        false, // user_auth_ok - BAD
        true,  // lp_auth_ok
        false, // gate_active
        false, // risk_increase
        exec_size
    );

    assert_eq!(decision, TradeCpiDecision::Reject,
        "TradeCpi must reject user auth failure");
}

/// Prove: TradeCpi rejects on LP auth failure
#[kani::proof]
fn kani_tradecpi_rejects_lp_auth_failure() {
    let old_nonce: u64 = kani::any();
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, valid_shape(),
        true,  // identity_ok
        true,  // pda_ok
        true,  // abi_ok
        true,  // user_auth_ok
        false, // lp_auth_ok - BAD
        false, // gate_active
        false, // risk_increase
        exec_size
    );

    assert_eq!(decision, TradeCpiDecision::Reject,
        "TradeCpi must reject LP auth failure");
}

/// Prove: TradeCpi rejects on identity mismatch (even if ABI valid)
#[kani::proof]
fn kani_tradecpi_rejects_identity_mismatch() {
    let old_nonce: u64 = kani::any();
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, valid_shape(),
        false, // identity_ok - BAD
        true,  // pda_ok
        true,  // abi_ok (strong adversary: valid ABI but wrong identity)
        true,  // user_auth_ok
        true,  // lp_auth_ok
        false, // gate_active
        false, // risk_increase
        exec_size
    );

    assert_eq!(decision, TradeCpiDecision::Reject,
        "TradeCpi must reject identity mismatch even if ABI valid");
}

/// Prove: TradeCpi rejects on ABI validation failure
#[kani::proof]
fn kani_tradecpi_rejects_abi_failure() {
    let old_nonce: u64 = kani::any();
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, valid_shape(),
        true,  // identity_ok
        true,  // pda_ok
        false, // abi_ok - BAD
        true,  // user_auth_ok
        true,  // lp_auth_ok
        false, // gate_active
        false, // risk_increase
        exec_size
    );

    assert_eq!(decision, TradeCpiDecision::Reject,
        "TradeCpi must reject ABI validation failure");
}

/// Prove: TradeCpi rejects on gate active + risk increase
#[kani::proof]
fn kani_tradecpi_rejects_gate_risk_increase() {
    let old_nonce: u64 = kani::any();
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, valid_shape(),
        true,  // identity_ok
        true,  // pda_ok
        true,  // abi_ok
        true,  // user_auth_ok
        true,  // lp_auth_ok
        true,  // gate_active - ACTIVE
        true,  // risk_increase - INCREASING
        exec_size
    );

    assert_eq!(decision, TradeCpiDecision::Reject,
        "TradeCpi must reject when gate active and risk increasing");
}

/// Prove: TradeCpi allows risk-reducing trade when gate active
#[kani::proof]
fn kani_tradecpi_allows_gate_risk_decrease() {
    let old_nonce: u64 = kani::any();
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, valid_shape(),
        true,  // identity_ok
        true,  // pda_ok
        true,  // abi_ok
        true,  // user_auth_ok
        true,  // lp_auth_ok
        true,  // gate_active
        false, // risk_increase - NOT increasing (reducing or neutral)
        exec_size
    );

    assert!(matches!(decision, TradeCpiDecision::Accept { .. }),
        "TradeCpi must allow risk-reducing trade when gate active");
}

/// Prove: TradeCpi reject leaves nonce unchanged
#[kani::proof]
fn kani_tradecpi_reject_nonce_unchanged() {
    let old_nonce: u64 = kani::any();
    let exec_size: i128 = kani::any();

    // Force a rejection (bad shape)
    let bad_shape = MatcherAccountsShape {
        prog_executable: false,
        ctx_executable: false,
        ctx_owner_is_prog: true,
        ctx_len_ok: true,
    };

    let decision = decide_trade_cpi(
        old_nonce, bad_shape, true, true, true, true, true, false, false, exec_size
    );

    let result_nonce = decision_nonce(old_nonce, decision);

    assert_eq!(result_nonce, old_nonce,
        "TradeCpi reject must leave nonce unchanged");
}

/// Prove: TradeCpi accept increments nonce
#[kani::proof]
fn kani_tradecpi_accept_increments_nonce() {
    let old_nonce: u64 = kani::any();
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, valid_shape(),
        true, true, true, true, true, false, false, exec_size
    );

    assert!(matches!(decision, TradeCpiDecision::Accept { .. }),
        "should accept with all valid inputs");

    let result_nonce = decision_nonce(old_nonce, decision);

    assert_eq!(result_nonce, old_nonce.wrapping_add(1),
        "TradeCpi accept must increment nonce by 1");
}

/// Prove: TradeCpi accept uses exec_size
#[kani::proof]
fn kani_tradecpi_accept_uses_exec_size() {
    let old_nonce: u64 = kani::any();
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, valid_shape(),
        true, true, true, true, true, false, false, exec_size
    );

    if let TradeCpiDecision::Accept { chosen_size, .. } = decision {
        assert_eq!(chosen_size, exec_size,
            "TradeCpi accept must use exec_size");
    } else {
        panic!("expected Accept");
    }
}

// =============================================================================
// M. TRADENOCPI DECISION COUPLING (4 proofs)
// =============================================================================

/// Prove: TradeNoCpi rejects on user auth failure
#[kani::proof]
fn kani_tradenocpi_rejects_user_auth_failure() {
    let decision = decide_trade_nocpi(false, true, false, false);
    assert_eq!(decision, TradeNoCpiDecision::Reject,
        "TradeNoCpi must reject user auth failure");
}

/// Prove: TradeNoCpi rejects on LP auth failure
#[kani::proof]
fn kani_tradenocpi_rejects_lp_auth_failure() {
    let decision = decide_trade_nocpi(true, false, false, false);
    assert_eq!(decision, TradeNoCpiDecision::Reject,
        "TradeNoCpi must reject LP auth failure");
}

/// Prove: TradeNoCpi rejects on gate active + risk increase
#[kani::proof]
fn kani_tradenocpi_rejects_gate_risk_increase() {
    let decision = decide_trade_nocpi(true, true, true, true);
    assert_eq!(decision, TradeNoCpiDecision::Reject,
        "TradeNoCpi must reject when gate active and risk increasing");
}

/// Prove: TradeNoCpi accepts when all checks pass
#[kani::proof]
fn kani_tradenocpi_accepts_valid() {
    let decision = decide_trade_nocpi(true, true, false, false);
    assert_eq!(decision, TradeNoCpiDecision::Accept,
        "TradeNoCpi must accept when all checks pass");
}

// =============================================================================
// N. ZERO SIZE WITH PARTIAL_OK (1 proof)
// =============================================================================

/// Prove: zero exec_size with PARTIAL_OK flag is accepted
#[kani::proof]
fn kani_matcher_zero_size_with_partial_ok_accepted() {
    let mut ret = any_matcher_return();
    ret.abi_version = MATCHER_ABI_VERSION;
    ret.flags = FLAG_VALID | FLAG_PARTIAL_OK;
    ret.reserved = 0;
    kani::assume(ret.exec_price_e6 != 0);
    ret.exec_size = 0;

    let lp_account_id: u64 = ret.lp_account_id;
    let oracle_price: u64 = ret.oracle_price_e6;
    // When exec_size == 0, validate_matcher_return returns early before abs() checks
    // so req_size can be any value including i128::MIN
    let req_size: i128 = kani::any();
    let req_id: u64 = ret.req_id;

    let result = validate_matcher_return(&ret, lp_account_id, oracle_price, req_size, req_id);
    assert!(result.is_ok(), "zero exec_size with PARTIAL_OK must be accepted");
}

// =============================================================================
// O. MISSING SHAPE COUPLING PROOFS (2 proofs)
// =============================================================================

/// Prove: TradeCpi rejects on bad matcher shape (ctx owner mismatch)
#[kani::proof]
fn kani_tradecpi_rejects_ctx_owner_mismatch() {
    let old_nonce: u64 = kani::any();
    let shape = MatcherAccountsShape {
        prog_executable: true,
        ctx_executable: false,
        ctx_owner_is_prog: false, // BAD - context not owned by program
        ctx_len_ok: true,
    };
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, shape, true, true, true, true, true, false, false, exec_size
    );

    assert_eq!(decision, TradeCpiDecision::Reject,
        "TradeCpi must reject when context not owned by matcher program");
}

/// Prove: TradeCpi rejects on bad matcher shape (ctx too short)
#[kani::proof]
fn kani_tradecpi_rejects_ctx_len_short() {
    let old_nonce: u64 = kani::any();
    let shape = MatcherAccountsShape {
        prog_executable: true,
        ctx_executable: false,
        ctx_owner_is_prog: true,
        ctx_len_ok: false, // BAD - context length insufficient
    };
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, shape, true, true, true, true, true, false, false, exec_size
    );

    assert_eq!(decision, TradeCpiDecision::Reject,
        "TradeCpi must reject when context length insufficient");
}

// =============================================================================
// P. UNIVERSAL REJECT => NONCE UNCHANGED (1 proof)
// This subsumes all specific "reject => nonce unchanged" proofs
// =============================================================================

/// Prove: ANY TradeCpi rejection leaves nonce unchanged (universal quantification)
#[kani::proof]
fn kani_tradecpi_any_reject_nonce_unchanged() {
    let old_nonce: u64 = kani::any();

    // Build shape from symbolic bools (MatcherAccountsShape doesn't impl kani::Arbitrary)
    let shape = MatcherAccountsShape {
        prog_executable: kani::any(),
        ctx_executable: kani::any(),
        ctx_owner_is_prog: kani::any(),
        ctx_len_ok: kani::any(),
    };

    let identity_ok: bool = kani::any();
    let pda_ok: bool = kani::any();
    let abi_ok: bool = kani::any();
    let user_auth_ok: bool = kani::any();
    let lp_auth_ok: bool = kani::any();
    let gate_active: bool = kani::any();
    let risk_increase: bool = kani::any();
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, shape, identity_ok, pda_ok, abi_ok,
        user_auth_ok, lp_auth_ok, gate_active, risk_increase, exec_size
    );

    // Only consider rejection cases
    kani::assume(matches!(decision, TradeCpiDecision::Reject));

    // For ANY rejection, nonce must be unchanged
    let result_nonce = decision_nonce(old_nonce, decision);
    assert_eq!(result_nonce, old_nonce,
        "ANY TradeCpi rejection must leave nonce unchanged");
}

/// Prove: ANY TradeCpi acceptance increments nonce (universal quantification)
#[kani::proof]
fn kani_tradecpi_any_accept_increments_nonce() {
    let old_nonce: u64 = kani::any();

    // Build shape from symbolic bools
    let shape = MatcherAccountsShape {
        prog_executable: kani::any(),
        ctx_executable: kani::any(),
        ctx_owner_is_prog: kani::any(),
        ctx_len_ok: kani::any(),
    };

    let identity_ok: bool = kani::any();
    let pda_ok: bool = kani::any();
    let abi_ok: bool = kani::any();
    let user_auth_ok: bool = kani::any();
    let lp_auth_ok: bool = kani::any();
    let gate_active: bool = kani::any();
    let risk_increase: bool = kani::any();
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, shape, identity_ok, pda_ok, abi_ok,
        user_auth_ok, lp_auth_ok, gate_active, risk_increase, exec_size
    );

    // Only consider acceptance cases
    kani::assume(matches!(decision, TradeCpiDecision::Accept { .. }));

    // For ANY acceptance, nonce must increment by 1
    let result_nonce = decision_nonce(old_nonce, decision);
    assert_eq!(result_nonce, old_nonce.wrapping_add(1),
        "ANY TradeCpi acceptance must increment nonce by 1");
}

// =============================================================================
// Q. ACCOUNT VALIDATION HELPERS (2 proofs)
// =============================================================================
// Note: signer_ok and writable_ok are identity functions (return input unchanged).
// Testing them would be trivial (proving true==true). Only len_ok has real logic.

/// Prove: len_ok requires actual >= need (universal)
#[kani::proof]
fn kani_len_ok_universal() {
    let actual: usize = kani::any();
    let need: usize = kani::any();

    // Universal proof: len_ok returns true iff actual >= need
    assert_eq!(len_ok(actual, need), actual >= need,
        "len_ok must return (actual >= need)");
}

// =============================================================================
// R. LP PDA SHAPE VALIDATION (4 proofs)
// =============================================================================

/// Prove: valid LP PDA shape is accepted
#[kani::proof]
fn kani_lp_pda_shape_valid() {
    let shape = LpPdaShape {
        is_system_owned: true,
        data_len_zero: true,
        lamports_zero: true,
    };
    assert!(lp_pda_shape_ok(shape), "valid LP PDA shape must be accepted");
}

/// Prove: non-system-owned LP PDA is rejected
#[kani::proof]
fn kani_lp_pda_rejects_wrong_owner() {
    let shape = LpPdaShape {
        is_system_owned: false,
        data_len_zero: true,
        lamports_zero: true,
    };
    assert!(!lp_pda_shape_ok(shape), "non-system-owned LP PDA must be rejected");
}

/// Prove: LP PDA with data is rejected
#[kani::proof]
fn kani_lp_pda_rejects_has_data() {
    let shape = LpPdaShape {
        is_system_owned: true,
        data_len_zero: false,
        lamports_zero: true,
    };
    assert!(!lp_pda_shape_ok(shape), "LP PDA with data must be rejected");
}

/// Prove: funded LP PDA is rejected
#[kani::proof]
fn kani_lp_pda_rejects_funded() {
    let shape = LpPdaShape {
        is_system_owned: true,
        data_len_zero: true,
        lamports_zero: false,
    };
    assert!(!lp_pda_shape_ok(shape), "funded LP PDA must be rejected");
}

// =============================================================================
// S. ORACLE FEED_ID AND SLAB SHAPE (4 proofs)
// =============================================================================

/// Prove: oracle_feed_id_ok accepts matching feed_ids
#[kani::proof]
fn kani_oracle_feed_id_match() {
    let feed_id: [u8; 32] = kani::any();
    assert!(oracle_feed_id_ok(feed_id, feed_id), "matching oracle feed_ids must be accepted");
}

/// Prove: oracle_feed_id_ok rejects mismatched feed_ids
#[kani::proof]
fn kani_oracle_feed_id_mismatch() {
    let expected: [u8; 32] = kani::any();
    let provided: [u8; 32] = kani::any();
    kani::assume(expected != provided);
    assert!(!oracle_feed_id_ok(expected, provided), "mismatched oracle feed_ids must be rejected");
}

/// Prove: valid slab shape is accepted
#[kani::proof]
fn kani_slab_shape_valid() {
    let shape = SlabShape {
        owned_by_program: true,
        correct_len: true,
    };
    assert!(slab_shape_ok(shape), "valid slab shape must be accepted");
}

/// Prove: invalid slab shape is rejected
#[kani::proof]
fn kani_slab_shape_invalid() {
    let owned: bool = kani::any();
    let correct_len: bool = kani::any();
    kani::assume(!owned || !correct_len);
    let shape = SlabShape {
        owned_by_program: owned,
        correct_len: correct_len,
    };
    assert!(!slab_shape_ok(shape), "invalid slab shape must be rejected");
}

// =============================================================================
// T. SIMPLE DECISION FUNCTIONS (6 proofs)
// =============================================================================

/// Prove: decide_single_owner_op accepts when auth ok
#[kani::proof]
fn kani_decide_single_owner_accepts() {
    let decision = decide_single_owner_op(true);
    assert_eq!(decision, SimpleDecision::Accept,
        "decide_single_owner_op must accept when auth ok");
}

/// Prove: decide_single_owner_op rejects when auth fails
#[kani::proof]
fn kani_decide_single_owner_rejects() {
    let decision = decide_single_owner_op(false);
    assert_eq!(decision, SimpleDecision::Reject,
        "decide_single_owner_op must reject when auth fails");
}

/// Prove: decide_crank accepts in permissionless mode
#[kani::proof]
fn kani_decide_crank_permissionless_accepts() {
    let idx_exists: bool = kani::any();
    let stored: [u8; 32] = kani::any();
    let signer: [u8; 32] = kani::any();
    // Permissionless mode always accepts regardless of idx/owner
    let decision = decide_crank(true, idx_exists, stored, signer);
    assert_eq!(decision, SimpleDecision::Accept, "permissionless crank must always accept");
}

/// Prove: decide_crank accepts self-crank when idx exists and owner matches
#[kani::proof]
fn kani_decide_crank_self_accepts() {
    let owner: [u8; 32] = kani::any();
    // Self-crank mode with valid idx and matching owner
    let decision = decide_crank(false, true, owner, owner);
    assert_eq!(decision, SimpleDecision::Accept, "self-crank must accept when idx exists and owner matches");
}

/// Prove: decide_crank rejects self-crank when idx doesn't exist
#[kani::proof]
fn kani_decide_crank_rejects_no_idx() {
    let stored: [u8; 32] = kani::any();
    let signer: [u8; 32] = kani::any();
    // Self-crank mode with non-existent idx must reject
    let decision = decide_crank(false, false, stored, signer);
    assert_eq!(decision, SimpleDecision::Reject,
        "self-crank must reject when idx doesn't exist");
}

/// Prove: decide_crank rejects self-crank when owner doesn't match
#[kani::proof]
fn kani_decide_crank_rejects_wrong_owner() {
    let stored: [u8; 32] = kani::any();
    let signer: [u8; 32] = kani::any();
    kani::assume(stored != signer);
    // Self-crank mode with existing idx but wrong owner must reject
    let decision = decide_crank(false, true, stored, signer);
    assert_eq!(decision, SimpleDecision::Reject,
        "self-crank must reject when owner doesn't match");
}

/// Prove: decide_admin_op accepts valid admin
#[kani::proof]
fn kani_decide_admin_accepts() {
    let admin: [u8; 32] = kani::any();
    kani::assume(admin != [0u8; 32]);

    let decision = decide_admin_op(admin, admin);
    assert_eq!(decision, SimpleDecision::Accept,
        "admin op must accept matching non-burned admin");
}

/// Prove: decide_admin_op rejects invalid admin
#[kani::proof]
fn kani_decide_admin_rejects() {
    // Case 1: burned admin
    let signer: [u8; 32] = kani::any();
    let decision1 = decide_admin_op([0u8; 32], signer);
    assert_eq!(decision1, SimpleDecision::Reject, "burned admin must reject");

    // Case 2: admin mismatch
    let admin: [u8; 32] = kani::any();
    kani::assume(admin != [0u8; 32]);
    kani::assume(admin != signer);
    let decision2 = decide_admin_op(admin, signer);
    assert_eq!(decision2, SimpleDecision::Reject, "admin mismatch must reject");
}

// =============================================================================
// U. VERIFY::ABI_OK EQUIVALENCE (1 proof)
// Prove that verify::abi_ok is equivalent to validate_matcher_return
// =============================================================================

/// Prove: verify::abi_ok returns true iff validate_matcher_return returns Ok
/// This is a single strong equivalence proof - abi_ok calls the real validator.
#[kani::proof]
fn kani_abi_ok_equals_validate() {
    let ret = any_matcher_return();
    let lp_account_id: u64 = kani::any();
    let oracle_price: u64 = kani::any();
    let req_size: i128 = kani::any();
    let req_id: u64 = kani::any();

    let validate_result = validate_matcher_return(&ret, lp_account_id, oracle_price, req_size, req_id);

    let ret_fields = MatcherReturnFields {
        abi_version: ret.abi_version,
        flags: ret.flags,
        exec_price_e6: ret.exec_price_e6,
        exec_size: ret.exec_size,
        req_id: ret.req_id,
        lp_account_id: ret.lp_account_id,
        oracle_price_e6: ret.oracle_price_e6,
        reserved: ret.reserved,
    };
    let abi_ok_result = abi_ok(ret_fields, lp_account_id, oracle_price, req_size, req_id);

    // Strong equivalence: abi_ok == validate.is_ok() for all inputs
    assert_eq!(abi_ok_result, validate_result.is_ok(),
        "abi_ok must be equivalent to validate_matcher_return.is_ok()");
}

// =============================================================================
// V. DECIDE_TRADE_CPI_FROM_RET UNIVERSAL PROOFS (3 proofs)
// These prove program-level policies using the mechanically-tied decision function
// =============================================================================

/// Prove: ANY rejection from decide_trade_cpi_from_ret leaves nonce unchanged
#[kani::proof]
fn kani_tradecpi_from_ret_any_reject_nonce_unchanged() {
    let old_nonce: u64 = kani::any();
    let shape = MatcherAccountsShape {
        prog_executable: kani::any(),
        ctx_executable: kani::any(),
        ctx_owner_is_prog: kani::any(),
        ctx_len_ok: kani::any(),
    };
    let identity_ok: bool = kani::any();
    let pda_ok: bool = kani::any();
    let user_auth_ok: bool = kani::any();
    let lp_auth_ok: bool = kani::any();
    let gate_is_active: bool = kani::any();
    let risk_increase: bool = kani::any();
    let ret = any_matcher_return_fields();
    let lp_account_id: u64 = kani::any();
    let oracle_price_e6: u64 = kani::any();
    let req_size: i128 = kani::any();

    let decision = decide_trade_cpi_from_ret(
        old_nonce, shape, identity_ok, pda_ok,
        user_auth_ok, lp_auth_ok, gate_is_active, risk_increase,
        ret, lp_account_id, oracle_price_e6, req_size
    );

    // Only consider rejection cases
    kani::assume(matches!(decision, TradeCpiDecision::Reject));

    // For ANY rejection, nonce must be unchanged
    let result_nonce = decision_nonce(old_nonce, decision);
    assert_eq!(result_nonce, old_nonce,
        "ANY TradeCpi rejection (from real inputs) must leave nonce unchanged");
}

/// Prove: ANY acceptance from decide_trade_cpi_from_ret increments nonce
#[kani::proof]
fn kani_tradecpi_from_ret_any_accept_increments_nonce() {
    let old_nonce: u64 = kani::any();
    let shape = MatcherAccountsShape {
        prog_executable: kani::any(),
        ctx_executable: kani::any(),
        ctx_owner_is_prog: kani::any(),
        ctx_len_ok: kani::any(),
    };
    let identity_ok: bool = kani::any();
    let pda_ok: bool = kani::any();
    let user_auth_ok: bool = kani::any();
    let lp_auth_ok: bool = kani::any();
    let gate_is_active: bool = kani::any();
    let risk_increase: bool = kani::any();
    let ret = any_matcher_return_fields();
    let lp_account_id: u64 = kani::any();
    let oracle_price_e6: u64 = kani::any();
    let req_size: i128 = kani::any();

    let decision = decide_trade_cpi_from_ret(
        old_nonce, shape, identity_ok, pda_ok,
        user_auth_ok, lp_auth_ok, gate_is_active, risk_increase,
        ret, lp_account_id, oracle_price_e6, req_size
    );

    // Only consider acceptance cases
    kani::assume(matches!(decision, TradeCpiDecision::Accept { .. }));

    // For ANY acceptance, nonce must increment by 1
    let result_nonce = decision_nonce(old_nonce, decision);
    assert_eq!(result_nonce, old_nonce.wrapping_add(1),
        "ANY TradeCpi acceptance (from real inputs) must increment nonce by 1");
}

/// Prove: ANY acceptance uses exec_size from ret, not req_size
/// NON-VACUOUS: Forces Accept path by constraining inputs to valid state
#[kani::proof]
fn kani_tradecpi_from_ret_accept_uses_exec_size() {
    let old_nonce: u64 = kani::any();
    // Force valid matcher shape
    let shape = MatcherAccountsShape {
        prog_executable: true,
        ctx_executable: false,
        ctx_owner_is_prog: true,
        ctx_len_ok: true,
    };
    // Force all authorization checks to pass
    let identity_ok: bool = true;
    let pda_ok: bool = true;
    let user_auth_ok: bool = true;
    let lp_auth_ok: bool = true;
    let gate_is_active: bool = false;  // Gate inactive = no risk check
    let risk_increase: bool = kani::any();  // Doesn't matter when gate inactive

    // Force valid matcher return
    let exec_size: i128 = kani::any();
    let req_size: i128 = kani::any();
    kani::assume(exec_size != 0);
    kani::assume(req_size != 0);
    // exec_size must have same sign as req_size and |exec_size| <= |req_size|
    kani::assume((exec_size > 0) == (req_size > 0));
    kani::assume(exec_size.unsigned_abs() <= req_size.unsigned_abs());

    let lp_account_id: u64 = kani::any();
    let oracle_price_e6: u64 = kani::any();
    kani::assume(oracle_price_e6 > 0);

    // req_id must match nonce_on_success(old_nonce) for ABI validation
    let expected_req_id = nonce_on_success(old_nonce);

    let ret = MatcherReturnFields {
        abi_version: MATCHER_ABI_VERSION,
        flags: FLAG_VALID,
        exec_price_e6: kani::any::<u64>().max(1),  // Non-zero price
        exec_size,
        req_id: expected_req_id,  // Must match nonce_on_success(old_nonce)
        lp_account_id,  // Must match
        oracle_price_e6,  // Must match
        reserved: 0,
    };

    let decision = decide_trade_cpi_from_ret(
        old_nonce, shape, identity_ok, pda_ok,
        user_auth_ok, lp_auth_ok, gate_is_active, risk_increase,
        ret, lp_account_id, oracle_price_e6, req_size
    );

    // MUST be Accept with these inputs - panic if not (catches regression)
    match decision {
        TradeCpiDecision::Accept { chosen_size, .. } => {
            assert_eq!(chosen_size, ret.exec_size,
                "TradeCpi accept must use exec_size from matcher return, not req_size");
        }
        TradeCpiDecision::Reject => {
            panic!("Expected Accept with valid inputs - function may have regressed to always-reject");
        }
    }
}

// =============================================================================
// W. REJECT => NO CHOSEN_SIZE
// =============================================================================
// Note: Removed trivial proof. The Reject variant having no fields is a
// compile-time structural guarantee enforced by Rust's type system.
// A Kani proof asserting `true` on enum match adds no verification value.

// =============================================================================
// X. i128::MIN BOUNDARY REGRESSION (1 proof)
// =============================================================================

/// Regression proof: i128::MIN boundary case is correctly rejected
/// This proves that exec_size=i128::MIN, req_size=i128::MIN+1 is rejected
/// because |i128::MIN| = 2^127 > |i128::MIN+1| = 2^127-1
/// The old .abs() implementation would panic; .unsigned_abs() handles this correctly.
#[kani::proof]
fn kani_min_abs_boundary_rejected() {
    let ret = MatcherReturn {
        abi_version: MATCHER_ABI_VERSION,
        flags: FLAG_VALID,
        exec_price_e6: 1_000_000, // non-zero price
        exec_size: i128::MIN,     // -2^127
        req_id: 42,
        lp_account_id: 100,
        oracle_price_e6: 50_000_000,
        reserved: 0,
    };

    let req_size = i128::MIN + 1; // -2^127 + 1, so |req_size| = 2^127 - 1

    // |exec_size| = 2^127, |req_size| = 2^127 - 1
    // Since |exec_size| > |req_size|, this must be rejected
    let result = validate_matcher_return(
        &ret,
        ret.lp_account_id,
        ret.oracle_price_e6,
        req_size,
        ret.req_id,
    );

    assert!(result.is_err(),
        "i128::MIN exec_size with req_size=i128::MIN+1 must be rejected (|exec| > |req|)");
}

// =============================================================================
// Y. ACCEPTANCE PROOFS - Valid inputs MUST be accepted
// =============================================================================

/// Prove: minimal valid non-zero exec_size is accepted
#[kani::proof]
fn kani_matcher_accepts_minimal_valid_nonzero_exec() {
    let mut ret = any_matcher_return();
    // Constrain to valid inputs
    ret.abi_version = MATCHER_ABI_VERSION;
    ret.flags = FLAG_VALID;
    ret.reserved = 0;
    kani::assume(ret.exec_price_e6 != 0);
    kani::assume(ret.exec_size != 0);

    // Use ret's own fields for expected values (no mismatch)
    let lp_account_id: u64 = ret.lp_account_id;
    let oracle_price: u64 = ret.oracle_price_e6;
    let req_id: u64 = ret.req_id;

    // req_size must be >= exec_size in magnitude, same sign
    let req_size: i128 = kani::any();
    kani::assume(req_size.signum() == ret.exec_size.signum());
    kani::assume(req_size.unsigned_abs() >= ret.exec_size.unsigned_abs());

    let result = validate_matcher_return(&ret, lp_account_id, oracle_price, req_size, req_id);
    assert!(result.is_ok(), "valid inputs must be accepted");
}

/// Prove: exec_size == req_size (same sign) is accepted
#[kani::proof]
fn kani_matcher_accepts_exec_size_equal_req_size() {
    let mut ret = any_matcher_return();
    ret.abi_version = MATCHER_ABI_VERSION;
    ret.flags = FLAG_VALID;
    ret.reserved = 0;
    kani::assume(ret.exec_price_e6 != 0);
    kani::assume(ret.exec_size != 0);

    // exec_size == req_size
    let req_size: i128 = ret.exec_size;
    let lp_account_id: u64 = ret.lp_account_id;
    let oracle_price: u64 = ret.oracle_price_e6;
    let req_id: u64 = ret.req_id;

    let result = validate_matcher_return(&ret, lp_account_id, oracle_price, req_size, req_id);
    assert!(result.is_ok(), "exec_size == req_size must be accepted");
}

/// Prove: partial fill with PARTIAL_OK is accepted
#[kani::proof]
fn kani_matcher_accepts_partial_fill_with_flag() {
    let mut ret = any_matcher_return();
    ret.abi_version = MATCHER_ABI_VERSION;
    ret.flags = FLAG_VALID | FLAG_PARTIAL_OK;
    ret.reserved = 0;
    kani::assume(ret.exec_price_e6 != 0);
    kani::assume(ret.exec_size != 0);

    let lp_account_id: u64 = ret.lp_account_id;
    let oracle_price: u64 = ret.oracle_price_e6;
    let req_id: u64 = ret.req_id;

    // req_size >= exec_size, same sign (partial fill)
    let req_size: i128 = kani::any();
    kani::assume(req_size.signum() == ret.exec_size.signum());
    kani::assume(req_size.unsigned_abs() >= ret.exec_size.unsigned_abs());

    let result = validate_matcher_return(&ret, lp_account_id, oracle_price, req_size, req_id);
    assert!(result.is_ok(), "partial fill with PARTIAL_OK must be accepted");
}

// =============================================================================
// Z. KEEPER CRANK WITH ALLOW_PANIC PROOFS (6 proofs)
// =============================================================================

/// Prove: allow_panic requires admin auth - rejects non-admin
#[kani::proof]
fn kani_crank_panic_requires_admin() {
    let admin: [u8; 32] = kani::any();
    let signer: [u8; 32] = kani::any();
    kani::assume(admin != [0u8; 32]); // Not burned
    kani::assume(admin != signer);     // Signer is NOT admin

    let stored_owner: [u8; 32] = kani::any();
    let permissionless: bool = kani::any();
    let idx_exists: bool = kani::any();

    // allow_panic != 0 but signer != admin => reject
    let decision = decide_keeper_crank_with_panic(
        1, // allow_panic != 0
        admin, signer, permissionless, idx_exists, stored_owner
    );

    assert_eq!(decision, SimpleDecision::Reject,
        "allow_panic without admin auth must reject");
}

/// Prove: allow_panic with valid admin auth proceeds to crank logic
#[kani::proof]
fn kani_crank_panic_with_admin_permissionless_accepts() {
    let admin: [u8; 32] = kani::any();
    kani::assume(admin != [0u8; 32]); // Not burned

    let stored_owner: [u8; 32] = kani::any();
    let idx_exists: bool = kani::any();

    // allow_panic != 0, signer == admin, permissionless mode
    let decision = decide_keeper_crank_with_panic(
        1, // allow_panic != 0
        admin, admin, // signer == admin
        true, // permissionless
        idx_exists, stored_owner
    );

    assert_eq!(decision, SimpleDecision::Accept,
        "allow_panic with admin + permissionless must accept");
}

/// Prove: allow_panic with burned admin always rejects
#[kani::proof]
fn kani_crank_panic_burned_admin_rejects() {
    let signer: [u8; 32] = kani::any();
    let stored_owner: [u8; 32] = kani::any();
    let permissionless: bool = kani::any();
    let idx_exists: bool = kani::any();

    // allow_panic != 0, admin is burned
    let decision = decide_keeper_crank_with_panic(
        1, // allow_panic != 0
        [0u8; 32], // burned admin
        signer, permissionless, idx_exists, stored_owner
    );

    assert_eq!(decision, SimpleDecision::Reject,
        "allow_panic with burned admin must reject");
}

/// Prove: without allow_panic, permissionless crank accepts without admin
#[kani::proof]
fn kani_crank_no_panic_permissionless_accepts() {
    let admin: [u8; 32] = kani::any();
    let signer: [u8; 32] = kani::any();
    let stored_owner: [u8; 32] = kani::any();
    let idx_exists: bool = kani::any();

    // allow_panic == 0, permissionless mode - accepts regardless of admin
    let decision = decide_keeper_crank_with_panic(
        0, // allow_panic == 0
        admin, signer, true, idx_exists, stored_owner
    );

    assert_eq!(decision, SimpleDecision::Accept,
        "no allow_panic + permissionless must accept");
}

/// Prove: without allow_panic, self-crank needs idx + owner match
#[kani::proof]
fn kani_crank_no_panic_self_crank_rejects_wrong_owner() {
    let admin: [u8; 32] = kani::any();
    let stored_owner: [u8; 32] = kani::any();
    let signer: [u8; 32] = kani::any();
    kani::assume(stored_owner != signer);

    // allow_panic == 0, self-crank mode, idx exists, but owner mismatch
    let decision = decide_keeper_crank_with_panic(
        0, // allow_panic == 0
        admin, signer,
        false, // self-crank
        true,  // idx exists
        stored_owner
    );

    assert_eq!(decision, SimpleDecision::Reject,
        "self-crank with owner mismatch must reject");
}

/// Prove: without allow_panic, self-crank with owner match accepts
#[kani::proof]
fn kani_crank_no_panic_self_crank_accepts_owner_match() {
    let admin: [u8; 32] = kani::any();
    let owner: [u8; 32] = kani::any();

    // allow_panic == 0, self-crank mode, idx exists, owner matches
    let decision = decide_keeper_crank_with_panic(
        0, // allow_panic == 0
        admin, owner, // signer == owner
        false, // self-crank
        true,  // idx exists
        owner  // stored_owner == signer
    );

    assert_eq!(decision, SimpleDecision::Accept,
        "self-crank with owner match must accept");
}

// =============================================================================
// AA. ORACLE INVERSION MATH PROOFS (5 proofs)
// =============================================================================

/// Prove: invert==0 returns raw unchanged (for any raw including 0)
/// Note: invert==0 is "no inversion" - raw passes through unchanged
#[kani::proof]
fn kani_invert_zero_returns_raw() {
    let raw: u64 = kani::any();
    let result = invert_price_e6(raw, 0);
    assert_eq!(result, Some(raw), "invert==0 must return raw unchanged");
}

/// Prove: invert!=0 with valid raw returns correct floor(1e12/raw)
/// NON-VACUOUS: forces success path by constraining raw to valid range
#[kani::proof]
fn kani_invert_nonzero_computes_correctly() {
    let raw: u64 = kani::any();
    // Constrain to valid range where inversion must succeed, capped for SAT solver
    kani::assume(raw > 0);
    kani::assume(raw <= KANI_MAX_QUOTIENT); // also ensures result >= 1 since 1e12/4096 >> 1

    let result = invert_price_e6(raw, 1);

    // Force success - must not be None in valid range
    let inverted = result.expect("inversion must succeed for raw in (0, 1e12]");

    // Verify correctness
    let expected = INVERSION_CONSTANT / (raw as u128);
    assert_eq!(inverted as u128, expected, "inversion must be floor(1e12/raw)");
}

/// Prove: raw==0 always returns None (div by zero protection)
#[kani::proof]
fn kani_invert_zero_raw_returns_none() {
    let result = invert_price_e6(0, 1);
    assert!(result.is_none(), "raw==0 must return None");
}

/// Prove: inverted==0 returns None (result too small)
#[kani::proof]
fn kani_invert_result_zero_returns_none() {
    // For inverted to be 0, we need 1e12 / raw < 1, i.e., raw > 1e12
    // Use a representative value just above the threshold
    let offset: u64 = kani::any();
    kani::assume(offset <= KANI_MAX_QUOTIENT);
    let raw = 1_000_000_000_001u64.saturating_add(offset);

    let result = invert_price_e6(raw, 1);
    assert!(result.is_none(), "inversion resulting in 0 must return None");
}

/// Prove: monotonicity - if raw1 > raw2 > 0 then inv1 <= inv2
#[kani::proof]
fn kani_invert_monotonic() {
    let raw1: u64 = kani::any();
    let raw2: u64 = kani::any();
    kani::assume(raw1 > 0 && raw2 > 0);
    kani::assume(raw1 > raw2);
    // Cap to keep division tractable for SAT solver
    kani::assume(raw1 <= KANI_MAX_QUOTIENT);
    kani::assume(raw2 <= KANI_MAX_QUOTIENT);

    let inv1 = invert_price_e6(raw1, 1);
    let inv2 = invert_price_e6(raw2, 1);

    // If both succeed, inv1 <= inv2 (inverse is monotonically decreasing)
    if let (Some(i1), Some(i2)) = (inv1, inv2) {
        assert!(i1 <= i2, "inversion must be monotonically decreasing");
    }
}

// =============================================================================
// AB. UNIT CONVERSION ALGEBRA PROOFS (8 proofs)
// =============================================================================

/// Prove: base_to_units conservation: units*scale + dust == base (when scale > 0)
#[kani::proof]
fn kani_base_to_units_conservation() {
    let scale: u32 = kani::any();
    kani::assume(scale > 0);
    kani::assume(scale <= KANI_MAX_SCALE);

    // Cap base to keep quotient small for SAT solver
    let base: u64 = kani::any();
    kani::assume(base <= (scale as u64) * KANI_MAX_QUOTIENT);

    let (units, dust) = base_to_units(base, scale);

    // Conservation: units * scale + dust == base
    let reconstructed = (units as u128) * (scale as u128) + (dust as u128);
    assert_eq!(reconstructed, base as u128, "units*scale + dust must equal base");
}

/// Prove: dust < scale when scale > 0
#[kani::proof]
fn kani_base_to_units_dust_bound() {
    let scale: u32 = kani::any();
    kani::assume(scale > 0);
    kani::assume(scale <= KANI_MAX_SCALE);

    // Cap base to keep quotient small for SAT solver
    let base: u64 = kani::any();
    kani::assume(base <= (scale as u64) * KANI_MAX_QUOTIENT);

    let (_, dust) = base_to_units(base, scale);

    assert!(dust < scale as u64, "dust must be < scale");
}

/// Prove: scale==0 returns (base, 0)
#[kani::proof]
fn kani_base_to_units_scale_zero() {
    let base: u64 = kani::any();

    let (units, dust) = base_to_units(base, 0);

    assert_eq!(units, base, "scale==0 must return units==base");
    assert_eq!(dust, 0, "scale==0 must return dust==0");
}

/// Prove: units_to_base roundtrip (without overflow)
#[kani::proof]
fn kani_units_roundtrip() {
    let units: u64 = kani::any();
    let scale: u32 = kani::any();
    kani::assume(scale > 0);
    kani::assume(scale <= KANI_MAX_SCALE);
    // Cap quotient to keep division tractable for SAT solver
    kani::assume(units <= KANI_MAX_QUOTIENT);

    let base = units_to_base(units, scale);
    let (recovered_units, dust) = base_to_units(base, scale);

    assert_eq!(recovered_units, units, "roundtrip must preserve units");
    assert_eq!(dust, 0, "roundtrip must have no dust");
}

/// Prove: units_to_base with scale==0 returns units unchanged
#[kani::proof]
fn kani_units_to_base_scale_zero() {
    let units: u64 = kani::any();

    let base = units_to_base(units, 0);

    assert_eq!(base, units, "scale==0 must return units unchanged");
}

/// Prove: base_to_units is monotonic: base1 < base2 => units1 <= units2
#[kani::proof]
fn kani_base_to_units_monotonic() {
    let scale: u32 = kani::any();
    kani::assume(scale > 0);
    kani::assume(scale <= KANI_MAX_SCALE);

    // Cap both bases to keep quotients small
    let base1: u64 = kani::any();
    let base2: u64 = kani::any();
    kani::assume(base1 <= (scale as u64) * KANI_MAX_QUOTIENT);
    kani::assume(base2 <= (scale as u64) * KANI_MAX_QUOTIENT);
    kani::assume(base1 < base2);

    let (units1, _) = base_to_units(base1, scale);
    let (units2, _) = base_to_units(base2, scale);

    assert!(units1 <= units2, "base_to_units must be monotonic");
}

///// Prove: units_to_base is strictly monotonic when products don't overflow.
/// NOTE: At saturation (units * scale >= u64::MAX), both return u64::MAX,
/// breaking strict monotonicity. This proof bounds inputs to non-saturating range.
/// Production code should use units_to_base_checked to detect overflow.
#[kani::proof]
fn kani_units_to_base_monotonic_bounded() {
    let scale: u32 = kani::any();
    kani::assume(scale > 0);
    kani::assume(scale <= KANI_MAX_SCALE);

    // Cap units to keep products below overflow threshold
    let units1: u64 = kani::any();
    let units2: u64 = kani::any();
    kani::assume(units1 <= KANI_MAX_QUOTIENT);
    kani::assume(units2 <= KANI_MAX_QUOTIENT);
    kani::assume(units1 < units2);

    // Within these bounds, no saturation occurs
    let base1 = units_to_base(units1, scale);
    let base2 = units_to_base(units2, scale);

    assert!(base1 < base2, "units_to_base is strictly monotonic when not saturating");
}

/// Prove: scale==0 preserves monotonicity for base_to_units
#[kani::proof]
fn kani_base_to_units_monotonic_scale_zero() {
    let base1: u64 = kani::any();
    let base2: u64 = kani::any();
    kani::assume(base1 < base2);

    let (units1, _) = base_to_units(base1, 0);
    let (units2, _) = base_to_units(base2, 0);

    assert!(units1 < units2, "scale==0 must preserve strict monotonicity");
}

// =============================================================================
// AC. WITHDRAW ALIGNMENT PROOFS (3 proofs)
// =============================================================================

/// Prove: misaligned amount rejects when scale != 0
/// Constructs misaligned amount directly to avoid expensive % in SAT solver
#[kani::proof]
fn kani_withdraw_misaligned_rejects() {
    let scale: u32 = kani::any();
    kani::assume(scale > 1); // scale==1 means everything is aligned
    kani::assume(scale <= KANI_MAX_SCALE);

    // Construct misaligned: amount = q*scale + r where 0 < r < scale
    let q: u64 = kani::any();
    let r: u64 = kani::any();
    kani::assume(q <= KANI_MAX_QUOTIENT);
    kani::assume(r > 0);
    kani::assume(r < scale as u64);
    let amount = q * (scale as u64) + r;

    let aligned = withdraw_amount_aligned(amount, scale);

    assert!(!aligned, "misaligned amount must be rejected");
}

/// Prove: aligned amount accepts when scale != 0
#[kani::proof]
fn kani_withdraw_aligned_accepts() {
    let scale: u32 = kani::any();
    kani::assume(scale > 0);
    kani::assume(scale <= KANI_MAX_SCALE);

    // Cap units to keep product small
    let units: u64 = kani::any();
    kani::assume(units <= KANI_MAX_QUOTIENT);

    let amount = units * (scale as u64);
    let aligned = withdraw_amount_aligned(amount, scale);

    assert!(aligned, "aligned amount must be accepted");
}

/// Prove: scale==0 always aligned
#[kani::proof]
fn kani_withdraw_scale_zero_always_aligned() {
    let amount: u64 = kani::any();

    let aligned = withdraw_amount_aligned(amount, 0);

    assert!(aligned, "scale==0 must always be aligned");
}

// =============================================================================
// AD. DUST MATH PROOFS (8 proofs)
// =============================================================================

/// Prove: sweep_dust conservation: units*scale + rem == dust (scale > 0)
#[kani::proof]
fn kani_sweep_dust_conservation() {
    let scale: u32 = kani::any();
    kani::assume(scale > 0);
    kani::assume(scale <= KANI_MAX_SCALE);

    // Cap dust to keep quotient small
    let dust: u64 = kani::any();
    kani::assume(dust <= (scale as u64) * KANI_MAX_QUOTIENT);

    let (units, rem) = sweep_dust(dust, scale);

    let reconstructed = (units as u128) * (scale as u128) + (rem as u128);
    assert_eq!(reconstructed, dust as u128, "units*scale + rem must equal dust");
}

/// Prove: sweep_dust rem < scale (scale > 0)
#[kani::proof]
fn kani_sweep_dust_rem_bound() {
    let scale: u32 = kani::any();
    kani::assume(scale > 0);
    kani::assume(scale <= KANI_MAX_SCALE);

    // Cap dust to keep quotient small
    let dust: u64 = kani::any();
    kani::assume(dust <= (scale as u64) * KANI_MAX_QUOTIENT);

    let (_, rem) = sweep_dust(dust, scale);

    assert!(rem < scale as u64, "remaining dust must be < scale");
}

/// Prove: if dust < scale, then units==0 and rem==dust
#[kani::proof]
fn kani_sweep_dust_below_threshold() {
    let dust: u64 = kani::any();
    let scale: u32 = kani::any();
    kani::assume(scale > 0);
    kani::assume(scale <= KANI_MAX_SCALE);
    kani::assume(dust < scale as u64);

    let (units, rem) = sweep_dust(dust, scale);

    assert_eq!(units, 0, "dust < scale must yield units==0");
    assert_eq!(rem, dust, "dust < scale must yield rem==dust");
}

/// Prove: sweep_dust with scale==0 returns (dust, 0)
#[kani::proof]
fn kani_sweep_dust_scale_zero() {
    let dust: u64 = kani::any();

    let (units, rem) = sweep_dust(dust, 0);

    assert_eq!(units, dust, "scale==0 must return units==dust");
    assert_eq!(rem, 0, "scale==0 must return rem==0");
}

/// Prove: accumulate_dust is saturating (no overflow)
#[kani::proof]
fn kani_accumulate_dust_saturates() {
    let old: u64 = kani::any();
    let added: u64 = kani::any();

    let result = accumulate_dust(old, added);

    // Result must be >= old (saturating)
    assert!(result >= old, "accumulate must be >= old");
    // Result must be <= MAX (saturating prevents overflow)
    assert!(result <= u64::MAX, "accumulate must not overflow");
    // If no overflow, result == old + added
    if old.checked_add(added).is_some() {
        assert_eq!(result, old + added, "no overflow means exact sum");
    } else {
        assert_eq!(result, u64::MAX, "overflow saturates to MAX");
    }
}

/// Prove: scale==0 policy - base_to_units never produces dust
/// This is the foundation of the "no dust when scale==0" invariant
#[kani::proof]
fn kani_scale_zero_policy_no_dust() {
    let base: u64 = kani::any();

    let (_, dust) = base_to_units(base, 0);

    assert_eq!(dust, 0, "scale==0 must NEVER produce dust");
}

/// Prove: scale==0 policy - sweep never leaves remainder
/// Combined with no-dust production, this ensures dust stays 0
#[kani::proof]
fn kani_scale_zero_policy_sweep_complete() {
    let dust: u64 = kani::any();

    let (_, rem) = sweep_dust(dust, 0);

    assert_eq!(rem, 0, "scale==0 sweep must leave no remainder");
}

/// Prove: scale==0 end-to-end - deposit/sweep cycle produces zero dust
/// Simulates: deposit base → get (units, dust) → sweep dust → final remainder
#[kani::proof]
fn kani_scale_zero_policy_end_to_end() {
    let base: u64 = kani::any();

    // Deposit converts base to units + dust
    let (_, dust) = base_to_units(base, 0);

    // Sweep any accumulated dust
    let (_, final_rem) = sweep_dust(dust, 0);

    // Both must be zero when scale==0
    assert_eq!(dust, 0, "deposit with scale==0 must produce no dust");
    assert_eq!(final_rem, 0, "sweep with scale==0 must leave no remainder");
}

// =============================================================================
// AE. UNIVERSAL GATE ORDERING PROOFS FOR TRADECPI (6 proofs)
// These prove that specific gates cause rejection regardless of other inputs
// =============================================================================

/// Universal: matcher_shape_ok==false => Reject (regardless of other inputs)
#[kani::proof]
fn kani_universal_shape_fail_rejects() {
    let old_nonce: u64 = kani::any();
    let shape = MatcherAccountsShape {
        prog_executable: kani::any(),
        ctx_executable: kani::any(),
        ctx_owner_is_prog: kani::any(),
        ctx_len_ok: kani::any(),
    };
    // Force shape to be invalid
    kani::assume(!matcher_shape_ok(shape));

    let identity_ok: bool = kani::any();
    let pda_ok: bool = kani::any();
    let abi_ok: bool = kani::any();
    let user_auth_ok: bool = kani::any();
    let lp_auth_ok: bool = kani::any();
    let gate_active: bool = kani::any();
    let risk_increase: bool = kani::any();
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, shape, identity_ok, pda_ok, abi_ok,
        user_auth_ok, lp_auth_ok, gate_active, risk_increase, exec_size
    );

    assert_eq!(decision, TradeCpiDecision::Reject,
        "invalid shape must always reject");
}

/// Universal: pda_ok==false => Reject
#[kani::proof]
fn kani_universal_pda_fail_rejects() {
    let old_nonce: u64 = kani::any();
    let shape = valid_shape();
    let identity_ok: bool = kani::any();
    let pda_ok = false; // Force failure
    let abi_ok: bool = kani::any();
    let user_auth_ok: bool = kani::any();
    let lp_auth_ok: bool = kani::any();
    let gate_active: bool = kani::any();
    let risk_increase: bool = kani::any();
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, shape, identity_ok, pda_ok, abi_ok,
        user_auth_ok, lp_auth_ok, gate_active, risk_increase, exec_size
    );

    assert_eq!(decision, TradeCpiDecision::Reject,
        "pda_ok==false must always reject");
}

/// Universal: user_auth_ok==false => Reject
#[kani::proof]
fn kani_universal_user_auth_fail_rejects() {
    let old_nonce: u64 = kani::any();
    let shape = valid_shape();
    let identity_ok: bool = kani::any();
    let pda_ok = true;
    let abi_ok: bool = kani::any();
    let user_auth_ok = false; // Force failure
    let lp_auth_ok: bool = kani::any();
    let gate_active: bool = kani::any();
    let risk_increase: bool = kani::any();
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, shape, identity_ok, pda_ok, abi_ok,
        user_auth_ok, lp_auth_ok, gate_active, risk_increase, exec_size
    );

    assert_eq!(decision, TradeCpiDecision::Reject,
        "user_auth_ok==false must always reject");
}

/// Universal: lp_auth_ok==false => Reject
#[kani::proof]
fn kani_universal_lp_auth_fail_rejects() {
    let old_nonce: u64 = kani::any();
    let shape = valid_shape();
    let identity_ok: bool = kani::any();
    let pda_ok = true;
    let abi_ok: bool = kani::any();
    let user_auth_ok = true;
    let lp_auth_ok = false; // Force failure
    let gate_active: bool = kani::any();
    let risk_increase: bool = kani::any();
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, shape, identity_ok, pda_ok, abi_ok,
        user_auth_ok, lp_auth_ok, gate_active, risk_increase, exec_size
    );

    assert_eq!(decision, TradeCpiDecision::Reject,
        "lp_auth_ok==false must always reject");
}

/// Universal: identity_ok==false => Reject
#[kani::proof]
fn kani_universal_identity_fail_rejects() {
    let old_nonce: u64 = kani::any();
    let shape = valid_shape();
    let identity_ok = false; // Force failure
    let pda_ok = true;
    let abi_ok: bool = kani::any();
    let user_auth_ok = true;
    let lp_auth_ok = true;
    let gate_active: bool = kani::any();
    let risk_increase: bool = kani::any();
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, shape, identity_ok, pda_ok, abi_ok,
        user_auth_ok, lp_auth_ok, gate_active, risk_increase, exec_size
    );

    assert_eq!(decision, TradeCpiDecision::Reject,
        "identity_ok==false must always reject");
}

/// Universal: abi_ok==false => Reject
#[kani::proof]
fn kani_universal_abi_fail_rejects() {
    let old_nonce: u64 = kani::any();
    let shape = valid_shape();
    let identity_ok = true;
    let pda_ok = true;
    let abi_ok = false; // Force failure
    let user_auth_ok = true;
    let lp_auth_ok = true;
    let gate_active: bool = kani::any();
    let risk_increase: bool = kani::any();
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, shape, identity_ok, pda_ok, abi_ok,
        user_auth_ok, lp_auth_ok, gate_active, risk_increase, exec_size
    );

    assert_eq!(decision, TradeCpiDecision::Reject,
        "abi_ok==false must always reject");
}

// =============================================================================
// AF. CONSISTENCY BETWEEN decide_trade_cpi AND decide_trade_cpi_from_ret
// Split into valid-shape and invalid-shape for faster/sharper proofs
// =============================================================================

/// Prove: consistency under VALID shape - focuses on ABI/nonce/gate/identity
#[kani::proof]
fn kani_tradecpi_variants_consistent_valid_shape() {
    let old_nonce: u64 = kani::any();
    let shape = valid_shape(); // Force valid shape

    let identity_ok: bool = kani::any();
    let pda_ok: bool = kani::any();
    let user_auth_ok: bool = kani::any();
    let lp_auth_ok: bool = kani::any();
    let gate_is_active: bool = kani::any();
    let risk_increase: bool = kani::any();

    // Create ret fields
    let ret = any_matcher_return_fields();
    let lp_account_id: u64 = kani::any();
    let oracle_price_e6: u64 = kani::any();
    let req_size: i128 = kani::any();

    // Compute req_id as decide_trade_cpi_from_ret does
    let req_id = nonce_on_success(old_nonce);

    // Check if ABI would pass
    let abi_passes = abi_ok(ret, lp_account_id, oracle_price_e6, req_size, req_id);

    // Get decisions from both variants
    let decision1 = decide_trade_cpi(
        old_nonce, shape, identity_ok, pda_ok, abi_passes,
        user_auth_ok, lp_auth_ok, gate_is_active, risk_increase, ret.exec_size
    );

    let decision2 = decide_trade_cpi_from_ret(
        old_nonce, shape, identity_ok, pda_ok,
        user_auth_ok, lp_auth_ok, gate_is_active, risk_increase,
        ret, lp_account_id, oracle_price_e6, req_size
    );

    // Both must give same outcome
    match (&decision1, &decision2) {
        (TradeCpiDecision::Reject, TradeCpiDecision::Reject) => {}
        (TradeCpiDecision::Accept { new_nonce: n1, chosen_size: s1 },
         TradeCpiDecision::Accept { new_nonce: n2, chosen_size: s2 }) => {
            assert_eq!(*n1, *n2, "nonces must match");
            assert_eq!(*s1, *s2, "chosen_sizes must match");
        }
        _ => panic!("decisions must be consistent"),
    }
}

/// Prove: consistency under INVALID shape - both must reject (fast proof)
#[kani::proof]
fn kani_tradecpi_variants_consistent_invalid_shape() {
    let old_nonce: u64 = kani::any();
    let shape = MatcherAccountsShape {
        prog_executable: kani::any(),
        ctx_executable: kani::any(),
        ctx_owner_is_prog: kani::any(),
        ctx_len_ok: kani::any(),
    };
    // Force INVALID shape
    kani::assume(!matcher_shape_ok(shape));

    // Other inputs symbolic
    let identity_ok: bool = kani::any();
    let pda_ok: bool = kani::any();
    let user_auth_ok: bool = kani::any();
    let lp_auth_ok: bool = kani::any();
    let gate_is_active: bool = kani::any();
    let risk_increase: bool = kani::any();
    let ret = any_matcher_return_fields();
    let lp_account_id: u64 = kani::any();
    let oracle_price_e6: u64 = kani::any();
    let req_size: i128 = kani::any();

    let req_id = nonce_on_success(old_nonce);
    let abi_passes = abi_ok(ret, lp_account_id, oracle_price_e6, req_size, req_id);

    let decision1 = decide_trade_cpi(
        old_nonce, shape, identity_ok, pda_ok, abi_passes,
        user_auth_ok, lp_auth_ok, gate_is_active, risk_increase, ret.exec_size
    );

    let decision2 = decide_trade_cpi_from_ret(
        old_nonce, shape, identity_ok, pda_ok,
        user_auth_ok, lp_auth_ok, gate_is_active, risk_increase,
        ret, lp_account_id, oracle_price_e6, req_size
    );

    // Both must reject on invalid shape
    assert_eq!(decision1, TradeCpiDecision::Reject, "invalid shape must reject (variant 1)");
    assert_eq!(decision2, TradeCpiDecision::Reject, "invalid shape must reject (variant 2)");
}

/// Prove: decide_trade_cpi_from_ret computes req_id as nonce_on_success(old_nonce)
/// NON-VACUOUS: forces acceptance by constraining ret to be ABI-valid
#[kani::proof]
fn kani_tradecpi_from_ret_req_id_is_nonce_plus_one() {
    let old_nonce: u64 = kani::any();
    let shape = valid_shape();

    // Compute the expected req_id that decide_trade_cpi_from_ret will use
    let expected_req_id = nonce_on_success(old_nonce);

    // Constrain ret to be ABI-valid for this req_id
    let mut ret = any_matcher_return_fields();
    ret.abi_version = MATCHER_ABI_VERSION;
    ret.flags = FLAG_VALID | FLAG_PARTIAL_OK; // PARTIAL_OK allows exec_size=0
    ret.reserved = 0;
    kani::assume(ret.exec_price_e6 != 0);
    ret.req_id = expected_req_id; // Must match nonce_on_success(old_nonce)
    ret.exec_size = 0; // With PARTIAL_OK, zero size is always valid

    let lp_account_id: u64 = ret.lp_account_id;
    let oracle_price_e6: u64 = ret.oracle_price_e6;
    let req_size: i128 = kani::any();

    // All other checks pass
    let decision = decide_trade_cpi_from_ret(
        old_nonce, shape,
        true,  // identity_ok
        true,  // pda_ok
        true,  // user_auth_ok
        true,  // lp_auth_ok
        false, // gate_active (inactive)
        false, // risk_increase
        ret, lp_account_id, oracle_price_e6, req_size
    );

    // FORCE acceptance - with valid ABI inputs, must accept
    match decision {
        TradeCpiDecision::Accept { new_nonce, .. } => {
            assert_eq!(new_nonce, expected_req_id,
                "new_nonce must equal nonce_on_success(old_nonce)");
        }
        TradeCpiDecision::Reject => {
            panic!("must accept with valid ABI inputs");
        }
    }
}

// =============================================================================
// AG. UNIVERSAL GATE PROOF (missing from AE)
// =============================================================================

/// Universal: gate_active && risk_increase => Reject (the kill switch)
/// This is the canonical risk-reduction enforcement property
#[kani::proof]
fn kani_universal_gate_risk_increase_rejects() {
    let old_nonce: u64 = kani::any();
    let shape = valid_shape();
    let identity_ok = true;
    let pda_ok = true;
    let abi_ok = true;
    let user_auth_ok = true;
    let lp_auth_ok = true;
    let gate_active = true;     // Gate IS active
    let risk_increase = true;   // Trade WOULD increase risk
    let exec_size: i128 = kani::any();

    let decision = decide_trade_cpi(
        old_nonce, shape, identity_ok, pda_ok, abi_ok,
        user_auth_ok, lp_auth_ok, gate_active, risk_increase, exec_size
    );

    assert_eq!(decision, TradeCpiDecision::Reject,
        "gate_active && risk_increase must ALWAYS reject");
}

// =============================================================================
// AH. ADDITIONAL STRENGTHENING PROOFS
// =============================================================================

/// Unit conversion: if dust==0 after base_to_units, roundtrip is exact
/// Constructs base = q * scale directly to avoid expensive % in SAT solver
#[kani::proof]
fn kani_units_roundtrip_exact_when_no_dust() {
    let scale: u32 = kani::any();
    kani::assume(scale > 0);
    kani::assume(scale <= KANI_MAX_SCALE);

    // Construct base as exact multiple of scale (no dust case)
    let q: u64 = kani::any();
    kani::assume(q <= KANI_MAX_QUOTIENT);
    let base = q * (scale as u64);

    let (units, dust) = base_to_units(base, scale);
    assert_eq!(dust, 0, "base = q*scale must have no dust");

    let recovered = units_to_base(units, scale);
    assert_eq!(recovered, base, "roundtrip must be exact when dust==0");
}

/// Universal: allow_panic != 0 && !admin_ok => Reject (for all other inputs)
#[kani::proof]
fn kani_universal_panic_requires_admin() {
    let allow_panic: u8 = kani::any();
    kani::assume(allow_panic != 0); // Panic requested

    let admin: [u8; 32] = kani::any();
    let signer: [u8; 32] = kani::any();

    // Admin check fails (either burned or mismatch)
    kani::assume(!admin_ok(admin, signer));

    // Other inputs can be anything
    let permissionless: bool = kani::any();
    let idx_exists: bool = kani::any();
    let stored_owner: [u8; 32] = kani::any();

    let decision = decide_keeper_crank_with_panic(
        allow_panic, admin, signer, permissionless, idx_exists, stored_owner
    );

    assert_eq!(decision, SimpleDecision::Reject,
        "allow_panic without admin auth must ALWAYS reject");
}

// =============================================================================
// AI. UNIVERSAL GATE KILL-SWITCH FOR FROM_RET PATH
// =============================================================================

/// Universal: gate_active && risk_increase => Reject in from_ret path
/// Proves the kill-switch works in the mechanically-tied path too
#[kani::proof]
fn kani_universal_gate_risk_increase_rejects_from_ret() {
    let old_nonce: u64 = kani::any();
    let shape = valid_shape();

    // Construct ABI-valid ret (so we get past ABI checks to the gate)
    let expected_req_id = nonce_on_success(old_nonce);
    let mut ret = any_matcher_return_fields();
    ret.abi_version = MATCHER_ABI_VERSION;
    ret.flags = FLAG_VALID | FLAG_PARTIAL_OK;
    ret.reserved = 0;
    kani::assume(ret.exec_price_e6 != 0);
    ret.req_id = expected_req_id;
    ret.exec_size = 0;

    let lp_account_id: u64 = ret.lp_account_id;
    let oracle_price_e6: u64 = ret.oracle_price_e6;
    let req_size: i128 = kani::any();

    // All pre-gate checks pass
    let decision = decide_trade_cpi_from_ret(
        old_nonce, shape,
        true,  // identity_ok
        true,  // pda_ok
        true,  // user_auth_ok
        true,  // lp_auth_ok
        true,  // gate_active - ACTIVE
        true,  // risk_increase - INCREASING
        ret, lp_account_id, oracle_price_e6, req_size
    );

    assert_eq!(decision, TradeCpiDecision::Reject,
        "gate_active && risk_increase must reject even with valid ABI");
}

// =============================================================================
// AJ. END-TO-END FORCED ACCEPTANCE FOR FROM_RET PATH
// =============================================================================

/// Prove: end-to-end acceptance when all conditions are met
/// NON-VACUOUS: forces Accept and verifies all output fields
#[kani::proof]
fn kani_tradecpi_from_ret_forced_acceptance() {
    let old_nonce: u64 = kani::any();
    let shape = valid_shape();

    // Construct ABI-valid ret
    let expected_req_id = nonce_on_success(old_nonce);
    let mut ret = any_matcher_return_fields();
    ret.abi_version = MATCHER_ABI_VERSION;
    ret.flags = FLAG_VALID | FLAG_PARTIAL_OK;
    ret.reserved = 0;
    kani::assume(ret.exec_price_e6 != 0);
    ret.req_id = expected_req_id;
    ret.exec_size = 0; // PARTIAL_OK allows zero

    let lp_account_id: u64 = ret.lp_account_id;
    let oracle_price_e6: u64 = ret.oracle_price_e6;
    let req_size: i128 = kani::any();

    // All checks pass, gate inactive or risk not increasing
    let decision = decide_trade_cpi_from_ret(
        old_nonce, shape,
        true,  // identity_ok
        true,  // pda_ok
        true,  // user_auth_ok
        true,  // lp_auth_ok
        false, // gate_active (inactive)
        false, // risk_increase (not increasing)
        ret, lp_account_id, oracle_price_e6, req_size
    );

    // MUST accept
    match decision {
        TradeCpiDecision::Accept { new_nonce, chosen_size } => {
            assert_eq!(new_nonce, expected_req_id, "new_nonce must be nonce+1");
            assert_eq!(chosen_size, ret.exec_size, "chosen_size must be exec_size");
        }
        TradeCpiDecision::Reject => {
            panic!("must accept when all conditions pass");
        }
    }
}

// =============================================================================
// AK. INITMARKET UNIT_SCALE BOUNDS PROOFS (4 proofs)
// =============================================================================

/// Prove: scale > MAX_UNIT_SCALE is rejected
#[kani::proof]
fn kani_init_market_scale_rejects_overflow() {
    let scale: u32 = kani::any();
    kani::assume(scale > MAX_UNIT_SCALE);

    let result = init_market_scale_ok(scale);

    assert!(!result, "scale > MAX_UNIT_SCALE must be rejected");
}

/// Prove: scale=0 is accepted (disables scaling)
#[kani::proof]
fn kani_init_market_scale_zero_ok() {
    let result = init_market_scale_ok(0);

    assert!(result, "scale=0 must be accepted");
}

/// Prove: scale=MAX_UNIT_SCALE is accepted (boundary)
#[kani::proof]
fn kani_init_market_scale_boundary_ok() {
    let result = init_market_scale_ok(MAX_UNIT_SCALE);

    assert!(result, "scale=MAX_UNIT_SCALE must be accepted");
}

/// Prove: scale=MAX_UNIT_SCALE+1 is rejected (boundary)
#[kani::proof]
fn kani_init_market_scale_boundary_reject() {
    // Note: if MAX_UNIT_SCALE is u32::MAX, this proof is vacuous (which is fine)
    if MAX_UNIT_SCALE < u32::MAX {
        let result = init_market_scale_ok(MAX_UNIT_SCALE + 1);
        assert!(!result, "scale=MAX_UNIT_SCALE+1 must be rejected");
    }
}

/// Prove: any scale in valid range [0, MAX_UNIT_SCALE] is accepted
#[kani::proof]
fn kani_init_market_scale_valid_range() {
    let scale: u32 = kani::any();
    kani::assume(scale <= MAX_UNIT_SCALE);

    let result = init_market_scale_ok(scale);

    assert!(result, "any scale in [0, MAX_UNIT_SCALE] must be accepted");
}

// =============================================================================
// AL. NON-INTERFERENCE PROOFS
// =============================================================================
// Note: Removed trivial proofs. admin_ok and owner_ok compare [u8; 32] arrays
// and don't reference unit_scale at all. Independence is structural (no shared
// state), not a runtime property that needs formal verification.

/// Prove: unit conversion is deterministic - same inputs always give same outputs
/// Calls the function twice with the same inputs to verify identical results.
#[kani::proof]
fn kani_unit_conversion_deterministic() {
    let scale: u32 = kani::any();
    kani::assume(scale <= KANI_MAX_SCALE);

    // Cap base to keep quotient small
    let base: u64 = kani::any();
    kani::assume(base <= (scale.max(1) as u64) * KANI_MAX_QUOTIENT);

    // Call the function twice with identical inputs
    let (units1, dust1) = base_to_units(base, scale);
    let (units2, dust2) = base_to_units(base, scale);

    // For a deterministic function, results must be identical
    assert_eq!(units1, units2, "base_to_units must be deterministic");
    assert_eq!(dust1, dust2, "base_to_units dust must be deterministic");
}

/// Prove: unit scale validation is pure - no side effects
#[kani::proof]
fn kani_scale_validation_pure() {
    let scale: u32 = kani::any();

    // Call multiple times - same result
    let result1 = init_market_scale_ok(scale);
    let result2 = init_market_scale_ok(scale);
    let result3 = init_market_scale_ok(scale);

    assert_eq!(result1, result2, "init_market_scale_ok must be pure (1)");
    assert_eq!(result2, result3, "init_market_scale_ok must be pure (2)");
}

// =============================================================================
// BUG DETECTION: Unit Scale Margin Inconsistency
// =============================================================================
//
// These proofs demonstrate a BUG in the current margin calculation:
// - Capital is scaled by unit_scale (base_tokens / unit_scale)
// - Position value is NOT scaled (position_size * price / 1_000_000)
// - Margin check compares capital (scaled) vs margin_required (unscaled)
// - This causes the same economic position to pass/fail margin based on unit_scale
//
// The proofs use ACTUAL PRODUCTION CODE from the percolator library:
// - percolator::RiskEngine::mark_pnl_for_position (the real mark_pnl calculation)
// - percolator_prog::verify::base_to_units (the real unit conversion)
//
// The proof SHOULD FAIL (finding a counterexample) to demonstrate the bug exists.

// Note: base_to_units is already imported at top of file from percolator_prog::verify

/// Compute position value using the SAME FORMULA as production code.
/// This replicates percolator::RiskEngine::is_above_margin_bps_mtm exactly.
/// See percolator/src/percolator.rs lines 3135-3138.
#[inline]
fn production_position_value(position_size: i128, oracle_price: u64) -> u128 {
    // Exact formula from production: mul_u128(abs(pos), price) / 1_000_000
    let abs_pos = position_size.unsigned_abs();
    abs_pos.saturating_mul(oracle_price as u128) / 1_000_000
}

/// Compute margin required using the SAME FORMULA as production code.
/// See percolator/src/percolator.rs line 3141.
#[inline]
fn production_margin_required(position_value: u128, margin_bps: u64) -> u128 {
    position_value.saturating_mul(margin_bps as u128) / 10_000
}

/// Compute mark-to-market PnL using the SAME FORMULA as production code.
/// This replicates percolator::RiskEngine::mark_pnl_for_position exactly.
/// See percolator/src/percolator.rs lines 1542-1562.
#[inline]
fn production_mark_pnl(position_size: i128, entry_price: u64, oracle_price: u64) -> Option<i128> {
    if position_size == 0 {
        return Some(0);
    }
    let abs_pos = position_size.unsigned_abs();
    let diff: i128 = if position_size > 0 {
        // Long: profit when oracle > entry
        (oracle_price as i128).saturating_sub(entry_price as i128)
    } else {
        // Short: profit when entry > oracle
        (entry_price as i128).saturating_sub(oracle_price as i128)
    };
    // mark_pnl = diff * abs_pos / 1_000_000 (production uses checked_mul/checked_div)
    diff.checked_mul(abs_pos as i128)?.checked_div(1_000_000)
}

/// Compute equity using the SAME FORMULA as production code.
/// This replicates percolator::RiskEngine::account_equity_mtm_at_oracle exactly.
/// See percolator/src/percolator.rs lines 3108-3120.
///
/// BUG: Production code adds capital (in units) + pnl + mark_pnl (both NOT in units).
/// This mixes different unit systems when unit_scale != 0.
#[inline]
fn production_equity(capital: u128, pnl: i128, mark_pnl: i128) -> u128 {
    // Exact formula from production: max(0, capital + pnl + mark_pnl)
    let cap_i = if capital > i128::MAX as u128 { i128::MAX } else { capital as i128 };
    let eq_i = cap_i.saturating_add(pnl).saturating_add(mark_pnl);
    if eq_i > 0 { eq_i as u128 } else { 0 }
}

// =============================================================================
// PRODUCTION scale_price_e6 proofs - These test the ACTUAL production function
// =============================================================================

/// Prove scale_price_e6 returns None when result would be zero.
/// This tests the PRODUCTION function directly.
#[kani::proof]
fn kani_scale_price_e6_zero_result_rejected() {
    let price: u64 = kani::any();
    let unit_scale: u32 = kani::any();

    // Constrain to avoid trivial cases
    kani::assume(unit_scale > 1);
    kani::assume(price > 0);
    kani::assume(price < unit_scale as u64);  // Result would be zero

    // PRODUCTION function should reject (return None)
    let result = scale_price_e6(price, unit_scale);
    assert!(result.is_none(), "scale_price_e6 must reject when scaled price would be zero");
}

/// Prove scale_price_e6 returns Some when result is non-zero.
/// This tests the PRODUCTION function directly.
#[kani::proof]
fn kani_scale_price_e6_valid_result() {
    let price: u64 = kani::any();
    let unit_scale: u32 = kani::any();

    // Constrain to valid inputs that produce non-zero result
    kani::assume(unit_scale > 1);
    kani::assume(unit_scale <= KANI_MAX_SCALE);  // Keep SAT tractable
    kani::assume(price >= unit_scale as u64);    // Ensures result >= 1
    kani::assume(price <= KANI_MAX_QUOTIENT as u64 * unit_scale as u64); // Tight bound for SAT

    // PRODUCTION function should succeed
    let result = scale_price_e6(price, unit_scale);
    assert!(result.is_some(), "scale_price_e6 must succeed for valid inputs");

    // Verify the formula: scaled = price / unit_scale
    let scaled = result.unwrap();
    assert_eq!(scaled, price / unit_scale as u64, "scale_price_e6 must compute price / unit_scale");
}

/// Prove scale_price_e6 is identity when unit_scale <= 1.
/// This tests the PRODUCTION function directly.
#[kani::proof]
fn kani_scale_price_e6_identity_for_scale_leq_1() {
    let price: u64 = kani::any();
    let unit_scale: u32 = kani::any();

    kani::assume(unit_scale <= 1);

    // PRODUCTION function should return price unchanged
    let result = scale_price_e6(price, unit_scale);
    assert!(result.is_some(), "scale_price_e6 must succeed when unit_scale <= 1");
    assert_eq!(result.unwrap(), price, "scale_price_e6 must be identity when unit_scale <= 1");
}

/// Prove that production base_to_units and scale_price_e6 use the SAME divisor.
/// This is the key property that ensures margin checks are consistent.
///
/// The fix works because:
/// - capital_units = base_tokens / unit_scale  (via base_to_units)
/// - oracle_scaled = oracle_price / unit_scale (via scale_price_e6)
///
/// Both divide by the same unit_scale, so margin ratios are preserved.
#[kani::proof]
fn kani_scale_price_and_base_to_units_use_same_divisor() {
    let base_tokens: u64 = kani::any();
    let oracle_price: u64 = kani::any();
    let unit_scale: u32 = kani::any();

    // Constrain to valid inputs
    kani::assume(unit_scale > 1);
    kani::assume(unit_scale <= KANI_MAX_SCALE);
    kani::assume(base_tokens >= unit_scale as u64);
    kani::assume(base_tokens <= KANI_MAX_QUOTIENT as u64 * unit_scale as u64); // Tight bound for SAT
    kani::assume(oracle_price >= unit_scale as u64);
    kani::assume(oracle_price <= KANI_MAX_QUOTIENT as u64 * unit_scale as u64); // Tight bound for SAT

    // Call PRODUCTION functions
    let (capital_units, _dust) = base_to_units(base_tokens, unit_scale);
    let oracle_scaled = scale_price_e6(oracle_price, unit_scale).unwrap();

    // Both should divide by unit_scale
    assert_eq!(capital_units, base_tokens / unit_scale as u64,
        "base_to_units must compute base / unit_scale");
    assert_eq!(oracle_scaled, oracle_price / unit_scale as u64,
        "scale_price_e6 must compute price / unit_scale");

    // Key invariant: same divisor means margin ratio is preserved
    // margin_ratio = capital / position_value
    // With scaling: (base/scale) / (price/scale * pos / 1e6) = base / (price * pos / 1e6)
    // Same ratio regardless of scale!
}

/// CONCRETE EXAMPLE using PRODUCTION functions.
/// Verifies the fix works for a typical scenario.
#[kani::proof]
fn kani_scale_price_e6_concrete_example() {
    let oracle_price: u64 = 138_000_000;  // $138 in e6
    let unit_scale: u32 = 1000;

    // Call PRODUCTION function
    let scaled = scale_price_e6(oracle_price, unit_scale);

    assert!(scaled.is_some(), "Must succeed for valid input");
    assert_eq!(scaled.unwrap(), 138_000, "138_000_000 / 1000 = 138_000");

    // Also test with production base_to_units
    let base_tokens: u64 = 1_000_000_000;  // 1 SOL
    let (capital_units, dust) = base_to_units(base_tokens, unit_scale);

    assert_eq!(capital_units, 1_000_000, "1B / 1000 = 1M");
    assert_eq!(dust, 0, "1B is evenly divisible by 1000");

    // Verify margin calculation uses consistent units:
    // position_value = pos_size * oracle_scaled / 1e6
    // margin_required = position_value * margin_bps / 10_000
    let position_size: u128 = 1_000_000;  // 1M contracts
    let margin_bps: u128 = 500;           // 5%

    let position_value_scaled = position_size * scaled.unwrap() as u128 / 1_000_000;
    let margin_required = position_value_scaled * margin_bps / 10_000;

    // capital_units (1M) > margin_required (6.9K) → PASSES
    assert!(capital_units as u128 > margin_required,
        "With fix: capital and position_value are both in units scale, margin check passes");
}
// Integer truncation can cause < 1 unit differences that flip results at exact
// boundaries, but this is unavoidable with integer arithmetic and economically
// insignificant compared to the original bug (factor of unit_scale difference).

// =============================================================================
// BUG #9 RATE LIMITING PROOFS (clamp_toward_with_dt)
// =============================================================================
//
// Bug #9: In Hyperp mode, clamp_toward_with_dt originally returned `mark` when
// dt=0 (same slot), allowing double-crank to bypass rate limiting.
// Fix: Return `index` (no movement) when dt=0 or cap=0.

/// Prove: When dt_slots == 0, index is returned unchanged (no movement).
/// This is the core Bug #9 fix - prevents same-slot rate limit bypass.
#[kani::proof]
fn kani_clamp_toward_no_movement_when_dt_zero() {
    let index: u64 = kani::any();
    let mark: u64 = kani::any();
    let cap_e2bps: u64 = kani::any();

    // Constrain to valid inputs
    kani::assume(index > 0);  // index=0 is special case (returns mark)
    kani::assume(cap_e2bps > 0);  // cap=0 also returns index unchanged

    // dt_slots = 0 (same slot)
    let result = clamp_toward_with_dt(index, mark, cap_e2bps, 0);

    // Bug #9 fix: must return index, NOT mark
    assert_eq!(result, index,
        "clamp_toward_with_dt must return index unchanged when dt_slots=0");
}

/// Prove: When cap_e2bps == 0, index is returned unchanged (rate limiting disabled).
#[kani::proof]
fn kani_clamp_toward_no_movement_when_cap_zero() {
    let index: u64 = kani::any();
    let mark: u64 = kani::any();
    let dt_slots: u64 = kani::any();

    // Constrain to valid inputs
    kani::assume(index > 0);  // index=0 is special case
    kani::assume(dt_slots > 0);  // dt=0 also returns index unchanged

    // cap_e2bps = 0 (rate limiting disabled)
    let result = clamp_toward_with_dt(index, mark, 0, dt_slots);

    assert_eq!(result, index,
        "clamp_toward_with_dt must return index unchanged when cap_e2bps=0");
}

/// Prove: When index == 0 (uninitialized), mark is returned (bootstrap case).
#[kani::proof]
fn kani_clamp_toward_bootstrap_when_index_zero() {
    let mark: u64 = kani::any();
    let cap_e2bps: u64 = kani::any();
    let dt_slots: u64 = kani::any();

    // index = 0 is the bootstrap/initialization case
    let result = clamp_toward_with_dt(0, mark, cap_e2bps, dt_slots);

    assert_eq!(result, mark,
        "clamp_toward_with_dt must return mark when index=0 (bootstrap)");
}

/// Prove: Index movement is bounded - concrete example.
/// Uses fixed values to avoid SAT explosion from division.
#[kani::proof]
fn kani_clamp_toward_movement_bounded_concrete() {
    // Concrete example: index=1_000_000, cap=10_000 (1%), dt=1
    // max_delta = 1_000_000 * 10_000 * 1 / 1_000_000 = 10_000
    let index: u64 = 1_000_000;
    let cap_e2bps: u64 = 10_000;  // 1%
    let dt_slots: u64 = 1;
    let mark: u64 = kani::any();

    let result = clamp_toward_with_dt(index, mark, cap_e2bps, dt_slots);

    // max_delta = 10_000
    let lo = index - 10_000;  // 990_000
    let hi = index + 10_000;  // 1_010_000

    assert!(result >= lo && result <= hi,
        "result must be within 1% of index");
}

/// Prove: Formula correctness - concrete example.
/// Uses fixed values to avoid SAT explosion from division.
#[kani::proof]
fn kani_clamp_toward_formula_concrete() {
    // Same concrete setup
    let index: u64 = 1_000_000;
    let cap_e2bps: u64 = 10_000;  // 1%
    let dt_slots: u64 = 1;
    let mark: u64 = kani::any();

    let result = clamp_toward_with_dt(index, mark, cap_e2bps, dt_slots);
    let expected = mark.clamp(990_000, 1_010_000);

    assert_eq!(result, expected,
        "result must equal mark.clamp(990_000, 1_010_000)");
}
