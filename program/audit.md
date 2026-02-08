# Percolator-prog Formal Verification Audit

## Kani Proofs Summary

**Date:** 2026-02-06
**Kani Version:** 0.66.0
**Total Proofs:** 143
**Passed:** 143
**Failed:** 0

## Proof Categories

These proofs verify **program-level** security properties.
Risk engine internals are NOT modeled - only wrapper authorization, binding logic, and unit conversions.

### A. Matcher ABI Validation (13 proofs)
| # | Harness | Property |
|---|---------|----------|
| 1 | kani_matcher_rejects_wrong_abi_version | Wrong ABI version rejected |
| 2 | kani_matcher_rejects_missing_valid_flag | Missing VALID flag rejected |
| 3 | kani_matcher_rejects_rejected_flag | REJECTED flag causes rejection |
| 4 | kani_matcher_rejects_wrong_req_id | Mismatched req_id rejected |
| 5 | kani_matcher_rejects_wrong_lp_account_id | Mismatched lp_account_id rejected |
| 6 | kani_matcher_rejects_wrong_oracle_price | Mismatched oracle_price rejected |
| 7 | kani_matcher_rejects_nonzero_reserved | Non-zero reserved rejected |
| 8 | kani_matcher_rejects_zero_exec_price | Zero exec_price rejected |
| 9 | kani_matcher_zero_size_requires_partial_ok | Zero size needs PARTIAL_OK |
| 10 | kani_matcher_rejects_exec_size_exceeds_req | exec_size > req_size rejected |
| 11 | kani_matcher_rejects_sign_mismatch | Sign mismatch rejected |
| 53 | kani_matcher_zero_size_with_partial_ok_accepted | Zero size with PARTIAL_OK accepted |
| 79 | kani_min_abs_boundary_rejected | i128::MIN boundary handled correctly |

### B. Matcher Acceptance Tests (3 proofs)
| # | Harness | Property |
|---|---------|----------|
| 80 | kani_matcher_accepts_minimal_valid_nonzero_exec | Minimal valid inputs accepted |
| 81 | kani_matcher_accepts_exec_size_equal_req_size | exec_size == req_size accepted |
| 82 | kani_matcher_accepts_partial_fill_with_flag | Partial fill with PARTIAL_OK accepted |

### C. Owner/Signer Enforcement (2 proofs)
| # | Harness | Property |
|---|---------|----------|
| 12 | kani_owner_mismatch_rejected | Owner != signer -> rejected |
| 13 | kani_owner_match_accepted | Owner == signer -> accepted |

### D. Admin Authorization (3 proofs)
| # | Harness | Property |
|---|---------|----------|
| 14 | kani_admin_mismatch_rejected | Admin != signer -> rejected |
| 15 | kani_admin_match_accepted | Admin == signer -> accepted |
| 16 | kani_admin_burned_disables_ops | Admin == [0;32] -> all ops disabled |

### E. CPI Identity Binding (2 proofs) - CRITICAL
| # | Harness | Property |
|---|---------|----------|
| 17 | kani_matcher_identity_mismatch_rejected | LP prog/ctx != provided -> rejected |
| 18 | kani_matcher_identity_match_accepted | LP prog/ctx == provided -> accepted |

### F. Matcher Account Shape Validation (5 proofs)
| # | Harness | Property |
|---|---------|----------|
| 19 | kani_matcher_shape_rejects_non_executable_prog | Non-executable program rejected |
| 20 | kani_matcher_shape_rejects_executable_ctx | Executable context rejected |
| 21 | kani_matcher_shape_rejects_wrong_ctx_owner | Context not owned by program rejected |
| 22 | kani_matcher_shape_rejects_short_ctx | Insufficient context length rejected |
| 23 | kani_matcher_shape_valid_accepted | Valid shape accepted |

### G. PDA Key Matching (2 proofs)
| # | Harness | Property |
|---|---------|----------|
| 24 | kani_pda_mismatch_rejected | Expected != provided key -> rejected |
| 25 | kani_pda_match_accepted | Expected == provided key -> accepted |

### H. Nonce Monotonicity (3 proofs)
| # | Harness | Property |
|---|---------|----------|
| 26 | kani_nonce_unchanged_on_failure | Failure -> nonce unchanged |
| 27 | kani_nonce_advances_on_success | Success -> nonce += 1 |
| 28 | kani_nonce_wraps_at_max | u64::MAX -> wraps to 0 |

