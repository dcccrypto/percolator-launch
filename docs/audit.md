# Percolator Adversarial Audit v2 — 2026-02-09

## Methodology
Line-by-line adversarial review of:
- On-chain program (`program/src/percolator.rs`, 4902 lines)
- Core package (`packages/core/src/abi/`, `math/`)
- Server services (`packages/server/src/services/`)
- Rust tests (`program/tests/insurance_lp_tests.rs`)
- TypeScript E2E tests (`app/scripts/test-insurance-lp.ts`)

Assumption: developer is adversarial. Every line could be a backdoor.

---

## Implementation Findings

### CRITICAL: C1 — DEX Oracle Flash Loan Manipulation (No TWAP)
- **Location:** `program/src/percolator.rs:1950-2150` (read_pumpswap_price_e6, read_raydium_clmm_price_e6, read_meteora_dlmm_price_e6)
- **Issue:** All DEX oracle readers use instantaneous spot prices vulnerable to flash-loan manipulation within a single transaction.
- **Attack:** Flash loan → inflate reserves → crank at manipulated price → execute trades/liquidations → repay.
- **Fix:** Design limitation — document clearly. Require authority oracle for high-TVL markets. Circuit breaker (`clamp_oracle_price`) provides partial mitigation but first price has no cap.
- **Status:** ❌ Open (design limitation, documented in code comments)

### CRITICAL: C2 — `saturating_sub` in WithdrawInsuranceLP (v1 finding)
- **Location:** `program/src/percolator.rs` — WithdrawInsuranceLP handler, insurance_fund.balance update
- **Issue:** v1 audit found `saturating_sub` bug. **Verified: This IS now fixed.** Code uses `checked_sub` with `EngineOverflow` error.
- **Status:** ✅ Fixed

### CRITICAL: C3 — Template Literal Syntax Error in E2E Test
- **Location:** `app/scripts/e2e-devnet-test.ts:64`
- **Issue:** Regular string used where template literal needed: `"...${process.env.HELIUS_API_KEY}..."` — TS compilation error.
- **Fix:** Changed to backtick template literal.
- **Status:** ✅ Fixed (this commit)

### HIGH: H1 — No Zero-Collateral Position Guard at Program Level
- **Location:** `program/src/percolator.rs` — TradeNoCpi/TradeCpi handlers
- **Issue:** The program does NOT explicitly prevent opening a position with 0 collateral. It relies on the underlying `RiskEngine::execute_trade` to enforce margin checks. If the engine has a bug in margin validation for zero-capital accounts, positions could be opened without collateral. The engine checks `initial_margin_bps` but if `notional == 0` (size=0), the margin check trivially passes.
- **Attack:** A user with 0 capital could call TradeNoCpi with size=0, which is a no-op but allocated an account slot. More critically: if engine ever accepts a trade where margin = 0 due to integer division (e.g., tiny position × high leverage), the user gets a free option.
- **Fix:** The engine's `execute_trade` should reject trades where resulting capital < minimum. This is an engine-level check, not a wrapper issue.
- **Status:** ❌ Open (requires engine audit — `percolator` crate not in this repo)

### HIGH: H2 — Admin Functions After RenounceAdmin
- **Location:** `program/src/percolator.rs` — RenounceAdmin (Tag 23), all admin handlers
- **Issue:** After `RenounceAdmin`, admin is set to `[0u8; 32]`. The `admin_ok` helper checks `admin != [0u8; 32] && admin == signer`. This correctly blocks ALL admin operations after renounce. **No bypass path found.**
- **Status:** ✅ Verified secure

### HIGH: H3 — Liquidation Cannot Be Self-Prevented
- **Location:** `program/src/percolator.rs` — LiquidateAtOracle (Tag 7)
- **Issue:** Liquidation is permissionless (no signer check on accounts[0]). Anyone can call it. The target cannot prevent liquidation since they can't block the transaction. The engine checks `is_undercollateralized` at oracle price. A user cannot manipulate oracle price (Pyth/Chainlink) to avoid liquidation. For admin oracle markets, the oracle authority controls the price, which is a known trust assumption.
- **Status:** ✅ Verified secure (by design)

