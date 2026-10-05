"use client";

/**
 * Devnet v2.1 (P2b lock exits): the close-only episode countdown, and the permissionless tag 104
 * wind-down where it would close something now. Renders nothing unless the market is close-only
 * AND the v2.1 flag is on (the caller gates on the flag). Closing yourself always works and is
 * said first.
 */
import { type FC } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useClusterSlot } from "@/hooks/useClusterSlot";
import { useAdlWindDown } from "@/hooks/useAdlWindDown";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { countdownLine, deriveCloseOnlyState } from "@/lib/v21/lock-episode";
import { V21_COPY } from "@/lib/v21/copy";

export interface CloseOnlyBannerViewProps {
  line: string;
  /** Offer the wind-down button (a position exists and a wind-down would close it now). */
  canWindDown: boolean;
  busy: boolean;
  error: string | null;
  done: boolean;
  onWindDown: () => void;
}

/** Pure renderer (tested without a provider). */
export const CloseOnlyBannerView: FC<CloseOnlyBannerViewProps> = ({ line, canWindDown, busy, error, done, onWindDown }) => (
  <div role="status" data-testid="close-only-banner" className="mb-3 border border-[var(--warning)]/30 bg-[var(--warning)]/[0.04] px-3 py-2 text-[11px]">
    <p className="font-medium text-[var(--text)]">{V21_COPY.lock.closeOnly}</p>
    <p className="mt-0.5 text-[var(--text-secondary)]">{V21_COPY.lock.closeOnlySub}</p>
    <p className="mt-1 text-[var(--text-secondary)]" data-testid="close-only-countdown">{line}</p>
    {canWindDown && !done && (
      <div className="mt-2">
        <p className="mb-1.5 text-[10px] text-[var(--text-dim)]">{V21_COPY.lock.windDownExplain}</p>
        <button
          type="button"
          data-testid="adl-wind-down"
          onClick={onWindDown}
          disabled={busy}
          className="border border-[var(--border)] px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text)] hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? V21_COPY.lock.windDownBusy : V21_COPY.lock.windDownTitle}
        </button>
      </div>
    )}
    {done && <p className="mt-2 text-[var(--long)]" data-testid="adl-wind-down-done">{V21_COPY.lock.windDownDone}</p>}
    {error && <p role="alert" className="mt-2 text-[var(--short)]" data-testid="adl-wind-down-error">{error}</p>}
  </div>
);

export const CloseOnlyBanner: FC<{ slabAddress: string; hasPosition: boolean; collateralDecimals: number }> = ({ slabAddress, hasPosition, collateralDecimals }) => {
  const { raw } = useSlabState();
  const nowSlot = useClusterSlot();
  const { windDown, busy, error, done } = useAdlWindDown(slabAddress);
  const engine = raw ? decodeMarketEngineView(raw) : null;
  const state = deriveCloseOnlyState({ raw, engine, nowSlot, collateralDecimals });
  if (!state.closeOnly) return null;
  return (
    <CloseOnlyBannerView
      line={countdownLine(state, V21_COPY.lock)}
      canWindDown={hasPosition && state.windDownNow}
      busy={busy}
      error={error}
      done={done}
      onWindDown={() => void windDown()}
    />
  );
};
