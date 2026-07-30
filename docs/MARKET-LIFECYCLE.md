# Market Lifecycle — who owns which registry

**Status:** descriptive, written 2026-07-29. Documents what the system *does today*,
verified against live devnet, not what it should do. Fixes are listed at the end as
open gaps, deliberately unimplemented.

A market's existence is not recorded in one place. Six stores each hold part of the
answer, written by three different processes, and no single one of them can tell you
whether a market is live, retired, priced, or tradeable. This is the reference for
which store is authoritative for what, what happens on create and retire, and where
the seams are.

---

## 1. The six stores

| # | Store | Written by | Authoritative for | Lives in |
|---|-------|-----------|-------------------|----------|
| 1 | **The slab account** | the launch tx | existence, config, balances, LP caps | Solana |
| 2 | **Supabase `markets`** | app `POST /api/markets` **and** indexer `syncMarkets()` | display metadata (symbol, name, logo, deployer) | Supabase |
| 3 | **Supabase `market_stats`** | indexer | volume / trade count / last price only | Supabase |
| 4 | **Blob `playground/registered-markets.json`** | app `POST /api/playground/keeper-register` | which markets the keeper is *told* to price | Vercel Blob |
| 5 | **Keeper `registry.json`** | keeper `register-poll` | which markets the keeper *actually* prices | oracle-keeper host |
| 6 | **Two blocklists** | humans, by hand | which markets are retired | two repos |

Plus `app/lib/playground-slab-meta.ts` — hardcoded metadata and pinned LP-portfolio
addresses for curated markets, which short-circuits several lookups.

**Nothing reconciles these.** Each is written independently; divergence is normal and
invisible until someone compares them.

### Read paths

- `/api/markets` and `/api/stats` both go through `loadMergedMarketRows()`
  (`app/lib/market-registry.ts`) — deliberately one loader, because they previously
  disagreed badly enough to read as fabrication ("161 markets / $237K OI" beside pages
  showing 6 markets / ~$35K). Keep it that way.
- `market_stats` is a **reduced schema** since 2026-07: it carries only
  `slab_address / volume_24h / volume_24h_usd / trade_count_24h / last_price /
  network / updated_at`. Mark price, OI, insurance, vault balance and funding are NOT
  in the DB — they are merged in live from chain on every request. Do not re-add them
  to `MARKET_SELECT_FIELDS` expecting them to be populated.

---

## 2. Create sequence

What actually happens when someone launches, in order:

1. **On-chain**: the wizard builds and sends the market-creation transactions. The
   slab now exists. *Everything below is bookkeeping, and every step of it can fail
   without failing the launch.*
2. **`POST /api/playground/keeper-register`** — writes store 4 (the blob). Runs early
   and is *not* deferred: it must land before `StakeInitPool` rotates marketauth,
   because its H1 deployer check requires marketauth to still equal the deployer.
   This route classifies the pool by its **on-chain owner program**, so the `dexType`
   the client sends is only a hint.
3. **`POST /api/markets`** — writes store 2 (metadata). Wrapped in
   `try { … } catch { console.warn("markets DB registration failed (non-fatal)") }`.
4. **Keeper `register-poll`** — polls `/api/playground/registered-markets` (store 4,
   already filtered by the app blocklist) and copies new entries into store 5. Applies
   its own on-chain **owner filter**, so markets belonging to a retired wrapper are
   skipped even if the feed still lists them.
5. **Indexer `syncMarkets()`** — independently discovers *every* slab on chain and
   inserts any it does not already have in store 2, with `metadata_source: "auto"`.

### ⚠ The metadata race (step 3 vs step 5)

These two writers race, and the loser is silently discarded:

- `POST /api/markets` **409s** when a row for that slab already exists —
  *"Existing metadata is immutable via this endpoint."* This is deliberate
  anti-tamper-by-replay behaviour.
- The indexer inserts on discovery, typically **within a minute** of the slab
  appearing on chain.
- The slab exists from step 1, but the app does not POST until step 3.

