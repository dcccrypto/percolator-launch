//! Percolator: Single-file Solana program with embedded Risk Engine.

#![no_std]
#![deny(unsafe_code)]

// =============================================================================
// COMPILE-TIME SAFETY GUARDS
// =============================================================================
// These guards prevent dangerous feature combinations from compiling.
// The `mainnet` feature acts as a build-time assertion that no test/devnet
// features are accidentally enabled in production builds.

/// C2: unsafe_close skips ALL CloseSlab validation — test environments only!
#[cfg(all(feature = "unsafe_close", feature = "mainnet"))]
compile_error!("unsafe_close MUST NOT be enabled on mainnet builds!");

/// H2: devnet disables oracle staleness/confidence checks — not safe for mainnet!
#[cfg(all(feature = "devnet", feature = "mainnet"))]
compile_error!("devnet feature MUST NOT be enabled on mainnet builds!");

extern crate alloc;

use solana_program::pubkey::Pubkey;
use solana_program::declare_id;

declare_id!("Perco1ator111111111111111111111111111111111");

// 1. mod constants
pub mod constants {
    use core::mem::{size_of, align_of};
    use crate::state::{SlabHeader, MarketConfig};
    use percolator::RiskEngine;

    pub const MAGIC: u64 = 0x504552434f4c4154; // "PERCOLAT"
    pub const VERSION: u32 = 1;

    pub const HEADER_LEN: usize = size_of::<SlabHeader>();
    pub const CONFIG_LEN: usize = size_of::<MarketConfig>();
    pub const ENGINE_ALIGN: usize = align_of::<RiskEngine>();

    pub const fn align_up(x: usize, a: usize) -> usize {
        (x + (a - 1)) & !(a - 1)
    }

    pub const ENGINE_OFF: usize = align_up(HEADER_LEN + CONFIG_LEN, ENGINE_ALIGN);
    pub const ENGINE_LEN: usize = size_of::<RiskEngine>();
    pub const SLAB_LEN: usize = ENGINE_OFF + ENGINE_LEN;
    pub const MATCHER_ABI_VERSION: u32 = 1;
    pub const MATCHER_CONTEXT_PREFIX_LEN: usize = 64;
    pub const MATCHER_CONTEXT_LEN: usize = 320;
    pub const MATCHER_CALL_TAG: u8 = 0;
    pub const MATCHER_CALL_LEN: usize = 67;

    /// Sentinel value for permissionless crank (no caller account required)
    pub const CRANK_NO_CALLER: u16 = u16::MAX;

    /// Maximum allowed unit_scale for InitMarket.
    /// unit_scale=0 disables scaling (1:1 base tokens to units, dust=0 always).
    /// unit_scale=1..=1_000_000_000 enables scaling with dust tracking.
    pub const MAX_UNIT_SCALE: u32 = 1_000_000_000;

    // Default funding parameters (used at init_market, can be changed via update_config)
    pub const DEFAULT_FUNDING_HORIZON_SLOTS: u64 = 500;            // ~4 min @ ~2 slots/sec
    pub const DEFAULT_FUNDING_K_BPS: u64 = 100;                    // 1.00x multiplier
    pub const DEFAULT_FUNDING_INV_SCALE_NOTIONAL_E6: u128 = 1_000_000_000_000; // Funding scale factor (e6 units)
    pub const DEFAULT_FUNDING_MAX_PREMIUM_BPS: i64 = 500;          // cap premium at 5.00%
    pub const DEFAULT_FUNDING_MAX_BPS_PER_SLOT: i64 = 5;           // cap per-slot funding
    pub const DEFAULT_HYPERP_PRICE_CAP_E2BPS: u64 = 10_000;       // 1% per slot max price change for Hyperp

    // Matcher call ABI offsets (67-byte layout)
    // byte 0: tag (u8)
    // 1..9: req_id (u64)
    // 9..11: lp_idx (u16)
    // 11..19: lp_account_id (u64)
    // 19..27: oracle_price_e6 (u64)
    // 27..43: req_size (i128)
    // 43..67: reserved (must be zero)
    pub const CALL_OFF_TAG: usize = 0;
    pub const CALL_OFF_REQ_ID: usize = 1;
    pub const CALL_OFF_LP_IDX: usize = 9;
    pub const CALL_OFF_LP_ACCOUNT_ID: usize = 11;
    pub const CALL_OFF_ORACLE_PRICE: usize = 19;
    pub const CALL_OFF_REQ_SIZE: usize = 27;
    pub const CALL_OFF_PADDING: usize = 43;

    // Matcher return ABI offsets (64-byte prefix)
    pub const RET_OFF_ABI_VERSION: usize = 0;
    pub const RET_OFF_FLAGS: usize = 4;
    pub const RET_OFF_EXEC_PRICE: usize = 8;
    pub const RET_OFF_EXEC_SIZE: usize = 16;
    pub const RET_OFF_REQ_ID: usize = 32;
    pub const RET_OFF_LP_ACCOUNT_ID: usize = 40;
    pub const RET_OFF_ORACLE_PRICE: usize = 48;
    pub const RET_OFF_RESERVED: usize = 56;

    // Default threshold parameters (used at init_market, can be changed via update_config)
    pub const DEFAULT_THRESH_FLOOR: u128 = 0;
    pub const DEFAULT_THRESH_RISK_BPS: u64 = 50;              // 0.50%
    pub const DEFAULT_THRESH_UPDATE_INTERVAL_SLOTS: u64 = 10;
    pub const DEFAULT_THRESH_STEP_BPS: u64 = 500;             // 5% max step
    pub const DEFAULT_THRESH_ALPHA_BPS: u64 = 1000;           // 10% EWMA
    pub const DEFAULT_THRESH_MIN: u128 = 0;
    pub const DEFAULT_THRESH_MAX: u128 = 10_000_000_000_000_000_000u128;
    pub const DEFAULT_THRESH_MIN_STEP: u128 = 1;
}

// 1b. Risk metric helpers (pure functions for anti-DoS threshold calculation)

/// LP risk state: (sum_abs, max_abs) over all LP positions.
/// LP aggregate risk state for O(1) risk delta checks.
/// Uses engine's maintained aggregates instead of scanning.
pub struct LpRiskState {
    pub sum_abs: u128,
    pub max_abs: u128,
}

impl LpRiskState {
    /// Get LP aggregate risk state from engine's maintained fields. O(1).
    #[inline]
    pub fn compute(engine: &percolator::RiskEngine) -> Self {
        Self {
            sum_abs: engine.lp_sum_abs.get(),
            max_abs: engine.lp_max_abs.get(),
        }
    }

    /// Current risk metric: max_concentration + sum_abs/8
    #[inline]
    pub fn risk(&self) -> u128 {
        self.max_abs.saturating_add(self.sum_abs / 8)
    }

    /// O(1) check: would applying delta to LP at lp_idx increase system risk?
    /// delta is the LP's position change (negative of user's trade size).
    /// Conservative: when LP was max and shrinks, we keep max_abs (overestimates risk, safe).
    #[inline]
    pub fn would_increase_risk(&self, old_lp_pos: i128, delta: i128) -> bool {
        let old_lp_abs = old_lp_pos.unsigned_abs();
        let new_lp_pos = old_lp_pos.saturating_add(delta);
        let new_lp_abs = new_lp_pos.unsigned_abs();

        // Guard: old_lp_abs must be part of sum_abs (caller must use same engine snapshot)
        #[cfg(debug_assertions)]
        debug_assert!(self.sum_abs >= old_lp_abs, "old_lp_abs not in sum_abs - wrong engine snapshot?");

        // Update sum_abs in O(1)
        let new_sum_abs = self.sum_abs
            .saturating_sub(old_lp_abs)
            .saturating_add(new_lp_abs);

        // Update max_abs in O(1) (conservative when LP was max and shrinks)
        let new_max_abs = if new_lp_abs >= self.max_abs {
            // LP becomes new max (or ties)
            new_lp_abs
        } else if old_lp_abs == self.max_abs && new_lp_abs < old_lp_abs {
            // LP was max and shrunk - we don't know second-largest without scan.
            // Conservative: keep old max (overestimates risk, which is safe for gating).
            self.max_abs
        } else {
            // LP wasn't max, stays not max
            self.max_abs
        };

        let old_risk = self.risk();
        let new_risk = new_max_abs.saturating_add(new_sum_abs / 8);
        new_risk > old_risk
    }
}

/// Compute system risk units for threshold calculation. O(1).
/// Uses engine's maintained LP aggregates instead of scanning.
#[inline]
pub fn compute_system_risk_units(engine: &percolator::RiskEngine) -> u128 {
    LpRiskState::compute(engine).risk()
}

/// Compute net LP position for inventory-based funding. O(1).
/// Uses engine's maintained net_lp_pos instead of scanning.
#[inline]
fn compute_net_lp_pos(engine: &percolator::RiskEngine) -> i128 {
    engine.net_lp_pos.get()
}

/// Compute inventory-based funding rate (bps per slot).
///
/// Engine convention:
///   funding_rate_bps_per_slot > 0 => longs pay shorts
///   (because pnl -= position * ΔF, ΔF>0 when rate>0)
///
/// Policy: rate sign follows LP inventory sign to push net_lp_pos toward 0.
///   - If LP net long (net_lp_pos > 0), rate > 0 => longs pay => discourages longs => pushes inventory toward 0.
///   - If LP net short (net_lp_pos < 0), rate < 0 => shorts pay => discourages shorts => pushes inventory toward 0.
pub fn compute_inventory_funding_bps_per_slot(
    net_lp_pos: i128,
    price_e6: u64,
    funding_horizon_slots: u64,
    funding_k_bps: u64,
    funding_inv_scale_notional_e6: u128,
    funding_max_premium_bps: i64,
    funding_max_bps_per_slot: i64,
) -> i64 {
    if net_lp_pos == 0 || price_e6 == 0 || funding_horizon_slots == 0 {
        return 0;
    }

    let abs_pos: u128 = net_lp_pos.unsigned_abs();
    let notional_e6: u128 = abs_pos.saturating_mul(price_e6 as u128) / 1_000_000u128;

    // premium_bps = (notional / scale) * k_bps, capped
    let mut premium_bps_u: u128 = notional_e6
        .saturating_mul(funding_k_bps as u128)
        / funding_inv_scale_notional_e6.max(1);

    if premium_bps_u > (funding_max_premium_bps.unsigned_abs() as u128) {
        premium_bps_u = funding_max_premium_bps.unsigned_abs() as u128;
    }

    // Apply sign: if LP net long (net_lp_pos > 0), funding is positive
    let signed_premium_bps: i64 = if net_lp_pos > 0 {
        premium_bps_u as i64
    } else {
        -(premium_bps_u as i64)
    };

    // Convert to per-slot by dividing by horizon
    let mut per_slot: i64 = signed_premium_bps / (funding_horizon_slots as i64);

    // Sanity clamp: absolute max ±10000 bps/slot (100% per slot) to catch overflow bugs
    per_slot = per_slot.clamp(-10_000, 10_000);

    // Policy clamp: tighter bound per config
    if per_slot > funding_max_bps_per_slot { per_slot = funding_max_bps_per_slot; }
    if per_slot < -funding_max_bps_per_slot { per_slot = -funding_max_bps_per_slot; }
    per_slot
}

// =============================================================================
// Pure helpers for Kani verification (program-level invariants only)
// =============================================================================

/// Pure verification helpers for program-level authorization and CPI binding.
/// These are tested by Kani to prove wrapper-level security properties.
pub mod verify {
    use crate::constants::MATCHER_CONTEXT_LEN;

    /// Owner authorization: stored owner must match signer.
    /// Used by: DepositCollateral, WithdrawCollateral, TradeNoCpi, TradeCpi, CloseAccount
    #[inline]
    pub fn owner_ok(stored: [u8; 32], signer: [u8; 32]) -> bool {
        stored == signer
    }

    /// Admin authorization: admin must be non-zero (not burned) and match signer.
    /// Used by: SetRiskThreshold, UpdateAdmin
    #[inline]
    pub fn admin_ok(admin: [u8; 32], signer: [u8; 32]) -> bool {
        admin != [0u8; 32] && admin == signer
    }

    /// CPI identity binding: matcher program and context must match LP registration.
    /// This is the critical CPI security check.
    #[inline]
    pub fn matcher_identity_ok(
        lp_matcher_program: [u8; 32],
        lp_matcher_context: [u8; 32],
        provided_program: [u8; 32],
        provided_context: [u8; 32],
    ) -> bool {
        lp_matcher_program == provided_program && lp_matcher_context == provided_context
    }

    /// Matcher account shape validation.
    /// Checks: program is executable, context is not executable,
    /// context owner is program, context has sufficient length.
    #[derive(Clone, Copy)]
    pub struct MatcherAccountsShape {
        pub prog_executable: bool,
        pub ctx_executable: bool,
        pub ctx_owner_is_prog: bool,
        pub ctx_len_ok: bool,
    }

    #[inline]
    pub fn matcher_shape_ok(shape: MatcherAccountsShape) -> bool {
        shape.prog_executable
            && !shape.ctx_executable
            && shape.ctx_owner_is_prog
            && shape.ctx_len_ok
    }

    /// Check if context length meets minimum requirement.
    #[inline]
    pub fn ctx_len_sufficient(len: usize) -> bool {
        len >= MATCHER_CONTEXT_LEN
    }

    /// Gating is active when threshold > 0 AND balance <= threshold.
    #[inline]
    pub fn gate_active(threshold: u128, balance: u128) -> bool {
        threshold > 0 && balance <= threshold
    }

    /// Nonce update on success: advances by 1.
    #[inline]
    pub fn nonce_on_success(old: u64) -> u64 {
        old.wrapping_add(1)
    }

    /// Nonce update on failure: unchanged.
    #[inline]
    pub fn nonce_on_failure(old: u64) -> u64 {
        old
    }

    /// PDA key comparison: provided key must match expected derived key.
    #[inline]
    pub fn pda_key_matches(expected: [u8; 32], provided: [u8; 32]) -> bool {
        expected == provided
    }

    /// Trade size selection for CPI path: must use exec_size from matcher, not requested size.
    /// Returns the size that should be passed to engine.execute_trade.
    #[inline]
    pub fn cpi_trade_size(exec_size: i128, _requested_size: i128) -> i128 {
        exec_size // Must use exec_size, never requested_size
    }

    // =========================================================================
    // Account validation helpers
    // =========================================================================

    /// Signer requirement: account must be a signer.
    #[inline]
    pub fn signer_ok(is_signer: bool) -> bool {
        is_signer
    }

    /// Writable requirement: account must be writable.
    #[inline]
    pub fn writable_ok(is_writable: bool) -> bool {
        is_writable
    }

    /// Account count requirement: must have at least `need` accounts.
    #[inline]
    pub fn len_ok(actual: usize, need: usize) -> bool {
        actual >= need
    }

    /// LP PDA shape validation for TradeCpi.
    /// PDA must be system-owned, have zero data, and zero lamports.
    #[derive(Clone, Copy)]
    pub struct LpPdaShape {
        pub is_system_owned: bool,
        pub data_len_zero: bool,
        pub lamports_zero: bool,
    }

    #[inline]
    pub fn lp_pda_shape_ok(s: LpPdaShape) -> bool {
        s.is_system_owned && s.data_len_zero && s.lamports_zero
    }

    /// Oracle feed ID check: provided feed_id must match expected config feed_id.
    #[inline]
    pub fn oracle_feed_id_ok(expected: [u8; 32], provided: [u8; 32]) -> bool {
        expected == provided
    }

    /// Slab shape validation.
    /// Slab must be owned by this program and have correct length.
    #[derive(Clone, Copy)]
    pub struct SlabShape {
        pub owned_by_program: bool,
        pub correct_len: bool,
    }

    #[inline]
    pub fn slab_shape_ok(s: SlabShape) -> bool {
        s.owned_by_program && s.correct_len
    }

    // =========================================================================
    // Per-instruction authorization helpers
    // =========================================================================

    /// Single-owner instruction authorization (Deposit, Withdraw, Close).
    #[inline]
    pub fn single_owner_authorized(stored_owner: [u8; 32], signer: [u8; 32]) -> bool {
        owner_ok(stored_owner, signer)
    }

    /// Trade authorization: both user and LP owners must match signers.
    #[inline]
    pub fn trade_authorized(
        user_owner: [u8; 32],
        user_signer: [u8; 32],
        lp_owner: [u8; 32],
        lp_signer: [u8; 32],
    ) -> bool {
        owner_ok(user_owner, user_signer) && owner_ok(lp_owner, lp_signer)
    }

    // =========================================================================
    // TradeCpi decision logic - models the full wrapper policy
    // =========================================================================

    /// Decision outcome for TradeCpi instruction.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum TradeCpiDecision {
        /// Reject the trade - nonce unchanged, no engine call
        Reject,
        /// Accept the trade - nonce incremented, engine called with chosen_size
        Accept { new_nonce: u64, chosen_size: i128 },
    }

    /// Pure decision function for TradeCpi instruction.
    /// Models the wrapper's full policy without touching the risk engine.
    ///
    /// # Arguments
    /// * `old_nonce` - Current nonce before this trade
    /// * `shape` - Matcher account shape validation inputs
    /// * `identity_ok` - Whether matcher identity matches LP registration
    /// * `pda_ok` - Whether LP PDA matches expected derivation
    /// * `abi_ok` - Whether matcher return passes ABI validation
    /// * `user_auth_ok` - Whether user signer matches user owner
    /// * `lp_auth_ok` - Whether LP signer matches LP owner
    /// * `gate_active` - Whether the risk-reduction gate is active
    /// * `risk_increase` - Whether this trade would increase system risk
    /// * `exec_size` - The exec_size from matcher return
    #[inline]
    pub fn decide_trade_cpi(
        old_nonce: u64,
        shape: MatcherAccountsShape,
        identity_ok: bool,
        pda_ok: bool,
        abi_ok: bool,
        user_auth_ok: bool,
        lp_auth_ok: bool,
        gate_active: bool,
        risk_increase: bool,
        exec_size: i128,
    ) -> TradeCpiDecision {
        // Check in order of actual program execution:
        // 1. Matcher shape validation
        if !matcher_shape_ok(shape) {
            return TradeCpiDecision::Reject;
        }
        // 2. PDA validation
        if !pda_ok {
            return TradeCpiDecision::Reject;
        }
        // 3. Owner authorization (user and LP)
        if !user_auth_ok || !lp_auth_ok {
            return TradeCpiDecision::Reject;
        }
        // 4. Matcher identity binding
        if !identity_ok {
            return TradeCpiDecision::Reject;
        }
        // 5. ABI validation (after CPI returns)
        if !abi_ok {
            return TradeCpiDecision::Reject;
        }
        // 6. Risk gate check
        if gate_active && risk_increase {
            return TradeCpiDecision::Reject;
        }
        // All checks passed - accept the trade
        TradeCpiDecision::Accept {
            new_nonce: nonce_on_success(old_nonce),
            chosen_size: cpi_trade_size(exec_size, 0), // 0 is placeholder for requested_size
        }
    }

    /// Extract nonce from TradeCpiDecision.
    #[inline]
    pub fn decision_nonce(old_nonce: u64, decision: TradeCpiDecision) -> u64 {
        match decision {
            TradeCpiDecision::Reject => nonce_on_failure(old_nonce),
            TradeCpiDecision::Accept { new_nonce, .. } => new_nonce,
        }
    }

    // =========================================================================
    // ABI validation from real MatcherReturn inputs
    // =========================================================================

    /// Pure matcher return fields for Kani verification.
    /// Mirrors matcher_abi::MatcherReturn but lives in verify module for Kani access.
    #[derive(Debug, Clone, Copy)]
    pub struct MatcherReturnFields {
        pub abi_version: u32,
        pub flags: u32,
        pub exec_price_e6: u64,
        pub exec_size: i128,
        pub req_id: u64,
        pub lp_account_id: u64,
        pub oracle_price_e6: u64,
        pub reserved: u64,
    }

    impl MatcherReturnFields {
        /// Convert to matcher_abi::MatcherReturn for validation.
        #[inline]
        pub fn to_matcher_return(&self) -> crate::matcher_abi::MatcherReturn {
            crate::matcher_abi::MatcherReturn {
                abi_version: self.abi_version,
                flags: self.flags,
                exec_price_e6: self.exec_price_e6,
                exec_size: self.exec_size,
                req_id: self.req_id,
                lp_account_id: self.lp_account_id,
                oracle_price_e6: self.oracle_price_e6,
                reserved: self.reserved,
            }
        }
    }

    /// ABI validation of matcher return - calls the real validate_matcher_return.
    /// Returns true iff the matcher return passes all ABI checks.
    /// This avoids logic duplication and ensures Kani proofs test the real code.
    #[inline]
    pub fn abi_ok(
        ret: MatcherReturnFields,
        expected_lp_account_id: u64,
        expected_oracle_price_e6: u64,
        req_size: i128,
        expected_req_id: u64,
    ) -> bool {
        let matcher_ret = ret.to_matcher_return();
        crate::matcher_abi::validate_matcher_return(
            &matcher_ret,
            expected_lp_account_id,
            expected_oracle_price_e6,
            req_size,
            expected_req_id,
        ).is_ok()
    }

    /// Decision function for TradeCpi that computes ABI validity from real inputs.
    /// This is the mechanically-tied version that proves program-level policies.
    ///
    /// # Arguments
    /// * `old_nonce` - Current nonce before this trade
    /// * `shape` - Matcher account shape validation inputs
    /// * `identity_ok` - Whether matcher identity matches LP registration
    /// * `pda_ok` - Whether LP PDA matches expected derivation
    /// * `user_auth_ok` - Whether user signer matches user owner
    /// * `lp_auth_ok` - Whether LP signer matches LP owner
    /// * `gate_active` - Whether the risk-reduction gate is active
    /// * `risk_increase` - Whether this trade would increase system risk
    /// * `ret` - The matcher return fields (from CPI)
    /// * `lp_account_id` - Expected LP account ID from request
    /// * `oracle_price_e6` - Expected oracle price from request
    /// * `req_size` - Requested trade size
    #[inline]
    pub fn decide_trade_cpi_from_ret(
        old_nonce: u64,
        shape: MatcherAccountsShape,
        identity_ok: bool,
        pda_ok: bool,
        user_auth_ok: bool,
        lp_auth_ok: bool,
        gate_is_active: bool,
        risk_increase: bool,
        ret: MatcherReturnFields,
        lp_account_id: u64,
        oracle_price_e6: u64,
        req_size: i128,
    ) -> TradeCpiDecision {
        // Check in order of actual program execution:
        // 1. Matcher shape validation
        if !matcher_shape_ok(shape) {
            return TradeCpiDecision::Reject;
        }
        // 2. PDA validation
        if !pda_ok {
            return TradeCpiDecision::Reject;
        }
        // 3. Owner authorization (user and LP)
        if !user_auth_ok || !lp_auth_ok {
            return TradeCpiDecision::Reject;
        }
        // 4. Matcher identity binding
        if !identity_ok {
            return TradeCpiDecision::Reject;
        }
        // 5. Compute req_id from nonce and validate ABI
        let req_id = nonce_on_success(old_nonce);
        if !abi_ok(ret, lp_account_id, oracle_price_e6, req_size, req_id) {
            return TradeCpiDecision::Reject;
        }
        // 6. Risk gate check
        if gate_is_active && risk_increase {
            return TradeCpiDecision::Reject;
        }
        // All checks passed - accept the trade
        TradeCpiDecision::Accept {
            new_nonce: req_id,
            chosen_size: cpi_trade_size(ret.exec_size, req_size),
        }
    }

    // =========================================================================
    // TradeNoCpi decision logic
    // =========================================================================

    /// Decision outcome for TradeNoCpi instruction.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum TradeNoCpiDecision {
        Reject,
        Accept,
    }

    /// Pure decision function for TradeNoCpi instruction.
    #[inline]
    pub fn decide_trade_nocpi(
        user_auth_ok: bool,
        lp_auth_ok: bool,
        gate_active: bool,
        risk_increase: bool,
    ) -> TradeNoCpiDecision {
        if !user_auth_ok || !lp_auth_ok {
            return TradeNoCpiDecision::Reject;
        }
        if gate_active && risk_increase {
            return TradeNoCpiDecision::Reject;
        }
        TradeNoCpiDecision::Accept
    }

    // =========================================================================
    // Other instruction decision logic
    // =========================================================================

    /// Simple Accept/Reject decision for single-check instructions.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum SimpleDecision {
        Reject,
        Accept,
    }

    /// Decision for Deposit/Withdraw/Close: requires owner authorization.
    #[inline]
    pub fn decide_single_owner_op(owner_auth_ok: bool) -> SimpleDecision {
        if owner_auth_ok {
            SimpleDecision::Accept
        } else {
            SimpleDecision::Reject
        }
    }

    /// Decision for KeeperCrank:
    /// - Permissionless mode (caller_idx == u16::MAX): always accept
    /// - Self-crank mode: idx must exist AND owner must match signer
    #[inline]
    pub fn decide_crank(
        permissionless: bool,
        idx_exists: bool,
        stored_owner: [u8; 32],
        signer: [u8; 32],
    ) -> SimpleDecision {
        if permissionless {
            SimpleDecision::Accept
        } else if idx_exists && owner_ok(stored_owner, signer) {
            SimpleDecision::Accept
        } else {
            SimpleDecision::Reject
        }
    }

    /// Decision for admin operations (SetRiskThreshold, UpdateAdmin).
    #[inline]
    pub fn decide_admin_op(admin: [u8; 32], signer: [u8; 32]) -> SimpleDecision {
        if admin_ok(admin, signer) {
            SimpleDecision::Accept
        } else {
            SimpleDecision::Reject
        }
    }

    // =========================================================================
    // KeeperCrank with allow_panic decision logic
    // =========================================================================

    /// Decision for KeeperCrank with allow_panic support.
    /// - If allow_panic != 0: requires admin authorization
    /// - If allow_panic == 0 and permissionless: always accept
    /// - If allow_panic == 0 and self-crank: requires idx exists and owner match
    #[inline]
    pub fn decide_keeper_crank_with_panic(
        allow_panic: u8,
        admin: [u8; 32],
        signer: [u8; 32],
        permissionless: bool,
        idx_exists: bool,
        stored_owner: [u8; 32],
    ) -> SimpleDecision {
        // If allow_panic is requested, must have admin authorization
        if allow_panic != 0 {
            if !admin_ok(admin, signer) {
                return SimpleDecision::Reject;
            }
        }
        // Normal crank logic
        decide_crank(permissionless, idx_exists, stored_owner, signer)
    }

    // =========================================================================
    // Oracle inversion math (pure logic)
    // =========================================================================

    /// Inversion constant: 1e12 for price_e6 * inverted_e6 = 1e12
    pub const INVERSION_CONSTANT: u128 = 1_000_000_000_000;

    /// Invert oracle price: inverted_e6 = 1e12 / raw_e6
    /// Returns None if raw == 0 or result overflows u64.
    #[inline]
    pub fn invert_price_e6(raw: u64, invert: u8) -> Option<u64> {
        if invert == 0 {
            return Some(raw);
        }
        if raw == 0 {
            return None;
        }
        let inverted = INVERSION_CONSTANT / (raw as u128);
        if inverted == 0 {
            return None;
        }
        if inverted > u64::MAX as u128 {
            return None;
        }
        Some(inverted as u64)
    }

    /// Scale oracle price by unit_scale: scaled_e6 = price_e6 / unit_scale
    /// Returns None if result would be zero (price too small for scale).
    ///
    /// CRITICAL: This ensures oracle-derived values (entry_price, mark_pnl, position_value)
    /// are in the same scale as capital (which is stored in units via base_to_units).
    /// Without this scaling, margin checks would compare units to base tokens incorrectly.
    #[inline]
    pub fn scale_price_e6(price: u64, unit_scale: u32) -> Option<u64> {
        if unit_scale <= 1 {
            return Some(price);
        }
        let scaled = price / unit_scale as u64;
        if scaled == 0 {
            return None;
        }
        Some(scaled)
    }

    // =========================================================================
    // Unit scale conversion math (pure logic)
    // =========================================================================

    /// Convert base amount to (units, dust).
    /// If scale == 0: returns (base, 0).
    /// Otherwise: units = base / scale, dust = base % scale.
    #[inline]
    pub fn base_to_units(base: u64, scale: u32) -> (u64, u64) {
        if scale == 0 {
            return (base, 0);
        }
        let s = scale as u64;
        (base / s, base % s)
    }

    /// Convert units to base amount (saturating).
    /// If scale == 0: returns units.
    /// Otherwise: returns units * scale (saturating).
    #[inline]
    pub fn units_to_base(units: u64, scale: u32) -> u64 {
        if scale == 0 {
            return units;
        }
        units.saturating_mul(scale as u64)
    }

    // =========================================================================
    // Withdraw alignment check (pure logic)
    // =========================================================================

    /// Check if withdraw amount is properly aligned to unit_scale.
    /// If scale == 0: always aligned.
    /// Otherwise: amount must be divisible by scale.
    #[inline]
    pub fn withdraw_amount_aligned(amount: u64, scale: u32) -> bool {
        if scale == 0 {
            return true;
        }
        amount % (scale as u64) == 0
    }

    // =========================================================================
    // Dust bookkeeping math (pure logic)
    // =========================================================================

    /// Accumulate dust: old_dust + added_dust (saturating).
    #[inline]
    pub fn accumulate_dust(old_dust: u64, added_dust: u64) -> u64 {
        old_dust.saturating_add(added_dust)
    }

    /// Sweep dust into units: returns (units_swept, remaining_dust).
    /// If scale == 0: returns (dust, 0) - all dust becomes units.
    /// Otherwise: units_swept = dust / scale, remaining = dust % scale.
    #[inline]
    pub fn sweep_dust(dust: u64, scale: u32) -> (u64, u64) {
        if scale == 0 {
            return (dust, 0);
        }
        let s = scale as u64;
        (dust / s, dust % s)
    }

    // =========================================================================
    // InitMarket scale validation (pure logic)
    // =========================================================================

    /// Validate unit_scale for InitMarket instruction.
    /// Returns true if scale is within allowed bounds.
    /// scale=0: disables scaling, 1:1 base tokens to units, dust always 0.
    /// scale=1..=MAX_UNIT_SCALE: enables scaling with dust tracking.
    #[inline]
    pub fn init_market_scale_ok(unit_scale: u32) -> bool {
        unit_scale <= crate::constants::MAX_UNIT_SCALE
    }

}

