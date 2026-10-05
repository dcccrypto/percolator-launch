// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { MemoryCandleStore, RETENTION_DAYS, createPgCandleStore, type SqlLike } from "@/lib/chart/candle-store";

const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const cd = (t: number, o: number, h = o, l = o, c = o, n = 1) => ({ t, o, h, l, c, n });

describe("MemoryCandleStore (the contract the Postgres store must match)", () => {
  it("a live row replaces a gecko row outright", async () => {
    const s = new MemoryCandleStore();
    await s.upsert([{ slab: SLAB, series: "oracle", res: 1, candle: cd(60, 1, 2, 0.5, 1.5, 0), src: "gecko" }]);
    await s.upsert([{ slab: SLAB, series: "oracle", res: 1, candle: cd(60, 10, 11, 9, 10.5, 3) }]);
    expect(await s.range(SLAB, "oracle", 1, 0, 120, 10)).toEqual([{ ...cd(60, 10, 11, 9, 10.5, 3), src: "live" }]);
  });
  it("a gecko row never overwrites a live row", async () => {
    const s = new MemoryCandleStore();
    await s.upsert([{ slab: SLAB, series: "oracle", res: 1, candle: cd(60, 10) }]);
    await s.upsert([{ slab: SLAB, series: "oracle", res: 1, candle: cd(60, 99), src: "gecko" }]);
    expect((await s.range(SLAB, "oracle", 1, 0, 120, 10))[0].o).toBe(10);
  });
  it("merges live updates: open kept, high/low widened, close replaced", async () => {
    const s = new MemoryCandleStore();
    await s.upsert([{ slab: SLAB, series: "mark", res: 1, candle: cd(60, 10, 12, 9, 11, 5) }]);
    await s.upsert([{ slab: SLAB, series: "mark", res: 1, candle: cd(60, 99, 11, 8, 10, 2) }]);
    expect((await s.range(SLAB, "mark", 1, 0, 120, 10))[0]).toMatchObject({ o: 10, h: 12, l: 8, c: 10, n: 5 });
  });
  it("before() returns the newest N strictly before t, ascending", async () => {
    const s = new MemoryCandleStore();
    await s.upsert([60, 120, 180, 240].map((t) => ({ slab: SLAB, series: "mark" as const, res: 1 as const, candle: cd(t, t) })));
    expect((await s.before(SLAB, "mark", 1, 240, 2)).map((c) => c.t)).toEqual([120, 180]);
  });
  it("newest() seeds only from live rows", async () => {
    const s = new MemoryCandleStore();
    await s.upsert([{ slab: SLAB, series: "oracle", res: 1, candle: cd(60, 1), src: "gecko" }]);
    expect(await s.newest([SLAB])).toEqual([]);
    await s.upsert([{ slab: SLAB, series: "oracle", res: 1, candle: cd(120, 2) }]);
    expect((await s.newest([SLAB]))[0].candle.t).toBe(120);
  });
});

describe("MemoryCandleStore chain source", () => {
  it("merge rules match the SQL (chain-live straddle both orders, chain idempotent, gecko loses)", async () => {
    const s = new MemoryCandleStore();
    await s.upsert([{ slab: SLAB, series: "mark", res: 15, candle: cd(900, 10, 12, 9, 11, 5), src: "chain" }, { slab: SLAB, series: "mark", res: 15, candle: cd(900, 50, 60, 40, 55, 3) }]);
    expect((await s.range(SLAB, "mark", 15, 0, 4e9, 5))[0]).toMatchObject({ src: "live", o: 10, h: 60, l: 9, c: 55, n: 8 });
    await s.upsert([{ slab: SLAB, series: "mark", res: 15, candle: cd(1800, 50, 60, 40, 55, 3) }, { slab: SLAB, series: "mark", res: 15, candle: cd(1800, 10, 12, 9, 11, 5), src: "chain" }]);
    expect((await s.range(SLAB, "mark", 15, 1800, 1801, 5))[0]).toMatchObject({ src: "live", o: 10, h: 60, l: 9, c: 55, n: 8 });
    await s.upsert([{ slab: SLAB, series: "mark", res: 5, candle: cd(300, 1, 9, 1, 5, 2), src: "chain" }, { slab: SLAB, series: "mark", res: 5, candle: cd(300, 2, 3, 2, 2.5, 2), src: "chain" }, { slab: SLAB, series: "mark", res: 5, candle: cd(300, 99), src: "gecko" }]);
    expect((await s.range(SLAB, "mark", 5, 300, 301, 5))[0]).toMatchObject({ o: 2, h: 3, src: "chain" });
  });
  it("firstLiveT looks at live 1m candles only", async () => {
    const s = new MemoryCandleStore();
    await s.upsert([{ slab: SLAB, series: "mark", res: 1, candle: cd(60, 1), src: "chain" }, { slab: SLAB, series: "mark", res: 1440, candle: cd(0, 1) }]);
    expect(await s.firstLiveT(SLAB, "mark")).toBeNull();
    await s.upsert([{ slab: SLAB, series: "mark", res: 1, candle: cd(600, 1) }]);
    expect(await s.firstLiveT(SLAB, "mark")).toBe(600);
  });
});

