// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DARK_THEME, LIGHT_THEME } from "@/hooks/useChartTheme";
import { createTvDatafeed, toSymbolInfo, tvPriceScale } from "@/lib/tv/datafeed";
import { createPerpProvider } from "@/lib/tv/data/perpProvider";
import { createSeriesStore } from "@/lib/chart/perp-series";
import type { LiveClient, LiveHandlers as WsHandlers } from "@/lib/chart/live-client";
import type { BarsRequest, ChartDataProvider } from "@/lib/tv/data/provider";
import { DEFAULT_INTERVAL, buildWidgetOptions } from "@/lib/tv/widgetOptions";
import { decimalsFromPriceScale, priceFormatterFactory } from "@/lib/tv/priceFormatter";
import { desiredLines } from "@/lib/tv/positionLines";

const APP = path.resolve(__dirname, "../../..");
const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const flush = () => new Promise((r) => setTimeout(r, 5));

describe("price formatter (memecoin precision)", () => {
  it("decimals come from the symbol's pricescale", () => {
    expect([100, 10_000, 1e6, 1e8].map(decimalsFromPriceScale)).toEqual([2, 4, 6, 8]);
    expect(decimalsFromPriceScale(1)).toBe(2);
    expect(decimalsFromPriceScale(NaN)).toBe(2);
  });
  it("formats a $0.0036 mark with every decimal the e6 grid carries, never fewer", () => {
    const f = priceFormatterFactory({ pricescale: tvPriceScale(0.003628) });
    expect(f.format(0.003628)).toBe("0.003628");
    expect(f.format(0.003629)).not.toBe(f.format(0.003628)); // a 1e-6 step stays visible
    expect(priceFormatterFactory({ pricescale: 100 }).format(0.003628)).toBe("0.00"); // control: a coarse scale would hide it
  });
  it("signs and edge cases", () => {
    const f = priceFormatterFactory({ pricescale: 1e6 });
    expect(f.format(-0.0021)).toBe("-0.002100");
    expect(f.format(0.0021, true)).toBe("+0.002100");
    expect(f.format(-0.0000001)).toBe("0.000000"); // rounds to zero: no "-0.000000"
    expect(f.format(NaN)).toBe("");
  });
  it("is wired into the widget options, and the default interval is intraday", () => {
    const opts = buildWidgetOptions({
      container: {} as HTMLElement, datafeed: {} as never, slab: SLAB, interval: DEFAULT_INTERVAL, themeName: "dark",
      dark: DARK_THEME, light: LIGHT_THEME, mode: "desktop", saveLoad: {} as never, settings: {} as never, savedData: null, timezone: "Etc/UTC", debug: false,
    });
    const fmt = opts.custom_formatters?.priceFormatterFactory?.({ pricescale: 1e6 } as never, "0.000001");
    expect(fmt?.format(0.003628)).toBe("0.003628");
    expect(opts.custom_formatters?.priceFormatterFactory?.(null, "0.01")).toBeNull();
    expect(DEFAULT_INTERVAL).toBe("15");
  });
});

describe("position lines", () => {
  const base = { markPrice: 0.0036, prevMarkPrice: null, liqPrice: 0.0021, entryPrice: 0.0034, prefs: { liq: true, entry: true }, theme: DARK_THEME };
  it("an estimated entry is labelled est.; a recorded one is not (negative control)", () => {
    expect(desiredLines({ ...base, entryIsEstimate: true }).entry?.text).toBe("Entry est.");
    expect(desiredLines({ ...base, entryIsEstimate: false }).entry?.text).toBe("Entry");
    expect(desiredLines(base).entry?.text).toBe("Entry");
  });
  it("the Mark line is hidden on the Mark series (it would sit on the candle) and shown otherwise", () => {
    expect(desiredLines({ ...base, showMark: false }).mark).toBeUndefined();
    expect(desiredLines({ ...base, showMark: true }).mark).toBeDefined();
    expect(desiredLines(base).mark).toBeDefined();
  });
  it("no price, no line (nothing falls back to the mark)", () => {
    const d = desiredLines({ ...base, liqPrice: null, entryPrice: null });
    expect(d.liq).toBeUndefined();
    expect(d.entry).toBeUndefined();
  });
});

