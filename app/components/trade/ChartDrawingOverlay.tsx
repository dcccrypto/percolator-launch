"use client";

import { useEffect, useRef, useState, type FC, type RefObject } from "react";
import type {
  IChartApi,
  MouseEventParams,
  Time,
} from "lightweight-charts";
import { sizeCanvasForDpr } from "@/lib/chart-canvas";
import {
  pricePointToPixel,
  type PriceConverter,
  type TimeConverter,
} from "@/lib/chart-coords";
import {
  type Drawing,
  type DrawingTool,
} from "@/lib/chart-drawings";
import { findHitDrawingId } from "@/lib/chart-hit-test";
import { assertNever } from "@/lib/exhaustive";

interface ChartDrawingOverlayProps {
  /** Live chart API ref managed by the parent's chart-init effect.
   *  May be null briefly between mount and chart creation. */
  chartRef: RefObject<IChartApi | null>;
  /** Live price-pane series ref (the one lightweight-charts gives us
   *  for the candle / line / area). Typed as PriceConverter — the
   *  structural subset we need; the real ISeriesApi assigns to it.
   *  Pass the PRICE-pane series, not an oscillator-pane series, or
   *  drawings will project through the wrong scale. */
  seriesRef: RefObject<PriceConverter | null>;
  /** The same div lightweight-charts mounts its canvas into. The
   *  overlay's canvas tracks this div's dimensions via ResizeObserver
   *  so it stays exactly aligned with the chart. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Flips true once the chart-init effect has populated chartRef.
   *  Used as the re-subscription trigger — when chartReady transitions
   *  false → true (mount, hot-reload, Strict Mode double-mount), the
   *  effect tears down old subscriptions and attaches new ones to the
   *  fresh chart instance. */
  chartReady: boolean;
  /** Persisted drawings for the active slab. Rendered every frame;
   *  hit-tested on click for selection. */
  drawings: readonly Drawing[];
  /** Setter for removing a drawing by id (Delete / Backspace path). */
  deleteDrawing: (id: string) => void;
  /** Active drawing tool. Pointer is the only branch wired in this
   *  commit; future commits add creation flows for trend / horizontal
   *  / rectangle. */
  tool: DrawingTool;
  /** Setter for the active tool. Used by the keyboard handler's
   *  Escape priority chain to fall back to pointer when nothing
   *  selectable is in flight. */
  setTool: (next: DrawingTool) => void;
  /** The slab whose drawings these are. Used to reset overlay-local
   *  selection state when the user navigates between markets. */
  slabAddress: string;
}

/**
 * Transparent canvas layered above the chart, dedicated to user-drawn
 * annotations (trend lines, horizontal lines, rectangles). Owns:
 * - render of the drawings list (per-kind branches with selected
 *   highlight)
 * - click dispatch for the active tool (pointer-mode hit-testing in
 *   this commit; creation flows in subsequent commits)
 * - keyboard handling (Escape priority chain + Delete / Backspace)
 *
 * Critical contract: `pointer-events: none` ALWAYS. The overlay never
 * captures pointer events. Click handling routes through
 * chart.subscribeClick so lightweight-charts' native pan / zoom keep
 * working. Setting pointer-events: auto would silently kill every
 * chart interaction.
 *
 * Layout: `absolute inset-0` fills the chart container. DOM order
 * places it AFTER the chart canvas (so it stacks above) but BEFORE
 * the empty-state / hover-tooltip / position-summary overlays (which
 * use `z-10` and stack above the drawing overlay — drawings should
 * not occlude the position badge or the OHLCV tooltip).
 *
 * State architecture: the main effect (subscriptions + canvas setup)
 * keys only on `[chartRef, containerRef, seriesRef, chartReady]` so it
 * doesn't re-fire on every drawings / selectedId / tool change. A
 * sibling effect drives redraws on data change without re-subscribing,
 * and event handlers read latest state via `stateRef`. The redraw
 * closure is published to `redrawRef` so the data-change effect can
 * call it imperatively.
 */
