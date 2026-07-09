"use client";

interface ProgressBarProps {
  /** 0–1 fill ratio */
  value: number;
  /** Height in pixels (default 8) */
  height?: number;
  className?: string;
  /** Optional Tailwind classes (e.g. a gradient) applied to the fill instead
   *  of the dynamic solid `fillColor`. When set, `fillColor` is not applied
   *  as an inline background so the class's gradient/color wins. */
  fillClassName?: string;
}

/**
 * Shared progress bar with dynamic fill color:
 * - accent (purple) when < 80%
 * - warning (amber) when 80–95%
 * - short (red) when > 95%
 * Pass `fillClassName` to override with a custom fill (e.g. a gradient) —
 * the dynamic color above is skipped whenever it's set.
 */
export function ProgressBar({ value, height = 8, className = "", fillClassName = "" }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(1, value));
  const pct = clamped * 100;

  const fillColor =
    clamped < 0.8
      ? "var(--accent)"
      : clamped < 0.95
        ? "var(--warning)"
        : "var(--short)";

  return (
    <div
      className={`w-full overflow-hidden rounded-full bg-[var(--border)] ${className}`}
      style={{ height }}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full transition-all duration-500 ease-out ${fillClassName}`}
        style={{
          width: `${pct}%`,
          backgroundColor: fillClassName ? undefined : fillColor,
        }}
      />
    </div>
  );
}