### I. CPI Uses exec_size (1 proof) - CRITICAL
| # | Harness | Property |
|---|---------|----------|
| 29 | kani_cpi_uses_exec_size | CPI uses exec_size, not requested size |

### J. Gate Activation Logic (3 proofs)
| # | Harness | Property |
|---|---------|----------|
| 30 | kani_gate_inactive_when_threshold_zero | threshold=0 -> gate inactive |
| 31 | kani_gate_inactive_when_balance_exceeds | balance > threshold -> gate inactive |
| 32 | kani_gate_active_when_conditions_met | threshold>0 && balance<=threshold -> gate active |

### K. Per-Instruction Authorization (4 proofs)
| # | Harness | Property |
|---|---------|----------|
| 33 | kani_single_owner_mismatch_rejected | Single-owner instruction rejects on mismatch |
| 34 | kani_single_owner_match_accepted | Single-owner instruction accepts on match |
| 35 | kani_trade_rejects_user_mismatch | Trade rejects when user owner mismatch |
| 36 | kani_trade_rejects_lp_mismatch | Trade rejects when LP owner mismatch |

### L. TradeCpi Decision Coupling (14 proofs) - CRITICAL
| # | Harness | Property |
|---|---------|----------|
| 37 | kani_tradecpi_rejects_non_executable_prog | Bad shape (non-exec prog) -> reject |
| 38 | kani_tradecpi_rejects_executable_ctx | Bad shape (exec ctx) -> reject |
| 39 | kani_tradecpi_rejects_pda_mismatch | PDA mismatch -> reject |
| 40 | kani_tradecpi_rejects_user_auth_failure | User auth failure -> reject |
| 41 | kani_tradecpi_rejects_lp_auth_failure | LP auth failure -> reject |
| 42 | kani_tradecpi_rejects_identity_mismatch | Identity mismatch -> reject |
| 43 | kani_tradecpi_rejects_abi_failure | ABI failure -> reject |
| 44 | kani_tradecpi_rejects_gate_risk_increase | Gate active + risk increase -> reject |
| 45 | kani_tradecpi_allows_gate_risk_decrease | Gate active + risk decrease -> accept |
| 46 | kani_tradecpi_reject_nonce_unchanged | Reject -> nonce unchanged |
| 47 | kani_tradecpi_accept_increments_nonce | Accept -> nonce += 1 |
| 48 | kani_tradecpi_accept_uses_exec_size | Accept -> uses exec_size |
| 54 | kani_tradecpi_rejects_ctx_owner_mismatch | Context not owned by program -> reject |
| 55 | kani_tradecpi_rejects_ctx_len_short | Context length insufficient -> reject |

### M. TradeNoCpi Decision Coupling (4 proofs)
| # | Harness | Property |
|---|---------|----------|
| 49 | kani_tradenocpi_rejects_user_auth_failure | User auth failure -> reject |
| 50 | kani_tradenocpi_rejects_lp_auth_failure | LP auth failure -> reject |
| 51 | kani_tradenocpi_rejects_gate_risk_increase | Gate active + risk increase -> reject |
| 52 | kani_tradenocpi_accepts_valid | All checks pass -> accept |

### N. Universal Nonce Properties (2 proofs) - CRITICAL
| # | Harness | Property |
|---|---------|----------|
| 56 | kani_tradecpi_any_reject_nonce_unchanged | ANY rejection -> nonce unchanged |
| 57 | kani_tradecpi_any_accept_increments_nonce | ANY acceptance -> nonce += 1 |

### O. Account Validation Helpers (1 consolidated proof)
| # | Harness | Property |
|---|---------|----------|
| 58 | kani_len_ok_universal | len_ok(actual, need) = (actual >= need) for all values |

### P. LP PDA Shape Validation (4 proofs)
| # | Harness | Property |
|---|---------|----------|
| 59 | kani_lp_pda_shape_valid | Valid LP PDA shape accepted |
| 60 | kani_lp_pda_rejects_wrong_owner | Non-system-owned LP PDA rejected |
| 61 | kani_lp_pda_rejects_has_data | LP PDA with data rejected |
| 62 | kani_lp_pda_rejects_funded | Funded LP PDA rejected |