export const ChartDrawingOverlay: FC<ChartDrawingOverlayProps> = ({
  chartRef,
  seriesRef,
  containerRef,
  chartReady,
  drawings,
  deleteDrawing,
  tool,
  setTool,
  slabAddress,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Currently selected drawing's id, or null. Overlay-local state —
   *  intentionally NOT persisted (a fresh page should start with
   *  nothing selected, and selection doesn't survive market switches). */
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Reset selection when the active slab changes — the user switched
  // markets, the previous selection no longer applies.
  useEffect(() => {
    setSelectedId(null);
  }, [slabAddress]);

  // Reset selection when the active tool changes. Switching to a
  // creation tool while a drawing is selected would leave a stray
  // highlight that the new tool can't act on; clearing here keeps
  // overlay-local state consistent with what the user just chose.
  useEffect(() => {
    setSelectedId(null);
  }, [tool]);

  // If the selected drawing was removed (Delete / Backspace, slab
  // change clearing storage, etc.), drop the dangling id.
  useEffect(() => {
    if (selectedId !== null && !drawings.some((d) => d.id === selectedId)) {
      setSelectedId(null);
    }
  }, [drawings, selectedId]);

  // Latest-state ref for handlers in the main effect to read without
  // putting these in the effect's deps array (which would tear down
  // and re-attach all subscriptions on every state change — defeats
  // the whole point of the overlay).
  const stateRef = useRef({ drawings, selectedId, tool });
  stateRef.current = { drawings, selectedId, tool };

  // Imperative redraw seam: the main effect populates this with a
  // closure that captures the canvas / ctx / converters; the
  // data-change effect below calls it without re-running the main
  // effect.
  const redrawRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!chartReady) return;
    const chart = chartRef.current;
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!chart || !container || !canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let logicalW = 0;
    let logicalH = 0;

    const redraw = (): void => {
      ctx.clearRect(0, 0, logicalW, logicalH);
      const series = seriesRef.current;
      if (!series) return;
      const timeScaleApi = chart.timeScale() as unknown as TimeConverter;
      const { drawings, selectedId } = stateRef.current;
      for (const drawing of drawings) {
        renderDrawing(
          ctx,
          logicalW,
          drawing,
          drawing.id === selectedId,
          series,
          timeScaleApi,
        );
      }
    };
    redrawRef.current = redraw;

    const resize = (): void => {
      const dpr = window.devicePixelRatio ?? 1;
      logicalW = container.clientWidth;
      logicalH = container.clientHeight;
      sizeCanvasForDpr(canvas, ctx, logicalW, logicalH, dpr);
      redraw();
    };

    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(container);

    const ts = chart.timeScale();
    ts.subscribeVisibleLogicalRangeChange(redraw);
    ts.subscribeSizeChange(redraw);

    // Click dispatch via chart.subscribeClick. Routes through the
    // chart's own canvas (which has pointer-events) so lightweight-
    // charts' pan / zoom keeps working. Future commits add branches
    // for trend / horizontal / rectangle creation flows; for now,
    // pointer is the only one wired.
    //
    // Mobile note: the toolbar is `hidden md:flex` so a phone user
    // can't change the tool, but a desktop session may have left
    // a creation tool persisted. Pointer mode is safe everywhere
    // (passive read); creation tools will need their own mobile
    // guards when they land.
    const onClick = (param: MouseEventParams<Time>): void => {
      const { tool, drawings } = stateRef.current;
      if (tool !== "pointer") return;
      if (!param.point) return;
      const series = seriesRef.current;
      if (!series) return;
      const timeScaleApi = chart.timeScale() as unknown as TimeConverter;
      const hitId = findHitDrawingId(
        drawings,
        param.point.x,
        param.point.y,
        series,
        timeScaleApi,
      );
      // setSelectedId always — even if hitId is null (deselect).
      setSelectedId(hitId);
    };
    chart.subscribeClick(onClick);

    return () => {
      ro.disconnect();
      try {
        ts.unsubscribeVisibleLogicalRangeChange(redraw);
        ts.unsubscribeSizeChange(redraw);
        chart.unsubscribeClick(onClick);
      } catch {
        // Chart was destroyed in a parallel cleanup. Refs already
        // dangling; the swallow keeps cleanup pure and silent.
      }
      redrawRef.current = () => {};
    };
  }, [chartRef, containerRef, seriesRef, chartReady]);

  // Drive redraw when drawings or selection state change without
  // tearing down + re-subscribing the main effect. The redrawRef is
  // populated inside the main effect; if the main effect hasn't run
  // yet (chartReady=false on initial mount), the no-op default kicks
  // in and this is a cheap miss.
  useEffect(() => {
    redrawRef.current();
  }, [drawings, selectedId]);

  // Keyboard: Escape priority chain + Delete / Backspace removes the
  // selected drawing. Both guarded against firing while focus is in
  // an input (so the order form's Backspace clears a digit instead
  // of deleting the user's drawing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const active = document.activeElement;
      if (
        active != null &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          (active as HTMLElement).isContentEditable)
      ) {
        return;
      }
      if (e.key === "Escape") {
        // Priority chain. Future tools (commit 6+) will insert a
        // pending-anchor cancel BEFORE the selectedId clear so a
        // half-drawn trend line cancels first, then a second
        // Escape returns to pointer.
        const { selectedId, tool } = stateRef.current;
        if (selectedId !== null) {
          setSelectedId(null);
          return;
        }
        if (tool !== "pointer") {
          setTool("pointer");
        }
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        const { selectedId } = stateRef.current;
        if (selectedId !== null) {
          deleteDrawing(selectedId);
          // selectedId resets via the "selected was removed" effect
          // when drawings updates. preventDefault stops Backspace
          // from triggering the browser's history-back nav.
          e.preventDefault();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setTool, deleteDrawing]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0"
      aria-hidden="true"
    />
  );
};

