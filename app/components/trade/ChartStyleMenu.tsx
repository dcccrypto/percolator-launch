"use client";

import { FC, useState, useRef, useEffect, useCallback } from "react";
import {
  CHART_STYLE_LABELS,
  CHART_STYLE_DISPLAY_ORDER,
  type ChartStyle,
} from "@/lib/chart-style";

interface ChartStyleMenuProps {
  value: ChartStyle;
  onChange: (style: ChartStyle) => void;
}

/** Click-driven dropdown that exposes every ChartStyle in
 *  CHART_STYLE_DISPLAY_ORDER. Replaces the previous 2-button Line/Candle
 *  toggle in the chart toolbar — the toggle could only express 2 of the 7
 *  styles the renderer now supports.
 *
 *  Closes on outside click and Escape. The trigger always shows the active
 *  style's label so the user never has to open the menu to read state.
 *
 *  ARIA: uses `role="listbox"` + `role="option"` + `aria-selected` rather
 *  than `role="menu"` + `role="menuitemradio"`. The menu pattern would
 *  promise arrow-key navigation, Home/End, type-ahead, and managed focus
 *  per the WAI-ARIA APG menu spec — none of which are implemented here.
 *  Listbox makes a smaller promise (Tab + Enter is sufficient) so the
 *  declared semantics match the actual behaviour. If arrow-key navigation
 *  is added later, swap back to the menu pattern in lockstep. */
export const ChartStyleMenu: FC<ChartStyleMenuProps> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const handleSelect = useCallback(
    (style: ChartStyle) => {
      onChange(style);
      setOpen(false);
    },
    [onChange],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={[
          "flex items-center gap-1 rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-xs transition-colors",
          open
            ? "text-[var(--accent)]"
            : "text-[var(--text-secondary)] hover:text-[var(--text)]",
        ].join(" ")}
      >
        <span>{CHART_STYLE_LABELS[value]}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
          className={["transition-transform duration-150", open ? "rotate-180" : ""].join(" ")}
        >
          <path
            d="M2.5 3.75L5 6.25L7.5 3.75"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <div
        role="listbox"
        aria-hidden={!open || undefined}
        className={[
          "absolute left-0 top-full z-20 mt-1 min-w-[180px] rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] py-1 shadow-[0_8px_32px_rgba(0,0,0,0.48)] transition-opacity duration-[120ms] ease-out",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        ].join(" ")}
      >
        {CHART_STYLE_DISPLAY_ORDER.map((style) => {
          const active = style === value;
          return (
            <button
              key={style}
              type="button"
              role="option"
              aria-selected={active}
              tabIndex={open ? 0 : -1}
              onClick={() => handleSelect(style)}
              className={[
                "flex w-full items-center justify-between px-3 py-1.5 text-xs transition-colors",
                active
                  ? "text-[var(--accent)] bg-[var(--accent)]/10"
                  : "text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--bg-surface)]",
              ].join(" ")}
            >
              <span>{CHART_STYLE_LABELS[style]}</span>
              {active && (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path
                    d="M2 5L4 7L8 3"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};