// 2. mod zc (Zero-Copy unsafe island)
#[allow(unsafe_code)]
pub mod zc {
    use solana_program::program_error::ProgramError;
    use percolator::RiskEngine;
    use crate::constants::{ENGINE_OFF, ENGINE_LEN, ENGINE_ALIGN};
    use core::mem::offset_of;

    // Use const to export the actual offset for debugging
    pub const ACCOUNTS_OFFSET: usize = offset_of!(RiskEngine, accounts);

    /// Old slab length (before Account struct reordering migration)
    /// Old slabs support up to 4095 accounts, new slabs support 4096.
    const OLD_ENGINE_LEN: usize = ENGINE_LEN - 8;

    #[inline]
    pub fn engine_ref<'a>(data: &'a [u8]) -> Result<&'a RiskEngine, ProgramError> {
        // Accept old slabs (ENGINE_LEN - 8) for backward compatibility
        if data.len() < ENGINE_OFF + OLD_ENGINE_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let ptr = unsafe { data.as_ptr().add(ENGINE_OFF) };
        if (ptr as usize) % ENGINE_ALIGN != 0 {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &*(ptr as *const RiskEngine) })
    }

    #[inline]
    pub fn engine_mut<'a>(data: &'a mut [u8]) -> Result<&'a mut RiskEngine, ProgramError> {
        // Accept old slabs (ENGINE_LEN - 8) for backward compatibility
        if data.len() < ENGINE_OFF + OLD_ENGINE_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let ptr = unsafe { data.as_mut_ptr().add(ENGINE_OFF) };
        if (ptr as usize) % ENGINE_ALIGN != 0 {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &mut *(ptr as *mut RiskEngine) })
    }

    // NOTE: engine_write was removed because it requires passing RiskEngine by value,
    // which stack-allocates the ~6MB struct and causes stack overflow in BPF.
    // Use engine_mut() + init_in_place() instead for initialization.

    use solana_program::{
        account_info::AccountInfo,
        instruction::Instruction as SolInstruction,
        program::invoke_signed,
    };

    /// Invoke the matcher program via CPI with proper lifetime coercion.
    ///
    /// This is the ONLY place where unsafe lifetime transmute is allowed.
    /// The transmute is sound because:
    /// - We are shortening lifetime from 'a (caller) to local scope
    /// - The AccountInfo is only used for the duration of invoke_signed
    /// - We don't hold references past the function call
    #[inline]
    #[allow(unsafe_code)]
    pub fn invoke_signed_trade<'a>(
        ix: &SolInstruction,
        a_lp_pda: &AccountInfo<'a>,
        a_matcher_ctx: &AccountInfo<'a>,
        seeds: &[&[u8]],
    ) -> Result<(), ProgramError> {
        // SAFETY: AccountInfos have lifetime 'a from the caller.
        // We clone them to get owned values (still with 'a lifetime internally).
        // The invoke_signed call consumes them by reference and returns.
        // No lifetime extension occurs.
        let infos = [a_lp_pda.clone(), a_matcher_ctx.clone()];
        invoke_signed(ix, &infos, &[seeds])
    }
}

pub mod matcher_abi {
    use solana_program::program_error::ProgramError;
    use crate::constants::MATCHER_ABI_VERSION;

    /// Matcher return flags
    pub const FLAG_VALID: u32 = 1;       // bit0: response is valid
    pub const FLAG_PARTIAL_OK: u32 = 2;  // bit1: partial fill including zero allowed
    pub const FLAG_REJECTED: u32 = 4;    // bit2: trade rejected by matcher

    #[repr(C)]
    #[derive(Debug, Clone, Copy)]
    pub struct MatcherReturn {
        pub abi_version: u32,
        pub flags: u32,
        pub exec_price_e6: u64,
        pub exec_size: i128,
        pub req_id: u64,
        pub lp_account_id: u64,
        pub oracle_price_e6: u64,
        pub reserved: u64,
    }

    pub fn read_matcher_return(ctx: &[u8]) -> Result<MatcherReturn, ProgramError> {
        if ctx.len() < 64 { return Err(ProgramError::InvalidAccountData); }
        let abi_version = u32::from_le_bytes(ctx[0..4].try_into().unwrap());
        let flags = u32::from_le_bytes(ctx[4..8].try_into().unwrap());
        let exec_price_e6 = u64::from_le_bytes(ctx[8..16].try_into().unwrap());
        let exec_size = i128::from_le_bytes(ctx[16..32].try_into().unwrap());
        let req_id = u64::from_le_bytes(ctx[32..40].try_into().unwrap());
        let lp_account_id = u64::from_le_bytes(ctx[40..48].try_into().unwrap());
        let oracle_price_e6 = u64::from_le_bytes(ctx[48..56].try_into().unwrap());
        let reserved = u64::from_le_bytes(ctx[56..64].try_into().unwrap());

        Ok(MatcherReturn {
            abi_version, flags, exec_price_e6, exec_size, req_id, lp_account_id, oracle_price_e6, reserved
        })
    }

    pub fn validate_matcher_return(ret: &MatcherReturn, lp_account_id: u64, oracle_price_e6: u64, req_size: i128, req_id: u64) -> Result<(), ProgramError> {
        // Check ABI version
        if ret.abi_version != MATCHER_ABI_VERSION { return Err(ProgramError::InvalidAccountData); }
        // Must have VALID flag set
        if (ret.flags & FLAG_VALID) == 0 { return Err(ProgramError::InvalidAccountData); }
        // Must not have REJECTED flag set
        if (ret.flags & FLAG_REJECTED) != 0 { return Err(ProgramError::InvalidAccountData); }

        // Validate echoed fields match request
        if ret.lp_account_id != lp_account_id { return Err(ProgramError::InvalidAccountData); }
        if ret.oracle_price_e6 != oracle_price_e6 { return Err(ProgramError::InvalidAccountData); }
        if ret.reserved != 0 { return Err(ProgramError::InvalidAccountData); }
        if ret.req_id != req_id { return Err(ProgramError::InvalidAccountData); }

        // Require exec_price_e6 != 0 always - avoids "all zeros but valid flag" ambiguity
        if ret.exec_price_e6 == 0 { return Err(ProgramError::InvalidAccountData); }

        // Zero exec_size requires PARTIAL_OK flag
        if ret.exec_size == 0 {
            if (ret.flags & FLAG_PARTIAL_OK) == 0 {
                return Err(ProgramError::InvalidAccountData);
            }
            // Zero fill with PARTIAL_OK is allowed - return early
            return Ok(());
        }

        // Size constraints (use unsigned_abs to avoid i128::MIN overflow)
        if ret.exec_size.unsigned_abs() > req_size.unsigned_abs() { return Err(ProgramError::InvalidAccountData); }
        if req_size != 0 {
            if ret.exec_size.signum() != req_size.signum() { return Err(ProgramError::InvalidAccountData); }
        }
        Ok(())
    }
}

// 3. mod error
pub mod error {
    use solana_program::program_error::ProgramError;
    use percolator::RiskError;

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub enum PercolatorError {
        InvalidMagic,
        InvalidVersion,
        AlreadyInitialized,
        NotInitialized,
        InvalidSlabLen,
        InvalidOracleKey,
        OracleStale,
        OracleConfTooWide,
        InvalidVaultAta,
        InvalidMint,
        ExpectedSigner,
        ExpectedWritable,
        OracleInvalid,
        EngineInsufficientBalance,
        EngineUndercollateralized,
        EngineUnauthorized,
        EngineInvalidMatchingEngine,
        EnginePnlNotWarmedUp,
        EngineOverflow,
        EngineAccountNotFound,
        EngineNotAnLPAccount,
        EnginePositionSizeMismatch,
        EngineRiskReductionOnlyMode,
        EngineAccountKindMismatch,
        InvalidTokenAccount,
        InvalidTokenProgram,
        InvalidConfigParam,
        HyperpTradeNoCpiDisabled,
        InsuranceMintAlreadyExists,
        InsuranceMintNotCreated,
        InsuranceBelowThreshold,
        InsuranceZeroAmount,
        InsuranceSupplyMismatch,
    }

    impl From<PercolatorError> for ProgramError {
        fn from(e: PercolatorError) -> Self {
            ProgramError::Custom(e as u32)
        }
    }

    pub fn map_risk_error(e: RiskError) -> ProgramError {
        let err = match e {
            RiskError::InsufficientBalance => PercolatorError::EngineInsufficientBalance,
            RiskError::Undercollateralized => PercolatorError::EngineUndercollateralized,
            RiskError::Unauthorized => PercolatorError::EngineUnauthorized,
            RiskError::InvalidMatchingEngine => PercolatorError::EngineInvalidMatchingEngine,
            RiskError::PnlNotWarmedUp => PercolatorError::EnginePnlNotWarmedUp,
            RiskError::Overflow => PercolatorError::EngineOverflow,
            RiskError::AccountNotFound => PercolatorError::EngineAccountNotFound,
            RiskError::NotAnLPAccount => PercolatorError::EngineNotAnLPAccount,
            RiskError::PositionSizeMismatch => PercolatorError::EnginePositionSizeMismatch,
            RiskError::AccountKindMismatch => PercolatorError::EngineAccountKindMismatch,
        };
        ProgramError::Custom(err as u32)
    }
}

// 4. mod ix
pub mod ix {
    use solana_program::{pubkey::Pubkey, program_error::ProgramError};
    use percolator::{RiskParams, U128};

    #[derive(Debug)]
    pub enum Instruction {
        InitMarket {
            admin: Pubkey,
            collateral_mint: Pubkey,
            /// Pyth feed ID for the index price (32 bytes).
            /// If all zeros, enables Hyperp mode (internal mark/index, no external oracle).
            index_feed_id: [u8; 32],
            /// Maximum staleness in seconds
            max_staleness_secs: u64,
            conf_filter_bps: u16,
            /// If non-zero, invert oracle price (raw -> 1e12/raw)
            invert: u8,
            /// Lamports per Unit for boundary conversion (0 = no scaling)
            unit_scale: u32,
            /// Initial mark price in e6 format. Required (non-zero) if Hyperp mode.
            initial_mark_price_e6: u64,
            risk_params: RiskParams,
        },
        InitUser { fee_payment: u64 },
        InitLP { matcher_program: Pubkey, matcher_context: Pubkey, fee_payment: u64 },
        DepositCollateral { user_idx: u16, amount: u64 },
        WithdrawCollateral { user_idx: u16, amount: u64 },
        KeeperCrank { caller_idx: u16, allow_panic: u8 },
        TradeNoCpi { lp_idx: u16, user_idx: u16, size: i128 },
        LiquidateAtOracle { target_idx: u16 },
        CloseAccount { user_idx: u16 },
        TopUpInsurance { amount: u64 },
        TradeCpi { lp_idx: u16, user_idx: u16, size: i128 },
        SetRiskThreshold { new_threshold: u128 },
        UpdateAdmin { new_admin: Pubkey },
        /// Close the market slab and recover SOL to admin.
        /// Requires: no active accounts, no vault funds, no insurance funds.
        CloseSlab,
        /// Update configurable parameters (funding + threshold). Admin only.
        UpdateConfig {
            funding_horizon_slots: u64,
            funding_k_bps: u64,
            funding_inv_scale_notional_e6: u128,
            funding_max_premium_bps: i64,
            funding_max_bps_per_slot: i64,
            thresh_floor: u128,
            thresh_risk_bps: u64,
            thresh_update_interval_slots: u64,
            thresh_step_bps: u64,
            thresh_alpha_bps: u64,
            thresh_min: u128,
            thresh_max: u128,
            thresh_min_step: u128,
        },
        /// Set maintenance fee per slot (admin only)
        SetMaintenanceFee { new_fee: u128 },
        /// Set the oracle price authority (admin only).
        /// Authority can push prices instead of requiring Pyth/Chainlink.
        /// Pass zero pubkey to disable and require Pyth/Chainlink.
        SetOracleAuthority { new_authority: Pubkey },
        /// Push oracle price (oracle authority only).
        /// Stores the price for use by crank/trade operations.
        PushOraclePrice { price_e6: u64, timestamp: i64 },
        /// Set oracle price circuit breaker cap (admin only).
        /// max_change_e2bps in 0.01 bps units (1_000_000 = 100%). 0 = disabled.
        SetOraclePriceCap { max_change_e2bps: u64 },
        /// Resolve market: force-close all positions at admin oracle price, enter withdraw-only mode.
        /// Admin only. Uses authority_price_e6 as settlement price.
        ResolveMarket,
        /// Withdraw insurance fund balance (admin only, requires RESOLVED flag).
        WithdrawInsurance,
        /// Admin force-close: unconditionally close any position at oracle price.
        /// Skips margin checks. Admin only.
        AdminForceClose { target_idx: u16 },
        /// Update initial and maintenance margin BPS. Admin only.
        UpdateRiskParams { initial_margin_bps: u64, maintenance_margin_bps: u64 },
        /// Renounce admin: set admin to all zeros (irreversible). Admin only.
        RenounceAdmin,
        /// Create the insurance LP SPL mint for this market. Admin only, once per market.
        /// Mint PDA: ["ins_lp", slab_pubkey]. Authority: vault PDA.
        CreateInsuranceMint,
        /// Deposit collateral into insurance fund, receive LP tokens proportional to share.
        /// Permissionless. LP tokens are freely transferable.
        DepositInsuranceLP { amount: u64 },
        /// Burn LP tokens and withdraw proportional share of insurance fund.
        /// Cannot withdraw below risk_reduction_threshold.
        WithdrawInsuranceLP { lp_amount: u64 },
    }

    impl Instruction {
        pub fn decode(input: &[u8]) -> Result<Self, ProgramError> {
            let (&tag, mut rest) = input.split_first().ok_or(ProgramError::InvalidInstructionData)?;
            
            match tag {
                0 => { // InitMarket
                    let admin = read_pubkey(&mut rest)?;
                    let collateral_mint = read_pubkey(&mut rest)?;
                    let index_feed_id = read_bytes32(&mut rest)?;
                    let max_staleness_secs = read_u64(&mut rest)?;
                    let conf_filter_bps = read_u16(&mut rest)?;
                    let invert = read_u8(&mut rest)?;
                    let unit_scale = read_u32(&mut rest)?;
                    let initial_mark_price_e6 = read_u64(&mut rest)?;
                    let risk_params = read_risk_params(&mut rest)?;
                    Ok(Instruction::InitMarket {
                        admin, collateral_mint, index_feed_id,
                        max_staleness_secs, conf_filter_bps, invert, unit_scale,
                        initial_mark_price_e6, risk_params
                    })
                },
                1 => { // InitUser
                    let fee_payment = read_u64(&mut rest)?;
                    Ok(Instruction::InitUser { fee_payment })
                },
                2 => { // InitLP
                    let matcher_program = read_pubkey(&mut rest)?;
                    let matcher_context = read_pubkey(&mut rest)?;
                    let fee_payment = read_u64(&mut rest)?;
                    Ok(Instruction::InitLP { matcher_program, matcher_context, fee_payment })
                },
                3 => { // Deposit
                    let user_idx = read_u16(&mut rest)?;
                    let amount = read_u64(&mut rest)?;
                    Ok(Instruction::DepositCollateral { user_idx, amount })
                },
                4 => { // Withdraw
                    let user_idx = read_u16(&mut rest)?;
                    let amount = read_u64(&mut rest)?;
                    Ok(Instruction::WithdrawCollateral { user_idx, amount })
                },
                5 => { // KeeperCrank
                    let caller_idx = read_u16(&mut rest)?;
                    let allow_panic = read_u8(&mut rest)?;
                    Ok(Instruction::KeeperCrank { caller_idx, allow_panic })
                },
                6 => { // TradeNoCpi
                    let lp_idx = read_u16(&mut rest)?;
                    let user_idx = read_u16(&mut rest)?;
                    let size = read_i128(&mut rest)?;
                    Ok(Instruction::TradeNoCpi { lp_idx, user_idx, size })
                },
                7 => { // LiquidateAtOracle
                    let target_idx = read_u16(&mut rest)?;
                    Ok(Instruction::LiquidateAtOracle { target_idx })
                },
                8 => { // CloseAccount
                    let user_idx = read_u16(&mut rest)?;
                    Ok(Instruction::CloseAccount { user_idx })
                },
                9 => { // TopUpInsurance
                    let amount = read_u64(&mut rest)?;
                    Ok(Instruction::TopUpInsurance { amount })
                },
                10 => { // TradeCpi
                    let lp_idx = read_u16(&mut rest)?;
                    let user_idx = read_u16(&mut rest)?;
                    let size = read_i128(&mut rest)?;
                    Ok(Instruction::TradeCpi { lp_idx, user_idx, size })
                },
                11 => { // SetRiskThreshold
                    let new_threshold = read_u128(&mut rest)?;
                    Ok(Instruction::SetRiskThreshold { new_threshold })
                },
                12 => { // UpdateAdmin
                    let new_admin = read_pubkey(&mut rest)?;
                    Ok(Instruction::UpdateAdmin { new_admin })
                },
                13 => { // CloseSlab
                    Ok(Instruction::CloseSlab)
                },
                14 => { // UpdateConfig
                    let funding_horizon_slots = read_u64(&mut rest)?;
                    let funding_k_bps = read_u64(&mut rest)?;
                    let funding_inv_scale_notional_e6 = read_u128(&mut rest)?;
                    let funding_max_premium_bps = read_i64(&mut rest)?;
                    let funding_max_bps_per_slot = read_i64(&mut rest)?;
                    let thresh_floor = read_u128(&mut rest)?;
                    let thresh_risk_bps = read_u64(&mut rest)?;
                    let thresh_update_interval_slots = read_u64(&mut rest)?;
                    let thresh_step_bps = read_u64(&mut rest)?;
                    let thresh_alpha_bps = read_u64(&mut rest)?;
                    let thresh_min = read_u128(&mut rest)?;
                    let thresh_max = read_u128(&mut rest)?;
                    let thresh_min_step = read_u128(&mut rest)?;
                    Ok(Instruction::UpdateConfig {
                        funding_horizon_slots, funding_k_bps, funding_inv_scale_notional_e6,
                        funding_max_premium_bps, funding_max_bps_per_slot,
                        thresh_floor, thresh_risk_bps, thresh_update_interval_slots,
                        thresh_step_bps, thresh_alpha_bps, thresh_min, thresh_max, thresh_min_step,
                    })
                },
                15 => { // SetMaintenanceFee
                    let new_fee = read_u128(&mut rest)?;
                    Ok(Instruction::SetMaintenanceFee { new_fee })
                },
                16 => { // SetOracleAuthority
                    let new_authority = read_pubkey(&mut rest)?;
                    Ok(Instruction::SetOracleAuthority { new_authority })
                },
                17 => { // PushOraclePrice
                    let price_e6 = read_u64(&mut rest)?;
                    let timestamp = read_i64(&mut rest)?;
                    Ok(Instruction::PushOraclePrice { price_e6, timestamp })
                },
                18 => { // SetOraclePriceCap
                    let max_change_e2bps = read_u64(&mut rest)?;
                    Ok(Instruction::SetOraclePriceCap { max_change_e2bps })
                },
                19 => Ok(Instruction::ResolveMarket),
                20 => Ok(Instruction::WithdrawInsurance),
                21 => { // AdminForceClose
                    let target_idx = read_u16(&mut rest)?;
                    Ok(Instruction::AdminForceClose { target_idx })
                },
                22 => { // UpdateRiskParams
                    let initial_margin_bps = read_u64(&mut rest)?;
                    let maintenance_margin_bps = read_u64(&mut rest)?;
                    Ok(Instruction::UpdateRiskParams { initial_margin_bps, maintenance_margin_bps })
                },
                23 => Ok(Instruction::RenounceAdmin),
                24 => Ok(Instruction::CreateInsuranceMint),
                25 => { // DepositInsuranceLP
                    let amount = read_u64(&mut rest)?;
                    Ok(Instruction::DepositInsuranceLP { amount })
                },
                26 => { // WithdrawInsuranceLP
                    let lp_amount = read_u64(&mut rest)?;
                    Ok(Instruction::WithdrawInsuranceLP { lp_amount })
                },
                _ => Err(ProgramError::InvalidInstructionData),
            }
        }
    }

