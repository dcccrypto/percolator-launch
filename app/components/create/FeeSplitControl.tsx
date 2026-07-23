"use client";

import { FC, useMemo } from "react";
import { FEE_SPLIT, validateFeeSplit } from "@percolatorct/sdk";

/** The three creator-settable fee shares, in bps of the total trade fee (T). */
export interface FeeSplitBps {
  creatorShareBps: number;
  lpShareBps: number;
  insuranceShareBps: number;
}

/** On-chain defaults (creator 1600 / LP 4800 / insurance 1600 bps of T). */
export const DEFAULT_FEE_SPLIT: FeeSplitBps = {
  creatorShareBps: FEE_SPLIT.DEFAULT_CREATOR_SHARE_BPS,
  lpShareBps: FEE_SPLIT.DEFAULT_LP_SHARE_BPS,
  insuranceShareBps: FEE_SPLIT.DEFAULT_INSURANCE_SHARE_BPS,
};

/** True when the split equals the on-chain defaults (so no UpdateFeeSplit tx is needed). */
export function isDefaultFeeSplit(s: FeeSplitBps): boolean {
  return (
    s.creatorShareBps === DEFAULT_FEE_SPLIT.creatorShareBps &&
    s.lpShareBps === DEFAULT_FEE_SPLIT.lpShareBps &&
    s.insuranceShareBps === DEFAULT_FEE_SPLIT.insuranceShareBps
  );
}

/** Format a bps-of-T value as a percentage of the total trade fee (e.g. 4800 → "48%"). */
function bpsToPct(bps: number): string {
  const pct = bps / 100;
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
}

interface FeeSplitControlProps {
  value: FeeSplitBps;
  onChange: (next: FeeSplitBps) => void;
}

/**
 * Fee-split control (Step 3) — lets a creator set how the trade fee is divided.
 *
 * The trade fee (T) always splits four ways: a FIXED 20% protocol cut (not
 * settable), then the three creator-controlled shares below, which are bps of T
 * and must sum to exactly 8000 (= 10000 − 2000 protocol). Floors are enforced
 * on-chain: creator ≤ 3600, LP ≥ 3200, insurance ≥ 1200.
 *
 * We validate here with the SDK's `validateFeeSplit` — the SAME rules the
 * wrapper enforces — so the user never eats a cryptic on-chain Custom(52)
 * FeeSplitSumInvalid / Custom(51) FeeSplitFloorViolation. Inputs are in whole
 * percent of T (×100 → bps) which keeps every value a clean integer multiple of
 * 100 (the defaults and floors all are), and are displayed alongside the fixed
 * 20% protocol leg so the four numbers visibly add up to 100%.
 */
export const FeeSplitControl: FC<FeeSplitControlProps> = ({ value, onChange }) => {
  const error = useMemo(() => validateFeeSplit(value), [value]);
  const sumBps =
    value.creatorShareBps + value.lpShareBps + value.insuranceShareBps;
  const protocolPct = FEE_SPLIT.PROTOCOL_FEE_BPS / 100; // 20

  // Whole-percent-of-T inputs. onChange converts back to bps (×100).
  const pct = (bps: number) => Math.round(bps / 100);
  const setLeg = (leg: keyof FeeSplitBps, pctStr: string) => {
    const cleaned = pctStr.replace(/[^0-9]/g, "");
    const nextPct = cleaned === "" ? 0 : parseInt(cleaned, 10);
    onChange({ ...value, [leg]: nextPct * 100 });
  };

  const legs: { key: keyof FeeSplitBps; label: string; hint: string }[] = [
    { key: "creatorShareBps", label: "Creator", hint: "max 36%" },
    { key: "lpShareBps", label: "LP vault", hint: "min 32%" },
    { key: "insuranceShareBps", label: "Insurance", hint: "min 12%" },
  ];

  return (
    <div className="border border-[var(--border)] bg-[var(--bg)] px-4 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <label className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text)]">
          Fee Split
        </label>
        {!isDefaultFeeSplit(value) && (
          <button
            type="button"
            onClick={() => onChange(DEFAULT_FEE_SPLIT)}
            className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-secondary)] underline decoration-dotted hover:text-[var(--text)]"
          >
            Reset to default
          </button>
        )}
      </div>

      <p className="text-[10px] text-[var(--text-secondary)] leading-relaxed">
        How the trade fee is divided. The protocol takes a fixed {protocolPct}%;
        you set the remaining {100 - protocolPct}% across creator, LP vault and
        insurance. The three must add up to {100 - protocolPct}% and respect the
        floors.
      </p>

      {/* Fixed protocol leg — shown so the numbers visibly total 100% */}
      <div className="flex items-center justify-between border-b border-[var(--border)]/60 pb-2">
        <span className="text-[11px] text-[var(--text-secondary)]">
          Protocol <span className="text-[9px] uppercase tracking-wide">(fixed)</span>
        </span>
        <span className="text-[12px] font-mono font-bold text-[var(--text-secondary)]">
          {protocolPct}%
        </span>
      </div>

      {legs.map(({ key, label, hint }) => (
        <div key={key} className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="text-[11px] text-[var(--text)]">{label}</span>
            <span className="text-[9px] text-[var(--text-dim)] uppercase tracking-wide">
              {hint} · {bpsToPct(value[key])} of fee
            </span>
          </div>
          <div className="flex items-center gap-1">
            <input
              type="text"
              inputMode="numeric"
              aria-label={`${label} share (percent of trade fee)`}
              value={pct(value[key])}
              onChange={(e) => setLeg(key, e.target.value)}
              className="w-16 border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-right text-[12px] font-mono text-[var(--text)] focus:border-[var(--accent)]/40 focus:outline-none"
            />
            <span className="text-[11px] text-[var(--text-secondary)]">%</span>
          </div>
        </div>
      ))}

      {/* Running total + validation */}
      <div className="flex items-center justify-between border-t border-[var(--border)]/60 pt-2">
        <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-secondary)]">
          Your legs total
        </span>
        <span
          className={`text-[12px] font-mono font-bold ${
            sumBps === FEE_SPLIT.FEE_SHARE_TOTAL_BPS
              ? "text-[var(--text)]"
              : "text-[var(--error)]"
          }`}
        >
          {bpsToPct(sumBps)} / {100 - protocolPct}%
        </span>
      </div>

      {error && (
        <p className="text-[10px] text-[var(--error)] leading-relaxed" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};
