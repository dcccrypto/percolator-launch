import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveHandlers as BarHandlers, ProviderBar } from "@/lib/tv/data/provider";
import type { TickMessage } from "@/lib/chart/perp-types";

// ── lightweight-charts: a recording fake ─────────────────────────────────────
const created = vi.hoisted(() => ({ series: [] as Array<{ kind: string; setData: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; createPriceLine: ReturnType<typeof vi.fn>; removePriceLine: ReturnType<typeof vi.fn>; applyOptions: ReturnType<typeof vi.fn>; lines: Array<{ opts: Record<string, unknown>; applyOptions: ReturnType<typeof vi.fn> }> }>, charts: 0, removed: 0 }));
vi.mock("lightweight-charts", () => {
  const mkSeries = (kind: string) => {
    const lines: Array<{ opts: Record<string, unknown>; applyOptions: ReturnType<typeof vi.fn> }> = [];
    const s = {
      kind, lines,
      setData: vi.fn(), update: vi.fn(), applyOptions: vi.fn(),
      createPriceLine: vi.fn((opts: Record<string, unknown>) => { const l = { opts, applyOptions: vi.fn() }; lines.push(l); return l; }),
      removePriceLine: vi.fn(),
    };
    created.series.push(s);
    return s;
  };
  return {
    ColorType: { Solid: "solid" }, CrosshairMode: { Normal: 0 }, LineStyle: { Solid: 0, Dashed: 2 },
    CandlestickSeries: "Candlestick", HistogramSeries: "Histogram",
    createChart: () => {
      created.charts++;
      return {
        addSeries: (def: string) => mkSeries(def),
        removeSeries: vi.fn(),
        applyOptions: vi.fn(),
        remove: () => { created.removed++; },
        priceScale: () => ({ applyOptions: vi.fn() }),
        timeScale: () => ({ fitContent: vi.fn(), subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn(), getVisibleLogicalRange: () => ({ from: 100, to: 200 }), setVisibleLogicalRange: vi.fn() }),
      };
    },
  };
});

// ── data layer: a controllable provider + live client ────────────────────────
const h = vi.hoisted(() => ({
  getBars: vi.fn(),
  barHandlers: null as null | { onBar(b: unknown): void; onReset?(): void },
  subscribeCalls: 0,
  tickHandlers: null as null | { onTick(m: unknown): void },
}));
vi.mock("@/lib/tv/data", () => ({
  getChartDataProvider: () => ({
    getBars: h.getBars,
    subscribeBars: (_s: string, _r: string, handlers: { onBar(b: unknown): void; onReset?(): void }) => { h.subscribeCalls++; h.barHandlers = handlers; return () => { h.barHandlers = null; }; },
  }),
  getLiveClient: () => ({ subscribe: (_s: string, handlers: { onTick(m: unknown): void }) => { h.tickHandlers = handlers; return () => { h.tickHandlers = null; }; } }),
  perpChartEnabled: () => true,
}));
vi.mock("@/hooks/usePositionLinePrices", () => ({ usePositionLinePrices: () => ({ liq: 0.0021, entry: 0.0034 }) }));
vi.mock("@/hooks/usePerpHeaderStats", () => ({ usePerpHeaderStats: () => ({ change: null, volume24hUsd: null, oiUsd: null, funding: undefined }) }));
vi.mock("@/components/trade/ChartPnlBadge", () => ({ ChartPnlBadge: () => null }));
vi.mock("@/components/trade/ChartBadges", () => ({ DraggableChartBadges: ({ children }: { children: React.ReactNode }) => <>{children}</>, PositionSummary: () => null }));

const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const T0 = Math.floor(Date.UTC(2026, 9, 4, 12, 0, 0) / 1000);
const bar = (i: number, p: number): ProviderBar => ({ timeSec: T0 + i * 900, open: p, high: p + 1, low: p - 1, close: p, volume: 0 });
const tick = (seq: number, mark: number | null, oracle: number | null): TickMessage => ({ type: "tick", slab: SLAB, epoch: "e", seq, slot: seq, landedMs: Date.now(), recvMs: Date.now(), mark, oracle });

