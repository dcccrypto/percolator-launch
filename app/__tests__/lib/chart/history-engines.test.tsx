/**
 * #3132 regression: the merged history (stored + oracle stand-in + rolled-up + flat bars) must be
 * data BOTH chart engines accept. lightweight-charts and TradingView THROW on duplicate / unsorted /
 * non-finite bars, and one throw blanks the whole chart. These tests push the real loadHistory output
 * through the real provider and datafeed into engine fakes that apply the engines' own assertions.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCandleStore } from "@/lib/chart/candle-store";
import { loadHistory, sanitizeBars, type HistoryBar } from "@/lib/chart/history";
import { createPerpProvider } from "@/lib/tv/data/perpProvider";
import { createSeriesStore } from "@/lib/chart/perp-series";
import { createTvDatafeed } from "@/lib/tv/datafeed";
import type { CandleResMinutes } from "@/lib/chart/perp-types";
import type { ChartDataProvider, ProviderBar } from "@/lib/tv/data/provider";

const SLAB = "Ar6khqrJVfPDx1KGmSP6Q4hxre6NNm66GpDJPHG1oF6N";
const none = async () => ({ status: "fresh" as const, bars: 0 });
const cd = (t: number, p: number, spread = 0) => ({ t, o: p, h: p + spread, l: p - spread, c: p, n: 1 });

/** The engines' own data contract (lightweight-charts: "data must be asc ordered by time", positive finite OHLC). */
function assertChartable(bars: ReadonlyArray<{ t: number; o: number; h: number; l: number; c: number }>): void {
  let prev = -Infinity;
  for (const b of bars) {
    if (!Number.isInteger(b.t) || b.t > 1e11) throw new Error(`time must be integer seconds, got ${b.t}`);
    if (!(b.t > prev)) throw new Error(`data must be asc ordered by time (dup/unsorted at ${b.t})`);
    prev = b.t;
    for (const v of [b.o, b.h, b.l, b.c]) if (!Number.isFinite(v) || v <= 0) throw new Error(`non-finite/non-positive price at ${b.t}`);
    if (b.h < Math.max(b.o, b.c) || b.l > Math.min(b.o, b.c)) throw new Error(`h/l do not contain o/c at ${b.t}`);
  }
}

/** A market shaped like LINK / CHILLHOUSE: gecko pool history with no-trade holes, a chain run, a live tail, only some resolutions stored. */
async function scenario(res: CandleResMinutes) {
  const step = res * 60;
  const T0 = Math.floor(Date.UTC(2026, 9, 1) / 1000 / step) * step;
  const store = new MemoryCandleStore();
  const at = (i: number) => T0 + i * step;
  const range = (a: number, n: number) => Array.from({ length: n }, (_, i) => at(a + i));
  // pool (gecko) oracle: 0..199 with a 1-bucket no-trade hole at 50 and a 300-bucket-ish hole later is not needed
  const gecko = range(0, 200).filter((t) => t !== at(50));
  await store.upsert(gecko.map((t, i) => ({ slab: SLAB, series: "oracle" as const, res, candle: cd(t, 10 + (i % 7) * 0.1, 0.05), src: "gecko" as const })));
  await store.upsert(range(60, 20).map((t) => ({ slab: SLAB, series: "mark" as const, res, candle: cd(t, 11, 0.02), src: "chain" as const })));   // chain: 60..79
  await store.upsert(range(180, 30).map((t) => ({ slab: SLAB, series: "mark" as const, res, candle: cd(t, 12, 0.03), src: "live" as const })));   // live: 180..209
  await store.upsert(range(180, 30).map((t) => ({ slab: SLAB, series: "oracle" as const, res, candle: cd(t, 12.1, 0.03), src: "live" as const })));
  // finer data only (rolled up when this resolution has no stored bar): 4 finer buckets per coarse bucket 90..99
  return { store, T0, step, at };
}