### Q. Oracle Key Validation (2 proofs)
| # | Harness | Property |
|---|---------|----------|
| 63 | kani_oracle_feed_id_match | Matching oracle feed IDs accepted |
| 64 | kani_oracle_feed_id_mismatch | Mismatched oracle feed IDs rejected |

### R. Slab Shape Validation (2 proofs)
| # | Harness | Property |
|---|---------|----------|
| 65 | kani_slab_shape_valid | Valid slab shape accepted |
| 66 | kani_slab_shape_invalid | Invalid slab shape rejected |

### S. Simple Decision Functions (8 proofs)
| # | Harness | Property |
|---|---------|----------|
| 67 | kani_decide_single_owner_accepts | Auth ok -> accept |
| 68 | kani_decide_single_owner_rejects | Auth fail -> reject |
| 69 | kani_decide_crank_permissionless_accepts | No account -> permissionless crank |
| 70 | kani_decide_crank_self_accepts | Owner matches -> crank allowed |
| 71 | kani_decide_crank_rejects_no_idx | Account exists but idx missing -> reject |
| 72 | kani_decide_crank_rejects_wrong_owner | Owner mismatch -> crank rejected |
| 73 | kani_decide_admin_accepts | Valid admin -> accept |
| 74 | kani_decide_admin_rejects | Invalid admin -> reject |

### T. ABI Equivalence (1 proof) - CRITICAL
| # | Harness | Property |
|---|---------|----------|
| 75 | kani_abi_ok_equals_validate | verify::abi_ok == validate_matcher_return.is_ok() |

### U. TradeCpi From Real Inputs (5 proofs) - CRITICAL
| # | Harness | Property |
|---|---------|----------|
| 76 | kani_tradecpi_from_ret_any_reject_nonce_unchanged | ANY rejection (real) -> nonce unchanged |
| 77 | kani_tradecpi_from_ret_any_accept_increments_nonce | ANY acceptance (real) -> nonce += 1 |
| 78 | kani_tradecpi_from_ret_accept_uses_exec_size | ANY acceptance -> uses exec_size |
| 121 | kani_tradecpi_from_ret_req_id_is_nonce_plus_one | req_id == nonce + 1 on success |
| 126 | kani_tradecpi_from_ret_forced_acceptance | Valid inputs force Accept path |

### V. Crank Panic Mode Authorization (6 proofs)
| # | Harness | Property |
|---|---------|----------|
| 83 | kani_crank_panic_requires_admin | Panic crank requires admin |
| 84 | kani_crank_panic_with_admin_permissionless_accepts | Admin + permissionless -> accept |
| 85 | kani_crank_panic_burned_admin_rejects | Burned admin -> reject |
| 86 | kani_crank_no_panic_permissionless_accepts | Non-panic permissionless -> accept |
| 87 | kani_crank_no_panic_self_crank_rejects_wrong_owner | Self-crank wrong owner -> reject |
| 88 | kani_crank_no_panic_self_crank_accepts_owner_match | Self-crank correct owner -> accept |

### W. Haircut Inversion Properties (5 proofs)
| # | Harness | Property |
|---|---------|----------|
| 89 | kani_invert_zero_returns_raw | h=0 -> raw value unchanged |
| 90 | kani_invert_nonzero_computes_correctly | h>0 -> correct computation |
| 91 | kani_invert_zero_raw_returns_none | raw=0 -> returns None |
| 92 | kani_invert_result_zero_returns_none | result=0 -> returns None |
| 93 | kani_invert_monotonic | Inversion preserves ordering |

### X. Unit Scale Conversion Properties (11 proofs)
| # | Harness | Property |
|---|---------|----------|
| 94 | kani_base_to_units_conservation | units + dust == base (no value loss) |
| 95 | kani_base_to_units_dust_bound | dust < unit_scale (bounded) |
| 96 | kani_base_to_units_scale_zero | scale=0 -> units=base, dust=0 |
| 97 | kani_units_roundtrip | base_to_units -> units_to_base roundtrips |
| 98 | kani_units_to_base_scale_zero | scale=0 -> base=units |
| 99 | kani_base_to_units_monotonic | Larger base -> larger units |
| 100 | kani_units_to_base_monotonic_bounded | Larger units -> larger base (bounded) |
| 101 | kani_base_to_units_monotonic_scale_zero | Monotonic even with scale=0 |
| 123 | kani_units_roundtrip_exact_when_no_dust | Perfect roundtrip when dust=0 |
| 132 | kani_unit_conversion_deterministic | Same inputs -> same outputs |
| 133 | kani_scale_validation_pure | Scale validation is deterministic |