    fn read_u8(input: &mut &[u8]) -> Result<u8, ProgramError> {
        let (&val, rest) = input.split_first().ok_or(ProgramError::InvalidInstructionData)?;
        *input = rest;
        Ok(val)
    }

    fn read_u16(input: &mut &[u8]) -> Result<u16, ProgramError> {
        if input.len() < 2 { return Err(ProgramError::InvalidInstructionData); }
        let (bytes, rest) = input.split_at(2);
        *input = rest;
        Ok(u16::from_le_bytes(bytes.try_into().unwrap()))
    }

    fn read_u32(input: &mut &[u8]) -> Result<u32, ProgramError> {
        if input.len() < 4 { return Err(ProgramError::InvalidInstructionData); }
        let (bytes, rest) = input.split_at(4);
        *input = rest;
        Ok(u32::from_le_bytes(bytes.try_into().unwrap()))
    }

    fn read_u64(input: &mut &[u8]) -> Result<u64, ProgramError> {
        if input.len() < 8 { return Err(ProgramError::InvalidInstructionData); }
        let (bytes, rest) = input.split_at(8);
        *input = rest;
        Ok(u64::from_le_bytes(bytes.try_into().unwrap()))
    }

    fn read_i64(input: &mut &[u8]) -> Result<i64, ProgramError> {
        if input.len() < 8 { return Err(ProgramError::InvalidInstructionData); }
        let (bytes, rest) = input.split_at(8);
        *input = rest;
        Ok(i64::from_le_bytes(bytes.try_into().unwrap()))
    }

    fn read_i128(input: &mut &[u8]) -> Result<i128, ProgramError> {
        if input.len() < 16 { return Err(ProgramError::InvalidInstructionData); }
        let (bytes, rest) = input.split_at(16);
        *input = rest;
        Ok(i128::from_le_bytes(bytes.try_into().unwrap()))
    }

    fn read_u128(input: &mut &[u8]) -> Result<u128, ProgramError> {
        if input.len() < 16 { return Err(ProgramError::InvalidInstructionData); }
        let (bytes, rest) = input.split_at(16);
        *input = rest;
        Ok(u128::from_le_bytes(bytes.try_into().unwrap()))
    }

    fn read_pubkey(input: &mut &[u8]) -> Result<Pubkey, ProgramError> {
        if input.len() < 32 { return Err(ProgramError::InvalidInstructionData); }
        let (bytes, rest) = input.split_at(32);
        *input = rest;
        Ok(Pubkey::new_from_array(bytes.try_into().unwrap()))
    }

    fn read_bytes32(input: &mut &[u8]) -> Result<[u8; 32], ProgramError> {
        if input.len() < 32 { return Err(ProgramError::InvalidInstructionData); }
        let (bytes, rest) = input.split_at(32);
        *input = rest;
        Ok(bytes.try_into().unwrap())
    }

    fn read_risk_params(input: &mut &[u8]) -> Result<RiskParams, ProgramError> {
        Ok(RiskParams {
            warmup_period_slots: read_u64(input)?,
            maintenance_margin_bps: read_u64(input)?,
            initial_margin_bps: read_u64(input)?,
            trading_fee_bps: read_u64(input)?,
            max_accounts: read_u64(input)?,
            new_account_fee: U128::new(read_u128(input)?),
            risk_reduction_threshold: U128::new(read_u128(input)?),
            maintenance_fee_per_slot: U128::new(read_u128(input)?),
            max_crank_staleness_slots: read_u64(input)?,
            liquidation_fee_bps: read_u64(input)?,
            liquidation_fee_cap: U128::new(read_u128(input)?),
            liquidation_buffer_bps: read_u64(input)?,
            min_liquidation_abs: U128::new(read_u128(input)?),
        })
    }
}

// 5. mod accounts (Pinocchio validation)
pub mod accounts {
    use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};
    use crate::error::PercolatorError;

    pub fn expect_len(accounts: &[AccountInfo], n: usize) -> Result<(), ProgramError> {
        // Length check via verify helper (Kani-provable)
        if !crate::verify::len_ok(accounts.len(), n) {
            return Err(ProgramError::NotEnoughAccountKeys);
        }
        Ok(())
    }

    pub fn expect_signer(ai: &AccountInfo) -> Result<(), ProgramError> {
        // Signer check via verify helper (Kani-provable)
        if !crate::verify::signer_ok(ai.is_signer) {
            return Err(PercolatorError::ExpectedSigner.into());
        }
        Ok(())
    }

    pub fn expect_writable(ai: &AccountInfo) -> Result<(), ProgramError> {
        // Writable check via verify helper (Kani-provable)
        if !crate::verify::writable_ok(ai.is_writable) {
            return Err(PercolatorError::ExpectedWritable.into());
        }
        Ok(())
    }

    pub fn expect_owner(ai: &AccountInfo, owner: &Pubkey) -> Result<(), ProgramError> {
        if ai.owner != owner {
            return Err(ProgramError::IllegalOwner);
        }
        Ok(())
    }

    pub fn expect_key(ai: &AccountInfo, expected: &Pubkey) -> Result<(), ProgramError> {
        // Key check via verify helper (Kani-provable)
        if !crate::verify::pda_key_matches(expected.to_bytes(), ai.key.to_bytes()) {
            return Err(ProgramError::InvalidArgument);
        }
        Ok(())
    }

    pub fn derive_vault_authority(program_id: &Pubkey, slab_key: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[b"vault", slab_key.as_ref()], program_id)
    }

    pub fn derive_insurance_lp_mint(program_id: &Pubkey, slab_key: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[b"ins_lp", slab_key.as_ref()], program_id)
    }
}

// 6. mod state
pub mod state {
    use bytemuck::{Pod, Zeroable};
    use core::cell::RefMut;
    use core::mem::offset_of;
    use solana_program::account_info::AccountInfo;
    use solana_program::program_error::ProgramError;
    use crate::constants::{HEADER_LEN, CONFIG_LEN};

    #[repr(C)]
    #[derive(Clone, Copy, Pod, Zeroable)]
    pub struct SlabHeader {
        pub magic: u64,
        pub version: u32,
        pub bump: u8,
        pub _padding: [u8; 3],
        pub admin: [u8; 32],
        pub _reserved: [u8; 24], // [0..8]=nonce, [8..16]=last_thr_slot, [16..24]=dust_base
    }

    /// Offset of _reserved field in SlabHeader, derived from offset_of! for correctness.
    pub const RESERVED_OFF: usize = offset_of!(SlabHeader, _reserved);

    // Portable compile-time assertion that RESERVED_OFF is 48 (expected layout)
    const _: [(); 48] = [(); RESERVED_OFF];

    #[repr(C)]
    #[derive(Clone, Copy, Pod, Zeroable)]
    pub struct MarketConfig {
        pub collateral_mint: [u8; 32],
        pub vault_pubkey: [u8; 32],
        /// Pyth feed ID for the index price feed
        pub index_feed_id: [u8; 32],
        /// Maximum staleness in seconds (Pyth Pull uses unix timestamps)
        pub max_staleness_secs: u64,
        pub conf_filter_bps: u16,
        pub vault_authority_bump: u8,
        /// If non-zero, invert the oracle price (raw -> 1e12/raw)
        pub invert: u8,
        /// Lamports per Unit for conversion (e.g., 1000 means 1 SOL = 1,000,000 Units)
        /// If 0, no scaling is applied (1:1 lamports to units)
        pub unit_scale: u32,

        // ========================================
        // Funding Parameters (configurable)
        // ========================================
        /// Funding horizon in slots (~4 min at 500 slots)
        pub funding_horizon_slots: u64,
        /// Funding rate multiplier in basis points (100 = 1.00x)
        pub funding_k_bps: u64,
        /// Funding scale factor in e6 units (controls funding rate sensitivity)
        pub funding_inv_scale_notional_e6: u128,
        /// Max premium in basis points (500 = 5%)
        pub funding_max_premium_bps: i64,
        /// Max funding rate per slot in basis points
        pub funding_max_bps_per_slot: i64,

        // ========================================
        // Threshold Parameters (configurable)
        // ========================================
        /// Floor for threshold calculation
        pub thresh_floor: u128,
        /// Risk coefficient in basis points (50 = 0.5%)
        pub thresh_risk_bps: u64,
        /// Update interval in slots
        pub thresh_update_interval_slots: u64,
        /// Max step size in basis points (500 = 5%)
        pub thresh_step_bps: u64,
        /// EWMA alpha in basis points (1000 = 10%)
        pub thresh_alpha_bps: u64,
        /// Minimum threshold value
        pub thresh_min: u128,
        /// Maximum threshold value
        pub thresh_max: u128,
        /// Minimum step size
        pub thresh_min_step: u128,

        // ========================================
        // Oracle Authority (optional signer-based oracle)
        // ========================================
        /// Oracle price authority pubkey. If non-zero, this signer can push prices
        /// directly instead of requiring Pyth/Chainlink. All zeros = disabled.
        pub oracle_authority: [u8; 32],
        /// Last price pushed by oracle authority (in e6 format, already scaled)
        pub authority_price_e6: u64,
        /// Unix timestamp when authority last pushed the price
        pub authority_timestamp: i64,

        // ========================================
        // Oracle Price Circuit Breaker
        // ========================================
        /// Max oracle price change per update in 0.01 bps (e2bps).
        /// 0 = disabled (no cap). 1_000_000 = 100%.
        pub oracle_price_cap_e2bps: u64,
        /// Last effective oracle price (after clamping), in e6 format.
        /// 0 = no history (first price accepted as-is).
        pub last_effective_price_e6: u64,
    }

    pub fn slab_data_mut<'a, 'b>(ai: &'b AccountInfo<'a>) -> Result<RefMut<'b, &'a mut [u8]>, ProgramError> {
        Ok(ai.try_borrow_mut_data()?)
    }

    pub fn read_header(data: &[u8]) -> SlabHeader {
        let mut h = SlabHeader::zeroed();
        let src = &data[..HEADER_LEN];
        let dst = bytemuck::bytes_of_mut(&mut h);
        dst.copy_from_slice(src);
        h
    }

    pub fn write_header(data: &mut [u8], h: &SlabHeader) {
        let src = bytemuck::bytes_of(h);
        let dst = &mut data[..HEADER_LEN];
        dst.copy_from_slice(src);
    }

    /// Read the request nonce from the reserved field in slab header.
    /// The nonce is stored at RESERVED_OFF..RESERVED_OFF+8 as little-endian u64.
    pub fn read_req_nonce(data: &[u8]) -> u64 {
        u64::from_le_bytes(data[RESERVED_OFF..RESERVED_OFF + 8].try_into().unwrap())
    }

    /// Write the request nonce to the reserved field in slab header.
    /// The nonce is stored in _reserved[0..8] as little-endian u64.
    /// Uses offset_of! for correctness even if SlabHeader layout changes.
    pub fn write_req_nonce(data: &mut [u8], nonce: u64) {
        #[cfg(debug_assertions)]
        debug_assert!(HEADER_LEN >= RESERVED_OFF + 16);
        data[RESERVED_OFF..RESERVED_OFF + 8].copy_from_slice(&nonce.to_le_bytes());
    }

    /// Read the last threshold update slot from _reserved[8..16].
    pub fn read_last_thr_update_slot(data: &[u8]) -> u64 {
        u64::from_le_bytes(data[RESERVED_OFF + 8..RESERVED_OFF + 16].try_into().unwrap())
    }

    /// Write the last threshold update slot to _reserved[8..16].
    pub fn write_last_thr_update_slot(data: &mut [u8], slot: u64) {
        data[RESERVED_OFF + 8..RESERVED_OFF + 16].copy_from_slice(&slot.to_le_bytes());
    }

    /// Read accumulated dust (base token remainder) from _reserved[16..24].
    pub fn read_dust_base(data: &[u8]) -> u64 {
        u64::from_le_bytes(data[RESERVED_OFF + 16..RESERVED_OFF + 24].try_into().unwrap())
    }

    /// Write accumulated dust (base token remainder) to _reserved[16..24].
    pub fn write_dust_base(data: &mut [u8], dust: u64) {
        data[RESERVED_OFF + 16..RESERVED_OFF + 24].copy_from_slice(&dust.to_le_bytes());
    }

    // ========================================
    // Market Flags (stored in _padding[0] at offset 13)
    // ========================================

    /// Offset of flags byte in SlabHeader (_padding[0])
    pub const FLAGS_OFF: usize = 13;

    /// Flag bit: Market is resolved (withdraw-only mode)
    pub const FLAG_RESOLVED: u8 = 1 << 0;

    /// Read market flags from _padding[0].
    pub fn read_flags(data: &[u8]) -> u8 {
        data[FLAGS_OFF]
    }

    /// Write market flags to _padding[0].
    pub fn write_flags(data: &mut [u8], flags: u8) {
        data[FLAGS_OFF] = flags;
    }

    /// Check if market is resolved (withdraw-only mode).
    pub fn is_resolved(data: &[u8]) -> bool {
        read_flags(data) & FLAG_RESOLVED != 0
    }

    /// Set the resolved flag.
    pub fn set_resolved(data: &mut [u8]) {
        let flags = read_flags(data) | FLAG_RESOLVED;
        write_flags(data, flags);
    }

    pub fn read_config(data: &[u8]) -> MarketConfig {
        let mut c = MarketConfig::zeroed();
        let src = &data[HEADER_LEN..HEADER_LEN + CONFIG_LEN];
        let dst = bytemuck::bytes_of_mut(&mut c);
        dst.copy_from_slice(src);
        c
    }

    pub fn write_config(data: &mut [u8], c: &MarketConfig) {
        let src = bytemuck::bytes_of(c);
        let dst = &mut data[HEADER_LEN..HEADER_LEN + CONFIG_LEN];
        dst.copy_from_slice(src);
    }
}

// 7. mod units - base token/units conversion at instruction boundaries
pub mod units {
    /// Convert base token amount to units, returning (units, dust).
    /// Base token is the collateral (e.g., lamports for SOL, satoshis for BTC).
    /// If scale is 0, returns (base, 0) - no scaling.
    #[inline]
    pub fn base_to_units(base: u64, scale: u32) -> (u64, u64) {
        if scale == 0 {
            return (base, 0);
        }
        let s = scale as u64;
        (base / s, base % s)
    }

    /// Convert units to base token amount.
    /// If scale is 0, returns units unchanged - no scaling.
    #[inline]
    pub fn units_to_base(units: u64, scale: u32) -> u64 {
        if scale == 0 {
            return units;
        }
        units.saturating_mul(scale as u64)
    }

    /// Convert units to base token amount with overflow check.
    /// Returns None if overflow would occur.
    #[inline]
    pub fn units_to_base_checked(units: u64, scale: u32) -> Option<u64> {
        if scale == 0 {
            return Some(units);
        }
        units.checked_mul(scale as u64)
    }
}