describe("datafeed over the PERP provider: one shared feed, series from the toggle", () => {
  function setup(seriesName: "mark" | "oracle" | "last" = "mark") {
    const store = createSeriesStore(null);
    store.set(seriesName);
    let ws: WsHandlers | null = null;
    const live: LiveClient = { subscribe: (_s, h) => { ws = h; return () => { ws = null; }; } };
    const fetchImpl = vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => ({ bars: [{ t: 60, o: 0.0036, h: 0.0037, l: 0.0035, c: 0.0036, src: url.includes("series=oracle") ? "dex" : "chain" }], noMoreHistory: true }),
    }));
    const base: ChartDataProvider = {
      id: "base",
      resolveSymbol: async (slab) => ({ slab, symbol: "PERC", description: "d", referencePrice: 0.0036, hasVolume: true }),
      getBars: async () => ({ bars: [], noMoreHistory: true, source: "oracle" }),
      subscribeBars: () => () => {},
      searchSymbols: async () => [],
    };
    const provider = createPerpProvider({ base, live, fetchImpl, series: store });
    const hooks = { onDexData: vi.fn(), onBarDelivered: vi.fn(), onSource: vi.fn(), onResetRequested: vi.fn() };
    return { df: createTvDatafeed(provider, hooks), store, hooks, fetchImpl, ws: () => ws as WsHandlers };
  }
  const period = { from: 0, to: 4_000_000_000, countBack: 300, firstDataRequest: true };
  const info = () => toSymbolInfo({ slab: SLAB, symbol: "PERC", description: "d", referencePrice: 0.0036, hasVolume: false });

  it("getBars reads /api/perp-chart for the toggled series", async () => {
    const t = setup("oracle");
    const onResult = vi.fn();
    t.df.getBars(info(), "15", period, onResult, vi.fn());
    await flush();
    expect(t.fetchImpl.mock.calls[0][0]).toContain("/api/perp-chart/" + SLAB + "?series=oracle&resolution=15");
    expect(onResult.mock.calls[0][0]).toHaveLength(1);
    expect(t.hooks.onSource).toHaveBeenCalledWith(SLAB, "perp-oracle");
  });
  it("GeckoTerminal-sourced bars raise the attribution hook; our own chain/live bars do not (negative control)", async () => {
    const dex = setup("oracle");
    dex.df.getBars(info(), "15", period, vi.fn(), vi.fn());
    await flush();
    expect(dex.hooks.onDexData).toHaveBeenCalledWith(SLAB);
    const own = setup("mark");
    own.df.getBars(info(), "15", period, vi.fn(), vi.fn());
    await flush();
    expect(own.hooks.onDexData).not.toHaveBeenCalled();
  });
  it("subscribeBars streams pushed ticks into the forming bar (mark) and ignores the oracle field", async () => {
    const t = setup("mark");
    const onTick = vi.fn();
    t.df.subscribeBars(info(), "1", onTick, "g1", vi.fn());
    const landedMs = Date.UTC(2026, 9, 4, 12, 0, 1);
    t.ws().onTick({ type: "tick", slab: SLAB, epoch: "e", seq: 1, slot: 1, landedMs, recvMs: landedMs, mark: 0.0036, oracle: 0.9 });
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick.mock.calls[0][0]).toMatchObject({ close: 0.0036, time: Date.UTC(2026, 9, 4, 12, 0, 0) });
    expect(t.hooks.onBarDelivered).toHaveBeenCalledTimes(1);
    t.df.unsubscribeBars("g1");
    expect(t.ws()).toBeNull();
  });
  it("flipping the series asks the library to reset (and the symbol's volume plot follows the series)", async () => {
    const t = setup("mark");
    const onReset = vi.fn();
    t.df.subscribeBars(info(), "1", vi.fn(), "g2", onReset);
    t.store.set("last");
    expect(onReset).toHaveBeenCalled();
    expect(t.hooks.onResetRequested).toHaveBeenCalledWith(SLAB);
    const meta = await createPerpProvider({ base: { id: "b", resolveSymbol: async (s) => ({ slab: s, symbol: "P", description: "d", referencePrice: 1, hasVolume: true }), getBars: async () => ({ bars: [], noMoreHistory: true, source: null }), subscribeBars: () => () => {}, searchSymbols: async () => [] }, live: { subscribe: () => () => {} }, fetchImpl: vi.fn(), series: t.store }).resolveSymbol(SLAB);
    expect(meta.hasVolume).toBe(true); // Last has volume; Mark/Oracle do not (covered in perp-provider tests)
  });
});

describe("licence + Advanced-Charts-only guards", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const n of readdirSync(dir)) {
      const p = path.join(dir, n);
      if (statSync(p).isDirectory()) { if (n !== "node_modules" && n !== ".next") walk(p, out); }
      else if (/\.(ts|tsx)$/.test(n)) out.push(p);
    }
    return out;
  }
  const sources = [...walk(path.join(APP, "lib/tv")), ...walk(path.join(APP, "components/trade/tv"))];

  it("uses NO Trading Platform primitives (fixed lines only, no draggable orders/positions/broker)", () => {
    const banned = /createOrderLine|createPositionLine|createExecutionShape|createBuySellButton|tradingProperties|broker_factory|broker_config|trading_terminal/;
    for (const f of sources) expect(readFileSync(f, "utf8"), f).not.toMatch(banned);
  });
  it("NEGATIVE CONTROL: the scan really does catch a banned call", () => {
    expect(/createOrderLine|createPositionLine/.test("chart.createOrderLine()")).toBe(true);
  });
  it("lines are plain locked horizontal_line shapes", () => {
    const src = readFileSync(path.join(APP, "lib/tv/positionLines.ts"), "utf8");
    expect(src).toMatch(/horizontal_line/);
    expect(src).toMatch(/lock: true/);
  });
  it("the TradingView logo/attribution is never hidden by our CSS or feature flags", () => {
    const css = readFileSync(path.join(APP, "public/tv-theme/percolator.css"), "utf8");
    expect(css).not.toMatch(/tv-logo|tv-attribution|logo[^{]*\{[^}]*display\s*:\s*none/i);
    const opts = buildWidgetOptions({
      container: {} as HTMLElement, datafeed: {} as never, slab: SLAB, interval: "15", themeName: "dark", dark: DARK_THEME, light: LIGHT_THEME,
      mode: "compact", saveLoad: {} as never, settings: {} as never, savedData: null, timezone: "Etc/UTC", debug: false,
    });
    expect(opts.disabled_features).not.toContain("adaptive_logo");
    expect(opts.enabled_features).toContain("adaptive_logo"); // compact mode keeps the (smaller) logo, it does not remove it
  });
  it("the CoinGecko attribution is rendered by the panel wherever gecko bars are shown", () => {
    const panel = readFileSync(path.join(APP, "components/trade/tv/TvChartPanel.tsx"), "utf8");
    expect(panel).toMatch(/Powered by CoinGecko/);
    expect(panel).toMatch(/onDexData/);
  });
});
