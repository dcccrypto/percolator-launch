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

  // setTool is routed through a ref so the slab/chart-init reset
  // effect below doesn't re-fire on every rerender just because the
  // parent passes a new function reference each render. Same pattern
  // as addDrawingRef — keeps the effect's deps minimal so it only
  // fires on the events it actually cares about (slab change,
  // chart re-init).
  const setToolRef = useRef(setTool);
  setToolRef.current = setTool;

  // Slab change OR chart re-init: clear in-flight creation/selection
  // AND drop the active tool back to pointer. Tool selection is
  // global to the React tree (one toolbar, one chart) so without
  // this reset, a user mid-trend on BTC who navigates to SOL would
  // arrive on the new chart still in trend mode — the next click
  // silently drops a creation anchor with no signal that a tool's
  // still active. Pointer is the safe default for arriving at a
  // new chart. chartReady's false→true edge (Strict Mode
  // double-mount, hot-reload, any future code path that rebuilds
  // the chart) also invalidates pendingP1's pixel projection
  // because the new chart may have a different visible range.
  useEffect(() => {
    setSelectedId(null);
    setPendingP1(null);
    previewP2Ref.current = null;
    setToolRef.current("pointer");
  }, [slabAddress, chartReady]);

  // Tool change (user picked a different tool from the toolbar):
  // clear in-flight creation/selection but DON'T touch the tool —
  // the user just selected it. Separate from the slab/chartReady
  // effect above so resetting the tool there doesn't bounce-fire
  // its own deps in a feedback loop.
  useEffect(() => {
    setSelectedId(null);
    setPendingP1(null);
    previewP2Ref.current = null;
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
  const stateRef = useRef({ drawings, selectedId, tool, pendingP1 });
  stateRef.current = { drawings, selectedId, tool, pendingP1 };

  // addDrawing is also routed through a ref rather than being in the
  // main effect's deps. The hook returns a useCallback-stable
  // reference today, but parking it in deps would make the entire
  // chart-subscription stack load-bearing on a hook two layers up —
  // any future refactor that breaks that memoization would silently
  // tear down + re-attach all four chart subscriptions on every
  // render. The ref keeps the architecture's "subscribe once" contract
  // intact regardless of upstream callback identity.
  const addDrawingRef = useRef(addDrawing);
  addDrawingRef.current = addDrawing;

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
      // Resolve fill once per frame so a theme switch repaints with
      // the right alpha at the next redraw without an explicit
      // subscription. Stroke uses pure accent regardless of theme.
      const fillStyle = isLightTheme() ? ACCENT_FILL_LIGHT : ACCENT_FILL_DARK;
      // Clip to the price pane's candle area. The drawing canvas
      // covers the whole container including the volume sub-region
      // and any oscillator panes (RSI/MACD via addPane), but the
      // price-pane series' coord conversion is only valid within
      // this band. Without clipping, drawings can paint into pane
      // regions where they don't belong.
      const bounds = getPriceAreaBounds(chart);
      ctx.save();
      if (bounds !== null) {
        ctx.beginPath();
        ctx.rect(0, bounds.top, logicalW, bounds.bottom - bounds.top);
        ctx.clip();
      }
      for (const drawing of drawings) {
        renderDrawing(
          ctx,
          logicalW,
          drawing,
          drawing.id === selectedId,
          series,
          timeScaleApi,
          fillStyle,
        );
      }
      // In-flight creation preview, dispatched by tool:
      // - trend: faded dashed line from pendingP1 to cursor + dot at p1
      // - rectangle: faded dashed rect from pendingP1 to cursor (no dots)
      // pointer / horizontal don't have multi-step creation; pendingP1
      // shouldn't be set in those modes.
      if (pendingP1 !== null) {
        const { tool } = stateRef.current;
        if (tool === "trend") {
          renderTrendPreview(
            ctx,
            pendingP1,
            previewP2Ref.current,
            series,
            timeScaleApi,
          );
        } else if (tool === "rectangle") {
          renderRectanglePreview(
            ctx,
            pendingP1,
            previewP2Ref.current,
            series,
            timeScaleApi,
            fillStyle,
          );
        }
      }
      ctx.restore();
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
      // Mobile guard: every tool short-circuits on touch viewports.
      // - Creation tools (trend/horizontal/rectangle) need the toolbar
      //   (hidden below md) and Escape (unreliable on soft keyboards),
      //   neither of which is available on phones.
      // - Pointer mode is also gated because mobile users have no
      //   way to delete a selected drawing (Backspace/Delete don't
      //   reach the document on most mobile soft keyboards). Letting
      //   them select but not delete is a worse trap than not
      //   selecting at all — drawings stay visible as static art on
      //   touch viewports until the user returns to a desktop.
      // matchMedia is undefined in some non-browser environments;
      // defensive default is "treat as desktop."
      if (
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(max-width: 767px)").matches
      ) {
        return;
      }
      // Pane bleed-through guard: reject clicks outside the price-
      // pane's candle area (volume sub-region or any oscillator pane).
      // The price-pane series' coordinateToPrice extrapolates rather
      // than returning null for y values past the scale margins, so
      // without this a click in the RSI pane would create a phantom
      // horizontal at an extrapolated price the user can't see. The
      // canvas itself is already clipped to this band on render;
      // rejecting clicks too keeps creation symmetric with rendering.
      const bounds = getPriceAreaBounds(chart);
      if (
        bounds !== null &&
        (param.point.y < bounds.top || param.point.y > bounds.bottom)
      ) {
        return;
      }
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
          addDrawingRef.current({ kind: "horizontal", price });
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
            // Reject a zero-length trend: a double-click at the same
            // pixel commits a trend with p1 === p2 that hit-tests as
            // a single dot — visually broken and clutters persisted
            // drawings. Keep pendingP1 set so the user can move and
            // try again. Same-bar same-price equality is exact since
            // pixelToPricePoint trunc'd both inputs through the same
            // Math.trunc(ms/1000) boundary.
            if (
              point.time === pendingP1.time &&
              point.price === pendingP1.price
            ) {
              return;
            }
            // Second click — commit, then reset for the next trend.
            // Tool stays in trend mode; the user can keep drawing
            // until they explicitly change tools.
            addDrawingRef.current({
              kind: "trend",
              p1: pendingP1,
              p2: point,
            });
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
        default:
          // Compile-error guard: a future DrawingTool kind added
          // to the union without a case here will fail to type-
          // check rather than silently no-op the click.
          return assertNever(tool);
      }
    };
    chart.subscribeClick(onClick);

    // Crosshair-move drives the live preview during multi-click
    // creation (trend tool). lightweight-charts fires this on every
    // pixel of cursor motion (~60 Hz on standard mice, higher on
    // high-poll-rate gaming mice / 240 Hz trackpads). Coalesce to one
    // redraw per frame via rAF — without this, a half-drawn trend
    // hover at 100 drawings × ~4 canvas ops each saturates the main
    // thread on lower-end laptops + battery.
    //
    // Scheduling uses a separate boolean flag from the rAF id: a
    // synchronous rAF (used in tests) runs the callback inline and
    // returns the id afterwards, which would otherwise leave a stale
    // id stored under an "id == 0 means free" convention. Splitting
    // the flag from the id keeps the scheduler correct for both
    // sync and async rAF semantics.
    let crosshairScheduled = false;
    let crosshairRafId = 0;
    let crosshairPending: { point: PricePoint | null; cursorLeft: boolean } | null = null;
    const flushCrosshairPreview = (): void => {
      crosshairScheduled = false;
      crosshairRafId = 0;
      if (crosshairPending === null) return;
      const { tool, pendingP1 } = stateRef.current;
      if (tool !== "trend" || pendingP1 === null) {
        crosshairPending = null;
        return;
      }
      const series = seriesRef.current;
      if (!series) {
        previewP2Ref.current = null;
        crosshairPending = null;
        return;
      }
      previewP2Ref.current = crosshairPending.cursorLeft
        ? null
        : crosshairPending.point;
      crosshairPending = null;
      redraw();
    };
    const onCrosshairMove = (param: MouseEventParams<Time>): void => {
      const { tool, pendingP1 } = stateRef.current;
      if (tool !== "trend" || pendingP1 === null) return;
      const series = seriesRef.current;
      if (!series) {
        previewP2Ref.current = null;
        return;
      }
      if (!param.point) {
        // Cursor left the chart — drop the preview on the next frame.
        crosshairPending = { point: null, cursorLeft: true };
      } else {
        const timeScaleApi = chart.timeScale() as unknown as TimeConverter;
        const point = pixelToPricePoint(
          series,
          timeScaleApi,
          param.point.x,
          param.point.y,
        );
        crosshairPending = { point, cursorLeft: false };
      }
      if (!crosshairScheduled) {
        crosshairScheduled = true;
        crosshairRafId = window.requestAnimationFrame(flushCrosshairPreview);
      }
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    return () => {
      ro.disconnect();
      // Cancel any pending preview frame so a teardown mid-hover
      // doesn't race a stale callback against a destroyed chart.
      if (crosshairScheduled) {
        window.cancelAnimationFrame(crosshairRafId);
        crosshairScheduled = false;
        crosshairRafId = 0;
      }
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
  }, [chartRef, containerRef, seriesRef, chartReady]);

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

  // Rectangle creation: drag-driven (mouse-down inside the chart sets
  // p1, mouse-move tracks the opposite corner, mouse-up commits).
  // chart.subscribeClick can't power this — clicks fire on
  // mouse-down + up at the same place, which is exactly what we
  // DON'T want for a drag. Instead we attach a native mousedown to
  // chart.chartElement() (the chart's own DOM container, the only
  // surface above the canvas with pointer-events). The follow-on
  // move and up listeners attach to document so the user can drag
  // out past the chart edges and release without the gesture
  // breaking.
  useEffect(() => {
    if (!chartReady || tool !== "rectangle") return;
    const chart = chartRef.current;
    if (!chart) return;
    const el = chart.chartElement();

    const onMouseDown = (e: MouseEvent): void => {
      // Left button only; ignore right-click / middle-click.
      if (e.button !== 0) return;
      // Mobile guard: drag-create on touch devices is its own UX
      // problem (gesture conflicts with chart pan, no clear cancel
      // affordance). Bail before pendingP1 is set.
      if (
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(max-width: 767px)").matches
      ) {
        return;
      }
      const series = seriesRef.current;
      if (!series) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // Pane bleed-through guard: same y-bounds check as the click
      // path. A mousedown in the volume sub-region or an oscillator
      // pane would otherwise anchor a rectangle drag at an
      // extrapolated price.
      const bounds = getPriceAreaBounds(chart);
      if (bounds !== null && (y < bounds.top || y > bounds.bottom)) {
        return;
      }
      const ts = chart.timeScale() as unknown as TimeConverter;
      const point = pixelToPricePoint(series, ts, x, y);
      if (point === null) return;
      setPendingP1(point);
    };
    el.addEventListener("mousedown", onMouseDown);
    return () => el.removeEventListener("mousedown", onMouseDown);
  }, [chartReady, tool, chartRef, seriesRef]);

  // While a rectangle drag is in flight (pendingP1 set in rectangle
  // mode), suppress the chart's built-in pan/zoom so the drag
  // gesture doesn't double as a chart pan. Restored on cleanup —
  // commit, Escape, tool change, or chart unmount all flow through
  // here. Also wires the document-level mousemove/mouseup that drive
  // the live preview and the commit.
  //
  // Note: handleScroll suppresses BOTH chart pan AND wheel zoom for
  // the duration of the drag; handleScale suppresses pinch and
  // axis-drag zoom. Users finish the drag before they can wheel-
  // zoom — acceptable trade-off vs fighting the drag gesture.
  useEffect(() => {
    if (!chartReady || tool !== "rectangle" || pendingP1 === null) return;
    const chart = chartRef.current;
    if (!chart) return;
    const el = chart.chartElement();

    // Snapshot the current scroll/scale options before disabling so
    // the cleanup restores whatever shape the parent configured —
    // not coarse `true` booleans. The chart-init in TradingChart
    // uses object form (`handleScroll: { mouseWheel, ... }`); writing
    // boolean `true` on cleanup widens any sub-flag the parent
    // disabled to enabled, silently regressing pan/zoom config.
    const previousScroll = chart.options().handleScroll;
    const previousScale = chart.options().handleScale;
    try {
      chart.applyOptions({
        handleScroll: false,
        handleScale: false,
      });
    } catch {
      // Chart torn down between effect setup and applyOptions call.
      // The cleanup's matching try/catch will swallow any restore
      // attempt symmetrically.
    }

    // Rectangle drag mousemove: same rAF coalesce as the crosshair
    // path. Browsers fire mousemove faster than vsync on high-poll
    // mice (1000 Hz gaming mice, 240 Hz trackpads) — without
    // coalescing, every event runs getBoundingClientRect +
    // pixelToPricePoint + a full redraw. Store the latest client
    // coords; defer projection + redraw to the next frame. The
    // scheduled-flag-vs-id split is the same as the crosshair path
    // and works under sync rAF too.
    let dragScheduled = false;
    let dragRafId = 0;
    let dragPendingClient: { clientX: number; clientY: number } | null = null;
    const flushDragPreview = (): void => {
      dragScheduled = false;
      dragRafId = 0;
      const pending = dragPendingClient;
      if (pending === null) return;
      dragPendingClient = null;
      const series = seriesRef.current;
      if (!series) {
        previewP2Ref.current = null;
        return;
      }
      const rect = el.getBoundingClientRect();
      const x = pending.clientX - rect.left;
      const y = pending.clientY - rect.top;
      const ts = chart.timeScale() as unknown as TimeConverter;
      const point = pixelToPricePoint(series, ts, x, y);
      previewP2Ref.current = point;
      redrawRef.current();
    };
    const onMouseMove = (e: MouseEvent): void => {
      dragPendingClient = { clientX: e.clientX, clientY: e.clientY };
      if (!dragScheduled) {
        dragScheduled = true;
        dragRafId = window.requestAnimationFrame(flushDragPreview);
      }
    };

    const onMouseUp = (e: MouseEvent): void => {
      const series = seriesRef.current;
      if (!series) {
        setPendingP1(null);
        previewP2Ref.current = null;
        return;
      }
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const ts = chart.timeScale() as unknown as TimeConverter;
      const p2 = pixelToPricePoint(series, ts, x, y);
      // Drag ended off-scale (price or time can't project) — cancel
      // rather than commit a partially-defined rectangle.
      if (p2 === null) {
        setPendingP1(null);
        previewP2Ref.current = null;
        return;
      }
      // Min-size guard: if the drag covered fewer than 10 CSS pixels
      // in BOTH dimensions, treat it as click jitter (a user trying
      // to click instead of drag) and cancel without committing a
      // tiny, unselectable rectangle.
      const p1Px = pricePointToPixel(series, ts, pendingP1);
      if (p1Px === null) {
        // Original anchor is no longer projectable (it scrolled off-
        // scale during the drag). We can't validate jitter without
        // p1 in pixel space — commit would produce a rectangle we
        // can't size-check. Cancel rather than guess.
        setPendingP1(null);
        previewP2Ref.current = null;
        return;
      }
      const dx = Math.abs(x - p1Px.x);
      const dy = Math.abs(y - p1Px.y);
      if (dx < 10 && dy < 10) {
        setPendingP1(null);
        previewP2Ref.current = null;
        return;
      }
      addDrawingRef.current({
        kind: "rectangle",
        p1: pendingP1,
        p2,
      });
      setPendingP1(null);
      previewP2Ref.current = null;
      // Tool stays in rectangle mode — TradingView convention.
    };

    // Stuck-state recovery: a few ways the drag can end without a
    // proper mouseup reaching us. All three call the same cancel
    // path — drop pendingP1 + previewP2Ref so the cleanup-on-deps-
    // change re-enables pan and removes the document listeners.
    const cancel = (): void => {
      setPendingP1(null);
      previewP2Ref.current = null;
    };
    // 1. Right-click during drag opens the OS context menu. Firefox
    //    skips the synthesizing mouseup entirely; Chrome may or may
    //    not fire it. Either way, the user expects "cancel my drag"
    //    semantics — stuck pendingP1 with the dashed preview frozen
    //    is a UX trap.
    const onContextMenu = (): void => cancel();
    document.addEventListener("contextmenu", onContextMenu);
    // 2. Window/tab blur (alt-tab, OS notification steals focus,
    //    user dragged into another window). The mouseup will fire
    //    on a different document we can't observe; cancelling here
    //    keeps the chart's pan suppression from latching on.
    const onWindowBlur = (): void => cancel();
    window.addEventListener("blur", onWindowBlur);

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);

    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("blur", onWindowBlur);
      // Cancel any pending drag-preview frame so a teardown mid-drag
      // doesn't race a stale callback that would write to
      // previewP2Ref after the drag context is gone.
      if (dragScheduled) {
        window.cancelAnimationFrame(dragRafId);
        dragScheduled = false;
        dragRafId = 0;
      }
      // Restore the SNAPSHOTTED scroll/scale options regardless of
      // how the drag ended (commit, cancel, Escape, slab change,
      // tool change, chart unmount). Writing the snapshot back
      // preserves whatever shape the parent configured — coarse
      // boolean OR granular object form.
      try {
        chart.applyOptions({
          handleScroll: previousScroll,
          handleScale: previousScale,
        });
      } catch {
        // Chart was destroyed in a parallel cleanup; nothing to
        // restore.
      }
    };
  }, [chartReady, tool, pendingP1, chartRef, seriesRef]);

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
      // z-[1] forces the drawing canvas above lightweight-charts'
      // own canvases (which paint at z-index auto / 0). The earlier
      // implementation relied on DOM order alone — that worked in
      // local dev but in production lightweight-charts' chart
      // container wins the stacking-order tie-break and paints on
      // top of the drawing canvas, so committed drawings save
      // correctly to localStorage and update state but never become
      // visible. z-[1] sits below the z-10 UI badges (empty-state,
      // hover-tooltip, position-summary) and above the chart's
      // canvases. pointer-events stays disabled so chart pan/zoom
      // still works through this layer.
      className="pointer-events-none absolute inset-0 z-[1]"
      aria-hidden="true"
    />
  );
};

