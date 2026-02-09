# Percolator Adversarial Audit — 2026-02-09

## Methodology
Full adversarial audit of the Percolator perpetuals protocol. Every file read line-by-line assuming the developer is adversarial. Focus on fund-draining attacks, privilege escalation, data corruption, and bypassing safety mechanisms.

Scope: On-chain program (4901 LOC Rust), core package (TypeScript ABI/PDA/math), frontend hooks, server services, tests, config/deployment.

---

## Critical Findings (must fix before mainnet)

### C1: Hardcoded Helius API Key Committed to Git
- **Location:** `tests/harness.ts:97`, `tests/devnet-e2e.ts:39`, `scripts/auto-crank-service.ts:43`, `scripts/e2e-devnet-test.ts:64`, `app/scripts/e2e-devnet-test.ts:64`, `packages/server/.env.example:2,11`
- **Impact:** API key `e568033d-06d6-49d1-ba90-b3564c91851b` is committed. Attacker gets free RPC access, can run up billing, or use for abuse attribution.
- **Proof:** `git show HEAD:tests/harness.ts | grep "api-key"`
- **Fix:** Remove hardcoded keys, use env vars everywhere. Rotate the exposed key immediately.
- **Status:** ✅ Fixed (hardcoded keys replaced with env vars; key rotation needed externally)

### C2: Supabase Service Role Key in `.env.local` (Not Committed but on Disk)
- **Location:** `.env.local` — `SUPABASE_SERVICE_ROLE_KEY`
- **Impact:** Service role key bypasses RLS. If workspace is compromised, full Supabase DB access. Not in git (good), but worth noting.
- **Proof:** File read shows full JWT.
- **Fix:** Ensure `.env.local` is never committed and is excluded from any deployment artifacts.
- **Status:** ⚠️ Informational (not in git)

### C3: DEX Oracle Flash Loan Manipulation — No TWAP Protection
- **Location:** `program/src/percolator.rs` — `read_pumpswap_price_e6`, `read_raydium_clmm_price_e6`, `read_meteora_dlmm_price_e6`
- **Impact:** All DEX oracle readers use instantaneous spot prices. Attacker with sufficient capital can flash-loan manipulate reserves in the same transaction to get an artificial price, then execute trades or trigger liquidations at that manipulated price. The circuit breaker (`clamp_oracle_price`) limits movement per update but does NOT prevent manipulation within a single crank cycle — the first ever price has no cap (last_effective_price_e6 == 0 → raw accepted).
- **Proof:** 
  1. Create market with PumpSwap oracle, first crank sets last_effective_price = spot price
  2. In a subsequent transaction: flash loan → inflate reserves → crank (price moves up to cap) → repeat across multiple cranks → achieve desired price → trade/liquidate
  3. Even with cap, attacker can ratchet price over multiple blocks
- **Fix:** Document clearly that DEX oracle markets are high-risk. Consider requiring authority oracle for any market above a TVL threshold. The cap provides some protection but is not a substitute for TWAP.
- **Status:** ❌ Open (design limitation, needs documentation + warnings)

### C4: Insurance LP Withdrawal Does Not Check Engine Vault Solvency
- **Location:** `program/src/percolator.rs:4770-4830` (WithdrawInsuranceLP handler)
- **Impact:** The withdrawal only checks `remaining >= risk_reduction_threshold`, but does NOT verify that the vault token account actually has enough tokens to pay out. If the insurance fund balance in the engine is higher than actual vault tokens (due to rounding or bugs), the SPL transfer would fail, which is safe (reverts). However, the `insurance_fund.balance` is decremented via `saturating_sub` which is lossy — if `units_to_return > insurance_balance` somehow, it would underflow to 0 silently.
- **Proof:** The `saturating_sub` at the end: `insurance_balance.saturating_sub(units_to_return)`. If `numerator / lp_supply` somehow exceeds `insurance_balance` (impossible with correct math, but worth hardening), fund balance goes to 0 with remaining LP tokens redeemable for nothing.
- **Fix:** Change `saturating_sub` to `checked_sub` with error. The math *should* prevent this, but defense in depth.
- **Status:** ✅ Fixed (changed to checked_sub with EngineOverflow error)

