// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createPerpProvider, parsePerpHistory, sourceForSeries } from "@/lib/tv/data/perpProvider";
import { createSeriesStore, SERIES_STORAGE_KEY } from "@/lib/chart/perp-series";
import type { LiveClient, LiveHandlers } from "@/lib/chart/live-client";
import type { BarsRequest, ChartDataProvider, LiveHandlers as BarHandlers, ProviderBar } from "@/lib/tv/data/provider";
import type { TickMessage } from "@/lib/chart/perp-types";
import { REPLAY_WINDOW_MS } from "@/lib/chart/tick-hub";

const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);
const req = (over: Partial<BarsRequest> = {}): BarsRequest => ({ slab: SLAB, resolution: "1", fromSec: T0 / 1000 - 3600, toSec: T0 / 1000, countBack: 300, firstRequest: true, ...over });
const tick = (seq: number, mark: number | null, oracle: number | null, landedMs: number): TickMessage =>
  ({ type: "tick", slab: SLAB, epoch: "e", seq, slot: seq, landedMs, recvMs: landedMs, mark, oracle });

function base(over: Partial<ChartDataProvider> = {}): ChartDataProvider {
  return {
    id: "base",
    resolveSymbol: async (slab) => ({ slab, symbol: "SOL", description: "SOL perp", referencePrice: 100, hasVolume: true }),
    getBars: async () => ({ bars: [], noMoreHistory: true, source: "oracle" }),
    subscribeBars: () => () => {},
    searchSymbols: async () => [],
    ...over,
  };
}
function liveFake() {
  let h: LiveHandlers | null = null;
  const live: LiveClient = { subscribe: (_s, handlers) => { h = handlers; return () => { h = null; }; } };
  return { live, handlers: () => h as LiveHandlers };
}
const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe("parsePerpHistory", () => {
  it("maps t/o/h/l/c to bars, sorts, drops junk, passes the proxy marker", () => {
    const r = parsePerpHistory({ bars: [{ t: 120, o: 2, h: 2, l: 2, c: 2 }, { t: 60, o: 1, h: 1, l: 1, c: 1 }, { t: 180, o: 0, h: 1, l: 1, c: 1 }, null], proxyBeforeSec: 120, proxyFromSec: 60, noMoreHistory: true });
    expect(r.bars.map((b) => b.timeSec)).toEqual([60, 120]);
    expect(r.proxyBeforeSec).toBe(120);
    expect(r.proxyFromSec).toBe(60);
    expect(r.noMoreHistory).toBe(true);
    expect(() => parsePerpHistory(null)).toThrow();
  });
});

describe("dex attribution marker", () => {
  it("parsePerpHistory reports the newest GeckoTerminal-sourced bar, null when there is none (negative control)", () => {
    const withDex = parsePerpHistory({ bars: [{ t: 60, o: 1, h: 1, l: 1, c: 1, src: "dex" }, { t: 120, o: 1, h: 1, l: 1, c: 1, src: "dex" }, { t: 180, o: 2, h: 2, l: 2, c: 2, src: "chain" }, { t: 240, o: 2, h: 2, l: 2, c: 2, src: "live" }] });
    expect(withDex.dexThroughSec).toBe(120);
    expect(parsePerpHistory({ bars: [{ t: 1, o: 1, h: 1, l: 1, c: 1, src: "live" }] }).dexThroughSec).toBeNull();
    expect(parsePerpHistory({ bars: [] }).dexThroughSec).toBeNull();
  });
  it("getBars passes it through to the chart", async () => {
    const fetchImpl = vi.fn(async () => json({ bars: [{ t: 60, o: 1, h: 1, l: 1, c: 1, src: "dex" }], noMoreHistory: true }));
    const p = createPerpProvider({ base: base(), live: liveFake().live, fetchImpl, series: createSeriesStore(null) });
    expect((await p.getBars(req())).dexThroughSec).toBe(60);
  });
});

