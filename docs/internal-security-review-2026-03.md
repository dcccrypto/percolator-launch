# Internal security review — March 2026

| Field | Value |
| ----- | ----- |
| **Repository** | `dcccrypto/percolator-launch` |
| **Commit reviewed** | `0d0c06874c462536211a284b94b21adf00909f09` (`main` at time of review) |
| **Review date** | 2026-03-29 |
| **Method** | Static review: dependency audit, repository search, targeted reads of high-risk API routes, CI workflow inspection, cross-check with `SECURITY-DEPS.md`, `DEPLOYMENT.md`, `MAINNET-CHECKLIST.md`, `supabase/migrations/README.md` |
| **Reviewer** | Automation-assisted (maintainer tooling); **human sign-off recommended** before treating this as release-blocking |
| **Companion** | Repeatable items: use `docs/internal-security-review-checklist.md` when that file exists on `main` (e.g. after checklist template PR merges). |

This is **not** a penetration test. Items marked **Not verified** require runtime, dashboard, or production access.

---

## 1. Dependencies and supply chain

| Check | Status | Notes |
| ----- | ------ | ----- |
| `pnpm audit --audit-level=high` | **Attention** | Ran with `pnpm@9`: **1 high** (`bigint-buffer` / GHSA-3gc7-fjrx-p6mg via `@solana/spl-token`). Documented as accepted risk in `SECURITY-DEPS.md`. Root `package.json` on reviewed commit has **no** `pnpm.auditConfig` ignore list; local audit exits **non-zero**. |
| CI enforcement | **Attention** | `.github/workflows/test.yml` **Security Tests** runs `pnpm audit --audit-level=high \|\| true` — failures **do not** fail the job. **Follow-up:** merge strict audit + allowlist (e.g. open PR enforcing audit without `\|\| true` and `pnpm.auditConfig` aligned with `SECURITY-DEPS.md`). |
| `pnpm.overrides` | **Pass (spot)** | Present for transitive fixes (e.g. `minimatch`, `h3`, `axios`); matches narrative in `SECURITY-DEPS.md`. No full lockfile diff in this pass. |
| New production deps | **Not verified** | No systematic `git log` sweep since last release; recommend before mainnet. |

---

## 2. Secrets and configuration

| Check | Status | Notes |
| ----- | ------ | ----- |
| Tracked source / docs | **Pass (search)** | Search for `SERVICE_ROLE`, `PRIVATE_KEY`, long `sk-` patterns: hits are **comments**, **`.env.example` placeholders**, deployment docs, or security-header tests — **no** literal secrets in reviewed paths. |
| Production env documentation | **Pass (spot)** | `docs/DEPLOYMENT.md`, `app/.env.example`, `MAINNET-CHECKLIST.md` list sensitive vars (`SUPABASE_SERVICE_ROLE_KEY`, Helius keys, crank keypair, etc.). |
| Rotation / ops | **Not verified** | Rotation timing is an **operational** process; confirm with whoever owns Supabase/Vercel/Railway. |
| Client bundle (`NEXT_PUBLIC_*`) | **Pass (spot)** | Prior grep of `app/components`: public config only (network, Privy app id, WalletConnect project id pattern, devnet gates). **Re-run** when adding new client env vars. |

---

## 3. Application API (Next.js routes)

| Check | Status | Notes |
| ----- | ------ | ----- |
| RPC proxy (`/api/rpc`) | **Pass (read)** | Method **allowlist**, **batch size cap** (`MAX_BATCH_SIZE`), upstream URLs restricted to Solana/Helius builders — not arbitrary SSRF. |
| Admin (`/api/admin/bugs`) | **Pass (read)** | `requireAdminSession()` before `getServiceClient()`; PATCH **field allowlist** (`status`, `admin_notes`). |
| Faucet / airdrop / auto-fund | **Pass (spot)** | Comments and structure indicate **DB INSERT-as-gate** / claim gates (addresses prior TOCTOU issues). Per-wallet and RPC rate-limit handling documented in-route. |
| Ideas / mobile create-market / launch | **Pass (spot)** | In-memory or shared helper rate limits referenced. **Caveat:** in-process limits are **per instance** and reset on cold start — acceptable for abuse throttling only unless Redis/edge limits are added. |
| Error responses | **Pass (spot)** | Admin and public routes generally return generic 500 messages to clients; details in server logs. |
| File uploads | **Partial** | Example: `app/app/api/tokens/[mint]/logo/route.ts` — **auth**, **MIME allowlist**, **2MB max**, per-mint rate limit. **Gap:** no **magic-byte** sniffing on this path (trusts `Content-Type` + browser). Low priority hardening for polyglot files. |

---

## 4. Data stores and privacy

| Check | Status | Notes |
| ----- | ------ | ----- |
| Supabase RLS / policies | **Not verified (live)** | `supabase/migrations/README.md` records tightening (e.g. migration **021** service_role writes, **044** admin/job policies). **Follow-up:** run policy review in Supabase SQL editor against production project. |
| PII in bug reports / admin | **Noted** | Admin bugs route intentionally returns **full** rows including PII fields — gated by **admin session**; acceptable if admin set is tightly controlled. |
| Logs | **Not verified** | Confirm Sentry/log drains do not include raw secrets (operational). |

---

## 5. Infrastructure and delivery

| Check | Status | Notes |
| ----- | ------ | ----- |
| GitHub required checks | **Partial** | `.github/workflows/pr-check.yml` runs fast build + package tests + Next build; **does not** run full `test.yml` (e2e, full merge-gate). Confirm **branch protection** requires the same jobs your team trusts for merge (see any repo `CONTRIBUTING` guidance). |
| CORS / HSTS | **Pass (doc)** | `SECURITY.md` describes CORS and security headers; alignment with prod URLs is **deployment-specific** — confirm on Vercel/Railway. |
| Third-party MFA | **Not verified** | GitHub / Supabase / Vercel org policy — ops. |

---

## 6. On-chain and external integrations

| Check | Status | Notes |
| ----- | ------ | ----- |
| Failure modes | **Pass (doc + spot)** | UI hooks and API routes use try/catch and user-facing errors in reviewed paths; oracle/RPC errors called out in code comments on faucet/airdrop. |
| Operator procedures | **Pass (doc)** | `DEPLOYMENT.md`, `MAINNET-CHECKLIST.md`, program IDs and authority notes present. |

---

## Findings summary

| ID | Severity | Topic | Recommendation |
| -- | -------- | ----- | ---------------- |
| R1 | Medium | **CI** | Remove `\|\| true` from `pnpm audit` in `test.yml` and add `pnpm.auditConfig` ignores matching `SECURITY-DEPS.md` so the job **fails** on new highs. |
| R2 | Low | **Uploads** | Consider magic-byte validation for logo uploads in addition to MIME + size. |
| R3 | Ops | **Supabase** | Quarterly: export and review RLS policies vs product assumptions. |
| R4 | Ops | **Branch protection** | Ensure required status checks include the workflows you intend (PR Check vs full Test Suite). |

---

## Sign-off

| Field | Value |
| ----- | ----- |
| Automation run | 2026-03-29 |
| Human maintainer | *(pending)* |
| Follow-ups | Track R1–R4 above; link PRs when closed |
