"use client";

/**
 * Earn after resolution (P3 / F-4; UX WP-8, audit §3.9). Keeper-first: the panel says the market
 * has settled and WHEN withdrawals open, as a time (never a slot), and re-reads on its own until
 * the payout is ready. "Finish now" is a secondary link that finishes every remaining step in ONE
 * approval (useResolvedExit.finish), optionally with the user's own withdrawal request last.
 * Pure view + a thin container over useResolvedExit.
 */
import { type FC } from "react";
import { COPY } from "@/lib/limits/copy";
import { summarizeResolvedExit, type ResolvedExitPlan } from "@/lib/limits/resolved-exit";
import { resolvedPayoutEta } from "@/lib/limits/resolved-eta";
import type { FinishRun } from "@/lib/limits/resolved-finish";
import type { ViewerReceipt } from "@/lib/limits/resolved-topup";
import { useResolvedExit } from "@/hooks/useResolvedExit";
import { LimitsNotice } from "./LimitsRow";

export interface ResolvedExitPanelViewProps {
  plan: ResolvedExitPlan | null;
  nowSlot: bigint | null;
  estimate: { steps: number; sol: string } | null;
  running: boolean;
  lastFinish: FinishRun | null;
  error: string | null;
  canRun: boolean;
  /** The viewer's Earn position on this market, formatted ("1,250.00 USDC"), or null. */
  earnAmount: string | null;
  /** The viewer holds shares with no request pending, so "Finish now" can include the request. */
  canRequest: boolean;
  onFinish: (withRequest: boolean) => void;
  /** The viewer's own resolved payout is partial (lib/limits/resolved-topup). */
  viewerReceipt?: ViewerReceipt;
  /** Test seams (the clock and the formatting locale / zone). */
  now?: Date;
  locale?: string;
  timeZone?: string;
}

export const ResolvedExitPanelView: FC<ResolvedExitPanelViewProps> = ({
  plan,
  nowSlot,
  estimate,
  running,
  lastFinish,
  error,
  canRun,
  earnAmount,
  canRequest,
  onFinish,
  viewerReceipt = "none",
  now,
  locale,
  timeZone,
}) => {
  if (!plan || plan.phase === "not-resolved") return null;
  const s = summarizeResolvedExit(plan);
  const ready = s.phase === "ready";
  const eta = !ready && nowSlot !== null ? resolvedPayoutEta({ untilSlot: s.untilSlot, nowSlot, now: now ?? new Date(), locale, timeZone }) : null;
  const showFinish = !ready && estimate !== null && estimate.steps > 0;
  return (
    <div data-testid="earn-resolved-exit-panel" data-phase={s.phase} className="mb-3 border border-[var(--border)] bg-[var(--panel-bg)] p-3">
      <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)]">{COPY.resolvedExit.title}</p>
      <p data-testid="earn-resolved-exit-status" data-phase={s.phase} className="mt-1 text-[11px] leading-relaxed text-[var(--text)]">
        {ready ? COPY.resolvedExit.ready : COPY.resolvedExit.status}
      </p>
      {viewerReceipt !== "none" && (
        <p data-testid="earn-resolved-exit-partial" data-receipt={viewerReceipt} className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
          {COPY.resolvedExit.partialReceipt}
        </p>
      )}
      {eta && (
        <p data-testid="earn-resolved-exit-eta" data-eta={eta.at.toISOString()} className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
          {COPY.resolvedExit.eta(earnAmount, eta.label, eta.relative)}
        </p>
      )}
      {s.escrowed > 0 && (
        <LimitsNotice tone="info" testId="earn-resolved-exit-blocker" data={{ kind: "escrowed" }}>
          {COPY.resolvedExit.escrowed(s.escrowed)}
        </LimitsNotice>
      )}
      {s.locked > 0 && (
        <LimitsNotice tone="info" testId="earn-resolved-exit-blocker" data={{ kind: "locked" }}>
          {COPY.resolvedExit.locked(s.locked)}
        </LimitsNotice>
      )}
      {showFinish && (
        <div className="mt-2">
          <p data-testid="earn-resolved-exit-finish-explain" className="text-[10px] leading-relaxed text-[var(--text-secondary)]">
            {COPY.resolvedExit.finishNow(estimate.steps, estimate.sol)}
          </p>
          <button
            type="button"
            data-testid="earn-resolved-exit"
            data-with-request={canRequest ? "1" : "0"}
            disabled={running || !canRun}
            onClick={() => onFinish(canRequest)}
            className="mt-1 text-[10px] font-medium text-[var(--accent)] underline underline-offset-2 transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:no-underline disabled:opacity-40"
          >
            {running ? COPY.resolvedExit.running : canRequest ? COPY.resolvedExit.finishAndWithdrawLink : COPY.resolvedExit.finishLink}
          </button>
        </div>
      )}
      {lastFinish && (
        <p data-testid="earn-resolved-exit-result" className="mt-2 text-[10px] text-[var(--text-secondary)]">
          {COPY.resolvedExit.result(lastFinish.broadcast, lastFinish.final.phase !== "ready")}
          {lastFinish.requested ? ` ${COPY.resolvedExit.requested}` : ""}
        </p>
      )}
      {error && (
        <p data-testid="earn-resolved-exit-error" className="mt-2 text-[10px] text-[var(--short)]">
          {error}
        </p>
      )}
    </div>
  );
};

export const ResolvedExitPanel: FC<{
  slab: string | null;
  walletConnected: boolean;
  onDone?: () => void;
  earnAmount?: string | null;
  /** Shares the viewer can request now (0 when none or a request is already pending). */
  requestableShares?: bigint;
  /** AUD-S1-18: what 77 would pay for `requestableShares` today (the request's floor sits under it). */
  requestQuoteAtoms?: bigint | null;
}> = ({ slab, walletConnected, onDone, earnAmount = null, requestableShares = 0n, requestQuoteAtoms = null }) => {
  const x = useResolvedExit(slab);
  return (
    <ResolvedExitPanelView
      plan={x.plan}
      nowSlot={x.nowSlot}
      estimate={x.estimate}
      running={x.running}
      lastFinish={x.lastFinish}
      error={x.error}
      canRun={walletConnected}
      earnAmount={earnAmount}
      viewerReceipt={x.viewerReceipt}
      canRequest={requestableShares > 0n}
      onFinish={(withRequest) => {
        void x
          .finish(withRequest ? { shares: requestableShares, quoteAtoms: requestQuoteAtoms } : undefined)
          .then(() => onDone?.())
          .catch(() => undefined);
      }}
    />
  );
};