### Y. Withdrawal Alignment Properties (3 proofs)
| # | Harness | Property |
|---|---------|----------|
| 102 | kani_withdraw_misaligned_rejects | Misaligned withdrawal rejected |
| 103 | kani_withdraw_aligned_accepts | Aligned withdrawal accepted |
| 104 | kani_withdraw_scale_zero_always_aligned | scale=0 -> always aligned |

### Z. Dust Sweep Properties (8 proofs)
| # | Harness | Property |
|---|---------|----------|
| 105 | kani_sweep_dust_conservation | swept + remaining == original |
| 106 | kani_sweep_dust_rem_bound | Remaining dust bounded |
| 107 | kani_sweep_dust_below_threshold | Swept dust below threshold |
| 108 | kani_sweep_dust_scale_zero | scale=0 -> no dust to sweep |
| 109 | kani_accumulate_dust_saturates | Dust accumulation saturates |
| 110 | kani_scale_zero_policy_no_dust | scale=0 policy produces no dust |
| 111 | kani_scale_zero_policy_sweep_complete | scale=0 sweep is complete |
| 112 | kani_scale_zero_policy_end_to_end | scale=0 end-to-end invariants |

### AA. Universal Rejection Properties (6 proofs)
| # | Harness | Property |
|---|---------|----------|
| 113 | kani_universal_shape_fail_rejects | ANY shape failure -> reject |
| 114 | kani_universal_pda_fail_rejects | ANY PDA failure -> reject |
| 115 | kani_universal_user_auth_fail_rejects | ANY user auth failure -> reject |
| 116 | kani_universal_lp_auth_fail_rejects | ANY LP auth failure -> reject |
| 117 | kani_universal_identity_fail_rejects | ANY identity failure -> reject |
| 118 | kani_universal_abi_fail_rejects | ANY ABI failure -> reject |

### BB. TradeCpi Variant Consistency (2 proofs)
| # | Harness | Property |
|---|---------|----------|
| 119 | kani_tradecpi_variants_consistent_valid_shape | decide_trade_cpi == decide_trade_cpi_from_ret (valid) |
| 120 | kani_tradecpi_variants_consistent_invalid_shape | decide_trade_cpi == decide_trade_cpi_from_ret (invalid) |

### CC. Universal Gate/Panic Properties (3 proofs)
| # | Harness | Property |
|---|---------|----------|
| 122 | kani_universal_gate_risk_increase_rejects | Gate active + risk increase -> reject |
| 124 | kani_universal_panic_requires_admin | Panic mode requires admin auth |
| 125 | kani_universal_gate_risk_increase_rejects_from_ret | Gate rejection (real inputs) |

### DD. InitMarket Scale Validation (5 proofs)
| # | Harness | Property |
|---|---------|----------|
| 127 | kani_init_market_scale_rejects_overflow | Overflow scale rejected |
| 128 | kani_init_market_scale_zero_ok | scale=0 accepted |
| 129 | kani_init_market_scale_boundary_ok | scale=MAX_UNIT_SCALE accepted |
| 130 | kani_init_market_scale_boundary_reject | scale=MAX+1 rejected |
| 131 | kani_init_market_scale_valid_range | Valid range [0, MAX] accepted |

### EE. scale_price_e6 Properties (4 proofs)
| # | Harness | Property |
|---|---------|----------|
| 134 | kani_scale_price_e6_zero_result_rejected | Zero result -> None |
| 135 | kani_scale_price_e6_valid_result | Valid inputs -> Some(price/scale) |
| 136 | kani_scale_price_e6_identity_for_scale_leq_1 | scale≤1 -> identity |
| 138 | kani_scale_price_e6_concrete_example | Concrete example: 1_000_000/100=10_000 |

### FF. scale_price_e6 and base_to_units Consistency (1 proof)
| # | Harness | Property |
|---|---------|----------|
| 137 | kani_scale_price_and_base_to_units_use_same_divisor | Both use /unit_scale |

