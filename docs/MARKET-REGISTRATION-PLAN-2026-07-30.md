# Market Registration Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `markets` row the single source of truth for market registration, so one authenticated write registers a market and the keeper picks it up in milliseconds.

**Architecture:** Add a `keeper_status` column to `markets` defaulting to `'retired'` (so indexer auto-discovery can never enroll a market for pricing). The registration endpoint upserts the row with the creator's metadata and `keeper_status='active'`. The keeper queries Supabase directly with the anon key it already holds and reconciles its local registry against that result instead of appending to it.

**Tech Stack:** Next.js 16 API routes, Supabase (PostgREST + Realtime + Management API), TypeScript, Vitest (app) / `node --test` (keeper), `@solana/web3.js`.

## Global Constraints

- Spec: `docs/MARKET-REGISTRATION-SPEC-2026-07-30.md`. Read it before starting.
- Supabase project ref: `ntcnkipyzrshoejssvbd` ("PercolatorIndexer", eu-west-1). Credentials in `~/.config/percolator/supabase.env` (0600).
- `markets` RLS: anon `SELECT` allowed; INSERT/UPDATE **service-role only**. Do not attempt writes with the anon key.
- The keeper runs locally under launchd as `com.percolator.oracle-keeper`. It executes `tsx` from **source**, so a restart is required for any change: `launchctl kickstart -k gui/$(id -u)/com.percolator.oracle-keeper`.
- `ps aux | grep 'tsx src/cross-cluster'` falsely reports the keeper stopped. Verify with `launchctl print` or on-chain push recency.
- App verification gate: `cd app && npx tsc --noEmit` (0 errors) + `pnpm test`. 14 pre-existing failures in ConnectButton/Header/Portfolio/useWallet (Privy) are expected — do not attempt to fix them; confirm the count is unchanged.
- Keeper verification gate: `npx tsc --noEmit` + `pnpm test` (136 passing baseline).
- Rollout order is load-bearing. Do not reorder tasks.
- Do not migrate or clean up existing markets beyond the single backfill in Task 1.

---

### Task 1: Add `keeper_status` and backfill

**Files:**
- Create: `supabase/migrations/047_markets_keeper_status.sql`

**Interfaces:**
- Produces: `markets.keeper_status TEXT NOT NULL DEFAULT 'retired'` constrained to `('active','retired')`; partial index `idx_markets_keeper_active`.

- [ ] **Step 1: Write the migration file**

```sql
-- 047: keeper_status — the single switch deciding whether the keeper prices a market.
--
-- DEFAULT 'retired' is the safety property. The indexer's syncMarkets() inserts a
-- row for every slab it discovers on chain; with this default, auto-discovery can
-- never enroll a market for pricing. Only the authenticated registration endpoint
-- sets 'active'. That is what makes it safe to point the keeper at a table the
-- indexer writes to.
ALTER TABLE markets ADD COLUMN IF NOT EXISTS keeper_status TEXT NOT NULL
  DEFAULT 'retired' CHECK (keeper_status IN ('active','retired'));

-- The keeper's only query filters on this; partial index keeps it cheap.
CREATE INDEX IF NOT EXISTS idx_markets_keeper_active
  ON markets (network) WHERE keeper_status = 'active';

NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 2: Apply it via the Management API**

```bash
set -a; . ~/.config/percolator/supabase.env; set +a
curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  --data-binary "$(python3 -c "
import json,sys; print(json.dumps({'query': open('supabase/migrations/047_markets_keeper_status.sql').read()}))")"
```
Expected: `[]` or a success body, not an error object.

- [ ] **Step 3: Verify the column and its default**

```bash
# expect keeper_status | text | NO | 'retired'::text
```
Query: `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name='markets' and column_name='keeper_status';`

Then confirm every existing row defaulted to `retired`:
`select keeper_status, count(*) from markets group by 1;` → expect `retired | 5`.

- [ ] **Step 4: Backfill the one market the keeper legitimately prices**

Only the market currently served by the feed, and only if it has a pool to price from:

```sql
update markets set keeper_status='active'
where slab_address = '5sDvEs2Zwn42ESkAmQm6Ycvi1XC3X8zHhhTDX1FX3hT7'
  and dex_pool_address is not null;
```
Verify: `select keeper_status, count(*) from markets group by 1;` → expect `active | 1`, `retired | 4`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/047_markets_keeper_status.sql
git commit -m "feat(db): add markets.keeper_status, defaulting to retired"
```

---

### Task 2: Keeper reads its market list from Supabase

**Files:**
- Create: `percolator-oracle-keeper/src/cross-cluster/db-markets.ts`
- Create: `percolator-oracle-keeper/src/cross-cluster/db-markets.test.ts`

