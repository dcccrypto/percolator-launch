"use client";

import { useEffect, useRef, type RefObject } from "react";
import {
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { IndicatorConfig } from "@/lib/indicator-registry";
import type { Candle } from "@/lib/indicators/types";
import { relativeStrengthIndex } from "@/lib/indicators/rsi";
import { macd } from "@/lib/indicators/macd";
import type { ChartTheme } from "@/hooks/useChartTheme";
import { assertNever } from "@/lib/exhaustive";

/** Series spawned by an oscillator-kind indicator: a single line series for
 *  RSI; a histogram + two lines for MACD. */
type OscillatorSeries = ISeriesApi<"Line" | "Histogram">;
type OscillatorPriceLine = ReturnType<ISeriesApi<"Line">["createPriceLine"]>;

/**
 * Wires oscillator-kind indicator configs (RSI, MACD) into a native pane
 * below the main price pane via lightweight-charts v5's `chart.addPane()`.
 * Overlay-kind configs (SMA, EMA, Bollinger) are filtered out by the
 * caller and rendered separately by useIndicatorOverlays.
 *
 * The v5 native pane API gives us, for free, what the v4 plan would have
 * required ~120 lines of manual plumbing for: shared time scale across
 * panes, shared crosshair, theme propagation, and viewport sync. The
 * pane lives inside the same chart instance — no second `<canvas>`, no
 * `subscribeVisibleTimeRangeChange` mirror, no separate teardown path.
 *
 * The pane is allocated lazily — only when at least one oscillator config
 * is active. Removing the last oscillator tears the pane down (collapsing
 * the chart back to its original height). Adding the next oscillator
 * reallocates a fresh pane.
 *
 * Multiple oscillators in one pane share the canvas. Their value scales
 * differ (RSI is 0–100; MACD is unbounded around zero) but lightweight-
 * charts auto-scales each series independently when they have distinct
 * `priceScaleId` values. We assign each indicator instance a unique
 * priceScaleId derived from its id so the scales don't fight each other.
 *
 * RSI gets a horizontal reference line at 70 (overbought) and 30
 * (oversold) via `series.createPriceLine`. MACD's histogram bars are
 * coloured per-bar (green for positive, red for negative) by setting
 * `color` on each data point — TradingView's universal convention. The
 * MACD line uses the indicator's chosen palette colour; the signal line
 * uses the theme's text colour for contrast.
 */
export function useIndicatorOscillatorPane(
  chartRef: RefObject<IChartApi | null>,
  chartReady: boolean,
  candleData: readonly Candle[],
  configs: readonly IndicatorConfig[],
  theme: ChartTheme,
): void {
  const paneIndexRef = useRef<number | null>(null);
  const seriesMapRef = useRef<Map<string, OscillatorSeries[]>>(new Map());
  const priceLineMapRef = useRef<Map<string, OscillatorPriceLine[]>>(new Map());

  // When the chart is destroyed (unmount, Strict Mode double-mount, hot-
  // reload), chartReady flips false. Our refs still point at the dead
  // chart's pane index and series — clear them so the next mount allocates
  // fresh state against the new chart instance.
  useEffect(() => {
    if (!chartReady) {
      paneIndexRef.current = null;
      seriesMapRef.current.clear();
      priceLineMapRef.current.clear();
    }
  }, [chartReady]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !chartReady) return;

    const seriesMap = seriesMapRef.current;
    const priceLineMap = priceLineMapRef.current;

    // No oscillators active — tear down the pane if it exists. The pane
    // collapses; the main chart fills the reclaimed vertical space.
    if (configs.length === 0) {
      tearDownPane(chart);
      return;
    }

    // Lazily allocate the oscillator pane on first use. v5 returns an
    // IPaneApi from addPane(); we keep just the index so subsequent
    // addSeries calls can target it via the third argument.
    //
    // `preserveEmptyPane: true` is critical: the diff loop below removes
    // each existing series before re-adding it. Without preservation, v5
    // auto-destroys the pane the instant its last series is removed —
    // and the very next addSeries(..., paneIndex=1) call falls back to
    // pane 0 because pane 1 no longer exists. The visual symptom is
    // every oscillator series migrating into the price pane after the
    // first re-render. With preservation the pane survives the brief
    // empty window between remove and re-add.
    if (paneIndexRef.current === null) {
      const newPane = chart.addPane(true);
      newPane.setHeight(120);
      paneIndexRef.current = newPane.paneIndex();
    } else {
      // Defensive: re-assert preservation in case anything else cleared it.
      const existingPane = chart.panes()[paneIndexRef.current];
      if (existingPane) existingPane.setPreserveEmptyPane(true);
    }
    const paneIndex = paneIndexRef.current;

    const activeIds = new Set(configs.map((c) => c.id));

    // Remove series for configs no longer present. Price lines attached
    // to a removed series go with it automatically — we just clear our
    // tracking Map entry.
    for (const [id, seriesList] of seriesMap) {
      if (!activeIds.has(id)) {
        for (const s of seriesList) {
          try {
            chart.removeSeries(s);
          } catch {
            /* chart was destroyed in a parallel cleanup */
          }
        }
        seriesMap.delete(id);
        priceLineMap.delete(id);
      }
    }

    // Add or update each active config. Same remove-and-recreate strategy
    // as the overlay hook: simpler than per-property diff, trivial cost
    // at our data sizes.
    for (const config of configs) {
      const existing = seriesMap.get(config.id);
      if (existing) {
        for (const s of existing) {
          try {
            chart.removeSeries(s);
          } catch {
            /* destroyed in parallel */
          }
        }
      }
      const { series, priceLines } = renderOscillatorConfig(
        chart,
        candleData,
        config,
        theme,
        paneIndex,
      );
      if (series.length > 0) {
        seriesMap.set(config.id, series);
        priceLineMap.set(config.id, priceLines);
      } else {
        seriesMap.delete(config.id);
        priceLineMap.delete(config.id);
      }
    }

    // No cleanup. Teardown is driven by:
    //   - `configs.length === 0` branch above (user disabled all oscillators)
    //   - the chartReady-reset effect above (chart instance destroyed)
    //   - the chart-init effect's `chart.remove()` (full unmount cascade)
    // A cleanup here would fire on every dep change (data tick, theme
    // toggle), tearing down + reallocating the pane on every WS tick —
    // exactly what the body's diff is trying to avoid.
  }, [chartRef, chartReady, candleData, configs, theme]);

  function tearDownPane(chart: IChartApi) {
    const seriesMap = seriesMapRef.current;
    // Remove tracked series. removePane below would also drop them, but
    // explicitly removing first means our refs and the chart's internal
    // state stay in sync even if removePane fails for any reason.
    for (const seriesList of seriesMap.values()) {
      for (const s of seriesList) {
        try {
          chart.removeSeries(s);
        } catch {
          /* destroyed in parallel */
        }
      }
    }
    seriesMap.clear();
    priceLineMapRef.current.clear();

    if (paneIndexRef.current !== null) {
      try {
        chart.removePane(paneIndexRef.current);
      } catch {
        /* destroyed in parallel */
      }
      paneIndexRef.current = null;
    }
  }
}