So whenever the indexer wins, the creator's typed name/symbol is rejected with a 409
that the launch flow swallows as non-fatal, and the market keeps the indexer's
auto-derived identity forever. Observed on devnet: a market launched as one name
displays DexScreener's `Fauci / Dr. Death`, with `deployer` holding the **collateral
mint address** rather than the launching wallet.

`metadata_source` is the tell: `auto` means the indexer wrote it, `manual` means a
human did via `PATCH /api/markets/[slab]`. A creator-launched market showing `auto`
lost this race.

---

## 3. Retire sequence

Retiring is a **three-repo, manual** operation, and only the first two are wired:

1. `app/lib/blocklist.ts` (58 entries) — hides the market from `/api/markets`,
   `/api/stats`, the UI, **and** filters it out of the keeper feed
   (`registered-markets/route.ts` filters on `BLOCKED_SLAB_ADDRESSES`).
2. `percolator-indexer/src/blocklist.ts` (23 entries) — stops `syncMarkets()`
   re-inserting the row. **Without this the frontend blocklist alone is not enough**:
   discovery sees the slab on chain every cycle and re-registers it within a minute.
3. The keeper's `registry.json` — **nothing does this.** See the gap below.

The two blocklists must be edited in lockstep. They have different lengths because
they serve different purposes (the app list also carries historical bad slabs), so
size is not a reconciliation signal — a market can legitimately be in one and not the
other, which makes a half-applied retirement indistinguishable from a correct state.

---

## 4. Open gaps

Recorded, not fixed.

### 4.1 The keeper never prunes — retired markets keep getting priced

`register-poll.ts` is **add-only**. It walks the feed, skips anything already `known`,
and calls `addMarket`. There is no removal path in the file. A market that leaves the
feed — because it was blocklisted — stays in `registry.json` and keeps being priced.

Verified live 2026-07-29 by decoding the keeper's own price pushes:

```
feed serves:           1 market
keeper registry.json:  3 markets
keeper pushes every ~7s to all 3, two of which are blocklisted in BOTH repos
```

`fix(keeper-feed): stop serving retired markets to the oracle keeper` fixed the feed
side only; anything already copied locally was never taken back out.

Consequence: blocklisting hides a market from the board while the keeper keeps it warm
on chain, burning fees indefinitely. Retirement is not actually complete without
someone hand-editing `registry.json` on the keeper host.

**Fix shape:** make `register-poll` reconcile rather than append — treat the feed as
the desired state and drop local entries absent from it. Needs care: a transient feed
failure must not be read as "retire everything", so removal should require a
successful fetch and probably N consecutive absences.

### 4.2 Two blocklists, one intent

Retiring takes edits in two repos that ship independently, so a retirement can
half-apply: blocklisted in the app but not the indexer means the row is re-created and
merely hidden; the reverse means it vanishes from the board while still being indexed.
A shared list (or one deriving from the other) would make the operation atomic.

### 4.3 Creator metadata loses the race

See §2. The 409 is correct as an anti-tamper rule but wrong as a launch outcome:
the legitimate creator's metadata is the one thing that *should* win over auto-derived
data. Options, roughly in order of preference: have the app write store 2 **before**
or as part of the on-chain step; have the indexer skip auto-registering a slab that is
younger than some grace window; or let `POST /api/markets` upsert over an `auto` row
(never over a `manual` one) when the caller proves deployer ownership — which it
already does via the challenge/signature flow.

### 4.4 No reconciliation view

There is no single place to ask "is this market live?". Answering it today means
querying chain, Supabase, the blob, the keeper host, and two source files. A read-only
diff endpoint over the six stores would make every gap above self-evident instead of
requiring an investigation to notice.

---

## 5. Rules of thumb

- **Chain is truth for state; Supabase is truth for identity; the blob is truth for
  intent-to-price; the keeper's registry is truth for what is actually being priced.**
  When they disagree, that ordering is usually the one you want.
- A market missing from `/api/markets` is not necessarily broken — check both
  blocklists first; retirement looks identical to loss.
- A market present in `/api/markets` is not necessarily priced, and a market being
  priced is not necessarily in `/api/markets`.
- `metadata_source: "auto"` on a creator-launched market means §2's race was lost.
- Never assume the keeper's `registry.json` matches the feed. It is a superset, and
  drifts one way only.
