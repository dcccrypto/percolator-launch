"use client";

import { useEffect, type FC, type ReactNode } from "react";
import type { DrawingTool } from "@/lib/chart-drawings";

interface ChartDrawingToolbarProps {
  tool: DrawingTool;
  setTool: (next: DrawingTool) => void;
}

/** Inline SVGs for each tool. Kept as small components so the TOOLS
 *  table below stays a flat data structure with a single `icon` field
 *  per row — adding a new tool means appending one row, no imports
 *  to plumb. */
const PointerIcon = (): ReactNode => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2 2 L7 12 L8.5 8 L12 6.5 Z" />
  </svg>
);

const TrendIcon = (): ReactNode => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <line x1="2" y1="12" x2="12" y2="2" />
  </svg>
);

const HorizontalIcon = (): ReactNode => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <line x1="2" y1="7" x2="12" y2="7" />
  </svg>
);

const RectangleIcon = (): ReactNode => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden="true"
  >
    <rect x="3" y="4" width="8" height="6" />
  </svg>
);

interface ToolEntry {
  kind: DrawingTool;
  label: string;
  icon: () => ReactNode;
}

/** Toolbar contents in display order (top → bottom). Pointer first
 *  because it's the default and the most common action (select /
 *  delete). Adding a new drawing kind: append a row, append a case to
 *  the renderer, append a kind to the Drawing union. */
const TOOLS: ReadonlyArray<ToolEntry> = [
  { kind: "pointer", label: "Pointer (select)", icon: PointerIcon },
  { kind: "trend", label: "Trend line", icon: TrendIcon },
  { kind: "horizontal", label: "Horizontal line", icon: HorizontalIcon },
  { kind: "rectangle", label: "Rectangle", icon: RectangleIcon },
];

/**
 * Vertical toolbar at the chart's left edge with one button per drawing
 * tool. Active tool gets the brand-accent highlight; clicking the
 * active non-pointer tool returns to pointer (TradingView convention —
 * a quick "cancel" without needing to find the pointer button).
 *
 * Hidden below the md breakpoint (< 768 px). Drawing tools are a
 * desktop-only feature for v1 — touch interaction patterns (long-press
 * vs. tap, anchor-drag handles, gesture conflicts with chart pan) are
 * a separate body of work and out of scope.
 *
 * ARIA: a labelled `<div aria-label="Drawing tools">` wrapping
 * `<button aria-pressed>` toggle buttons (matches the indicator menu's
 * toggle pattern). Deliberately NOT `role="toolbar"` — the APG
 * toolbar contract requires roving tabindex + arrow-key focus
 * management between toolbar items, which we don't implement. Tab +
 * Enter is the full keyboard contract here, so promising the
 * "toolbar" role would be misleading. Screen readers still announce
 * each button with its label; users get accurate semantics without
 * an unfulfilled contract.
 *
 * Keyboard: Escape returns to the pointer tool from any other tool.
 * Input-focus guarded: Escape inside an order-form INPUT or TEXTAREA
 * is ignored so it can do what the input expects (close a select,
 * cancel autocomplete, etc.) without hijacking the user's keystroke.
 */
export const ChartDrawingToolbar: FC<ChartDrawingToolbarProps> = ({
  tool,
  setTool,
}) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // Input-focus guard: don't hijack Escape from form inputs.
      const active = document.activeElement;
      if (
        active != null &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          (active as HTMLElement).isContentEditable)
      ) {
        return;
      }
      // Already pointer — no state change needed (avoids spurious renders).
      if (tool === "pointer") return;
      setTool("pointer");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [tool, setTool]);

  return (
    <div
      aria-label="Drawing tools"
      className="absolute left-2 top-2 z-10 hidden flex-col gap-1 rounded-none border border-[var(--border)] bg-[var(--bg-elevated)]/95 p-1 backdrop-blur-sm md:flex"
    >
      {TOOLS.map(({ kind, label, icon: Icon }) => {
        const isActive = tool === kind;
        // Clicking the active non-pointer tool deselects to pointer.
        // Clicking active pointer is a no-op set (same value, no
        // re-render). Inactive: switch to that tool.
        const onClick = (): void => {
          setTool(isActive && kind !== "pointer" ? "pointer" : kind);
        };
        return (
          <button
            key={kind}
            type="button"
            aria-label={label}
            aria-pressed={isActive}
            title={label}
            onClick={onClick}
            className={[
              // Inactive uses --text-secondary (not --text-dim) so the
              // icon meets WCAG AA non-text contrast (3:1) against
              // --bg-elevated in both themes — text-dim is reserved
              // for true placeholders and renders ~1.4:1 / 2.0:1.
              // focus-visible:outline restores a visible focus ring
              // for sighted keyboard users (Tailwind's preflight
              // strips the UA outline).
              "flex h-7 w-7 items-center justify-center rounded-none transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-1",
              isActive
                ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] hover:text-[var(--text)]",
            ].join(" ")}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
};
