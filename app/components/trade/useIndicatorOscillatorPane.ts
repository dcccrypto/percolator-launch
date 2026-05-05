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
/** IPaneApi as returned by IChartApi.addPane(). Stored by-reference (not by
 *  index) so that pane.paneIndex() always reads the current live index even
 *  after sibling panes are added or removed and the indices shift. */
type Pane = ReturnType<IChartApi["addPane"]>;

/**
 * Wires oscillator-kind indicator configs (RSI, MACD) into native panes
 * below the main price pane via lightweight-charts v5's `chart.addPane()`.
 * Overlay-kind configs (SMA, EMA, Bollinger) are filtered out by the
 * caller and rendered separately by useIndicatorOverlays.
 *
 * Pane allocation: each oscillator config gets its OWN dedicated pane,
 * matching TradingView convention. Toggling RSI on opens one pane below
 * the price chart; toggling MACD on opens a second pane below that;
 * toggling either off collapses just that one pane and lets the
 * remaining panes (price + the surviving oscillator) reflow. This avoids
 * the cluttered dual-scale axis you get from packing multiple
 * oscillators into a single shared pane.
 *
 * Pane preservation: addPane() is called with `preserveEmptyPane: true`
 * because the diff loop below removes each existing series before
 * re-adding it on every effect run, and v5 auto-destroys panes the
 * instant their last series is removed unless this flag is set. Without
 * preservation, the pane vanishes during the brief empty window and the
 * next addSeries(..., paneIndex) call falls back to pane 0, dropping the
 * oscillator series into the price pane.
 *
 * Pane references vs indices: the map stores `IPaneApi` references
 * rather than integer indices because v5 compacts pane indices when a
 * pane is removed (removing pane at index 1 shifts the pane at index 2
 * down to 1). Calling `pane.paneIndex()` returns the current live index
 * regardless of removals, so addSeries always targets the correct pane.
 *
 * RSI gets horizontal reference lines at 70 (overbought) and 30
 * (oversold) via `series.createPriceLine`. MACD's histogram bars are
 * coloured per-bar (green for positive, red for negative) by setting
 * `color` on each data point — TradingView's universal convention. The
 * MACD line uses the indicator's chosen palette colour; the signal line
 * uses the theme's text colour at higher alpha for contrast.
 */
export function useIndicatorOscillatorPane(
  chartRef: RefObject<IChartApi | null>,
  chartReady: boolean,
  candleData: readonly Candle[],
  configs: readonly IndicatorConfig[],
  theme: ChartTheme,
): void {
  const paneMapRef = useRef<Map<string, Pane>>(new Map());
  const seriesMapRef = useRef<Map<string, OscillatorSeries[]>>(new Map());
  const priceLineMapRef = useRef<Map<string, OscillatorPriceLine[]>>(new Map());

  // When the chart is destroyed (unmount, Strict Mode double-mount, hot-
  // reload), chartReady flips false. Our refs still point at panes and
  // series on the dead chart — clear them so the next mount allocates
  // fresh state against the new chart instance.
  useEffect(() => {
    if (!chartReady) {
      paneMapRef.current.clear();
      seriesMapRef.current.clear();
      priceLineMapRef.current.clear();
    }
  }, [chartReady]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !chartReady) return;

    const paneMap = paneMapRef.current;
    const seriesMap = seriesMapRef.current;
    const priceLineMap = priceLineMapRef.current;

    const activeIds = new Set(configs.map((c) => c.id));

    // Remove panes (and their series) for configs no longer present.
    // Spread the keys so we can mutate the map while iterating.
    for (const id of [...paneMap.keys()]) {
      if (!activeIds.has(id)) {
        const seriesList = seriesMap.get(id);
        if (seriesList) {
          for (const s of seriesList) {
            try {
              chart.removeSeries(s);
            } catch {
              /* chart was destroyed in a parallel cleanup */
            }
          }
          seriesMap.delete(id);
        }
        priceLineMap.delete(id);
        const pane = paneMap.get(id);
        if (pane) {
          try {
            chart.removePane(pane.paneIndex());
          } catch {
            /* destroyed in parallel */
          }
          paneMap.delete(id);
        }
      }
    }

    // Add or update each active config. One pane per config — allocated
    // lazily on first appearance, kept across re-renders.
    for (const config of configs) {
      let pane = paneMap.get(config.id);
      if (!pane) {
        pane = chart.addPane(true);
        pane.setHeight(120);
        paneMap.set(config.id, pane);
      }
      const paneIndex = pane.paneIndex();

      // Remove existing series for this config — we always remove-and-
      // recreate on update (period change, theme change). Trivial cost
      // at our data sizes; pane preservation above keeps this safe even
      // when the pane briefly has zero series between remove and add.
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
    //   - the diff loop above (config removed by user)
    //   - the chartReady-reset effect above (chart instance destroyed)
    //   - the chart-init effect's `chart.remove()` (full unmount cascade)
    // A cleanup here would fire on every dep change (data tick, theme
    // toggle), tearing down + reallocating panes on every WS tick.
  }, [chartRef, chartReady, candleData, configs, theme]);
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
          // Per-instance scale id keeps the autoscaleInfoProvider's
          // pinned 0–100 range scoped to THIS series (not shared with
          // any other series that might land in the same pane).
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
      // Force the per-instance scale visible — overlay scales (created
      // by assigning a non-default priceScaleId) hide their axis by
      // default in v5, which would suppress both the 0-100 axis labels
      // AND the 30 / 70 reference-line labels below.
      chart.priceScale(config.id, paneIndex).applyOptions({ visible: true });
      series.setData(
        data.map((p) => ({ time: msToUtc(p.time), value: p.value })),
      );
      // Overbought (70) and oversold (30) reference lines — universal
      // RSI convention. Dashed, derived from the theme's text colour at
      // ~25% alpha so they read as secondary structure rather than
      // noise. theme.gridColor (~4-5% alpha) was effectively invisible
      // on real charts.
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