describe("createPgCandleStore SQL shape", () => {
  function fake() {
    const unsafe = vi.fn(async (_q: string, _p?: unknown[]) => [] as Array<Record<string, unknown>>);
    const sql = Object.assign(vi.fn(), { unsafe }) as unknown as SqlLike;
    return { store: createPgCandleStore(sql), unsafe };
  }
  it("upserts all rows in ONE statement with parameters (never string-built values)", async () => {
    const { store, unsafe } = fake();
    await store.upsert([
      { slab: SLAB, series: "mark", res: 1, candle: cd(60, 1) },
      { slab: SLAB, series: "oracle", res: 5, candle: cd(300, 2), src: "gecko" },
    ]);
    expect(unsafe).toHaveBeenCalledTimes(1);
    const [q, p] = unsafe.mock.calls[0] as [string, unknown[]];
    expect(q).toContain("ON CONFLICT (slab, series, res, t) DO UPDATE");
    expect(q).toContain("WHERE NOT (excluded.src = 'gecko' AND chart_candles.src <> 'gecko')");
    expect(q).not.toContain(SLAB);
    expect(p).toHaveLength(2 * 9 + 2);
    expect(p.slice(-2)).toEqual(["live", "gecko"]);
  });
  it("splits a big batch into statements of at most PG_UPSERT_CHUNK rows (parameter limit); a small batch stays one", async () => {
    const { store, unsafe } = fake();
    const rows = Array.from({ length: 2500 }, (_, i) => ({ slab: SLAB, series: "mark" as const, res: 1 as const, candle: cd(60 * (i + 1), 1) }));
    await store.upsert(rows);
    expect(unsafe).toHaveBeenCalledTimes(3);
    for (const c of unsafe.mock.calls) expect((c[1] as unknown[]).length).toBeLessThan(65_535);
    expect(Math.max(...unsafe.mock.calls.map((c) => (c[1] as unknown[]).length))).toBe(1000 * 10);
    unsafe.mockClear();
    await store.upsert(rows.slice(0, 1000));
    expect(unsafe).toHaveBeenCalledTimes(1);
  });
  it("does nothing for an empty batch", async () => {
    const { store, unsafe } = fake();
    await store.upsert([]);
    expect(unsafe).not.toHaveBeenCalled();
  });
  it("before() asks for newest-first and returns ascending numbers", async () => {
    const { store, unsafe } = fake();
    unsafe.mockResolvedValueOnce([
      { t: "180", o: 3, h: 3, l: 3, c: 3, n: 1, src: "live" },
      { t: "120", o: 2, h: 2, l: 2, c: 2, n: 1, src: "gecko" },
    ]);
    const out = await store.before(SLAB, "mark", 1, 240, 2);
    expect(unsafe.mock.calls[0][0]).toContain("ORDER BY t DESC LIMIT $5");
    expect(out.map((c) => c.t)).toEqual([120, 180]);
    expect(typeof out[0].t).toBe("number");
  });
  it("prunes each finite-retention resolution by its own cutoff and never the daily", async () => {
    const { store, unsafe } = fake();
    const now = 1_791_000_000_000;
    unsafe.mockResolvedValue([{ "?column?": 1 }]);
    await store.prune(now);
    const finite = Object.values(RETENTION_DAYS).filter((d) => d !== null);
    expect(unsafe).toHaveBeenCalledTimes(finite.length);
    expect(unsafe.mock.calls.map((c) => (c[1] as number[])[0])).not.toContain(1440);
    const oneMin = unsafe.mock.calls.find((c) => (c[1] as number[])[0] === 1)!;
    expect((oneMin[1] as number[])[1]).toBe(Math.floor(now / 1000) - 2 * 86_400);
  });
});
