"use client";

import { FC, useCallback, useEffect, useRef, useState } from "react";

export interface RotaryDialProps {
  label: string;
  /** Raw value in the dial's own units (e.g. bps, leverage ×, sim-USDC). */
  value: number;
  min: number;
  max: number;
  /** Snap increment. Drag detents land on multiples of this. */
  step: number;
  /** Renders the value for the inset readout (e.g. "10×", "0.30%"). */
  format: (v: number) => string;
  /** Optional caption under the readout (e.g. "liq at 10% move"). */
  caption?: string;
  onChange: (v: number) => void;
  disabled?: boolean;
}

const SIZE = 96;
const R = 34;
/** Sweep runs from 7:30 to 4:30 — a real instrument's dead-zone at the bottom. */
const A0 = Math.PI * 0.75;
const A1 = Math.PI * 2.25;
/** Vertical pixels of drag for a full min→max sweep. Tuned to feel geared, not twitchy. */
const DRAG_RANGE_PX = 190;

/**
 * A machined rotary dial — the Control Room's primary control.
 *
 * Deliberately NOT a slider: dragging a physical dial makes the value feel
 * consequential, which is the point (a creator is setting real market
 * parameters, not tweaking a preference). Drag vertically, scroll, or use
 * arrow keys. Values snap to `step` detents, and each detent crossed fires a
 * short tick pulse so the control feels notched rather than continuous.
 *
 * On mount the needle performs a power-on self-test sweep (min→max→value), the
 * way a real instrument does when it boots. That single detail is what sells
 * the panel as hardware rather than a form.
 */