// =====================================================================
// Render layer
// =====================================================================

/** Brand accent (--accent in the theme, same hue in dark and light).
 *  Hardcoded as RGB so the fill / stroke variants can derive different
 *  alphas without parsing CSS variables on every frame. */
const ACCENT_RGB = "153, 69, 255";
const ACCENT_STROKE = `rgb(${ACCENT_RGB})`;
/** Fill alpha is theme-dependent: a 15% accent over near-white
 *  (#FAFAFD light bg) reads as a pale lavender wash that's barely
 *  visible — the rectangle's body IS its affordance, so we bump
 *  alpha to 22% in light mode to keep the area legible. Stroke
 *  contrast against light bg is ~5.5:1 unchanged, which clears the
 *  WCAG AA 3:1 graphics threshold. */
const ACCENT_FILL_DARK = `rgba(${ACCENT_RGB}, 0.15)`;
const ACCENT_FILL_LIGHT = `rgba(${ACCENT_RGB}, 0.22)`;
const SELECTED_LINE_WIDTH = 2.5;
const DEFAULT_LINE_WIDTH = 1.5;
const ANCHOR_RADIUS = 4;

/** Read the document-level theme attribute set by the theme switcher
 *  (mirrors useChartTheme's getThemeFromDOM). Called per-frame inside
 *  the redraw closure so a theme switch picks up at the next paint
 *  without an explicit subscribe. SSR-safe — defaults to dark when
 *  document is undefined. */
