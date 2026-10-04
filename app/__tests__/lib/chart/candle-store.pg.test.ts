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
    const dir = resolve(__dirname, "../../../../supabase/migrations");
    const ddl = readFileSync(resolve(dir, "20261004000000_chart_candles.sql"), "utf8");
    const ddl2 = readFileSync(resolve(dir, "20261004000100_chart_candles_chain.sql"), "utf8");
    await sql.unsafe(`DROP TABLE IF EXISTS chart_candles; DROP TABLE IF EXISTS chart_backfill; DROP TABLE IF EXISTS chart_chain_backfill;`);
    await sql.unsafe(ddl);
    await sql.unsafe(ddl);  // idempotent: a second run is a no-op
    await sql.unsafe(ddl2);
    await sql.unsafe(ddl2);
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

  describe("backfill claim and negative cache", () => {
    const S9 = "Ev5DZC5FGav5ZptzoAQqkn4JbYyRk3e7nXKTRznfzd6d";
    const T = 1_791_000_000_000;
    it("claims are atomic: the second claimant loses until the hold expires, then wins", async () => {
      expect(await store.claimBackfill(S9, 1, T, 60_000)).toBe(true);
      expect(await store.claimBackfill(S9, 1, T + 1_000, 60_000)).toBe(false);
      expect(await store.claimBackfill(S9, 1, T + 61_000, 60_000)).toBe(true);
    });
    it("a different resolution is an independent claim", async () => {
      expect(await store.claimBackfill(S9, 5, T, 60_000)).toBe(true);
    });
    it("backoff blocks claims until it ends; a successful pull clears it", async () => {
      await store.backoffBackfill(S9, 15, T + 600_000);
      expect(await store.claimBackfill(S9, 15, T + 1_000, 60_000)).toBe(false);
      expect(await store.claimBackfill(S9, 15, T + 600_001, 60_000)).toBe(true);
      await store.backoffBackfill(S9, 60, T + 600_000);
      await store.markBackfilled(S9, 60, T, 5);
      expect(await store.claimBackfill(S9, 60, T + 1_000, 60_000)).toBe(true);
      expect(await store.backfilledAt(S9, 60)).toBe(T);
    });
  });

  describe("chain source (one-time mark backfill)", () => {
    const S2 = "6Y4bfYLWrhabgzU4p3onx9CeW1jCKjGjjSCaoCHf2Q9R";
    const row = async (res: 1 | 5 | 15, t: number) => (await store.range(S2, "mark", res, t, t + 1, 1))[0];
    it("accepts src='chain' at the database (negative control: junk is still rejected)", async () => {
      await store.upsert([{ slab: S2, series: "mark", res: 1, candle: cd(60, 1, 2, 0.5, 1.5, 3), src: "chain" }]);
      expect(await row(1, 60)).toMatchObject({ src: "chain", o: 1, h: 2 });
      await expect(sql.unsafe(`INSERT INTO chart_candles (slab,series,res,t,o,h,l,c,src) VALUES ('x','mark',1,1,1,1,1,1,'bogus')`)).rejects.toThrow();
    });
    it("a chain re-run replaces the previous chain row outright (idempotent)", async () => {
      await store.upsert([{ slab: S2, series: "mark", res: 1, candle: cd(120, 1, 9, 1, 5, 4), src: "chain" }]);
      await store.upsert([{ slab: S2, series: "mark", res: 1, candle: cd(120, 2, 3, 2, 2.5, 4), src: "chain" }]);
      expect(await row(1, 120)).toMatchObject({ o: 2, h: 3, l: 2, c: 2.5, src: "chain" });
    });
    it("chain replaces gecko; gecko never overwrites chain", async () => {
      await store.upsert([{ slab: S2, series: "mark", res: 5, candle: cd(300, 7), src: "gecko" }]);
      await store.upsert([{ slab: S2, series: "mark", res: 5, candle: cd(300, 8, 9, 7, 8.5, 2), src: "chain" }]);
      expect(await row(5, 300)).toMatchObject({ o: 8, src: "chain" });
      await store.upsert([{ slab: S2, series: "mark", res: 5, candle: cd(300, 99), src: "gecko" }]);
      expect((await row(5, 300)).o).toBe(8);
    });
    it("the straddling bucket merges: chain-then-live and live-then-chain give the same candle", async () => {
      const chain = cd(900, 10, 12, 9, 11, 5);
      const live = cd(900, 50, 60, 40, 55, 3);
      await store.upsert([{ slab: S2, series: "mark", res: 15, candle: chain, src: "chain" }]);
      await store.upsert([{ slab: S2, series: "mark", res: 15, candle: live }]);
      const a = await row(15, 900);
      expect(a).toMatchObject({ src: "live", o: 10, h: 60, l: 9, c: 55, n: 8 });
      await store.upsert([{ slab: S2, series: "mark", res: 15, candle: cd(1800, 50, 60, 40, 55, 3) }]);
      await store.upsert([{ slab: S2, series: "mark", res: 15, candle: cd(1800, 10, 12, 9, 11, 5), src: "chain" }]);
      expect(await row(15, 1800)).toMatchObject({ src: "live", o: 10, h: 60, l: 9, c: 55, n: 8 });
    });
    it("firstLiveT is the earliest LIVE 1m candle only (not chain, not coarser buckets)", async () => {
      const S3 = "4EGvEGdLY2i9JeApJ8cEjkFehuSXpzfo11BBJarB7MTw";
      expect(await store.firstLiveT(S3, "mark")).toBeNull();
      await store.upsert([{ slab: S3, series: "mark", res: 1, candle: cd(60, 1), src: "chain" }, { slab: S3, series: "mark", res: 1440, candle: cd(0, 1) }]);
      expect(await store.firstLiveT(S3, "mark")).toBeNull();
      await store.upsert([{ slab: S3, series: "mark", res: 1, candle: cd(600, 1) }, { slab: S3, series: "mark", res: 1, candle: cd(660, 1) }]);
      expect(await store.firstLiveT(S3, "mark")).toBe(600);
    });
  });
});
