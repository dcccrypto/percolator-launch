"use client";

import { type FC } from "react";
import { useRecoverToStakers } from "@/hooks/useRecoverToStakers";
import { RECOVER_COPY } from "@/lib/v22/resolved-claims";

export interface RecoverToStakersViewProps {
  offer: boolean;
  blockedByPositions: boolean;
  busy: boolean;
  error: string | null;
  done: string | null;
  canAct: boolean;
  onRecover: () => void;
}

/** Pure renderer. Shown above Withdraw on a pool whose market is settled. */
export const RecoverToStakersView: FC<RecoverToStakersViewProps> = ({ offer, blockedByPositions, busy, error, done, canAct, onRecover }) => {
  if (!offer && !done) return null;
  return (
    <div data-testid="recover-to-stakers" className="border border-[var(--warning)]/30 bg-[var(--warning)]/[0.04] px-3 py-2 text-[11px]">
      <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)]">{RECOVER_COPY.title}</p>
      {!done && <p className="mt-1 text-[var(--text-secondary)]">{RECOVER_COPY.body}</p>}
      {blockedByPositions && !done && <p data-testid="recover-waiting" className="mt-1 text-[var(--text-secondary)]">{RECOVER_COPY.waitingOnPositions}</p>}
      {canAct && !done && (
        <button
          type="button"
          data-testid="recover-to-stakers-button"
          onClick={onRecover}
          disabled={busy || blockedByPositions}
          className="mt-2 border border-[var(--border)] px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text)] hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? RECOVER_COPY.busy : RECOVER_COPY.button}
        </button>
      )}
      {done && <p data-testid="recover-done" className="mt-1 text-[var(--long)]">{done}</p>}
      {error && <p role="alert" data-testid="recover-error" className="mt-1 text-[var(--short)]">{error}</p>}
    </div>
  );
};

export const RecoverToStakers: FC<{ slabAddress: string; canAct: boolean }> = ({ slabAddress, canAct }) => {
  const r = useRecoverToStakers(slabAddress);
  return (
    <RecoverToStakersView
      offer={r.view?.offer ?? false}
      blockedByPositions={r.view?.blockedByPositions ?? false}
      busy={r.busy}
      error={r.error}
      done={r.done}
      canAct={canAct}
      onRecover={() => void r.recover()}
    />
  );
};
