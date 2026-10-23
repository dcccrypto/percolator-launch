# Security Dependency Risk Register

> Last updated: 2026-03-29
> Audited by: security agent

## Summary

| Metric | Count |
|--------|-------|
| Total vulnerabilities (pre-remediation) | 7 |
| Fixed by dependency removal | 2 (elliptic, lodash) |
| Fixed by pnpm override | 3 (minimatch ×3) |
| Fixed in prior PR | 1 (hono, PR #265) |
| Remaining (risk accepted) | 2 |

## Remediation Actions Taken

### 1. Removed `@solana/wallet-adapter-wallets` (unused)

**Eliminated:** elliptic (low), lodash prototype pollution (moderate)

The `@solana/wallet-adapter-wallets` package was declared as a dependency in
`app/package.json` but never imported. The WalletProvider uses an empty wallets
array with wallet-standard auto-detection (Phantom, Solflare, etc.). This
package pulled in `@solana/wallet-adapter-torus` and its deep dependency chain
including `elliptic` (risky crypto implementation) and `lodash` (prototype
pollution via `_.unset`/`_.omit`).

**Risk of removal:** None. No code references this package.

### 2. Overrode `minimatch` to ≥10.0.0

**Eliminated:** minimatch ReDoS (high, ×3 paths)

The vulnerable minimatch 3.x was pulled in transitively by:
- `eslint@8 → minimatch`
- `@typescript-eslint/typescript-estree → minimatch`
- `eslint-config-next → eslint-plugin-import → ... → minimatch`

Added `"minimatch": ">=10.0.0"` to `pnpm.overrides` in root `package.json`.
Verified linting still passes with the override.

### 3. Hono upgrade (prior — PR #265)

**Eliminated:** hono vulnerability (coder, Sprint 2)

## Remaining Vulnerabilities — Risk Accepted

### stream-json <=3.4.0 (moderate, ignored: GHSA-528h-pc64-c93x)

- **Path:** `@solana/web3.js -> jayson 4.3.0 -> stream-json 1.9.1`
- **Why accepted:** `@solana/web3.js` only loads `jayson/lib/client/browser`; the stream-json code path (server-side JSON streaming) is unreachable. Overriding to stream-json >=3.5.0 is NOT an option: 3.x is ESM-only and breaks `require('jayson')` / `jayson/lib/utils` (MODULE_NOT_FOUND) on jayson 4.3.0 (`^1.9.1`). Mirrored in `pnpm.auditConfig.ignoreGhsas`.

### bigint-buffer ≤1.1.5 — Buffer Overflow (HIGH)

- **Advisory:** GHSA-3gc7-fjrx-p6mg / CVE-2025-3194
- **Path:** `@solana/spl-token → @solana/buffer-layout-utils → bigint-buffer`
- **Patched versions:** No released patch (upstream PR #64 open, unmerged as of 2026-03-25)
- **Risk assessment:** LOW effective risk despite HIGH CVSS
  - **Root cause:** Stack buffer overflow in native C binding's `fromBigInt` function
    (`bigint_buffer.cc`). The `fits_in_stack` check compared `word_count` bytes
    against `BUFFER_STACK_SIZE` (element count), causing overflow when a BigInt
    requiring more than ~64 bytes is converted to a Buffer via native path.
  - **JS path is safe:** When `process.browser === true` (Next.js frontend) or
    when the native binding fails to load, a pure JS fallback is used — this path
    is not affected by the C overflow.
  - **Server-side (api, indexer, keeper):** Uses native bindings in Node.js. However,
    all inputs to `toBufferLE/toBufferBE` come from SPL Token's internal fixed-size
    serialization (u64 = 8 bytes, u128 = 16 bytes) — well within stack limits. No
    user-controlled BigInt can reach this path without first passing Solana runtime
    validation.
  - **Fix available (unmerged):** ja88a/bigint-buffer@840d2146 has the one-line C fix.
    A maintained drop-in replacement exists: `@vekexasia/bigint-buffer2@1.1.1` (Rust
    napi bindings, same API). Cannot override via `pnpm.overrides` without package
    name matching; would require forking `@solana/buffer-layout-utils`.
- **Mitigation:** Monitor for `@solana/spl-token` releasing a version that drops
  `bigint-buffer` or migrates to `@vekexasia/bigint-buffer2`. If upstream PR #64
  is merged and a new bigint-buffer version is published, upgrade immediately.
- **Decision:** ACCEPT — effective exploit risk is low in our context (fixed-size
  inputs, frontend uses safe JS path). No actionable drop-in fix available without
  forking upstream Solana packages. Last reviewed: 2026-03-25.

### h3 <1.15.9 — SSE Injection + Path Traversal (MODERATE) — MITIGATED

- **Advisory:** GHSA-4hxc-9384-m385 (SSE Event Injection via `\r`), GHSA-72gr-qfp7-vwhw (Double Decoding Path Traversal in serveStatic)
- **Path:** `@privy-io/react-auth → @walletconnect/ethereum-provider → @walletconnect/keyvaluestorage → unstorage → h3`
- **Patched versions:** ≥1.15.9
- **Risk assessment:** LOW effective risk despite MODERATE CVSS
  - `h3` arrives via `@walletconnect/keyvaluestorage` which uses `unstorage` for client-side key-value storage only — NOT as an HTTP server.
  - Both vulnerable surfaces (`serveStatic` path traversal, SSE injection) require an HTTP server context that is never instantiated in this dep chain.
- **Mitigation:** pnpm override set to `>=1.15.9` (PR #1505, GH#1504). h3 1.15.9 resolves both advisories.
- **Decision:** RESOLVED via override — PR #1505.

### ajv <8.18.0 — ReDoS with `$data` option (MODERATE)

- **Advisory:** GHSA-2g4f-4pwh-qvx6
- **Path:** `eslint@8 → ajv`
- **Patched versions:** ≥8.18.0
- **Risk assessment:** NEGLIGIBLE
  - `ajv` is a transitive dev dependency of ESLint 8. It runs only during
    local development linting — never in production builds or at runtime.
  - The ReDoS requires the `$data` option, which ESLint's usage does not enable.
  - Upgrading ESLint 8→9 would fix this but requires flat config migration
    across the root workspace, which is a larger effort (tracked separately).
- **Mitigation:** Upgrade root workspace to ESLint 9 + typescript-eslint 8
  when the team has bandwidth for config migration.
- **Decision:** ACCEPT — dev-only, no production impact, no realistic exploit
  path.

## CI enforcement

The **Security Tests** job in `.github/workflows/test.yml` runs `pnpm audit --audit-level=high` and **fails the workflow** on any high-or-critical advisory that is not explicitly ignored.

Accepted-risk items (currently **bigint-buffer** / GHSA-3gc7-fjrx-p6mg) must be mirrored in root `package.json` under `pnpm.auditConfig.ignoreGhsas` / `ignoreCves` so the audit passes while the register below stays authoritative.

## In-memory rate limits (API routes)

Several routes use **in-process** counters (e.g. ideas submission, mobile create-market). That is correct for a single Node instance but **does not coordinate across** multiple serverless instances or cold starts. For strict global limits, use a shared store (e.g. Redis) or an edge/WAF rate limiter; until then, treat in-memory limits as **best-effort abuse throttling**.

## Audit Commands

```bash
# Full audit (respects pnpm.auditConfig ignores)
pnpm audit

# Fail CI-equivalent check locally
pnpm audit --audit-level=high

# Check specific package
pnpm why <package-name>

# Verify overrides are applied
pnpm ls minimatch
```

## Review Schedule

This register should be reviewed:
- Before each mainnet deployment
- When adding new dependencies
- Monthly during active development
