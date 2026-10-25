"use client";

/**
 * One calm line and one button on a market that has had no price for the stale window (wrapper tag 39 can settle it). Shown on the
 * trade page and on the position row; nothing renders on a market that has not matured, is already settled, or is not a v2.2 market.
 * The button is the only thing that ever sends (lib/v22/stale-resolve.ts, hooks/useStaleResolve.ts).
 */
import { type FC } from "react";
import { useStaleResolve } from "@/hooks/useStaleResolve";
import { STALE_SETTLE_COPY } from "@/lib/v22/stale-resolve";
import { staleLine } from "@/lib/v22/market-lifecycle";

export interface StaleSettleNoticeViewProps {
  minutes: number;
  /** When the price stopped (local time, an estimate). With it a stale market reads "Price stopped at <time>. Anyone can settle this market."; without it, the minutes line. */
  stoppedAtLabel?: string | null;
  /** "settled" = the market is already resolved: close out (no tag 39). */
  kind?: "stale" | "settled";
  hasFunds: boolean;
  busy: boolean;
  error: string | null;
  done: string | null;
  /** S1-6 a/c: the close waits for the other side to settle. A calm line, not an error; the button stays (no auto-retry). */
  waiting?: string | null;
  /** Wallet connected: without one the line is shown and the button is not. */
  canAct: boolean;
  onSettle: () => void;
  compact?: boolean;
}

/** Pure renderer (tested without a provider). */
export const StaleSettleNoticeView: FC<StaleSettleNoticeViewProps> = ({ minutes, stoppedAtLabel = null, kind = "stale", hasFunds, busy, error, done, waiting = null, canAct, onSettle, compact }) => (
  <div
    role="status"
    data-testid="stale-settle-notice"
    className={`${compact ? "mx-4 my-2" : "mb-3"} border border-[var(--warning)]/30 bg-[var(--warning)]/[0.04] px-3 py-2 text-[11px]`}
  >
    <p className="text-[var(--text)]" data-testid="stale-settle-line">
      {kind === "settled" ? STALE_SETTLE_COPY.settledLine : stoppedAtLabel ? staleLine(stoppedAtLabel, hasFunds) : hasFunds ? STALE_SETTLE_COPY.line(minutes) : STALE_SETTLE_COPY.lineNoFunds(minutes)}
    </p>
    {canAct && !done && (
      <button
        type="button"
        data-testid="stale-settle-button"
        onClick={onSettle}
        disabled={busy}
        className="mt-2 border border-[var(--border)] px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text)] hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? STALE_SETTLE_COPY.busy : kind === "settled" ? STALE_SETTLE_COPY.settledButton : STALE_SETTLE_COPY.button}
      </button>
    )}
    {done && <p className="mt-2 text-[var(--long)]" data-testid="stale-settle-done">{done}</p>}
    {waiting && !done && <p className="mt-2 text-[var(--text-secondary)]" data-testid="stale-settle-waiting">{waiting}</p>}
    {error && <p role="alert" className="mt-2 text-[var(--short)]" data-testid="stale-settle-error">{error}</p>}
  </div>
);

export const StaleSettleNotice: FC<{ slabAddress: string; hasFunds: boolean; canAct: boolean; compact?: boolean }> = ({ slabAddress, hasFunds, canAct, compact }) => {
  const s = useStaleResolve(slabAddress, hasFunds);
  // After a successful settle the market is no longer Live: keep the confirmation visible instead of vanishing with the notice.
  if (!s.view && !s.done) return null;
  return (
    <StaleSettleNoticeView
      minutes={s.view?.minutes ?? 0}
      stoppedAtLabel={s.view?.stoppedAtLabel ?? null}
      kind={s.view?.kind ?? "stale"}
      hasFunds={hasFunds}
      busy={s.busy}
      error={s.error}
      done={s.done}
      waiting={s.waiting}
      canAct={canAct}
      onSettle={() => void s.settle()}
      compact={compact}
    />
  );
};