---

## High Findings

### H1: `premium_bps_u as i64` Cast Can Truncate
- **Location:** `program/src/percolator.rs:207-210` — `compute_inventory_funding_bps_per_slot`
- **Impact:** `premium_bps_u` is u128 clamped to `funding_max_premium_bps.unsigned_abs()` (i64 range). The `as i64` cast is safe after clamping. However, the signed conversion `-(premium_bps_u as i64)` would panic if premium_bps_u == i64::MAX + 1 and the value were exactly at that boundary. Since it's clamped to `funding_max_premium_bps.unsigned_abs()` which comes from an i64, the max value is `i64::MAX` (9.2e18), and `i64::MAX as i64` is fine. Negating `i64::MAX` is also fine (-i64::MAX is representable). 
- **Proof:** Boundary analysis shows this is actually safe for all valid inputs.
- **Fix:** No fix needed — verified safe.
- **Status:** ✅ Verified Safe

### H2: Oracle Service Fetches Price from DexScreener Using `collateralMint` Instead of Index Token
- **Location:** `packages/server/src/services/oracle.ts:108` — `const mint = marketConfig.collateralMint.toBase58()`
- **Impact:** For coin-margined markets where collateral IS the index token, this is correct. But if someone creates a USDC-margined market for SOL, the oracle would fetch the USDC price (always ~$1) instead of SOL price. Trades would execute at wrong prices.
- **Proof:** Comment in code acknowledges this: "Currently all percolator markets are coin-margined, so collateralMint is correct."
- **Fix:** Add an `indexMint` or `oracleTokenMint` field to market config. For now, document this limitation.
- **Status:** ❌ Open (design limitation)

### H3: `useCreateMarket.ts` Stores Slab Keypair Secret Key in `localStorage`
- **Location:** `app/hooks/useCreateMarket.ts:140`
- **Impact:** `JSON.stringify(Array.from(slabKp.secretKey))` — stores the full secret key of the slab keypair in browser localStorage. Any XSS attack or malicious extension can read it. The slab keypair controls the market account.
- **Proof:** Code line 140: `JSON.stringify(Array.from(slabKp.secretKey))`
- **Fix:** Don't store secret keys in localStorage. The slab keypair is only needed during market creation. If multi-step flow is needed, encrypt it or use a session-scoped variable.
- **Status:** ❌ Open

### H4: No Rate Limiting on Oracle Price Push
- **Location:** `program/src/percolator.rs` — PushOraclePrice handler (tag 17)
- **Impact:** Oracle authority can push prices as fast as they can submit transactions. Combined with the circuit breaker, they can ratchet prices by `oracle_price_cap_e2bps` per push. With cap set to 10000 e2bps (1%), they can move price ~1% per transaction. At Solana's speed (~400ms/slot), they can move price ~150% per minute.
- **Proof:** No timestamp or slot-based cooldown on PushOraclePrice. Each push is clamped against `last_effective_price_e6`, but there's no minimum interval between pushes.
- **Fix:** Add a minimum interval (e.g., 1 slot) between oracle price pushes on-chain.
- **Status:** ❌ Open

### H5: `devnet` Feature Disables All Oracle Safety Checks
- **Location:** `program/src/percolator.rs:1790-1804` (staleness check), `1810-1818` (confidence check)
- **Impact:** When compiled with `--features devnet`, staleness and confidence checks are completely skipped. If accidentally deployed to mainnet with this feature, stale/manipulated prices would be accepted.
- **Proof:** `#[cfg(feature = "devnet")]` blocks replace checks with `let _ = ...` (no-ops).
- **Fix:** Already documented with warning comment. Add a build-time assertion or CI check that mainnet builds never include `devnet` feature.
- **Status:** ⚠️ Documented (needs CI gate)

---

## Medium Findings