// =====================================================================
// Render layer
// =====================================================================

/** Brand accent (--accent in the theme). Hardcoded as RGB so the
 *  fill / stroke variants can derive different alphas without parsing
 *  CSS variables on every frame. */
const ACCENT_RGB = "153, 69, 255";
const ACCENT_STROKE = `rgb(${ACCENT_RGB})`;
const ACCENT_FILL = `rgba(${ACCENT_RGB}, 0.15)`;
const SELECTED_LINE_WIDTH = 2.5;
const DEFAULT_LINE_WIDTH = 1.5;
const ANCHOR_RADIUS = 4;

function renderDrawing(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  drawing: Drawing,
  selected: boolean,
  series: PriceConverter,
  timeScale: TimeConverter,
): void {
  ctx.strokeStyle = ACCENT_STROKE;
  ctx.lineWidth = selected ? SELECTED_LINE_WIDTH : DEFAULT_LINE_WIDTH;

  switch (drawing.kind) {
    case "trend": {
      const p1 = pricePointToPixel(series, timeScale, drawing.p1);
      const p2 = pricePointToPixel(series, timeScale, drawing.p2);
      if (p1 === null || p2 === null) return;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      if (selected) {
        drawAnchor(ctx, p1.x, p1.y);
        drawAnchor(ctx, p2.x, p2.y);
      }
      return;
    }
    case "horizontal": {
      const y = series.priceToCoordinate(drawing.price);
      if (y === null) return;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvasW, y);
      ctx.stroke();
      // Horizontal lines have no point-anchors to dot — the entire
      // line is the anchor. The thicker selected line stroke is the
      // visual cue.
      return;
    }
    case "rectangle": {
      const p1 = pricePointToPixel(series, timeScale, drawing.p1);
      const p2 = pricePointToPixel(series, timeScale, drawing.p2);
      if (p1 === null || p2 === null) return;
      const x = Math.min(p1.x, p2.x);
      const y = Math.min(p1.y, p2.y);
      const w = Math.abs(p2.x - p1.x);
      const h = Math.abs(p2.y - p1.y);
      ctx.fillStyle = ACCENT_FILL;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      if (selected) {
        drawAnchor(ctx, p1.x, p1.y);
        drawAnchor(ctx, p2.x, p2.y);
      }
      return;
    }
    default:
      assertNever(drawing);
  }
}

/** Filled accent dot at a drawing's anchor point. Used for selected
 *  drawings to advertise where the user can grab to edit (drag-edit
 *  is deferred to v2; the dots are the contract for future
 *  interaction). */
function drawAnchor(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = ACCENT_STROKE;
  ctx.beginPath();
  ctx.arc(x, y, ANCHOR_RADIUS, 0, Math.PI * 2);
  ctx.fill();
}
