"use client";

import { FC, useState, useRef, useEffect, useCallback, useLayoutEffect, type CSSProperties } from "react";
import { createPortal } from "react-dom";
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

const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

/** Fixed-position style that right-aligns the popup to its trigger (opens leftward), then clamps it inside the
 *  viewport (a trigger near the LEFT edge, as on a phone, would otherwise push it off-screen). Pure so it is
 *  testable. */
export function displayMenuPosition(
  trigger: { top: number; bottom: number; left: number; right: number },
  viewport: { width: number },
  menuWidth = 200,
): CSSProperties {
  const maxWidth = viewport.width - VIEWPORT_MARGIN * 2;
  const w = Math.min(menuWidth, maxWidth);
  const left = Math.min(Math.max(trigger.right - w, VIEWPORT_MARGIN), viewport.width - w - VIEWPORT_MARGIN);
  return { position: "fixed", top: trigger.bottom + MENU_GAP, left, maxWidth };
}

/** Click-driven popup that exposes an ON/OFF toggle for each chart overlay
 *  in OVERLAY_DISPLAY_ORDER (Avg Entry price, Liquidation price, Live PnL).
 *  Sits next to ChartStyleMenu in the chart toolbar.
 *
 *  The popup is PORTALED to document.body (position: fixed, right-aligned to the trigger) so the chart
 *  container's `overflow-hidden` / paint containment and the order panel can never clip it, and it opens
 *  leftward because the trigger sits at the chart's right edge. z-[70]: above the chart chrome, the sticky
 *  market bar (z-30) and bottom nav (z-50), below the full-screen sheet (z-[100]) and app modals (z-[9999]).
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
  const popupRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({});

  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setStyle(
      displayMenuPosition(
        el.getBoundingClientRect(),
        { width: document.documentElement.clientWidth },
        popupRef.current?.offsetWidth || undefined,
      ),
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

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
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !popupRef.current?.contains(t)) setOpen(false);
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

      {open && typeof document !== "undefined" && createPortal(
      <div
        ref={popupRef}
        data-testid="chart-display-menu"
        style={style}
        className="z-[70] min-w-[200px] rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] py-1 shadow-[0_8px_32px_rgba(0,0,0,0.48)]"
      >
        {OVERLAY_DISPLAY_ORDER.map((key) => {
          const enabled = prefs[key];
          return (
            <button
              key={key}
              type="button"
              aria-pressed={enabled}
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
      </div>,
      document.body,
      )}
    </div>
  );
};
