# Market registration: one store, one write, one switch

**Date:** 2026-07-30
**Status:** approved, ready for implementation
**Repos:** `percolator-launch`, `percolator-oracle-keeper`, Supabase project `ntcnkipyzrshoejssvbd`

## Problem

Registering a market currently takes two writes to two stores, and the one that
carries the creator's intent loses.

Measured on the live database, 2026-07-30:

```
select count(*), count(*) filter (where metadata_source='auto') from markets;
  total 5   auto 5
```

**All five rows were written by the indexer.** `POST /api/markets` has never
successfully created one. Four of the five are unidentified — `symbol='UNKNOWN'`,
`name='Market 6RobABa7'`, `dex_pool_address=null` — and every row has
`deployer` set to `DJ54k4wH92…`, the sim-USDC **mint**, not a wallet. Their
`created_at` all land on `:33`/`:34` seconds, the indexer's 60s poll cadence.

Three causes, all verified in code:

1. **A race with no tiebreak.** The slab exists on chain before the app POSTs.
   The indexer's `syncMarkets()` inserts any slab it discovers within ~60s, and
   `metadata_source` defaults to `'auto'`. `POST /api/markets` then 409s
   ("Existing metadata is immutable via this endpoint") and the launch flow
   swallows it: `catch { console.warn("…non-fatal") }`.
2. **Two stores.** The keeper's list lives in a Vercel blob written by
   `POST /api/playground/keeper-register`; metadata lives in Supabase. Nothing
   reconciles them.
3. **Add-only propagation.** `register-poll.ts` never removes. A blocklisted
   market leaves the feed but keeps being priced from the keeper's local copy —
   observed: feed serves 1 market, `registry.json` holds 3, all 3 priced every ~7s.

## Goal

One store (the `markets` row), one authenticated write, one switch to retire.
Propagation in milliseconds, not a poll interval.

Non-goals: migrating or cleaning up existing markets; unifying the two
blocklists (they stop being load-bearing for pricing, but stay for display and
ingest); the Raydium price conversion (currently blocked, tracked separately).

## What already exists

Three findings that make this much smaller than it appears:

- The keeper **already subscribes to Supabase Realtime** on `public.markets`
  (`registration-stream.ts`, `postgres_changes`, event `*`). It uses that signal
  only to trigger a blob fetch. The DB is already the change notifier; it just
  isn't the data source.
- The keeper **already holds live Supabase credentials** (`SUPABASE_URL`,
  `SUPABASE_ANON_KEY`).
- RLS is **already correct**: `markets` has anon `SELECT` (`Public read access` /
  `markets_select_anon`) with INSERT/UPDATE restricted to service-role. The
  keeper reads with the key it has and cannot write. No new credentials.

The keeper needs `slab_address`, `dex_pool_address`, `symbol`, `mint_address` —
all already columns. It does **not** need `dex_type`: it derives that from the
pool account's owner program (`detectDexType`) and validates it on every read.
Storing it would create a second copy that can disagree with chain.

## Design

### Schema

One column on `markets`:

```sql
ALTER TABLE markets ADD COLUMN IF NOT EXISTS keeper_status TEXT NOT NULL
  DEFAULT 'retired' CHECK (keeper_status IN ('active','retired'));
CREATE INDEX IF NOT EXISTS idx_markets_keeper_active
  ON markets (network) WHERE keeper_status = 'active';
```

`DEFAULT 'retired'` is the safety property. The indexer inserts rows with the
default, so **auto-discovery can never enroll a market for pricing**. Only the
authenticated registration call sets `'active'`. That is what makes it safe to
point the keeper at a table the indexer writes to.

Backfill is limited to markets the keeper is legitimately pricing today, so the
live market does not lose its price mid-rollout.

### Write path

One endpoint: `POST /api/markets/register`, grown from `keeper-register`.

Auth is unchanged — the existing H1v2 stateless proof: sign
`register:<slabAddress>:<unix-minute>`, verified against the slab's **live
on-chain marketauth**. It must run before `percolator-stake`'s `InitPool`, which
rotates marketauth away from the deployer. This is stricter than what
`POST /api/markets` uses today (a wallet-possession challenge); consolidating
onto it is a security improvement.

Write semantics — this is where the race dies:

