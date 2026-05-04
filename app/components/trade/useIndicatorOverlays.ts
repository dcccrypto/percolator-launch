"use client";

import { useEffect, useRef, type RefObject } from "react";
import {
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { IndicatorConfig } from "@/lib/indicator-registry";
import type { Candle } from "@/lib/indicators/types";
import { simpleMovingAverage } from "@/lib/indicators/sma";
import { exponentialMovingAverage } from "@/lib/indicators/ema";
import { bollingerBands } from "@/lib/indicators/bollinger";
import { assertNever } from "@/lib/exhaustive";

/** Series spawned by an overlay-kind indicator: one for SMA/EMA, three
 *  for Bollinger (upper / middle / lower lines). All are line series. */
type IndicatorSeries = ISeriesApi<"Line">;

/**
 * Wires overlay-kind indicator configs (SMA, EMA, Bollinger) to line series
 * on the main chart. Pane-kind configs (RSI, MACD) are filtered out and
 * handled separately by the oscillator-pane hook.
 *
 * Critical design point: this hook attaches series to the EXISTING chart
 * instance. It must NOT trigger the chart-init effect to re-run when
 * indicators change — that would destroy and recreate the entire chart on
 * every period tweak the user makes in the settings menu. The chart-init
 * effect's deps array stays clean of indicator state; this hook diffs the
 * config list against an internal Map and adds/removes series in place.
 *
 * The chart instance is stable for the component's lifetime in this
 * codebase (the chart-init effect uses []-deps and lives once per mount).
 * `chartReady` flips true after createChart() and false on unmount; the
 * hook re-runs on each flip, attaching/detaching series at the right time.
 *
 * Bollinger fill caveat: lightweight-charts cannot natively fill between
 * two series. The semi-transparent band fill (TradingView's default look)
 * would require a custom canvas primitive or a stacked area-series trick
 * with masking. For v1, ship the three lines only — the indicator is still
 * fully readable. The fill can ship as a polish commit later.
 */
export function useIndicatorOverlays(
  chartRef: RefObject<IChartApi | null>,
  chartReady: boolean,
  candleData: readonly Candle[],
  configs: readonly IndicatorConfig[],
): void {
  const seriesMapRef = useRef<Map<string, IndicatorSeries[]>>(new Map());

  // When the chart is destroyed (unmount, Strict Mode double-mount, hot-
  // reload), chartReady flips false. Our refs still point at series on
  // the dead chart — clear them so the next mount diffs against an empty
  // map and attaches fresh series to the new chart instance.
  useEffect(() => {
    if (!chartReady) {
      seriesMapRef.current.clear();
    }
  }, [chartReady]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !chartReady) return;

    const seriesMap = seriesMapRef.current;
    const activeIds = new Set(configs.map((c) => c.id));

    // Remove series for configs no longer present.
    for (const [id, seriesList] of seriesMap) {
      if (!activeIds.has(id)) {
        for (const s of seriesList) {
          try {
            chart.removeSeries(s);
          } catch {
            /* chart was already destroyed in a parallel cleanup */
          }
        }
        seriesMap.delete(id);
      }
    }

    // Add or update series for every active config. We always remove-and-
    // recreate on update (period change, color change) — simpler than a
    // per-property diff and the cost is trivial at our data sizes
    // (200–500 candles, sub-millisecond render per series).
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
      const seriesList = renderConfig(chart, candleData, config);
      if (seriesList.length > 0) {
        seriesMap.set(config.id, seriesList);
      } else {
        seriesMap.delete(config.id);
      }
    }

    // No cleanup. Teardown is driven by:
    //   - the activeIds diff above (user removed a specific indicator)
    //   - the chartReady-reset effect above (chart instance destroyed)
    //   - the chart-init effect's `chart.remove()` (full unmount cascade)
    // A cleanup here would fire on every dep change (data tick, config
    // edit), removing every series only to re-add them in the next run —
    // exactly the WS-tick churn we want to avoid.
  }, [chartRef, chartReady, candleData, configs]);
}

/** Build the series list for a single indicator config. Returns an empty
 *  array for pane-kind indicators (RSI, MACD) — those render in a separate
 *  pane via the sibling oscillator hook. The exhaustive switch + assertNever
 *  catches any future kind that isn't classified as overlay-or-pane. */
function renderConfig(
  chart: IChartApi,
  candles: readonly Candle[],
  config: IndicatorConfig,
): IndicatorSeries[] {
  switch (config.kind) {
    case "sma": {
      const data = simpleMovingAverage(candles, config.period);
      const series = chart.addSeries(LineSeries, {
        color: config.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      series.setData(
        data.map((p) => ({ time: msToUtc(p.time), value: p.value })),
      );
      return [series];
    }
    case "ema": {
      const data = exponentialMovingAverage(candles, config.period);
      const series = chart.addSeries(LineSeries, {
        color: config.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      series.setData(
        data.map((p) => ({ time: msToUtc(p.time), value: p.value })),
      );
      return [series];
    }
    case "bollinger": {
      const data = bollingerBands(candles, config.period, config.stdDev);
      // Three line series: middle (solid), upper (dashed), lower (dashed).
      // Same color so they read as a group; dashed-vs-solid distinguishes
      // the bands from the SMA midline at a glance.
      const middle = chart.addSeries(LineSeries, {
        color: config.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      middle.setData(
        data.map((p) => ({ time: msToUtc(p.time), value: p.middle })),
      );
      const upper = chart.addSeries(LineSeries, {
        color: config.color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      upper.setData(
        data.map((p) => ({ time: msToUtc(p.time), value: p.upper })),
      );
      const lower = chart.addSeries(LineSeries, {
        color: config.color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      lower.setData(
        data.map((p) => ({ time: msToUtc(p.time), value: p.lower })),
      );
      return [middle, upper, lower];
    }
    case "rsi":
    case "macd":
      // Oscillator-pane kinds — handled by useIndicatorOscillatorPane.
      return [];
    default:
      return assertNever(config);
  }
}

/** Convert internal millisecond timestamps to lightweight-charts' UTCTimestamp
 *  (Unix seconds) at the API boundary. The math layer keeps everything in
 *  ms (matches Date.now() and Candle.timestamp); only this conversion site
 *  knows about the seconds convention lightweight-charts requires. */
function msToUtc(timeMs: number): UTCTimestamp {
  return Math.floor(timeMs / 1000) as UTCTimestamp;
}
