"use client";

import { FC, useState } from "react";
import { useCreatorClaim } from "@/hooks/useCreatorClaim";
import { formatTokenAmount } from "@/lib/format";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useSlabState } from "@/components/providers/SlabProvider";

/**
 * Creator fee-claim panel (audit gap #2).
 *
 * Renders ONLY for the market's insurance_operator (the creator) — non-creators
 * never see it. Shows the accrued claimable creator revenue (the real per-asset
 * insurance_domain_budget) and a Claim button that sends WithdrawInsuranceAsset
 * (tag 57), then re-reads on-chain state so the displayed amount drops to 0.
 *
 * Rough devnet slot time (~0.4s) used only to humanize the cooldown countdown;
 * the on-chain cooldown gate is authoritative.
 */
const APPROX_SLOT_MS = 400;

function formatCooldown(remainingSlots: bigint): string {
  const secs = Math.max(0, Math.round((Number(remainingSlots) * APPROX_SLOT_MS) / 1000));
  if (secs < 90) return `~${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `~${mins}m`;
  return `~${Math.round(mins / 60)}h`;
}

export const CreatorClaimPanel: FC<{ slabAddress?: string }> = () => {
  const { config } = useSlabState();
  const tokenMeta = useTokenMeta(config?.collateralMint ?? null);
  const decimals = tokenMeta?.decimals ?? 6;
  const symbol = tokenMeta?.symbol ?? "";

  const {
    isOperator,
    claimable,
    cooldownActive,
    cooldownRemainingSlots,
    loading,
    error,
    success,
    claim,
  } = useCreatorClaim();

  const [justClaimed, setJustClaimed] = useState(false);

  // Non-creators never see this panel.
  if (!isOperator) return null;

  const hasClaimable = claimable > 0n;
  const disabled = loading || !hasClaimable || cooldownActive;

  const onClaim = async () => {
    setJustClaimed(false);
    try {
      await claim();
      setJustClaimed(true);
    } catch {
      // error surfaced via the hook's `error` state
    }
  };

  return (
    <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80">
      <div className="flex items-center justify-between border-b border-[var(--border)]/40 px-3 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]">
          Creator fees
        </span>
        <span className="text-[8px] uppercase tracking-[0.1em] text-[var(--text-dim)]">
          You are the operator
        </span>
      </div>

      <div className="p-3">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[9px] text-[var(--text-dim)]">Claimable</span>
        <span
          className="text-[13px] font-medium text-[var(--text)]"
          style={{ fontFamily: "var(--font-mono)" }}
          data-testid="creator-claimable"
        >
          {formatTokenAmount(claimable, decimals)} {symbol}
        </span>
      </div>

      <button
        type="button"
        onClick={onClaim}
        disabled={disabled}
        data-testid="creator-claim-button"
        className={`w-full rounded-none px-2 py-1 text-[11px] font-medium transition-colors ${
          disabled
            ? "cursor-not-allowed bg-[var(--bg)] text-[var(--text-dim)]"
            : "bg-[var(--accent)] text-[var(--accent-contrast,#fff)] hover:opacity-90"
        }`}
      >
        {loading
          ? "Claiming…"
          : cooldownActive
            ? `Cooldown ${formatCooldown(cooldownRemainingSlots)}`
            : hasClaimable
              ? "Claim fees"
              : "No fees to claim"}
      </button>

      {cooldownActive && !loading && (
        <div className="mt-1 text-[8px] text-[var(--text-dim)]">
          Fees can be claimed once per cooldown window. Next claim available in about{" "}
          {formatCooldown(cooldownRemainingSlots)}.
        </div>
      )}

      {error && (
        <div className="mt-1 text-[8px] text-[var(--warning,#e0a000)]" data-testid="creator-claim-error">
          {error}
        </div>
      )}

      {success && justClaimed && !error && (
        <div className="mt-1 text-[8px] text-[var(--long,#22c55e)]" data-testid="creator-claim-success">
          Claimed. Balance updated.
        </div>
      )}
      </div>
    </div>
  );
};
