# /allocation and /vote on percolator.trade

Two direct-URL pages for the PERC allocation checker and holder vote. They are
not linked from the header, footer, navigation, homepage or waitlist, are not in
the sitemap, and send `noindex, nofollow` (page metadata and `X-Robots-Tag`).

## Allocation checker (one wallet at a time, server-side database)

`/allocation` states the published terms (a guaranteed floor of 20% of the full
raise, split in proportion to snapshot balance; excess commitment refunded;
figures provisional until the raise) and has one form: paste a wallet, get the
result for that wallet only.

`POST /api/allocation/check` with exactly `{"wallet": "<address>"}`:

| Result | HTTP | Body |
|---|---|---|
| eligible | 200 | `status`, `snapshot`, `snapshot_balance` (exact, token units), `provisional_allocation_usd` (exact cents), `allocation_status: "provisional"` |
| excluded | 200 | `status`, `snapshot`, `snapshot_balance`, `exclusion_reasons` (known codes + labels), no allocation |
| not in snapshot | 200 | `status: "not_found"`, `snapshot`. No balance, no allocation, never a zero |
| invalid input | 400/413/415 | not canonical base58 32-byte, arrays, extra keys, several addresses, oversize, non-JSON |
| rate limited | 429 | `retry_after_seconds` + `Retry-After` |
| not configured / database error / malformed answer | 503 | `status: "unavailable"` |

The holder list never reaches the browser: it is not in the repository, public
assets, client bundles, source maps or the page's server-component payload. The
page renders only static copy; the form posts one wallet and renders one answer.
Nothing is cached (`Cache-Control: no-store`, no result cache, no shared state
between requests beyond pooled connections). The wallet is not logged.

### Database (dedicated private Postgres: Neon project `percolator-allocation-checker`)

Migration: `supabase/waitlist-migrations/20261108000000_perc_alloc_private_lookup.sql`.

- A dedicated database, separate from the waitlist Supabase project (which is
  untouched). The SQL is plain Postgres; on Supabase it would also revoke
  `anon`, `authenticated` and `service_role`.
- Schema `perc_alloc`: nothing granted to PUBLIC.
- `perc_alloc.snapshot`: label, date, slot, token decimals, floor/raise in cents,
  counts, source hashes, team-exclusion provenance, active/superseded timestamps.
  One active snapshot; older ones are kept as superseded, never deleted.
  Approved balance exceptions: count, private provenance text, exception-file
  hashes and the base manifest hash.
- `perc_alloc.holder`: one row per owner per snapshot. `balance_raw numeric(20,0)`
  (exact base units, u64 range), `allocation_usd_cents bigint`, `eligible`,
  `exclusion_reasons` (only `off-curve`, `LP`, `burn`). Constraints make an
  excluded row with an allocation, or an eligible row with a reason, impossible.
  `balance_basis` is `snapshot`, or `exception` for an eligible owner counted
  under an approved balance exception (shown as "Counted balance (approved
  exception)"; no other label is ever public).
- `perc_alloc.rate_limit`: `bucket bytea(32)`, window, hits, expiry. No IP, no owner.
- `perc_alloc.check_allocation(owner text, client_key bytea)`: the only runtime
  entry point. SECURITY DEFINER, owned by the NOLOGIN role `perc_alloc_definer`
  (SELECT on snapshot/holder, read/write on rate_limit only). Validates input,
  applies the limits atomically in the same statement, then reads exactly one
  primary-key row.
- Runtime role `perc_alloc_reader`: EXECUTE on that one function, no table
  privileges, `statement_timeout = 3s`, connection limit 30. The app refuses any
  other database user name.

Rate limits (constants in SQL, not caller-controlled): 10 per client per minute,
60 per client per hour (denied attempts count), 600 per minute across all
clients. The client key is HMAC-SHA256 of the client IP (IPv6 by /64) under
`ALLOCATION_RATE_LIMIT_SECRET`; the database never sees an IP. Unknown wallets
cost the same as known ones.

### Server-only configuration (none of these is a publish switch)

| Env var | Purpose |
|---|---|
| `ALLOCATION_DATABASE_URL` | Postgres URL for `perc_alloc_reader` (Neon pooled host recommended; Supavisor user form `perc_alloc_reader.<project-ref>` also accepted). Non-loopback hosts always use verified TLS; URL `ssl*` parameters are ignored. |
| `ALLOCATION_RATE_LIMIT_SECRET` | 32+ random characters. |
| `ALLOCATION_DATABASE_CA_PEM` | Optional CA certificate for TLS verification. |

Without a valid URL and secret the checker answers 503 unavailable. None of
these are `NEXT_PUBLIC_*`.

