"use client";

import { SERIES_HINT, SERIES_LABEL } from "@/lib/chart/perp-series";
import { PERP_SERIES, type PerpSeries } from "@/lib/chart/perp-types";

/** Mark / Oracle / Last: a segmented control (radio group semantics; arrow keys move the selection). */
export function PerpSeriesToggle({ value, onChange }: { value: PerpSeries; onChange(next: PerpSeries): void }) {
  return (
    <div role="radiogroup" aria-label="Chart price source" className="inline-flex shrink-0 border border-[var(--border)]">
      {PERP_SERIES.map((s, i) => {
        const on = s === value;
        return (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            title={SERIES_HINT[s]}
            onClick={() => onChange(s)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                const d = e.key === "ArrowRight" ? 1 : PERP_SERIES.length - 1;
                onChange(PERP_SERIES[(i + d) % PERP_SERIES.length]);
              }
            }}
            className={`min-h-8 px-2.5 text-[11px] font-medium tracking-wide transition-colors ${
              on ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "text-[var(--text-secondary)] hover:text-[var(--text)]"
            }`}
          >
            {SERIES_LABEL[s]}
          </button>
        );
      })}
    </div>
  );
}