export const RotaryDial: FC<RotaryDialProps> = ({
  label,
  value,
  min,
  max,
  step,
  format,
  caption,
  onChange,
  disabled = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);
  const lastY = useRef(0);
  /** Accumulates sub-step drag so slow drags still move (and don't quantise to zero). */
  const residue = useRef(0);
  const lastDetent = useRef(value);

  /** Needle position actually painted — lags `value` during the boot sweep. */
  const [painted, setPainted] = useState(min);
  const [booted, setBooted] = useState(false);
  const [ticking, setTicking] = useState(false);

  const clamp = useCallback(
    (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step)),
    [min, max, step],
  );

  // ── power-on self-test: sweep min → max → settle on value ──────────────
  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setPainted(value);
      setBooted(true);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const DUR = 900;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / DUR);
      // out → up to max by 55%, then ease back down to the real value
      const eased = 1 - Math.pow(1 - p, 3);
      const swept =
        p < 0.55
          ? min + (max - min) * (eased / 0.55) * 0.55
          : max - (max - value) * ((eased - 0.55) / 0.45);
      setPainted(swept);
      if (p < 1) raf = requestAnimationFrame(tick);
      else {
        setPainted(value);
        setBooted(true);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // Boot once per mount — deliberately not re-running on value changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once booted, the needle simply tracks the value.
  useEffect(() => {
    if (booted) setPainted(value);
  }, [value, booted]);

  // ── paint ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    cv.width = SIZE * dpr;
    cv.height = SIZE * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);

    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const t = (painted - min) / (max - min || 1);
    const needleAngle = A0 + (A1 - A0) * t;

    // machined bezel — brushed metal ring with a specular highlight
    const bezel = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    bezel.addColorStop(0, "#2b3042");
    bezel.addColorStop(0.35, "#161a25");
    bezel.addColorStop(0.6, "#1e2231");
    bezel.addColorStop(1, "#0d0f17");
    ctx.fillStyle = bezel;
    ctx.beginPath();
    ctx.arc(cx, cy, R + 8, 0, Math.PI * 2);
    ctx.fill();

    // knurled rim — the grip notches of a real dial
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 56; i++) {
      const a = (i / 56) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (R + 8), cy + Math.sin(a) * (R + 8));
      ctx.lineTo(cx + Math.cos(a) * (R + 5), cy + Math.sin(a) * (R + 5));
      ctx.stroke();
    }

    // recessed face
    const face = ctx.createRadialGradient(cx - 8, cy - 10, 2, cx, cy, R + 2);
    face.addColorStop(0, "#151926");
    face.addColorStop(1, "#0a0c13");
    ctx.fillStyle = face;
    ctx.beginPath();
    ctx.arc(cx, cy, R + 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // travel track
    ctx.strokeStyle = "#1C1F2E";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx, cy, R, A0, A1);
    ctx.stroke();

    // value arc — purple→green, the app's own accent pair
    const arc = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    arc.addColorStop(0, "#9945FF");
    arc.addColorStop(1, "#14F195");
    ctx.strokeStyle = arc;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, R, A0, needleAngle);
    ctx.stroke();

    // graduations
    for (let i = 0; i <= 10; i++) {
      const a = A0 + (A1 - A0) * (i / 10);
      const lit = i / 10 <= t;
      ctx.strokeStyle = lit ? "rgba(173,98,255,0.75)" : "#252a3a";
      ctx.lineWidth = i % 5 === 0 ? 1.6 : 1;
      const len = i % 5 === 0 ? 7 : 4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (R - 6), cy + Math.sin(a) * (R - 6));
      ctx.lineTo(cx + Math.cos(a) * (R - 6 - len), cy + Math.sin(a) * (R - 6 - len));
      ctx.stroke();
    }

    // needle + its drop shadow (depth sells the physicality)
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx, cy + 1);
    ctx.lineTo(cx + Math.cos(needleAngle) * (R - 12), cy + Math.sin(needleAngle) * (R - 12) + 1);
    ctx.stroke();

    ctx.strokeStyle = "#E1E2E8";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(needleAngle) * (R - 12), cy + Math.sin(needleAngle) * (R - 12));
    ctx.stroke();

    // hub
    const hub = ctx.createRadialGradient(cx - 1, cy - 2, 0, cx, cy, 5);
    hub.addColorStop(0, "#AD62FF");
    hub.addColorStop(1, "#6a24c9");
    ctx.fillStyle = hub;
    ctx.beginPath();
    ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }, [painted, min, max]);

  // ── input ──────────────────────────────────────────────────────────────
  const commit = useCallback(
    (next: number) => {
      const v = clamp(next);
      if (v !== lastDetent.current) {
        lastDetent.current = v;
        setTicking(true);
        window.setTimeout(() => setTicking(false), 90);
      }
      if (v !== value) onChange(v);
    },
    [clamp, onChange, value],
  );

  useEffect(() => {
    if (disabled) return;

    const move = (e: MouseEvent | TouchEvent) => {
      if (!dragging.current) return;
      e.preventDefault();
      const y = "touches" in e ? e.touches[0]!.clientY : (e as MouseEvent).clientY;
      const dy = lastY.current - y; // up = increase, like a real dial
      lastY.current = y;
      residue.current += (dy / DRAG_RANGE_PX) * (max - min);
      const next = value + residue.current;
      const snapped = clamp(next);
      if (snapped !== value) {
        residue.current = 0;
        commit(snapped);
      }
    };
    const up = () => {
      dragging.current = false;
      residue.current = 0;
    };

    window.addEventListener("mousemove", move);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("mouseup", up);
    window.addEventListener("touchend", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("touchend", up);
    };
  }, [value, min, max, clamp, commit, disabled]);

  const start = (clientY: number) => {
    if (disabled) return;
    dragging.current = true;
    lastY.current = clientY;
    residue.current = 0;
  };

  return (
    <div className="flex flex-col items-center">
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format(value)}
        aria-disabled={disabled}
        onMouseDown={(e) => start(e.clientY)}
        onTouchStart={(e) => start(e.touches[0]!.clientY)}
        onWheel={(e) => {
          if (disabled) return;
          commit(value + (e.deltaY < 0 ? step : -step));
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowUp" || e.key === "ArrowRight") {
            e.preventDefault();
            commit(value + step);
          } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
            e.preventDefault();
            commit(value - step);
          } else if (e.key === "Home") {
            e.preventDefault();
            commit(min);
          } else if (e.key === "End") {
            e.preventDefault();
            commit(max);
          }
        }}
        className={`select-none rounded-full transition-transform duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel-bg)] ${
          disabled ? "cursor-not-allowed opacity-40" : "cursor-grab active:cursor-grabbing active:scale-[0.97]"
        }`}
      >
        <canvas
          ref={canvasRef}
          width={SIZE}
          height={SIZE}
          style={{ width: SIZE, height: SIZE, display: "block" }}
        />
      </div>

      {/* inset LCD readout — recessed, backlit */}
      <div
        className="mt-2 min-w-[74px] rounded-[2px] border border-[var(--border)] bg-[#07080d] px-2 py-1 text-center transition-colors duration-100"
        style={{
          boxShadow: ticking
            ? "inset 0 1px 3px rgba(0,0,0,0.9), 0 0 10px rgba(153,69,255,0.35)"
            : "inset 0 1px 3px rgba(0,0,0,0.9)",
        }}
      >
        <div
          className="text-[13px] leading-none text-[var(--text)]"
          style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
        >
          {format(value)}
        </div>
      </div>

      <div className="mt-1.5 text-[9px] uppercase tracking-[0.14em] text-[var(--text-secondary)]">
        {label}
      </div>
      {caption ? (
        <div className="mt-0.5 text-[9px] text-[var(--text-muted)]" style={{ fontVariantNumeric: "tabular-nums" }}>
          {caption}
        </div>
      ) : null}
    </div>
  );
};