### Operator procedure (owner-approved; done outside git, secrets never committed)

1. Apply the migration to the dedicated database as its owner/import role.
2. Out of band: `alter role perc_alloc_reader login password '<generated>';`
3. Import the snapshot from the private files (kept outside the repository):

   ```sh
   npx tsx app/scripts/allocation/import-snapshot.ts \
     --eligible <eligible.csv> --manifest <manifest.json> --all-holders <all-holders.csv> \
     --snapshot-date YYYY-MM-DD --snapshot-slot <slot> --token-decimals <n>          # validate only
   ALLOCATION_IMPORT_DATABASE_URL=... npx tsx app/scripts/allocation/import-snapshot.ts ... --apply --allow-remote
   ```

   A derived (v2) export that adds approved balance-exception owners needs
   `--base-manifest <v1 manifest.json>` and one `--exception <file.json>` per
   added owner. The importer then also checks: the derived manifest names the
   base export by hash, the floor/terms/rounding/slot agree, the declared owner
   counts and raw totals match, each exception owner is canonical, present in
   the export at exactly its exception balance and not already ordinarily
   eligible (an exception supersedes an earlier exclusion), and the all-holder
   file's balances for every other owner. All v1 checks still run.

   Re-runnable: each `--apply` inserts a new versioned snapshot, verifies it
   (row count, unique owners, eligible and exception counts, exact cents and raw
   totals) in the same transaction and only then moves the single active
   pointer. A failure leaves the previous snapshot active; re-applying the
   inputs that are already active is a no-op.

   The importer checks the eligible file's hash against the manifest, every row
   and owner, the exact floor arithmetic, re-derives every allocation with exact
   largest-remainder math, cross-checks every owner against the all-holder file
   (exclusion reasons come only from there), then inserts in one transaction that
   verifies its own totals before it supersedes the active snapshot. It prints
   counts and hashes only.
4. Set the server-only env vars on the percolator.trade Vercel project only.

The importer refuses a manifest whose snapshot date, floor percent or raise
differ from the published terms (`PUBLISHED_TERMS` in `import-lib.ts`, tied to
`copy.ts` by a test), so the page cannot contradict the per-wallet figures.
Remote imports always use verified TLS.

### Deployment prerequisites (from the independent review)

- **Client IP.** percolator.trade is served by Vercel directly (not through the
  Cloudflare proxy), so per-client limits key only on the Vercel-set
  `x-real-ip` / `x-vercel-forwarded-for`; client-settable `cf-connecting-ip` and
  `x-forwarded-for` are ignored. Putting a proxy in front would make clients
  share the proxy's buckets (more limiting, not less).
- **TLS CA.** Neon certificates chain to a public CA (no PEM needed). Supabase
  database/pooler certificates usually need the project CA:
  set `ALLOCATION_DATABASE_CA_PEM`, or every lookup fails closed as unavailable.
- **Connection budget.** The reader role allows 30 connections; each warm
  serverless instance holds up to 3. Prefer the provider's pooled URL.

## Vote: disabled

`/vote` says voting is not open and has no controls.
`GET /api/vote/status` returns `{"state":"UNAVAILABLE","open":false}`.
`POST /api/vote/challenge` and `POST /api/vote/submit` always return 503 without
reading the body. `GET /api/vote/results` and `/api/vote/log` return 409 `not_started`.
There is no start, admin or configure endpoint. The state lives in
`app/lib/allocation-vote/state.ts` as constants; a test asserts the vote files
read no `process.env`, filesystem or storage.

## Host isolation

`main` is built by two Vercel projects (percolator-launch and percolator-mainnet).
Pages and APIs serve only when the `Host` header is exactly `percolator.trade`
(optional numeric port). Every other host, including mainnet.percolatorlaunch.com,
Vercel previews, localhost, subdomains and lookalikes, gets 404 from middleware,
and again from each page and handler (before any database call). Forwarding
headers (`x-forwarded-host` and similar) are never consulted. The existing
`www.percolator.trade` and `percolatorlaunch.com` 301s to `percolator.trade` are
unchanged. The env vars above belong on the percolator.trade project only.

## Known limitations

- Client IP comes from the waitlist helper (`cf-connecting-ip`, then `x-real-ip`).
  If the origin can be reached without Cloudflare, `cf-connecting-ip` can be
  forged to rotate per-client keys; the global cap still bounds total lookups.
- The global cap trades availability for enumeration resistance: a distributed
  flood can make the checker answer 429 for everyone for up to a minute.
- The runtime role still has the privileges Postgres grants every role through
  `PUBLIC` (for example EXECUTE on functions in `public` that were never revoked
  from `PUBLIC`).
