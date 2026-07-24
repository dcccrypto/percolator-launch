"use client";

import { FC, useState } from "react";
import { useCreatorClaim } from "@/hooks/useCreatorClaim";
import { formatTokenAmount } from "@/lib/format";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useSlabState } from "@/components/providers/SlabProvider";

/**
 * Creator fee-claim panel — `WithdrawCreatorFee` (tag 90).
 *
 * Renders ONLY for asset 0's `asset_admin` (the creator); non-creators never see
 * it. `asset_admin` is the field the on-chain tag-90 handler gates on and the one
 * authority that stays the creator's wallet after the wizard rotates marketauth /
 * insurance_authority / insurance_operator to program PDAs on a staked market.
 * It shows `creator_fee_claimable_atoms` — the market-level
 * counter the creator's cut of trade fees accrues into — and a Claim button
 * that pays exactly that out of the vault, then re-reads on-chain state so the
 * displayed amount drops.
 *
 * WHAT THIS IS NOT: the market's insurance fund / loss backstop. This panel
 * used to display `insurance_domain_budget` (the pot the engine draws down to
 * cover negative trader PnL) and drain it via tag 57, which was a solvency
 * withdrawal dressed up as revenue. Tag 90 cannot reach that pot, and nothing
 * here should ever describe it as creator earnings again.
 *
 * There is deliberately NO cooldown UI: tag 57's cooldown/ceiling gates
 * rate-limit backstop withdrawals, and `handle_withdraw_creator_fee` applies
 * neither.
 */
export const CreatorClaimPanel: FC<{ slabAddress?: string }> = () => {
  const { config } = useSlabState();
  const tokenMeta = useTokenMeta(config?.collateralMint ?? null);
  const decimals = tokenMeta?.decimals ?? 6;
  const symbol = tokenMeta?.symbol ?? "";

  const { isClaimAuthority, claimable, loading, error, success, claim } = useCreatorClaim();

  const [justClaimed, setJustClaimed] = useState(false);

  // Non-creators never see this panel.
  if (!isClaimAuthority) return null;

  const hasClaimable = claimable > 0n;
  const disabled = loading || !hasClaimable;

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
          You are the creator
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
          {loading ? "Claiming…" : hasClaimable ? "Claim fees" : "No fees to claim"}
        </button>

        <div className="mt-1 text-[8px] leading-relaxed text-[var(--text-dim)]">
          Your share of this market&apos;s trade fees. Paid from the market vault and
          separate from the insurance fund, which backs trader losses and is not
          claimable.
        </div>

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
