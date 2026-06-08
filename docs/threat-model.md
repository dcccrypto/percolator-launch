# Percolator Threat Model — 2026-03-31

**Maintained by:** Security agent (Sentinel)  
**Last updated:** 2026-03-31 00:05 UTC  
**Status:** MAINNET LIVE — Audit Readiness Phase

---

## Executive Summary

Percolator is a permissionless perpetual futures protocol on Solana (devnet live; mainnet live).  
This threat model documents all identified security concerns, their severity, and their current status.

**Pre-mainnet blockers (Khubair action required):**
- 🔴 **CRITICAL: GH#1823 / GH#2014** — Upgrade authority is single keypair. Transfer to Squads multisig. Monitor: `npx tsx scripts/check-upgrade-authority.ts`.
- 🔴 **CRITICAL: GH#1876** — Supabase service_role key leaked in git history (7+ weeks). Rotate immediately.

**Remaining open issues:** LOW/INFO only. All CRITICAL/HIGH technical findings have been fixed.

---

## Audit Coverage Summary (2026-03-29 to 2026-03-31)

### Anchor Program Instruction Handlers Reviewed

| Handler | Reviewed | Findings |
|---------|----------|----------|
| DepositCollateral | ✅ | NONE |
| WithdrawCollateral | ✅ | NONE |
| TradeNoCpi | ✅ | NONE |
| TradeCpi | ✅ | NONE |
| LiquidateAtOracle | ✅ | NONE |
| LiquidateWithMarkPrice | ✅ | NONE |
| KeeperCrank (dispatch+engine) | ✅ | LOW (wrapping_neg — FIXED PR#170) |
| TopUpKeeperFund | ✅ | NONE |
| InitMarket | ✅ (partial) | NONE |
| DepositInsuranceLP / WithdrawInsuranceLP | ✅ | NONE |
| LpVaultDeposit / LpVaultWithdraw | ✅ | LOW (creator lock bypass — FIXED PR#170) |
| LpVaultCrankFees | ✅ | NONE |
| AllocateMarket | ✅ | NONE |
| AdvanceEpoch | ✅ | INFO (expect_signer removed — PR#155) |
| QueueWithdrawalSV | ✅ | LOW (duplicate-queue — FIXED PR#157) |
| ClaimEpochWithdrawal | ✅ | NONE |
| ChallengeSettlement | ✅ | NONE |
| ResolveDispute | ✅ | LOW (challenger_ata — FIXED PR#170) |
| SetInsuranceWithdrawPolicy | ✅ | INFO (cooldown=0 allowed, by design) |
| WithdrawInsuranceLimited | ✅ | NONE |
| CloseStaleSlabs | ✅ | NONE |
| ReclaimSlabRent | ✅ | NONE |
| ResolveMarket | ✅ | NONE |
| AdminForceClose | ✅ | LOW (wrapping_neg GH#1937 — FIXED PR#170) |
| UpdateConfig | ✅ | HIGH (oracle_phase alias — FIXED PR#165, GH#1939 CLOSED) |
| SetOraclePriceCap | ✅ | LOW (negative bps — GH#1946, MEDIUM, anchor backlog) |
| MintPositionNft | ✅ | NONE |
| BurnPositionNft | ✅ | NONE |
| SettleFunding | ✅ | NONE |
| GetPositionValue | ✅ | NONE |
| TransferHook Execute | ✅ | NONE |
| TransferOwnershipCpi | ✅ | NONE |
| ExecuteAdl | ✅ | NONE (T14 complete) |
| execute_adl engine | ✅ | INFO (target ordering by-design; documented) |
| enforce_one_side_margin | ✅ | 5 issues found — ALL FIXED PR#69 |

### Engine / Library Modules Reviewed

| Module | Reviewed | Findings |
|--------|----------|----------|
| wide_math (ADL T1) | ✅ | INFO (abs_u256 panics on MIN — by design) |
| I256 PnL migration (ADL T2) | ✅ | NONE |
| SideMode / InstructionContext (ADL T3/T4) | ✅ | INFO (SideMode discriminant not validated post raw-ptr — non-blocking) |
| Two-phase keeper (ADL T5) | ✅ | NONE |
| accrue_funding / dt edge cases | ✅ | INFO (funding_p5 Kani proof covers dt<1000 only) |
| accrue_market_to (ADL coefficients) | ✅ | LOW (silent failure not in CrankOutcome — GH#1931, PERC-8296) |
| set_pnl / pnl_pos_tot conservation | ✅ | NONE (Kani proven) |
| compute_adaptive_funding_rate | ✅ | LOW (no bounds on adaptive_max_funding_bps in UpdateRiskParams) |
| F5 funding dampening | ✅ | NONE |
| compute_premium_funding_rate | ✅ | NONE |
| liquidate_at_oracle (engine) | ✅ | NONE |
| liquidate_with_mark_price (partial liq) | ✅ | NONE |
| account_equity_mtm_at_oracle | ✅ | NONE |
| VRAM parameter bounds | ✅ | INFO (type constraints + downstream caps make all paths safe) |

### Oracle Manipulation Surface

| Oracle Mode | ADL Context | Finding |
|-------------|-------------|---------|
| Pyth-pinned (mainnet BTC/SOL/ETH) | ✅ | NONE — account substitution blocked at program ID level |
| Admin-oracle markets | ✅ | TRUST ASSUMPTION — admin key compromise = oracle compromise |
| DEX oracle markets | ✅ | INFO — 5% flash-loan manipulation theoretically possible; mainnet uses Pyth |
| Hyperp markets | ✅ | NONE — last_effective_price EMA, no live account in ExecuteAdl |

### Dependency Audits

| Repo | Last Audit | Status |
|------|-----------|--------|
| percolator-prog (cargo) | 2026-03-31 00:00 UTC | ✅ 0 CVEs (6 unmaintained dev-only, suppressed) |
| percolator-nft (cargo) | 2026-03-30 12:00 UTC | ✅ 0 CVEs (suppressed via .cargo/audit.toml) |
| percolator-launch (pnpm) | 2026-03-31 00:00 UTC | ✅ 0 new CVEs (bigint-buffer ACCEPTED, no native compile path) |
| percolator-keeper (pnpm) | 2026-03-31 00:00 UTC | ✅ 0 new CVEs (bigint-buffer ACCEPTED) |
| percolator-indexer (pnpm) | 2026-03-31 00:00 UTC | ✅ 0 new CVEs (bigint-buffer ACCEPTED) |

---

## Kani Formal Proofs (ADL T8-KANI)

All 12 Kani proofs reviewed and approved (PR#174 + PR#70):

| Proof ID | What it proves | Status |
|----------|---------------|--------|
| T8-K1 | Partial deleverage ≤ 1.0 (close_abs ≤ abs_pos) | ✅ SOUND |
| T8-K2 | Minimum 1 unit always closed | ✅ SOUND |
| T8-K3 | Insurance gate rejects non-zero balance | ✅ SOUND |
| T8-K3b | Insurance gate accepts zero balance | ✅ SOUND |
| T8-K4 | Target gate rejects pnl ≤ 0 | ✅ SOUND |
| T8-K4b | Target gate accepts pnl > 0 | ✅ SOUND |
| T8-K5 | Zero-excess closes exactly 1 unit | ✅ SOUND |
| T8-K6 | Boundary (excess == target_pnl) equals full close | ✅ SOUND |
| T8-E1 | pnl_pos_tot unchanged after execute_adl (engine) | ✅ SOUND |
| T8-E2 | close_abs ≤ abs_pos (engine) | ✅ SOUND |
| T8-E3 | close_abs ≥ 1 (engine) | ✅ SOUND |
| T8-E4 | Conservation: vault ≥ c_tot + insurance after ADL | ✅ SOUND |

**GH#1925 (Kani gap):** CLOSED — all proofs delivered via PR#174 + PR#70.

---

## Open Security Issues (Pre-Mainnet)

### 🔴 CRITICAL — Khubair Action Required

| # | Issue | Status | Action |
|---|-------|--------|--------|
| 1 | **GH#1823 / GH#2014: Upgrade authority single keypair** | OPEN | Khubair must create Squads multisig and transfer program authority. On-chain verified 2026-03-31: Authority 7JVQvrAf is System Program owner = plain keypair. Transfer has NOT happened. Runbook: `docs/GH-2014-upgrade-authority-governance.md`. |
| 2 | **GH#1876: Supabase service_role key in git history** | OPEN | Khubair must rotate at Supabase dashboard. Key leaked 7+ weeks (since ~Feb 8). No upstream fix until rotation. |

### 🟡 LOW / INFORMATIONAL

| # | Issue | Severity | Component | Status |
|---|-------|----------|-----------|--------|
| 3 | GH#1946: SetOraclePriceCap negative bps | MEDIUM | percolator-prog | Anchor backlog (PERC backlog). Input validation gap on admin endpoint. No exploit without admin key compromise. |
| 4 | GH#1931: accrue_market_to silent failure not in CrankOutcome | LOW | percolator engine | PERC-8296 in progress. No fund risk. ADL coefficients stale for that crank if overflow, not updated. |
| 5 | GH#1915: InitSharedVault first-caller-wins | INFO | percolator-prog | Doc note in PR#158 (merged). Deployment procedure must create SharedVault before any attacker. |
| 6 | GH#1913: AdvanceEpoch doc inconsistency | INFO | percolator-prog | PERC-8314 anchor backlog. |
| 7 | VRAM parameter no upper bounds in UpdateRiskParams | LOW/INFO | percolator engine | Type constraints + downstream caps make all paths arithmetically safe. Admin trust boundary. Recommend defensive bounds. |
| 8 | Adaptive funding: no bounds on adaptive_max_funding_bps | LOW/INFO | percolator engine | i64 cast in compute caps value. No overflow. Admin trust boundary. Recommend cap ≤ 10_000 bps. |
| 9 | funding_p5 Kani proof covers dt < 1000 only | INFO | Kani proofs | 31_536_000 boundary guard is trivially correct but not formally proven. |
| 10 | execute_adl does not enforce target ordering | INFO/BY DESIGN | percolator engine | Caller can target any profitable position, not just rank #1. Off-chain keeper provides ordering. No fund risk. |
| 11 | freeze_funding / unfreeze_funding not exposed as instructions | INFO | percolator engine | No emergency rate stabilization capability. By design or gap — recommend documenting for auditors. |
| 12 | AuditCrank (tag 53) permissionless pause | LOW | percolator-prog | 150-slot cooldown mitigates DoS. Accepted risk. |
| 13 | Keeper #27/#28: wrong BTC mint in mainnet-markets.ts | LOW | percolator-keeper | Open. Market config issue. |

### ✅ CLOSED (Fixed This Session Cycle)

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| GH#1939 | UpdateConfig oracle_phase aliased with k2_bps low byte | HIGH | PR#165 merged |
| GH#1942 | sendTx skipPreflight:true fallback | HIGH | PR#1949 merged |
| GH#1945 | /api/rpc network= routing | MEDIUM | PR#1952 + PR#1954 merged |
| GH#1950 | mobile/create-market blocklist→allowlist | MEDIUM | PR#1956 merged |
| GH#1951 | Admin UI authority pre-flight | LOW | PR#1955 merged |
| GH#1927 | ResolveDispute challenger_ata owner check | LOW | PR#170 merged |
| GH#1926 | LpVaultWithdraw creator lock bypass | LOW | PR#170 merged |
| GH#1937 | KeeperCrank wrapping_neg on i128::MIN | LOW | PR#170 merged |
| GH#1925 | execute_adl Kani gap | MEDIUM | PR#174 + PR#70 merged |
| GH#1943 | Funding rate 10,000x display underreport | HIGH (display) | PR#1949 merged |

---

## ADL T14 Security Audit — COMPLETE ✅

**Scope:** ADL implementation T1–T8 + Kani proofs  
**Completed:** 2026-03-31 00:00 UTC  
**Result:** ALL CLEAN — no critical or high findings  

Coverage:
- **T1** (wide_math): ✅ — overflow safety, abs edge cases, I256 signed arithmetic
- **T2** (I256 PnL): ✅ — type migration correct, pnl_matured_pos_tot aggregate maintained
- **T3** (SideMode/InstructionContext): ✅ — enum repr safe, deferred reset triple-guarded
- **T4** (InstructionContext wiring): ✅ — TOCTOU-safe, fresh context per instruction
- **T5** (two-phase keeper): ✅ — epoch validation, stale count checked, insurance floor
- **T6–T8** (core ADL engine): ✅ — execute_adl arithmetic sound, conservation proven by Kani
- **Kani proofs**: ✅ — 12 proofs all sound (PR#174 + PR#70)
- **Oracle manipulation**: ✅ — ADL price cannot be manipulated for Pyth/Hyperp markets
- **Rank manipulation**: INFO — by-design permissive (any profitable target allowed); off-chain ordering

**T15 (QA regression):** UNBLOCKED as of 2026-03-31.

---

## VRAM Audit Results (Idle Audit 2026-03-31 00:00 UTC)

Reviewed all 4 VRAM parameters passed through UpdateRiskParams:

| Parameter | Type | Bounds Check | Downstream Safety |
|-----------|------|-------------|-------------------|
| vol_margin_scale_bps | u16 (max 65535) | None | apply_vram_scaling caps final margin at 10,000 bps ✅ |
| vol_alpha_e6 | u16 (max 65535) | None | EWMA alpha ≤ 65535/1,000,000 < 1.0 — never > 1.0 ✅ |
| vol_margin_target_e6 | u16 | None | Zero-denominator guarded in compute_vram_margin_bps ✅ |
| adaptive_max_funding_bps | u64 | None | Clamped to i64 range in compute_adaptive_funding_rate ✅ |

**Verdict:** All VRAM parameters are safe via type constraints and downstream caps. No GH issues required. Informational note: consider adding defensive bounds (e.g. scale_bps ≤ 10,000, adaptive_max_funding_bps ≤ 10,000) in UpdateRiskParams handler as defense-in-depth against admin key compromise.

---

## Audit Signer/Auth Verification

All admin-gated instructions verified to use `expect_signer + require_admin`:
- SetRiskThreshold, UpdateAdmin, AcceptAdmin, SetOracleAuthority, SetOraclePriceCap, CloseSlab, UpdateConfig, SetMaintenanceFee, ResolveMarket, WithdrawInsurance, AdminForceClose, SetPendingSettlement, SetInsuranceWithdrawPolicy, SetWalletCap, AllocateMarket ✅

**ExecuteAdl verified admin-only:** `expect_signer(a_keeper) + require_admin(header.admin, a_keeper.key)` — NOT permissionless despite initial SDK JSDoc error (corrected in PR#49).

---

## Secret Scanning

| Repo | GH Secret Alert Status |
|------|----------------------|
| percolator-launch | Alert #1 (Supabase service_role key) — OPEN 7+ weeks |
| percolator-sdk | Clean |
| percolator-prog | Clean |
| percolator-keeper | Clean |
| percolator-indexer | Clean |
| percolator-api | Clean |

---

## Infrastructure

| Item | Status |
|------|--------|
| Helius API key rotation | ✅ DONE |
| HYPERP oracle disabled | ✅ DONE |
| Admin-only tests | ✅ DONE |
| Keeper DoS fix | ✅ DONE |
| Upgrade authority | 🔴 OPEN — single keypair, Squads transfer pending |
| Supabase key rotation | 🔴 OPEN — Khubair must rotate |
| Pre-mainnet checklist | ✅ DONE — docs/pre-mainnet-security-checklist.md (PR#1922) |

---

## Next Audit Rotation (CONTEXT.md reference)

Last idle audit completed: VRAM parameter bounds (2026-03-31 00:00 UTC)

Next rotation candidates:
1. SetOraclePriceCap negative bps (GH#1946 MEDIUM) — verify bounds in handler
2. compute_adaptive_funding_rate Kani gap — no proof covers this path
3. enqueue_adl (once T9+ code stabilizes for review)