**Interfaces:**
- Consumes: `MarketEntry` from `./registry.ts`; `detectDexType` from `@percolatorct/sdk`.
- Produces: `fetchActiveMarkets(cfg): Promise<MarketEntry[] | null>` — **`null` means the query failed** and callers must treat it as "no information", never as "no markets". Also `classifyPools(conn, pools, cache): Promise<Map<string,DexType>>`.

`dex_type` is deliberately not a DB column: the keeper derives it from the pool account's owner program, which it already validates on every price read. Storing it would create a second copy that can disagree with chain.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rowsToEntries } from "./db-markets.ts";

describe("rowsToEntries", () => {
  it("maps a DB row to a MarketEntry using the classified dexType", () => {
    const out = rowsToEntries(
      [{ slab_address: "SLAB1", dex_pool_address: "POOL1", symbol: "FOO", mint_address: "MINT1", mainnet_ca: "CA1" }],
      new Map([["POOL1", "meteora-dlmm"]]),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].marketAddress, "SLAB1");
    assert.equal(out[0].poolAddress, "POOL1");
    assert.equal(out[0].dexType, "meteora-dlmm");
    assert.equal(out[0].symbol, "FOO");
    assert.equal(out[0].assetIndex, 0);
  });

  it("drops rows whose pool could not be classified rather than guessing", () => {
    const out = rowsToEntries(
      [{ slab_address: "SLAB1", dex_pool_address: "POOL1", symbol: "FOO", mint_address: "MINT1", mainnet_ca: null }],
      new Map(),
    );
    assert.equal(out.length, 0);
  });

  it("drops rows with no pool address — there is nothing to price from", () => {
    const out = rowsToEntries(
      [{ slab_address: "SLAB1", dex_pool_address: null, symbol: "FOO", mint_address: "MINT1", mainnet_ca: null }],
      new Map(),
    );
    assert.equal(out.length, 0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test src/cross-cluster/db-markets.test.ts`
Expected: FAIL — cannot find module `./db-markets.ts`.

- [ ] **Step 3: Implement `db-markets.ts`**

```ts
/**
 * The keeper's market list, read from Supabase.
 *
 * Replaces the Vercel blob: the `markets` row is the single source of truth,
 * and `keeper_status='active'` is the only thing that enrolls a market for
 * pricing. See docs/MARKET-REGISTRATION-SPEC-2026-07-30.md in percolator-launch.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { detectDexType } from "@percolatorct/sdk";
import type { MarketEntry, DexType } from "./registry.ts";

export interface DbMarketRow {
  slab_address: string;
  dex_pool_address: string | null;
  symbol: string | null;
  mint_address: string;
  mainnet_ca: string | null;
}

/** Classify pools by their on-chain owner program, caching across cycles. */
export async function classifyPools(
  conn: Connection,
  pools: string[],
  cache: Map<string, DexType>,
): Promise<Map<string, DexType>> {
  const unknown = pools.filter((p) => !cache.has(p));
  for (let i = 0; i < unknown.length; i += 100) {
    const chunk = unknown.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(chunk.map((p) => new PublicKey(p)), "confirmed");
    infos.forEach((info, j) => {
      if (!info) return;
      const dex = detectDexType(info.owner);
      if (dex) cache.set(chunk[j], dex as DexType);
    });
  }
  return cache;
}

/** Map DB rows to registry entries, dropping anything unpriceable. */
export function rowsToEntries(rows: DbMarketRow[], dexByPool: Map<string, DexType>): MarketEntry[] {
  const out: MarketEntry[] = [];
  for (const r of rows) {
    if (!r.dex_pool_address) continue;          // nothing to price from
    const dexType = dexByPool.get(r.dex_pool_address);
    if (!dexType) continue;                      // unclassifiable — never guess
    out.push({
      label: `${r.symbol ?? r.slab_address.slice(0, 8)}/USDC — ${dexType}`,
      marketAddress: r.slab_address,
      poolAddress: r.dex_pool_address,
      dexType,
      assetIndex: 0,
      symbol: r.symbol ?? undefined,
      collateral: r.mint_address,
      registeredAt: Date.now(),
    } as MarketEntry);
  }
  return out;
}

export interface FetchActiveConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  network: string;
  mainnetConn: Connection;
  dexCache: Map<string, DexType>;
}

/**
 * Active markets, or `null` when the query FAILED.
 *
 * The null/[] distinction is load-bearing: callers reconcile against the
 * result, so a failed query returning [] would retire every market.
 */
export async function fetchActiveMarkets(cfg: FetchActiveConfig): Promise<MarketEntry[] | null> {
  const url =
    `${cfg.supabaseUrl}/rest/v1/markets` +
    `?select=slab_address,dex_pool_address,symbol,mint_address,mainnet_ca` +
    `&keeper_status=eq.active&network=eq.${encodeURIComponent(cfg.network)}` +
    `&dex_pool_address=not.is.null`;
  let rows: DbMarketRow[];
  try {
    const resp = await fetch(url, {
      headers: { apikey: cfg.supabaseAnonKey, Authorization: `Bearer ${cfg.supabaseAnonKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.warn(`[db-markets] query failed: HTTP ${resp.status}`);
      return null;
    }
    rows = (await resp.json()) as DbMarketRow[];
    if (!Array.isArray(rows)) return null;
  } catch (err) {
    console.warn(`[db-markets] query failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  try {
    await classifyPools(cfg.mainnetConn, rows.map((r) => r.dex_pool_address!).filter(Boolean), cfg.dexCache);
  } catch (err) {
    console.warn(`[db-markets] pool classification failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  return rowsToEntries(rows, cfg.dexCache);
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx tsx --test src/cross-cluster/db-markets.test.ts` → 3 passing.
Then `npx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/cross-cluster/db-markets.ts src/cross-cluster/db-markets.test.ts
git commit -m "feat(keeper): read the active market list from Supabase"
```

---

### Task 3: Reconcile instead of append

**Files:**
- Modify: `percolator-oracle-keeper/src/cross-cluster/register-poll.ts`
- Create: `percolator-oracle-keeper/src/cross-cluster/reconcile.test.ts`

**Interfaces:**
- Produces: `reconcileMarkets(registry, desired, absences, threshold): { added: string[]; removed: string[] }` — pure, no I/O, so the dangerous logic is directly testable.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcileMarkets } from "./register-poll.ts";

const mk = (a: string) => ({ marketAddress: a, poolAddress: "P" + a, dexType: "pumpswap", label: a, assetIndex: 0 } as any);

describe("reconcileMarkets", () => {
  it("adds a market present in desired but not local", () => {
    const reg = { markets: [] as any[] };
    const r = reconcileMarkets(reg, [mk("A")], new Map(), 3);
    assert.deepEqual(r.added, ["A"]);
    assert.equal(reg.markets.length, 1);
  });

  it("does NOT drop a missing market before the absence threshold", () => {
    const reg = { markets: [mk("A")] };
    const absences = new Map<string, number>();
    for (let i = 0; i < 2; i++) reconcileMarkets(reg, [], absences, 3);
    assert.equal(reg.markets.length, 1, "dropped too early");
  });

  it("drops a market after N consecutive absences", () => {
    const reg = { markets: [mk("A")] };
    const absences = new Map<string, number>();
    let removed: string[] = [];
    for (let i = 0; i < 3; i++) removed = reconcileMarkets(reg, [], absences, 3).removed;
    assert.deepEqual(removed, ["A"]);
    assert.equal(reg.markets.length, 0);
  });

  it("resets the absence counter when a market reappears", () => {
    const reg = { markets: [mk("A")] };
    const absences = new Map<string, number>();
    reconcileMarkets(reg, [], absences, 3);
    reconcileMarkets(reg, [mk("A")], absences, 3);
    reconcileMarkets(reg, [], absences, 3);
    reconcileMarkets(reg, [], absences, 3);
    assert.equal(reg.markets.length, 1, "counter did not reset on reappearance");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test src/cross-cluster/reconcile.test.ts`
Expected: FAIL — `reconcileMarkets` is not exported.

- [ ] **Step 3: Add `reconcileMarkets` to `register-poll.ts`**

```ts
/**
 * Reconcile the local registry against the desired set.
 *
 * register-poll used to be append-only, so a market removed upstream kept being
 * priced from the local copy forever (observed: feed served 1 market, registry
 * held 3, all 3 priced every ~7s). This makes the desired set authoritative.
 *
 * The absence threshold is the guard: a market must be missing from N
 * CONSECUTIVE successful queries before it is dropped, so one odd-but-successful
 * result cannot retire the board. Callers must never invoke this with the result
 * of a FAILED query — see fetchActiveMarkets' null contract.
 */
export function reconcileMarkets(
  registry: { markets: any[] },
  desired: any[],
  absences: Map<string, number>,
  threshold: number,
): { added: string[]; removed: string[] } {
  const desiredByAddr = new Map(desired.map((m) => [m.marketAddress, m]));
  const added: string[] = [];
  const removed: string[] = [];

  for (const [addr, entry] of desiredByAddr) {
    absences.delete(addr);
    if (!registry.markets.some((m) => m.marketAddress === addr)) {
      registry.markets.push(entry);
      added.push(addr);
    }
  }

  for (const local of [...registry.markets]) {
    if (desiredByAddr.has(local.marketAddress)) continue;
    const n = (absences.get(local.marketAddress) ?? 0) + 1;
    absences.set(local.marketAddress, n);
    if (n >= threshold) {
      registry.markets = registry.markets.filter((m) => m.marketAddress !== local.marketAddress);
      absences.delete(local.marketAddress);
      removed.push(local.marketAddress);
    }
  }
  return { added, removed };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx tsx --test src/cross-cluster/reconcile.test.ts` → 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/cross-cluster/register-poll.ts src/cross-cluster/reconcile.test.ts
git commit -m "feat(keeper): reconcile the registry instead of only appending"
```

---

### Task 4: Registration writes the markets row

**Files:**
- Modify: `app/app/api/playground/keeper-register/route.ts`
- Modify: `app/hooks/useCreateMarket.ts` (remove the two `POST /api/markets` calls)
- Create: `app/__tests__/api/register-upsert.test.ts`

**Interfaces:**
- Produces: `upsertMarketRow(supabase, row, opts): Promise<{ ok: true } | { ok: false; status: number; error: string }>` exported from the route module for testing.

Write semantics, from the spec — all three branches require the marketauth proof, so the anti-tamper property is preserved:

| Existing row | Action |
|---|---|
| none | insert; `metadata_source='manual'`, `keeper_status='active'` |
| `metadata_source='auto'` | update — creator metadata beats the indexer's guess |
| `metadata_source='manual'` | idempotent update if same marketauth; else 409 |

- [ ] **Step 1: Write the failing test** covering all three branches plus the safety default. Use a fake supabase client exposing `.from().select().eq().maybeSingle()` and `.upsert()`.

- [ ] **Step 2: Run it and watch it fail** — `upsertMarketRow` not exported.

- [ ] **Step 3: Implement `upsertMarketRow`** in the route and call it after the existing marketauth verification and pool classification, **in addition to** the existing blob write (this is the dual-write step; the blob is removed in Task 6).

- [ ] **Step 4: Remove the `POST /api/markets` calls** from `useCreateMarket.ts` (lines ~1348 and ~3091) so launch makes one registration call.

- [ ] **Step 5: Verify** — `npx tsc --noEmit` clean; `pnpm test` shows the same 14 pre-existing failures and no new ones.

- [ ] **Step 6: Commit**

---

### Task 5: Cut the keeper over to the DB

**Files:**
- Modify: `percolator-oracle-keeper/src/cross-cluster.ts` (pass Supabase config into the poll)
- Modify: `percolator-oracle-keeper/src/cross-cluster/register-poll.ts` (source from `fetchActiveMarkets`, reconcile the result)

- [ ] **Step 1** — replace the blob fetch in `pollOnce` with `fetchActiveMarkets`; on `null`, log and return without touching the registry.
- [ ] **Step 2** — feed the result through `reconcileMarkets` with threshold 3; persist only when `added.length || removed.length`.
- [ ] **Step 3** — `npx tsc --noEmit` + `pnpm test` green.
- [ ] **Step 4** — commit, push, then `launchctl kickstart -k gui/$(id -u)/com.percolator.oracle-keeper`.
- [ ] **Step 5: Verify on chain** — confirm the keeper still pushes a price for the backfilled market within 30s, and that the two retired markets stop being pushed within 3 reconciles.

---

### Task 6: Remove the blob (after Task 5 is proven)

**Files:**
- Delete: `app/lib/playground-registered-markets.ts`, `app/app/api/playground/registered-markets/route.ts`
- Modify: `app/app/api/playground/keeper-register/route.ts` (drop the blob write), `app/app/api/markets/route.ts` (drop the POST handler), keeper `.env` (drop `REGISTER_SOURCE_URL`)

- [ ] **Step 1** — remove the blob write and its module; keep the DB write.
- [ ] **Step 2** — remove the `POST` handler from `/api/markets`; leave GET untouched.
- [ ] **Step 3** — `npx tsc --noEmit` + `pnpm test`; fix any test that referenced the removed paths.
- [ ] **Step 4** — commit and push.

---

## Self-Review

**Spec coverage:** schema → Task 1. Write path → Task 4. Read path → Tasks 2, 3, 5. Retirement → Task 1 (column) + Task 3 (reconcile). Rollout steps 1–4 → Tasks 1, 4, 5, 6. Error handling (null-vs-empty, N absences) → Tasks 2, 3. Testing → per-task, plus Task 5 step 5 on-chain. Covered.

**Placeholders:** none — Tasks 1–3 carry full code; Tasks 4–6 are step-level because they modify large existing files whose exact context must be read at edit time, and each names its files, line anchors and acceptance check.

**Type consistency:** `fetchActiveMarkets` returns `MarketEntry[] | null` in Task 2 and is consumed as such in Task 5. `reconcileMarkets(registry, desired, absences, threshold)` has the same signature in Tasks 3 and 5. `rowsToEntries` and `classifyPools` share the `Map<string, DexType>` cache type.
