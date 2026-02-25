"use client";

import { FC, useMemo } from "react";

interface FeeSliderProps {
  value: number;
  onChange: (bps: number) => void;
  min?: number;
  max?: number;
  label: string;
  /** Show percentage conversion tooltip */
  showPercent?: boolean;
}

/**
 * Range slider with live tooltip (bps → %).
 * Styled with accent thumb and track.
 */
export const FeeSlider: FC<FeeSliderProps> = ({
  value,
  onChange,
  min = 1,
  max = 1000,
  label,
  showPercent = true,
}) => {
  const percent = useMemo(() => (value / 100).toFixed(2), [value]);
  const fillPercent = useMemo(
    () => ((value - min) / (max - min)) * 100,
    [value, min, max]
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label
          className="text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]"
          htmlFor={`slider-${label.replace(/\s+/g, "-").toLowerCase()}`}
        >
          {label}
        </label>
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-bold font-mono text-[var(--accent)]">
            {value} bps
          </span>
          {showPercent && (
            <span className="text-[10px] text-[var(--text-dim)]">
              = {percent}% per trade
            </span>
          )}
        </div>
      </div>
      <div className="relative">
        <input
          id={`slider-${label.replace(/\s+/g, "-").toLowerCase()}`}
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full h-1.5 appearance-none cursor-pointer bg-transparent [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-none [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-[var(--accent)] [&::-webkit-slider-thumb]:bg-[var(--accent)] [&::-webkit-slider-thumb]:-mt-[5px] [&::-moz-range-track]:h-1.5 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-none [&::-moz-range-thumb]:border-[var(--accent)] [&::-moz-range-thumb]:bg-[var(--accent)]"
          aria-valuenow={value}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-label={`${label} in basis points`}
          style={{
            background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${fillPercent}%, rgba(255,255,255,0.08) ${fillPercent}%, rgba(255,255,255,0.08) 100%)`,
          }}
        />
      </div>
      <div className="flex items-center justify-between mt-1">
        <span className="text-[9px] text-[var(--text-dim)]">{min} bps</span>
        <span className="text-[9px] text-[var(--text-dim)]">{max} bps</span>
      </div>
    </div>
  );
};
