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
});