describe("perp provider history", () => {
  it("asks the perp-chart route for the CURRENT series and tags the source", async () => {
    const store = createSeriesStore(null);
    const fetchImpl = vi.fn(async () => json({ s: "ok", bars: [{ t: 60, o: 1, h: 1, l: 1, c: 1 }], noMoreHistory: false }));
    const p = createPerpProvider({ base: base(), live: liveFake().live, fetchImpl, series: store });
    const mark = await p.getBars(req());
    expect(fetchImpl.mock.calls[0][0]).toContain("series=mark");
    expect(mark.source).toBe("perp-mark");
    store.set("oracle");
    const oracle = await p.getBars(req());
    expect(fetchImpl.mock.calls[1][0]).toContain("series=oracle");
    expect(oracle.source).toBe("perp-oracle");
  });
  it("a missing store (503/404) is an honest empty chart; ANY other failure (first request or not) is an error the chart surfaces", async () => {
    const mk = (f: () => Promise<ReturnType<typeof json>>) => createPerpProvider({ base: base(), live: liveFake().live, fetchImpl: f, series: createSeriesStore(null) });
    expect((await mk(async () => json({}, 503)).getBars(req())).bars).toEqual([]);
    expect((await mk(async () => json({}, 404)).getBars(req())).source).toBe("perp-mark");
    // a 502/504 (history route timed out) and a network failure must NOT degrade to an empty page: that is a blank canvas
    await expect(mk(async () => json({}, 504)).getBars(req())).rejects.toThrow("504");
    await expect(mk(async () => json({}, 502)).getBars(req({ firstRequest: false }))).rejects.toThrow("502");
    await expect(mk(async () => { throw new Error("net"); }).getBars(req())).rejects.toThrow("net");
    await expect(mk(async () => { throw new Error("net"); }).getBars(req({ firstRequest: false }))).rejects.toThrow();
  });
  it("last-trade series uses the base provider; no trades is an honest empty chart", async () => {
    const store = createSeriesStore(null);
    store.set("last");
    const getBars = vi.fn(async () => ({ bars: [], noMoreHistory: false, source: "oracle" as const }));
    const p = createPerpProvider({ base: base({ getBars }), live: liveFake().live, fetchImpl: vi.fn(), series: store });
    expect(await p.getBars(req())).toEqual({ bars: [], noMoreHistory: true, source: "percolator" });
    expect(getBars).toHaveBeenCalled();
  });
  it("only the Last series has volume", async () => {
    const store = createSeriesStore(null);
    const p = createPerpProvider({ base: base(), live: liveFake().live, fetchImpl: vi.fn(), series: store });
    expect((await p.resolveSymbol(SLAB)).hasVolume).toBe(false);
    store.set("last");
    expect((await p.resolveSymbol(SLAB)).hasVolume).toBe(true);
  });
  it("maps series to source badges", () => {
    expect([sourceForSeries("mark"), sourceForSeries("oracle"), sourceForSeries("last")]).toEqual(["perp-mark", "perp-oracle", "percolator"]);
  });
});

