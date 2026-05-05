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

    /** Clear the canvas. Future commits will iterate the active
     *  drawings list here and call per-kind render branches; for now
     *  the redraw exists only to prove the trigger plumbing fires on
     *  resize / pan / zoom / chart-rebuild. */
    const redraw = (): void => {
      const dpr = window.devicePixelRatio ?? 1;
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      ctx.clearRect(0, 0, w, h);
    };

    /** Re-size the canvas to the container's current dimensions (DPR-
     *  aware) and redraw. Called on initial mount and on every
     *  ResizeObserver tick. */
    const resize = (): void => {
      const dpr = window.devicePixelRatio ?? 1;
      const w = container.clientWidth;
      const h = container.clientHeight;
      sizeCanvasForDpr(canvas, ctx, w, h, dpr);
      redraw();
    };

    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(container);

    const ts = chart.timeScale();
    ts.subscribeVisibleTimeRangeChange(redraw);

    return () => {
      ro.disconnect();
      try {
        ts.unsubscribeVisibleTimeRangeChange(redraw);
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
