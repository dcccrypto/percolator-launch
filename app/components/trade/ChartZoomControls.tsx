"use client";

import { type FC, type ReactNode } from "react";

export interface ChartZoomControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  /** Whether drag currently box-zooms (true) or pans (false, the
   *  lightweight-charts default). */
  dragToZoom: boolean;
  onToggleDragToZoom: () => void;
}

const PlusIcon = (): ReactNode => (
  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
    <line x1="7" y1="2" x2="7" y2="12" />
    <line x1="2" y1="7" x2="12" y2="7" />
  </svg>
);

const MinusIcon = (): ReactNode => (
  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
    <line x1="2" y1="7" x2="12" y2="7" />
  </svg>
);

/** Four inward-pointing corner brackets — the "fit to frame" convention
 *  used by most charting/imaging toolbars for a reset-zoom action. */
const FitIcon = (): ReactNode => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="M1.5 4.5V2h2.5" />
    <path d="M12.5 4.5V2h-2.5" />
    <path d="M1.5 9.5V12h2.5" />
    <path d="M12.5 9.5V12h-2.5" />
  </svg>
);

/** Magnifying glass — toggled on to switch plain drag from pan to
 *  box-zoom. */
const MagnifierIcon = (): ReactNode => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="6" cy="6" r="4" />
    <line x1="9.2" y1="9.2" x2="12.5" y2="12.5" />
  </svg>
);

const buttonClass =
  "flex h-6 w-6 pointer-coarse:h-8 pointer-coarse:w-8 items-center justify-center rounded-none transition-colors " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-1 " +
  "text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] hover:text-[var(--text)]";

const toggleButtonClass = (active: boolean): string =>
  [
    "flex h-6 w-6 pointer-coarse:h-8 pointer-coarse:w-8 items-center justify-center rounded-none transition-colors",
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-1",
    active
      ? "bg-[var(--accent)]/10 text-[var(--accent)]"
      : "text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] hover:text-[var(--text)]",
  ].join(" ");

/**
 * Chart zoom toolbar: zoom in / zoom out / reset-to-fit, plus a
 * "drag to zoom" mode toggle (magnifier). Lives in the same header
 * controls row as ChartStyleMenu / ChartDisplayMenu / the timeframe
 * pills — NOT overlaid on the chart canvas — so it can't collide with
 * the price/time scale or the canvas-overlaid drawing toolbar, and it
 * wraps for free at mobile widths via the parent's `flex-wrap`.
 *
 * Purely presentational: all state (dragToZoom) and chart wiring lives
 * in `useChartZoomControls`. Box-zoom-drag itself and double-click-reset
 * are wired directly to the chart element by that hook, not through
 * this component.
 */
export const ChartZoomControls: FC<ChartZoomControlsProps> = ({
  onZoomIn,
  onZoomOut,
  onReset,
  dragToZoom,
  onToggleDragToZoom,
}) => {
  return (
    <div
      aria-label="Chart zoom controls"
      className="flex items-center gap-0.5 rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5"
    >
      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in (+)"
        onClick={onZoomIn}
        className={buttonClass}
      >
        <PlusIcon />
      </button>
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out (-)"
        onClick={onZoomOut}
        className={buttonClass}
      >
        <MinusIcon />
      </button>
      <button
        type="button"
        aria-label="Reset zoom"
        title="Reset zoom (or double-click the chart)"
        onClick={onReset}
        className={buttonClass}
      >
        <FitIcon />
      </button>
      <div
        role="separator"
        aria-orientation="vertical"
        className="mx-0.5 h-4 w-px bg-[var(--border)]"
      />
      <button
        type="button"
        aria-label="Drag to zoom"
        aria-pressed={dragToZoom}
        title={dragToZoom ? "Drag to zoom: ON (drag the chart to box-zoom)" : "Drag to zoom: OFF (drag the chart to pan)"}
        onClick={onToggleDragToZoom}
        className={toggleButtonClass(dragToZoom)}
      >
        <MagnifierIcon />
      </button>
    </div>
  );
};