describe("perp provider live", () => {
  function sub(seriesName: "mark" | "oracle" | "last", lastBar: ProviderBar | null = null, now = () => T0) {
    const store = createSeriesStore(null);
    store.set(seriesName);
    const lf = liveFake();
    const bars: ProviderBar[] = [];
    const onReset = vi.fn();
    const p = createPerpProvider({ base: base(), live: lf.live, fetchImpl: vi.fn(), series: store, now });
    const off = p.subscribeBars(SLAB, "1", { onBar: (b) => bars.push(b), onReset } as BarHandlers, lastBar, sourceForSeries(seriesName));
    return { lf, bars, onReset, store, off };
  }
  it("folds mark ticks into the forming candle and opens a new minute at the previous close", () => {
    const { lf, bars } = sub("mark");
    lf.handlers().onTick(tick(1, 100, 90, T0 + 1_000));
    lf.handlers().onTick(tick(2, 103, 91, T0 + 2_500));
    lf.handlers().onTick(tick(3, 98, 92, T0 + 61_000));
    expect(bars[1]).toMatchObject({ timeSec: T0 / 1000, open: 100, high: 103, low: 100, close: 103 });
    expect(bars[2]).toMatchObject({ timeSec: T0 / 1000 + 60, open: 103, high: 103, low: 98, close: 98 });
  });
  it("the oracle series follows the oracle field, the mark series ignores it", () => {
    const o = sub("oracle");
    o.lf.handlers().onTick(tick(1, 100, 90, T0 + 1_000));
    expect(o.bars[0].close).toBe(90);
    const m = sub("mark");
    m.lf.handlers().onTick(tick(1, 100, null, T0 + 1_000));
    expect(m.bars[0].close).toBe(100);
    const none = sub("oracle");
    none.lf.handlers().onTick(tick(1, 100, null, T0 + 1_000));
    expect(none.bars).toEqual([]);
  });
  it("continues from the last history bar instead of restarting the candle", () => {
    const last: ProviderBar = { timeSec: T0 / 1000, open: 100, high: 110, low: 95, close: 105, volume: 0 };
    const { lf, bars } = sub("mark", last);
    lf.handlers().onTick(tick(1, 120, 120, T0 + 5_000));
    expect(bars[0]).toMatchObject({ open: 100, high: 120, low: 95, close: 120 });
  });
  it("ignores a tick older than the forming candle (never rewrites a closed bar)", () => {
    const last: ProviderBar = { timeSec: T0 / 1000 + 60, open: 1, high: 1, low: 1, close: 1, volume: 0 };
    const { lf, bars } = sub("mark", last);
    lf.handlers().onTick(tick(1, 5, 5, T0 + 1_000));
    expect(bars).toEqual([]);
  });
  it("last-trade series folds trades with volume and ignores mark ticks", () => {
    const { lf, bars } = sub("last");
    lf.handlers().onTick(tick(1, 100, 100, T0 + 1_000));
    expect(bars).toEqual([]);
    lf.handlers().onTrade!({ type: "trade", slab: SLAB, id: "1", price: 7, size: 2, side: "long", ts: T0 + 1_000 });
    lf.handlers().onTrade!({ type: "trade", slab: SLAB, id: "2", price: 8, size: 3, side: "short", ts: T0 + 2_000 });
    expect(bars[1]).toMatchObject({ open: 7, high: 8, close: 8, volume: 5 });
  });
  it("flipping the series asks the chart to reload; unsubscribing stops everything", () => {
    const { store, onReset, off, lf } = sub("mark");
    store.set("oracle");
    expect(onReset).toHaveBeenCalledTimes(1);
    off();
    store.set("mark");
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(lf.handlers()).toBeNull();
  });
  it("a reconnect resets the chart only when the outage outlived the replay buffer", () => {
    let t = T0;
    const { lf, onReset } = sub("mark", null, () => t);
    lf.handlers().onTick(tick(1, 100, 100, T0));
    t = T0 + 60_000;
    lf.handlers().onReconnect!();
    expect(onReset).not.toHaveBeenCalled();
    t = T0 + REPLAY_WINDOW_MS + 1;
    lf.handlers().onReconnect!();
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

describe("series store", () => {
  it("defaults to Mark, persists, and survives a throwing storage", () => {
    const mem: Record<string, string> = {};
    const storage = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; } };
    const s = createSeriesStore(storage);
    expect(s.get()).toBe("mark");
    s.set("oracle");
    expect(mem[SERIES_STORAGE_KEY]).toBe("oracle");
    expect(createSeriesStore(storage).get()).toBe("oracle");
    const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const b = createSeriesStore(bad);
    expect(b.get()).toBe("mark");
    expect(() => b.set("last")).not.toThrow();
    expect(b.get()).toBe("last");
  });
  it("ignores a stored junk value and notifies only on a real change", () => {
    const s = createSeriesStore({ getItem: () => "nonsense", setItem: () => {} });
    expect(s.get()).toBe("mark");
    const fn = vi.fn();
    s.subscribe(fn);
    s.set("mark");
    s.set("last");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