function isLightTheme(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute("data-theme") === "light";
}

/** Y-bounds of the price pane's candle area (top scale margin to
 *  bottom scale margin), in chart-canvas pixel coordinates. The
 *  drawing canvas spans the whole container, but the price-pane
 *  series' coordinateToPrice / priceToCoordinate map is only valid
 *  within this band — outside (volume sub-region, RSI/MACD oscillator
 *  panes) the conversion extrapolates and creates phantom drawings
 *  at prices the user can't see. The redraw clips to this band, and
 *  click dispatch rejects clicks outside it.
 *
 *  Returns null when the chart can't report panes/scale (early init,
 *  test stub without these methods, chart torn down) — caller falls
 *  back to no-clip / no-reject behaviour. */
function getPriceAreaBounds(
  chart: IChartApi,
): { top: number; bottom: number } | null {
  try {
    const panes = chart.panes();
    if (!Array.isArray(panes) || panes.length === 0) return null;
    const pricePane = panes[0];
    if (!pricePane || typeof pricePane.getHeight !== "function") return null;
    const paneHeight = pricePane.getHeight();
    if (!Number.isFinite(paneHeight) || paneHeight <= 0) return null;
    const scale = chart.priceScale("right");
    const margins = scale.options().scaleMargins;
    const topMargin = margins?.top ?? 0;
    const bottomMargin = margins?.bottom ?? 0;
    return {
      top: paneHeight * topMargin,
      bottom: paneHeight * (1 - bottomMargin),
    };
  } catch {
    return null;
  }
}