/** Build the series + reference lines for a single oscillator config. */
function renderOscillatorConfig(
  chart: IChartApi,
  candles: readonly Candle[],
  config: IndicatorConfig,
  theme: ChartTheme,
  paneIndex: number,
): { series: OscillatorSeries[]; priceLines: OscillatorPriceLine[] } {
  switch (config.kind) {
    case "rsi": {
      const data = relativeStrengthIndex(candles, config.period);
      const series = chart.addSeries(
        LineSeries,
        {
          color: config.color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          // Per-instance scale so multiple oscillators in the same pane
          // don't fight over a shared right-side scale.
          priceScaleId: config.id,
          // Pin the visible range to [0, 100] so the 30 / 70 reference
          // lines below render at fixed positions regardless of where
          // the RSI line is currently sitting. autoscaleInfoProvider is
          // v5's explicit way to declare a logical range — `autoScale:
          // false` alone would freeze the scale to whatever was first
          // auto-fit, leaving the reference lines clipped if RSI hadn't
          // touched 0 or 100 yet.
          autoscaleInfoProvider: () => ({
            priceRange: { minValue: 0, maxValue: 100 },
          }),
        },
        paneIndex,
      );
      // Force the per-instance scale visible — overlay scales (created by
      // assigning a non-default priceScaleId) hide their axis by default
      // in v5, which would suppress both the 0-100 axis labels AND the
      // 30 / 70 reference-line labels below.
      chart.priceScale(config.id, paneIndex).applyOptions({ visible: true });
      series.setData(
        data.map((p) => ({ time: msToUtc(p.time), value: p.value })),
      );
      // Overbought (70) and oversold (30) reference lines — universal
      // RSI convention. Dashed, derived from the theme's text colour at
      // ~25% alpha so they read as secondary structure rather than noise.
      // theme.gridColor (~4-5% alpha) was effectively invisible on real
      // charts.
      const referenceColor = withAlpha(theme.textColor, 0.25);
      const overbought = series.createPriceLine({
        price: 70,
        color: referenceColor,
        lineStyle: LineStyle.Dashed,
        lineWidth: 1,
        axisLabelVisible: true,
        title: "70",
      });
      const oversold = series.createPriceLine({
        price: 30,
        color: referenceColor,
        lineStyle: LineStyle.Dashed,
        lineWidth: 1,
        axisLabelVisible: true,
        title: "30",
      });
      return { series: [series], priceLines: [overbought, oversold] };
    }
    case "macd": {
      const data = macd(
        candles,
        config.fastPeriod,
        config.slowPeriod,
        config.signalPeriod,
      );
      // Histogram first so the lines render on top of the bars.
      const histogram = chart.addSeries(
        HistogramSeries,
        {
          priceLineVisible: false,
          lastValueVisible: false,
          priceScaleId: config.id,
        },
        paneIndex,
      );
      // Make the per-instance MACD scale visible (same reasoning as RSI
      // above — overlay scales suppress axis labels by default in v5).
      chart.priceScale(config.id, paneIndex).applyOptions({ visible: true });
      histogram.setData(
        data.map((p) => ({
          time: msToUtc(p.time),
          value: p.histogram,
          // Per-bar colour by sign — TradingView convention. Positive
          // bars in up-colour (bullish, MACD above signal); negative in
          // down-colour (bearish, MACD below signal).
          color: p.histogram >= 0 ? theme.upColor : theme.downColor,
        })),
      );
      // MACD line in the indicator's chosen palette colour.
      const macdLine = chart.addSeries(
        LineSeries,
        {
          color: config.color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          priceScaleId: config.id,
        },
        paneIndex,
      );
      macdLine.setData(
        data.map((p) => ({ time: msToUtc(p.time), value: p.macd })),
      );
      // Signal line in the theme text colour, ramped to ~75% alpha so it
      // reads as a peer line to the palette-coloured MACD line rather
      // than as background noise (the default theme.textColor is ~45%
      // alpha — too faint at 1px line width). Both share the same scale
      // so a crossover at the same y-coordinate IS a true crossover.
      const signalLine = chart.addSeries(
        LineSeries,
        {
          color: withAlpha(theme.textColor, 0.75),
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          priceScaleId: config.id,
        },
        paneIndex,
      );
      signalLine.setData(
        data.map((p) => ({ time: msToUtc(p.time), value: p.signal })),
      );
      return { series: [histogram, macdLine, signalLine], priceLines: [] };
    }
    case "sma":
    case "ema":
    case "bollinger":
      // Overlay-kind, handled by useIndicatorOverlays. Return empty so
      // the caller treats this config as a no-op for the pane.
      return { series: [], priceLines: [] };
    default:
      return assertNever(config);
  }
}

/** Convert internal millisecond timestamps to lightweight-charts'
 *  UTCTimestamp (Unix seconds) at the API boundary. The math layer keeps
 *  everything in ms (matches Date.now() and Candle.timestamp); only this
 *  conversion site knows about lightweight-charts' seconds convention. */
function msToUtc(timeMs: number): UTCTimestamp {
  return Math.floor(timeMs / 1000) as UTCTimestamp;
}

/** Override the alpha channel of an `rgba(...)` string. The chart theme
 *  exposes `textColor` as `rgba(R,G,B,A)` for both dark and light themes;
 *  this helper lets us derive higher-contrast variants for the RSI
 *  reference lines (~25%) and MACD signal line (~75%) without hardcoding
 *  light/dark colors at the use site. */
function withAlpha(rgbaColor: string, alpha: number): string {
  const match = rgbaColor.match(/^rgba?\(([^)]+)\)$/);
  if (!match) return rgbaColor;
  const parts = match[1].split(",").map((p) => p.trim());
  if (parts.length < 3) return rgbaColor;
  const [r, g, b] = parts;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
