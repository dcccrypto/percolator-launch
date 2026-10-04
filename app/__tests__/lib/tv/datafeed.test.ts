import { describe, expect, it, vi } from "vitest";
import {
  createTvDatafeed,
  normalizeResolution,
  toSymbolInfo,
  tvPriceScale,
  TV_SUPPORTED_RESOLUTIONS,
} from "@/lib/tv/datafeed";
import type { BarsPage, BarsRequest, ChartDataProvider, LiveHandlers, ProviderBar } from "@/lib/tv/data/provider";
import type { TvBar, TvHistoryMeta, TvSymbolInfo } from "@/lib/tv/types";

const SLAB = "HBU9iugdcxdvQ9tNFuTLTtcB1bYXFdh4d5reD8M2dpop";
const bar = (timeSec: number, close = 1): ProviderBar => ({ timeSec, open: close, high: close, low: close, close, volume: 5 });

function fakeProvider(page: Partial<BarsPage> = {}) {
  const calls: BarsRequest[] = [];
  const subs: Array<{ handlers: LiveHandlers; lastBar: ProviderBar | null; source: unknown; off: ReturnType<typeof vi.fn> }> = [];
  const provider: ChartDataProvider = {
    id: "fake",
    resolveSymbol: vi.fn(async (slab: string) => ({ slab, symbol: "SOL", description: "SOL perpetual", referencePrice: 150, hasVolume: true })),
    getBars: vi.fn(async (req: BarsRequest) => {
      calls.push(req);
      return { bars: [bar(60), bar(120, 2)], noMoreHistory: false, source: "percolator" as const, ...page };
    }),
    subscribeBars: vi.fn((_s, _r, handlers: LiveHandlers, lastBar: ProviderBar | null, source) => {
      const off = vi.fn();
      subs.push({ handlers, lastBar, source, off });
      return off;
    }),
    searchSymbols: vi.fn(async () => [{ slab: SLAB, symbol: "SOL", description: "SOL perpetual", referencePrice: 1, hasVolume: true }]),
  };
  return { provider, calls, subs };
}

const flush = () => new Promise((r) => setTimeout(r, 5));
const symbolInfo = (): TvSymbolInfo => toSymbolInfo({ slab: SLAB, symbol: "SOL", description: "d", referencePrice: 150, hasVolume: true });