### GG. clamp_toward_with_dt Rate Limiting (5 proofs) - Bug #9
| # | Harness | Property |
|---|---------|----------|
| 139 | kani_clamp_toward_no_movement_when_dt_zero | dt=0 -> index unchanged |
| 140 | kani_clamp_toward_no_movement_when_cap_zero | cap=0 -> index unchanged |
| 141 | kani_clamp_toward_bootstrap_when_index_zero | index=0 -> jumps to mark |
| 142 | kani_clamp_toward_movement_bounded_concrete | Movement bounded by cap*dt |
| 143 | kani_clamp_toward_formula_concrete | Formula matches specification |

## Key Security Properties Proven

### Authorization Surface
1. **Owner checks cannot be bypassed** - Every account operation validates owner == signer
2. **Admin checks cannot be bypassed** - Admin ops require admin == signer
3. **Burned admin is permanent** - [0;32] admin disables all admin ops forever
4. **Crank authorization is correct** - Existing accounts require owner, non-existent allow anyone
5. **Trade requires both parties** - Both user and LP owners must sign

### CPI Security (CRITICAL)
1. **Matcher identity binding** - CPI only proceeds if provided program/context match LP registration
2. **Matcher shape validation** - Program must be executable, context must not be, owner must be program
3. **exec_size is used** - CPI path uses matcher's exec_size, never the user's requested size
4. **Identity mismatch rejects even with valid ABI** - Strong adversary model

### State Consistency
1. **Nonce unchanged on failure** - Any rejection leaves nonce unchanged
2. **Nonce advances on success** - Successful trade advances nonce by exactly 1
3. **Nonce wraps correctly** - u64::MAX wraps to 0

### Risk Gate Policy
1. **Gate inactive when threshold=0** - Zero threshold disables gating
2. **Gate inactive when balance > threshold** - Sufficient funds disable gating
3. **Risk-increasing trades rejected when gate active** - Anti-DoS protection
4. **Risk-reducing trades allowed when gate active** - Deleveraging permitted

### Matcher ABI
1. **All field mismatches rejected** - ABI version, req_id, lp_account_id, oracle_price, reserved
2. **Flag semantics enforced** - VALID required, REJECTED causes rejection, PARTIAL_OK for zero size
3. **Size constraints enforced** - exec_size <= req_size, sign must match
4. **No overflow on i128::MIN** - Uses unsigned_abs() to avoid panic on extreme values

### Unit Scale Conversions (NEW)
1. **Conservation** - base_to_units: units + dust == base
2. **Dust bounded** - dust < unit_scale always
3. **Monotonicity** - Larger inputs produce larger outputs
4. **Roundtrip** - units_to_base(base_to_units(x)) >= x
5. **Determinism** - Same inputs always produce same outputs

### Hyperp Index Smoothing (Bug #9 Fix)
1. **No movement when dt=0** - Second crank in same slot can't move index
2. **No movement when cap=0** - Zero cap means no movement allowed
3. **Bootstrap allowed** - index=0 can jump to mark (initial price discovery)
4. **Movement bounded** - |delta| <= cap * dt (rate limiting enforced)

## Proof Quality Audit (2026-02-06)

### Removed Vacuous/Trivial Proofs
- `kani_reject_has_no_chosen_size` - Structural tautology (Reject has no fields)
- `kani_signer_ok_*`, `kani_writable_ok_*` - Identity function tests
- `kani_*_independent_of_scale` - Fake non-interference tests
- Individual `kani_len_ok_*` - Consolidated into `kani_len_ok_universal`

### Fixed Proofs
- `kani_unit_conversion_deterministic` - Now calls function twice, not copy result
- `kani_tradecpi_from_ret_accept_uses_exec_size` - Forces Accept path with valid req_id

### Bounded Verification
- `KANI_MAX_SCALE = 64` - Tractable scale values
- `KANI_MAX_QUOTIENT = 4096` - Tractable quotient values
- Price/base bounds: `<= KANI_MAX_QUOTIENT * unit_scale` for SAT tractability

## What is NOT Proven

- Risk engine internals (LpRiskState, risk metric formula)
- CPI execution (Solana invoke mechanics)
- AccountInfo validation (done at runtime by Solana)
- Actual PDA derivation (Solana's find_program_address)
- Token transfer correctness (SPL Token program)
- Arbitrary u64 inputs (bounded for SAT tractability)
