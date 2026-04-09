# Codebase Audit: dcccrypto/percolator-launch

**Date:** 2026-04-09
**Repo:** https://github.com/dcccrypto/percolator-launch
**Stack:** Next.js 16 + Solana (perpetual futures trading platform)
**Auditor:** Claude Code (automated static analysis)

---

## Overall Assessment

The codebase is **above-average quality for a DeFi project**. Strong security foundations including CSP nonces, timing-safe comparisons, ed25519 challenge-response auth, and comprehensive input validation. The primary risks are in economic attack vectors (oracle manipulation, low liquidity thresholds) and a maintenance-heavy architecture pattern that has already caused a documented chain of bugs.

---

## Critical / High Severity

### 1. DEX Oracle Flash-Loan Vulnerability
**Severity:** HIGH
**File:** `packages/core/src/solana/dex-oracle.ts:62-68`

The code reads instantaneous AMM spot prices (PumpSwap, Raydium CLMM, Meteora DLMM) which are vulnerable to flash-loan manipulation within a single transaction. The on-chain EMA provides some smoothing, but the default circuit breaker (`capE2bps`) is **0 (disabled)**. The code documents this risk but lacks sufficient mitigation.

**Recommendation:** Enable circuit breaker by default. Require minimum EMA window. Consider TWAP-based pricing.

---

### 2. Stats/Markets Route Duplication
**Severity:** HIGH (Maintenance/Bug Risk)
**Files:** `app/app/api/stats/route.ts` vs `app/app/api/markets/route.ts`

Both routes independently implement identical market sanitization logic: phantom OI detection, zombie filtering, price capping, USD conversion, `numericOrNull()` helpers. Comments in the codebase reference a **chain of bugs caused by this drift**: GH#1432, #1435, #1438, #1465, #1518, #1535, #1538, #1563, #2067, #2070, #2072, #2083.

**Recommendation:** Extract a shared `sanitizeMarketData()` pipeline that both routes consume.

---

## Medium Severity

### 3. RPC Proxy Origin Check Bypass
**File:** `app/app/api/rpc/route.ts:324-346`

`isAllowedOrigin()` returns `true` when both `Origin` and `Referer` headers are absent (intended for server-side calls). Any external client can strip both headers, bypassing the origin guard and consuming Helius API quota. Rate limiting (120 req/min) provides partial protection.

**Recommendation:** Require an internal auth token for server-to-server calls. Reject requests missing both Origin/Referer *and* the internal token.

---

### 4. Rate Limit Fail-Open on DB Errors
**Files:** `app/app/api/devnet-airdrop/route.ts:147-168`, `app/app/api/airdrop/route.ts:127-138`

When the Supabase INSERT-as-gate encounters an unexpected DB error (not a 23505 unique violation), the code fails open: `return { allowed: true }`. A transient DB outage could allow unlimited token minting.

**Recommendation:** Fail closed (deny the request) on unexpected DB errors for any endpoint that dispenses value.

---

### 5. In-Memory Rate Limiter Fallback
**File:** `app/middleware.ts:57-94`

When Upstash Redis is unavailable, the rate limiter falls back to an in-memory `Map`. On Vercel serverless, each cold start gets a fresh map, and requests distribute across isolates -- making the rate limiter effectively non-functional.

**Recommendation:** Alert when falling back to in-memory rate limiting in production. Consider failing closed instead.

---

### 6. Minimum Pool Liquidity Too Low ($100)
**File:** `app/app/api/launch/route.ts:197`