| Existing row | Action |
|---|---|
| none | insert; `metadata_source='manual'`, `keeper_status='active'` |
| `metadata_source='auto'` | **update** — the creator's metadata beats the indexer's guess |
| `metadata_source='manual'` | idempotent update if the same marketauth signs; else 409 |

Every branch requires the marketauth proof, so the anti-tamper property behind
today's blanket 409 is preserved. What changes is that a legitimate creator no
longer loses to a bot that got there first.

Moves in from `POST /api/markets`: one-market-per-token dedupe (keyed on
`mainnet_ca` OR `dex_pool_address`, skipping self so retries do not 409
themselves), input sanitisation (invisible/bidi rejection, logo-URL validation),
network tagging. `PATCH /api/markets/[slab]` stays as the only other producer of
`metadata_source='manual'`. GET routes untouched.

Explicitly: **`POST /api/markets` is removed**, not left as a second path — its
only callers are the wizard's two launch branches in `useCreateMarket.ts`, both
of which collapse into the single `POST /api/markets/register` call. The GET
handler on `/api/markets` is unaffected. `POST /api/playground/keeper-register`
is removed once step 4 lands; until then it remains as the dual-write host.

### Read path

The keeper queries Supabase directly with its anon key:

```sql
select slab_address, dex_pool_address, symbol, mint_address
from markets
where keeper_status = 'active' and network = $1 and dex_pool_address is not null;
```

`register-poll` changes from **append** to **reconcile**: the query result is
the desired state; local entries absent from it are dropped. Two guards so a bad
read cannot wipe the registry:

- reconcile only on a **successful** query (an error is a no-op, not an empty set);
- require **N consecutive absences** (N=3) before dropping a market.

`registry.json` stops being a source of truth and becomes a disposable cache of
the last good query, so a Supabase outage degrades to *stale*, never to *silent*.

Realtime already triggers the poll, so a new market is picked up in ~ms.

### Retirement

`update markets set keeper_status='retired' where slab_address=$1`. The keeper
drops it within N reconciles. The row survives for history. The app and indexer
blocklists remain for display and ingest but stop gating pricing.

## Rollout

Order matters more than the code. Four steps, each safe alone:

1. **Migration only.** Add the column, backfill `'active'` for markets the keeper
   currently prices. Purely additive; nothing reads it yet.
2. **App dual-writes.** Registration writes the `markets` row *and* the blob. The
   old keeper keeps working, unaware. Revertible.
3. **Keeper switches** to the DB query + reconcile. The only step with real risk,
   and independently revertible because the blob still exists.
4. **Delete** the blob, its endpoint, `REGISTER_SOURCE_URL`, and the dual-write.

Steps 1–2 ship together. Step 3 is watched. Step 4 is cleanup once 3 is proven.

## Error handling

- **Registration fails** → surfaced and retryable (`LaunchSuccess` already has the
  retry). Degrades to the indexer backstop: `auto` + `retired` = indexable,
  unpriced, filtered off the board by the existing `isActiveMarket`/zombie checks.
  Nothing half-registers into looking live while not being priced.
- **Supabase unreachable** → keeper prices from its last good query. Stale, not silent.
- **Empty or failed query** → no-op, never a mass retirement.

## Testing

Unit:
- all three write-semantics branches, including idempotent re-register
- dedupe skips self
- reconcile: add, drop after N absences, no-op on error, no-op on empty-due-to-error
- `keeper_status` defaults to `'retired'` on a bare insert (the safety property)

Integration, against live devnet:
- register a throwaway market → row appears with `keeper_status='active'` and the
  creator's metadata (`metadata_source='manual'`), not `UNKNOWN`
- keeper picks it up via Realtime and pushes a price
- flip to `'retired'` → keeper stops pricing it within N reconciles

The last two are the point of the change, so they are exercised for real rather
than mocked.

## Risks

- **Step 3 is the sharp edge.** If the query returns empty due to a
  misconfiguration rather than an error, the N-absence guard is the only thing
  between that and a mass retirement. It is tested directly.
- **`dex_pool_address is not null`** in the read query means a market registered
  without a pool is silently never priced. That is correct (nothing to price
  from) but must surface in the wizard, not fail quietly.
- **The marketauth window** is a real ordering constraint driven by on-chain
  state. Registration must stay before `InitPool`; moving it later breaks auth.
