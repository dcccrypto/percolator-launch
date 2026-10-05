// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { MemoryCandleStore } from "@/lib/chart/candle-store";
import { loadHistory } from "@/lib/chart/history";

const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const cd = (t: number, p: number) => ({ t, o: p, h: p, l: p, c: p, n: 1 });
const none = async () => ({ status: "fresh" as const, bars: 0 });

describe("loadHistory", () => {
  it("returns own bars only when there are enough, without touching the backfill", async () => {
    const store = new MemoryCandleStore();
    await store.upsert([60, 120, 180].map((t) => ({ slab: SLAB, series: "mark" as const, res: 1 as const, candle: cd(t, 1) })));
    const backfill = vi.fn(none);
    const h = await loadHistory(SLAB, "mark", 1, 1000, 3, { store, backfill });
    expect(h.bars.map((b) => b.t)).toEqual([60, 120, 180]);
    expect(h.proxyBeforeSec).toBeNull();
    expect(backfill).not.toHaveBeenCalled();
  });
  it("mark history older than the first mark is filled from the oracle series and flagged", async () => {
    const store = new MemoryCandleStore();
    await store.upsert([
      { slab: SLAB, series: "oracle", res: 1, candle: cd(60, 5), src: "gecko" },
      { slab: SLAB, series: "oracle", res: 1, candle: cd(120, 6), src: "gecko" },
      { slab: SLAB, series: "mark", res: 1, candle: cd(180, 7) },
    ]);
    const h = await loadHistory(SLAB, "mark", 1, 1000, 3, { store, backfill: none });
    expect(h.bars.map((b) => [b.t, b.src])).toEqual([[60, "dex"], [120, "dex"], [180, "live"]]);
    expect(h.proxyBeforeSec).toBe(180);
  });
  it("pulls the backfill when history is short, then re-reads", async () => {
    const store = new MemoryCandleStore();
    const backfill = vi.fn(async () => {
      await store.upsert([60, 120].map((t) => ({ slab: SLAB, series: "oracle" as const, res: 1 as const, candle: cd(t, 1), src: "gecko" as const })));
      return { status: "pulled" as const, bars: 2 };
    });
    const h = await loadHistory(SLAB, "oracle", 1, 1000, 10, { store, backfill });
    expect(h.bars).toHaveLength(2);
    expect(h.noMoreHistory).toBe(true);
    expect(backfill).toHaveBeenCalledTimes(1);
  });
  it("a rate-limited backfill must not claim there is no more history", async () => {
    const store = new MemoryCandleStore();
    const h = await loadHistory(SLAB, "oracle", 1, 1000, 10, { store, backfill: async () => ({ status: "rate-limited", bars: 0 }) });
    expect(h.bars).toEqual([]);
    expect(h.noMoreHistory).toBe(false);
  });
  it("does not hold the response past the backfill budget", async () => {
    const store = new MemoryCandleStore();
    const never = () => new Promise<never>(() => {});
    const t0 = Date.now();
    const h = await loadHistory(SLAB, "oracle", 1, 1000, 10, { store, backfill: never, backfillBudgetMs: 30 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(h.bars).toEqual([]);
    expect(h.noMoreHistory).toBe(false);
  });

  describe("gap between the pre-live mark and the live feed (CHILLHOUSE 2026-10-05)", () => {
    const M = 900; // 15m
    const T0 = 1_000 * M;
    const up = (store: MemoryCandleStore, series: "mark" | "oracle", res: 1 | 5 | 15 | 60 | 240, ts: number[], src: "live" | "chain" | "gecko", px: number) =>
      store.upsert(ts.map((t) => ({ slab: SLAB, series, res, candle: cd(t, px), src })));
    const range = (from: number, n: number, step = M) => Array.from({ length: n }, (_, i) => from + i * step);

    it("fills every bucket with no mark from the oracle, flags those bars, and leaves real marks alone", async () => {
      const store = new MemoryCandleStore();
      await up(store, "oracle", 15, range(T0, 40), "gecko", 1); // pool history across the whole window
      await up(store, "mark", 15, range(T0 + 5 * M, 5), "chain", 2); // chain backfill covers 5..9 so far
      await up(store, "mark", 15, range(T0 + 30 * M, 10), "live", 3); // live starts at 30
      const h = await loadHistory(SLAB, "mark", 15, T0 + 40 * M, 40, { store, backfill: none });
      expect(h.bars.map((b) => b.t)).toEqual(range(T0, 40)); // continuous: no hole between 10 and 30
      const kind = (t: number) => h.bars.find((b) => b.t === t)!;
      expect(kind(T0 + 7 * M)).toMatchObject({ c: 2, src: "chain" });
      expect(kind(T0 + 7 * M).proxy).toBeUndefined();
      expect(kind(T0 + 20 * M)).toMatchObject({ c: 1, src: "dex", proxy: true });
      expect(kind(T0 + 35 * M)).toMatchObject({ c: 3, src: "live" });
      expect(h.proxyFromSec).toBe(T0);
      expect(h.proxyBeforeSec).toBe(T0 + 30 * M); // end of the newest stand-in bar
    });

    it("the gap closes by itself as the chain backfill writes marks into it", async () => {
      const store = new MemoryCandleStore();
      await up(store, "oracle", 15, range(T0, 20), "gecko", 1);
      await up(store, "mark", 15, range(T0 + 15 * M, 5), "live", 3);
      const before = await loadHistory(SLAB, "mark", 15, T0 + 20 * M, 20, { store, backfill: none });
      expect(before.bars.filter((b) => b.proxy)).toHaveLength(15);
      await up(store, "mark", 15, range(T0, 15), "chain", 2); // the running backfill reaches the gap
      const after = await loadHistory(SLAB, "mark", 15, T0 + 20 * M, 20, { store, backfill: none });
      expect(after.bars.filter((b) => b.proxy)).toHaveLength(0);
      expect(after.proxyBeforeSec).toBeNull();
      expect(after.bars.map((b) => b.src)).toEqual([...Array(15).fill("chain"), ...Array(5).fill("live")]);
    });

    it("rolls missing 4h bars up from 1h (Gecko was only pulled at 1h) so 4h is continuous too", async () => {
      const H = 3600, F = 14_400, base = 5_000 * F;
      const store = new MemoryCandleStore();
      const oracle1h = range(base, 24, H);
      await store.upsert(oracle1h.map((t, i) => ({ slab: SLAB, series: "oracle" as const, res: 60 as const, candle: { t, o: 10 + i, h: 20 + i, l: 1 + i, c: 11 + i, n: 1 }, src: "gecko" as const })));
      await up(store, "mark", 240, [base + 4 * F, base + 5 * F], "live", 7);
      const h = await loadHistory(SLAB, "mark", 240, base + 6 * F, 6, { store, backfill: none });
      expect(h.bars.map((b) => b.t)).toEqual(range(base, 6, F));
      const first = h.bars[0];
      expect(first).toMatchObject({ o: 10, h: 23, l: 1, c: 14, src: "dex", proxy: true, derived: true }); // 4 hourly bars rolled up
      expect(h.bars[4]).toMatchObject({ c: 7, src: "live" });
      expect(h.bars[4].proxy).toBeUndefined();
    });

    it("a stored bar at the requested resolution is never replaced by a rolled-up one", async () => {
      const F = 14_400, base = 5_000 * F;
      const store = new MemoryCandleStore();
      await up(store, "oracle", 240, [base], "gecko", 5);
      await up(store, "oracle", 60, range(base, 4, 3600), "gecko", 9);
      const h = await loadHistory(SLAB, "oracle", 240, base + F, 1, { store, backfill: none });
      expect(h.bars).toHaveLength(1);
      expect(h.bars[0].c).toBe(5);
      expect(h.bars[0].derived).toBeUndefined();
    });

    it("does not read the oracle (or call the backfill) when the marks are already complete", async () => {
      const store = new MemoryCandleStore();
      await up(store, "mark", 15, range(T0, 10), "live", 3);
      const spy = vi.spyOn(store, "before");
      const backfill = vi.fn(none);
      const h = await loadHistory(SLAB, "mark", 15, T0 + 10 * M, 10, { store, backfill });
      expect(h.bars.every((b) => !b.proxy)).toBe(true);
      expect(backfill).not.toHaveBeenCalled();
      expect(spy.mock.calls.filter((c) => c[1] === "oracle")).toHaveLength(0);
    });

    it("pages back past a hole instead of stopping at it", async () => {
      const store = new MemoryCandleStore();
      await up(store, "oracle", 15, [...range(T0, 5), ...range(T0 + 400 * M, 5)], "gecko", 1); // 395-bucket hole
      const h = await loadHistory(SLAB, "oracle", 15, T0 + 405 * M, 8, { store, backfill: none });
      expect(h.bars.map((b) => b.t)).toEqual([...range(T0 + 2 * M, 3), ...range(T0 + 400 * M, 5)]);
    });

    it("carries a short no-trade Gecko hole forward as flat bars (flagged), but never a long one or a hole after a real bar", async () => {
      const store = new MemoryCandleStore();
      // pool bars at 0,1 then 4 (2-bucket hole), then 9 (4 buckets: still short), then a 200-bucket hole, then 210
      await up(store, "oracle", 15, [0, 1, 4, 9, 210].map((i) => T0 + i * M), "gecko", 1);
      await up(store, "mark", 15, [T0 + 214 * M, T0 + 216 * M], "live", 3); // hole 211..213 follows a dex bar; 215 follows a live bar
      const h = await loadHistory(SLAB, "mark", 15, T0 + 217 * M, 300, { store, backfill: none });
      const ts = h.bars.map((b) => (b.t - T0) / M);
      expect(ts).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 210, 211, 212, 213, 214, 216]);
      expect(h.bars.find((b) => b.t === T0 + 2 * M)).toMatchObject({ flat: true, proxy: true, src: "dex", o: 1, c: 1 });
      expect(h.bars.find((b) => b.t === T0 + 1 * M)!.flat).toBeUndefined();
    });

    it("flat carry-forward on the oracle series itself is not flagged as a proxy", async () => {
      const store = new MemoryCandleStore();
      await up(store, "oracle", 15, [0, 3].map((i) => T0 + i * M), "gecko", 1);
      const h = await loadHistory(SLAB, "oracle", 15, T0 + 4 * M, 2, { store, backfill: none });
      expect(h.bars.map((b) => b.t)).toEqual([T0 + 2 * M, T0 + 3 * M]);
      expect(h.bars[0]).toMatchObject({ flat: true, src: "dex" });
      expect(h.bars[0].proxy).toBeUndefined();
    });

    it("database reads per request stay small however many holes there are (#3132 made ~460 sequential reads and timed the route out)", async () => {
      const store = new MemoryCandleStore();
      // 100 isolated one-bucket holes in the mark series, finer data present, oracle sparse too
      const idx = (n: number) => Array.from({ length: n }, (_, i) => i);
      const marks = idx(300).filter((i) => i % 3 !== 0);
      await up(store, "mark", 15, marks.map((i) => T0 + i * M), "chain", 2);
      await up(store, "oracle", 15, idx(300).filter((i) => i % 7 !== 0).map((i) => T0 + i * M), "gecko", 1);
      await up(store, "oracle", 5, idx(900).map((i) => T0 + i * 300), "gecko", 1);
      let reads = 0;
      const wrap = <K extends "before" | "range">(k: K) => { const orig = store[k].bind(store) as (...a: unknown[]) => Promise<unknown>; (store as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => { reads++; return orig(...a); }; };
      wrap("before"); wrap("range");
      const h = await loadHistory(SLAB, "mark", 15, T0 + 300 * M, 300, { store, backfill: none });
      expect(h.bars.length).toBe(300);
      expect(reads).toBeLessThanOrEqual(12);
    });
  });
});