describe("merged history is chartable by both engines", () => {
  for (const res of [15, 60, 240] as const) {
    it(`res ${res}: strictly ascending, unique, finite, h/l contain o/c; gap + proxy + flat all present`, async () => {
      const { store, at, step } = await scenario(res);
      const h = await loadHistory(SLAB, "mark", res, at(210), 210, { store, backfill: none });
      expect(() => assertChartable(h.bars)).not.toThrow();
      expect(h.bars.map((b) => b.t)).toEqual(Array.from({ length: 210 }, (_, i) => at(i))); // continuous 0..209
      const tag = (i: number) => h.bars.find((b) => b.t === at(i))!;
      expect(tag(70).proxy).toBeUndefined();                                // real chain mark
      expect(tag(120)).toMatchObject({ proxy: true, src: "dex" });          // gap between chain and live
      expect(tag(50)).toMatchObject({ flat: true, proxy: true });           // no-trade hole carried forward
      expect(tag(200)).toMatchObject({ src: "live" });
      expect(step).toBeGreaterThan(0);
    });
  }

  it("rolled-up bars (only the finer resolution is stored) are chartable too", async () => {
    const T0 = Math.floor(Date.UTC(2026, 9, 1) / 1000 / 14_400) * 14_400;
    const store = new MemoryCandleStore();
    await store.upsert(Array.from({ length: 96 }, (_, i) => ({ slab: SLAB, series: "oracle" as const, res: 60 as const, candle: cd(T0 + i * 3600, 5 + (i % 5) * 0.1, 0.2), src: "gecko" as const })));
    const h = await loadHistory(SLAB, "mark", 240, T0 + 24 * 14_400, 24, { store, backfill: none });
    expect(h.bars).toHaveLength(24);
    expect(h.bars.every((b) => b.derived && b.proxy)).toBe(true);
    expect(() => assertChartable(h.bars)).not.toThrow();
  });

  it("negative control: the validator rejects duplicate, unsorted, NaN and h<l data (so the passes above mean something)", () => {
    const b = (t: number, o = 1, h = 1, l = 1, c = 1) => ({ t, o, h, l, c });
    expect(() => assertChartable([b(60), b(60)])).toThrow(/asc ordered/);
    expect(() => assertChartable([b(120), b(60)])).toThrow(/asc ordered/);
    expect(() => assertChartable([b(60, NaN)])).toThrow(/non-finite/);
    expect(() => assertChartable([b(60, 2, 1, 1, 2)])).toThrow(/h\/l/);
    expect(() => assertChartable([b(60_000_000_000_000)])).toThrow(/seconds/);
  });

  it("negative control: corrupt stored rows reach the wire UNLESS sanitised (the route now sanitises)", async () => {
    const store = new MemoryCandleStore();
    await store.upsert([cd(60, 5), cd(120, 5), cd(180, 5)].map((candle) => ({ slab: SLAB, series: "mark" as const, res: 1 as const, candle, src: "live" as const })));
    // a corrupt row slipped past the table checks: high below close, and a NaN row
    store.rows.set(`${SLAB}|mark|1|120`, { t: 120, o: 5, h: 4, l: 5, c: 5, n: 1, src: "live" });
    store.rows.set(`${SLAB}|mark|1|240`, { t: 240, o: NaN, h: NaN, l: NaN, c: NaN, n: 1, src: "live" });
    const h = await loadHistory(SLAB, "mark", 1, 300, 10, { store, backfill: none });
    expect(() => assertChartable(h.bars)).not.toThrow();
    expect(h.bars.map((b) => b.t)).toEqual([60, 120, 180]);
    expect(h.bars[1].h).toBe(5); // widened to contain open/close
    // and without sanitising the same rows would blank the chart
    expect(() => assertChartable([{ t: 120, o: 5, h: 4, l: 5, c: 5 }])).toThrow();
    expect(sanitizeBars([{ t: 5, o: 1, h: 1, l: 1, c: 1, v: 0, src: "live" }, { t: 5, o: 1, h: 1, l: 1, c: 1, v: 0, src: "live" }] as HistoryBar[])).toHaveLength(1);
  });

  it("through the real provider and the real TradingView datafeed: bars arrive in ms, ascending, numeric-only", async () => {
    const { store, at } = await scenario(15);
    const provider = createPerpProvider({
      base: { id: "b", resolveSymbol: async (slab) => ({ slab, symbol: "LINK", description: "", referencePrice: 12, hasVolume: false }), getBars: async () => ({ bars: [], noMoreHistory: true, source: "oracle" }), subscribeBars: () => () => {}, searchSymbols: async () => [] },
      live: { subscribe: () => () => {} },
      series: createSeriesStore(null),
      fetchImpl: async (url) => {
        const q = new URL(url, "http://x").searchParams;
        const h = await loadHistory(SLAB, "mark", 15, Number(q.get("to")), Number(q.get("countBack")), { store, backfill: none });
        const body = JSON.parse(JSON.stringify({ s: h.bars.length ? "ok" : "no_data", ...h })); // exactly what the route serialises
        return { ok: true, status: 200, json: async () => body };
      },
    });
    const errors: unknown[] = [];
    const feed = createTvDatafeed(provider, { onError: (_w, e) => errors.push(e) });
    const got = await new Promise<{ bars: Array<Record<string, unknown>>; meta: { noData?: boolean } }>((resolve, reject) => {
      feed.getBars({ ticker: SLAB } as never, "15", { from: at(0), to: at(210), countBack: 210, firstDataRequest: true }, (bars, meta) => resolve({ bars: bars as never, meta: meta as never }), reject);
    });
    expect(errors).toEqual([]);
    expect(got.bars).toHaveLength(210);
    for (const b of got.bars) expect(Object.keys(b).sort()).toEqual(["close", "high", "low", "open", "time", "volume"]); // no proxy/flat/src leaks
    expect(() => assertChartable(got.bars.map((b) => ({ t: (b.time as number) / 1000, o: b.open as number, h: b.high as number, l: b.low as number, c: b.close as number })))).not.toThrow();
    expect(typeof got.meta.noData === "boolean" || got.meta.noData === undefined).toBe(true);
  });
});

