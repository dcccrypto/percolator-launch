"use client";

import { FC, useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  createChart,
  IChartApi,
  ISeriesApi,
  LineStyle,
  ColorType,
  CrosshairMode,
  CandlestickSeries,
  HistogramSeries,
  BarSeries,
  LineSeries,
  AreaSeries,
} from "lightweight-charts";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useTokenChart } from "@/hooks/useTokenChart";
import { usePythChart } from "@/hooks/usePythChart";
import { usePercolatorCandles } from "@/hooks/usePercolatorCandles";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { useMarketInfo } from "@/hooks/useMarketInfo";
import { useEngineState } from "@/hooks/useEngineState";
import { useLiqPrice } from "@/hooks/useLiqPrice";
import { useChartTheme } from "@/hooks/useChartTheme";
import { ChartEmptyState } from "./ChartEmptyState";
import { ChartStyleMenu } from "./ChartStyleMenu";
import { ChartDisplayMenu } from "./ChartDisplayMenu";
import { ChartPnlBadge } from "./ChartPnlBadge";
import { computeRef24h, computePriceChange } from "@/lib/chart-stats";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockUserAccount } from "@/lib/mock-trade-data";
import { getEntryPrice } from "@/lib/entry-price";
import { useChartStylePref } from "@/hooks/useChartStylePref";
import { useChartOverlayPrefs } from "@/hooks/useChartOverlayPrefs";
import { useChartIndicatorPrefs } from "@/hooks/useChartIndicatorPrefs";
import { isOverlayKind, isPaneKind } from "@/lib/indicator-registry";
import { useIndicatorOverlays } from "./useIndicatorOverlays";
import { useIndicatorOscillatorPane } from "./useIndicatorOscillatorPane";
import { ChartIndicatorMenu } from "./ChartIndicatorMenu";
import { ChartDrawingOverlay } from "./ChartDrawingOverlay";
import { ChartDrawingToolbar } from "./ChartDrawingToolbar";
import { useChartDrawingTool } from "@/hooks/useChartDrawingTool";
import { useChartDrawings } from "@/hooks/useChartDrawings";
import {
  isCandleStyle,
  candleStyleOptions,
  chartDataKind,
  hasRenderableData,
  type ChartSeriesKind,
} from "@/lib/chart-style";
import { assertNever } from "@/lib/exhaustive";
import { formatUsdFromNumber } from "@/lib/format";

// Phase 2: added 15m timeframe
type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "7d" | "30d";

interface PricePoint {
  timestamp: number;
  price: number;
}

const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const CANDLE_INTERVAL_MS = 5 * 60 * 1000;

/** Oracle price history uses unix seconds; external chart candles use ms (Prompt 89). */
function pricePointTimestampToMs(t: number): number {
  if (!Number.isFinite(t) || t <= 0) return Date.now();
  return t < 100_000_000_000 ? t * 1000 : t;
}

// PERC-8090: removed 7d/30d from TIMEFRAMES — too exotic for a perps UI
const VISIBLE_TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

// Phase 2: timeframes that benefit from auto-polling
const POLLING_TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