async function mount() {
  vi.resetModules();
  const { PerpChart } = await import("@/components/trade/perp/PerpChart");
  const { getSeriesStore } = await import("@/lib/chart/perp-series");
  const r = render(<PerpChart slabAddress={SLAB} />);
  return { ...r, store: getSeriesStore() };
}
const flushRaf = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });

beforeEach(() => {
  created.series.length = 0; created.charts = 0; created.removed = 0; h.subscribeCalls = 0;
  h.getBars.mockReset();
  h.getBars.mockResolvedValue({ bars: [bar(0, 100), bar(1, 101)], noMoreHistory: false, source: "perp-mark" });
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  window.localStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("PerpChart", () => {
  it("loads history for the default MARK series at the default timeframe and draws it", async () => {
    await mount();
    await waitFor(() => expect(h.getBars).toHaveBeenCalled());
    const req = h.getBars.mock.calls[0][0];
    expect(req).toMatchObject({ slab: SLAB, resolution: "15", firstRequest: true });
    const candle = created.series.find((s) => s.kind === "Candlestick")!;
    await waitFor(() => expect(candle.setData).toHaveBeenCalledTimes(1));
    expect(candle.setData.mock.calls[0][0]).toHaveLength(2);
    expect(created.series.find((s) => s.kind === "Histogram")).toBeUndefined(); // no volume plot on Mark
  });

  it("a pushed bar updates the forming candle in place (update, not setData), coalesced per frame", async () => {
    await mount();
    await waitFor(() => expect(h.barHandlers).not.toBeNull());
    const candle = created.series.find((s) => s.kind === "Candlestick")!;
    act(() => {
      h.barHandlers!.onBar(bar(1, 102));
      h.barHandlers!.onBar(bar(1, 103)); // same frame: only the newest is painted
    });
    await flushRaf();
    expect(candle.update).toHaveBeenCalledTimes(1);
    expect(candle.update.mock.calls[0][0]).toMatchObject({ close: 103 });
    expect(candle.setData).toHaveBeenCalledTimes(1);
    act(() => h.barHandlers!.onBar(bar(2, 104))); // a new bucket
    await flushRaf();
    expect(candle.update).toHaveBeenLastCalledWith(expect.objectContaining({ close: 104 }));
  });

  it("a live-only start (no history) still gets memecoin axis precision from the first pushed price", async () => {
    h.getBars.mockResolvedValue({ bars: [], noMoreHistory: true, source: "perp-mark" });
    await mount();
    await waitFor(() => expect(h.barHandlers).not.toBeNull());
    const candle = created.series.find((s) => s.kind === "Candlestick")!;
    act(() => h.barHandlers!.onBar({ timeSec: T0, open: 0.003628, high: 0.003628, low: 0.003628, close: 0.003628, volume: 0 }));
    await flushRaf();
    expect(candle.applyOptions).toHaveBeenCalledWith({ priceFormat: { type: "price", precision: 6, minMove: 0.000001 } });
  });

  it("draws Entry and Liq lines from the position, with memecoin prices intact", async () => {
    await mount();
    await waitFor(() => expect(created.series.some((s) => s.createPriceLine.mock.calls.length > 0)).toBe(true));
    const candle = created.series.find((s) => s.kind === "Candlestick")!;
    const titles = candle.createPriceLine.mock.calls.map((c) => [c[0].title, c[0].price]);
    expect(titles).toContainEqual(["Entry", 0.0034]);
    expect(titles).toContainEqual(["Liq", 0.0021]);
    expect(titles.map((t) => t[0])).not.toContain("Mark"); // on the Mark view the line would sit on the candle
  });

  it("on the Oracle view the Mark line appears and follows pushed ticks", async () => {
    const { store } = await mount();
    await waitFor(() => expect(h.tickHandlers).not.toBeNull());
    act(() => store.set("oracle"));
    await waitFor(() => expect(h.getBars.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(h.getBars.mock.calls.at(-1)![0].slab).toBe(SLAB);
    act(() => h.tickHandlers!.onTick(tick(1, 0.00346, 0.00345)));
    await waitFor(() => {
      const candle = created.series.filter((s) => s.kind === "Candlestick").at(-1)!;
      expect(candle.createPriceLine.mock.calls.map((c) => c[0].title)).toContain("Mark");
    });
    const candle = created.series.filter((s) => s.kind === "Candlestick").at(-1)!;
    act(() => h.tickHandlers!.onTick(tick(2, 0.00347, 0.00345)));
    await waitFor(() => {
      const markLine = candle.lines.find((l) => l.opts.title === "Mark")!;
      expect(markLine.applyOptions).toHaveBeenCalledWith(expect.objectContaining({ price: 0.00347 }));
    });
  });

  it("the Last series adds a volume plot and an honest empty state", async () => {
    h.getBars.mockResolvedValue({ bars: [], noMoreHistory: true, source: "percolator" });
    const { store } = await mount();
    act(() => store.set("last"));
    await waitFor(() => expect(created.series.some((s) => s.kind === "Histogram")).toBe(true));
    expect(await screen.findByText(/No trades on this market yet/i)).toBeInTheDocument();
  });

  describe("CoinGecko attribution (GeckoTerminal-sourced bars)", () => {
    const withDex = { bars: [bar(0, 100), bar(1, 101)], noMoreHistory: false, source: "perp-mark", dexThroughSec: T0 };
    it("is visible on the Mark series when pre-launch pool bars are shown, and links out", async () => {
      h.getBars.mockResolvedValue({ ...withDex, proxyBeforeSec: T0 + 900 });
      await mount();
      const a = await screen.findByTestId("coingecko-attribution");
      expect(a.textContent).toMatch(/Powered by CoinGecko/);
      expect(a.getAttribute("href")).toMatch(/^https:\/\/www\.coingecko\.com\//);
      expect(a.getAttribute("rel")).toContain("noopener");
    });
    it("is visible on the ORACLE series too (it was Mark-only before)", async () => {
      h.getBars.mockResolvedValue({ ...withDex, source: "perp-oracle" });
      const { store } = await mount();
      act(() => store.set("oracle"));
      expect(await screen.findByTestId("coingecko-attribution")).toBeInTheDocument();
    });
    it("is NOT shown when no bar came from GeckoTerminal (negative control)", async () => {
      await mount();
      await waitFor(() => expect(created.series.some((s) => s.kind === "Candlestick")).toBe(true));
      await new Promise((r) => setTimeout(r, 30));
      expect(screen.queryByTestId("coingecko-attribution")).toBeNull();
    });
    it("is not shown on the Last series, which never contains pool data", async () => {
      h.getBars.mockResolvedValue({ ...withDex, source: "percolator" });
      const { store } = await mount();
      act(() => store.set("last"));
      await waitFor(() => expect(h.getBars.mock.calls.length).toBeGreaterThanOrEqual(2));
      await new Promise((r) => setTimeout(r, 30));
      expect(screen.queryByTestId("coingecko-attribution")).toBeNull();
    });
  });

  it("an onReset from the data layer reloads history", async () => {
    await mount();
    await waitFor(() => expect(h.barHandlers).not.toBeNull());
    const before = h.getBars.mock.calls.length;
    await act(async () => { h.barHandlers!.onReset!(); });
    await waitFor(() => expect(h.getBars.mock.calls.length).toBe(before + 1));
  });

  it("a history failure shows the error state but still wires the live feed", async () => {
    h.getBars.mockRejectedValue(new Error("boom"));
    await mount();
    expect(await screen.findByText(/history is unavailable/i)).toBeInTheDocument();
    await waitFor(() => expect(h.barHandlers).not.toBeNull());
  });

  it("tears everything down on unmount", async () => {
    const { unmount } = await mount();
    await waitFor(() => expect(h.barHandlers).not.toBeNull());
    unmount();
    expect(h.barHandlers).toBeNull();
    expect(h.tickHandlers).toBeNull();
    expect(created.removed).toBe(1);
  });

  it("the header goes Offline with no ticks and Live right after one", async () => {
    await mount();
    expect(await screen.findByText("Offline")).toBeInTheDocument();
    await waitFor(() => expect(h.tickHandlers).not.toBeNull());
    act(() => h.tickHandlers!.onTick(tick(1, 1, 1)));
    expect(await screen.findByText(/^Live \d/)).toBeInTheDocument();
  });
});