describe("TradingView datafeed reports data errors instead of going quiet", () => {
  const mk = (getBars: ChartDataProvider["getBars"]) => ({ id: "t", resolveSymbol: vi.fn(), searchSymbols: vi.fn(), getBars, subscribeBars: () => () => {} }) as unknown as ChartDataProvider;
  const call = (feed: ReturnType<typeof createTvDatafeed>) =>
    new Promise<string>((resolve) => feed.getBars({ ticker: SLAB } as never, "15", { from: 0, to: 9, countBack: 5, firstDataRequest: true }, () => resolve("result"), (m) => resolve(`error:${m}`)));
  it("a thrown getBars calls hooks.onError and TradingView's onError; a good page calls onBarsLoaded", async () => {
    const onError = vi.fn(); const onBarsLoaded = vi.fn();
    expect(await call(createTvDatafeed(mk(async () => { throw new Error("perp-chart HTTP 504"); }), { onError, onBarsLoaded }))).toBe("error:perp-chart HTTP 504");
    expect(onError).toHaveBeenCalledWith("bars", expect.any(Error));
    expect(onBarsLoaded).not.toHaveBeenCalled();
    expect(await call(createTvDatafeed(mk(async () => ({ bars: [{ timeSec: 900, open: 1, high: 1, low: 1, close: 1, volume: 0 }], noMoreHistory: false, source: "perp-mark" as const })), { onError, onBarsLoaded }))).toBe("result");
    expect(onBarsLoaded).toHaveBeenCalledTimes(1);
  });
});

// ── PerpChart (lightweight-charts fallback) with an engine fake that THROWS like the real one ─────────
const lw = vi.hoisted(() => ({ setData: [] as unknown[][], dataErrors: [] as string[] }));
vi.mock("lightweight-charts", () => {
  const series = () => ({
    priceToCoordinate: () => 100,
    setData: (data: Array<{ time: number; open: number; high: number; low: number; close: number }>) => {
      let prev = -Infinity;
      for (const d of data) {
        if (!(d.time > prev)) { const m = `Assertion failed: data must be asc ordered by time, index=${data.indexOf(d)}`; lw.dataErrors.push(m); throw new Error(m); }
        prev = d.time;
        if (![d.open, d.high, d.low, d.close].every(Number.isFinite)) { lw.dataErrors.push("Value is null"); throw new Error("Value is null"); }
      }
      lw.setData.push(data);
    },
    update: vi.fn(), applyOptions: vi.fn(), createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })), removePriceLine: vi.fn(),
  });
  return {
    ColorType: { Solid: "solid" }, CrosshairMode: { Normal: 0 }, LineStyle: { Solid: 0, Dashed: 2 }, CandlestickSeries: "Candlestick", HistogramSeries: "Histogram",
    createChart: () => ({
      addSeries: () => series(), removeSeries: vi.fn(), applyOptions: vi.fn(), remove: vi.fn(), priceScale: () => ({ applyOptions: vi.fn() }),
      timeScale: () => ({ height: () => 20, fitContent: vi.fn(), subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn(), getVisibleLogicalRange: () => ({ from: 100, to: 200 }), setVisibleLogicalRange: vi.fn() }),
    }),
  };
});
const dp = vi.hoisted(() => ({ provider: null as null | ChartDataProvider }));
vi.mock("@/lib/tv/data", () => ({
  getChartDataProvider: () => dp.provider,
  getLiveClient: () => ({ subscribe: () => () => {} }),
  perpChartEnabled: () => true,
}));
vi.mock("@/hooks/usePositionLinePrices", () => ({ usePositionLinePrices: () => ({ liq: null, entry: null, entryIsEstimate: false }) }));
vi.mock("@/hooks/usePerpHeaderStats", () => ({ usePerpHeaderStats: () => ({ change: null, volume24hUsd: null, oiUsd: null, funding: undefined }) }));
vi.mock("@/components/trade/ChartPnlBadge", () => ({ ChartPnlBadge: () => null }));
vi.mock("@/components/trade/ChartBadges", () => ({ DraggableChartBadges: ({ children }: { children: React.ReactNode }) => <>{children}</>, PositionSummary: () => null }));