### M1: `computeMarkPnl` in TypeScript Uses Different Formula Than On-Chain
- **Location:** `packages/core/src/math/trading.ts:17-26`
- **Impact:** TypeScript computes PnL as `(oracle - entry) * absPos / oracle` for longs. The on-chain engine uses `position * (price - entry) / 1_000_000` (from the Rust RiskEngine). These are different formulas — the TS version divides by oracle (coin-margined), the Rust version divides by 1e6. This means the frontend will show different PnL than what the engine computes.
- **Proof:** Compare `computeMarkPnl` in trading.ts vs engine's `mark_pnl` calculation. The division denominators differ.
- **Fix:** Verify which formula the engine actually uses and make the TypeScript match exactly. If the engine uses linear PnL (`pos * (price - entry) / 1e6`), update the TS. If coin-margined (`/ oracle`), update the comment.
- **Status:** ❌ Open

### M2: `computeLiqPrice` Uses Floating Point (`Number()`)
- **Location:** `packages/core/src/math/trading.ts:35-50`
- **Impact:** Uses `Number()` conversions which lose precision for values > 2^53. For positions denominated in lamports, values near 9.2e18 (u64 max) would lose precision. The `Math.round` also introduces rounding errors. These are UI-only calculations, so no fund loss, but users might see incorrect liquidation prices.
- **Fix:** Rewrite in pure BigInt arithmetic.
- **Status:** ❌ Open

### M3: Crank Service Has No Mutex — Concurrent Cycles Possible
- **Location:** `packages/server/src/services/crank.ts:220-240` (start method)
- **Impact:** The `setInterval` callback calls `discover()` then `crankAll()`. If a cycle takes longer than `intervalMs`, a second cycle starts while the first is still running. Two concurrent cranks for the same market could submit duplicate transactions (wasting SOL on fees).
- **Proof:** No lock/flag preventing overlapping cycles. Only `isDue()` provides some protection, but `lastCrankTime` is updated AFTER the transaction succeeds, so two cycles could both pass `isDue()` for the same market.
- **Fix:** Add a `cycling` flag that prevents overlapping cycles.
- **Status:** ✅ Fixed (added `_cycling` guard flag)

### M4: Health Endpoint Exposes Internal Market Count and Crank Stats
- **Location:** `packages/server/src/routes/health.ts`
- **Impact:** Exposes `crankStatus` (all market addresses + their success/failure counts), which reveals operational details. Minor information disclosure.
- **Fix:** Gate detailed status behind an API key or admin auth.
- **Status:** ❌ Open

### M5: `CloseSlab` with `unsafe_close` Feature Skips All Validation
- **Location:** `program/src/percolator.rs:4087-4110`
- **Impact:** When compiled with `--features unsafe_close`, CloseSlab skips admin check, balance check, account check — anyone can drain the slab's SOL. This is clearly for emergencies (CU limits), but it's extremely dangerous.
- **Proof:** The `#[cfg(not(feature = "unsafe_close"))]` block contains ALL validation. With the feature enabled, the code jumps straight to lamport transfer.
- **Fix:** Remove this feature or add at minimum an admin check even in unsafe mode.
- **Status:** ❌ Open

### M6: `TopUpInsurance` Accepts Zero Amount Silently
- **Location:** `program/src/percolator.rs` — TopUpInsurance handler
- **Impact:** Unlike DepositInsuranceLP which rejects amount=0, TopUpInsurance with amount=0 just does nothing (collateral::deposit returns Ok for amount=0). No harm but inconsistent.
- **Fix:** Add `if amount == 0 { return Err(...); }` for consistency.
- **Status:** ❌ Open

---

## Low Findings

### L1: Vercel OIDC Token in `.env.local`
- **Location:** `.env.local` — `VERCEL_OIDC_TOKEN`
- **Impact:** Short-lived token (expires within hours). Not in git. Low risk.
- **Status:** ⚠️ Informational

### L2: Test Harness Uses Hardcoded Feed ID `[1u8; 32]`
- **Location:** Multiple test files
- **Impact:** Tests only cover one feed ID pattern. No collision testing.
- **Status:** ⚠️ Low

