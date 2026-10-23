"use client";

import { FC, useCallback, useEffect, useRef, useState } from "react";

export interface RotaryDialProps {
  label: string;
  /** Raw value in the dial's own units (e.g. bps, leverage ×, sim-USDC). */
  value: number;
  min: number;
  max: number;
  /** Snap increment. Values land on multiples of this. */
  step: number;
  /** Renders the value for the inset readout (e.g. "10×", "0.30%"). */
  format: (v: number) => string;
  /** Optional caption under the readout (e.g. "liq at 10% move"). */
  caption?: string;
  onChange: (v: number) => void;
  disabled?: boolean;
}

const STEP_BTN =
  "flex h-9 w-9 items-center justify-center rounded-[2px] border border-[var(--border)] bg-[var(--panel-bg)] text-[16px] leading-none text-[var(--text-secondary)] select-none touch-manipulation hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-30";

/**
 * What the readout accepts while typing: digits, plus ONE decimal separator only when the dial has
 * fractional steps (leverage). No letters, signs or symbols ever reach the field.
 */
export function sanitizeDialTyping(text: string, allowDecimal: boolean): string {
  if (!allowDecimal) return text.replace(/[^0-9]/g, "");
  const kept = text.replace(/[^0-9.,]/g, "");
  const sep = kept.search(/[.,]/);
  return sep < 0 ? kept : kept.slice(0, sep + 1) + kept.slice(sep + 1).replace(/[.,]/g, "");
}

/**
 * A typed value -> the dial's value, snapped to `step` and clamped to [min, max]; null when it isn't a
 * number. Accepts what people actually type: "4.5", "4.5x", "4,5" (comma decimal), "1,000" / "10 000"
 * (thousands separators). A comma followed by exactly three digits is a thousands separator,
 * otherwise it is a decimal comma.
 */
