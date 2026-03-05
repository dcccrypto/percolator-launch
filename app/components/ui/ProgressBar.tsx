"use client";

interface ProgressBarProps {
  /** 0–1 fill ratio */
  value: number;
  /** Height in pixels (default 8) */
  height?: number;
  className?: string;
}

/**
 * Shared progress bar with dynamic fill color:
 * - accent (purple) when < 80%
 * - warning (amber) when 80–95%
 * - short (red) when > 95%
 */
export function ProgressBar({ value, height = 8, className = "" }: ProgressBarProps) {
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
        className="h-full rounded-full transition-all duration-500 ease-out"
        style={{ width: `${pct}%`, backgroundColor: fillColor }}
      />
    </div>
  );
}