function aggregateCandles(prices: PricePoint[], intervalMs: number) {
  if (prices.length === 0) return [];
  const candles: { timestamp: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  let current: (typeof candles)[0] | null = null;
  prices.forEach((point) => {
    const candleStart = Math.floor(point.timestamp / intervalMs) * intervalMs;
    if (!current || current.timestamp !== candleStart) {
      if (current) candles.push(current);
      current = { timestamp: candleStart, open: point.price, high: point.price, low: point.price, close: point.price, volume: 0 };
    } else {
      current.high = Math.max(current.high, point.price);
      current.low = Math.min(current.low, point.price);
      current.close = point.price;
    }
  });
  if (current) candles.push(current);
  return candles;
}

// Phase 2: compact position summary shown on chart when wallet is connected
interface PositionSummaryProps {
  slabAddress: string;
}

function PositionSummary({ slabAddress }: PositionSummaryProps) {
  const realUserAccount = useUserAccount();
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const userAccount = realUserAccount ?? (mockMode ? getMockUserAccount(slabAddress) : null);

  if (!userAccount) return null;
  const { account } = userAccount;
  if (account.positionSize === 0n) return null;

  const isLong = account.positionSize > 0n;
  const direction = isLong ? "LONG" : "SHORT";
  const dirColor = isLong ? "text-green-400" : "text-red-400";

  return (
    <div className="absolute top-2 right-2 z-10 flex items-center gap-1.5 rounded-none border border-[var(--border)]/60 bg-[var(--bg)]/90 px-2 py-1 backdrop-blur-sm">
      <span className={`text-[9px] font-bold uppercase tracking-[0.12em] ${dirColor}`}>{direction}</span>
      <span className="text-[9px] text-[var(--text-dim)]">position open</span>
    </div>
  );
}

/**
 * Map a market's underlying-asset symbol to the Pyth Benchmarks feed symbol.
 * Pyth feeds follow `Crypto.<ASSET>/USD` naming. Keep the list tight — the
 * server-side API route has the same allowlist and will reject anything not
 * on it. Extending the allowlist means updating BOTH here and
 * `/api/chart/pyth/route.ts`.
 */
function pythSymbolForAsset(assetSymbol: string | null | undefined): string | null {
  if (!assetSymbol) return null;
  const s = assetSymbol.trim().toUpperCase();
  if (!s) return null;
  const supported = new Set(["SOL", "BTC", "ETH", "JUP", "JTO", "WIF", "BONK", "PYTH"]);
  return supported.has(s) ? `Crypto.${s}/USD` : null;
}

export const TradingChart: FC<{ slabAddress: string; mintAddress?: string }> = ({
  slabAddress,
  mintAddress,
}) => {
  const { config } = useSlabState();
  const { priceUsd } = useLivePrice();
  const chartTheme = useChartTheme();
  const [chartStyle, setChartStyle] = useChartStylePref();
  const [overlayPrefs, setOverlayPref] = useChartOverlayPrefs();
  const {
    indicators,
    addIndicator,
    removeIndicator,
    updateIndicator,
    clearAll: clearAllIndicators,
  } = useChartIndicatorPrefs(slabAddress);
  const { tool: drawingTool, setTool: setDrawingTool } = useChartDrawingTool();
  const {
    drawings,
    addDrawing,
    deleteDrawing,
    clearAll: clearAllDrawings,
  } = useChartDrawings(slabAddress);
  const [timeframe, setTimeframe] = useState<Timeframe>("1d");
  const [oraclePrices, setOraclePrices] = useState<PricePoint[]>([]);

  // Resolve the Pyth Benchmarks feed for this market. For SOL/USDC perp the
  // underlying is SOL → `Crypto.SOL/USD`. Non-mapped assets fall through to
  // the GeckoTerminal pool-history path and then to oracle aggregation.
  const marketInfoForSymbol = useMarketInfo(slabAddress);
  const pythSymbol = pythSymbolForAsset(marketInfoForSymbol.market?.symbol);

  // Phase 2: liq price overlay
  const realUserAccount = useUserAccount();
  const marketConfig = useMarketConfig();
  const { params } = useSlabState();
  const liqPriceE6 = useLiqPrice();

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // Flips true once the chart-init effect has populated chartRef.current,
  // back to false on unmount. Provides a reactive trigger for downstream
  // hooks (useIndicatorOverlays) that need to attach series to the chart
  // — refs alone can't drive an effect since they don't trigger re-runs.
  const [chartReady, setChartReady] = useState(false);
  const seriesRef = useRef<ISeriesApi<ChartSeriesKind> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const priceLineRef = useRef<ReturnType<ISeriesApi<"Candlestick">["createPriceLine"]> | null>(null);
  const liqLineRef = useRef<ReturnType<ISeriesApi<"Candlestick">["createPriceLine"]> | null>(null);
  const entryLineRef = useRef<ReturnType<ISeriesApi<"Candlestick">["createPriceLine"]> | null>(null);
  // Track whether we've done the initial viewport fit for the current
  // timeframe/chart-type/data-source. Without this, calling fitContent() on
  // every poll (new bar arrives every ~30s for Pyth / 60s for GeckoTerminal)
  // wipes out any user pan/zoom — the chart snaps back to "all bars visible"
  // and the user can't stay zoomed in.
  const fitKeyRef = useRef<string>("");

  // Crosshair-hover OHLCV readout. Populated via chart.subscribeCrosshairMove;
  // rendered as a floating tooltip overlay inside the chart container.
  const [hoverBar, setHoverBar] = useState<{
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    isCandle: boolean;
  } | null>(null);

  // Prefer Pyth Benchmarks (canonical global spot price; deep history) when
  // the market's underlying asset has a Pyth feed. Same data source Hyperliquid
  // / Drift / Jupiter Perps use — shows real SOL/USD history back days/years,
  // not just the last 24 h of our keeper observations.
  const {
    candles: pythCandles,
    status: pythStatus,
  } = usePythChart(pythSymbol, timeframe);

  // Fallback source: GeckoTerminal via the mint's DEX pool. Used when no Pyth
  // feed is mapped for this asset (e.g. long-tail tokens).
  const {
    candles: externalCandles,
    status: externalStatus,
    poolAddress,
  } = useTokenChart(mintAddress ?? null, timeframe);

  // Tier-0: Percolator's own internal-trade candles. Preferred when the slab
  // has active match-engine volume, because these reflect OUR fills rather
  // than Pyth's spot tape — and update live via the trades:<slab> WS channel.
  const {
    candles: percolatorCandlesRaw,
    status: percolatorStatus,
  } = usePercolatorCandles(slabAddress ?? null, timeframe);

  // Convert from {time: unix-seconds} to {timestamp: ms} shape used by the chart.
  // Memoed so identity is stable between renders that don't change the source
  // array — without this, every parent render (live-price tick, crosshair
  // hover, etc.) produces a fresh array, which cascades into candleData →
  // indicator hooks → full series remove+recreate at WS cadence.
  const percolatorCandles = useMemo(
    () => percolatorCandlesRaw.map((c) => ({
      timestamp: c.time * 1000,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    })),
    [percolatorCandlesRaw],
  );

  // Prefer Percolator as the chart source only when it has enough coverage to
  // form a readable chart. With 1–2 candles against a 24 h window, the tier-0
  // source produces a mostly-empty chart that looks broken — Pyth's deep spot
  // history is a better background until real internal volume arrives.
  //
  // The user's fill is still visible: the Entry price line renders on top of
  // whichever source is showing, so a new trader sees their entry against
  // Pyth's SOL/USD context before Percolator has enough bars to stand alone.
  //
  // Two exceptions where Percolator still wins below the threshold: (a) Pyth
  // returned no data for this asset (long-tail token), or (b) Pyth errored.
  // In either case "any Percolator data" is strictly better than nothing.
  const MIN_PERC_BARS = 10;
  const percHasEnough =
    percolatorStatus === "success" && percolatorCandles.length >= MIN_PERC_BARS;
  const pythHasNothing =
    (pythStatus === "success" && pythCandles.length === 0) || pythStatus === "error";
  const hasPercolatorData =
    percolatorStatus === "success" &&
    percolatorCandles.length > 0 &&
    (percHasEnough || pythHasNothing);
  const hasPythData = !hasPercolatorData && pythStatus === "success" && pythCandles.length > 0;
  const hasExternalData = !hasPercolatorData && !hasPythData && externalStatus === "success" && externalCandles.length > 0;

  // Fetch oracle price history
  useEffect(() => {
    fetch(`/api/markets/${slabAddress}/prices`)
      .then((r) => r.json())
      .then((d) => {
        const apiPrices = (d.prices ?? []).map((p: { price_e6: string; timestamp: number }) => ({
          timestamp: pricePointTimestampToMs(p.timestamp),
          price: parseInt(p.price_e6) / 1e6,
        }));
        // lightweight-charts requires strictly ascending timestamps; sort defensively
        // in case the API returns prices in an unexpected order.
        apiPrices.sort((a: PricePoint, b: PricePoint) => a.timestamp - b.timestamp);
        setOraclePrices(apiPrices);
      })
      .catch(() => {});
  }, [slabAddress]);

  // Live price updates
  useEffect(() => {
    if (!config || !priceUsd) return;
    const now = Date.now();
    setOraclePrices((prev) => {
      const last = prev[prev.length - 1];
      if (last && now - last.timestamp < 5000) return prev;
      return [...prev, { timestamp: now, price: priceUsd }].slice(-1000);
    });
  }, [config, priceUsd]);

  // Derive data. Memoed because oraclePrices only changes on the 5s-gated
  // live-price effect (line ~287), so the filtered slice is reference-stable
  // between most renders. Same WS-tick churn argument as percolatorCandles
  // above — without this, candleData's memo invalidates on every tick.
  const oracleFiltered = useMemo(
    () => {
      const cutoff = Date.now() - TIMEFRAME_MS[timeframe];
      return oraclePrices.filter((p) => p.timestamp >= cutoff);
    },
    [oraclePrices, timeframe],
  );

  // Data source priority: Percolator internal trades (tier-0, when >=10 bars) →
  // Pyth Benchmarks (canonical spot) → GeckoTerminal (DEX-pool history for
  // long-tail tokens) → oracle-aggregated fallback (keeper observations).
  //
  // Memoed so the reference is stable between renders that don't change the
  // underlying source arrays. Without this, every parent render (e.g. on
  // unrelated state like timeframe-pill hover) creates a new array, which
  // re-fires the indicator hooks' effects and tears down + reallocates the
  // oscillator pane on every WebSocket tick.
  const candleData = useMemo(() => {
    if (hasPercolatorData) return percolatorCandles;
    if (hasPythData) return pythCandles as { timestamp: number; open: number; high: number; low: number; close: number; volume: number }[];
    if (hasExternalData) return externalCandles as { timestamp: number; open: number; high: number; low: number; close: number; volume: number }[];
    return aggregateCandles(oracleFiltered, CANDLE_INTERVAL_MS);
  }, [hasPercolatorData, hasPythData, hasExternalData, percolatorCandles, pythCandles, externalCandles, oracleFiltered]);

  const lineData = useMemo(() => {
    if (hasPercolatorData) return percolatorCandles.map((c) => ({ timestamp: c.timestamp, price: c.close }));
    if (hasPythData) return pythCandles.map((c) => ({ timestamp: c.timestamp, price: c.close }));
    if (hasExternalData) return externalCandles.map((c) => ({ timestamp: c.timestamp, price: c.close }));
    return oracleFiltered;
  }, [hasPercolatorData, hasPythData, hasExternalData, percolatorCandles, pythCandles, externalCandles, oracleFiltered]);

  const totalDataPoints = candleData.length + lineData.length;

  // GH#1625: sparse-data guard. Routes through the SoT helper so area and
  // bar correctly trigger the overlay too — they used to fall through the
  // ad-hoc candle+line predicate.
  const { sparse: effectiveSparse } = hasRenderableData(chartStyle, candleData, lineData);

  // Phase 2: volume has data (used to show empty state in volume pane)
  const hasVolumeData = candleData.some((c) => (c.volume ?? 0) > 0);

  // Indicator overlays (SMA / EMA / Bollinger). Memo the filtered subset so
  // the overlay hook's effect only re-runs when the user actually adds /
  // removes / edits an indicator — not on every WebSocket price tick (which
  // would churn series remove+recreate at 250ms cadence).
  const overlayIndicatorConfigs = useMemo(
    () => indicators.filter((i) => isOverlayKind(i.kind)),
    [indicators],
  );
  useIndicatorOverlays(chartRef, chartReady, candleData, overlayIndicatorConfigs);

  // Oscillator-pane indicators (RSI / MACD). Same memo discipline. The pane
  // is allocated lazily inside the hook — empty pane configs collapses the
  // pane and the chart fills the reclaimed vertical space.
  const paneIndicatorConfigs = useMemo(
    () => indicators.filter((i) => isPaneKind(i.kind)),
    [indicators],
  );
  useIndicatorOscillatorPane(chartRef, chartReady, candleData, paneIndicatorConfigs, chartTheme);

  // Create/destroy chart
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: chartTheme.bg },
        textColor: chartTheme.textColor,
      },
      grid: {
        vertLines: { color: chartTheme.gridColor },
        horzLines: { color: chartTheme.gridColor },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: chartTheme.borderColor,
        // Leave a sliver of headroom/footroom so price labels don't clip
        // against the top/bottom edge of the canvas.
        scaleMargins: { top: 0.08, bottom: 0.12 },
      },
      timeScale: {
        borderColor: chartTheme.borderColor,
        timeVisible: true,
        secondsVisible: false,
        // rightOffset reserves space to the right of the last bar so the
        // crosshair can hover past the last candle without getting clipped,
        // matching TradingView/Binance behaviour.
        rightOffset: 8,
        barSpacing: 8,
        // Keep visual consistency; don't let the user drag past the start.
        fixLeftEdge: false,
        fixRightEdge: false,
      },
      // Scroll + scale handles default to true but make the intent explicit
      // so any future refactor doesn't silently disable pan/zoom.
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    });

    chartRef.current = chart;
    // Preserve the default price pane when momentarily empty. The
    // price-series effect below remove-and-re-adds the price series on
    // every dep change (priceUsd tick, theme switch, etc.), and v5
    // auto-destroys empty panes whenever any other panes exist. With
    // RSI / MACD oscillator panes active, the brief empty window
    // between removeSeries(price) and addSeries(price) was triggering
    // v5 to compact pane 0 out of existence — the pane indices then
    // shifted (the first oscillator pane became pane 0), and the next
    // addSeries(price) defaulted into the oscillator pane, dumping the
    // price line on top of the indicator. Setting preserveEmptyPane
    // keeps pane 0 alive across the empty window.
    chart.panes()[0]?.setPreserveEmptyPane(true);
    setChartReady(true);

    return () => {
      setChartReady(false);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeSeriesRef.current = null;
      priceLineRef.current = null;
      liqLineRef.current = null;
      entryLineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply theme changes to existing chart without recreating it
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: chartTheme.bg },
        textColor: chartTheme.textColor,
      },
      grid: {
        vertLines: { color: chartTheme.gridColor },
        horzLines: { color: chartTheme.gridColor },
      },
      rightPriceScale: { borderColor: chartTheme.borderColor },
      timeScale: { borderColor: chartTheme.borderColor },
    });
  }, [chartTheme]);

  // Derive entry price from user account
  const entryPriceNum = (() => {
    const ua = realUserAccount;
    if (!ua) return null;
    const ep = ua.account.entryPrice;
    const resolvedEntryPrice =
      ep != null && ep > 0n ? ep : getEntryPrice(slabAddress, ua.idx);
    if (resolvedEntryPrice <= 0n) return null;
    return Number(resolvedEntryPrice) / 1e6;
  })();

  // Update series when data or chartStyle changes
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // Remove old series
    if (seriesRef.current) {
      chart.removeSeries(seriesRef.current);
      seriesRef.current = null;
    }
    if (volumeSeriesRef.current) {
      chart.removeSeries(volumeSeriesRef.current);
      volumeSeriesRef.current = null;
    }
    priceLineRef.current = null;
    liqLineRef.current = null;
    entryLineRef.current = null;

    // Series selection.
    //
    // The switch is exhaustive over ChartStyle: a future variant added to
    // ALL_STYLES without a matching case here fails the build at the
    // assertNever default rather than silently rendering nothing.
    //
    // All four candle variants share one fall-through body — they all use
    // addCandlestickSeries with different colour presets via candleStyleOptions.
    // Bar series also reads OHLC candleData; line and area both read the
    // single-value lineData stream.
    //
    // Overlay lines (Mark / Liq / Entry) are added per series via the local
    // addOverlayLines() helper to keep each case body small. They use the
    // generic ISeriesApi.createPriceLine API which all series types support.
    const addOverlayLines = (s: ISeriesApi<ChartSeriesKind>) => {
      // Mark price line
      if (priceUsd != null) {
        priceLineRef.current = s.createPriceLine({
          price: priceUsd,
          color: "rgba(255,255,255,0.6)",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "Mark",
        });
      }
      // Liq price overlay
      const liqPriceNum = liqPriceE6 != null && liqPriceE6 > 0n ? Number(liqPriceE6) / 1e6 : null;
      if (overlayPrefs.liq && liqPriceNum != null && liqPriceNum > 0) {
        liqLineRef.current = s.createPriceLine({
          price: liqPriceNum,
          color: "#ef4444",
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: "Liq",
        });
      }
      // Entry price overlay — cyan dashed when position is open
      if (overlayPrefs.entry && entryPriceNum != null && entryPriceNum > 0) {
        entryLineRef.current = s.createPriceLine({
          price: entryPriceNum,
          color: "#22d3ee",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "Entry",
        });
      }
    };

    switch (chartStyle) {
      case "candle-solid":
      case "candle-hollow":
      case "candle-hollow-up":
      case "candle-hollow-down": {
        if (!hasRenderableData(chartStyle, candleData, lineData).ready) break;
        const series = chart.addSeries(CandlestickSeries, {
          ...candleStyleOptions(chartStyle, chartTheme.upColor, chartTheme.downColor),
          // Suppress lightweight-charts' built-in last-price label + horizontal
          // price line. Those show the DEX pool's last candle close (e.g. 84.20)
          // which is NOT our mark price (84.33) — users saw two prices on the
          // chart and couldn't tell which was authoritative. Our explicit
          // createPriceLine below draws the mark price as the only price label.
          lastValueVisible: false,
          priceLineVisible: false,
        });

        const formatted = candleData.map((c) => ({
          time: (Math.floor(c.timestamp / 1000)) as import("lightweight-charts").UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }));
        series.setData(formatted);
        seriesRef.current = series;

        // Volume histogram — only render when the active data source has real
        // trade volume. Pyth Benchmarks returns v=0 for every bar (it's a price
        // feed, not a trade tape); painting a sentinel 0.001 for every bar made
        // the pane render as a meaningless flat red/green band auto-scaled to
        // fill the full pane. Hide the series entirely in that case and let the
        // candles reclaim the bottom 10% of vertical space instead.
        if (hasVolumeData) {
          const volumeSeries = chart.addSeries(HistogramSeries, {
            priceFormat: { type: "volume" },
            priceScaleId: "volume",
          });
          chart.priceScale("volume").applyOptions({
            scaleMargins: { top: 0.90, bottom: 0 },
          });
          const volumeData = candleData.map((c) => ({
            time: (Math.floor(c.timestamp / 1000)) as import("lightweight-charts").UTCTimestamp,
            value: c.volume ?? 0,
            color: c.close >= c.open ? chartTheme.volUpColor : chartTheme.volDownColor,
          }));
          volumeSeries.setData(volumeData);
          volumeSeriesRef.current = volumeSeries;
        } else {
          // No volume pane — reclaim the bottom margin for the candle series.
          series.priceScale().applyOptions({
            scaleMargins: { top: 0.08, bottom: 0.04 },
          });
        }

        addOverlayLines(series);
        break;
      }
      case "bar": {
        if (!hasRenderableData(chartStyle, candleData, lineData).ready) break;
        const series = chart.addSeries(BarSeries, {
          upColor: chartTheme.upColor,
          downColor: chartTheme.downColor,
          openVisible: true,
          // Keep proportional bar widths (matches v4 behaviour). v5 still
          // accepts this option but flipped the default to `true`, which
          // would render visibly thinner bars without this explicit override.
          thinBars: false,
          lastValueVisible: false,
          priceLineVisible: false,
        });
        const formatted = candleData.map((c) => ({
          time: (Math.floor(c.timestamp / 1000)) as import("lightweight-charts").UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }));
        series.setData(formatted);
        seriesRef.current = series;
        addOverlayLines(series);
        break;
      }
      case "line": {
        if (!hasRenderableData(chartStyle, candleData, lineData).ready) break;
        const series = chart.addSeries(LineSeries, {
          color: chartTheme.upColor,
          lineWidth: 2,
          // Same rationale as candle series — only the mark price should show
          // as a price-axis label. DEX last-close goes away.
          lastValueVisible: false,
          priceLineVisible: false,
        });
        const formatted = lineData.map((p) => ({
          time: (Math.floor(p.timestamp / 1000)) as import("lightweight-charts").UTCTimestamp,
          value: p.price,
        }));
        series.setData(formatted);
        seriesRef.current = series;
        addOverlayLines(series);
        break;
      }
      case "area": {
        if (!hasRenderableData(chartStyle, candleData, lineData).ready) break;
        // Brand purple (--accent in globals.css) gives the area mode a distinct
        // identity vs. the green line series — same data, different feel.
        const ACCENT = "#9945FF";
        const series = chart.addSeries(AreaSeries, {
          lineColor: ACCENT,
          topColor: `${ACCENT}66`,    // ~40% alpha at the top
          bottomColor: `${ACCENT}00`, // fade to transparent at the bottom
          lineWidth: 2,
          lastValueVisible: false,
          priceLineVisible: false,
        });
        const formatted = lineData.map((p) => ({
          time: (Math.floor(p.timestamp / 1000)) as import("lightweight-charts").UTCTimestamp,
          value: p.price,
        }));
        series.setData(formatted);
        seriesRef.current = series;
        addOverlayLines(series);
        break;
      }
      default:
        return assertNever(chartStyle);
    }

    // Crosshair-hover OHLCV readout. Publishes the bar under the cursor to
    // hoverBar state so the overlay tooltip can render it. Clears on leave.
    const crosshairHandler = (param: Parameters<Parameters<IChartApi["subscribeCrosshairMove"]>[0]>[0]) => {
      if (!param.time || !param.point || !seriesRef.current) {
        setHoverBar(null);
        return;
      }
      const data = param.seriesData.get(seriesRef.current) as
        | { open?: number; high?: number; low?: number; close?: number; value?: number }
        | undefined;
      if (!data) {
        setHoverBar(null);
        return;
      }
      let volume = 0;
      if (volumeSeriesRef.current) {
        const v = param.seriesData.get(volumeSeriesRef.current) as { value?: number } | undefined;
        if (v?.value != null) volume = v.value;
      }
      const isCandle = data.open != null && data.high != null && data.low != null && data.close != null;
      setHoverBar({
        time: Number(param.time),
        open: data.open ?? data.value ?? 0,
        high: data.high ?? data.value ?? 0,
        low: data.low ?? data.value ?? 0,
        close: data.close ?? data.value ?? 0,
        volume,
        isCandle,
      });
    };
    chart.subscribeCrosshairMove(crosshairHandler);

    // Only fit the content to viewport on the FIRST render for the current
    // (timeframe, data-kind, data source) combo. Subsequent polls just
    // update-in-place so the user's pan/zoom is preserved.
    //
    // Bucket by data shape (chartDataKind): candle variants + bar all read
    // OHLC; line + area both read the single-value lineData stream. Flipping
    // between styles that share a data source preserves pan/zoom; only
    // switching kinds (candle ↔ line) refits the viewport.
    const source = hasPercolatorData
      ? "percolator"
      : hasPythData
        ? "pyth"
        : hasExternalData
          ? "dex"
          : "oracle";
    const fitKey = `${chartDataKind(chartStyle)}:${timeframe}:${source}`;
    if (fitKeyRef.current !== fitKey) {
      chart.timeScale().fitContent();
      fitKeyRef.current = fitKey;
    }

    return () => {
      chart.unsubscribeCrosshairMove(crosshairHandler);
    };
  }, [chartStyle, timeframe, candleData, lineData, priceUsd, liqPriceE6, entryPriceNum, chartTheme, hasPercolatorData, hasPythData, hasExternalData, overlayPrefs.entry, overlayPrefs.liq]);

  // Update mark price line when live price changes
  useEffect(() => {
    if (priceLineRef.current && priceUsd != null) {
      priceLineRef.current.applyOptions({ price: priceUsd });
    }
  }, [priceUsd]);

  // Header % change is ALWAYS trailing 24 h vs current — the industry
  // convention users expect, independent of what timeframe/zoom they picked.
  // Extracted into a pure helper so the daily-bar edge case (cutoff falls
  // inside the current day's bar, making the delta always 0) can be unit-tested.
  const activeData = lineData.length > 0 ? lineData : oracleFiltered;
  const currentPrice = activeData[activeData.length - 1]?.price ?? priceUsd ?? 0;
  const ref24h = computeRef24h(activeData, timeframe, currentPrice);
  const { priceChange, priceChangePercent, isUp } = computePriceChange(currentPrice, ref24h);

  // GH#1652: do NOT early-return here — the chart container must always mount
  // so that lightweight-charts can create its canvas. Sparse/empty state is
  // rendered as an overlay inside the container below.
  const showEmptyOverlay = totalDataPoints === 0 || effectiveSparse;

  return (
    <div className="rounded-none border border-[var(--border)] bg-[var(--bg)] p-3">
      {/* Header — shows timeframe % change + data-source badge only.
          The DEX pool's last-close price used to live here too (e.g. "$84.20 DEX")
          but that contradicted the mark price shown in the market info bar above,
          and the only price on the chart should be the mark. */}
      <div className="mb-3 flex flex-wrap items-start justify-between gap-y-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: isUp ? "var(--long)" : "var(--short)" }}>
              {isUp ? "+" : ""}{priceChange.toFixed(4)} ({isUp ? "+" : ""}{priceChangePercent.toFixed(2)}%)
            </span>
            {hasPercolatorData ? (
              <span
                className="text-[9px] font-medium uppercase tracking-[0.08em] px-1.5 py-0.5 rounded-sm"
                style={{ background: "var(--accent)/0.1", color: "var(--accent)", border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)" }}
                title="Source: Percolator match engine (internal trades)"
              >
                PERC
              </span>
            ) : hasPythData ? (
              <span
                className="text-[9px] font-medium uppercase tracking-[0.08em] px-1.5 py-0.5 rounded-sm"
                style={{ background: "var(--accent)/0.1", color: "var(--accent)", border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)" }}
                title={`Source: Pyth Benchmarks · ${pythSymbol}`}
              >
                PYTH
              </span>
            ) : hasExternalData ? (
              <span
                className="text-[9px] font-medium uppercase tracking-[0.08em] px-1.5 py-0.5 rounded-sm"
                style={{ background: "var(--accent)/0.1", color: "var(--accent)", border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)" }}
                title={poolAddress ? `GeckoTerminal pool: ${poolAddress}` : "Source: GeckoTerminal"}
              >
                DEX
              </span>
            ) : (
              mintAddress && externalStatus !== "idle" && (
                <span
                  className="text-[9px] font-medium uppercase tracking-[0.08em] px-1.5 py-0.5 rounded-sm"
                  style={{ background: "var(--bg-elevated)", color: "var(--text-dim)", border: "1px solid var(--border)" }}
                  title="Showing oracle price history (no DEX data found)"
                >
                  Oracle
                </span>
              )
            )}
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <ChartStyleMenu value={chartStyle} onChange={setChartStyle} />
          <ChartDisplayMenu prefs={overlayPrefs} onToggle={setOverlayPref} />
          <ChartIndicatorMenu
            indicators={indicators}
            addIndicator={addIndicator}
            removeIndicator={removeIndicator}
            updateIndicator={updateIndicator}
            clearAll={clearAllIndicators}
          />

          {/* PERC-8090: 1m/5m/15m/1h/4h/1d only — 7d/30d collapsed */}
          <div className="flex gap-1 rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5">
            {VISIBLE_TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={`rounded-none px-1.5 sm:px-2 py-1 text-xs transition-colors ${
                  timeframe === tf
                    ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] hover:text-[var(--text)]"
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Chart container — relative so PositionSummary overlay can be absolute */}
      {/* Phase 2: mobile uses 40svh, desktop keeps 500px */}
      {/* overflow-hidden clips lightweight-charts toolbar/navigation buttons so they
          cannot escape the chart boundary and bleed into adjacent stat grid cells
          (GH#1647: ◀ 32 ▶ ✕ appearing in ACCOUNTS cell of STATS tab)
          GH#1660: `contain: paint` creates a new paint containment boundary so lw-charts
          absolutely-positioned nav buttons are painted within this element only,
          preventing them from bleeding into sibling DOM at 1440px desktop. */}
      <div className="relative overflow-hidden [contain:paint]">
        {/* GH#1652: always mount the container so lightweight-charts canvas initialises.
            The chart ref is always created in useEffect; empty-state is overlaid on top
            when candles=[] so the canvas element exists in the DOM on first render. */}
        {/* Bumped desktop height 500 → 620 so the time axis has room to render
            below the candles + volume pane without getting visually clipped. */}
        <div ref={containerRef} className="w-full h-[45svh] lg:h-[620px]" />

        {/* User-drawing overlay: transparent canvas tracking the chart
            container's dimensions, layered above the chart canvas via DOM
            order (no explicit z) but below the empty-state / hover-tooltip
            / position-summary badges (which sit at z-10). pointer-events
            stay disabled — drawing-tool clicks route through
            chart.subscribeClick so native pan/zoom keep working.

            Gated on !showEmptyOverlay alongside the toolbar: the
            empty-state's 91%-alpha backdrop would otherwise ghost
            persisted drawings through the wash with no toolbar to
            clear them — a UX dead-end on sparse markets. Unmounting
            the overlay drops the canvas entirely; drawings re-appear
            (still per-slab in localStorage) the moment data populates
            and the empty-state lifts. */}
        {!showEmptyOverlay && (
          <ChartDrawingOverlay
            chartRef={chartRef}
            seriesRef={seriesRef}
            containerRef={containerRef}
            chartReady={chartReady}
            drawings={drawings}
            addDrawing={addDrawing}
            deleteDrawing={deleteDrawing}
            tool={drawingTool}
            setTool={setDrawingTool}
            slabAddress={slabAddress}
          />
        )}

        {/* Drawing tools toolbar — vertical bar at the chart's left edge.
            Hidden below the md breakpoint (touch interaction patterns
            for drawing tools are out of scope for v1) AND hidden when
            the empty-state overlay is shown (no chart to draw on, so
            the toolbar would be a dead interaction). */}
        {!showEmptyOverlay && (
          <ChartDrawingToolbar
            tool={drawingTool}
            setTool={setDrawingTool}
            drawingCount={drawings.length}
            clearAll={clearAllDrawings}
          />
        )}

        {/* GH#1652: empty-state overlay — shown when no data yet, sits above canvas */}
        {showEmptyOverlay && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center backdrop-blur-[1px]" style={{ background: `${chartTheme.bg}e8` }}>
            {priceUsd != null && priceUsd > 0 ? (
              <>
                <div
                  className="text-2xl font-bold text-[var(--text)] drop-shadow-sm"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {formatUsdFromNumber(priceUsd)}
                </div>
                <div className="mt-1 text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
                  Price chart building…
                </div>
              </>
            ) : (
              <>
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="mb-2 text-[#475569]"
                  aria-hidden="true"
                >
                  <line x1="18" y1="3" x2="18" y2="6" />
                  <line x1="18" y1="11" x2="18" y2="21" />
                  <rect x="15" y="6" width="6" height="5" rx="1" />
                  <line x1="12" y1="6" x2="12" y2="8" />
                  <line x1="12" y1="15" x2="12" y2="21" />
                  <rect x="9" y="8" width="6" height="7" rx="1" />
                  <line x1="6" y1="3" x2="6" y2="10" />
                  <line x1="6" y1="17" x2="6" y2="21" />
                  <rect x="3" y="10" width="6" height="7" rx="1" />
                </svg>
                <div
                  className="text-[15px] font-semibold text-[#94a3b8]"
                  style={{ fontFamily: "'Space Grotesk', system-ui, sans-serif" }}
                >
                  No chart data yet
                </div>
                <div
                  className="mt-1 text-xs text-[#475569]"
                  style={{ fontFamily: "'Space Grotesk', system-ui, sans-serif" }}
                >
                  Price history will appear once trading begins
                </div>
              </>
            )}
          </div>
        )}

        {/* Phase 2: Volume no-data overlay — shown when volume pane exists but all volumes are 0 */}
        {!showEmptyOverlay && isCandleStyle(chartStyle) && !hasVolumeData && (
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 flex h-[20%] items-center justify-center border-t border-[var(--border)]/30">
            <span className="text-[9px] text-[var(--text-dim)] uppercase tracking-[0.12em]">
              ── Volume (no data) ──
            </span>
          </div>
        )}

        {/* OHLCV tooltip — hover the chart to see the bar under the crosshair.
            Positioned top-left on mobile (where the drawing toolbar is hidden);
            shifted right on md+ to clear the drawing toolbar that occupies
            the top-left corner there. left-14 (56px) gives ~10px of
            breathing room past the toolbar's outer edge (8px left + 38px
            wide = 46px right edge; left-12 = 48px would have been only
            2px of clearance). Hidden entirely when not hovering. */}
        {hoverBar && !showEmptyOverlay && (
          <div
            className="pointer-events-none absolute top-2 left-2 md:left-14 z-10 rounded-none border border-[var(--border)]/60 bg-[var(--bg)]/90 px-2 py-1 font-mono text-[10px] shadow-sm backdrop-blur-sm"
            aria-hidden="true"
          >
            <div className="flex items-center gap-3 whitespace-nowrap">
              {hoverBar.isCandle ? (
                <>
                  <span className="text-[var(--text-dim)]">O <span className="text-[var(--text)]">{formatUsdFromNumber(hoverBar.open).slice(1)}</span></span>
                  <span className="text-[var(--text-dim)]">H <span className="text-[var(--text)]">{formatUsdFromNumber(hoverBar.high).slice(1)}</span></span>
                  <span className="text-[var(--text-dim)]">L <span className="text-[var(--text)]">{formatUsdFromNumber(hoverBar.low).slice(1)}</span></span>
                  <span className="text-[var(--text-dim)]">C <span className="text-[var(--text)]" style={{ color: hoverBar.close >= hoverBar.open ? "var(--long)" : "var(--short)" }}>{formatUsdFromNumber(hoverBar.close).slice(1)}</span></span>
                </>
              ) : (
                <span className="text-[var(--text-dim)]">Price <span className="text-[var(--text)]">{formatUsdFromNumber(hoverBar.close).slice(1)}</span></span>
              )}
              {hoverBar.volume > 0 && (
                <span className="text-[var(--text-dim)]">V <span className="text-[var(--text)]">{hoverBar.volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></span>
              )}
            </div>
          </div>
        )}

        {overlayPrefs.position && <PositionSummary slabAddress={slabAddress} />}
        {overlayPrefs.pnl && <ChartPnlBadge slabAddress={slabAddress} />}
      </div>
    </div>
  );
};