// 8. mod oracle
pub mod oracle {
    use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};
    use crate::error::PercolatorError;

    // SECURITY (H5): The "devnet" feature disables critical oracle safety checks:
    // - Staleness validation (stale prices accepted)
    // - Confidence interval validation (wide confidence accepted)
    //
    // WARNING: NEVER deploy to mainnet with the "devnet" feature enabled!
    // Build for mainnet with: cargo build-sbf (without --features devnet)

    /// Pyth Solana Receiver program ID (same for mainnet and devnet)
    /// rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ
    pub const PYTH_RECEIVER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
        0x0c, 0xb7, 0xfa, 0xbb, 0x52, 0xf7, 0xa6, 0x48,
        0xbb, 0x5b, 0x31, 0x7d, 0x9a, 0x01, 0x8b, 0x90,
        0x57, 0xcb, 0x02, 0x47, 0x74, 0xfa, 0xfe, 0x01,
        0xe6, 0xc4, 0xdf, 0x98, 0xcc, 0x38, 0x58, 0x81,
    ]);

    /// Chainlink OCR2 Store program ID (same for mainnet and devnet)
    /// HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny
    pub const CHAINLINK_OCR2_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
        0xf1, 0x4b, 0xf6, 0x5a, 0xd5, 0x6b, 0xd2, 0xba,
        0x71, 0x5e, 0x45, 0x74, 0x2c, 0x23, 0x1f, 0x27,
        0xd6, 0x36, 0x21, 0xcf, 0x5b, 0x77, 0x8f, 0x37,
        0xc1, 0xa2, 0x48, 0x95, 0x1d, 0x17, 0x56, 0x02,
    ]);

    /// PumpSwap AMM program ID
    /// pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
    pub const PUMPSWAP_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
        0x0c, 0x14, 0xde, 0xfc, 0x82, 0x5e, 0xc6, 0x76,
        0x94, 0x25, 0x08, 0x18, 0xbb, 0x65, 0x40, 0x65,
        0xf4, 0x29, 0x8d, 0x31, 0x56, 0xd5, 0x71, 0xb4,
        0xd4, 0xf8, 0x09, 0x0c, 0x18, 0xe9, 0xa8, 0x63,
    ]);

    /// Raydium CLMM (Concentrated Liquidity) program ID
    /// CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
    pub const RAYDIUM_CLMM_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
        0xa5, 0xd5, 0xca, 0x9e, 0x04, 0xcf, 0x5d, 0xb5,
        0x90, 0xb7, 0x14, 0xba, 0x2f, 0xe3, 0x2c, 0xb1,
        0x59, 0x13, 0x3f, 0xc1, 0xc1, 0x92, 0xb7, 0x22,
        0x57, 0xfd, 0x07, 0xd3, 0x9c, 0xb0, 0x40, 0x1e,
    ]);

    /// Meteora DLMM (Dynamic Liquidity Market Maker) program ID
    /// LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
    pub const METEORA_DLMM_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
        0x04, 0xe9, 0xe1, 0x2f, 0xbc, 0x84, 0xe8, 0x26,
        0xc9, 0x32, 0xcc, 0xe9, 0xe2, 0x64, 0x0c, 0xce,
        0x15, 0x59, 0x0c, 0x1c, 0x62, 0x73, 0xb0, 0x92,
        0x57, 0x08, 0xba, 0x3b, 0x85, 0x20, 0xb0, 0xbc,
    ]);

    // PriceUpdateV2 account layout (Borsh-serialized via Anchor's #[account])
    // See: https://github.com/pyth-network/pyth-crosschain/blob/main/target_chains/solana/pyth_solana_receiver_sdk/src/price_update.rs
    //
    // Layout:
    //   [0..8]   discriminator
    //   [8..40]  write_authority (Pubkey)
    //   [40]     verification_level variant (Borsh enum):
    //              0x00 = Partial { num_signatures: u8 } → 2 bytes total (variant + data)
    //              0x01 = Full                           → 1 byte total  (variant only)
    //   [40+N..] PriceFeedMessage: feed_id(32) + price(i64) + conf(u64) + expo(i32) + publish_time(i64) + ...
    //   [...+8]  posted_slot (u64)
    //
    // The base offset for PriceFeedMessage depends on the verification variant:
    //   Partial → base = 42 (8 + 32 + 2)
    //   Full    → base = 41 (8 + 32 + 1)
    const PRICE_UPDATE_V2_MIN_LEN: usize = 134;
    const PYTH_DISCRIMINATOR_LEN: usize = 8;
    const PYTH_WRITE_AUTHORITY_LEN: usize = 32;
    const PYTH_VERIFICATION_LEVEL_OFF: usize = PYTH_DISCRIMINATOR_LEN + PYTH_WRITE_AUTHORITY_LEN; // 40

    // Chainlink OCR2 State/Aggregator account layout offsets (devnet format)
    // This is the simpler account format used on Solana devnet
    // Note: Different from the Transmissions ring buffer format in older docs
    const CL_MIN_LEN: usize = 224;       // Minimum required length
    const CL_OFF_DECIMALS: usize = 138;  // u8 - number of decimals
    // Skip unused: latest_round_id (143), live_length (148), live_cursor (152)
    // The actual price data is stored directly at tail:
    const CL_OFF_SLOT: usize = 200;      // u64 - slot when updated
    const CL_OFF_TIMESTAMP: usize = 208; // u64 - unix timestamp (seconds)
    const CL_OFF_ANSWER: usize = 216;    // i128 - price answer

    // Maximum supported exponent to prevent overflow (10^18 fits in u128)
    const MAX_EXPO_ABS: i32 = 18;

    /// Read price from a Pyth PriceUpdateV2 account.
    ///
    /// Parameters:
    /// - price_ai: The PriceUpdateV2 account
    /// - expected_feed_id: The expected Pyth feed ID (must match account's feed_id)
    /// - now_unix_ts: Current unix timestamp (from clock.unix_timestamp)
    /// - max_staleness_secs: Maximum age in seconds
    /// - conf_bps: Maximum confidence interval in basis points
    ///
    /// Returns the price in e6 format (e.g., 150_000_000 = 150.00 in base units).
    pub fn read_pyth_price_e6(
        price_ai: &AccountInfo,
        expected_feed_id: &[u8; 32],
        now_unix_ts: i64,
        max_staleness_secs: u64,
        conf_bps: u16,
    ) -> Result<u64, ProgramError> {
        // Validate oracle owner (skip in tests to allow mock oracles)
        #[cfg(not(feature = "test"))]
        {
            if *price_ai.owner != PYTH_RECEIVER_PROGRAM_ID {
                return Err(ProgramError::IllegalOwner);
            }
        }

        let data = price_ai.try_borrow_data()?;
        if data.len() < PRICE_UPDATE_V2_MIN_LEN {
            return Err(ProgramError::InvalidAccountData);
        }

        // Determine the base offset for PriceFeedMessage based on VerificationLevel variant.
        // Borsh serializes enums as: 1 byte variant index + variant data.
        //   Partial (0x00) has { num_signatures: u8 } → 2 bytes total
        //   Full    (0x01) has no data                → 1 byte total
        let verification_variant = data[PYTH_VERIFICATION_LEVEL_OFF];
        let base = match verification_variant {
            0 => PYTH_VERIFICATION_LEVEL_OFF + 2, // Partial: variant(1) + num_signatures(1) = 42
            1 => PYTH_VERIFICATION_LEVEL_OFF + 1, // Full: variant(1) = 41
            _ => return Err(ProgramError::InvalidAccountData),
        };

        // PriceFeedMessage field offsets relative to base:
        //   feed_id(32) + price(i64=8) + conf(u64=8) + expo(i32=4) + publish_time(i64=8)
        let off_feed_id = base;
        let off_price = base + 32;
        let off_conf = off_price + 8;
        let off_expo = off_conf + 8;
        let off_publish_time = off_expo + 4;

        // Bounds check
        if off_publish_time + 8 > data.len() {
            return Err(ProgramError::InvalidAccountData);
        }

        // Validate feed_id matches expected
        let feed_id: [u8; 32] = data[off_feed_id..off_feed_id + 32].try_into().unwrap();
        if &feed_id != expected_feed_id {
            return Err(PercolatorError::InvalidOracleKey.into());
        }

        // Read price fields
        let price = i64::from_le_bytes(data[off_price..off_price + 8].try_into().unwrap());
        let conf = u64::from_le_bytes(data[off_conf..off_conf + 8].try_into().unwrap());
        let expo = i32::from_le_bytes(data[off_expo..off_expo + 4].try_into().unwrap());
        let publish_time = i64::from_le_bytes(data[off_publish_time..off_publish_time + 8].try_into().unwrap());

        if price <= 0 {
            return Err(PercolatorError::OracleInvalid.into());
        }

        // SECURITY (C3): Bound exponent to prevent overflow in pow()
        if expo.abs() > MAX_EXPO_ABS {
            return Err(PercolatorError::OracleInvalid.into());
        }

        // Staleness check (skip on devnet)
        #[cfg(not(feature = "devnet"))]
        {
            let age = now_unix_ts.saturating_sub(publish_time);
            if age < 0 || age as u64 > max_staleness_secs {
                return Err(PercolatorError::OracleStale.into());
            }
        }
        #[cfg(feature = "devnet")]
        let _ = (publish_time, max_staleness_secs, now_unix_ts);

        // Confidence check (skip on devnet)
        let price_u = price as u128;
        #[cfg(not(feature = "devnet"))]
        {
            let lhs = (conf as u128) * 10_000;
            let rhs = price_u * (conf_bps as u128);
            if lhs > rhs {
                return Err(PercolatorError::OracleConfTooWide.into());
            }
        }
        #[cfg(feature = "devnet")]
        let _ = (conf, conf_bps);

        // Convert to e6 format
        let scale = expo + 6;
        let final_price_u128 = if scale >= 0 {
            let mul = 10u128.pow(scale as u32);
            price_u.checked_mul(mul).ok_or(PercolatorError::EngineOverflow)?
        } else {
            let div = 10u128.pow((-scale) as u32);
            price_u / div
        };

        if final_price_u128 == 0 {
            return Err(PercolatorError::OracleInvalid.into());
        }
        if final_price_u128 > u64::MAX as u128 {
            return Err(PercolatorError::EngineOverflow.into());
        }

        Ok(final_price_u128 as u64)
    }

    /// Read price from a Chainlink OCR2 State/Aggregator account.
    ///
    /// Parameters:
    /// - price_ai: The Chainlink aggregator account
    /// - expected_feed_pubkey: The expected feed account pubkey (for validation)
    /// - now_unix_ts: Current unix timestamp (from clock.unix_timestamp)
    /// - max_staleness_secs: Maximum age in seconds
    ///
    /// Returns the price in e6 format (e.g., 150_000_000 = 150.00 in base units).
    /// Note: Chainlink doesn't have confidence intervals, so conf_bps is not used.
    pub fn read_chainlink_price_e6(
        price_ai: &AccountInfo,
        expected_feed_pubkey: &[u8; 32],
        now_unix_ts: i64,
        max_staleness_secs: u64,
    ) -> Result<u64, ProgramError> {
        // Validate oracle owner (skip in tests to allow mock oracles)
        #[cfg(not(feature = "test"))]
        {
            if *price_ai.owner != CHAINLINK_OCR2_PROGRAM_ID {
                return Err(ProgramError::IllegalOwner);
            }
        }

        // Validate feed pubkey matches expected
        if price_ai.key.to_bytes() != *expected_feed_pubkey {
            return Err(PercolatorError::InvalidOracleKey.into());
        }

        let data = price_ai.try_borrow_data()?;
        if data.len() < CL_MIN_LEN {
            return Err(ProgramError::InvalidAccountData);
        }

        // Read header fields
        let decimals = data[CL_OFF_DECIMALS];

        // Read price data directly from fixed offsets
        let timestamp = u64::from_le_bytes(
            data[CL_OFF_TIMESTAMP..CL_OFF_TIMESTAMP + 8].try_into().unwrap()
        );
        // Read answer as i128 (16 bytes), but only bottom 8 bytes are typically used
        let answer = i128::from_le_bytes(
            data[CL_OFF_ANSWER..CL_OFF_ANSWER + 16].try_into().unwrap()
        );

        if answer <= 0 {
            return Err(PercolatorError::OracleInvalid.into());
        }

        // SECURITY (C3): Bound decimals to prevent overflow in pow()
        if decimals > MAX_EXPO_ABS as u8 {
            return Err(PercolatorError::OracleInvalid.into());
        }

        // Staleness check (skip on devnet)
        #[cfg(not(feature = "devnet"))]
        {
            let age = now_unix_ts.saturating_sub(timestamp as i64);
            if age < 0 || age as u64 > max_staleness_secs {
                return Err(PercolatorError::OracleStale.into());
            }
        }
        #[cfg(feature = "devnet")]
        let _ = (timestamp, max_staleness_secs, now_unix_ts);

        // Convert to e6 format
        // Chainlink decimals work like: price = answer / 10^decimals
        // We want e6, so: price_e6 = answer * 10^6 / 10^decimals = answer * 10^(6-decimals)
        let price_u = answer as u128;
        let scale = 6i32 - decimals as i32;
        let final_price_u128 = if scale >= 0 {
            let mul = 10u128.pow(scale as u32);
            price_u.checked_mul(mul).ok_or(PercolatorError::EngineOverflow)?
        } else {
            let div = 10u128.pow((-scale) as u32);
            price_u / div
        };

        if final_price_u128 == 0 {
            return Err(PercolatorError::OracleInvalid.into());
        }
        if final_price_u128 > u64::MAX as u128 {
            return Err(PercolatorError::EngineOverflow.into());
        }

        Ok(final_price_u128 as u64)
    }

    // =========================================================================
    // DEX Oracle Readers (PumpSwap, Raydium CLMM, Meteora DLMM)
    // =========================================================================

    // Raydium CLMM PoolState layout (Anchor — 8-byte discriminator)
    const RAYDIUM_CLMM_MIN_LEN: usize = 269;
    const RAYDIUM_CLMM_OFF_MINT0: usize = 73;
    const RAYDIUM_CLMM_OFF_MINT1: usize = 105;
    const RAYDIUM_CLMM_OFF_DECIMALS0: usize = 233;
    const RAYDIUM_CLMM_OFF_DECIMALS1: usize = 234;
    const RAYDIUM_CLMM_OFF_SQRT_PRICE_X64: usize = 253;

    /// Read spot price from a Raydium CLMM pool account.
    ///
    /// Uses sqrt_price_x64 (Q64.64 fixed-point) to compute:
    ///   price_e6 = (sqrt_price_x64^2 / 2^128) * 10^(6 + decimals_0 - decimals_1)
    ///
    /// Returns token_1 per token_0 in e6 format.
    ///
    /// SECURITY NOTE: DEX spot prices have no staleness/confidence checks and are
    /// vulnerable to flash-loan manipulation. See PumpSwap docs for details.
    pub fn read_raydium_clmm_price_e6(
        price_ai: &AccountInfo,
        expected_feed_id: &[u8; 32],
    ) -> Result<u64, ProgramError> {
        // Validate pool address matches expected (stored in index_feed_id)
        if price_ai.key.to_bytes() != *expected_feed_id {
            return Err(PercolatorError::InvalidOracleKey.into());
        }

        let data = price_ai.try_borrow_data()?;
        if data.len() < RAYDIUM_CLMM_MIN_LEN {
            return Err(ProgramError::InvalidAccountData);
        }

        let decimals_0 = data[RAYDIUM_CLMM_OFF_DECIMALS0] as i32;
        let decimals_1 = data[RAYDIUM_CLMM_OFF_DECIMALS1] as i32;

        let sqrt_price_x64 = u128::from_le_bytes(
            data[RAYDIUM_CLMM_OFF_SQRT_PRICE_X64..RAYDIUM_CLMM_OFF_SQRT_PRICE_X64 + 16]
                .try_into()
                .unwrap(),
        );

        if sqrt_price_x64 == 0 {
            return Err(PercolatorError::OracleInvalid.into());
        }

        // price_ratio = sqrt_price_x64^2 / 2^128
        // To avoid overflow, compute in steps:
        //   numerator = sqrt_price_x64^2  (can be up to 256 bits, but we use u128 carefully)
        //   We need: price_e6 = (sqrt^2 / 2^128) * 10^(6 + d0 - d1)
        //
        // Rewrite to avoid intermediate overflow:
        //   price_e6 = sqrt^2 * 10^(6 + d0 - d1) / 2^128
        //
        // Split sqrt into hi (top 64 bits) and lo (bottom 64 bits) for precision:
        //   sqrt^2 = (hi * 2^64 + lo)^2 but that's 256-bit.
        //
        // Simpler approach: divide first, multiply second.
        //   step1 = sqrt / 2^64  (integer, may lose precision for small prices)
        //   price_ratio_approx = step1 * sqrt  (fits u128 since both < 2^64 range)
        //
        // For better precision with small prices, we scale up first:
        let decimal_diff = 6i32 + decimals_0 - decimals_1;

        // Compute price_e6 = sqrt_price_x64^2 * 10^decimal_diff / 2^128
        //
        // PRECISION FIX: The naive approach `(sqrt >> 64) * sqrt` drops all low bits,
        // causing sqrtHi = 0 for micro-priced tokens (most memecoins where sqrt < 2^64).
        // Instead, we scale up by 1e6 BEFORE dividing, preserving precision:
        //   scaled_sqrt = sqrt * 1_000_000
        //   term = scaled_sqrt >> 64
        //   price_e6_raw = term * sqrt >> 64
        // This gives us 6 extra decimal digits of precision.
        // We then adjust decimal_diff by -6 since we already multiplied by 1e6.
        let scaled_sqrt = sqrt_price_x64
            .checked_mul(1_000_000)
            .ok_or(PercolatorError::EngineOverflow)?;
        let term = scaled_sqrt >> 64;
        let price_e6_raw = term
            .checked_mul(sqrt_price_x64)
            .ok_or(PercolatorError::EngineOverflow)?
            >> 64;

        // We already embedded 1e6, so adjust decimal_diff accordingly
        let adjusted_diff = decimal_diff - 6;

        let price_e6 = if adjusted_diff >= 0 {
            let scale = 10u128.pow(adjusted_diff as u32);
            price_e6_raw
                .checked_mul(scale)
                .ok_or(PercolatorError::EngineOverflow)?
        } else {
            let scale = 10u128.pow((-adjusted_diff) as u32);
            price_e6_raw / scale
        };

        if price_e6 == 0 {
            return Err(PercolatorError::OracleInvalid.into());
        }
        if price_e6 > u64::MAX as u128 {
            return Err(PercolatorError::EngineOverflow.into());
        }

        Ok(price_e6 as u64)
    }

    // PumpSwap pool layout (no Anchor discriminator)
    const PUMPSWAP_MIN_LEN: usize = 195;
    const PUMPSWAP_OFF_BASE_MINT: usize = 35;
    const PUMPSWAP_OFF_QUOTE_MINT: usize = 67;
    const PUMPSWAP_OFF_BASE_VAULT: usize = 131;
    const PUMPSWAP_OFF_QUOTE_VAULT: usize = 163;

    // SPL Token Account: amount is at offset 64 (u64 LE)
    const SPL_TOKEN_AMOUNT_OFF: usize = 64;
    const SPL_TOKEN_ACCOUNT_MIN_LEN: usize = 72; // need at least through amount field

    /// Read spot price from a PumpSwap AMM pool.
    ///
    /// PumpSwap is a constant-product AMM. Price = quote_reserve / base_reserve.
    /// Requires remaining_accounts[0] = base vault, remaining_accounts[1] = quote vault.
    ///
    /// Returns price in e6 format: price_e6 = quote_amount * 1_000_000 / base_amount.
    /// The `invert` and `unit_scale` fields handle decimal adjustments.
    ///
    /// SECURITY NOTE on DEX oracle freshness:
    /// Unlike Pyth/Chainlink, DEX spot prices have NO staleness or confidence checks.
    /// Spot prices are vulnerable to flash-loan manipulation within a single transaction.
    /// Market creators should understand this trade-off. The clamping logic in
    /// `read_engine_price_with_fallback` provides some protection by capping max price
    /// changes, but this is not a substitute for TWAP or multi-block aggregation.
    /// For high-value markets, prefer Pyth/Chainlink oracles.
    pub fn read_pumpswap_price_e6(
        price_ai: &AccountInfo,
        expected_feed_id: &[u8; 32],
        remaining: &[AccountInfo],
    ) -> Result<u64, ProgramError> {
        // Validate pool address
        if price_ai.key.to_bytes() != *expected_feed_id {
            return Err(PercolatorError::InvalidOracleKey.into());
        }

        let pool_data = price_ai.try_borrow_data()?;
        if pool_data.len() < PUMPSWAP_MIN_LEN {
            return Err(ProgramError::InvalidAccountData);
        }

        // Need exactly 2 remaining accounts: base vault, quote vault
        if remaining.len() < 2 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        // Read and log base/quote mints for verification.
        // NOTE: We validate vault addresses (which are derived from the pool) but callers
        // must ensure the pool's base_mint/quote_mint match their expected token pair.
        // The pool address itself is validated via expected_feed_id, and the market creator
        // is responsible for configuring the correct pool. An incorrect pool would yield
        // wrong prices but cannot steal funds from the percolator engine.
        let _base_mint: [u8; 32] = pool_data[PUMPSWAP_OFF_BASE_MINT..PUMPSWAP_OFF_BASE_MINT + 32]
            .try_into()
            .unwrap();
        let _quote_mint: [u8; 32] = pool_data[PUMPSWAP_OFF_QUOTE_MINT..PUMPSWAP_OFF_QUOTE_MINT + 32]
            .try_into()
            .unwrap();

        // Validate vault addresses match pool's stored vaults
        let expected_base_vault: [u8; 32] = pool_data[PUMPSWAP_OFF_BASE_VAULT..PUMPSWAP_OFF_BASE_VAULT + 32]
            .try_into()
            .unwrap();
        let expected_quote_vault: [u8; 32] = pool_data[PUMPSWAP_OFF_QUOTE_VAULT..PUMPSWAP_OFF_QUOTE_VAULT + 32]
            .try_into()
            .unwrap();

        if remaining[0].key.to_bytes() != expected_base_vault {
            return Err(PercolatorError::InvalidOracleKey.into());
        }
        if remaining[1].key.to_bytes() != expected_quote_vault {
            return Err(PercolatorError::InvalidOracleKey.into());
        }

        // Read token amounts from vault accounts
        let base_vault_data = remaining[0].try_borrow_data()?;
        let quote_vault_data = remaining[1].try_borrow_data()?;

        if base_vault_data.len() < SPL_TOKEN_ACCOUNT_MIN_LEN
            || quote_vault_data.len() < SPL_TOKEN_ACCOUNT_MIN_LEN
        {
            return Err(ProgramError::InvalidAccountData);
        }

        let base_amount = u64::from_le_bytes(
            base_vault_data[SPL_TOKEN_AMOUNT_OFF..SPL_TOKEN_AMOUNT_OFF + 8]
                .try_into()
                .unwrap(),
        );
        let quote_amount = u64::from_le_bytes(
            quote_vault_data[SPL_TOKEN_AMOUNT_OFF..SPL_TOKEN_AMOUNT_OFF + 8]
                .try_into()
                .unwrap(),
        );

        if base_amount == 0 {
            return Err(PercolatorError::OracleInvalid.into());
        }

        // price_e6 = quote_amount * 1_000_000 / base_amount
        let price_e6 = (quote_amount as u128)
            .checked_mul(1_000_000)
            .ok_or(PercolatorError::EngineOverflow)?
            / (base_amount as u128);

        if price_e6 == 0 {
            return Err(PercolatorError::OracleInvalid.into());
        }
        if price_e6 > u64::MAX as u128 {
            return Err(PercolatorError::EngineOverflow.into());
        }

        Ok(price_e6 as u64)
    }

    // Meteora DLMM LbPair layout (Anchor — 8-byte discriminator)
    // Key fields from the IDL:
    //   parameters (PDA padding + StaticParameters + VariableParameters) starts at offset 8
    //   StaticParameters contains active_id (i32) and bin_step (u16)
    //   Layout verified from Meteora DLMM source:
    //     [8..16]    parameters.padding (?)
    //     Relevant: active_id at 16, bin_step at 20
    //   Actual anchor layout (from LbPair struct):
    //     [8..40]    parameters (StaticParameters 32 bytes)
    //     [40..72]   v_parameters (VariableParameters 32 bytes)
    //     [72..76]   bump_seed [u8;2] + padding
    //     Then: bin_step_seed [u8;2], pair_type u8, active_id i32, ...
    //
    // Simplified: we read active_id and bin_step from known offsets.
    // From Meteora source: LbPair has active_id at offset 8+32+32+2+2+1 = 77 (i32)
    //   and bin_step at offset 8+0+10 = 18 (u16) inside StaticParameters
    //
    // Verified from Meteora DLMM IDL/source:
    //   StaticParameters layout (at offset 8):
    //     base_factor: u16 (0-2)
    //     filter_period: u16 (2-4)
    //     decay_period: u16 (4-6)
    //     reduction_factor: u16 (6-8)
    //     variable_fee_control: u32 (8-12)
    //     max_volatility_accumulator: u32 (12-16)
    //     min_bin_id: i32 (16-20)
    //     max_bin_id: i32 (20-24)
    //     protocol_share: u16 (24-26)
    //     padding: [u8;6] (26-32)
    //   VariableParameters layout (at offset 40):
    //     volatility_accumulator: u32 (0-4)
    //     volatility_reference: u32 (4-8)
    //     id_reference: i32 (8-12)
    //     time_of_last_update: u64 (12-20, but padded to 16 = 24)
    //     padding: [u8;8] (24-32)
    //   After parameters:
    //     [72..74]   bump_seed: [u8;2]
    //     [74..76]   bin_step_seed: [u8;2]  — NOT bin_step (this is just the LE bytes of bin_step for PDA)
    //     [76]       pair_type: u8
    //     [77..81]   active_id: i32
    //     [81..113]  token_x_mint: Pubkey
    //     [113..145] token_y_mint: Pubkey
    //
    // We also need bin_step. The canonical source is LbPair.bin_step field, but it's not
    // stored directly — it's derived from the PDA seeds. However, bin_step_seed at [74..76]
    // IS the bin_step as u16 LE (used in PDA derivation). We can read it from there.

    const METEORA_DLMM_MIN_LEN: usize = 145;
    const METEORA_DLMM_OFF_BIN_STEP_SEED: usize = 74; // u16 LE = bin_step
    const METEORA_DLMM_OFF_ACTIVE_ID: usize = 77;     // i32 LE

    /// Read spot price from a Meteora DLMM pool account.
    ///
    /// Price formula: price = (1 + bin_step/10000) ^ active_id
    ///
    /// Uses binary exponentiation with u128 fixed-point (38 decimal digits).
    /// Returns price in e6 format.
    ///
    /// SECURITY NOTE: DEX spot prices have no staleness/confidence checks and are
    /// vulnerable to flash-loan manipulation. See PumpSwap docs for details.
    pub fn read_meteora_dlmm_price_e6(
        price_ai: &AccountInfo,
        expected_feed_id: &[u8; 32],
    ) -> Result<u64, ProgramError> {
        // Validate pool address
        if price_ai.key.to_bytes() != *expected_feed_id {
            return Err(PercolatorError::InvalidOracleKey.into());
        }

        let data = price_ai.try_borrow_data()?;
        if data.len() < METEORA_DLMM_MIN_LEN {
            return Err(ProgramError::InvalidAccountData);
        }

        let bin_step = u16::from_le_bytes(
            data[METEORA_DLMM_OFF_BIN_STEP_SEED..METEORA_DLMM_OFF_BIN_STEP_SEED + 2]
                .try_into()
                .unwrap(),
        ) as u64;

        let active_id = i32::from_le_bytes(
            data[METEORA_DLMM_OFF_ACTIVE_ID..METEORA_DLMM_OFF_ACTIVE_ID + 4]
                .try_into()
                .unwrap(),
        );

        if bin_step == 0 {
            return Err(PercolatorError::OracleInvalid.into());
        }

        // Zero-price bin offset: active_id is signed, center is 0
        // Price = (1 + bin_step/10000) ^ active_id
        // For negative active_id: price = 1 / (1 + bin_step/10000) ^ |active_id|
        let is_negative = active_id < 0;
        let exp = if is_negative {
            (-(active_id as i64)) as u64
        } else {
            active_id as u64
        };

        // Binary exponentiation in fixed-point (scale = 1e18 for precision)
        const SCALE: u128 = 1_000_000_000_000_000_000; // 1e18
        let base = SCALE + (bin_step as u128) * SCALE / 10_000; // (1 + bin_step/10000) * SCALE

        let mut result: u128 = SCALE;
        let mut b: u128 = base;
        let mut e = exp;

        while e > 0 {
            if e & 1 == 1 {
                result = result
                    .checked_mul(b)
                    .ok_or(PercolatorError::EngineOverflow)?
                    / SCALE;
            }
            e >>= 1;
            if e > 0 {
                b = b
                    .checked_mul(b)
                    .ok_or(PercolatorError::EngineOverflow)?
                    / SCALE;
            }
        }

        // result is price * SCALE (1e18)
        // Convert to e6: price_e6 = result / 1e12
        let price_e6 = if is_negative {
            // price = 1/result (in fixed point): SCALE^2 / result
            // then convert to e6: (SCALE^2 / result) / 1e12 = SCALE * 1e6 / result
            if result == 0 {
                return Err(PercolatorError::OracleInvalid.into());
            }
            SCALE
                .checked_mul(1_000_000)
                .ok_or(PercolatorError::EngineOverflow)?
                / result
        } else {
            result / 1_000_000_000_000 // result / 1e12 to go from 1e18 to 1e6
        };

        if price_e6 == 0 {
            return Err(PercolatorError::OracleInvalid.into());
        }
        if price_e6 > u64::MAX as u128 {
            return Err(PercolatorError::EngineOverflow.into());
        }

        Ok(price_e6 as u64)
    }

    /// Read oracle price for engine use, applying inversion and unit scaling if configured.
    ///
    /// Automatically detects oracle type by account owner:
    /// - PYTH_RECEIVER_PROGRAM_ID: reads Pyth PriceUpdateV2
    /// - CHAINLINK_OCR2_PROGRAM_ID: reads Chainlink OCR2 Transmissions
    /// - RAYDIUM_CLMM_PROGRAM_ID: reads Raydium CLMM sqrt_price_x64
    /// - PUMPSWAP_PROGRAM_ID: reads PumpSwap AMM reserves (needs remaining_accounts)
    /// - METEORA_DLMM_PROGRAM_ID: reads Meteora DLMM active bin price
    ///
    /// Transformations applied in order:
    /// 1. If invert != 0: inverted price = 1e12 / raw_e6
    /// 2. If unit_scale > 1: scaled price = price / unit_scale
    ///
    /// CRITICAL: The unit_scale transformation ensures oracle-derived values (entry_price,
    /// mark_pnl, position_value) are in the same scale as capital (which is stored in units).
    /// Without this scaling, margin checks would compare units to base tokens incorrectly.
    ///
    /// The raw oracle is validated (staleness, confidence for Pyth) BEFORE transformations.
    pub fn read_engine_price_e6(
        price_ai: &AccountInfo,
        expected_feed_id: &[u8; 32],
        now_unix_ts: i64,
        max_staleness_secs: u64,
        conf_bps: u16,
        invert: u8,
        unit_scale: u32,
        remaining_accounts: &[AccountInfo],
    ) -> Result<u64, ProgramError> {
        // Detect oracle type by account owner and dispatch
        let raw_price = if *price_ai.owner == PYTH_RECEIVER_PROGRAM_ID {
            read_pyth_price_e6(price_ai, expected_feed_id, now_unix_ts, max_staleness_secs, conf_bps)?
        } else if *price_ai.owner == CHAINLINK_OCR2_PROGRAM_ID {
            read_chainlink_price_e6(price_ai, expected_feed_id, now_unix_ts, max_staleness_secs)?
        } else if *price_ai.owner == RAYDIUM_CLMM_PROGRAM_ID {
            read_raydium_clmm_price_e6(price_ai, expected_feed_id)?
        } else if *price_ai.owner == PUMPSWAP_PROGRAM_ID {
            read_pumpswap_price_e6(price_ai, expected_feed_id, remaining_accounts)?
        } else if *price_ai.owner == METEORA_DLMM_PROGRAM_ID {
            read_meteora_dlmm_price_e6(price_ai, expected_feed_id)?
        } else {
            // In test mode, try Pyth format first (for existing tests)
            #[cfg(feature = "test")]
            {
                read_pyth_price_e6(price_ai, expected_feed_id, now_unix_ts, max_staleness_secs, conf_bps)?
            }
            #[cfg(not(feature = "test"))]
            {
                return Err(ProgramError::IllegalOwner);
            }
        };

        // Step 1: Apply inversion if configured (uses verify::invert_price_e6)
        let price_after_invert = crate::verify::invert_price_e6(raw_price, invert)
            .ok_or(PercolatorError::OracleInvalid)?;

        // Step 2: Apply unit scaling if configured (uses verify::scale_price_e6)
        // This ensures oracle-derived values match capital scale (stored in units)
        crate::verify::scale_price_e6(price_after_invert, unit_scale)
            .ok_or(PercolatorError::OracleInvalid.into())
    }

    /// Check if authority-pushed price is available and fresh.
    /// Returns Some(price_e6) if authority is set and price is within staleness bounds.
    /// Returns None if no authority is set or price is stale.
    ///
    /// Note: The stored authority_price_e6 is already in the correct format (e6, scaled).
    pub fn read_authority_price(
        config: &super::state::MarketConfig,
        now_unix_ts: i64,
        max_staleness_secs: u64,
    ) -> Option<u64> {
        // No authority set
        if config.oracle_authority == [0u8; 32] {
            return None;
        }
        // No price pushed yet
        if config.authority_price_e6 == 0 {
            return None;
        }
        // Check staleness
        let age = now_unix_ts.saturating_sub(config.authority_timestamp);
        if age < 0 || age as u64 > max_staleness_secs {
            return None;
        }
        Some(config.authority_price_e6)
    }

    /// Read oracle price, preferring authority-pushed price over Pyth/Chainlink.
    ///
    /// If an oracle authority is configured and has pushed a fresh price, use that.
    /// Otherwise, fall back to reading from the provided Pyth/Chainlink account.
    ///
    /// The price_ai can be any account when using authority oracle - it won't be read
    /// if the authority price is valid.
    pub fn read_price_with_authority(
        config: &super::state::MarketConfig,
        price_ai: &AccountInfo,
        now_unix_ts: i64,
        remaining_accounts: &[AccountInfo],
    ) -> Result<u64, ProgramError> {
        // Try authority price first
        if let Some(authority_price) = read_authority_price(config, now_unix_ts, config.max_staleness_secs) {
            return Ok(authority_price);
        }

        // Fall back to Pyth/Chainlink/DEX
        read_engine_price_e6(
            price_ai,
            &config.index_feed_id,
            now_unix_ts,
            config.max_staleness_secs,
            config.conf_filter_bps,
            config.invert,
            config.unit_scale,
            remaining_accounts,
        )
    }

    /// Clamp `raw_price` so it cannot move more than `max_change_e2bps` from `last_price`.
    /// Units: 1_000_000 e2bps = 100%. 0 = disabled (no cap). last_price == 0 = first-time.
    pub fn clamp_oracle_price(last_price: u64, raw_price: u64, max_change_e2bps: u64) -> u64 {
        if max_change_e2bps == 0 || last_price == 0 {
            return raw_price;
        }
        let max_delta = ((last_price as u128) * (max_change_e2bps as u128) / 1_000_000) as u64;
        let lower = last_price.saturating_sub(max_delta);
        let upper = last_price.saturating_add(max_delta);
        raw_price.clamp(lower, upper)
    }

    /// Read oracle price with circuit-breaker clamping.
    /// Reads raw price via `read_price_with_authority`, clamps it against
    /// `config.last_effective_price_e6`, and updates that field to the post-clamped value.
    pub fn read_price_clamped(
        config: &mut super::state::MarketConfig,
        price_ai: &AccountInfo,
        now_unix_ts: i64,
        remaining_accounts: &[AccountInfo],
    ) -> Result<u64, ProgramError> {
        let raw = read_price_with_authority(config, price_ai, now_unix_ts, remaining_accounts)?;
        let clamped = clamp_oracle_price(config.last_effective_price_e6, raw, config.oracle_price_cap_e2bps);
        config.last_effective_price_e6 = clamped;
        Ok(clamped)
    }

    // =========================================================================
    // Hyperp mode helpers (internal mark/index, no external oracle)
    // =========================================================================

    /// Check if Hyperp mode is active (internal mark/index pricing).
    /// Hyperp mode is active when index_feed_id is all zeros.
    #[inline]
    pub fn is_hyperp_mode(config: &super::state::MarketConfig) -> bool {
        config.index_feed_id == [0u8; 32]
    }

    /// Move `index` toward `mark`, but clamp movement by cap_e2bps * dt_slots.
    /// cap_e2bps units: 1_000_000 = 100.00%
    /// Returns the new index value.
    ///
    /// Security: When dt_slots == 0 (same slot) or cap_e2bps == 0 (cap disabled),
    /// returns index unchanged to prevent bypassing rate limits.
    pub fn clamp_toward_with_dt(index: u64, mark: u64, cap_e2bps: u64, dt_slots: u64) -> u64 {
        if index == 0 { return mark; }
        // Bug #9 fix: return index (no movement) when dt=0 or cap=0,
        // rather than mark (bypass rate limiting)
        if cap_e2bps == 0 || dt_slots == 0 { return index; }

        let max_delta_u128 =
            (index as u128)
            .saturating_mul(cap_e2bps as u128)
            .saturating_mul(dt_slots as u128)
            / 1_000_000u128;

        let max_delta = core::cmp::min(max_delta_u128, u64::MAX as u128) as u64;
        let lo = index.saturating_sub(max_delta);
        let hi = index.saturating_add(max_delta);
        mark.clamp(lo, hi)
    }

    /// Get engine oracle price (unified: external oracle vs Hyperp mode).
    /// In Hyperp mode: updates index toward mark with rate limiting.
    /// In external mode: reads from Pyth/Chainlink/authority with circuit breaker.
    pub fn get_engine_oracle_price_e6(
        engine_last_slot: u64,
        now_slot: u64,
        now_unix_ts: i64,
        config: &mut super::state::MarketConfig,
        a_oracle: &AccountInfo,
        remaining_accounts: &[AccountInfo],
    ) -> Result<u64, ProgramError> {
        // Hyperp mode: index_feed_id == 0
        if is_hyperp_mode(config) {
            let mark = config.authority_price_e6;
            if mark == 0 {
                return Err(super::error::PercolatorError::OracleInvalid.into());
            }

            let prev_index = config.last_effective_price_e6;
            let dt = now_slot.saturating_sub(engine_last_slot);
            let new_index = clamp_toward_with_dt(
                prev_index.max(1),
                mark,
                config.oracle_price_cap_e2bps,
                dt,
            );

            config.last_effective_price_e6 = new_index;
            return Ok(new_index);
        }

        // Non-Hyperp: existing behavior (authority -> Pyth/Chainlink) + circuit breaker
        read_price_clamped(config, a_oracle, now_unix_ts, remaining_accounts)
    }

    /// Compute premium-based funding rate (Hyperp funding model).
    /// Premium = (mark - index) / index, converted to bps per slot.
    /// Returns signed bps per slot (positive = longs pay shorts).
    pub fn compute_premium_funding_bps_per_slot(
        mark_e6: u64,
        index_e6: u64,
        funding_horizon_slots: u64,
        funding_k_bps: u64,       // 100 = 1.00x multiplier
        max_premium_bps: i64,     // e.g. 500 = 5%
        max_bps_per_slot: i64,
    ) -> i64 {
        if mark_e6 == 0 || index_e6 == 0 || funding_horizon_slots == 0 { return 0; }

        let diff = mark_e6 as i128 - index_e6 as i128;
        let mut premium_bps = diff
            .saturating_mul(10_000)
            / (index_e6 as i128);

        // Clamp premium
        premium_bps = premium_bps.clamp(-(max_premium_bps as i128), max_premium_bps as i128);

        // Apply k multiplier (100 => 1.00x)
        let scaled = premium_bps.saturating_mul(funding_k_bps as i128) / 100i128;

        // Convert to per-slot by dividing by horizon
        let mut per_slot = (scaled / (funding_horizon_slots as i128)) as i64;

        // Policy clamp
        per_slot = per_slot.clamp(-max_bps_per_slot, max_bps_per_slot);
        per_slot
    }
}

