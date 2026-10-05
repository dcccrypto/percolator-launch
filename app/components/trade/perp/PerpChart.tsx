"use client";

/**
 * The perp-standard trade chart on lightweight-charts: Mark (default) / Oracle / Last candles,
 * pushed per tick, with entry / liquidation lines and a funding / OI / volume header.
 *
 * Data comes from the SAME ChartDataProvider the TradingView datafeed uses (lib/tv/data), so the
 * two engines can never disagree about what a candle is. The forming candle updates from keeper
 * ticks pushed over the price-ws socket (no polling); history is read once per (series,
 * resolution) and older pages are fetched as the user scrolls back.
 */
import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useChartTheme } from "@/hooks/useChartTheme";
import { useChartOverlayPrefs } from "@/hooks/useChartOverlayPrefs";
import { usePositionLinePrices } from "@/hooks/usePositionLinePrices";
import { usePerpHeaderStats } from "@/hooks/usePerpHeaderStats";
import { getChartDataProvider, getLiveClient } from "@/lib/tv/data";
import {
  RESOLUTION_SECONDS,
  type ProviderBar,
  type ProviderResolution,
} from "@/lib/tv/data/provider";
import { getSeriesStore, SERIES_LABEL } from "@/lib/chart/perp-series";
import { perpPricePrecision, formatPerpPrice } from "@/lib/chart/precision";
import { liqEdgeFromCoordinate } from "@/lib/chart-liq-edge";
import { ESTIMATE_LABEL } from "@/lib/entry-price-display";
import type { PerpSeries } from "@/lib/chart/perp-types";
import { LiqEdgeChip } from "../LiqEdgeChip";
import { ChartDisplayMenu } from "../ChartDisplayMenu";
import { ChartPnlBadge } from "../ChartPnlBadge";
import { DraggableChartBadges, PositionSummary } from "../ChartBadges";
import { PerpChartHeader, type LiveState } from "./PerpChartHeader";
import { PerpSeriesToggle } from "./PerpSeriesToggle";

const RESOLUTIONS: ReadonlyArray<{ label: string; res: ProviderResolution }> = [
  { label: "1m", res: "1" },
  { label: "5m", res: "5" },
  { label: "15m", res: "15" },
  { label: "1h", res: "60" },
  { label: "4h", res: "240" },
  { label: "1d", res: "1D" },
];
const DEFAULT_RES: ProviderResolution = "15";
const RES_STORAGE_KEY = "perc:chart:perp-res";
const INITIAL_BARS = 400;
const PAGE_BARS = 300;
const DELAYED_AFTER_MS = 10_000;
const OFFLINE_AFTER_MS = 60_000;

const toTime = (sec: number) => sec as UTCTimestamp;
const toCandle = (b: ProviderBar) => ({ time: toTime(b.timeSec), open: b.open, high: b.high, low: b.low, close: b.close });

function loadRes(): ProviderResolution {
  try {
    const v = window.localStorage.getItem(RES_STORAGE_KEY);
    if (RESOLUTIONS.some((r) => r.res === v)) return v as ProviderResolution;
  } catch { /* storage blocked */ }
  return DEFAULT_RES;
}

/** Opt-in latency probe for measurement: set window.__PERP_CHART_PROBE__ = [] before load. */
interface ProbeSample { slab: string; seq: number; landedMs: number; recvMs: number; wsMs: number; paintMs: number | null }
function probe(): ProbeSample[] | null {
  const w = window as unknown as { __PERP_CHART_PROBE__?: ProbeSample[] };
  return Array.isArray(w.__PERP_CHART_PROBE__) ? w.__PERP_CHART_PROBE__ : null;
}

interface Props {
  slabAddress: string;
  mintAddress?: string;
}