describe("tv datafeed adapter", () => {
  it("onReady is async and advertises the resolution set", async () => {
    const df = createTvDatafeed(fakeProvider().provider);
    const cb = vi.fn();
    df.onReady(cb);
    expect(cb).not.toHaveBeenCalled(); // must be a separate macrotask
    await flush();
    expect(cb.mock.calls[0][0].supported_resolutions).toEqual(TV_SUPPORTED_RESOLUTIONS);
  });

  it("resolveSymbol maps provider metadata; ticker stays the case-sensitive slab", async () => {
    const df = createTvDatafeed(fakeProvider().provider);
    const onResolve = vi.fn();
    df.resolveSymbol(SLAB, onResolve, vi.fn());
    await flush();
    const info = onResolve.mock.calls[0][0] as TvSymbolInfo;
    expect(info.ticker).toBe(SLAB);
    expect(info.name).toBe("SOL/USD");
    expect(info.session).toBe("24x7");
    expect(info.visible_plots_set).toBe("ohlcv");
    expect(info.has_weekly_and_monthly).toBe(false);
  });

  it("resolveSymbol failure reports unknown_symbol", async () => {
    const { provider } = fakeProvider();
    provider.resolveSymbol = vi.fn(async () => {
      throw new Error("boom");
    });
    const onError = vi.fn();
    createTvDatafeed(provider).resolveSymbol(SLAB, vi.fn(), onError);
    await flush();
    expect(onError).toHaveBeenCalledWith("unknown_symbol");
  });

  it("getBars converts to ms and forwards the period", async () => {
    const { provider, calls } = fakeProvider();
    const df = createTvDatafeed(provider);
    const onResult = vi.fn();
    df.getBars(symbolInfo(), "D", { from: 10, to: 1000, countBack: 300, firstDataRequest: true }, onResult, vi.fn());
    await flush();
    expect(calls[0]).toMatchObject({ slab: SLAB, resolution: "1D", fromSec: 10, toSec: 1000, countBack: 300, firstRequest: true });
    const [bars, meta] = onResult.mock.calls[0] as [TvBar[], TvHistoryMeta];
    expect(bars.map((b) => b.time)).toEqual([60_000, 120_000]);
    expect(meta.noData).toBe(false);
  });

  it("empty or exhausted history sets noData", async () => {
    const df = createTvDatafeed(fakeProvider({ bars: [], noMoreHistory: false }).provider);
    const onResult = vi.fn();
    df.getBars(symbolInfo(), "60", { from: 0, to: 10, countBack: 1, firstDataRequest: false }, onResult, vi.fn());
    await flush();
    expect(onResult.mock.calls[0][1]).toEqual({ noData: true });
    const df2 = createTvDatafeed(fakeProvider({ noMoreHistory: true }).provider);
    const r2 = vi.fn();
    df2.getBars(symbolInfo(), "60", { from: 0, to: 10, countBack: 1, firstDataRequest: false }, r2, vi.fn());
    await flush();
    expect(r2.mock.calls[0][0]).toHaveLength(2);
    expect(r2.mock.calls[0][1]).toEqual({ noData: true });
  });

  it("unsupported resolution is an error, never a provider call", async () => {
    const { provider } = fakeProvider();
    const onError = vi.fn();
    createTvDatafeed(provider).getBars(symbolInfo(), "30", { from: 0, to: 1, countBack: 1, firstDataRequest: true }, vi.fn(), onError);
    await flush();
    expect(onError).toHaveBeenCalled();
    expect(provider.getBars).not.toHaveBeenCalled();
  });

  it("subscribeBars hands the provider the last history bar and source, forwards ticks in ms", async () => {
    const { provider, subs } = fakeProvider({ source: "oracle" });
    const onSource = vi.fn();
    const df = createTvDatafeed(provider, { onSource });
    df.getBars(symbolInfo(), "60", { from: 0, to: 1000, countBack: 2, firstDataRequest: true }, vi.fn(), vi.fn());
    await flush();
    expect(onSource).toHaveBeenCalledWith(SLAB, "oracle");
    const onTick = vi.fn();
    df.subscribeBars(symbolInfo(), "60", onTick, "g1", vi.fn());
    expect(subs[0].lastBar).toEqual(bar(120, 2));
    expect(subs[0].source).toBe("oracle");
    subs[0].handlers.onBar(bar(180, 3));
    expect(onTick).toHaveBeenCalledWith(expect.objectContaining({ time: 180_000, close: 3 }));
  });

  it("provider reset calls onResetCacheNeeded and the reset hook; unsubscribe releases", () => {
    const { provider, subs } = fakeProvider();
    const onResetRequested = vi.fn();
    const df = createTvDatafeed(provider, { onResetRequested });
    const onReset = vi.fn();
    df.subscribeBars(symbolInfo(), "60", vi.fn(), "g1", onReset);
    subs[0].handlers.onReset?.();
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onResetRequested).toHaveBeenCalledWith(SLAB);
    df.unsubscribeBars("g1");
    expect(subs[0].off).toHaveBeenCalledTimes(1);
  });

  it("searchSymbols maps results with the slab as ticker", async () => {
    const df = createTvDatafeed(fakeProvider().provider);
    const onResult = vi.fn();
    df.searchSymbols("so", "", "", onResult);
    await flush();
    expect(onResult.mock.calls[0][0][0]).toMatchObject({ symbol: "SOL/USD", ticker: SLAB, exchange: "Percolator" });
  });

  it("normalizeResolution and tvPriceScale", () => {
    expect(normalizeResolution("D")).toBe("1D");
    expect(normalizeResolution("W")).toBe("1W");
    expect(normalizeResolution("15")).toBe("15");
    expect(tvPriceScale(3500)).toBe(100);
    expect(tvPriceScale(150)).toBe(10_000);
    expect(tvPriceScale(null)).toBe(100);
    expect(tvPriceScale(0.3175)).toBe(10_000);
    expect(tvPriceScale(0.002573)).toBe(1_000_000);
    expect(tvPriceScale(0.000126)).toBe(1e7);
    expect(tvPriceScale(1e-9)).toBe(1e8); // capped at the e6 grid + 2 spare decimals
    expect(tvPriceScale(1e-15)).toBe(1e8);
  });
});
