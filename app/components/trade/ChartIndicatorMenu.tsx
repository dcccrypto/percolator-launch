"use client";

import { FC, useState, useRef, useEffect, useCallback } from "react";
import {
  ALL_INDICATOR_KINDS,
  INDICATOR_LABELS,
  type IndicatorConfig,
  type IndicatorKind,
} from "@/lib/indicator-registry";
import type { IndicatorPatch } from "@/hooks/useChartIndicatorPrefs";
import { assertNever } from "@/lib/exhaustive";

interface ChartIndicatorMenuProps {
  indicators: IndicatorConfig[];
  addIndicator: (kind: IndicatorKind) => void;
  removeIndicator: (id: string) => void;
  updateIndicator: (id: string, patch: IndicatorPatch) => void;
  clearAll: () => void;
}

/** Toolbar dropdown that surfaces every supported indicator as a toggle row.
 *  Click the row's toggle to add the indicator with its TradingView default
 *  parameters; click again to remove it. While enabled, the row exposes
 *  per-kind period inputs (and stdDev for Bollinger; fast/slow/signal for
 *  MACD) plus a colour swatch showing the auto-assigned palette colour.
 *
 *  This v1 menu is single-instance-per-kind: clicking the SMA toggle adds
 *  ONE SMA, clicking again removes the first matching one. The hook
 *  itself supports multi-instance (multiple SMAs at different periods),
 *  but the UI for managing multiples lives in a future polish commit.
 *
 *  Mobile: panel switches to a bottom sheet anchored to the viewport
 *  bottom on viewports below the md breakpoint, so the dropdown doesn't
 *  overflow off the right edge of narrow phones.
 *
 *  ARIA: trigger is `aria-haspopup="true"` + `aria-expanded`; toggles use
 *  `aria-pressed` rather than `role="menuitemcheckbox"` because the
 *  toggle-button pattern doesn't promise the WAI-ARIA APG menu keyboard
 *  contract (arrow-key focus management, type-ahead) which we don't
 *  implement. Tab + Enter on each row is the full keyboard contract. */
export const ChartIndicatorMenu: FC<ChartIndicatorMenuProps> = ({
  indicators,
  addIndicator,
  removeIndicator,
  updateIndicator,
  clearAll,
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Escape closes the menu, but only when focus is OUTSIDE a number input.
  // Otherwise pressing Escape while editing a period would eat the
  // keystroke instead of letting the input do whatever it normally does.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const active = document.activeElement;
      if (
        active != null &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA")
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Outside-click closes.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const handleClearAll = useCallback(() => {
    if (indicators.length === 0) return;
    clearAll();
    // keep menu open so the user can immediately re-add what they want
  }, [indicators.length, clearAll]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="Indicators"
        title="Indicators"
        className={[
          "flex items-center gap-1 rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 sm:px-2 py-1 text-xs transition-colors",
          open
            ? "text-[var(--accent)]"
            : "text-[var(--text-secondary)] hover:text-[var(--text)]",
        ].join(" ")}
      >
        <span className="font-mono italic">f(x)</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
          className={[
            "transition-transform duration-150",
            open ? "rotate-180" : "",
          ].join(" ")}
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
        // `inert` removes the panel from sequential focus and click target
        // when closed. Without this, Tab walks through every toggle and
        // input even though the panel is invisible (opacity:0 alone keeps
        // children in the focus tree).
        // @ts-expect-error - inert is a valid HTML attribute, React types lag
        inert={!open ? "" : undefined}
        className={[
          // z-[60] so the mobile bottom-sheet variant sits ABOVE the global
          // MobileBottomNav (z-50) — at z-20 the nav was painting over the
          // sheet's "Clear all" footer, leaving it unreachable on phones.
          "absolute left-0 top-full z-[60] mt-1 min-w-[280px] rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] py-1 shadow-[0_8px_32px_rgba(0,0,0,0.48)] transition-opacity duration-[120ms] ease-out",
          open
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none",
          // Mobile: bottom sheet. max-h + overflow keeps "Clear all" reachable
          // when all five rows are expanded with their per-kind inputs.
          // pb-[env(safe-area-inset-bottom)] adds iOS home-indicator clearance
          // so the footer button isn't covered by the home bar.
          "max-md:fixed max-md:bottom-0 max-md:left-0 max-md:right-0 max-md:top-auto max-md:max-h-[80vh] max-md:overflow-y-auto max-md:rounded-t-lg max-md:border-t max-md:pb-[env(safe-area-inset-bottom)]",
        ].join(" ")}
      >
        <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--text-dim)] border-b border-[var(--border)]">
          Indicators
        </div>
        {ALL_INDICATOR_KINDS.map((kind) => {
          const config = indicators.find((i) => i.kind === kind) ?? null;
          return (
            <ChartIndicatorRow
              key={kind}
              kind={kind}
              config={config}
              onAdd={() => addIndicator(kind)}
              onRemove={() => config && removeIndicator(config.id)}
              onUpdate={(patch) => config && updateIndicator(config.id, patch)}
            />
          );
        })}
        <button
          type="button"
          onClick={handleClearAll}
          disabled={indicators.length === 0}
          className="w-full px-3 py-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--bg-surface)] border-t border-[var(--border)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Clear all
        </button>
      </div>
    </div>
  );
};

// =====================================================================

interface ChartIndicatorRowProps {
  kind: IndicatorKind;
  config: IndicatorConfig | null;
  onAdd: () => void;
  onRemove: () => void;
  onUpdate: (patch: IndicatorPatch) => void;
}