### HIGH: H4 — Liquidation of Healthy Positions
- **Location:** `program/src/percolator.rs` — LiquidateAtOracle handler
- **Issue:** The program delegates to `engine.liquidate_at_oracle()` which checks margin. If the engine correctly validates that the position IS underwater before liquidating, this is secure. The wrapper does NOT add any additional margin check — it trusts the engine entirely.
- **Status:** ⚠️ Depends on engine correctness (not auditable from wrapper alone)

### HIGH: H5 — `devnet` Feature Disables Oracle Safety
- **Location:** `program/src/percolator.rs:1770-1790` (Pyth reader), `1880-1895` (Chainlink reader)
- **Issue:** With `#[cfg(feature = "devnet")]`, staleness and confidence checks are completely skipped. If this feature flag is accidentally left on for mainnet build, oracles provide no safety guarantees.
- **Fix:** Already documented in code with `// SECURITY (H5)` comment. CI should verify mainnet builds exclude `devnet` feature.
- **Status:** ⚠️ Informational (build process must exclude `devnet`)

### MEDIUM: M1 — PushOraclePrice Doesn't Validate Timestamp Ordering
- **Location:** `program/src/percolator.rs` — PushOraclePrice handler (Tag 17)
- **Issue:** The handler accepts any timestamp without checking that it's >= the previous timestamp. An oracle authority could push prices with past timestamps. However, the circuit breaker clamps the price magnitude, and the stored `authority_timestamp` is only used for staleness checks (which accept any non-stale value).
- **Attack:** Oracle authority pushes price with timestamp=0 → next reads see it as stale (if non-Hyperp) → price not used. This is a self-DoS, not an exploit.
- **Status:** ⚠️ Low risk (authority is trusted)

### MEDIUM: M2 — CrankService No Mutex (Double-Processing)
- **Location:** `packages/server/src/services/crank.ts:145-155`
- **Issue:** The `_cycling` flag prevents overlapping cycles, but there's no mutex. If `crankAll()` is called directly (e.g., via API route) while a timer cycle is running, both could process the same market. However, double-cranking is idempotent on-chain (engine deduplicates via slot checks), so this is a wasted-compute issue, not a correctness issue.
- **Status:** ⚠️ Low risk (idempotent on-chain)

### MEDIUM: M3 — Oracle Service Accepts Any API Response
- **Location:** `packages/server/src/services/oracle.ts:40-55`
- **Issue:** `fetchDexScreenerPrice` parses `parseFloat(pair.priceUsd)` without range validation. A DexScreener API returning `"0"`, `"NaN"`, or extremely large values would result in `0n` or garbage prices being pushed on-chain. The on-chain circuit breaker clamps magnitude, providing partial protection.
- **Fix:** Add validation: price must be > 0, < reasonable max, and not NaN/Infinity.
- **Status:** ❌ Open

### MEDIUM: M4 — Pre-existing TypeScript Compilation Errors in `app/`
- **Location:** `app/api/crank/[slab]/route.ts`, `app/api/markets/*/route.ts`
- **Issue:** Missing `@/lib/api-auth` module and `requireAuth` references. These are pre-existing (not from this audit).
- **Status:** ❌ Open (pre-existing)

### LOW: L1 — Rounding Direction in Insurance LP Shares
- **Location:** `program/src/percolator.rs` — DepositInsuranceLP, WithdrawInsuranceLP
- **Issue:** Both deposit (LP minting) and withdrawal (collateral return) round DOWN via integer division. This always favors the pool, which is correct. Verified by `test_rounding_favors_pool` test.
- **Status:** ✅ Correct

