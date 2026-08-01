"use client";

import { FC, useCallback, useEffect, useRef, useState } from "react";

export interface HoldToLaunchProps {
  onLaunch: () => void;
  disabled?: boolean;
  /** Why the control is disabled — shown in place of the hold prompt. */
  disabledReason?: string;
  /** Skips the hold gesture (used by e2e/mock runs and reduced-motion users). */
  instant?: boolean;
}

const SIZE = 132;
const STROKE = 2.5;
const RADIUS = SIZE / 2 - STROKE;
const CIRC = 2 * Math.PI * RADIUS;
/** Long enough to be a deliberate act, short enough not to be a chore. */
const HOLD_MS = 1100;

/**
 * Press-and-hold launch key.
 *
 * A market launch is irreversible and costs real rent — a single click is too
 * cheap a gesture for it. Holding for ~1.1s while a ring fills makes the
 * commitment physical, and releasing early cleanly aborts with the ring
 * unwinding, so there is no accidental launch and no confirmation modal to
 * bounce through.
 *
 * Keyboard: focus and hold Space/Enter. Reduced-motion (or `instant`) users get
 * a plain activate-on-press, since a timed hold is a motion-dependent gesture.
 */
export const HoldToLaunch: FC<HoldToLaunchProps> = ({
  onLaunch,
  disabled = false,
  disabledReason,
  instant = false,
}) => {
  const [progress, setProgress] = useState(0);
  const [fired, setFired] = useState(false);
  const holding = useRef(false);
  const raf = useRef(0);
  const startedAt = useRef(0);

  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const skipHold = instant || reduced;

  const stop = useCallback(() => {
    holding.current = false;
    cancelAnimationFrame(raf.current);
    setProgress(0);
  }, []);

  const tick = useCallback(() => {
    if (!holding.current) return;
    const p = Math.min(1, (performance.now() - startedAt.current) / HOLD_MS);
    setProgress(p);
    if (p >= 1) {
      holding.current = false;
      setFired(true);
      onLaunch();
      return;
    }
    raf.current = requestAnimationFrame(tick);
  }, [onLaunch]);

  const begin = useCallback(() => {
    if (disabled || fired) return;
    if (skipHold) {
      setFired(true);
      onLaunch();
      return;
    }
    holding.current = true;
    startedAt.current = performance.now();
    raf.current = requestAnimationFrame(tick);
  }, [disabled, fired, skipHold, onLaunch, tick]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const armed = progress > 0.995 || fired;
  const label = disabled
    ? (disabledReason ?? "Unavailable")
    : fired
      ? "Launching"
      : progress > 0
        ? "Keep holding"
        : skipHold
          ? "Launch market"
          : "Hold to launch";

  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        disabled={disabled || fired}
        aria-label={disabled ? (disabledReason ?? "Launch unavailable") : "Hold to launch market"}
        onMouseDown={begin}
        onMouseUp={stop}
        onMouseLeave={stop}
        onTouchStart={(e) => {
          e.preventDefault();
          begin();
        }}
        onTouchEnd={stop}
        onKeyDown={(e) => {
          if ((e.key === " " || e.key === "Enter") && !e.repeat) {
            e.preventDefault();
            begin();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === " " || e.key === "Enter") stop();
        }}
        className={`relative grid place-items-center rounded-full border transition-[transform,box-shadow] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel-bg)] ${
          disabled
            ? "cursor-not-allowed border-[var(--border)] opacity-40"
            : "cursor-pointer border-[var(--border)] hover:shadow-[0_0_28px_rgba(153,69,255,0.28)] active:scale-[0.97]"
        }`}
        style={{ width: SIZE, height: SIZE, background: "var(--bg-elevated)" }}
      >
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="pointer-events-none absolute inset-0 -rotate-90"
          aria-hidden="true"
        >
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke="var(--border)"
            strokeWidth={STROKE}
          />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke={armed ? "var(--long)" : "var(--accent)"}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - progress)}
            style={{
              transition: holding.current ? "none" : "stroke-dashoffset 240ms cubic-bezier(.22,1,.36,1)",
              filter: progress > 0 ? "drop-shadow(0 0 6px rgba(153,69,255,0.7))" : "none",
            }}
          />
        </svg>

        <span
          className={`pointer-events-none z-10 px-4 text-center text-[10px] uppercase leading-[1.6] tracking-[0.16em] ${
            armed ? "text-[var(--long)]" : "text-[var(--text-secondary)]"
          }`}
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {label}
        </span>
      </button>

      {!disabled && !fired && !skipHold ? (
        <p className="mt-3 text-[10px] text-[var(--text-muted)]">Release to cancel</p>
      ) : null}
    </div>
  );
};
