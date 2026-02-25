"use client";

import { FC } from "react";
import { SLAB_TIERS, type SlabTierKey } from "@percolator/sdk";

interface SlabTierPickerProps {
  value: SlabTierKey;
  onChange: (tier: SlabTierKey) => void;
}

const TIER_COSTS: Record<SlabTierKey, string> = {
  small: "~0.44 SOL",
  medium: "~1.8 SOL",
  large: "~7 SOL",
};

const TIER_DESCRIPTIONS: Record<SlabTierKey, string> = {
  small: "Low liquidity depth",
  medium: "Standard",
  large: "Deep orderbook",
};

/**
 * Radio-style list for Small/Medium/Large slab tiers with costs.
 * Used in Step 3 (Parameters).
 */
export const SlabTierPicker: FC<SlabTierPickerProps> = ({ value, onChange }) => {
  const tiers = Object.entries(SLAB_TIERS) as [SlabTierKey, (typeof SLAB_TIERS)[SlabTierKey]][];

  return (
    <div className="space-y-2">
      {tiers.map(([key, tier]) => {
        const selected = value === key;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(key)}
            className={`flex w-full items-center justify-between border p-3.5 transition-all ${
              selected
                ? "border-[var(--accent)]/40 bg-[var(--accent)]/[0.06]"
                : "border-[var(--border)] bg-transparent hover:border-[var(--accent)]/20"
            }`}
          >
            <div className="flex items-center gap-3">
              <div
                className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                  selected
                    ? "border-[var(--accent)]"
                    : "border-[var(--border)]"
                }`}
              >
                {selected && (
                  <div className="h-2 w-2 rounded-full bg-[var(--accent)]" />
                )}
              </div>
              <div className="text-left">
                <span
                  className={`text-[12px] font-semibold uppercase tracking-[0.05em] ${
                    selected ? "text-white" : "text-[var(--text)]"
                  }`}
                >
                  {tier.label}
                </span>
                <p className="text-[10px] text-[var(--text-dim)] mt-0.5">
                  {TIER_DESCRIPTIONS[key]} · {tier.maxAccounts} slots
                </p>
              </div>
            </div>
            <span
              className={`text-[12px] font-mono font-bold ${
                selected ? "text-[var(--accent)]" : "text-[var(--text-secondary)]"
              }`}
            >
              {TIER_COSTS[key]}
            </span>
          </button>
        );
      })}
    </div>
  );
};