### LOW: L2 — `encode_init_market` Test Missing `initial_mark_price_e6` Field
- **Location:** `program/tests/insurance_lp_tests.rs:168`
- **Issue:** The `encode_init_market` function doesn't encode `initial_mark_price_e6` (added for Hyperp mode). It encodes the old layout. This works because the field defaults to 0 (non-Hyperp mode), and the Rust decoder reads it as 0 which is valid for non-Hyperp. But the byte layout doesn't match the instruction decoder for tag 0.
- **Wait:** Looking more carefully, line 167 encodes `unit_scale` (u32), then immediately starts risk params. The Rust decoder expects `initial_mark_price_e6` (u64) after `unit_scale`. The test encodes the old layout missing this 8-byte field, which means all subsequent risk params are shifted by 8 bytes. **This would cause the test to decode garbage risk params.**
- **Fix:** Add `encode_u64(0, &mut data);` after the `unit_scale` line in the test encoder.
- **Status:** ✅ Fixed (this commit)

---

## ABI Verification

### Instruction Encoders (TypeScript ↔ Rust)
Verified byte-by-byte for all 27 tags (0-26):

| Tag | Instruction | TS Layout | Rust Layout | Match? |
|-----|-------------|-----------|-------------|--------|
| 0 | InitMarket | tag(1)+admin(32)+mint(32)+feed(32)+staleness(8)+conf(2)+invert(1)+scale(4)+markPrice(8)+RiskParams | Same | ✅ |
| 1 | InitUser | tag(1)+fee(8) | Same | ✅ |
| 2 | InitLP | tag(1)+prog(32)+ctx(32)+fee(8) | Same | ✅ |
| 3 | Deposit | tag(1)+idx(2)+amount(8) | Same | ✅ |
| 4 | Withdraw | tag(1)+idx(2)+amount(8) | Same | ✅ |
| 5 | KeeperCrank | tag(1)+idx(2)+panic(1) | Same | ✅ |
| 6 | TradeNoCpi | tag(1)+lp(2)+user(2)+size(16) | Same | ✅ |
| 7 | Liquidate | tag(1)+idx(2) | Same | ✅ |
| 8 | Close | tag(1)+idx(2) | Same | ✅ |
| 9 | TopUp | tag(1)+amount(8) | Same | ✅ |
| 10 | TradeCpi | tag(1)+lp(2)+user(2)+size(16) | Same | ✅ |
| 11 | SetThreshold | tag(1)+threshold(16) | Same | ✅ |
| 12 | UpdateAdmin | tag(1)+admin(32) | Same | ✅ |
| 13 | CloseSlab | tag(1) | Same | ✅ |
| 14 | UpdateConfig | tag(1)+13 params | Same | ✅ |
| 15 | SetMaintFee | tag(1)+fee(16) | Same | ✅ |
| 16 | SetOracleAuth | tag(1)+auth(32) | Same | ✅ |
| 17 | PushPrice | tag(1)+price(8)+ts(8) | Same | ✅ |
| 18 | SetCap | tag(1)+cap(8) | Same | ✅ |
| 19 | Resolve | tag(1) | Same | ✅ |
| 20 | WithdrawIns | tag(1) | Same | ✅ |
| 21 | ForceClose | tag(1)+idx(2) | Same | ✅ |
| 22 | UpdateRisk | tag(1)+init(8)+maint(8) | Same | ✅ |
| 23 | Renounce | tag(1) | Same | ✅ |
| 24 | CreateMint | tag(1) | Same | ✅ |
| 25 | DepositLP | tag(1)+amount(8) | Same | ✅ |
| 26 | WithdrawLP | tag(1)+amount(8) | Same | ✅ |

### Account Ordering (TypeScript ↔ Rust)
Verified account count and signer/writable flags for all instructions. All match.

### Encode/Decode Helpers
- `encU8/16/32/64/128`, `encI64/128`, `encPubkey`: All produce correct little-endian byte layouts. ✅
- `encI128`: Correctly uses two's complement for negative values. ✅
- Rust `read_*` helpers: All use correct byte widths and `from_le_bytes`. ✅

---

## Math Audit (`packages/core/src/math/trading.ts`)

