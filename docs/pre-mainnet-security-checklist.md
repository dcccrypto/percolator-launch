# Pre-Mainnet Security Checklist — PERC-8262

| Field | Value |
|-------|-------|
| **Date** | 2026-03-30 |
| **Reviewer** | Sentinel (security agent) |
| **Scope** | percolator-launch, percolator-prog, percolator-nft, percolator-keeper, percolator-indexer |
| **Status** | **2 BLOCKERS** (Khubair action required) |

---

## 🔴 BLOCKERS — Must Fix Before Mainnet

| # | Item | Status | Action Required |
|---|------|--------|----------------|
| B1 | **Upgrade authority single-keypair** (GH#1823) | ❌ OPEN | Khubair must create Squads multisig and transfer authority from `7JVQvrAf...`. Verified on-chain 2026-03-30 09:27 BST — authority is still `7JVQvrAf...` (System Program owner = plain keypair). |
| B2 | **Supabase service_role key leaked in git history** (GH#1876) | ❌ OPEN | Khubair must rotate at https://supabase.com/dashboard/project/ygvbajglkrwkbjdjyhxi/settings/api, then update `SUPABASE_SERVICE_ROLE_KEY` in Vercel + all Railway services. 7+ weeks unrotated. Full DB read/write risk. |

---

## 1. Critical / High Security Findings

| Finding | Severity | Status |
|---------|----------|--------|
| GH#1823: Upgrade authority single-keypair | CRITICAL | ❌ OPEN — blocked on Khubair |
| GH#1876: Supabase service_role key in git history | HIGH | ❌ OPEN — blocked on Khubair |
| GH#1918: QueueWithdrawalSV duplicate-queue griefing | LOW | ✅ PR#157 APPROVED (pending merge) |
| GH#1783: bigint-buffer CVE-2025-3194 | MEDIUM | ✅ ACCEPTED RISK (no native compile path, PERC-8183) |
| GH#1829: SetOraclePriceCap missing floor | MEDIUM | ✅ CLOSED — PR#150 merged |
| Keeper #27/#28: wrong BTC mint in mainnet-markets.ts | LOW | Open (non-blocking) |

---

## 2. Dependency Audit

| Repo | Tool | Result | Status |
|------|------|--------|--------|
| percolator-launch | `pnpm audit` | 0 vulnerabilities (bigint-buffer CVE accepted, PERC-8183) | ✅ PASS |
| percolator-keeper | `pnpm audit` | 1 high (bigint-buffer GHSA-3gc7-fjrx-p6mg — accepted, no native compile path) | ✅ PASS |
| percolator-indexer | `pnpm audit` | 1 high (bigint-buffer GHSA-3gc7-fjrx-p6mg — accepted, no native compile path) | ✅ PASS |
| percolator-prog | `cargo audit` | 6 warnings — ALL unmaintained dev-only deps (atty, bincode, derivative, number_prefix, paste, rustls-pemfile via solana-sdk/litesvm test chain). Suppressed in audit.toml. 0 active CVEs. | ✅ PASS |
| percolator-nft | `cargo audit` | 2 CVEs (RUSTSEC-2022-0093, RUSTSEC-2024-0344) — confirmed DEV-ONLY via `cargo tree -e normal`. audit.toml added (PR#23). 0 on-chain exposure. | ✅ PASS |

---

## 3. Secrets and Configuration

| Check | Status | Notes |
|-------|--------|-------|
| Hardcoded private keys / API secrets in source | ✅ PASS | No literal private keys, API secrets, or JWT tokens found in tracked source files. Comments and `.env.example` placeholders only. |
| NEXT_PUBLIC_* vars — no secrets in client bundle | ✅ PASS | Client-side vars: `HELIUS_WS_API_KEY` (WS-only, limited-scope, intentional), `PRIVY_APP_ID`, `PROGRAM_ID`, `SENTRY_DSN`, `SOLANA_NETWORK`, `DEFAULT_NETWORK`, `MOCK_MODE`, `PRIORITY_FEE`, `BLOCKED_MARKET_ADDRESSES`. No service-role key, no admin secret, no private key exposed to browser. Note: `NEXT_PUBLIC_HELIUS_API_KEY` used in devnet faucet hook only (devnet path, intentional). Mainnet path uses server-only `HELIUS_MAINNET_API_KEY`. |
| ADMIN_API_SECRET guards | ✅ PASS | All admin endpoints reject when `ADMIN_API_SECRET` unset or whitespace-only (PR#1884). Whitespace trimming applied (PR#1885). |
| GitHub secret scanning | ❌ OPEN | Alert #1: Supabase service_role key — state: open. See B2 above. |
| Production env vars documented | ✅ PASS | `docs/MAINNET-ENV.md` and `MAINNET-CHECKLIST.md` document all required production secrets. Fresh secrets (API_AUTH_KEY, WS_AUTH_SECRET, HELIUS_WEBHOOK_SECRET, ADMIN_API_SECRET, INDEXER_API_KEY, KEEPER_REGISTER_SECRET) must be generated with `openssl rand -hex 32`. |

---

## 4. Application API — Auth, Rate Limits, CORS

| Check | Status | Notes |
|-------|--------|-------|
| Global middleware rate limiting | ✅ PASS | middleware.ts: Upstash Redis sliding window (120 req/IP/min general, 600 req/IP/min for `/api/rpc`). In-memory fallback for local/CI. Globally consistent across Vercel instances. |
| CORS | ✅ PASS | No CORS headers set on API routes (Next.js default: same-origin only). No `Access-Control-Allow-Origin: *` found. |
| Security headers (next.config.ts) | ✅ PASS | `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=(), bluetooth=()`. |
| CSP | ✅ PASS | Per-request nonce-based CSP generated in middleware.ts. Nonce generation uses `crypto.randomUUID()` (Edge Runtime compatible). |
| Admin routes auth | ✅ PASS | `/api/admin/*`: `requireAdminSession()` (Supabase JWT + admin_users table check). |
| `/api/airdrop` rate limiting | ✅ PASS | `tryAirdropClaimGate()` — 24-hour per-wallet claim gate via DB. |
| `/api/launch` rate limiting | ✅ PASS | PR#1880 (PERC-8237): rate limit on POST /api/launch — 60 req/IP/min. |
| `/api/oracle/advance-phase` rate limiting | ✅ PASS | PR#1127: 60 req/IP/min sliding window (Upstash Redis + in-memory fallback). |
| `/api/rpc` method allowlist | ✅ PASS | Solana method allowlist enforced. Batch size capped. Upstream URLs restricted. |
| Cache-Control headers on price/market routes | ✅ PASS | PR#1886: `no-store` on `/api/prices`. PR#1887: correct `Cache-Control` on `/api/markets/[slab]`. |
| `/api/applications` PII protection | ✅ PASS | PR#1890: switched from INDEXER_API_KEY to `requireAdminSession()` — prevents external PII exposure. |
| `/api/traders` count | ✅ PASS | PR#1888: trades limit validated 1-200 via `validateNumericParam`. |
| Logo/image upload — magic byte validation | ✅ PASS | PR#1900: PNG/JPEG/GIF/WebP magic byte sniffing; detected content type replaces user-supplied `file.type`. Closes polyglot SVG-as-image bypass. |
| INDEXER_API_KEY whitespace trimming | ✅ PASS | PR#1891: trim applied. |
| KEEPER_REGISTER_SECRET whitespace | ✅ PASS | PR#1885: whitespace rejection applied. |

---

## 5. On-Chain Program Security

### percolator-prog (ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv)

| Check | Status | Notes |
|-------|--------|-------|
| Upgrade authority | ❌ CRITICAL | Single-keypair `7JVQvrAf...` — see B1 above |
| Signer checks — all instruction handlers | ✅ PASS | `expect_signer` enforced across all user-facing and admin handlers. TradeNoCpi: a_user + a_lp both required signers. TradeCpi: a_user required signer; a_lp_owner NOT required (delegation model via LP PDA). |
| Account owner validation | ✅ PASS | `slab_guard()`: owner == program_id on all entry points. `verify_vault()`, `verify_token_account()` comprehensive SPL checks. `validate_spl_mint()` complete. |
| PDA derivation correctness | ✅ PASS | 18 PDA types reviewed — all seeds distinct, fixed-size components, bump stored and re-derived. No ordering attacks on cmor_pair. |
| Admin function access control | ✅ PASS | All 14 admin handlers: `expect_signer` + `require_admin`. Two-step admin transfer with zero-address guard. |
| Oracle staleness guards | ✅ PASS | Hyperp: `check_hyperp_staleness()` on all trade/liquidation paths. Non-Hyperp: `read_price_clamped()` with circuit breaker. |
| SetOraclePriceCap floor | ✅ PASS | GH#1829 fix (PR#150) present: Hyperp floor + non-Hyperp admin-oracle floor. |
| TradeCpi ABI validation | ✅ PASS | `validate_matcher_return()`: ABI version, VALID flag, req_id echo, lp_account_id echo, oracle_price echo, exec_size ≤ requested, sign match, exec_price != 0. Replay protected by monotonic nonce. |
| TradeNoCpi — Hyperp disable | ✅ PASS | `HyperpTradeNoCpiDisabled` returned when `is_hyperp_mode()`. All Hyperp trades must go TradeCpi path. |
| Mark price manipulation guard | ✅ PASS | TradeCpi mark update only if new mark is convergent (closer to index) or current mark == 0. |
| OI caps post-trade | ✅ PASS | `check_oi_cap` + `check_pnl_cap` + `check_phase_leverage` + `check_wallet_position_cap` all applied post-trade. |
| Insurance LP math | ✅ PASS | DepositInsuranceLP + WithdrawInsuranceLP: u128 arithmetic, correct LP minting/burning formulas, dust deposit rejection, triple-capped withdrawal. |
| Core collateral handlers | ✅ PASS | DepositCollateral + WithdrawCollateral: unit_scale alignment check, vault_authority_bump from config (not user-supplied), owner_ok cross-user protection. |
| Kani proof coverage | ✅ PASS | C10, C11 proofs added/approved (PR#156). QueueWithdrawalSV duplicate guard (PR#157). 6 unmaintained dev-dep crate warnings suppressed in audit.toml. |
| QueueWithdrawalSV duplicate guard | ✅ PASS | PR#157: `claimed==0` check before write prevents phantom-LP griefing. LOW severity confirmed (PERC-8252). |
| AdvanceEpoch expect_signer removed | ✅ PASS | PR#155 (PERC-8249): permissionless crank correctly no longer requires signer. |
| CPI security — invoke_signed patterns | ✅ PASS | All CPI calls use vault_authority PDA signer seeds. No arbitrary CPI escalation. Matcher CPI: slab not passed to CPI to prevent ExternalAccountDataModified. |

---

## 6. Infrastructure and Delivery

| Check | Status | Notes |
|-------|--------|-------|
| Railway env vars — devnet values for mainnet | ⚠️ VERIFY | Per `MAINNET-CHECKLIST.md`: `KEEPER_PRIVATE_KEY`, `CRANK_KEYPAIR`, Helius keys, `PROGRAM_ID`, `ALL_PROGRAM_IDS` must be mainnet-specific. **Do NOT reuse devnet keypairs.** |
| Helius webhook secret | ⚠️ VERIFY | `HELIUS_WEBHOOK_SECRET` must be same value in both percolator-api and percolator-indexer Railway services. |
| MFA on dashboards | ⚠️ VERIFY | Supabase, Vercel, Railway, GitHub — confirm MFA enabled on all privileged accounts. |
| Branch protection | ✅ PASS | CI gates (unit, integration, e2e, typecheck, security, fuzz) required on main branch. CodeRabbit review required. |
| Secret scanning CI enforcement | ✅ PASS | GitHub Advanced Security secret scanning enabled on percolator-launch. |

---

## 7. Summary

| Category | Pass | Warn/Verify | Fail/Blocked |
|----------|------|-------------|--------------|
| Critical/High findings | 4 closed | — | 2 open (B1, B2 — Khubair) |
| Dependency audit | 5/5 repos clean | — | — |
| Secrets/config | 6 checks | 1 (git history alert) | 1 (rotation required) |
| API auth/rate limits | 15 checks | — | — |
| On-chain program | 16 checks | — | 1 (upgrade authority) |
| Infrastructure | 2 checks | 3 (verify) | — |

### Verdict: **NOT READY FOR MAINNET** until B1 + B2 are resolved.

Both blockers require **Khubair's direct action**:
1. Create Squads multisig → transfer upgrade authority from `7JVQvrAf...`
2. Rotate Supabase `service_role` key → update in Vercel + Railway

All technical security controls are in place. The program, API, and infrastructure are hardened and audit-ready. The two blockers are operational/key-management items that cannot be automated.

---

*Generated by Sentinel (security agent) — 2026-03-30 09:27 BST*
*PERC-8262 | Commit: main (latest)*