async function mountPerp() {
  vi.resetModules();
  const { PerpChart } = await import("@/components/trade/perp/PerpChart");
  return render(<PerpChart slabAddress={SLAB} />);
}

describe("PerpChart (lightweight-charts) with merged history", () => {
  beforeEach(() => {
    lw.setData.length = 0; lw.dataErrors.length = 0;
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 420 });
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    window.localStorage.clear();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("draws gap + proxy + roll-up + flat history without the engine throwing, and shows no error", async () => {
    const { store, at } = await scenario(15);
    const h = await loadHistory(SLAB, "mark", 15, at(210), 210, { store, backfill: none });
    const bars: ProviderBar[] = h.bars.map((b) => ({ timeSec: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: 0 }));
    dp.provider = { id: "t", resolveSymbol: vi.fn(), searchSymbols: vi.fn(), getBars: vi.fn(async () => ({ bars, noMoreHistory: false, source: "perp-mark" as const, proxyBeforeSec: h.proxyBeforeSec, proxyFromSec: h.proxyFromSec })), subscribeBars: () => () => {} } as unknown as ChartDataProvider;
    await mountPerp();
    await waitFor(() => expect(lw.setData).toHaveLength(1));
    expect(lw.setData[0]).toHaveLength(210);
    expect(lw.dataErrors).toEqual([]);
    expect(screen.queryByTestId("chart-data-error")).toBeNull();
  });

  it("negative control: the same engine fake DOES throw on duplicate times, and the chart reports it instead of staying blank", async () => {
    const dup: ProviderBar[] = [1, 2, 2, 3].map((i) => ({ timeSec: 900 * i, open: 1, high: 1, low: 1, close: 1, volume: 0 }));
    dp.provider = { id: "t", resolveSymbol: vi.fn(), searchSymbols: vi.fn(), getBars: vi.fn(async () => ({ bars: dup, noMoreHistory: false, source: "perp-mark" as const })), subscribeBars: () => () => {} } as unknown as ChartDataProvider;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await mountPerp();
    await waitFor(() => expect(screen.getByTestId("chart-data-error")).toBeInTheDocument());
    expect(lw.dataErrors[0]).toMatch(/asc ordered/);
    expect(spy).toHaveBeenCalled(); // logged to the console, not swallowed
    spy.mockRestore();
  });

  it("a failed history fetch shows 'Chart data unavailable' with a Retry that reloads; recovery clears it", async () => {
    const bars: ProviderBar[] = [1, 2, 3].map((i) => ({ timeSec: 900 * i, open: 1, high: 2, low: 1, close: 2, volume: 0 }));
    const getBars = vi.fn()
      .mockRejectedValueOnce(new Error("perp-chart HTTP 504"))
      .mockResolvedValue({ bars, noMoreHistory: false, source: "perp-mark" as const });
    dp.provider = { id: "t", resolveSymbol: vi.fn(), searchSymbols: vi.fn(), getBars, subscribeBars: () => () => {} } as unknown as ChartDataProvider;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await mountPerp();
    await waitFor(() => expect(screen.getByText("Chart data unavailable")).toBeInTheDocument());
    expect(spy.mock.calls.flat().join(" ")).toContain("504");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry" })); });
    await waitFor(() => expect(lw.setData).toHaveLength(1));
    expect(getBars).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Chart data unavailable")).toBeNull();
    spy.mockRestore();
  });
});
