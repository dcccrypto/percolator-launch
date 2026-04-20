"use client";

import { FC, useState, useRef, useEffect, useCallback } from "react";
import { createChart, IChartApi, ISeriesApi, LineStyle, ColorType, CrosshairMode } from "lightweight-charts";
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
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockUserAccount } from "@/lib/mock-trade-data";

type ChartType = "line" | "candle";
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
  const [chartType, setChartType] = useState<ChartType>("candle");
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
  const seriesRef = useRef<ISeriesApi<"Candlestick" | "Line"> | null>(null);
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
  const percolatorCandles = percolatorCandlesRaw.map((c) => ({
    timestamp: c.time * 1000,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));

  // Only use Percolator as the chart source once the market has enough volume
  // to form at least 10 bars — otherwise fall back to Pyth to avoid a sparse,
  // gap-filled chart that looks worse than Pyth's deep history.
  const hasPercolatorData = percolatorStatus === "success" && percolatorCandles.length >= 10;
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

  // Derive data
  const oracleFiltered = (() => {
    const cutoff = Date.now() - TIMEFRAME_MS[timeframe];
    return oraclePrices.filter((p) => p.timestamp >= cutoff);
  })();

  // Data source priority: Percolator internal trades (tier-0, when >=10 bars) →
  // Pyth Benchmarks (canonical spot) → GeckoTerminal (DEX-pool history for
  // long-tail tokens) → oracle-aggregated fallback (keeper observations).
  const candleData = (() => {
    if (hasPercolatorData) return percolatorCandles;
    if (hasPythData) return pythCandles as { timestamp: number; open: number; high: number; low: number; close: number; volume: number }[];
    if (hasExternalData) return externalCandles as { timestamp: number; open: number; high: number; low: number; close: number; volume: number }[];
    return aggregateCandles(oracleFiltered, CANDLE_INTERVAL_MS);
  })();

  const lineData = (() => {
    if (hasPercolatorData) return percolatorCandles.map((c) => ({ timestamp: c.timestamp, price: c.close }));
    if (hasPythData) return pythCandles.map((c) => ({ timestamp: c.timestamp, price: c.close }));
    if (hasExternalData) return externalCandles.map((c) => ({ timestamp: c.timestamp, price: c.close }));
    return oracleFiltered;
  })();

  const totalDataPoints = candleData.length + lineData.length;

  // GH#1625: sparse-data guard
  const effectiveSparse =
    (chartType === "candle" && candleData.length < 2) ||
    (chartType === "line" && lineData.length < 2);

  // Phase 2: volume has data (used to show empty state in volume pane)
  const hasVolumeData = candleData.some((c) => (c.volume ?? 0) > 0);

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

    return () => {
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
    if (ep == null || ep === 0n) return null;
    return Number(ep) / 1e6;
  })();

  // Update series when data or chartType changes
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

    if (chartType === "candle" && candleData.length > 0) {
      const series = chart.addCandlestickSeries({
        upColor: chartTheme.upColor,
        downColor: chartTheme.downColor,
        borderDownColor: chartTheme.downColor,
        borderUpColor: chartTheme.upColor,
        wickDownColor: chartTheme.downColor,
        wickUpColor: chartTheme.upColor,
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

      // Phase 2: Volume histogram — always add series; use sentinel 0.001 when
      // no real volume data exists so the pane renders (showing the "no data" label
      // via the overlay div below, not via lwc itself).
      const volumeSeries = chart.addHistogramSeries({
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
      });
      chart.priceScale("volume").applyOptions({
        // Volume pane takes bottom 10% (top margin 0.90). With Pyth's
        // aggregated daily volume numbers spanning 180+ bars, a wider pane
        // dominates the price action visually — shrinking it keeps the
        // candles as the primary focus.
        scaleMargins: { top: 0.90, bottom: 0 },
      });
      const volumeData = candleData.map((c) => ({
        time: (Math.floor(c.timestamp / 1000)) as import("lightweight-charts").UTCTimestamp,
        // Phase 2: use a tiny sentinel value so lwc renders the pane even when vol=0
        value: (c.volume ?? 0) > 0 ? c.volume : 0.001,
        color: c.close >= c.open ? chartTheme.volUpColor : chartTheme.volDownColor,
      }));
      volumeSeries.setData(volumeData);
      volumeSeriesRef.current = volumeSeries;

      // Mark price line
      if (priceUsd != null) {
        priceLineRef.current = series.createPriceLine({
          price: priceUsd,
          color: "rgba(255,255,255,0.6)",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "Mark",
        });
      }

      // Phase 2: Liq price overlay
      const liqPriceNum = liqPriceE6 != null && liqPriceE6 > 0n ? Number(liqPriceE6) / 1e6 : null;
      if (liqPriceNum != null && liqPriceNum > 0) {
        liqLineRef.current = series.createPriceLine({
          price: liqPriceNum,
          color: "#ef4444",
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: "Liq",
        });
      }

      // Entry price overlay — cyan dashed when position is open
      if (entryPriceNum != null && entryPriceNum > 0) {
        entryLineRef.current = series.createPriceLine({
          price: entryPriceNum,
          color: "#22d3ee",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "Entry",
        });
      }
    } else if (chartType === "line" && lineData.length > 0) {
      const series = chart.addLineSeries({
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
      seriesRef.current = series as ISeriesApi<"Candlestick" | "Line">;

      // Mark price line on line series
      if (priceUsd != null) {
        priceLineRef.current = series.createPriceLine({
          price: priceUsd,
          color: "rgba(255,255,255,0.6)",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "Mark",
        });
      }

      // Liq price on line chart
      const liqPriceNum = liqPriceE6 != null && liqPriceE6 > 0n ? Number(liqPriceE6) / 1e6 : null;
      if (liqPriceNum != null && liqPriceNum > 0) {
        liqLineRef.current = series.createPriceLine({
          price: liqPriceNum,
          color: "#ef4444",
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: "Liq",
        });
      }

      // Entry price on line chart
      if (entryPriceNum != null && entryPriceNum > 0) {
        entryLineRef.current = series.createPriceLine({
          price: entryPriceNum,
          color: "#22d3ee",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "Entry",
        });
      }
    }

    // Only fit the content to viewport on the FIRST render for the current
    // (timeframe, chart type, data source) combo. Subsequent polls just
    // update-in-place so the user's pan/zoom is preserved.
    const source = hasPythData ? "pyth" : hasExternalData ? "dex" : "oracle";
    const fitKey = `${chartType}:${timeframe}:${source}`;
    if (fitKeyRef.current !== fitKey) {
      chart.timeScale().fitContent();
      fitKeyRef.current = fitKey;
    }
  }, [chartType, timeframe, candleData, lineData, priceUsd, liqPriceE6, entryPriceNum, chartTheme, hasPythData, hasExternalData]);

  // Update mark price line when live price changes
  useEffect(() => {
    if (priceLineRef.current && priceUsd != null) {
      priceLineRef.current.applyOptions({ price: priceUsd });
    }
  }, [priceUsd]);

  // Header % change is ALWAYS trailing 24 h vs current — the industry
  // convention users expect, independent of what timeframe/zoom they picked.
  // (Previously this was first-visible-bar to last-visible-bar, so on the
  // 1d daily-candle view with 180 days of Pyth history the header read
  // -55% over the 6-month SOL drawdown — true, but deeply misleading.)
  const activeData = lineData.length > 0 ? lineData : oracleFiltered;
  const currentPrice = activeData[activeData.length - 1]?.price ?? priceUsd ?? 0;
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  const ref24h =
    activeData.find((p) => p.timestamp >= cutoff24h)?.price ??
    activeData[0]?.price ??
    currentPrice;
  const priceChange = currentPrice - ref24h;
  const priceChangePercent = ref24h > 0 ? (priceChange / ref24h) * 100 : 0;
  const isUp = priceChange >= 0;

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
          <div className="flex gap-1 rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5">
            <button
              onClick={() => setChartType("line")}
              className={`rounded-none px-2 py-1 text-xs transition-colors ${
                chartType === "line"
                  ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                  : "text-[var(--text-dim)] hover:text-[var(--text-secondary)]"
              }`}
            >
              Line
            </button>
            <button
              onClick={() => setChartType("candle")}
              className={`rounded-none px-2 py-1 text-xs transition-colors ${
                chartType === "candle"
                  ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                  : "text-[var(--text-dim)] hover:text-[var(--text-secondary)]"
              }`}
            >
              Candle
            </button>
          </div>

          {/* PERC-8090: 1m/5m/15m/1h/4h/1d only — 7d/30d collapsed */}
          <div className="flex gap-1 rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5">
            {VISIBLE_TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={`rounded-none px-2 py-1 text-xs transition-colors ${
                  timeframe === tf
                    ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                    : "text-[var(--text-dim)] hover:text-[var(--text-secondary)]"
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

        {/* GH#1652: empty-state overlay — shown when no data yet, sits above canvas */}
        {showEmptyOverlay && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center backdrop-blur-[1px]" style={{ background: `${chartTheme.bg}e8` }}>
            {priceUsd != null && priceUsd > 0 ? (
              <>
                <div
                  className="text-2xl font-bold text-[var(--text)] drop-shadow-sm"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  ${priceUsd < 0.01 ? priceUsd.toFixed(6) : priceUsd.toFixed(2)}
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
        {!showEmptyOverlay && chartType === "candle" && !hasVolumeData && (
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 flex h-[20%] items-center justify-center border-t border-[var(--border)]/30">
            <span className="text-[9px] text-[var(--text-dim)] uppercase tracking-[0.12em]">
              ── Volume (no data) ──
            </span>
          </div>
        )}

        {/* Phase 2: Position summary badge overlay */}
        <PositionSummary slabAddress={slabAddress} />
      </div>
    </div>
  );
};