function renderDrawing(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  drawing: Drawing,
  selected: boolean,
  series: PriceConverter,
  timeScale: TimeConverter,
  fillStyle: string,
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
      ctx.fillStyle = fillStyle;
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

/** Live preview for an in-flight rectangle drag: faded dashed
 *  outline + filled translucent body from the locked-in mouse-down
 *  corner to the current cursor position. No anchor dots — the rect
 *  shape itself communicates the drag in progress, and committed
 *  rectangles only get corner dots when SELECTED (not during
 *  creation). Returns silently if either endpoint projects off-scale
 *  or before the cursor has moved (previewP2 === null — drag just
 *  started, no opposite corner yet). */
function renderRectanglePreview(
  ctx: CanvasRenderingContext2D,
  pendingP1: PricePoint,
  previewP2: PricePoint | null,
  series: PriceConverter,
  timeScale: TimeConverter,
  fillStyle: string,
): void {
  if (previewP2 === null) return;
  const p1 = pricePointToPixel(series, timeScale, pendingP1);
  const p2 = pricePointToPixel(series, timeScale, previewP2);
  if (p1 === null || p2 === null) return;
  const x = Math.min(p1.x, p2.x);
  const y = Math.min(p1.y, p2.y);
  const w = Math.abs(p2.x - p1.x);
  const h = Math.abs(p2.y - p1.y);
  ctx.save();
  ctx.fillStyle = fillStyle;
  ctx.strokeStyle = ACCENT_STROKE;
  ctx.globalAlpha = 0.6;
  ctx.setLineDash([5, 5]);
  ctx.lineWidth = DEFAULT_LINE_WIDTH;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}
