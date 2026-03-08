"use client";

import { FC } from "react";
import { SLAB_TIERS, type SlabTierKey } from "@percolator/sdk";
import { getNetwork } from "@/lib/config";

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
 * PERC-509: On devnet, Small and Medium slab programs are outdated (120-byte slab
 * struct discrepancy) and will return InvalidSlabLen (error 0x4) on InitMarket.
 * Only Large is confirmed working until devops redeploys all tier programs.
 * On mainnet, all tiers are available.
 */
function getDevnetDisabledTiers(): Set<SlabTierKey> {
  try {
    if (getNetwork() === "devnet") return new Set<SlabTierKey>(["small", "medium"]);
  } catch { /* SSR safe */ }
  return new Set<SlabTierKey>();
}

/**
 * Radio-style list for Small/Medium/Large slab tiers with costs.
 * Used in Quick Launch Step 2 and Manual Step 3 (Parameters).
 * On devnet, Small/Medium are disabled until their programs are redeployed.
 */
export const SlabTierPicker: FC<SlabTierPickerProps> = ({ value, onChange }) => {
  const tiers = Object.entries(SLAB_TIERS) as [SlabTierKey, (typeof SLAB_TIERS)[SlabTierKey]][];
  const disabledTiers = getDevnetDisabledTiers();

  return (
    <div className="space-y-2">
      {tiers.map(([key, tier]) => {
        const selected = value === key;
        const disabled = disabledTiers.has(key);
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            title={
              disabled
                ? "Temporarily unavailable on devnet — program redeployment pending. Use Large tier."
                : undefined
            }
            onClick={() => { if (!disabled) onChange(key); }}
            className={`flex w-full items-center justify-between border p-3.5 transition-all ${
              disabled
                ? "border-[var(--border)]/50 bg-transparent opacity-40 cursor-not-allowed"
                : selected
                  ? "border-[var(--accent)]/40 bg-[var(--accent)]/[0.06]"
                  : "border-[var(--border)] bg-transparent hover:border-[var(--accent)]/20"
            }`}
          >
            <div className="flex items-center gap-3">
              <div
                className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                  disabled
                    ? "border-[var(--border)]/50"
                    : selected
                      ? "border-[var(--accent)]"
                      : "border-[var(--border)]"
                }`}
              >
                {selected && !disabled && (
                  <div className="h-2 w-2 rounded-full bg-[var(--accent)]" />
                )}
              </div>
              <div className="text-left">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[12px] font-semibold uppercase tracking-[0.05em] ${
                      disabled
                        ? "text-[var(--text-dim)]"
                        : selected
                          ? "text-white"
                          : "text-[var(--text)]"
                    }`}
                  >
                    {tier.label}
                  </span>
                  {disabled && (
                    <span className="text-[9px] font-medium uppercase tracking-[0.08em] text-[var(--text-dim)] border border-[var(--border)]/50 px-1 py-0.5">
                      DEVNET PENDING
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-[var(--text-dim)] mt-0.5">
                  {TIER_DESCRIPTIONS[key]} · {tier.maxAccounts} slots
                </p>
              </div>
            </div>
            <span
              className={`text-[12px] font-mono font-bold ${
                disabled
                  ? "text-[var(--text-dim)]"
                  : selected
                    ? "text-[var(--accent)]"
                    : "text-[var(--text-secondary)]"
              }`}
            >
              {TIER_COSTS[key]}
            </span>
          </button>
        );
      })}
      {disabledTiers.size > 0 && (
        <p className="text-[10px] text-[var(--text-dim)] pt-1">
          ⚠ Small/Medium programs pending redeployment on devnet. Use Large for now.
        </p>
      )}
    </div>
  );
};
