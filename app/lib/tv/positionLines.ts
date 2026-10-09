/**
 * Mark / Liq / Entry as locked horizontal lines on the TradingView chart.
 *
 * Advanced Charts has no position/order-line primitives (those are Trading
 * Platform only since v29), so each line is a regular horizontal_line drawing
 * that is locked, unselectable, kept out of the saved layout and out of undo —
 * inert, like the old chart's createPriceLine. A small reconciler keeps the
 * set of lines equal to what the page wants, moving lines in place instead of
 * recreating them.
 */
import type { ChartTheme } from "@/hooks/useChartTheme";
import type { OverlayPrefs } from "@/lib/chart-overlays";
import { ESTIMATE_LABEL } from "@/lib/entry-price-display";
import type { TvChartApi, TvEntityId } from "./types";

export type LineKind = "mark" | "liq" | "entry";
export const LINE_KINDS: readonly LineKind[] = ["mark", "liq", "entry"];

export interface LineSpec {
  price: number;
  color: string;
  /** 0 solid, 2 dashed (TradingView line styles). */
  style: 0 | 2;
  width: 1 | 2;
  text: string;
}

export type DesiredLines = Partial<Record<LineKind, LineSpec>>;

const valid = (p: number | null | undefined): p is number => p != null && Number.isFinite(p) && p > 0;

export interface LineInputs {
  markPrice: number | null;
  /** The previous mark, to tint the Mark line up/down like the old chart. */
  prevMarkPrice: number | null;
  liqPrice: number | null;
  entryPrice: number | null;
  /** The entry is a back-solve, not a recorded price (computePositionPnl `isEstimate`): label it "est.". */
  entryIsEstimate?: boolean;
  /** Draw the Mark line (default true). It is the chart's current-price line on every series, Mark included: TradingView's own price line is off (lib/tv/theme.ts). */
  showMark?: boolean;
  prefs: Pick<OverlayPrefs, "liq" | "entry">;
  theme: ChartTheme;
}

/** Pure: which lines should exist, and how they look. */
export function desiredLines(i: LineInputs): DesiredLines {
  const out: DesiredLines = {};
  if (i.showMark !== false && valid(i.markPrice)) {
    const prev = i.prevMarkPrice;
    const color =
      prev == null || !Number.isFinite(prev) || prev === i.markPrice
        ? i.theme.neutralLine
        : i.markPrice > prev
          ? i.theme.upColor
          : i.theme.downColor;
    out.mark = { price: i.markPrice, color, style: 2, width: 1, text: "Mark" };
  }
  if (i.prefs.liq && valid(i.liqPrice)) {
    out.liq = { price: i.liqPrice, color: i.theme.downColor, style: 0, width: 2, text: "Liq" };
  }
  if (i.prefs.entry && valid(i.entryPrice)) {
    out.entry = { price: i.entryPrice, color: i.theme.entryLine, style: 2, width: 1, text: i.entryIsEstimate ? `Entry ${ESTIMATE_LABEL}` : "Entry" };
  }
  return out;
}

export function shapeOverrides(spec: LineSpec): Record<string, string | number | boolean> {
  return {
    linecolor: spec.color,
    linestyle: spec.style,
    linewidth: spec.width,
    textcolor: spec.color,
    showLabel: true,
    showPrice: true,
    horzLabelsAlign: "right",
    vertLabelsAlign: "bottom",
    fontsize: 11,
  };
}

interface Live {
  id: TvEntityId | null;
  /** Set while createShape is in flight. */
  creating: Promise<void> | null;
  spec: LineSpec;
}

/**
 * Keeps the chart's Mark/Liq/Entry drawings equal to the latest DesiredLines.
 * Safe to call `sync` at tick rate: unchanged lines cost nothing, a moved
 * line is one setPoints, a recoloured one is one setProperties.
 */
export class PositionLines {
  private readonly lines = new Map<LineKind, Live>();
  private latest: DesiredLines = {};
  private disposed = false;

  constructor(
    private readonly chart: () => TvChartApi | null,
    private readonly nowSec: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** The chart, or null — the getter throws once the widget's iframe is gone (unmount). */
  private safeChart(): TvChartApi | null {
    try {
      return this.chart();
    } catch {
      return null;
    }
  }

  sync(desired: DesiredLines): void {
    if (this.disposed) return;
    this.latest = desired;
    const chart = this.safeChart();
    if (!chart) return;
    for (const kind of LINE_KINDS) {
      const want = desired[kind];
      const have = this.lines.get(kind);
      if (!want) {
        if (have) this.remove(kind, have, chart);
        continue;
      }
      if (!have) {
        this.create(kind, want, chart);
        continue;
      }
      if (have.creating) {
        have.spec = want; // applied when creation resolves
        continue;
      }
      this.update(kind, have, want, chart);
    }
  }

  private create(kind: LineKind, spec: LineSpec, chart: TvChartApi): void {
    const live: Live = { id: null, creating: null, spec };
    this.lines.set(kind, live);
    live.creating = chart
      .createShape(
        { time: this.nowSec(), price: spec.price },
        {
          shape: "horizontal_line",
          text: spec.text,
          lock: true,
          disableSelection: true,
          disableSave: true,
          disableUndo: true,
          showInObjectsTree: false,
          zOrder: "top",
          overrides: shapeOverrides(spec),
        },
      )
      .then(
        (id) => {
          live.creating = null;
          if (this.disposed || this.lines.get(kind) !== live || !this.latest[kind]) {
            try {
              chart.removeEntity(id);
            } catch {
              /* chart gone */
            }
            if (this.lines.get(kind) === live) this.lines.delete(kind);
            return;
          }
          live.id = id;
          const target = live.spec;
          live.spec = spec; // what was actually created
          this.update(kind, live, target, chart);
        },
        () => {
          live.creating = null;
          if (this.lines.get(kind) === live) this.lines.delete(kind);
        },
      );
  }

  private update(kind: LineKind, live: Live, want: LineSpec, chart: TvChartApi): void {
    if (live.id == null) return;
    const prev = live.spec;
    try {
      const shape = chart.getShapeById(live.id);
      if (prev.price !== want.price) shape.setPoints([{ time: this.nowSec(), price: want.price }]);
      if (prev.color !== want.color || prev.style !== want.style || prev.width !== want.width) {
        shape.setProperties(shapeOverrides(want));
      }
      live.spec = want;
    } catch {
      // The drawing vanished (layout reload, symbol change): recreate next sync.
      if (this.lines.get(kind) === live) this.lines.delete(kind);
    }
  }

  private remove(kind: LineKind, live: Live, chart: TvChartApi): void {
    this.lines.delete(kind);
    if (live.id != null) {
      try {
        chart.removeEntity(live.id);
      } catch {
        /* already gone */
      }
    }
    // An in-flight create removes itself on resolve (latest[kind] is unset).
  }

  /** Forget all line ids (after the chart dropped its drawings, e.g. a symbol change) and redraw. */
  reset(): void {
    this.lines.clear();
    this.sync(this.latest);
  }

  dispose(): void {
    const chart = this.safeChart();
    this.disposed = true;
    if (chart) {
      for (const live of this.lines.values()) {
        if (live.id != null) {
          try {
            chart.removeEntity(live.id);
          } catch {
            /* ignore */
          }
        }
      }
    }
    this.lines.clear();
  }
}
