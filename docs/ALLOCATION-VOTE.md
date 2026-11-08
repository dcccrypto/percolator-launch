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

## Vote: weekly fee claims vs buy-and-burn (NOT STARTED by default)

**Rules.** Voters are the eligible rows of the checker snapshot that is active
when the poll starts (the poll pins that `snapshot_id`; a later re-import does
not change the voter set or weights). Votes are weighted by exact snapshot
`balance_raw`. Weekly fee claims wins only on a strict majority of balance
voted; a tie or zero votes is buy-and-burn. No quorum. One 24 hour window from
the moment an admin starts it (database clock). One ballot row per wallet;
a wallet may change its vote while the window is open and its last valid vote
counts. Results are aggregates only, published 60 seconds after the window
closes (`tallying` until then, so a cast committing at the boundary can never
change a published result).

**Flow.** `POST /api/vote/challenge {"wallet","choice"}` returns a single-use
5 minute nonce and the exact text to sign:

```
percolator.trade PERC holder vote
Action: cast-vote
Domain: percolator.trade
Poll: perc-fee-policy-2026-11
Choice: <weekly-fee-claims|buy-and-burn>
Wallet: <address>
Nonce: <64 hex>
Issued At: <UTC ms ISO>
Expires At: <UTC ms ISO>
Signing records a vote only. It is not a transaction and moves no funds.
```

The wallet signs it (Wallet Standard `solana:signMessage`, no transaction).
`POST /api/vote/submit` sends the fields + base58 signature. The server
rebuilds the text, verifies Ed25519 (canonical encodings, S < L), then one
database transaction (`perc_vote.cast_vote`) rebuilds the text again, checks the
window and eligibility, locks and consumes the nonce (bound to poll, wallet,
choice, issue and expiry time) and upserts the ballot, storing message and
signature. Concurrent replays consume a nonce at most once.

**Database.** `supabase/waitlist-migrations/20261108010000_perc_vote.sql`, applied
AFTER the checker migration to the same database. Private schema `perc_vote`
(poll, nonce, ballot); SECURITY DEFINER functions owned by `perc_alloc_definer`;
the runtime role `perc_alloc_reader` may only EXECUTE them (no table access).
Rate limits reuse `perc_alloc._hit` with hashed client keys. Applying the
migration does not start the vote. The migration is additive only (no DROP).

Then `20261108020000_perc_private_rls.sql` enables row level security on all six
private tables (`perc_alloc.{snapshot,holder,rate_limit}` and
`perc_vote.{poll,nonce,ballot}`). Only `perc_alloc_definer` gets a policy. The
API roles and the runtime role have no grants and no policies. The table owner,
used by the import, is not forced through RLS.

**Configuration.** Same server-only `ALLOCATION_DATABASE_URL` and
`ALLOCATION_RATE_LIMIT_SECRET` as the checker, plus `VOTE_ADMIN_SECRET`
(server-only, Production only, at least 32 random characters). Without
`VOTE_ADMIN_SECRET` the start endpoint returns 404.

**Starting (owner approval required; one-shot, irreversible).** Open
`https://percolator.trade/vote/admin`, paste the admin secret, tick the
confirmation and press Start. Equivalent:
`POST /api/vote/admin/start` with header `Authorization: Bearer <secret>` and body
`{"confirm":"START perc-fee-policy-2026-11"}`. The secret is never accepted
from a URL or cookie. Attempts are limited to 5 per client per 15 minutes
(no global bucket, so strangers cannot lock the admin out), counted before the
secret is compared. Note: the runtime database role can also execute
`perc_vote.start_poll`; treat `ALLOCATION_DATABASE_URL` as able to start the poll. A second start
returns 409 and never extends or restarts the window.

**Not-started check (read-only):** `GET /api/vote/status` -> `"state":"not_started"`,
or `select count(*) from perc_vote.poll` -> 0.

## Host isolation

`main` is built by two Vercel projects (percolator-launch and percolator-mainnet).
Pages and APIs serve only when the `Host` header is exactly `percolator.trade`
(optional numeric port). Every other host, including mainnet.percolatorlaunch.com,
Vercel previews, localhost, subdomains and lookalikes, gets 404 from middleware,
and again from each page and handler (before any database call). Forwarding
headers (`x-forwarded-host` and similar) are never consulted. The existing
`www.percolator.trade` and `percolatorlaunch.com` 301s to `percolator.trade` are
unchanged. The env vars above belong on the percolator.trade project only.

**Deployed-preview E2E exception (opt-in, one host).** A Vercel deployment also
serves these surfaces on one extra host if both of these hold:

- Vercel marks it as a preview (`VERCEL_ENV=preview`, a Vercel system variable);
- it was given `ALLOCATION_VOTE_PREVIEW_HOST` per deployment (`vercel deploy -e/-b`).

The value must be exactly one single-label `*.vercel.app` hostname. It is
compared by exact equality, with no wildcard and no port. Production, mainnet
and ordinary previews are unaffected. Never store this variable in the project
env. Use it only with an isolated throwaway database, and give that deployment
throwaway `ALLOCATION_DATABASE_URL`, `ALLOCATION_RATE_LIMIT_SECRET` and
`VOTE_ADMIN_SECRET` values. Never reuse production values there. The harness is
`app/scripts/vote/e2e-preview.ts`. It refuses any database holding a
non-synthetic snapshot.

## Known limitations

- The client IP for allocation/vote rate limits comes only from the
  Vercel-set `x-real-ip` / `x-vercel-forwarded-for`. `cf-connecting-ip` and
  `x-forwarded-for` are ignored. The global cap still bounds total lookups.
- The global cap trades availability for enumeration resistance: a distributed
  flood can make the checker answer 429 for everyone for up to a minute.
- The runtime role still has the privileges Postgres grants every role through
  `PUBLIC` (for example EXECUTE on functions in `public` that were never revoked
  from `PUBLIC`).