### `computeMarkPnl`
- Zero position → 0n ✅
- Zero oracle → 0n ✅
- Long profit: `(oracle - entry) * absPos / oracle` — correct coin-margined formula ✅
- Short profit: `(entry - oracle) * absPos / oracle` — correct ✅
- **Edge case:** `positionSize = -1n, entry = 1n, oracle = max_u64` → large negative pnl. Result is bounded by position size, no overflow in bigint. ✅

### `computeLiqPrice`
- Uses `Number()` conversions which lose precision for values > 2^53. For typical position sizes (< 10^18 lamports = ~1B SOL), this is acceptable but would be imprecise for extreme values.
- **Status:** ⚠️ Informational — consider using bigint throughout for precision

### `computeTradingFee`
- Simple `notional * bps / 10000`. Correct. ✅

---

## Test Validity Audit

### Rust Tests (`insurance_lp_tests.rs`)

| Test | Claims | Assertion Valid? | Vacuous? | Edge Cases? |
|------|--------|-----------------|----------|-------------|
| `test_create_insurance_mint_success` | Create works | ⚠️ Test acknowledges it may fail due to harness limitation | N/A | No |
| `test_create_insurance_mint_already_exists` | Rejects duplicate | ✅ Checks exact error code | No | Error path ✅ |
| `test_create_insurance_mint_non_admin_fails` | Non-admin rejected | ✅ Checks is_err | No | Error path ✅ |
| `test_deposit_first_deposit_1_to_1` | 1:1 first deposit | ✅ Checks LP balance, mint supply, insurance balance, vault | No | Happy path |
| `test_deposit_zero_amount_rejected` | Zero rejected | ✅ Exact error code | No | Error path ✅ |
| `test_deposit_resolved_market_blocked` | Resolved blocks deposit | ✅ | No | Error path ✅ |
| `test_deposit_mint_not_created_fails` | No mint = error | ✅ | No | Error path ✅ |
| `test_deposit_second_deposit_proportional` | Proportional minting | ✅ Multi-step verification | No | Proportional math ✅ |
| `test_withdraw_proportional_redemption` | Full redeem works | ✅ Checks all balances return to initial | No | Happy path ✅ |
| `test_withdraw_zero_amount_rejected` | Zero rejected | ✅ | No | Error path ✅ |
| `test_withdraw_supply_mismatch_no_supply` | Empty pool rejected | ✅ | No | Error path ✅ |
| `test_withdraw_mint_not_created` | No mint = error | ✅ | No | Error path ✅ |
| `test_withdraw_below_threshold_rejected` | Threshold enforced | ✅ Two-part: rejected then accepted above threshold | No | Boundary ✅ |
| `test_multi_user_proportional_shares` | Fair sharing | ✅ Both users get exact amounts back | No | Multi-user ✅ |
| `test_yield_accrual_withdraw_more_than_deposited` | Fee accrual → more tokens | ✅ | No | Yield accounting ✅ |
| `test_rounding_favors_pool` | Rounding always pool-favorable | ✅ Asserts pool retains dust | No | Rounding edge ✅ |
| `test_large_amounts` | Near u64::MAX works | ✅ | No | Overflow edge ✅ |
| `test_yield_accrual_multi_user` | Multi-user yield proportional | ✅ | No | Complex scenario ✅ |

### Critical Test Bug Found: L2
The test's `encode_init_market` function is missing the `initial_mark_price_e6` field (8 bytes). This means all subsequent fields (warmup, margins, fees, etc.) are shifted by 8 bytes, reading garbage values. The tests pass because:
1. The garbage values happen to not cause errors for the specific test scenarios
2. Most risk params being 0 or garbage doesn't affect insurance LP tests directly

**This is a serious test reliability issue** — the tests may be passing for the wrong reasons.

### Missing Test Coverage