### L3: `useAdminActions` Has No Confirmation for `RenounceAdmin`
- **Location:** `app/hooks/useAdminActions.ts`
- **Impact:** Frontend hook exists for renouncing admin. The component using it should have a confirmation dialog, but the hook itself has no guard. UI-level concern.
- **Status:** ⚠️ Low (UI layer responsibility)

### L4: Dockerfile Runs as Root
- **Location:** `Dockerfile`
- **Impact:** Production container runs as root. If the Node.js process is compromised, attacker has root in the container.
- **Fix:** Add `USER node` before CMD.
- **Status:** ✅ Fixed

### L5: Server `.env.example` Contains Actual API Key
- **Location:** `packages/server/.env.example:2,11`
- **Impact:** Example files should have placeholder values, not real keys.
- **Fix:** Replace with `your-api-key-here`.
- **Status:** ✅ Fixed

---

## Test Coverage Analysis

### On-Chain Program (27 instruction tags: 0-26)

- **Total instruction handlers:** 27
- **Handlers with dedicated tests:** ~20 (InitMarket, InitUser, InitLP, Deposit, Withdraw, KeeperCrank, TradeNoCpi, TradeCpi, Liquidate, CloseAccount, TopUpInsurance, SetRiskThreshold, UpdateAdmin, CloseSlab, UpdateConfig, RenounceAdmin, CreateInsuranceMint, DepositInsuranceLP, WithdrawInsuranceLP, PushOraclePrice)
- **Handlers without dedicated tests:** ~7
  - SetMaintenanceFee (tag 15)
  - SetOracleAuthority (tag 16) — partially tested via e2e
  - SetOraclePriceCap (tag 18)
  - ResolveMarket (tag 19) — partially in integration
  - WithdrawInsurance (tag 20)
  - AdminForceClose (tag 21)
  - UpdateRiskParams (tag 22)

### Edge Cases
- **Tested:** Zero amounts (InsuranceLP), wrong signer, basic auth checks, unit scaling, dust accumulation, insurance threshold
- **Missing:**
  - u64::MAX amounts for deposit/withdraw
  - Overflow in LP token mint calculation (supply * amount exceeding u128)
  - Concurrent deposit+withdraw race (InsuranceLP)
  - DEX oracle with zero reserves
  - Chainlink with max decimals (18)
  - Hyperp mode: mark price manipulation via rapid TradeCpi
  - ResolveMarket + WithdrawInsurance full lifecycle
  - AdminForceClose correctness

### TypeScript Core Package
- Tests exist for: ABI encoding, PDA derivation, slab parsing, encode utilities, validation
- Missing: Math/trading.ts unit tests, instruction account count verification against Rust

---

## Proof Validity

### Vacuous Proofs Found
- None identified — Kani proofs in `program/tests/kani.rs` test real code paths via `verify` module functions. They are well-structured with proper `kani::any()` inputs and meaningful postconditions.

### Non-Deterministic Tests
- None identified — all tests use deterministic inputs. No randomized testing (fuzzing.rs exists in `percolator/tests/` but is separate from the program tests).

---

## Recommendations (Prioritized)

1. **IMMEDIATE:** Rotate the exposed Helius API key (C1)
2. **IMMEDIATE:** Replace `saturating_sub` with `checked_sub` in InsuranceLP withdrawal (C4)
3. **HIGH:** Add minimum interval for oracle price pushes (H4)
4. **HIGH:** Remove slab keypair from localStorage (H3)
5. **HIGH:** Verify TS PnL formula matches on-chain engine (M1)
6. **MEDIUM:** Add cycling mutex to crank service (M3)
7. **MEDIUM:** Add `USER node` to Dockerfile (L4)
8. **MEDIUM:** Clean up .env.example files (L5)
9. **MEDIUM:** Add CI gate preventing `devnet` or `unsafe_close` features in mainnet builds (H5, M5)
10. **LOW:** Rewrite `computeLiqPrice` in pure BigInt (M2)
11. **DESIGN:** Document DEX oracle risks prominently (C3)
12. **DESIGN:** Add `indexMint` field for non-coin-margined markets (H2)