// 9. mod collateral
pub mod collateral {
    use solana_program::{
        account_info::AccountInfo, program_error::ProgramError,
    };

    #[cfg(not(feature = "test"))]
    use solana_program::program::{invoke, invoke_signed};

    #[cfg(feature = "test")]
    use solana_program::program_pack::Pack;
    #[cfg(feature = "test")]
    use spl_token::state::Account as TokenAccount;

    pub fn deposit<'a>(
        _token_program: &AccountInfo<'a>,
        source: &AccountInfo<'a>,
        dest: &AccountInfo<'a>,
        _authority: &AccountInfo<'a>,
        amount: u64
    ) -> Result<(), ProgramError> {
        if amount == 0 { return Ok(()); }
        #[cfg(not(feature = "test"))]
        {
            let ix = spl_token::instruction::transfer(
                _token_program.key,
                source.key,
                dest.key,
                _authority.key,
                &[],
                amount,
            )?;
            invoke(&ix, &[source.clone(), dest.clone(), _authority.clone(), _token_program.clone()])
        }
        #[cfg(feature = "test")]
        {
            let mut src_data = source.try_borrow_mut_data()?;
            let mut src_state = TokenAccount::unpack(&src_data)?;
            src_state.amount = src_state.amount.checked_sub(amount).ok_or(ProgramError::InsufficientFunds)?;
            TokenAccount::pack(src_state, &mut src_data)?;

            let mut dst_data = dest.try_borrow_mut_data()?;
            let mut dst_state = TokenAccount::unpack(&dst_data)?;
            dst_state.amount = dst_state.amount.checked_add(amount).ok_or(ProgramError::InvalidAccountData)?;
            TokenAccount::pack(dst_state, &mut dst_data)?;
            Ok(())
        }
    }

    pub fn withdraw<'a>(
        _token_program: &AccountInfo<'a>,
        source: &AccountInfo<'a>,
        dest: &AccountInfo<'a>,
        _authority: &AccountInfo<'a>,
        amount: u64,
        _signer_seeds: &[&[&[u8]]],
    ) -> Result<(), ProgramError> {
        if amount == 0 { return Ok(()); }
        #[cfg(not(feature = "test"))]
        {
            let ix = spl_token::instruction::transfer(
                _token_program.key,
                source.key,
                dest.key,
                _authority.key,
                &[],
                amount,
            )?;
            invoke_signed(&ix, &[source.clone(), dest.clone(), _authority.clone(), _token_program.clone()], _signer_seeds)
        }
        #[cfg(feature = "test")]
        {
            let mut src_data = source.try_borrow_mut_data()?;
            let mut src_state = TokenAccount::unpack(&src_data)?;
            src_state.amount = src_state.amount.checked_sub(amount).ok_or(ProgramError::InsufficientFunds)?;
            TokenAccount::pack(src_state, &mut src_data)?;

            let mut dst_data = dest.try_borrow_mut_data()?;
            let mut dst_state = TokenAccount::unpack(&dst_data)?;
            dst_state.amount = dst_state.amount.checked_add(amount).ok_or(ProgramError::InvalidAccountData)?;
            TokenAccount::pack(dst_state, &mut dst_data)?;
            Ok(())
        }
    }
}

// 9a. mod insurance_lp — SPL mint/burn helpers for insurance LP tokens
pub mod insurance_lp {
    #[allow(unused_imports)]
    use alloc::format;
    use solana_program::{
        account_info::AccountInfo, program_error::ProgramError,
        pubkey::Pubkey, system_instruction,
    };

    #[cfg(not(feature = "test"))]
    use solana_program::program::{invoke, invoke_signed};
    #[cfg(not(feature = "test"))]
    use solana_program::sysvar::Sysvar;
    use solana_program::program_pack::Pack;

    /// Create the insurance LP mint account (PDA) and initialize it.
    /// Mint authority = vault_authority PDA. Freeze authority = None.
    #[allow(unused_variables)]
    pub fn create_mint<'a>(
        payer: &AccountInfo<'a>,
        mint_account: &AccountInfo<'a>,
        vault_authority: &AccountInfo<'a>,
        system_program: &AccountInfo<'a>,
        token_program: &AccountInfo<'a>,
        rent_sysvar: &AccountInfo<'a>,
        decimals: u8,
        mint_seeds: &[&[u8]],
    ) -> Result<(), ProgramError> {
        #[cfg(not(feature = "test"))]
        {
            let space = spl_token::state::Mint::LEN;
            let rent = solana_program::rent::Rent::get()?;
            let lamports = rent.minimum_balance(space);

            // Create account via CPI with PDA signing
            let create_ix = system_instruction::create_account(
                payer.key,
                mint_account.key,
                lamports,
                space as u64,
                &spl_token::ID,
            );
            invoke_signed(
                &create_ix,
                &[payer.clone(), mint_account.clone(), system_program.clone()],
                &[mint_seeds],
            )?;

            // Initialize mint: authority = vault_authority PDA, freeze = None
            let init_ix = spl_token::instruction::initialize_mint(
                &spl_token::ID,
                mint_account.key,
                vault_authority.key,
                None,
                decimals,
            )?;
            invoke(
                &init_ix,
                &[mint_account.clone(), rent_sysvar.clone(), token_program.clone()],
            )?;
        }
        #[cfg(feature = "test")]
        {
            // In test mode, initialize the mint data directly
            use solana_program::program_pack::Pack;
            use spl_token::state::Mint;
            let mut data = mint_account.try_borrow_mut_data()?;
            let mut mint_state = Mint::default();
            mint_state.is_initialized = true;
            mint_state.decimals = decimals;
            mint_state.mint_authority = solana_program::program_option::COption::Some(*vault_authority.key);
            mint_state.freeze_authority = solana_program::program_option::COption::None;
            mint_state.supply = 0;
            Mint::pack(mint_state, &mut data)?;
        }
        Ok(())
    }

    /// Mint LP tokens to a user's token account. Signed by vault_authority PDA.
    #[allow(unused_variables)]
    pub fn mint_to<'a>(
        token_program: &AccountInfo<'a>,
        mint: &AccountInfo<'a>,
        destination: &AccountInfo<'a>,
        authority: &AccountInfo<'a>,
        amount: u64,
        signer_seeds: &[&[&[u8]]],
    ) -> Result<(), ProgramError> {
        if amount == 0 { return Ok(()); }
        #[cfg(not(feature = "test"))]
        {
            let ix = spl_token::instruction::mint_to(
                token_program.key,
                mint.key,
                destination.key,
                authority.key,
                &[],
                amount,
            )?;
            invoke_signed(&ix, &[mint.clone(), destination.clone(), authority.clone(), token_program.clone()], signer_seeds)
        }
        #[cfg(feature = "test")]
        {
            use solana_program::program_pack::Pack;
            use spl_token::state::{Mint, Account as TokenAccount};

            // Update mint supply
            let mut mint_data = mint.try_borrow_mut_data()?;
            let mut mint_state = Mint::unpack(&mint_data)?;
            mint_state.supply = mint_state.supply.checked_add(amount)
                .ok_or(ProgramError::InvalidAccountData)?;
            Mint::pack(mint_state, &mut mint_data)?;

            // Update destination balance
            let mut dst_data = destination.try_borrow_mut_data()?;
            let mut dst_state = TokenAccount::unpack(&dst_data)?;
            dst_state.amount = dst_state.amount.checked_add(amount)
                .ok_or(ProgramError::InvalidAccountData)?;
            TokenAccount::pack(dst_state, &mut dst_data)?;
            Ok(())
        }
    }

    /// Burn LP tokens from a user's token account. User is the authority.
    #[allow(unused_variables)]
    pub fn burn<'a>(
        token_program: &AccountInfo<'a>,
        mint: &AccountInfo<'a>,
        source: &AccountInfo<'a>,
        authority: &AccountInfo<'a>,
        amount: u64,
    ) -> Result<(), ProgramError> {
        if amount == 0 { return Ok(()); }
        #[cfg(not(feature = "test"))]
        {
            let ix = spl_token::instruction::burn(
                token_program.key,
                source.key,
                mint.key,
                authority.key,
                &[],
                amount,
            )?;
            invoke(&ix, &[source.clone(), mint.clone(), authority.clone(), token_program.clone()])
        }
        #[cfg(feature = "test")]
        {
            use solana_program::program_pack::Pack;
            use spl_token::state::{Mint, Account as TokenAccount};

            // Update mint supply
            let mut mint_data = mint.try_borrow_mut_data()?;
            let mut mint_state = Mint::unpack(&mint_data)?;
            mint_state.supply = mint_state.supply.checked_sub(amount)
                .ok_or(ProgramError::InsufficientFunds)?;
            Mint::pack(mint_state, &mut mint_data)?;

            // Update source balance
            let mut src_data = source.try_borrow_mut_data()?;
            let mut src_state = TokenAccount::unpack(&src_data)?;
            src_state.amount = src_state.amount.checked_sub(amount)
                .ok_or(ProgramError::InsufficientFunds)?;
            TokenAccount::pack(src_state, &mut src_data)?;
            Ok(())
        }
    }

    /// Read the current supply from an SPL mint account.
    pub fn read_mint_supply(mint_account: &AccountInfo) -> Result<u64, ProgramError> {
        use solana_program::program_pack::Pack;
        let data = mint_account.try_borrow_data()?;
        let mint = spl_token::state::Mint::unpack(&data)?;
        if !mint.is_initialized {
            return Err(ProgramError::UninitializedAccount);
        }
        Ok(mint.supply)
    }

    /// Read the decimals from an SPL mint account.
    pub fn read_mint_decimals(mint_account: &AccountInfo) -> Result<u8, ProgramError> {
        use solana_program::program_pack::Pack;
        let data = mint_account.try_borrow_data()?;
        let mint = spl_token::state::Mint::unpack(&data)?;
        Ok(mint.decimals)
    }
}

// 9. mod processor
pub mod processor {
    #[allow(unused_imports)]
    use alloc::format;
    use solana_program::{
        account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey,
        sysvar::{clock::Clock, Sysvar},
        program_error::ProgramError,
        program_pack::Pack,
        msg,
        log::{sol_log_compute_units, sol_log_64},
    };
    use crate::{
        ix::Instruction,
        state::{self, SlabHeader, MarketConfig},
        accounts,
        constants::{MAGIC, VERSION, SLAB_LEN, CONFIG_LEN, MATCHER_CONTEXT_LEN, MATCHER_CALL_TAG, MATCHER_CALL_LEN, MATCHER_CONTEXT_PREFIX_LEN,
            DEFAULT_FUNDING_HORIZON_SLOTS, DEFAULT_FUNDING_K_BPS, DEFAULT_FUNDING_INV_SCALE_NOTIONAL_E6, DEFAULT_FUNDING_MAX_PREMIUM_BPS, DEFAULT_FUNDING_MAX_BPS_PER_SLOT,
            DEFAULT_THRESH_FLOOR, DEFAULT_THRESH_RISK_BPS, DEFAULT_THRESH_UPDATE_INTERVAL_SLOTS, DEFAULT_THRESH_STEP_BPS, DEFAULT_THRESH_ALPHA_BPS, DEFAULT_THRESH_MIN, DEFAULT_THRESH_MAX, DEFAULT_THRESH_MIN_STEP,
            DEFAULT_HYPERP_PRICE_CAP_E2BPS},
        error::{PercolatorError, map_risk_error},
        oracle,
        collateral,
        zc,
    };
    use percolator::{RiskEngine, NoOpMatcher, MAX_ACCOUNTS, MatchingEngine, TradeExecution, RiskError};
    use solana_program::instruction::{Instruction as SolInstruction, AccountMeta};

    struct CpiMatcher {
        exec_price: u64,
        exec_size: i128,
    }

    impl MatchingEngine for CpiMatcher {
        fn execute_match(
            &self,
            _lp_program: &[u8; 32],
            _lp_context: &[u8; 32],
            _lp_account_id: u64,
            _oracle_price: u64,
            _size: i128,
        ) -> Result<TradeExecution, RiskError> {
            Ok(TradeExecution {
                price: self.exec_price,
                size: self.exec_size,
            })
        }
    }

    fn slab_guard(program_id: &Pubkey, slab: &AccountInfo, data: &[u8]) -> Result<(), ProgramError> {
        // Slab shape validation via verify helper (Kani-provable)
        // Accept old slabs that are 8 bytes smaller due to Account struct reordering migration.
        // Old slabs (1111384 bytes) work for up to 4095 accounts; new slabs (1111392) for 4096.
        const OLD_SLAB_LEN: usize = SLAB_LEN - 8;
        let shape = crate::verify::SlabShape {
            owned_by_program: slab.owner == program_id,
            correct_len: data.len() == SLAB_LEN || data.len() == OLD_SLAB_LEN,
        };
        if !crate::verify::slab_shape_ok(shape) {
            // Return specific error based on which check failed
            if slab.owner != program_id {
                return Err(ProgramError::IllegalOwner);
            }
            solana_program::log::sol_log_64(SLAB_LEN as u64, data.len() as u64, 0, 0, 0);
            return Err(PercolatorError::InvalidSlabLen.into());
        }
        Ok(())
    }

    fn require_initialized(data: &[u8]) -> Result<(), ProgramError> {
        let h = state::read_header(data);
        if h.magic != MAGIC { return Err(PercolatorError::NotInitialized.into()); }
        if h.version != VERSION { return Err(PercolatorError::InvalidVersion.into()); }
        Ok(())
    }

    /// Require that the signer is the current admin.
    /// If admin is burned (all zeros), admin operations are permanently disabled.
    /// Admin authorization via verify helper (Kani-provable)
    fn require_admin(header_admin: [u8; 32], signer: &Pubkey) -> Result<(), ProgramError> {
        if !crate::verify::admin_ok(header_admin, signer.to_bytes()) {
            return Err(PercolatorError::EngineUnauthorized.into());
        }
        Ok(())
    }

    fn check_idx(engine: &RiskEngine, idx: u16) -> Result<(), ProgramError> {
        if (idx as usize) >= MAX_ACCOUNTS || !engine.is_used(idx as usize) {
            return Err(PercolatorError::EngineAccountNotFound.into());
        }
        Ok(())
    }

    fn verify_vault(a_vault: &AccountInfo, expected_owner: &Pubkey, expected_mint: &Pubkey, expected_pubkey: &Pubkey) -> Result<(), ProgramError> {
        if a_vault.key != expected_pubkey { return Err(PercolatorError::InvalidVaultAta.into()); }
        if a_vault.owner != &spl_token::ID { return Err(PercolatorError::InvalidVaultAta.into()); }
        if a_vault.data_len() != spl_token::state::Account::LEN { return Err(PercolatorError::InvalidVaultAta.into()); }

        let data = a_vault.try_borrow_data()?;
        let tok = spl_token::state::Account::unpack(&data)?;
        if tok.mint != *expected_mint { return Err(PercolatorError::InvalidMint.into()); }
        if tok.owner != *expected_owner { return Err(PercolatorError::InvalidVaultAta.into()); }
        // SECURITY (H3): Verify vault token account is initialized
        // Uninitialized vault could brick deposits/withdrawals
        if tok.state != spl_token::state::AccountState::Initialized {
            return Err(PercolatorError::InvalidVaultAta.into());
        }
        Ok(())
    }

    /// Verify a user's token account: owner, mint, and initialized state.
    /// Skip in tests to allow mock accounts.
    #[allow(unused_variables)]
    fn verify_token_account(a_token_account: &AccountInfo, expected_owner: &Pubkey, expected_mint: &Pubkey) -> Result<(), ProgramError> {
        #[cfg(not(feature = "test"))]
        {
            if a_token_account.owner != &spl_token::ID {
                return Err(PercolatorError::InvalidTokenAccount.into());
            }
            if a_token_account.data_len() != spl_token::state::Account::LEN {
                return Err(PercolatorError::InvalidTokenAccount.into());
            }

            let data = a_token_account.try_borrow_data()?;
            let tok = spl_token::state::Account::unpack(&data)?;
            if tok.mint != *expected_mint {
                return Err(PercolatorError::InvalidMint.into());
            }
            if tok.owner != *expected_owner {
                return Err(PercolatorError::InvalidTokenAccount.into());
            }
            if tok.state != spl_token::state::AccountState::Initialized {
                return Err(PercolatorError::InvalidTokenAccount.into());
            }
        }
        Ok(())
    }

    /// Verify the token program account is valid.
    /// Skip in tests to allow mock accounts.
    #[allow(unused_variables)]
    fn verify_token_program(a_token: &AccountInfo) -> Result<(), ProgramError> {
        #[cfg(not(feature = "test"))]
        {
            if *a_token.key != spl_token::ID {
                return Err(PercolatorError::InvalidTokenProgram.into());
            }
            if !a_token.executable {
                return Err(PercolatorError::InvalidTokenProgram.into());
            }
        }
        Ok(())
    }