export function parseDialInput(text: string, o: { min: number; max: number; step: number }): number | null {
  let t = text.trim().replace(/[×x%\s]/gi, "");
  if (!t) return null;
  if (t.includes(",") && !t.includes(".")) {
    t = /,\d{3}(?!\d)/.test(t) ? t.replace(/,/g, "") : t.replace(",", ".");
  } else {
    t = t.replace(/,/g, "");
  }
  t = t.replace(/\.$/, ""); // "4." -> "4" (typed a point, then Enter)
  if (!/^-?\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  const snapped = Math.round(n / o.step) * o.step;
  // Round off float noise from the snap (0.1 * 3 = 0.30000000000000004).
  const clean = Number(snapped.toFixed(10));
  return Math.min(o.max, Math.max(o.min, clean));
}

const SIZE = 96;
const R = 34;
/** Sweep runs from 7:30 to 4:30 — a real instrument's dead-zone at the bottom. */
const A0 = Math.PI * 0.75;
const A1 = Math.PI * 2.25;
/**
 * A machined rotary dial — the Control Room's primary control.
 *
 * The dial face itself has no pointer/touch drag (it was laggy). Input is: typing the value into the
 * readout, the vertical slider beside the dial (fast, coarse), tap-able − / + step buttons, and arrow
 * keys / Home / End on the focused dial. Scroll-to-adjust was removed: it only worked once the dial
 * was focused, users didn't find it, and a page scroll over the dial was a hazard (#2716).
 * Values snap to `step` detents, and each detent crossed fires a short tick
 * pulse so the control feels notched rather than continuous.
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
  const lastDetent = useRef(value);
  /** The readout while it is being typed into; null shows the formatted value. */
  const [draft, setDraft] = useState<string | null>(null);

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
  // The tick glow clears itself 90ms later. Keep the timer so a newer detent
  // restarts it and an unmount cancels it — a timer left running set state on
  // an unmounted dial (and, under jsdom, after the window was torn down).
  const tickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (tickTimer.current !== null) clearTimeout(tickTimer.current);
    },
    [],
  );
  const pulse = useCallback((v: number) => {
    if (v !== lastDetent.current) {
      lastDetent.current = v;
      setTicking(true);
      if (tickTimer.current !== null) clearTimeout(tickTimer.current);
      tickTimer.current = setTimeout(() => {
        tickTimer.current = null;
        setTicking(false);
      }, 90);
    }
  }, []);

  const commit = useCallback(
    (next: number) => {
      const v = clamp(next);
      // Any committed change (slider, -/+, keys, or the typed value itself) ends an in-progress
      // edit, so a half-typed or stale number can't overwrite it when the box later loses focus.
      setDraft(null);
      pulse(v);
      if (v !== value) onChange(v);
    },
    [clamp, onChange, pulse, value],
  );

  const fillPct = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;

  const commitDraft = () => {
    if (draft !== null) {
      const v = parseDialInput(draft, { min, max, step });
      if (v !== null) commit(v);
    }
    setDraft(null);
  };

  return (
    <div className="flex flex-col items-center">
      <div className="flex items-center gap-3">
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format(value)}
        aria-disabled={disabled}
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
        className={`select-none rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel-bg)] ${
          disabled ? "cursor-not-allowed opacity-40" : "cursor-default"
        }`}
      >
        <canvas
          ref={canvasRef}
          width={SIZE}
          height={SIZE}
          style={{ width: SIZE, height: SIZE, display: "block" }}
        />
      </div>
      {/* Vertical slider for fast, coarse adjusting (drag anywhere along it). A pointer/touch
          convenience that mirrors the dial: hidden from assistive tech and the tab order, where the
          dial's own slider role, arrow keys, −/+ and the typed readout already cover it. */}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-hidden="true"
        tabIndex={-1}
        data-testid={`${label}-vertical-slider`}
        onChange={(e) => commit(Number(e.target.value))}
        className="leverage-slider cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
        style={{
          writingMode: "vertical-lr",
          direction: "rtl",
          height: SIZE - 8,
          width: 22,
          // A drag that starts on the slider moves the slider, never the page (touch screens).
          touchAction: "none",
          // Same look as the trade ticket's leverage slider: a 4px track filled up to the value,
          // painted as a centred strip so the whole 22px column stays an easy touch target.
          background: `linear-gradient(to top, var(--accent) ${fillPct}%, var(--border) ${fillPct}%) center / 4px 100% no-repeat`,
        }}
      />
      </div>

      {/* inset LCD readout — recessed, backlit, flanked by tap-to-step buttons */}
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          aria-label={`${"Decrease"} ${label}`}
          disabled={disabled || value <= min}
          onClick={() => commit(value - step)}
          className={STEP_BTN}
        >
          −
        </button>
      <div
        className="min-w-[74px] rounded-[2px] border border-[var(--border)] bg-[var(--dial-readout-bg)] focus-within:border-[var(--accent)] text-center transition-colors duration-100"
        style={{
          boxShadow: ticking
            ? "inset 0 1px 3px rgba(0,0,0,0.9), 0 0 10px rgba(153,69,255,0.35)"
            : "inset 0 1px 3px rgba(0,0,0,0.9)",
        }}
      >
        {/* Type a value: Enter or leaving the field commits it (snapped + clamped), Escape cancels. */}
        <input
          type="text"
          inputMode={step < 1 ? "decimal" : "numeric"}
          aria-label={`${label} value`}
          disabled={disabled}
          value={draft ?? format(value)}
          onFocus={(e) => {
            setDraft(String(value));
            const el = e.currentTarget;
            requestAnimationFrame(() => el.select());
          }}
          onChange={(e) => setDraft(sanitizeDialTyping(e.target.value, step < 1))}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft(null);
              requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
            }
          }}
          className="w-[90px] bg-transparent px-2 py-1 text-center text-[13px] leading-none text-[var(--dial-readout-text)] outline-none disabled:cursor-not-allowed"
          style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
        />
      </div>
        <button
          type="button"
          aria-label={`${"Increase"} ${label}`}
          disabled={disabled || value >= max}
          onClick={() => commit(value + step)}
          className={STEP_BTN}
        >
          +
        </button>
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