function PerpChartInner({ slabAddress }: Props) {
  const theme = useChartTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const [overlayPrefs, setOverlayPref] = useChartOverlayPrefs();
  const lines = usePositionLinePrices(slabAddress);

  const seriesStore = getSeriesStore();
  const series = useSyncExternalStore(seriesStore.subscribe, seriesStore.get, () => "mark" as PerpSeries);
  const [res, setResState] = useState<ProviderResolution>(DEFAULT_RES);
  useEffect(() => { setResState(loadRes()); }, []);
  const setRes = useCallback((r: ProviderResolution) => {
    setResState(r);
    try { window.localStorage.setItem(RES_STORAGE_KEY, r); } catch { /* ignore */ }
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const linesRef = useRef<{ mark?: IPriceLine; entry?: IPriceLine; liq?: IPriceLine }>({});
  const barsRef = useRef<ProviderBar[]>([]);

  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [proxyBefore, setProxyBefore] = useState<number | null>(null);
  const [proxyFrom, setProxyFrom] = useState<number | null>(null);
  // Any bar on screen sourced from GeckoTerminal / CoinGecko (pre-launch history): attribution is then mandatory.
  const [usesDex, setUsesDex] = useState(false);
  // Off-screen liquidation indicator (same behaviour as TradingChart's, #3102): price lines are not part of
  // the autoscale, so a liq far outside the candles is drawn past the canvas edge with nothing to show where
  // it went. `liqEdge` drives a chip pinned to the edge it hides behind; null = in view / no liq. The ref
  // mirrors it so the hot tick path only calls setState when the state flips.
  const [liqEdge, setLiqEdge] = useState<"above" | "below" | null>(null);
  const liqEdgeRef = useRef<"above" | "below" | null>(null);
  const liqPriceRef = useRef<number | null>(null);
  const [lastPrice, setLastPrice] = useState<number | null>(null); // the shown series' newest value
  const [markPrice, setMarkPrice] = useState<number | null>(null);
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(0);

  // ── chart instance (once) ────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const t = themeRef.current;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: t.bg }, textColor: t.textColor, fontSize: 11 },
      grid: { vertLines: { color: t.gridColor }, horzLines: { color: t.gridColor } },
      rightPriceScale: { borderColor: t.borderColor, scaleMargins: { top: 0.08, bottom: 0.18 } },
      timeScale: { borderColor: t.borderColor, timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
      linesRef.current = {};
    };
  }, []);

  // ── theme ────────────────────────────────────────────────────────────────
  useEffect(() => {
    chartRef.current?.applyOptions({
      layout: { background: { type: ColorType.Solid, color: theme.bg }, textColor: theme.textColor },
      grid: { vertLines: { color: theme.gridColor }, horzLines: { color: theme.gridColor } },
      rightPriceScale: { borderColor: theme.borderColor },
      timeScale: { borderColor: theme.borderColor },
    });
    candleRef.current?.applyOptions({
      upColor: theme.upColor, downColor: theme.downColor, borderUpColor: theme.upColor, borderDownColor: theme.downColor,
      wickUpColor: theme.upColor, wickDownColor: theme.downColor,
    });
  }, [theme]);

  // ── price lines (mark / entry / liq) ──────────────────────────────────────
  const setLine = useCallback((key: "mark" | "entry" | "liq", price: number | null, opts: { title: string; color: string; style: LineStyle; width: 1 | 2 }) => {
    const s = candleRef.current;
    if (!s) return;
    const cur = linesRef.current[key];
    if (price === null || !Number.isFinite(price) || price <= 0) {
      if (cur) { s.removePriceLine(cur); delete linesRef.current[key]; }
      return;
    }
    if (cur) cur.applyOptions({ price, color: opts.color, title: opts.title });
    else linesRef.current[key] = s.createPriceLine({ price, color: opts.color, lineWidth: opts.width, lineStyle: opts.style, axisLabelVisible: true, title: opts.title });
  }, []);

  // Recompute whether the liq line is off the top/bottom of the visible pane. One priceToCoordinate; stable
  // identity (reads through refs) so it can sit in effect deps and be called from tick / range callbacks.
  const recomputeLiqEdge = useCallback(() => {
    const series = candleRef.current;
    const container = containerRef.current;
    const price = liqPriceRef.current;
    let next: "above" | "below" | null = null;
    if (series && container && price != null) {
      const coord = (series.priceToCoordinate as (p: number) => number | null)(price);
      const axisH = chartRef.current?.timeScale().height() ?? 0; // price pane = chart height minus the time axis
      next = liqEdgeFromCoordinate(coord, container.clientHeight - axisH);
    }
    if (next !== liqEdgeRef.current) {
      liqEdgeRef.current = next;
      setLiqEdge(next);
    }
  }, []);

  // The Mark line is only drawn when the candles are NOT the mark (on the Mark view it would sit on the last candle).
  useEffect(() => {
    setLine("mark", series === "mark" ? null : markPrice, { title: "Mark", color: theme.neutralLine, style: LineStyle.Dashed, width: 1 });
  }, [series, markPrice, theme.neutralLine, setLine, status]);
  useEffect(() => {
    setLine("entry", overlayPrefs.entry ? lines.entry : null, { title: lines.entryIsEstimate ? `Entry ${ESTIMATE_LABEL}` : "Entry", color: theme.entryLine, style: LineStyle.Dashed, width: 1 });
  }, [lines.entry, lines.entryIsEstimate, overlayPrefs.entry, theme.entryLine, setLine, status]);
  useEffect(() => {
    const liq = overlayPrefs.liq ? lines.liq : null;
    liqPriceRef.current = liq != null && Number.isFinite(liq) && liq > 0 ? liq : null;
    setLine("liq", liq, { title: "Liq", color: theme.downColor, style: LineStyle.Solid, width: 2 });
    recomputeLiqEdge(); // the line was just (re)synced: refresh the chip to match
  }, [lines.liq, overlayPrefs.liq, theme.downColor, setLine, recomputeLiqEdge, status]);

  // ── data: history + push-fed forming candle, per (slab, series, resolution) ──
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    let cancelled = false;
    let offBars: (() => void) | null = null;
    let raf = 0;
    let pending: ProviderBar | null = null;
    let noMore = false;
    let paging = false;
    const provider = getChartDataProvider();
    const sizeSec = RESOLUTION_SECONDS[res];
    setStatus("loading");
    setUsesDex(false);

    // Fresh series objects per (series, resolution): a candle series cannot change its price format in place cleanly.
    const t = themeRef.current;
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: t.upColor, downColor: t.downColor, borderUpColor: t.upColor, borderDownColor: t.downColor,
      wickUpColor: t.upColor, wickDownColor: t.downColor, priceLineVisible: true, lastValueVisible: true,
    });
    candleRef.current = candle;
    const vol = series === "last" ? chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false }) : null;
    if (vol) chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volRef.current = vol;
    chart.applyOptions({ timeScale: { secondsVisible: res === "1" } });
    linesRef.current = {}; // the old series' lines died with it

    const setAll = (bars: ProviderBar[]) => {
      barsRef.current = bars;
      candle.setData(bars.map(toCandle));
      vol?.setData(bars.map((b) => ({ time: toTime(b.timeSec), value: b.volume, color: b.close >= b.open ? t.volUpColor : t.volDownColor })));
      const ref = bars.length ? bars[bars.length - 1].close : null;
      const pf = perpPricePrecision(ref);
      candle.applyOptions({ priceFormat: { type: "price", precision: pf.precision, minMove: pf.minMove } });
    };

    const flush = () => {
      raf = 0;
      const b = pending;
      pending = null;
      if (!b || cancelled) return;
      const arr = barsRef.current;
      const last = arr[arr.length - 1];
      if (last && b.timeSec < last.timeSec) return;
      if (!last) {
        // Live-only start (no history yet): the axis precision must come from this first price,
        // or a sub-cent market renders as "0.00".
        const pf = perpPricePrecision(b.close);
        candle.applyOptions({ priceFormat: { type: "price", precision: pf.precision, minMove: pf.minMove } });
      }
      if (last && last.timeSec === b.timeSec) arr[arr.length - 1] = b; else arr.push(b);
      candle.update(toCandle(b));
      vol?.update({ time: toTime(b.timeSec), value: b.volume, color: b.close >= b.open ? t.volUpColor : t.volDownColor });
      setLastPrice(b.close);
      recomputeLiqEdge(); // a drifting mark can autoscale the range and move the liq line in or out of view
      const p = probe();
      if (p) for (let i = p.length - 1; i >= 0 && p[i].paintMs === null; i--) p[i].paintMs = Date.now();
    };

    const load = async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      try {
        const page = await provider.getBars({
          slab: slabAddress, resolution: res, fromSec: nowSec - INITIAL_BARS * sizeSec, toSec: nowSec + 1,
          countBack: INITIAL_BARS, firstRequest: true,
        });
        if (cancelled) return;
        noMore = page.noMoreHistory;
        setProxyBefore(series === "mark" ? page.proxyBeforeSec ?? null : null);
        setProxyFrom(series === "mark" ? page.proxyFromSec ?? null : null);
        if (page.dexThroughSec != null) setUsesDex(true);
        setAll(page.bars);
        setLastPrice(page.bars.length ? page.bars[page.bars.length - 1].close : null);
        setStatus(page.bars.length ? "ready" : "empty");
        requestAnimationFrame(() => { if (!cancelled) recomputeLiqEdge(); }); // autoscale has settled on the new data
        if (page.bars.length) chart.timeScale().fitContent();
      } catch {
        if (!cancelled) setStatus("error");
      }
      if (cancelled) return;
      offBars = provider.subscribeBars(
        slabAddress, res,
        {
          onBar: (b) => {
            if (barsRef.current.length === 0) setStatus("ready");
            pending = b;
            if (!raf) raf = requestAnimationFrame(flush);
          },
          onReset: () => { if (!cancelled) { offBars?.(); offBars = null; void reload(); } },
        },
        barsRef.current[barsRef.current.length - 1] ?? null,
        null,
      );
    };
    const reload = async () => { barsRef.current = []; await load(); };

    // Scroll-back paging: when the user nears the left edge, fetch the page before the oldest bar.
    const onRange = async () => {
      recomputeLiqEdge(); // any pan/zoom can move the liq line in or out of view
      if (paging || noMore || barsRef.current.length === 0 || cancelled) return;
      const r = chart.timeScale().getVisibleLogicalRange();
      if (!r || r.from > 20) return;
      paging = true;
      try {
        const oldest = barsRef.current[0].timeSec;
        const page = await provider.getBars({
          slab: slabAddress, resolution: res, fromSec: oldest - PAGE_BARS * sizeSec, toSec: oldest,
          countBack: PAGE_BARS, firstRequest: false,
        });
        if (cancelled) return;
        noMore = page.noMoreHistory || page.bars.length === 0;
        if (page.dexThroughSec != null) setUsesDex(true);
        const older = page.bars.filter((b) => b.timeSec < oldest);
        if (older.length) {
          const before = chart.timeScale().getVisibleLogicalRange();
          setAll([...older, ...barsRef.current]);
          // setData resets the viewport: shift it right by the number of bars we prepended.
          if (before) chart.timeScale().setVisibleLogicalRange({ from: before.from + older.length, to: before.to + older.length });
        }
      } catch { /* TradingView-style: the next scroll retries */ }
      finally { paging = false; }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);

    void load();
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      offBars?.();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      try { chart.removeSeries(candle); if (vol) chart.removeSeries(vol); } catch { /* chart already removed */ }
      candleRef.current = null;
      volRef.current = null;
      linesRef.current = {};
      barsRef.current = [];
    };
  }, [slabAddress, series, res, recomputeLiqEdge]);

  // ── header feed: independent of the candle series (mark line, price, liveness) ──
  useEffect(() => {
    setMarkPrice(null);
    setLastTickAt(null);
    const live = getLiveClient();
    if (!live) return;
    const off = live.subscribe(slabAddress, {
      onTick: (m) => {
        const now = Date.now();
        if (m.mark !== null) setMarkPrice(m.mark);
        if (series === "oracle" && m.oracle !== null) setLastPrice(m.oracle);
        else if (series === "mark" && m.mark !== null) setLastPrice(m.mark);
        setLastTickAt(now);
        const p = probe();
        if (p) { p.push({ slab: slabAddress, seq: m.seq, landedMs: m.landedMs, recvMs: m.recvMs, wsMs: now, paintMs: null }); if (p.length > 2000) p.shift(); }
      },
    });
    return off;
  }, [slabAddress, series]);

  // 1 Hz re-render for the "age" readout only.
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const stats = usePerpHeaderStats(slabAddress, lastPrice, series);
  const ageMs = lastTickAt === null ? null : Date.now() - lastTickAt;
  void nowTick;
  const liveState: LiveState = ageMs === null ? "offline" : ageMs > OFFLINE_AFTER_MS ? "offline" : ageMs > DELAYED_AFTER_MS ? "delayed" : "live";

  return (
    <div className="flex h-[clamp(460px,68svh,700px)] w-full flex-col rounded-sm lg:h-full border border-[var(--border)] bg-[var(--panel-bg)]" data-testid="perp-chart">
      <PerpChartHeader price={lastPrice} stats={stats} live={liveState} ageSec={ageMs === null ? null : ageMs / 1000} seriesLabel={SERIES_LABEL[series]} />
      <div className="flex items-center gap-2 border-y border-[var(--border)] px-2 py-1">
        <PerpSeriesToggle value={series} onChange={(s) => seriesStore.set(s)} />
        {/* Off-screen liq indicator lives in the chrome strip, not over the chart area. */}
        <LiqEdgeChip edge={liqEdge} price={overlayPrefs.liq ? liqPriceRef.current : null} />
        <div className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto [scrollbar-width:none]" role="tablist" aria-label="Timeframe">
          {RESOLUTIONS.map((r) => (
            <button
              key={r.res}
              type="button"
              role="tab"
              aria-selected={r.res === res}
              onClick={() => setRes(r.res)}
              className={`min-h-8 shrink-0 px-2 text-[11px] ${r.res === res ? "text-[var(--accent)]" : "text-[var(--text-secondary)] hover:text-[var(--text)]"}`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <ChartDisplayMenu prefs={overlayPrefs} onToggle={setOverlayPref} />
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        {status !== "ready" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-[var(--text-muted)]">
            {status === "loading" ? "Loading chart…"
              : status === "error" ? "Chart history is unavailable right now. Live ticks will still draw."
              : series === "last" ? "No trades on this market yet."
              : "Waiting for the first price tick…"}
          </div>
        )}
        {status === "ready" && series !== "last" && ((series === "mark" && proxyBefore !== null) || usesDex) && (
          <div className="absolute bottom-7 left-2 flex max-w-[70%] flex-col gap-0.5 rounded-sm bg-[var(--bg)]/80 px-1.5 py-0.5 text-[9px] text-[var(--text-muted)]">
            {series === "mark" && proxyBefore !== null && (
              <span className="pointer-events-none">
                {proxyFrom !== null
                  ? `${new Date(proxyFrom * 1000).toLocaleDateString()} to ${new Date(proxyBefore * 1000).toLocaleDateString()}`
                  : `Before ${new Date(proxyBefore * 1000).toLocaleDateString()}`}
                : pool price where no mark was recorded
              </span>
            )}
            {usesDex && (
              <a
                href="https://www.coingecko.com/en/api"
                target="_blank"
                rel="noopener noreferrer"
                title="Pre-launch history comes from GeckoTerminal (CoinGecko)"
                data-testid="coingecko-attribution"
                className="underline decoration-dotted underline-offset-2 hover:text-[var(--text)]"
              >
                Powered by CoinGecko
              </a>
            )}
          </div>
        )}
        <DraggableChartBadges>
          {overlayPrefs.position && <PositionSummary slabAddress={slabAddress} />}
          {overlayPrefs.pnl && <ChartPnlBadge slabAddress={slabAddress} />}
        </DraggableChartBadges>
      </div>
      <span className="sr-only" aria-live="polite">{SERIES_LABEL[series]} chart, {res} timeframe</span>
    </div>
  );
}

export const PerpChart = memo(PerpChartInner);
