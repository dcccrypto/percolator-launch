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
  pixelToPricePoint,
  type PriceConverter,
  type TimeConverter,
} from "@/lib/chart-coords";
import {
  type Drawing,
  type DrawingInput,
  type DrawingTool,
  type PricePoint,
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
  /** Setter for adding a new drawing (creation flows: trend, horizontal,
   *  rectangle). The hook generates the id + persists. */
  addDrawing: (input: DrawingInput) => void;
  /** Setter for removing a drawing by id (Delete / Backspace path). */
  deleteDrawing: (id: string) => void;
  /** Active drawing tool. Pointer hit-tests; trend uses two-click
   *  creation; horizontal commits on a single click; rectangle uses
   *  drag (separate commit). */
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
  addDrawing,
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
  /** First click of a multi-click creation flow — locked-in anchor
   *  waiting for the second click to commit (trend tool). State, not
   *  ref, because the keyboard handler's Escape priority chain reads
   *  it to decide whether to cancel the pending creation or fall
   *  through to deselect / tool-reset. */
  const [pendingP1, setPendingP1] = useState<PricePoint | null>(null);
  /** Live preview anchor — where the second click WOULD commit if
   *  the user clicked right now. Updated on every crosshair move
   *  while pendingP1 is set. Ref (not state) because it changes at
   *  ~60 fps during hover and re-rendering React on every move
   *  would be wasteful — the redraw call after each ref update
   *  paints the preview line directly. */
  const previewP2Ref = useRef<PricePoint | null>(null);

  // Reset overlay-local state on slab change OR tool change. Combined
  // into one effect because both triggers want the same reset (clear
  // selection AND any in-flight creation): a slab switch makes the
  // previous selection irrelevant, and a tool switch invalidates a
  // half-drawn anchor that the new tool can't act on.
  useEffect(() => {
    setSelectedId(null);
    setPendingP1(null);
    previewP2Ref.current = null;
  }, [slabAddress, tool]);

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
  const stateRef = useRef({ drawings, selectedId, tool, pendingP1 });
  stateRef.current = { drawings, selectedId, tool, pendingP1 };

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
      const { drawings, selectedId, pendingP1 } = stateRef.current;
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
      // In-flight creation preview: the trend tool draws a faded
      // dashed line from the locked-in p1 to wherever the cursor
      // currently is, so the user can see what they're about to
      // commit on the second click.
      if (pendingP1 !== null) {
        renderTrendPreview(
          ctx,
          pendingP1,
          previewP2Ref.current,
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
    // charts' pan / zoom keeps working. Per-tool branches:
    // - pointer: hit-test against drawings, set / clear selection
    // - horizontal: single-click commits a horizontal at the click's
    //   price level
    // - trend: two-click flow — click 1 sets pendingP1, click 2
    //   commits {p1, p2} as a trend drawing and resets pendingP1
    // - rectangle: separate commit (drag-driven, not click-driven)
    //
    // Mobile note: the toolbar is `hidden md:flex` so a phone user
    // can't change the tool, but a desktop session may have left
    // a creation tool persisted. Pointer mode is safe everywhere
    // (passive read); creation tools also fire here on mobile but
    // a phone user has no way to back out — see the mobile guard
    // todo for the rectangle commit.
    const onClick = (param: MouseEventParams<Time>): void => {
      const { tool, drawings, pendingP1 } = stateRef.current;
      if (!param.point) return;
      const series = seriesRef.current;
      if (!series) return;
      const timeScaleApi = chart.timeScale() as unknown as TimeConverter;

      switch (tool) {
        case "pointer": {
          const hitId = findHitDrawingId(
            drawings,
            param.point.x,
            param.point.y,
            series,
            timeScaleApi,
          );
          // setSelectedId always — even if hitId is null (deselect).
          setSelectedId(hitId);
          return;
        }
        case "horizontal": {
          const price = series.coordinateToPrice(param.point.y);
          if (price === null) return;
          addDrawing({ kind: "horizontal", price });
          // Tool stays in horizontal mode — TradingView convention.
          // User explicitly switches via toolbar or Escape to leave.
          return;
        }
        case "trend": {
          const point = pixelToPricePoint(
            series,
            timeScaleApi,
            param.point.x,
            param.point.y,
          );
          if (point === null) return;
          if (pendingP1 === null) {
            // First click — lock in the start point. The second
            // click will commit {pendingP1, point}.
            setPendingP1(point);
          } else {
            // Second click — commit, then reset for the next trend.
            // Tool stays in trend mode; the user can keep drawing
            // until they explicitly change tools.
            addDrawing({ kind: "trend", p1: pendingP1, p2: point });
            setPendingP1(null);
            previewP2Ref.current = null;
          }
          return;
        }
        case "rectangle":
          // Drag-driven creation lands in a separate commit. Click
          // is not the trigger — left intentionally unhandled so
          // an accidental click in rectangle mode doesn't drop a
          // zero-size rect.
          return;
      }
    };
    chart.subscribeClick(onClick);

    // Crosshair-move drives the live preview during multi-click
    // creation (trend tool only in this commit). Updates a ref —
    // not React state — and triggers a redraw imperatively, so we
    // don't burn a render cycle per mouse-move (~60 fps).
    const onCrosshairMove = (param: MouseEventParams<Time>): void => {
      const { tool, pendingP1 } = stateRef.current;
      if (tool !== "trend" || pendingP1 === null) return;
      const series = seriesRef.current;
      if (!series) {
        previewP2Ref.current = null;
        return;
      }
      if (!param.point) {
        // Cursor left the chart — drop the preview.
        previewP2Ref.current = null;
        redraw();
        return;
      }
      const timeScaleApi = chart.timeScale() as unknown as TimeConverter;
      const point = pixelToPricePoint(
        series,
        timeScaleApi,
        param.point.x,
        param.point.y,
      );
      previewP2Ref.current = point;
      redraw();
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    return () => {
      ro.disconnect();
      try {
        ts.unsubscribeVisibleLogicalRangeChange(redraw);
        ts.unsubscribeSizeChange(redraw);
        chart.unsubscribeClick(onClick);
        chart.unsubscribeCrosshairMove(onCrosshairMove);
      } catch {
        // Chart was destroyed in a parallel cleanup. Refs already
        // dangling; the swallow keeps cleanup pure and silent.
      }
      redrawRef.current = () => {};
    };
  }, [chartRef, containerRef, seriesRef, chartReady, addDrawing]);

  // Drive redraw when drawings, selection, or pending-creation state
  // change without tearing down + re-subscribing the main effect. The
  // redrawRef is populated inside the main effect; if the main effect
  // hasn't run yet (chartReady=false on initial mount), the no-op
  // default kicks in and this is a cheap miss.
  //
  // pendingP1 in the deps so the preview anchor dot appears the
  // moment the first trend click lands (without waiting for the next
  // crosshair move to repaint).
  useEffect(() => {
    redrawRef.current();
  }, [drawings, selectedId, pendingP1]);

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
        // Priority chain (highest first):
        // 1. Cancel pending creation (locked-in trend p1) — keep tool
        // 2. Clear selection
        // 3. Reset tool to pointer
        // 4. No-op
        // The order matches user expectation: a half-drawn anchor
        // is the most recent action and the most "in flight," so
        // it gets the first Escape.
        const { pendingP1, selectedId, tool } = stateRef.current;
        if (pendingP1 !== null) {
          setPendingP1(null);
          previewP2Ref.current = null;
          return;
        }
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
          // preventDefault on BOTH keys: Backspace is the obvious
          // back-nav trigger, but Firefox configurations (and some
          // screen-reader virtual cursors) bind Delete to navigation
          // or "delete element" actions too. Symmetric prevention
          // costs nothing and keeps the user's keystroke from
          // escaping into the browser when a drawing was just
          // removed.
          e.preventDefault();
          deleteDrawing(selectedId);
          // selectedId resets via the "selected was removed" effect
          // when drawings updates.
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
      const x2 = Math.max(p1.x, p2.x);
      const y2 = Math.max(p1.y, p2.y);
      const w = x2 - x;
      const h = y2 - y;
      ctx.fillStyle = ACCENT_FILL;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      if (selected) {
        // All four corners get an anchor dot, not just the original
        // p1 / p2. Hit-testing treats every edge as grabbable so the
        // visual cue should match — two corners would imply only
        // those two are interactive (they're not; v1 has no
        // drag-edit, the dots are pure selection feedback).
        drawAnchor(ctx, x, y);
        drawAnchor(ctx, x2, y);
        drawAnchor(ctx, x, y2);
        drawAnchor(ctx, x2, y2);
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

/** Live preview for an in-flight trend creation: faded dashed line
 *  from the locked-in p1 to wherever the cursor currently is, with
 *  a solid anchor dot at p1 to show the start point is committed.
 *  No dot at p2 — that anchor isn't locked in yet (the next click
 *  commits it). Returns silently if either endpoint projects off-
 *  scale or if the cursor hasn't moved into the chart yet
 *  (previewP2 === null). */
function renderTrendPreview(
  ctx: CanvasRenderingContext2D,
  pendingP1: PricePoint,
  previewP2: PricePoint | null,
  series: PriceConverter,
  timeScale: TimeConverter,
): void {
  const p1 = pricePointToPixel(series, timeScale, pendingP1);
  if (p1 === null) return;
  // Always paint the anchor dot (so the user knows their first
  // click was registered) even if the cursor is off-chart.
  ctx.save();
  ctx.fillStyle = ACCENT_STROKE;
  ctx.beginPath();
  ctx.arc(p1.x, p1.y, ANCHOR_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  if (previewP2 !== null) {
    const p2 = pricePointToPixel(series, timeScale, previewP2);
    if (p2 !== null) {
      ctx.strokeStyle = ACCENT_STROKE;
      ctx.globalAlpha = 0.6;
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = DEFAULT_LINE_WIDTH;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  }
  ctx.restore();
}