    pub fn process_instruction<'a, 'b>(
        program_id: &Pubkey,
        accounts: &'b [AccountInfo<'a>],
        instruction_data: &[u8],
    ) -> ProgramResult {
        let instruction = Instruction::decode(instruction_data)?;

        match instruction {
            Instruction::InitMarket {
                admin, collateral_mint, index_feed_id,
                max_staleness_secs, conf_filter_bps, invert, unit_scale,
                initial_mark_price_e6, risk_params
            } => {
                // Reduced from 11 to 9: removed pyth_index and pyth_collateral accounts
                // (feed_id is now passed in instruction data, not as account)
                accounts::expect_len(accounts, 9)?;
                let a_admin = &accounts[0];
                let a_slab = &accounts[1];
                let a_mint = &accounts[2];
                let a_vault = &accounts[3];

                accounts::expect_signer(a_admin)?;
                accounts::expect_writable(a_slab)?;

                // Ensure instruction data matches the signer
                if admin != *a_admin.key {
                    return Err(ProgramError::InvalidInstructionData);
                }

                // SECURITY (H1): Enforce collateral_mint matches the account
                // This prevents signers from being confused by mismatched instruction data
                if collateral_mint != *a_mint.key {
                    return Err(ProgramError::InvalidInstructionData);
                }

                // SECURITY (H2): Validate mint is a real SPL Token mint
                // Check owner == spl_token::ID and data length == Mint::LEN (82 bytes)
                #[cfg(not(feature = "test"))]
                {
                    use spl_token::state::Mint;
                    use solana_program::program_pack::Pack;
                    if *a_mint.owner != spl_token::ID {
                        return Err(ProgramError::IllegalOwner);
                    }
                    if a_mint.data_len() != Mint::LEN {
                        return Err(ProgramError::InvalidAccountData);
                    }
                    // Verify mint is initialized by unpacking
                    let mint_data = a_mint.try_borrow_data()?;
                    let _ = Mint::unpack(&mint_data)?;
                }

                // Validate unit_scale: reject huge values that make most deposits credit 0 units
                if !crate::verify::init_market_scale_ok(unit_scale) {
                    return Err(ProgramError::InvalidInstructionData);
                }

                // Hyperp mode validation: if index_feed_id is all zeros, require initial_mark_price_e6
                let is_hyperp = index_feed_id == [0u8; 32];
                if is_hyperp && initial_mark_price_e6 == 0 {
                    // Hyperp mode requires a non-zero initial mark price
                    return Err(ProgramError::InvalidInstructionData);
                }

                // For Hyperp mode with inverted markets, apply inversion to initial price
                // This ensures the stored mark/index are in "market price" form
                let initial_mark_price_e6 = if is_hyperp && invert != 0 {
                    crate::verify::invert_price_e6(initial_mark_price_e6, invert)
                        .ok_or(PercolatorError::OracleInvalid)?
                } else {
                    initial_mark_price_e6
                };

                #[cfg(debug_assertions)]
                {
                    if core::mem::size_of::<MarketConfig>() != CONFIG_LEN {
                        return Err(ProgramError::InvalidAccountData);
                    }
                }

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;

                let _ = zc::engine_mut(&mut data)?;

                let header = state::read_header(&data);
                if header.magic == MAGIC { return Err(PercolatorError::AlreadyInitialized.into()); }

                let (auth, bump) = accounts::derive_vault_authority(program_id, a_slab.key);
                verify_vault(a_vault, &auth, a_mint.key, a_vault.key)?;

                for b in data.iter_mut() { *b = 0; }

                // Initialize engine in-place (zero-copy) to avoid stack overflow.
                // The data is already zeroed above, so init_in_place only sets non-zero fields.
                let engine = zc::engine_mut(&mut data)?;
                engine.init_in_place(risk_params);

                // Initialize slot fields to current slot to prevent overflow on first crank
                // (accrue_funding checks dt < 31_536_000, which fails if last_funding_slot=0)
                let a_clock = &accounts[5];
                let clock = Clock::from_account_info(a_clock)?;
                engine.current_slot = clock.slot;
                engine.last_funding_slot = clock.slot;
                engine.last_crank_slot = clock.slot;

                let config = MarketConfig {
                    collateral_mint: a_mint.key.to_bytes(),
                    vault_pubkey: a_vault.key.to_bytes(),
                    index_feed_id,
                    max_staleness_secs,
                    conf_filter_bps,
                    vault_authority_bump: bump,
                    invert,
                    unit_scale,
                    // Funding parameters (defaults)
                    funding_horizon_slots: DEFAULT_FUNDING_HORIZON_SLOTS,
                    funding_k_bps: DEFAULT_FUNDING_K_BPS,
                    funding_inv_scale_notional_e6: DEFAULT_FUNDING_INV_SCALE_NOTIONAL_E6,
                    funding_max_premium_bps: DEFAULT_FUNDING_MAX_PREMIUM_BPS,
                    funding_max_bps_per_slot: DEFAULT_FUNDING_MAX_BPS_PER_SLOT,
                    // Threshold parameters (defaults)
                    thresh_floor: DEFAULT_THRESH_FLOOR,
                    thresh_risk_bps: DEFAULT_THRESH_RISK_BPS,
                    thresh_update_interval_slots: DEFAULT_THRESH_UPDATE_INTERVAL_SLOTS,
                    thresh_step_bps: DEFAULT_THRESH_STEP_BPS,
                    thresh_alpha_bps: DEFAULT_THRESH_ALPHA_BPS,
                    thresh_min: DEFAULT_THRESH_MIN,
                    thresh_max: DEFAULT_THRESH_MAX,
                    thresh_min_step: DEFAULT_THRESH_MIN_STEP,
                    // Oracle authority (disabled by default - use Pyth/Chainlink)
                    // In Hyperp mode: authority_price_e6 = mark, last_effective_price_e6 = index
                    oracle_authority: [0u8; 32],
                    authority_price_e6: if is_hyperp { initial_mark_price_e6 } else { 0 },
                    authority_timestamp: 0, // In Hyperp mode: stores funding rate (bps per slot)
                    // Oracle price circuit breaker
                    // In Hyperp mode: used for rate-limited index smoothing AND mark price clamping
                    // Default: disabled for non-Hyperp, 1% per slot for Hyperp
                    oracle_price_cap_e2bps: if is_hyperp { DEFAULT_HYPERP_PRICE_CAP_E2BPS } else { 0 },
                    last_effective_price_e6: if is_hyperp { initial_mark_price_e6 } else { 0 },
                };
                state::write_config(&mut data, &config);

                let new_header = SlabHeader {
                    magic: MAGIC,
                    version: VERSION,
                    bump,
                    _padding: [0; 3],
                    admin: a_admin.key.to_bytes(),
                    _reserved: [0; 24],
                };
                state::write_header(&mut data, &new_header);
                // Step 4: Explicitly initialize nonce to 0 for determinism
                state::write_req_nonce(&mut data, 0);
                // Initialize threshold update slot to 0
                state::write_last_thr_update_slot(&mut data, 0);
            },
            Instruction::InitUser { fee_payment } => {
                accounts::expect_len(accounts, 5)?;
                let a_user = &accounts[0];
                let a_slab = &accounts[1];
                let a_user_ata = &accounts[2];
                let a_vault = &accounts[3];
                let a_token = &accounts[4];

                accounts::expect_signer(a_user)?;
                accounts::expect_writable(a_slab)?;
                verify_token_program(a_token)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                // Block new users when market is resolved
                if state::is_resolved(&data) {
                    return Err(ProgramError::InvalidAccountData);
                }
                let config = state::read_config(&data);
                let mint = Pubkey::new_from_array(config.collateral_mint);

                let (auth, _) = accounts::derive_vault_authority(program_id, a_slab.key);
                verify_vault(a_vault, &auth, &mint, &Pubkey::new_from_array(config.vault_pubkey))?;
                verify_token_account(a_user_ata, a_user.key, &mint)?;

                // Transfer base tokens to vault
                collateral::deposit(a_token, a_user_ata, a_vault, a_user, fee_payment)?;

                // Convert base tokens to units for engine
                let (units, dust) = crate::units::base_to_units(fee_payment, config.unit_scale);

                // Accumulate dust
                let old_dust = state::read_dust_base(&data);
                state::write_dust_base(&mut data, old_dust.saturating_add(dust));

                let engine = zc::engine_mut(&mut data)?;
                let idx = engine.add_user(units as u128).map_err(map_risk_error)?;
                engine.set_owner(idx, a_user.key.to_bytes()).map_err(map_risk_error)?;
            },
            Instruction::InitLP { matcher_program, matcher_context, fee_payment } => {
                accounts::expect_len(accounts, 5)?;
                let a_user = &accounts[0];
                let a_slab = &accounts[1];
                let a_user_ata = &accounts[2];
                let a_vault = &accounts[3];
                let a_token = &accounts[4];

                accounts::expect_signer(a_user)?;
                accounts::expect_writable(a_slab)?;
                verify_token_program(a_token)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                // Block new LPs when market is resolved
                if state::is_resolved(&data) {
                    return Err(ProgramError::InvalidAccountData);
                }

                let config = state::read_config(&data);
                let mint = Pubkey::new_from_array(config.collateral_mint);

                let (auth, _) = accounts::derive_vault_authority(program_id, a_slab.key);
                verify_vault(a_vault, &auth, &mint, &Pubkey::new_from_array(config.vault_pubkey))?;
                verify_token_account(a_user_ata, a_user.key, &mint)?;

                // Transfer base tokens to vault
                collateral::deposit(a_token, a_user_ata, a_vault, a_user, fee_payment)?;

                // Convert base tokens to units for engine
                let (units, dust) = crate::units::base_to_units(fee_payment, config.unit_scale);

                // Accumulate dust
                let old_dust = state::read_dust_base(&data);
                state::write_dust_base(&mut data, old_dust.saturating_add(dust));

                let engine = zc::engine_mut(&mut data)?;
                let idx = engine.add_lp(matcher_program.to_bytes(), matcher_context.to_bytes(), units as u128).map_err(map_risk_error)?;
                engine.set_owner(idx, a_user.key.to_bytes()).map_err(map_risk_error)?;
            },
            Instruction::DepositCollateral { user_idx, amount } => {
                accounts::expect_len(accounts, 6)?;
                let a_user = &accounts[0];
                let a_slab = &accounts[1];
                let a_user_ata = &accounts[2];
                let a_vault = &accounts[3];
                let a_token = &accounts[4];
                let a_clock = &accounts[5];

                accounts::expect_signer(a_user)?;
                accounts::expect_writable(a_slab)?;
                verify_token_program(a_token)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                // Block deposits when market is resolved
                if state::is_resolved(&data) {
                    return Err(ProgramError::InvalidAccountData);
                }

                let config = state::read_config(&data);
                let mint = Pubkey::new_from_array(config.collateral_mint);

                let (auth, _) = accounts::derive_vault_authority(program_id, a_slab.key);
                verify_vault(a_vault, &auth, &mint, &Pubkey::new_from_array(config.vault_pubkey))?;
                verify_token_account(a_user_ata, a_user.key, &mint)?;

                let clock = Clock::from_account_info(a_clock)?;

                // Transfer base tokens to vault
                collateral::deposit(a_token, a_user_ata, a_vault, a_user, amount)?;

                // Convert base tokens to units for engine
                let (units, dust) = crate::units::base_to_units(amount, config.unit_scale);

                // Accumulate dust
                let old_dust = state::read_dust_base(&data);
                state::write_dust_base(&mut data, old_dust.saturating_add(dust));

                let engine = zc::engine_mut(&mut data)?;

                check_idx(engine, user_idx)?;

                // Owner authorization via verify helper (Kani-provable)
                let owner = engine.accounts[user_idx as usize].owner;
                if !crate::verify::owner_ok(owner, a_user.key.to_bytes()) {
                    return Err(PercolatorError::EngineUnauthorized.into());
                }

                engine.deposit(user_idx, units as u128, clock.slot).map_err(map_risk_error)?;
            },
            Instruction::WithdrawCollateral { user_idx, amount } => {
                accounts::expect_len(accounts, 8)?;
                let a_user = &accounts[0];
                let a_slab = &accounts[1];
                let a_vault = &accounts[2];
                let a_user_ata = &accounts[3];
                let a_vault_pda = &accounts[4];
                let a_token = &accounts[5];
                let a_clock = &accounts[6];
                let a_oracle_idx = &accounts[7];

                accounts::expect_signer(a_user)?;
                accounts::expect_writable(a_slab)?;
                verify_token_program(a_token)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;
                let mut config = state::read_config(&data);
                let mint = Pubkey::new_from_array(config.collateral_mint);

                let (derived_pda, _) = accounts::derive_vault_authority(program_id, a_slab.key);
                accounts::expect_key(a_vault_pda, &derived_pda)?;

                verify_vault(a_vault, &derived_pda, &mint, &Pubkey::new_from_array(config.vault_pubkey))?;
                verify_token_account(a_user_ata, a_user.key, &mint)?;

                let clock = Clock::from_account_info(a_clock)?;
                // Read oracle price: Hyperp mode uses index directly, otherwise circuit-breaker clamping
                let is_hyperp = oracle::is_hyperp_mode(&config);
                let price = if is_hyperp {
                    let idx = config.last_effective_price_e6;
                    if idx == 0 {
                        return Err(PercolatorError::OracleInvalid.into());
                    }
                    idx
                } else {
                    oracle::read_price_clamped(&mut config, a_oracle_idx, clock.unix_timestamp, &accounts[8..])?
                };
                state::write_config(&mut data, &config);

                let engine = zc::engine_mut(&mut data)?;

                check_idx(engine, user_idx)?;

                // Owner authorization via verify helper (Kani-provable)
                let owner = engine.accounts[user_idx as usize].owner;
                if !crate::verify::owner_ok(owner, a_user.key.to_bytes()) {
                    return Err(PercolatorError::EngineUnauthorized.into());
                }

                // Reject misaligned withdrawal amounts (cleaner UX than silent floor)
                if config.unit_scale != 0 && amount % config.unit_scale as u64 != 0 {
                    return Err(ProgramError::InvalidInstructionData);
                }

                // Convert requested base tokens to units
                let (units_requested, _) = crate::units::base_to_units(amount, config.unit_scale);

                engine
                    .withdraw(user_idx, units_requested as u128, clock.slot, price)
                    .map_err(map_risk_error)?;

                // Convert units back to base tokens for payout (checked to prevent silent overflow)
                let base_to_pay = crate::units::units_to_base_checked(units_requested, config.unit_scale)
                    .ok_or(PercolatorError::EngineOverflow)?;

                let seed1: &[u8] = b"vault";
                let seed2: &[u8] = a_slab.key.as_ref();
                let bump_arr: [u8; 1] = [config.vault_authority_bump];
                let seed3: &[u8] = &bump_arr;
                let seeds: [&[u8]; 3] = [seed1, seed2, seed3];
                let signer_seeds: [&[&[u8]]; 1] = [&seeds];

                collateral::withdraw(
                    a_token,
                    a_vault,
                    a_user_ata,
                    a_vault_pda,
                    base_to_pay,
                    &signer_seeds,
                )?;
            },
            Instruction::KeeperCrank { caller_idx, allow_panic } => {
                use crate::constants::CRANK_NO_CALLER;

                accounts::expect_len(accounts, 4)?;
                let a_caller = &accounts[0];
                let a_slab = &accounts[1];
                let a_clock = &accounts[2];
                let a_oracle = &accounts[3];

                // Permissionless mode: caller_idx == u16::MAX means anyone can crank
                let permissionless = caller_idx == CRANK_NO_CALLER;

                if !permissionless {
                    // Self-crank mode: require signer + owner authorization
                    accounts::expect_signer(a_caller)?;
                }
                accounts::expect_writable(a_slab)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                // Check if market is resolved - if so, force-close positions instead of normal crank
                if state::is_resolved(&data) {
                    let config = state::read_config(&data);
                    let settlement_price = config.authority_price_e6;
                    if settlement_price == 0 {
                        return Err(ProgramError::InvalidAccountData);
                    }

                    let clock = Clock::from_account_info(a_clock)?;
                    let engine = zc::engine_mut(&mut data)?;

                    // Force-close positions in a paginated manner using crank_cursor
                    // Process up to 64 accounts per crank call (bounded compute)
                    const BATCH_SIZE: u16 = 64;
                    let start = engine.crank_cursor;
                    let end = core::cmp::min(start + BATCH_SIZE, percolator::MAX_ACCOUNTS as u16);

                    for idx in start..end {
                        if engine.is_used(idx as usize) {
                            let acc = &engine.accounts[idx as usize];
                            let pos = acc.position_size.get();
                            if pos != 0 {
                                // Settle position at settlement price
                                // PnL = position * (settlement_price - entry_price) / 1e6
                                let entry = acc.entry_price as i128;
                                let settle = settlement_price as i128;
                                let pnl_delta = pos
                                    .saturating_mul(settle.saturating_sub(entry))
                                    / 1_000_000i128;

                                // Add to PnL using set_pnl() to maintain pnl_pos_tot aggregate
                                // SECURITY: Must use set_pnl() for correct haircut calculations
                                let old_pnl = acc.pnl.get();
                                let new_pnl = old_pnl.saturating_add(pnl_delta);
                                engine.set_pnl(idx as usize, new_pnl);

                                // Clear position
                                engine.accounts[idx as usize].position_size = percolator::I128::ZERO;
                                engine.accounts[idx as usize].entry_price = 0;
                            }
                        }
                    }

                    // Update crank cursor for next call
                    engine.crank_cursor = if end >= percolator::MAX_ACCOUNTS as u16 { 0 } else { end };
                    engine.current_slot = clock.slot;

                    return Ok(());
                }

                let mut config = state::read_config(&data);
                let header = state::read_header(&data);
                // Read last threshold update slot BEFORE mutable engine borrow
                let last_thr_slot = state::read_last_thr_update_slot(&data);

                // SECURITY (C4): allow_panic triggers global settlement - admin only
                // This prevents griefing attacks where anyone triggers panic at worst moment
                if allow_panic != 0 {
                    accounts::expect_signer(a_caller)?;
                    if !crate::verify::admin_ok(header.admin, a_caller.key.to_bytes()) {
                        return Err(PercolatorError::EngineUnauthorized.into());
                    }
                }

                // Read dust before borrowing engine (for dust sweep later)
                let dust_before = state::read_dust_base(&data);
                let unit_scale = config.unit_scale;

                let clock = Clock::from_account_info(a_clock)?;

                // Hyperp mode: use get_engine_oracle_price_e6 for rate-limited index smoothing
                // Otherwise: use read_price_clamped as before
                let is_hyperp = oracle::is_hyperp_mode(&config);
                let engine_last_slot = {
                    let engine = zc::engine_ref(&data)?;
                    engine.current_slot
                };

                let remaining_oracle_accounts = &accounts[4..];
                let price = if is_hyperp {
                    // Hyperp mode: update index toward mark with rate limiting
                    oracle::get_engine_oracle_price_e6(
                        engine_last_slot,
                        clock.slot,
                        clock.unix_timestamp,
                        &mut config,
                        a_oracle,
                        remaining_oracle_accounts,
                    )?
                } else {
                    oracle::read_price_clamped(&mut config, a_oracle, clock.unix_timestamp, remaining_oracle_accounts)?
                };

                // Hyperp mode: compute and store funding rate BEFORE engine borrow
                // This avoids borrow conflicts with config read/write
                let hyperp_funding_rate = if is_hyperp {
                    // Read previous funding rate (piecewise-constant: use stored rate, then update)
                    // authority_timestamp is reinterpreted as i64 funding rate in Hyperp mode
                    let prev_rate = config.authority_timestamp;

                    // Compute new rate from premium
                    let mark_e6 = config.authority_price_e6;
                    let index_e6 = config.last_effective_price_e6;
                    let new_rate = oracle::compute_premium_funding_bps_per_slot(
                        mark_e6,
                        index_e6,
                        config.funding_horizon_slots,
                        config.funding_k_bps,
                        config.funding_max_premium_bps,
                        config.funding_max_bps_per_slot,
                    );

                    // Store new rate in config for next crank
                    config.authority_timestamp = new_rate;

                    Some(prev_rate) // Use PREVIOUS rate for this crank (piecewise-constant model)
                } else {
                    None
                };
                state::write_config(&mut data, &config);

                let engine = zc::engine_mut(&mut data)?;

                // Crank authorization:
                // - Permissionless mode (caller_idx == u16::MAX): anyone can crank
                // - Self-crank mode: caller_idx must be a valid, existing account owned by signer
                if !permissionless {
                    check_idx(engine, caller_idx)?;
                    let stored_owner = engine.accounts[caller_idx as usize].owner;
                    if !crate::verify::owner_ok(stored_owner, a_caller.key.to_bytes()) {
                        return Err(PercolatorError::EngineUnauthorized.into());
                    }
                }
                // Execute crank with effective_caller_idx for clarity
                // In permissionless mode, pass CRANK_NO_CALLER to engine (out-of-range = no caller settle)
                let effective_caller_idx = if permissionless { CRANK_NO_CALLER } else { caller_idx };

                // Compute funding rate:
                // - Hyperp mode: use pre-computed rate (avoids borrow conflict)
                // - Normal mode: inventory-based funding from LP net position
                let effective_funding_rate = if let Some(rate) = hyperp_funding_rate {
                    rate
                } else {
                    // Normal mode: inventory-based funding from LP net position
                    // Engine internally gates same-slot compounding via dt = now_slot - last_funding_slot,
                    // so passing the same rate multiple times in the same slot is harmless (dt=0 => no change).
                    let net_lp_pos = crate::compute_net_lp_pos(engine);
                    crate::compute_inventory_funding_bps_per_slot(
                        net_lp_pos,
                        price,
                        config.funding_horizon_slots,
                        config.funding_k_bps,
                        config.funding_inv_scale_notional_e6,
                        config.funding_max_premium_bps,
                        config.funding_max_bps_per_slot,
                    )
                };
                #[cfg(feature = "cu-audit")]
                {
                    msg!("CU_CHECKPOINT: keeper_crank_start");
                    sol_log_compute_units();
                }
                let _outcome = engine.keeper_crank(effective_caller_idx, clock.slot, price, effective_funding_rate, allow_panic != 0).map_err(map_risk_error)?;
                #[cfg(feature = "cu-audit")]
                {
                    msg!("CU_CHECKPOINT: keeper_crank_end");
                    sol_log_compute_units();
                }

                // Dust sweep: if accumulated dust >= unit_scale, sweep to insurance fund
                // Done before copying stats so insurance balance reflects the sweep
                let remaining_dust = if unit_scale > 0 {
                    let scale = unit_scale as u64;
                    if dust_before >= scale {
                        let units_to_sweep = dust_before / scale;
                        engine.top_up_insurance_fund(units_to_sweep as u128).map_err(map_risk_error)?;
                        Some(dust_before % scale)
                    } else {
                        None
                    }
                } else {
                    None
                };

                // Copy stats before threshold update (avoid borrow conflict)
                let liqs = engine.lifetime_liquidations;
                let force = engine.lifetime_force_realize_closes;
                let ins_low = engine.insurance_fund.balance.get() as u64;

                // --- Threshold auto-update (rate-limited + EWMA smoothed + step-clamped)
                if clock.slot >= last_thr_slot.saturating_add(config.thresh_update_interval_slots) {
                    let risk_units = crate::compute_system_risk_units(engine);
                    // Convert risk_units (contracts) to notional using price
                    let risk_notional = risk_units
                        .saturating_mul(price as u128)
                        / 1_000_000;
                    // raw target: floor + risk_notional * thresh_risk_bps / 10000
                    let raw_target = config.thresh_floor
                        .saturating_add(
                            risk_notional
                                .saturating_mul(config.thresh_risk_bps as u128)
                                / 10_000
                        );
                    let clamped_target = raw_target.clamp(config.thresh_min, config.thresh_max);
                    let current = engine.risk_reduction_threshold();
                    // EWMA: new = alpha * target + (1 - alpha) * current
                    let alpha = config.thresh_alpha_bps as u128;
                    let smoothed = (alpha * clamped_target + (10_000 - alpha) * current) / 10_000;
                    // Step clamp: max step = thresh_step_bps / 10000 of current (but at least thresh_min_step)
                    // Bug #6 fix: When current == 0, allow stepping to clamped_target directly
                    // Otherwise threshold would only increase by thresh_min_step (=1) per update
                    let max_step = if current == 0 {
                        clamped_target // Allow full jump when starting from zero
                    } else {
                        (current * config.thresh_step_bps as u128 / 10_000)
                            .max(config.thresh_min_step)
                    };
                    let final_thresh = if smoothed > current {
                        current.saturating_add(max_step.min(smoothed - current))
                    } else {
                        current.saturating_sub(max_step.min(current - smoothed))
                    };
                    engine.set_risk_reduction_threshold(final_thresh.clamp(config.thresh_min, config.thresh_max));
                    drop(engine);
                    state::write_last_thr_update_slot(&mut data, clock.slot);
                }

                // Write remaining dust if sweep occurred
                if let Some(dust) = remaining_dust {
                    state::write_dust_base(&mut data, dust);
                }

                // Debug: log lifetime counters (sol_log_64: tag, liqs, force, max_accounts, insurance)
                msg!("CRANK_STATS");
                sol_log_64(0xC8A4C, liqs, force, MAX_ACCOUNTS as u64, ins_low);
            },
            Instruction::TradeNoCpi { lp_idx, user_idx, size } => {
                accounts::expect_len(accounts, 5)?;
                let a_user = &accounts[0];
                let a_lp = &accounts[1];
                let a_slab = &accounts[2];

                accounts::expect_signer(a_user)?;
                accounts::expect_signer(a_lp)?;
                accounts::expect_writable(a_slab)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                // Block trading when market is resolved
                if state::is_resolved(&data) {
                    return Err(ProgramError::InvalidAccountData);
                }

                let mut config = state::read_config(&data);

                let clock = Clock::from_account_info(&accounts[3])?;
                let a_oracle = &accounts[4];

                // Hyperp mode: reject TradeNoCpi to prevent mark price manipulation
                // All trades must go through TradeCpi with a pinned matcher
                if oracle::is_hyperp_mode(&config) {
                    return Err(PercolatorError::HyperpTradeNoCpiDisabled.into());
                }

                // Read oracle price with circuit-breaker clamping
                let price = oracle::read_price_clamped(&mut config, a_oracle, clock.unix_timestamp, &accounts[5..])?;
                state::write_config(&mut data, &config);

                let engine = zc::engine_mut(&mut data)?;

                check_idx(engine, lp_idx)?;
                check_idx(engine, user_idx)?;

                let u_owner = engine.accounts[user_idx as usize].owner;

                // Owner authorization via verify helper (Kani-provable)
                if !crate::verify::owner_ok(u_owner, a_user.key.to_bytes()) {
                    return Err(PercolatorError::EngineUnauthorized.into());
                }
                let l_owner = engine.accounts[lp_idx as usize].owner;
                if !crate::verify::owner_ok(l_owner, a_lp.key.to_bytes()) {
                    return Err(PercolatorError::EngineUnauthorized.into());
                }

                // Gate: if insurance_fund <= threshold, only allow risk-reducing trades
                // LP delta is -size (LP takes opposite side of user's trade)
                // O(1) check after single O(n) scan
                // Gate activation via verify helper (Kani-provable)
                let bal = engine.insurance_fund.balance.get();
                let thr = engine.risk_reduction_threshold();
                if crate::verify::gate_active(thr, bal) {
                    #[cfg(feature = "cu-audit")]
                    {
                        msg!("CU_CHECKPOINT: trade_nocpi_compute_start");
                        sol_log_compute_units();
                    }
                    let risk_state = crate::LpRiskState::compute(engine);
                    #[cfg(feature = "cu-audit")]
                    {
                        msg!("CU_CHECKPOINT: trade_nocpi_compute_end");
                        sol_log_compute_units();
                    }
                    let old_lp_pos = engine.accounts[lp_idx as usize].position_size.get();
                    if risk_state.would_increase_risk(old_lp_pos, -size) {
                        return Err(PercolatorError::EngineRiskReductionOnlyMode.into());
                    }
                }

                #[cfg(feature = "cu-audit")]
                {
                    msg!("CU_CHECKPOINT: trade_nocpi_execute_start");
                    sol_log_compute_units();
                }
                engine.execute_trade(&NoOpMatcher, lp_idx, user_idx, clock.slot, price, size).map_err(map_risk_error)?;
                #[cfg(feature = "cu-audit")]
                {
                    msg!("CU_CHECKPOINT: trade_nocpi_execute_end");
                    sol_log_compute_units();
                }
            },
            Instruction::TradeCpi { lp_idx, user_idx, size } => {
                // Phase 1: Updated account layout - lp_pda must be in accounts
                accounts::expect_len(accounts, 8)?;
                let a_user = &accounts[0];
                let a_lp_owner = &accounts[1];
                let a_slab = &accounts[2];
                let a_clock = &accounts[3];
                let a_oracle = &accounts[4];
                let a_matcher_prog = &accounts[5];
                let a_matcher_ctx = &accounts[6];
                let a_lp_pda = &accounts[7];

                accounts::expect_signer(a_user)?;
                // Note: a_lp_owner does NOT need to be a signer for TradeCpi.
                // LP owner delegated trade authorization to the matcher program.
                // The matcher CPI (via LP PDA invoke_signed) validates the trade.
                accounts::expect_writable(a_slab)?;
                accounts::expect_writable(a_matcher_ctx)?;

                // Matcher shape validation via verify helper (Kani-provable)
                let matcher_shape = crate::verify::MatcherAccountsShape {
                    prog_executable: a_matcher_prog.executable,
                    ctx_executable: a_matcher_ctx.executable,
                    ctx_owner_is_prog: a_matcher_ctx.owner == a_matcher_prog.key,
                    ctx_len_ok: crate::verify::ctx_len_sufficient(a_matcher_ctx.data_len()),
                };
                if !crate::verify::matcher_shape_ok(matcher_shape) {
                    return Err(ProgramError::InvalidAccountData);
                }

                // Phase 1: Validate lp_pda is the correct PDA, system-owned, empty data, 0 lamports
                let lp_bytes = lp_idx.to_le_bytes();
                let (expected_lp_pda, bump) = Pubkey::find_program_address(
                    &[b"lp", a_slab.key.as_ref(), &lp_bytes],
                    program_id
                );
                // PDA key validation via verify helper (Kani-provable)
                if !crate::verify::pda_key_matches(expected_lp_pda.to_bytes(), a_lp_pda.key.to_bytes()) {
                    return Err(ProgramError::InvalidSeeds);
                }
                // LP PDA shape validation via verify helper (Kani-provable)
                let lp_pda_shape = crate::verify::LpPdaShape {
                    is_system_owned: a_lp_pda.owner == &solana_program::system_program::ID,
                    data_len_zero: a_lp_pda.data_len() == 0,
                    lamports_zero: **a_lp_pda.lamports.borrow() == 0,
                };
                if !crate::verify::lp_pda_shape_ok(lp_pda_shape) {
                    return Err(ProgramError::InvalidAccountData);
                }

                // Phase 3 & 4: Read engine state, generate nonce, validate matcher identity
                // Note: Use immutable borrow for reading to avoid ExternalAccountDataModified
                // Nonce write is deferred until after execute_trade
                let (lp_account_id, mut config, req_id, lp_matcher_prog, lp_matcher_ctx) = {
                    let data = a_slab.try_borrow_data()?;
                    slab_guard(program_id, a_slab, &*data)?;
                    require_initialized(&*data)?;

                    // Block trading when market is resolved
                    if state::is_resolved(&*data) {
                        return Err(ProgramError::InvalidAccountData);
                    }

                    let config = state::read_config(&*data);

                    // Phase 3: Monotonic nonce for req_id (prevents replay attacks)
                    // Nonce advancement via verify helper (Kani-provable)
                    let nonce = state::read_req_nonce(&*data);
                    let req_id = crate::verify::nonce_on_success(nonce);

                    let engine = zc::engine_ref(&*data)?;

                    check_idx(engine, lp_idx)?;
                    check_idx(engine, user_idx)?;

                    // Owner authorization via verify helper (Kani-provable)
                    let u_owner = engine.accounts[user_idx as usize].owner;
                    if !crate::verify::owner_ok(u_owner, a_user.key.to_bytes()) {
                        return Err(PercolatorError::EngineUnauthorized.into());
                    }
                    let l_owner = engine.accounts[lp_idx as usize].owner;
                    if !crate::verify::owner_ok(l_owner, a_lp_owner.key.to_bytes()) {
                        return Err(PercolatorError::EngineUnauthorized.into());
                    }

                    let lp_acc = &engine.accounts[lp_idx as usize];
                    (lp_acc.account_id, config, req_id, lp_acc.matcher_program, lp_acc.matcher_context)
                };

                // Matcher identity binding via verify helper (Kani-provable)
                if !crate::verify::matcher_identity_ok(
                    lp_matcher_prog,
                    lp_matcher_ctx,
                    a_matcher_prog.key.to_bytes(),
                    a_matcher_ctx.key.to_bytes(),
                ) {
                    return Err(PercolatorError::EngineInvalidMatchingEngine.into());
                }

                let clock = Clock::from_account_info(a_clock)?;
                // Read oracle price: Hyperp mode uses index directly, otherwise circuit-breaker clamping
                let is_hyperp = oracle::is_hyperp_mode(&config);
                let price = if is_hyperp {
                    // Hyperp mode: use current index price for trade execution
                    let idx = config.last_effective_price_e6;
                    if idx == 0 {
                        return Err(PercolatorError::OracleInvalid.into());
                    }
                    idx
                } else {
                    oracle::read_price_clamped(&mut config, a_oracle, clock.unix_timestamp, &accounts[8..])?
                };

                // Note: We don't zero the matcher_ctx before CPI because we don't own it.
                // Security is maintained by ABI validation which checks req_id (nonce),
                // lp_account_id, and oracle_price_e6 all match the request parameters.

                let mut cpi_data = alloc::vec::Vec::with_capacity(MATCHER_CALL_LEN);
                cpi_data.push(MATCHER_CALL_TAG);
                cpi_data.extend_from_slice(&req_id.to_le_bytes());
                cpi_data.extend_from_slice(&lp_idx.to_le_bytes());
                cpi_data.extend_from_slice(&lp_account_id.to_le_bytes());
                cpi_data.extend_from_slice(&price.to_le_bytes());
                cpi_data.extend_from_slice(&size.to_le_bytes());
                cpi_data.extend_from_slice(&[0u8; 24]); // padding to MATCHER_CALL_LEN

                #[cfg(debug_assertions)]
                {
                    if cpi_data.len() != MATCHER_CALL_LEN {
                        return Err(ProgramError::InvalidInstructionData);
                    }
                }

                let metas = alloc::vec![
                    AccountMeta::new_readonly(*a_lp_pda.key, true), // Will become signer via invoke_signed
                    AccountMeta::new(*a_matcher_ctx.key, false),
                ];

                let ix = SolInstruction {
                    program_id: *a_matcher_prog.key,
                    accounts: metas,
                    data: cpi_data,
                };

                let bump_arr = [bump];
                let seeds: &[&[u8]] = &[b"lp", a_slab.key.as_ref(), &lp_bytes, &bump_arr];

                // Phase 2: Use zc helper for CPI - slab not passed to avoid ExternalAccountDataModified
                zc::invoke_signed_trade(&ix, a_lp_pda, a_matcher_ctx, seeds)?;

                let ctx_data = a_matcher_ctx.try_borrow_data()?;
                let ret = crate::matcher_abi::read_matcher_return(&ctx_data)?;
                // ABI validation via verify helper (Kani-provable)
                let ret_fields = crate::verify::MatcherReturnFields {
                    abi_version: ret.abi_version,
                    flags: ret.flags,
                    exec_price_e6: ret.exec_price_e6,
                    exec_size: ret.exec_size,
                    req_id: ret.req_id,
                    lp_account_id: ret.lp_account_id,
                    oracle_price_e6: ret.oracle_price_e6,
                    reserved: ret.reserved,
                };
                if !crate::verify::abi_ok(ret_fields, lp_account_id, price, size, req_id) {
                    return Err(ProgramError::InvalidAccountData);
                }
                drop(ctx_data);

                let matcher = CpiMatcher { exec_price: ret.exec_price_e6, exec_size: ret.exec_size };
                {
                    let mut data = state::slab_data_mut(a_slab)?;
                    state::write_config(&mut data, &config);
                    let engine = zc::engine_mut(&mut data)?;

                    // Gate: if insurance_fund <= threshold, only allow risk-reducing trades
                    // Use actual exec_size from matcher (LP delta is -exec_size)
                    // O(1) check after single O(n) scan
                    // Gate activation via verify helper (Kani-provable)
                    let bal = engine.insurance_fund.balance.get();
                    let thr = engine.risk_reduction_threshold();
                    if crate::verify::gate_active(thr, bal) {
                        #[cfg(feature = "cu-audit")]
                        {
                            msg!("CU_CHECKPOINT: trade_cpi_compute_start");
                            sol_log_compute_units();
                        }
                        let risk_state = crate::LpRiskState::compute(engine);
                        #[cfg(feature = "cu-audit")]
                        {
                            msg!("CU_CHECKPOINT: trade_cpi_compute_end");
                            sol_log_compute_units();
                        }
                        let old_lp_pos = engine.accounts[lp_idx as usize].position_size.get();
                        if risk_state.would_increase_risk(old_lp_pos, -ret.exec_size) {
                            return Err(PercolatorError::EngineRiskReductionOnlyMode.into());
                        }
                    }

                    // Trade size selection via verify helper (Kani-provable: uses exec_size, not requested_size)
                    let trade_size = crate::verify::cpi_trade_size(ret.exec_size, size);
                    #[cfg(feature = "cu-audit")]
                    {
                        msg!("CU_CHECKPOINT: trade_cpi_execute_start");
                        sol_log_compute_units();
                    }
                    engine.execute_trade(&matcher, lp_idx, user_idx, clock.slot, price, trade_size).map_err(map_risk_error)?;
                    #[cfg(feature = "cu-audit")]
                    {
                        msg!("CU_CHECKPOINT: trade_cpi_execute_end");
                        sol_log_compute_units();
                    }
                    // Write nonce AFTER CPI and execute_trade to avoid ExternalAccountDataModified
                    state::write_req_nonce(&mut data, req_id);

                    // Hyperp mode: update mark price with execution price
                    // Apply circuit breaker to prevent extreme mark price manipulation
                    if is_hyperp {
                        let mut config = state::read_config(&data);
                        // Clamp exec_price against current index to prevent manipulation
                        // Uses same circuit breaker as PushOraclePrice for consistency
                        let clamped_mark = oracle::clamp_oracle_price(
                            config.last_effective_price_e6,
                            ret.exec_price_e6,
                            config.oracle_price_cap_e2bps,
                        );
                        config.authority_price_e6 = clamped_mark;
                        state::write_config(&mut data, &config);
                    }
                }
            },
            Instruction::LiquidateAtOracle { target_idx } => {
                accounts::expect_len(accounts, 4)?;
                let a_slab = &accounts[1];
                let a_oracle = &accounts[3];
                accounts::expect_writable(a_slab)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;
                let mut config = state::read_config(&data);

                let clock = Clock::from_account_info(&accounts[2])?;
                // Read oracle price: Hyperp mode uses index directly, otherwise circuit-breaker clamping
                let is_hyperp = oracle::is_hyperp_mode(&config);
                let price = if is_hyperp {
                    let idx = config.last_effective_price_e6;
                    if idx == 0 {
                        return Err(PercolatorError::OracleInvalid.into());
                    }
                    idx
                } else {
                    oracle::read_price_clamped(&mut config, a_oracle, clock.unix_timestamp, &accounts[4..])?
                };
                state::write_config(&mut data, &config);

                let engine = zc::engine_mut(&mut data)?;

                check_idx(engine, target_idx)?;

                // Debug logging for liquidation (using sol_log_64 for no_std)
                sol_log_64(target_idx as u64, price, 0, 0, 0);  // idx, price
                {
                    let acc = &engine.accounts[target_idx as usize];
                    sol_log_64(acc.capital.get() as u64, acc.pnl.get() as u64, 0, 0, 1);  // cap, pnl
                    sol_log_64(acc.position_size.get() as u64, acc.entry_price, 0, 0, 2);  // pos, entry
                    // Calculate mark PnL
                    let pos = acc.position_size.get();
                    let entry = acc.entry_price as i128;
                    let mark = pos.saturating_mul(price as i128 - entry) / 1_000_000;
                    let equity = (acc.capital.get() as i128).saturating_add(acc.pnl.get()).saturating_add(mark);
                    let notional = (if pos < 0 { -pos } else { pos } as u128).saturating_mul(price as u128) / 1_000_000;
                    let maint_req = notional.saturating_mul(engine.params.maintenance_margin_bps as u128) / 10_000;
                    sol_log_64(mark as u64, equity as u64, maint_req as u64, 0, 3);  // mark, equity, maint
                }

                #[cfg(feature = "cu-audit")]
                {
                    msg!("CU_CHECKPOINT: liquidate_start");
                    sol_log_compute_units();
                }
                let _res = engine.liquidate_at_oracle(target_idx, clock.slot, price).map_err(map_risk_error)?;
                sol_log_64(_res as u64, 0, 0, 0, 4);  // result
                #[cfg(feature = "cu-audit")]
                {
                    msg!("CU_CHECKPOINT: liquidate_end");
                    sol_log_compute_units();
                }
            },
            Instruction::CloseAccount { user_idx } => {
                accounts::expect_len(accounts, 8)?;
                let a_user = &accounts[0];
                let a_slab = &accounts[1];
                let a_vault = &accounts[2];
                let a_user_ata = &accounts[3];
                let a_pda = &accounts[4];
                let a_token = &accounts[5];
                let a_oracle = &accounts[7];

                accounts::expect_signer(a_user)?;
                accounts::expect_writable(a_slab)?;
                verify_token_program(a_token)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;
                let mut config = state::read_config(&data);
                let mint = Pubkey::new_from_array(config.collateral_mint);

                let (auth, _) = accounts::derive_vault_authority(program_id, a_slab.key);
                verify_vault(a_vault, &auth, &mint, &Pubkey::new_from_array(config.vault_pubkey))?;
                verify_token_account(a_user_ata, a_user.key, &mint)?;
                accounts::expect_key(a_pda, &auth)?;

                let clock = Clock::from_account_info(&accounts[6])?;
                // Read oracle price: Hyperp mode uses index directly, otherwise circuit-breaker clamping
                let is_hyperp = oracle::is_hyperp_mode(&config);
                let price = if is_hyperp {
                    let idx = config.last_effective_price_e6;
                    if idx == 0 {
                        return Err(PercolatorError::OracleInvalid.into());
                    }
                    idx
                } else {
                    oracle::read_price_clamped(&mut config, a_oracle, clock.unix_timestamp, &accounts[8..])?
                };
                state::write_config(&mut data, &config);

                let engine = zc::engine_mut(&mut data)?;

                check_idx(engine, user_idx)?;

                // Owner authorization via verify helper (Kani-provable)
                let u_owner = engine.accounts[user_idx as usize].owner;
                if !crate::verify::owner_ok(u_owner, a_user.key.to_bytes()) {
                    return Err(PercolatorError::EngineUnauthorized.into());
                }

                #[cfg(feature = "cu-audit")]
                {
                    msg!("CU_CHECKPOINT: close_account_start");
                    sol_log_compute_units();
                }
                let amt_units = engine.close_account(user_idx, clock.slot, price).map_err(map_risk_error)?;
                #[cfg(feature = "cu-audit")]
                {
                    msg!("CU_CHECKPOINT: close_account_end");
                    sol_log_compute_units();
                }
                let amt_units_u64: u64 = amt_units.try_into().map_err(|_| PercolatorError::EngineOverflow)?;

                // Convert units to base tokens for payout (checked to prevent silent overflow)
                let base_to_pay = crate::units::units_to_base_checked(amt_units_u64, config.unit_scale)
                    .ok_or(PercolatorError::EngineOverflow)?;

                let seed1: &[u8] = b"vault";
                let seed2: &[u8] = a_slab.key.as_ref();
                let bump_arr: [u8; 1] = [config.vault_authority_bump];
                let seed3: &[u8] = &bump_arr;
                let seeds: [&[u8]; 3] = [seed1, seed2, seed3];
                let signer_seeds: [&[&[u8]]; 1] = [&seeds];

                collateral::withdraw(a_token, a_vault, a_user_ata, a_pda, base_to_pay, &signer_seeds)?;
            },
            Instruction::TopUpInsurance { amount } => {
                accounts::expect_len(accounts, 5)?;
                let a_user = &accounts[0];
                let a_slab = &accounts[1];
                let a_user_ata = &accounts[2];
                let a_vault = &accounts[3];
                let a_token = &accounts[4];

                accounts::expect_signer(a_user)?;
                accounts::expect_writable(a_slab)?;
                verify_token_program(a_token)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                // Block insurance top-up when market is resolved
                if state::is_resolved(&data) {
                    return Err(ProgramError::InvalidAccountData);
                }

                let config = state::read_config(&data);
                let mint = Pubkey::new_from_array(config.collateral_mint);

                let (auth, _) = accounts::derive_vault_authority(program_id, a_slab.key);
                verify_vault(a_vault, &auth, &mint, &Pubkey::new_from_array(config.vault_pubkey))?;
                verify_token_account(a_user_ata, a_user.key, &mint)?;

                // Transfer base tokens to vault
                collateral::deposit(a_token, a_user_ata, a_vault, a_user, amount)?;

                // Convert base tokens to units for engine
                let (units, dust) = crate::units::base_to_units(amount, config.unit_scale);

                // Accumulate dust
                let old_dust = state::read_dust_base(&data);
                state::write_dust_base(&mut data, old_dust.saturating_add(dust));

                let engine = zc::engine_mut(&mut data)?;
                engine.top_up_insurance_fund(units as u128).map_err(map_risk_error)?;
            },
            Instruction::SetRiskThreshold { new_threshold } => {
                accounts::expect_len(accounts, 2)?;
                let a_admin = &accounts[0];
                let a_slab = &accounts[1];

                accounts::expect_signer(a_admin)?;
                accounts::expect_writable(a_slab)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                let header = state::read_header(&data);
                require_admin(header.admin, a_admin.key)?;

                let engine = zc::engine_mut(&mut data)?;
                engine.set_risk_reduction_threshold(new_threshold);
            }

            Instruction::UpdateAdmin { new_admin } => {
                accounts::expect_len(accounts, 2)?;
                let a_admin = &accounts[0];
                let a_slab = &accounts[1];

                accounts::expect_signer(a_admin)?;
                accounts::expect_writable(a_slab)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                let mut header = state::read_header(&data);
                require_admin(header.admin, a_admin.key)?;

                header.admin = new_admin.to_bytes();
                state::write_header(&mut data, &header);
            }

            Instruction::CloseSlab => {
                accounts::expect_len(accounts, 2)?;
                let a_dest = &accounts[0];
                let a_slab = &accounts[1];

                accounts::expect_signer(a_dest)?;
                accounts::expect_writable(a_slab)?;

                // With unsafe_close: skip all validation and zeroing (CU limit)
                // Account will be garbage collected after lamports are drained
                #[cfg(not(feature = "unsafe_close"))]
                {
                    let mut data = state::slab_data_mut(a_slab)?;
                    slab_guard(program_id, a_slab, &data)?;
                    require_initialized(&data)?;

                    let header = state::read_header(&data);
                    require_admin(header.admin, a_dest.key)?;

                    let engine = zc::engine_ref(&data)?;
                    if !engine.vault.is_zero() {
                        return Err(PercolatorError::EngineInsufficientBalance.into());
                    }
                    if !engine.insurance_fund.balance.is_zero() {
                        return Err(PercolatorError::EngineInsufficientBalance.into());
                    }
                    if engine.num_used_accounts != 0 {
                        return Err(PercolatorError::EngineAccountNotFound.into());
                    }

                    // Bug #3 fix: Check dust_base to prevent closing with unaccounted funds
                    let dust_base = state::read_dust_base(&data);
                    if dust_base != 0 {
                        return Err(PercolatorError::EngineInsufficientBalance.into());
                    }

                    // Zero out the slab data to prevent reuse
                    for b in data.iter_mut() {
                        *b = 0;
                    }
                }

                // Transfer all lamports from slab to destination
                let slab_lamports = a_slab.lamports();
                **a_slab.lamports.borrow_mut() = 0;
                **a_dest.lamports.borrow_mut() = a_dest
                    .lamports()
                    .checked_add(slab_lamports)
                    .ok_or(PercolatorError::EngineOverflow)?;
            }

            Instruction::UpdateConfig {
                funding_horizon_slots, funding_k_bps, funding_inv_scale_notional_e6,
                funding_max_premium_bps, funding_max_bps_per_slot,
                thresh_floor, thresh_risk_bps, thresh_update_interval_slots,
                thresh_step_bps, thresh_alpha_bps, thresh_min, thresh_max, thresh_min_step,
            } => {
                accounts::expect_len(accounts, 2)?;
                let a_admin = &accounts[0];
                let a_slab = &accounts[1];

                accounts::expect_signer(a_admin)?;
                accounts::expect_writable(a_slab)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                let header = state::read_header(&data);
                require_admin(header.admin, a_admin.key)?;

                // Validate parameters
                if funding_horizon_slots == 0 {
                    return Err(PercolatorError::InvalidConfigParam.into());
                }
                if funding_inv_scale_notional_e6 == 0 {
                    return Err(PercolatorError::InvalidConfigParam.into());
                }
                if thresh_alpha_bps > 10_000 {
                    return Err(PercolatorError::InvalidConfigParam.into());
                }
                if thresh_min > thresh_max {
                    return Err(PercolatorError::InvalidConfigParam.into());
                }

                // Read existing config and update
                let mut config = state::read_config(&data);
                config.funding_horizon_slots = funding_horizon_slots;
                config.funding_k_bps = funding_k_bps;
                config.funding_inv_scale_notional_e6 = funding_inv_scale_notional_e6;
                config.funding_max_premium_bps = funding_max_premium_bps;
                config.funding_max_bps_per_slot = funding_max_bps_per_slot;
                config.thresh_floor = thresh_floor;
                config.thresh_risk_bps = thresh_risk_bps;
                config.thresh_update_interval_slots = thresh_update_interval_slots;
                config.thresh_step_bps = thresh_step_bps;
                config.thresh_alpha_bps = thresh_alpha_bps;
                config.thresh_min = thresh_min;
                config.thresh_max = thresh_max;
                config.thresh_min_step = thresh_min_step;
                state::write_config(&mut data, &config);
            }

            Instruction::SetMaintenanceFee { new_fee } => {
                accounts::expect_len(accounts, 2)?;
                let a_admin = &accounts[0];
                let a_slab = &accounts[1];

                accounts::expect_signer(a_admin)?;
                accounts::expect_writable(a_slab)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                let header = state::read_header(&data);
                require_admin(header.admin, a_admin.key)?;

                let engine = zc::engine_mut(&mut data)?;
                engine.params.maintenance_fee_per_slot = percolator::U128::new(new_fee);
            }

            Instruction::SetOracleAuthority { new_authority } => {
                accounts::expect_len(accounts, 2)?;
                let a_admin = &accounts[0];
                let a_slab = &accounts[1];

                accounts::expect_signer(a_admin)?;
                accounts::expect_writable(a_slab)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                let header = state::read_header(&data);
                require_admin(header.admin, a_admin.key)?;

                // Update oracle authority in config
                let mut config = state::read_config(&data);
                config.oracle_authority = new_authority.to_bytes();
                // Clear stored price when authority changes
                config.authority_price_e6 = 0;
                config.authority_timestamp = 0;
                state::write_config(&mut data, &config);
            }

            Instruction::PushOraclePrice { price_e6, timestamp } => {
                accounts::expect_len(accounts, 2)?;
                let a_authority = &accounts[0];
                let a_slab = &accounts[1];

                accounts::expect_signer(a_authority)?;
                accounts::expect_writable(a_slab)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                // Verify caller is the oracle authority
                let mut config = state::read_config(&data);
                if config.oracle_authority == [0u8; 32] {
                    return Err(PercolatorError::EngineUnauthorized.into());
                }
                if config.oracle_authority != a_authority.key.to_bytes() {
                    return Err(PercolatorError::EngineUnauthorized.into());
                }

                // Validate price (must be positive)
                if price_e6 == 0 {
                    return Err(PercolatorError::OracleInvalid.into());
                }

                // Clamp the incoming price against circuit breaker
                let clamped = oracle::clamp_oracle_price(
                    config.last_effective_price_e6, price_e6, config.oracle_price_cap_e2bps
                );
                config.authority_price_e6 = clamped;
                // In Hyperp mode, authority_timestamp stores the funding rate (bps/slot).
                // Only write the oracle timestamp in non-Hyperp admin oracle mode.
                if !oracle::is_hyperp_mode(&config) {
                    config.authority_timestamp = timestamp;
                }
                config.last_effective_price_e6 = clamped;
                state::write_config(&mut data, &config);
            }

            Instruction::SetOraclePriceCap { max_change_e2bps } => {
                accounts::expect_len(accounts, 2)?;
                let a_admin = &accounts[0];
                let a_slab = &accounts[1];

                accounts::expect_signer(a_admin)?;
                accounts::expect_writable(a_slab)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                let header = state::read_header(&data);
                require_admin(header.admin, a_admin.key)?;

                let mut config = state::read_config(&data);
                config.oracle_price_cap_e2bps = max_change_e2bps;
                state::write_config(&mut data, &config);
            }

            Instruction::ResolveMarket => {
                // Resolve market: set RESOLVED flag, use admin oracle price for settlement
                // Positions are force-closed via subsequent KeeperCrank calls (paginated)
                accounts::expect_len(accounts, 2)?;
                let a_admin = &accounts[0];
                let a_slab = &accounts[1];

                accounts::expect_signer(a_admin)?;
                accounts::expect_writable(a_slab)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                let header = state::read_header(&data);
                require_admin(header.admin, a_admin.key)?;

                // Can't re-resolve
                if state::is_resolved(&data) {
                    return Err(ProgramError::InvalidAccountData);
                }

                // Require admin oracle price to be set (authority_price_e6 > 0)
                let config = state::read_config(&data);
                if config.authority_price_e6 == 0 {
                    return Err(ProgramError::InvalidAccountData);
                }

                // Set the resolved flag
                state::set_resolved(&mut data);
            }

            Instruction::WithdrawInsurance => {
                // Withdraw insurance fund (admin only, requires RESOLVED and all positions closed)
                accounts::expect_len(accounts, 6)?;
                let a_admin = &accounts[0];
                let a_slab = &accounts[1];
                let a_admin_ata = &accounts[2];
                let a_vault = &accounts[3];
                let a_token = &accounts[4];
                let a_vault_pda = &accounts[5];

                accounts::expect_signer(a_admin)?;
                accounts::expect_writable(a_slab)?;
                verify_token_program(a_token)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                let header = state::read_header(&data);
                require_admin(header.admin, a_admin.key)?;

                // Must be resolved
                if !state::is_resolved(&data) {
                    return Err(ProgramError::InvalidAccountData);
                }

                let config = state::read_config(&data);
                let mint = Pubkey::new_from_array(config.collateral_mint);

                let (auth, _) = accounts::derive_vault_authority(program_id, a_slab.key);
                verify_vault(a_vault, &auth, &mint, &Pubkey::new_from_array(config.vault_pubkey))?;
                verify_token_account(a_admin_ata, a_admin.key, &mint)?;
                accounts::expect_key(a_vault_pda, &auth)?;

                let engine = zc::engine_mut(&mut data)?;

                // Require all positions to be closed (force-closed by crank)
                // Check that no account has position_size != 0
                let mut has_open_positions = false;
                for i in 0..percolator::MAX_ACCOUNTS {
                    if engine.is_used(i) {
                        let pos = engine.accounts[i].position_size.get();
                        if pos != 0 {
                            has_open_positions = true;
                            break;
                        }
                    }
                }
                if has_open_positions {
                    return Err(ProgramError::InvalidAccountData);
                }

                // Get insurance balance and convert to base tokens
                let insurance_units = engine.insurance_fund.balance.get();
                if insurance_units == 0 {
                    return Ok(()); // Nothing to withdraw
                }

                // Cap at u64::MAX for conversion (should never happen in practice)
                let units_u64 = if insurance_units > u64::MAX as u128 {
                    u64::MAX
                } else {
                    insurance_units as u64
                };
                let base_amount = crate::units::units_to_base_checked(units_u64, config.unit_scale)
                    .ok_or(PercolatorError::EngineOverflow)?;

                // Zero out insurance fund
                engine.insurance_fund.balance = percolator::U128::ZERO;

                // Transfer from vault to admin
                let seed1: &[u8] = b"vault";
                let seed2: &[u8] = a_slab.key.as_ref();
                let bump_arr: [u8; 1] = [config.vault_authority_bump];
                let seed3: &[u8] = &bump_arr;
                let seeds: [&[u8]; 3] = [seed1, seed2, seed3];
                let signer_seeds: [&[&[u8]]; 1] = [&seeds];

                collateral::withdraw(
                    a_token,
                    a_vault,
                    a_admin_ata,
                    a_vault_pda,
                    base_amount,
                    &signer_seeds,
                )?;
            }
            Instruction::AdminForceClose { target_idx } => {
                // Admin force-close: unconditionally close any position at oracle price.
                // Accounts: [admin(signer), slab(writable), clock, oracle]
                accounts::expect_len(accounts, 4)?;
                let a_admin = &accounts[0];
                let a_slab = &accounts[1];
                let a_oracle = &accounts[3];

                accounts::expect_signer(a_admin)?;
                accounts::expect_writable(a_slab)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                let header = state::read_header(&data);
                require_admin(header.admin, a_admin.key)?;

                let mut config = state::read_config(&data);
                let clock = Clock::from_account_info(&accounts[2])?;

                // Read oracle price (same logic as LiquidateAtOracle)
                let is_hyperp = oracle::is_hyperp_mode(&config);
                let price = if is_hyperp {
                    let idx = config.last_effective_price_e6;
                    if idx == 0 {
                        return Err(PercolatorError::OracleInvalid.into());
                    }
                    idx
                } else {
                    oracle::read_price_clamped(&mut config, a_oracle, clock.unix_timestamp, &accounts[4..])?
                };
                state::write_config(&mut data, &config);

                let engine = zc::engine_mut(&mut data)?;
                check_idx(engine, target_idx)?;

                engine.admin_force_close(target_idx, clock.slot, price).map_err(map_risk_error)?;
            }

            Instruction::UpdateRiskParams { initial_margin_bps, maintenance_margin_bps } => {
                // Update margin parameters. Admin only.
                // Accounts: [admin(signer), slab(writable)]
                accounts::expect_len(accounts, 2)?;
                let a_admin = &accounts[0];
                let a_slab = &accounts[1];

                accounts::expect_signer(a_admin)?;
                accounts::expect_writable(a_slab)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                let header = state::read_header(&data);
                require_admin(header.admin, a_admin.key)?;

                // Validate: initial >= maintenance, both > 0, both <= 10000
                if initial_margin_bps == 0 || maintenance_margin_bps == 0 {
                    return Err(PercolatorError::InvalidConfigParam.into());
                }
                if initial_margin_bps > 10_000 || maintenance_margin_bps > 10_000 {
                    return Err(PercolatorError::InvalidConfigParam.into());
                }
                if initial_margin_bps < maintenance_margin_bps {
                    return Err(PercolatorError::InvalidConfigParam.into());
                }

                let engine = zc::engine_mut(&mut data)?;
                engine.set_margin_params(initial_margin_bps, maintenance_margin_bps);
            }

            Instruction::RenounceAdmin => {
                // Renounce admin: set admin to all zeros (irreversible).
                // Accounts: [admin(signer), slab(writable)]
                accounts::expect_len(accounts, 2)?;
                let a_admin = &accounts[0];
                let a_slab = &accounts[1];

                accounts::expect_signer(a_admin)?;
                accounts::expect_writable(a_slab)?;

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                let header = state::read_header(&data);
                require_admin(header.admin, a_admin.key)?;

                // Set admin to all zeros — irreversible
                let mut new_header = header;
                new_header.admin = [0u8; 32];
                state::write_header(&mut data, &new_header);
            }

            Instruction::CreateInsuranceMint => {
                // Create insurance LP mint for this market. Admin only, once per market.
                // Accounts: [admin(signer), slab, ins_lp_mint(writable), vault_authority,
                //            collateral_mint, system_program, token_program, rent, payer(signer+writable)]
                accounts::expect_len(accounts, 9)?;
                let a_admin = &accounts[0];
                let a_slab = &accounts[1];
                let a_ins_lp_mint = &accounts[2];
                let a_vault_authority = &accounts[3];
                let a_collateral_mint = &accounts[4];
                let a_system = &accounts[5];
                let a_token = &accounts[6];
                let a_rent = &accounts[7];
                let a_payer = &accounts[8];

                accounts::expect_signer(a_admin)?;
                accounts::expect_writable(a_ins_lp_mint)?;
                accounts::expect_signer(a_payer)?;
                accounts::expect_writable(a_payer)?;
                verify_token_program(a_token)?;

                let data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                let header = state::read_header(&data);
                require_admin(header.admin, a_admin.key)?;

                // Verify the ins_lp_mint PDA
                let (expected_mint, mint_bump) = accounts::derive_insurance_lp_mint(program_id, a_slab.key);
                accounts::expect_key(a_ins_lp_mint, &expected_mint)?;

                // Verify vault authority PDA
                let (expected_auth, _) = accounts::derive_vault_authority(program_id, a_slab.key);
                accounts::expect_key(a_vault_authority, &expected_auth)?;

                // Check mint doesn't already exist (data len == 0 means not yet created)
                if a_ins_lp_mint.data_len() > 0 {
                    return Err(PercolatorError::InsuranceMintAlreadyExists.into());
                }

                // Read collateral mint decimals
                let decimals = crate::insurance_lp::read_mint_decimals(a_collateral_mint)?;

                // Create and initialize the mint PDA
                let slab_key_bytes = a_slab.key.as_ref();
                let bump_arr: [u8; 1] = [mint_bump];
                let mint_seeds: &[&[u8]] = &[b"ins_lp", slab_key_bytes, &bump_arr];

                crate::insurance_lp::create_mint(
                    a_payer,
                    a_ins_lp_mint,
                    a_vault_authority,
                    a_system,
                    a_token,
                    a_rent,
                    decimals,
                    mint_seeds,
                )?;

                msg!("Insurance LP mint created");
            }

            Instruction::DepositInsuranceLP { amount } => {
                // Deposit collateral into insurance fund, receive LP tokens.
                // Accounts: [depositor(signer), slab(writable), depositor_ata(writable),
                //            vault(writable), token_program, ins_lp_mint(writable),
                //            depositor_lp_ata(writable), vault_authority]
                accounts::expect_len(accounts, 8)?;
                let a_depositor = &accounts[0];
                let a_slab = &accounts[1];
                let a_depositor_ata = &accounts[2];
                let a_vault = &accounts[3];
                let a_token = &accounts[4];
                let a_ins_lp_mint = &accounts[5];
                let a_depositor_lp_ata = &accounts[6];
                let a_vault_authority = &accounts[7];

                accounts::expect_signer(a_depositor)?;
                accounts::expect_writable(a_slab)?;
                accounts::expect_writable(a_depositor_ata)?;
                accounts::expect_writable(a_vault)?;
                accounts::expect_writable(a_ins_lp_mint)?;
                accounts::expect_writable(a_depositor_lp_ata)?;
                verify_token_program(a_token)?;

                if amount == 0 {
                    return Err(PercolatorError::InsuranceZeroAmount.into());
                }

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                // Block deposits on resolved markets
                if state::is_resolved(&data) {
                    return Err(ProgramError::InvalidAccountData);
                }

                let config = state::read_config(&data);
                let mint = Pubkey::new_from_array(config.collateral_mint);

                // Verify vault
                let (auth, vault_bump) = accounts::derive_vault_authority(program_id, a_slab.key);
                verify_vault(a_vault, &auth, &mint, &Pubkey::new_from_array(config.vault_pubkey))?;
                verify_token_account(a_depositor_ata, a_depositor.key, &mint)?;

                // Verify insurance LP mint PDA
                let (expected_lp_mint, _) = accounts::derive_insurance_lp_mint(program_id, a_slab.key);
                accounts::expect_key(a_ins_lp_mint, &expected_lp_mint)?;

                // Verify LP mint exists
                if a_ins_lp_mint.data_len() == 0 {
                    return Err(PercolatorError::InsuranceMintNotCreated.into());
                }

                // Verify vault authority PDA
                accounts::expect_key(a_vault_authority, &auth)?;

                // Read current insurance balance and LP supply BEFORE deposit
                let engine = zc::engine_mut(&mut data)?;
                let insurance_balance_before: u128 = engine.insurance_fund.balance.get();
                let lp_supply = crate::insurance_lp::read_mint_supply(a_ins_lp_mint)?;

                // Transfer collateral from depositor to vault
                collateral::deposit(a_token, a_depositor_ata, a_vault, a_depositor, amount)?;

                // Convert base tokens to units
                let (units, dust) = crate::units::base_to_units(amount, config.unit_scale);

                // Accumulate dust
                let old_dust = state::read_dust_base(&data);
                state::write_dust_base(&mut data, old_dust.saturating_add(dust));

                // Calculate LP tokens to mint
                let lp_tokens_to_mint: u64 = if lp_supply == 0 {
                    // First deposit: 1:1 ratio (units of collateral = LP tokens)
                    // Guard: if insurance already has balance but supply is 0, that means
                    // admin topped up via TopUpInsurance before creating LP mint.
                    // Still safe: first LP depositor gets tokens proportional to their deposit only.
                    units
                } else {
                    if insurance_balance_before == 0 {
                        // Shouldn't happen: supply > 0 but balance == 0 means fund was drained.
                        // Reject to prevent division by zero and unfair minting.
                        return Err(PercolatorError::InsuranceSupplyMismatch.into());
                    }
                    // Proportional: tokens = deposit_units * supply / balance
                    // Use u128 for intermediate to prevent overflow
                    let numerator = (units as u128)
                        .checked_mul(lp_supply as u128)
                        .ok_or(PercolatorError::EngineOverflow)?;
                    let result = numerator / insurance_balance_before;
                    // Round DOWN (depositor gets fewer tokens — pool is never underfunded)
                    if result > u64::MAX as u128 {
                        return Err(PercolatorError::EngineOverflow.into());
                    }
                    result as u64
                };

                if lp_tokens_to_mint == 0 {
                    // Deposit too small to mint any LP tokens — reject to prevent loss
                    return Err(PercolatorError::InsuranceZeroAmount.into());
                }

                // Top up insurance fund in engine
                // Re-borrow engine after the collateral transfer
                let engine = zc::engine_mut(&mut data)?;
                engine.top_up_insurance_fund(units as u128).map_err(map_risk_error)?;

                // Mint LP tokens to depositor
                let seed1: &[u8] = b"vault";
                let seed2: &[u8] = a_slab.key.as_ref();
                let bump_arr: [u8; 1] = [vault_bump];
                let seed3: &[u8] = &bump_arr;
                let seeds: [&[u8]; 3] = [seed1, seed2, seed3];
                let signer_seeds: [&[&[u8]]; 1] = [&seeds];

                crate::insurance_lp::mint_to(
                    a_token,
                    a_ins_lp_mint,
                    a_depositor_lp_ata,
                    a_vault_authority,
                    lp_tokens_to_mint,
                    &signer_seeds,
                )?;

                msg!("Insurance LP deposit: {} tokens, {} LP minted", amount, lp_tokens_to_mint);
            }

            Instruction::WithdrawInsuranceLP { lp_amount } => {
                // Burn LP tokens and withdraw proportional share of insurance fund.
                // Accounts: [withdrawer(signer), slab(writable), withdrawer_ata(writable),
                //            vault(writable), token_program, ins_lp_mint(writable),
                //            withdrawer_lp_ata(writable), vault_authority]
                accounts::expect_len(accounts, 8)?;
                let a_withdrawer = &accounts[0];
                let a_slab = &accounts[1];
                let a_withdrawer_ata = &accounts[2];
                let a_vault = &accounts[3];
                let a_token = &accounts[4];
                let a_ins_lp_mint = &accounts[5];
                let a_withdrawer_lp_ata = &accounts[6];
                let a_vault_authority = &accounts[7];

                accounts::expect_signer(a_withdrawer)?;
                accounts::expect_writable(a_slab)?;
                accounts::expect_writable(a_withdrawer_ata)?;
                accounts::expect_writable(a_vault)?;
                accounts::expect_writable(a_ins_lp_mint)?;
                accounts::expect_writable(a_withdrawer_lp_ata)?;
                verify_token_program(a_token)?;

                if lp_amount == 0 {
                    return Err(PercolatorError::InsuranceZeroAmount.into());
                }

                let mut data = state::slab_data_mut(a_slab)?;
                slab_guard(program_id, a_slab, &data)?;
                require_initialized(&data)?;

                let config = state::read_config(&data);
                let mint = Pubkey::new_from_array(config.collateral_mint);

                // Verify vault
                let (auth, vault_bump) = accounts::derive_vault_authority(program_id, a_slab.key);
                verify_vault(a_vault, &auth, &mint, &Pubkey::new_from_array(config.vault_pubkey))?;
                verify_token_account(a_withdrawer_ata, a_withdrawer.key, &mint)?;

                // Verify insurance LP mint PDA
                let (expected_lp_mint, _) = accounts::derive_insurance_lp_mint(program_id, a_slab.key);
                accounts::expect_key(a_ins_lp_mint, &expected_lp_mint)?;

                if a_ins_lp_mint.data_len() == 0 {
                    return Err(PercolatorError::InsuranceMintNotCreated.into());
                }

                // Verify vault authority
                accounts::expect_key(a_vault_authority, &auth)?;

                // Read current insurance balance and LP supply
                let engine = zc::engine_mut(&mut data)?;
                let insurance_balance: u128 = engine.insurance_fund.balance.get();
                let lp_supply = crate::insurance_lp::read_mint_supply(a_ins_lp_mint)?;

                if lp_supply == 0 || insurance_balance == 0 {
                    return Err(PercolatorError::InsuranceSupplyMismatch.into());
                }

                // Calculate units to return: lp_amount * insurance_balance / lp_supply
                // Round DOWN (user gets less — pool is never underfunded)
                let numerator = (lp_amount as u128)
                    .checked_mul(insurance_balance)
                    .ok_or(PercolatorError::EngineOverflow)?;
                let units_to_return = numerator / (lp_supply as u128);

                if units_to_return == 0 {
                    return Err(PercolatorError::InsuranceZeroAmount.into());
                }

                // Safety: cannot withdraw below risk_reduction_threshold
                let remaining = insurance_balance.saturating_sub(units_to_return);
                let threshold = engine.params.risk_reduction_threshold;
                if remaining < threshold.get() {
                    return Err(PercolatorError::InsuranceBelowThreshold.into());
                }

                // Convert units to base tokens
                let units_u64 = if units_to_return > u64::MAX as u128 {
                    return Err(PercolatorError::EngineOverflow.into());
                } else {
                    units_to_return as u64
                };
                let base_amount = crate::units::units_to_base_checked(units_u64, config.unit_scale)
                    .ok_or(PercolatorError::EngineOverflow)?;

                // Reduce insurance fund balance (checked to prevent silent underflow)
                let new_balance = insurance_balance
                    .checked_sub(units_to_return)
                    .ok_or(PercolatorError::EngineOverflow)?;
                engine.insurance_fund.balance = percolator::U128::new(new_balance);

                // Burn LP tokens from withdrawer (user signs as authority over their tokens)
                crate::insurance_lp::burn(
                    a_token,
                    a_ins_lp_mint,
                    a_withdrawer_lp_ata,
                    a_withdrawer,
                    lp_amount,
                )?;

                // Transfer collateral from vault to withdrawer
                let seed1: &[u8] = b"vault";
                let seed2: &[u8] = a_slab.key.as_ref();
                let bump_arr: [u8; 1] = [vault_bump];
                let seed3: &[u8] = &bump_arr;
                let seeds: [&[u8]; 3] = [seed1, seed2, seed3];
                let signer_seeds: [&[&[u8]]; 1] = [&seeds];

                collateral::withdraw(
                    a_token,
                    a_vault,
                    a_withdrawer_ata,
                    a_vault_authority,
                    base_amount,
                    &signer_seeds,
                )?;

                msg!("Insurance LP withdraw: {} LP burned, {} tokens returned", lp_amount, base_amount);
            }
        }
        Ok(())
    }
}

// 10. mod entrypoint
pub mod entrypoint {
    #[allow(unused_imports)]
    use alloc::format; // Required by entrypoint! macro in SBF builds
    use solana_program::{
        account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
    };
    use crate::processor;

    entrypoint!(process_instruction);

    fn process_instruction<'a>(
        program_id: &Pubkey,
        accounts: &'a [AccountInfo<'a>],
        instruction_data: &[u8],
    ) -> ProgramResult {
        processor::process_instruction(program_id, accounts, instruction_data)
    }
}

// 11. mod risk (glue)
pub mod risk {
    pub use percolator::{RiskEngine, RiskParams, RiskError, NoOpMatcher, MatchingEngine, TradeExecution};
}

