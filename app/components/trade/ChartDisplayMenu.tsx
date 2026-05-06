"use client";

import { FC, useState, useRef, useEffect, useCallback } from "react";
import {
  OVERLAY_LABELS,
  OVERLAY_DISPLAY_ORDER,
  type OverlayKey,
  type OverlayPrefs,
} from "@/lib/chart-overlays";

interface ChartDisplayMenuProps {
  prefs: OverlayPrefs;
  onToggle: (key: OverlayKey, value: boolean) => void;
}

/** Click-driven popup that exposes an ON/OFF toggle for each chart overlay
 *  in OVERLAY_DISPLAY_ORDER (Avg Entry price, Liquidation price, Live PnL).
 *  Sits next to ChartStyleMenu in the chart toolbar.
 *
 *  Closes on outside click and Escape. The trigger label is static ("Display")
 *  rather than reflecting state — counting "3 of 3 enabled" in the trigger
 *  would be noise when defaults are all-on.
 *
 *  ARIA: each toggle is a `<button aria-pressed={value}>` rather than a
 *  listbox option or menuitemcheckbox. Toggle buttons (`aria-pressed`) are
 *  the closest native fit for "independent boolean per row" — listbox
 *  semantics promise single-select, and `role="menuitemcheckbox"` requires
 *  the WAI-ARIA APG menu keyboard contract (arrow keys, focus management)
 *  which this component does not implement. The popup container itself
 *  carries no role; Tab + Space/Enter on each button is the full contract. */
export const ChartDisplayMenu: FC<ChartDisplayMenuProps> = ({ prefs, onToggle }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const handleToggle = useCallback(
    (key: OverlayKey) => {
      onToggle(key, !prefs[key]);
    },
    [onToggle, prefs],
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
        aria-haspopup="true"
        className={[
          "flex items-center gap-1 rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-xs transition-colors",
          open
            ? "text-[var(--accent)]"
            : "text-[var(--text-secondary)] hover:text-[var(--text)]",
        ].join(" ")}
      >
        <span>Display</span>
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
        aria-hidden={!open || undefined}
        className={[
          "absolute left-0 top-full z-20 mt-1 min-w-[200px] rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] py-1 shadow-[0_8px_32px_rgba(0,0,0,0.48)] transition-opacity duration-[120ms] ease-out",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        ].join(" ")}
      >
        {OVERLAY_DISPLAY_ORDER.map((key) => {
          const enabled = prefs[key];
          return (
            <button
              key={key}
              type="button"
              aria-pressed={enabled}
              tabIndex={open ? 0 : -1}
              onClick={() => handleToggle(key)}
              className={[
                // Row hover bg matches the ChartStyleMenu (Line) options
                // so every dropdown in the chart toolbar uses the same
                // hover affordance — text brightens AND the row gets a
                // subtle surface highlight.
                "flex w-full items-center justify-between px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-surface)]",
                enabled
                  ? "text-[var(--text)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text)]",
              ].join(" ")}
            >
              <span>{OVERLAY_LABELS[key]}</span>
              <span
                aria-hidden="true"
                className={[
                  "inline-flex h-3.5 w-6 items-center rounded-full border transition-colors",
                  enabled
                    ? "bg-[var(--accent)] border-[var(--accent)]"
                    : "bg-transparent border-[var(--border)]",
                ].join(" ")}
              >
                <span
                  className={[
                    "h-2.5 w-2.5 rounded-full bg-[var(--bg)] transition-transform",
                    enabled ? "translate-x-[10px]" : "translate-x-[2px]",
                  ].join(" ")}
                />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