const ChartIndicatorRow: FC<ChartIndicatorRowProps> = ({
  kind,
  config,
  onAdd,
  onRemove,
  onUpdate,
}) => {
  const enabled = config !== null;
  return (
    <div className="group px-3 py-2 border-b border-[var(--border)]/50 last:border-b-0 transition-colors hover:bg-[var(--bg-surface)]">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          aria-pressed={enabled}
          onClick={() => (enabled ? onRemove() : onAdd())}
          className="flex flex-1 items-center gap-2 text-xs"
        >
          <ToggleSwitch on={enabled} />
          <span
            className={[
              "transition-colors",
              enabled
                ? "text-[var(--text)]"
                : "text-[var(--text-secondary)] group-hover:text-[var(--text)]",
            ].join(" ")}
          >
            {INDICATOR_LABELS[kind]}
          </span>
        </button>
        {config && (
          // The swatch is decorative — the colour itself isn't actionable
          // from this menu, and a hex code is noise to a screen reader.
          // The toggle's aria-pressed already conveys enabled state.
          <span
            data-testid={`indicator-swatch-${kind}`}
            className="inline-block h-3 w-3 rounded-sm border border-[var(--border)]"
            style={{ backgroundColor: config.color }}
            aria-hidden="true"
          />
        )}
      </div>
      {config && (
        <div className="mt-2 ml-7 flex flex-wrap items-center gap-2 text-xs">
          <ConfigInputs config={config} onUpdate={onUpdate} />
        </div>
      )}
    </div>
  );
};

// =====================================================================

interface ConfigInputsProps {
  config: IndicatorConfig;
  onUpdate: (patch: IndicatorPatch) => void;
}

const ConfigInputs: FC<ConfigInputsProps> = ({ config, onUpdate }) => {
  switch (config.kind) {
    case "sma":
    case "ema":
    case "rsi":
      return (
        <NumberInput
          label="Period"
          value={config.period}
          min={2}
          max={500}
          onChange={(period) => onUpdate({ period })}
        />
      );
    case "bollinger":
      return (
        <>
          <NumberInput
            label="Period"
            value={config.period}
            min={2}
            max={500}
            onChange={(period) => onUpdate({ period })}
          />
          <NumberInput
            label="StdDev"
            value={config.stdDev}
            min={0.1}
            max={10}
            step={0.1}
            onChange={(stdDev) => onUpdate({ stdDev })}
          />
        </>
      );
    case "macd":
      return (
        <>
          <NumberInput
            label="Fast"
            value={config.fastPeriod}
            min={2}
            max={100}
            onChange={(fastPeriod) => onUpdate({ fastPeriod })}
          />
          <NumberInput
            label="Slow"
            value={config.slowPeriod}
            min={2}
            max={500}
            onChange={(slowPeriod) => onUpdate({ slowPeriod })}
          />
          <NumberInput
            label="Signal"
            value={config.signalPeriod}
            min={2}
            max={100}
            onChange={(signalPeriod) => onUpdate({ signalPeriod })}
          />
        </>
      );
    default:
      // Exhaustive for the IndicatorConfig union — assertNever fails
      // compilation if a future kind is added without a case here.
      return assertNever(config);
  }
};

// =====================================================================

interface NumberInputProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}

/** Number input that commits on blur (or Enter) rather than every
 *  keystroke. Per-keystroke commits would re-render the chart at every
 *  digit ("type 1 → EMA(1), type 0 → EMA(10), type 0 → EMA(100)") which
 *  is jarring. The committed value is also clamped to [min, max] so a
 *  user typing 9999 ends up with a sane 500 instead of an EMA call that
 *  returns []. */
const NumberInput: FC<NumberInputProps> = ({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}) => {
  const [draft, setDraft] = useState(String(value));

  // Re-sync draft when the externally-controlled value changes (e.g.,
  // after a "Clear all" or after the indicator is re-added with defaults).
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = useCallback(() => {
    // Empty input means the user typed garbage that the native number
    // input rejected to "" (or cleared the field). Either way, treat it
    // as "no change" rather than parsing as 0 and clamping to min.
    const trimmed = draft.trim();
    if (trimmed === "") {
      setDraft(String(value));
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      // Garbage input — revert to last valid value.
      setDraft(String(value));
      return;
    }
    const clamped = Math.max(min, Math.min(max, parsed));
    if (clamped !== value) onChange(clamped);
    // Always re-sync draft to the clamped value so the input doesn't
    // visually retain an out-of-range number (e.g., 9999 → 500).
    setDraft(String(clamped));
  }, [draft, value, min, max, onChange]);

  return (
    <label className="flex items-center gap-1 text-[var(--text-dim)]">
      <span>{label}</span>
      <input
        type="number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
        min={min}
        max={max}
        step={step}
        className="w-14 rounded-none border border-[var(--border)] bg-[var(--bg)] px-1 py-0.5 text-xs text-[var(--text)]"
      />
    </label>
  );
};

// =====================================================================

interface ToggleSwitchProps {
  on: boolean;
}

const ToggleSwitch: FC<ToggleSwitchProps> = ({ on }) => (
  <span
    aria-hidden="true"
    className={[
      "inline-flex h-3.5 w-6 items-center rounded-full border transition-colors",
      on
        ? "bg-[var(--accent)] border-[var(--accent)]"
        : "bg-transparent border-[var(--border)]",
    ].join(" ")}
  >
    <span
      className={[
        "h-2.5 w-2.5 rounded-full bg-[var(--bg)] transition-transform",
        on ? "translate-x-[10px]" : "translate-x-[2px]",
      ].join(" ")}
    />
  </span>
);