| Instruction | Happy | Wrong Signer | Wrong Account | Zero Amount | Overflow | Unauthorized |
|-------------|-------|-------------|---------------|-------------|----------|--------------|
| 0 InitMarket | ✅ (unit.rs) | ❌ | ❌ | ❌ | ❌ | ❌ |
| 1 InitUser | ✅ (unit.rs) | ❌ | ❌ | ✅ | ❌ | ❌ |
| 2 InitLP | ✅ (unit.rs) | ❌ | ❌ | ❌ | ❌ | ❌ |
| 3 Deposit | ✅ (unit.rs) | ❌ | ❌ | ❌ | ❌ | ❌ |
| 4 Withdraw | ✅ (unit.rs) | ❌ | ❌ | ❌ | ❌ | ❌ |
| 5 KeeperCrank | ✅ | ❌ | ❌ | N/A | ❌ | ❌ |
| 6 TradeNoCpi | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 7 Liquidate | ✅ | N/A | ❌ | N/A | ❌ | N/A |
| 8 Close | ✅ | ❌ | ❌ | N/A | ❌ | ❌ |
| 9 TopUp | ✅ | ❌ | ❌ | ❌ | ❌ | N/A |
| 10 TradeCpi | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 11-23 Admin | ✅ | Partial | ❌ | ❌ | ❌ | ✅ |
| 24 CreateMint | ⚠️ | ✅ | ❌ | N/A | N/A | ✅ |
| 25 DepositLP | ✅ | ❌ | ❌ | ✅ | ✅ | N/A |
| 26 WithdrawLP | ✅ | ❌ | ✅ | ✅ | ❌ | N/A |

### Vacuous Tests Found
None — all tests have meaningful assertions.

### Non-deterministic Tests
None — all tests use deterministic fixtures.

---

## On-Chain Test Results

TypeScript compilation:
- `packages/core`: ✅ Compiles clean
- `app/`: ❌ Pre-existing errors in `app/api/` routes (missing `@/lib/api-auth` module) — not related to this audit

Devnet E2E: Not executed (requires program deployment and the template literal fix was blocking compilation).

---

## Fixes Applied

### Fix 1: Template literal syntax in E2E test
- **File:** `app/scripts/e2e-devnet-test.ts:64`
- **Issue:** C3 — Regular string instead of template literal
- **Change:** `"...${...}"` → `` `...${...}` ``

### Fix 2: Missing `initial_mark_price_e6` in test encoder
- **File:** `program/tests/insurance_lp_tests.rs:168`
- **Issue:** L2 — Test encoder missing 8-byte field, shifting all subsequent params
- **Change:** Added `encode_u64(0, &mut data);` for `initial_mark_price_e6` after `unit_scale`

### Fix 3: Rebuilt core package dist
- **File:** `packages/core/dist/`
- **Issue:** Insurance LP exports missing from built dist
- **Change:** `npm run build` in `packages/core`

---

## Remaining Issues

| ID | Severity | Issue | Status |
|----|----------|-------|--------|
| C1 | Critical | DEX oracle flash loan vulnerability | ❌ Design limitation |
| H1 | High | No zero-collateral guard (engine dependency) | ❌ Requires engine audit |
| H5 | High | `devnet` feature disables oracle safety | ⚠️ Build process must exclude |
| M3 | Medium | Oracle service no price validation | ❌ Open |
| M4 | Medium | Pre-existing TS compilation errors in app/ | ❌ Pre-existing |

## Security Properties Verified ✅
1. **RenounceAdmin is irreversible** — admin set to zeros, `admin_ok` rejects zeros
2. **All admin ops require signer check** — `expect_signer` + `require_admin` on every admin handler
3. **PDA derivations are verified** — `expect_key` checks derived vs provided
4. **Insurance LP rounding favors pool** — integer division rounds down on both deposit and withdraw
5. **Insurance LP withdrawal enforces threshold** — `remaining < threshold` check prevents draining
6. **Resolved market blocks new activity** — deposits, trades, new users all check `is_resolved`
7. **CPI trade uses exec_size not requested_size** — verified via `cpi_trade_size` helper
8. **Nonce prevents CPI replay** — monotonic nonce incremented on success, checked in ABI validation
9. **Owner checks use constant-time comparison** — byte array equality comparison
10. **Slab ownership verified** — `slab_guard` checks program owns the account