Markets can be created on DEX pools with as little as $101 in liquidity. Combined with the flash-loan oracle vulnerability (#1), an attacker could create a thin pool, launch a percolator market, then manipulate the pool to profit via the perp.

**Recommendation:** Increase minimum liquidity threshold significantly (e.g., $10,000+).

---

### 7. No On-Chain Verification Pool Matches Token
**File:** `app/app/api/launch/route.ts:176-217`

The DexScreener API response's `pairAddress` is used as the oracle pool without on-chain verification that the pool's base token matches the requested mint. A crafted DexScreener entry could direct the oracle to an unrelated pool.

**Recommendation:** Verify on-chain that the pool contains the expected token before market creation.

---

### 8. Oracle Resolve 5-Minute Cache
**File:** `app/app/api/oracle/resolve/[ca]/route.ts:88`

The oracle resolve endpoint caches results for 5 minutes. During volatile markets, this can produce stale initial prices for newly created markets. No cache-busting mechanism exists.

**Recommendation:** Reduce cache TTL or bypass cache during market creation flow.

---

### 9. Pre-Trade Liquidation Price Optimistic
**File:** `packages/core/src/math/trading.ts:62-88`

`computePreTradeLiqPrice` adjusts entry price for fees but does not deduct the fee from margin before computing liquidation price. The UI shows a healthier position than reality.

**Recommendation:** Deduct fee from margin before computing liquidation price, or document the approximation clearly in the UI.

---

### 10. StakePool Decode Lacks Discriminator
**File:** `packages/core/src/solana/stake.ts:363-444`

`decodeStakePool` only checks `data.length` and `isInitialized = bytes[0] === 1`. Any 352-byte account where byte[0] equals 1 would pass. Mitigated at the API level by `getProgramAccounts` filtering, but the exported function could be misused.

**Recommendation:** Add a magic/discriminator check to the decode function.

---

### 11. Pool Value Underflow
**File:** `app/app/api/stake/pools/route.ts:315-319`

`totalDeposited - totalWithdrawn - totalFlushed + totalReturned` can produce a negative bigint if withdrawals exceed deposits (accounting inconsistency). This would display negative TVL to users.

**Recommendation:** Clamp to 0 or flag as an error condition.

---

### 12. Docker Copies All node_modules to Production
**Files:** `Dockerfile.api:44`, `Dockerfile.indexer:44`

`COPY --from=builder /app/node_modules ./node_modules` includes devDependencies in production images.

**Recommendation:** Use `pnpm install --frozen-lockfile --prod` or `pnpm deploy` for pruned production deps.

---

### 13. Widespread `any` Types in Production Code
**Files:** `app/lib/faucet-rate-gate.ts:33,110`, `app/app/api/devnet-airdrop/route.ts:205`, `app/hooks/useWalletCompat.ts`, others

`supabase: any` parameter in faucet-rate-gate is the most concerning -- accepts any object and calls `.from()` without validation. `Record<string, unknown>` casts bypass generated DB types throughout stats/markets routes.

**Recommendation:** Use generated Supabase types. Replace `any` with `unknown` and narrow with type guards.

---

### 14. Markets Page is 1,077-Line Client Component
**File:** `app/app/markets/page.tsx`

Single `"use client"` component with inline data fetching, sorting, filtering, and search logic. Large client-side bundle.

**Recommendation:** Split into smaller components. Move data fetching to server components or use SWR with ISR.

---

## Low Severity

| # | Finding | File |
|---|---------|------|
| 15 | Fee split bps not validated to sum to 10000 (BigInt underflow risk) | `math/trading.ts:170-181` |
| 16 | Max leverage truncates to integer (33.33x becomes 33x) | `math/trading.ts:257-262` |
| 17 | IP address stored persistently in ideas table (PII) | `app/api/ideas/route.ts:79` |
| 18 | `cv_data` field not validated as base64 before storage | `app/api/applications/route.ts:69` |
| 19 | React 18 runtime with `@types/react: ^19` type definitions | `app/package.json` |
| 20 | Both `package-lock.json` and `pnpm-lock.yaml` exist at root | Root |
| 21 | 6 Google Fonts loaded in layout (performance impact) | `app/app/layout.tsx` |
| 22 | Coverage gate disabled in CI (`"temporarily disabled"`) | `.github/workflows/test.yml:250-256` |
| 23 | docker-compose.yml references non-existent Dockerfile paths | Root |
| 24 | Nonce IP binding may break on mobile networks | `app/api/markets/route.ts:824` |
| 25 | StakePool tranche fields read at unaligned offsets | `solana/stake.ts:409-412` |

---

## Positive Findings

The project demonstrates strong security practices in many areas:

- **Timing-safe comparisons** (`timingSafeEqual`) on all secret checks
- **Sealed signer pattern** for devnet mint authority -- no private key exposure
- **ed25519 nonce challenge-response** for market registration prevents impersonation
- **INSERT-as-gate pattern** eliminates TOCTOU race conditions in rate limiting
- **Comprehensive CSP** with per-request nonce, HSTS, X-Frame-Options, Permissions-Policy
- **Method allowlisting** on RPC proxy (only specific Solana methods permitted)
- **All Solana pubkey inputs validated** via `new PublicKey()` constructor
- **No hardcoded secrets** in source code -- all from environment variables
- **No `eval()`, `exec()`, or command injection vectors** found
- **Admin routes double-gated** -- middleware check + Supabase session + admin_users table
- **166 unit tests + 9 E2E specs + fuzz tests** with CI merge gates
- **Pinned Docker base image SHAs** (supply chain security)
- **CI uses pinned action SHAs** (not floating tags)
- **Integer math via BigInt throughout** -- avoids JavaScript float precision bugs
- **Range validation on all ABI encoders** with length assertion on total instruction size
- **Network guards** prevent devnet-only endpoints from executing on mainnet

---

## Top 7 Recommendations (Priority Order)

1. **Extract shared market sanitization pipeline** -- single biggest maintenance win, prevents the recurring drift-bug pattern (GH#1432-#2083)
2. **Increase minimum pool liquidity threshold** -- $100 is dangerously low; combined with flash-loan oracle risk, this is the primary economic attack vector
3. **Enable oracle circuit breaker by default** -- `capE2bps` defaults to 0 (disabled)
4. **Add on-chain pool verification** in the launch route to prevent oracle misdirection
5. **Fix rate limit fail-open** -- fail closed on DB errors for any value-dispensing endpoint
6. **Add internal auth token** for server-to-server RPC proxy calls
7. **Clamp pool value to 0** in stake calculations to prevent negative TVL display

---

*This audit was performed via automated static analysis. It does not include dynamic testing, formal verification, or on-chain program review. Findings should be validated by the development team before implementing fixes.*
