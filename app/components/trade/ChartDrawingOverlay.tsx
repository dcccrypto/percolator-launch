"use client";

import { useEffect, useRef, type FC, type RefObject } from "react";
import type { IChartApi } from "lightweight-charts";
import { sizeCanvasForDpr } from "@/lib/chart-canvas";

interface ChartDrawingOverlayProps {
  /** Live chart API ref managed by the parent's chart-init effect.
   *  May be null briefly between mount and chart creation. */
  chartRef: RefObject<IChartApi | null>;
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
}

/**
 * A transparent canvas layered above the chart, dedicated to user-drawn
 * annotations (trend lines, horizontal lines, rectangles). Renders
 * nothing visible until subsequent commits add the drawing-state props
 * and per-kind render branches; this commit is just the plumbing —
 * canvas mounts at the right size, stays aligned with the chart on
 * resize / pan / zoom, and re-attaches to a new chart instance when
 * the chart is rebuilt.
 *
 * Critical contract: `pointer-events: none` ALWAYS. The overlay never
 * captures pointer events. Click handling for the drawing tools will
 * route through `chart.subscribeClick` (next commits), which keeps
 * lightweight-charts' native pan / zoom intact alongside drawing
 * creation. If the overlay ever set `pointer-events: auto`, every
 * pan / zoom interaction would die.
 *
 * Layout: `absolute inset-0` fills the chart container. DOM order
 * places it AFTER the chart canvas (so it stacks above) but BEFORE
 * the empty-state / hover-tooltip / position-summary overlays (which
 * use `z-10` and stack above the drawing overlay — drawings should
 * not occlude the position badge or the OHLCV tooltip).
 *
 * DPR: backing-store size scales by `devicePixelRatio` for sharp
 * rendering on Retina / fractional-DPR screens; CSS size stays at the
 * container's logical pixels so layout doesn't shift. The 2D context
 * transform handles the multiplication so draw calls in subsequent
 * commits work in CSS-pixel space without per-call DPR math.
 */
export const ChartDrawingOverlay: FC<ChartDrawingOverlayProps> = ({
  chartRef,
  containerRef,
  chartReady,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!chartReady) return;
    const chart = chartRef.current;
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!chart || !container || !canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Cache the logical (CSS-pixel) dimensions used for the LAST resize.
    // `redraw`'s clearRect uses these instead of recomputing from
    // `canvas.width / window.devicePixelRatio` — that recompute reads a
    // FRESH dpr on every redraw, but `canvas.width` was set with the
    // dpr that was current at the last resize. If those disagree (user
    // dragged the window between monitors of identical logical size,
    // so DPR changed but the container didn't, so ResizeObserver
    // didn't fire) the recompute under-clears and leaves ghost trails.
    // The full fix for monitor-swap blur requires a matchMedia
    // listener — deferred to v2 — but caching here at least keeps the
    // clear correct for the canvas's current backing size.
    let logicalW = 0;
    let logicalH = 0;

    /** Clear the canvas. Future commits will iterate the active
     *  drawings list here and call per-kind render branches; for now
     *  the redraw exists only to prove the trigger plumbing fires on
     *  resize / pan / zoom / chart-rebuild. */
    const redraw = (): void => {
      ctx.clearRect(0, 0, logicalW, logicalH);
    };

    /** Re-size the canvas to the container's current dimensions (DPR-
     *  aware) and redraw. Called on initial mount and on every
     *  ResizeObserver tick. */
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
    // subscribeVisibleLogicalRangeChange (NOT visibleTimeRangeChange):
    // the time-range variant clamps to bar coverage and can stay
    // frozen at the right-edge "future padding" zone during pan. The
    // logical-range variant is the canonical "chart needs to redraw"
    // hook and fires for every pan / zoom regardless of bar coverage.
    ts.subscribeVisibleLogicalRangeChange(redraw);
    // subscribeSizeChange catches internal chart reflows that DON'T
    // change the container size — most commonly when the price-scale
    // gutter widens because a price label grew a digit ($99 → $100,
    // $9999 → $10000). ResizeObserver doesn't see those.
    ts.subscribeSizeChange(redraw);

    return () => {
      ro.disconnect();
      try {
        ts.unsubscribeVisibleLogicalRangeChange(redraw);
        ts.unsubscribeSizeChange(redraw);
      } catch {
        // Chart was destroyed in a parallel cleanup (Strict Mode
        // double-unmount, parent unmount). Refs are already dangling;
        // the swallow keeps the cleanup pure and silent.
      }
    };
  }, [chartRef, containerRef, chartReady]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0"
      aria-hidden="true"
    />
  );
};
