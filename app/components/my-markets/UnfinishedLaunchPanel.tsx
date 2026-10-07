"use client";

import { FC } from "react";
import Link from "next/link";
import { UNFINISHED_COPY, unfinishedStageCopy, type LaunchStage } from "@/lib/unfinished-launch";

/**
 * What a creator sees in an unfinished launch's drawer (#3266): what state it stopped in, what is and
 * is not possible, and the two actions. Reclaim rent appears only where the chain says the market can
 * still be removed; a launch that already holds a portfolio or funds can only be finished, and says so
 * instead of offering a close that would revert.
 */
export const UnfinishedLaunchPanel: FC<{
  stage: LaunchStage;
  /** Where Continue goes. */
  continueHref: string;
  onReclaim: () => void;
  reclaiming: boolean;
  /** Why Reclaim rent can't be pressed right now (unclaimed fees, wrong wallet), or null. */
  reclaimBlockedReason?: string | null;
  /** The close error, verbatim, if the last reclaim failed. */
  error: string | null;
}> = ({ stage, continueHref, onReclaim, reclaiming, reclaimBlockedReason = null, error }) => (
  <div data-testid="unfinished-launch-panel" data-stage={stage.kind} className="mb-4 border border-[var(--warning)]/30 bg-[var(--warning)]/[0.04] p-4">
    <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--warning)]">{UNFINISHED_COPY.heading}</p>
    <p data-testid="unfinished-launch-copy" className="mt-1 text-[11px] text-[var(--text-secondary)]">{unfinishedStageCopy(stage)}</p>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Link
        href={continueHref}
        data-testid="unfinished-continue"
        className="border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/[0.15]"
      >
        {UNFINISHED_COPY.continue}
      </Link>
      {stage.kind === "removable" && (
        <button
          type="button"
          data-testid="unfinished-reclaim"
          disabled={reclaiming || reclaimBlockedReason !== null}
          title={reclaimBlockedReason ?? undefined}
          onClick={onReclaim}
          className="border border-[var(--border)] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-colors hover:border-[var(--short)]/40 hover:text-[var(--text)] disabled:opacity-50"
        >
          {reclaiming ? "reclaiming…" : UNFINISHED_COPY.reclaim}
        </button>
      )}
    </div>
    {stage.kind === "removable" && reclaimBlockedReason && (
      <p data-testid="unfinished-reclaim-blocked" className="mt-2 text-[10px] text-[var(--text)]">{reclaimBlockedReason}</p>
    )}
    {error && <p className="mt-2 text-[10px] text-[var(--short)]">{error}</p>}
  </div>
);
