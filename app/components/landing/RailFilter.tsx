"use client";

import type { FC, ReactNode } from "react";

/**
 * A small segmented control for the landing rails' filters (timeframe, row count).
 * Restrained on-brand styling — mono label, border, accent on the active segment —
 * so it reads as part of the existing table chrome, not a neon widget.
 */
export interface SegOption<T extends string> {
  value: T;
  label: string;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<SegOption<T>>;
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex items-center gap-0.5 rounded-sm border border-[var(--border)] bg-[var(--accent)]/[0.03] p-0.5 font-mono text-[10px] uppercase tracking-[0.08em]"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={[
              "rounded-[3px] px-2 py-0.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
              active
                ? "bg-[var(--accent)]/15 text-[var(--accent-text)]"
                : "text-[var(--text-dim)] hover:text-[var(--text-secondary)]",
            ].join(" ")}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Row-count options shared by both rails. */
export const COUNT_OPTIONS = [
  { value: "5", label: "5" },
  { value: "10", label: "10" },
  { value: "20", label: "20" },
] as const satisfies ReadonlyArray<SegOption<"5" | "10" | "20">>;

export type RailCount = (typeof COUNT_OPTIONS)[number]["value"];
export const DEFAULT_RAIL_COUNT: RailCount = "20";
/**
 * The markets rail defaults to fewer rows than the tokens rail: every visible row polls
 * /api/prices/<slab>, which fans out to GeckoTerminal's keyless budget (30 calls/min). 20 rows can
 * exhaust it and blank the 24h change and mini chart for a minute. 5/10/20 stay selectable.
 */
export const MARKETS_RAIL_DEFAULT_COUNT: RailCount = "10";

/** A labelled control (caption + segmented control), right-aligned in the rail's top bar. */
export const RailControl: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <div className="flex items-center gap-1.5">
    <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--text-dim)]">{label}</span>
    {children}
  </div>
);
