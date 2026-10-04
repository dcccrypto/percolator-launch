// @vitest-environment node
/**
 * Runs the real SQL against a real Postgres. Skipped unless one is provided:
 *   docker run --rm -p 55432:5432 -e POSTGRES_PASSWORD=pgtest postgres:16-alpine
 *   CANDLES_TEST_DATABASE_URL=postgres://postgres:pgtest@localhost:55432/postgres pnpm vitest run candle-store.pg
 * or, with no daemon, an in-process Postgres (PGlite) installed outside the repo:
 *   PGLITE_MODULE=/path/to/node_modules/@electric-sql/pglite/dist/index.js pnpm vitest run candle-store.pg
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgCandleStore, type SqlLike } from "@/lib/chart/candle-store";

const URL = process.env.CANDLES_TEST_DATABASE_URL;
const PGLITE = process.env.PGLITE_MODULE;
const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const cd = (t: number, o: number, h = o, l = o, c = o, n = 1) => ({ t, o, h, l, c, n });

describe.skipIf(!URL && !PGLITE)("createPgCandleStore against Postgres", () => {
  let sql: SqlLike & { unsafe(q: string, p?: unknown[]): Promise<Array<Record<string, unknown>>>; end(): Promise<void> };
  let store: ReturnType<typeof createPgCandleStore>;

  beforeAll(async () => {
    if (PGLITE) {
      const mod = (await import(/* @vite-ignore */ PGLITE)) as { PGlite: new () => { query(q: string, p?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>; exec(q: string): Promise<unknown>; close(): Promise<void> } };
      const db = new mod.PGlite();
      // PGlite takes one statement per parameterised query; exec() for multi-statement DDL.
      sql = {
        unsafe: async (q: string, p?: unknown[]) => (p ? (await db.query(q, p)).rows : ((await db.exec(q)) as unknown as Array<Record<string, unknown>>, [])),
        end: async () => db.close(),
      } as unknown as typeof sql;
    } else {
      sql = postgres(URL as string, { prepare: false, max: 2, onnotice: () => {} }) as unknown as typeof sql;
    }
    store = createPgCandleStore(sql);
    const ddl = readFileSync(resolve(__dirname, "../../../../supabase/migrations/20261004000000_chart_candles.sql"), "utf8");
    await sql.unsafe(`DROP TABLE IF EXISTS chart_candles; DROP TABLE IF EXISTS chart_backfill;`);
    await sql.unsafe(ddl);
    await sql.unsafe(ddl); // idempotent: a second run is a no-op
  });
  afterAll(async () => { await sql.end(); });

  it("live merges: open kept, high/low widened, close replaced, n monotone", async () => {
    await store.upsert([{ slab: SLAB, series: "mark", res: 1, candle: cd(60, 10, 12, 9, 11, 5) }]);
    await store.upsert([{ slab: SLAB, series: "mark", res: 1, candle: cd(60, 99, 11, 8, 10, 2) }]);
    const [c] = await store.range(SLAB, "mark", 1, 0, 120, 10);
    expect(c).toMatchObject({ t: 60, o: 10, h: 12, l: 8, c: 10, n: 5, src: "live" });
  });
  it("live replaces gecko; gecko never replaces live", async () => {
    await store.upsert([{ slab: SLAB, series: "oracle", res: 5, candle: cd(300, 1, 2, 0.5, 1.5, 0), src: "gecko" }]);
    await store.upsert([{ slab: SLAB, series: "oracle", res: 5, candle: cd(300, 10, 11, 9, 10.5, 3) }]);
    await store.upsert([{ slab: SLAB, series: "oracle", res: 5, candle: cd(300, 77), src: "gecko" }]);
    expect((await store.range(SLAB, "oracle", 5, 0, 600, 10))[0]).toMatchObject({ o: 10, h: 11, l: 9, c: 10.5, n: 3, src: "live" });
  });
  it("one multi-row upsert with mixed sources", async () => {
    await store.upsert([
      { slab: SLAB, series: "oracle", res: 15, candle: cd(900, 1), src: "gecko" },
      { slab: SLAB, series: "oracle", res: 15, candle: cd(1800, 2) },
    ]);
    expect((await store.range(SLAB, "oracle", 15, 0, 3600, 10)).map((c) => [c.t, c.src])).toEqual([[900, "gecko"], [1800, "live"]]);
  });
  it("before() is newest-first-limited and ascending; newest() returns live rows only", async () => {
    await store.upsert([60, 120, 180, 240].map((t) => ({ slab: SLAB, series: "mark" as const, res: 60 as const, candle: cd(t, t) })));
    expect((await store.before(SLAB, "mark", 60, 240, 2)).map((c) => c.t)).toEqual([120, 180]);
    const newest = await store.newest([SLAB]);
    expect(newest.find((r) => r.series === "oracle" && r.res === 15)!.candle.t).toBe(1800);
    expect(typeof newest[0].candle.t).toBe("number");
  });
  it("rejects a non-positive price at the database", async () => {
    await expect(store.upsert([{ slab: SLAB, series: "mark", res: 1, candle: cd(600, 0) }])).rejects.toThrow();
  });
  it("backfill ledger round-trips and prune honours per-resolution retention", async () => {
    expect(await store.backfilledAt(SLAB, 1)).toBe(0);
    await store.markBackfilled(SLAB, 1, 1_791_000_000_000, 7);
    expect(await store.backfilledAt(SLAB, 1)).toBe(1_791_000_000_000);
    const now = 1_791_000_000_000;
    const old = Math.floor(now / 1000) - 3 * 86_400; // 1m keeps 2 days; the daily keeps forever
    await store.upsert([
      { slab: SLAB, series: "mark", res: 1, candle: cd(old, 1) },
      { slab: SLAB, series: "mark", res: 1440, candle: cd(old - (old % 86_400), 1) },
    ]);
    expect(await store.prune(now)).toBeGreaterThanOrEqual(1);
    expect(await store.range(SLAB, "mark", 1, old, old + 1, 5)).toEqual([]);
    expect((await store.range(SLAB, "mark", 1440, 0, 4e9, 5)).length).toBe(1);
  });
});
