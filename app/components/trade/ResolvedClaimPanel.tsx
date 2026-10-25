"use client";

/**
 * The claim panel on a settled market's page: what this wallet can still collect here, senior first (positions, Earn, stake), each with
 * its one next action, and when the owner-only settle window ends. Nothing is sent on its own: the one button that sends is "Close and
 * withdraw" (the same settle flow as the trade ticket, hooks/useStaleResolve.ts); Earn and stake link to the pages that own those exits.
 * Renders nothing on a live market, and nothing for a viewer with no wallet connected beyond the order-of-payment line.
 */
import { type FC } from "react";
import Link from "next/link";
import { useStaleResolve } from "@/hooks/useStaleResolve";
import { useResolvedClaims } from "@/hooks/useResolvedClaims";
import { CLAIM_COPY, type ClaimAction, type ClaimRow, type OwnerWindow } from "@/lib/v22/resolved-claims";
import { relativePhrase } from "@/lib/limits/resolved-eta";

export interface ResolvedClaimPanelViewProps {
  rows: readonly ClaimRow[];
  window: OwnerWindow | null;
  slabAddress: string;
  walletConnected: boolean;
  loading: boolean;
  busy: boolean;
  error: string | null;
  done: string | null;
  waiting: string | null;
  onClose: () => void;
  /** Test seam: the viewer's locale / zone. */
  locale?: string;
  timeZone?: string;
}

function windowLine(w: OwnerWindow | null, locale?: string, timeZone?: string): string | null {
  if (!w) return null;
  if (!w.configured) return CLAIM_COPY.ownerWindowNone;
  if (!w.ownerOnly) return CLAIM_COPY.ownerWindowOver;
  if (w.endsAtMs === null) return null;
  const at = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(w.endsAtMs));
  return CLAIM_COPY.ownerWindow(`${at} (${relativePhrase(w.endsAtMs - Date.now())})`);
}

export const ResolvedClaimPanelView: FC<ResolvedClaimPanelViewProps> = ({ rows, window: w, slabAddress, walletConnected, loading, busy, error, done, waiting, onClose, locale, timeZone }) => {
  const line = windowLine(w, locale, timeZone);
  const mine = rows.filter((r) => r.actions.length > 0);
  return (
    <section data-testid="resolved-claim-panel" aria-label="Claims on this settled market" className="border-b border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3 text-[11px]">
      <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)]">{CLAIM_COPY.title}</p>
      <p className="mt-1 text-[var(--text-secondary)]">{CLAIM_COPY.intro}</p>
      {line && (
        <p data-testid="claim-owner-window" className="mt-1 text-[var(--text-secondary)]">
          {line}
        </p>
      )}
      {walletConnected && mine.length === 0 && !loading && (
        <p data-testid="claim-none" className="mt-2 text-[var(--text)]">
          {CLAIM_COPY.none}
        </p>
      )}
      <ol className="mt-2 space-y-2">
        {mine.map((r) => (
          <li key={r.kind} data-testid={`claim-row-${r.kind}`} data-status={r.status} className="border border-[var(--border)]/60 px-3 py-2">
            <p className="font-medium text-[var(--text)]">{CLAIM_COPY.rows[r.kind].label}</p>
            <p className="mt-0.5 text-[10px] text-[var(--text-secondary)]">{CLAIM_COPY.rows[r.kind].hint}</p>
            {r.waitingOn === "positions" && (
              <p data-testid="claim-waiting" className="mt-1 text-[10px] text-[var(--text-secondary)]">
                {CLAIM_COPY.waitingOnPositions}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-3">
              {r.actions.map((a) => (
                <ActionControl key={a} action={a} slabAddress={slabAddress} busy={busy} onClose={onClose} />
              ))}
            </div>
            {r.kind === "positions" && done && <p data-testid="claim-done" className="mt-2 text-[var(--long)]">{done}</p>}
            {r.kind === "positions" && waiting && !done && <p data-testid="claim-positions-waiting" className="mt-2 text-[var(--text-secondary)]">{waiting}</p>}
            {r.kind === "positions" && error && <p role="alert" className="mt-2 text-[var(--short)]">{error}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
};

const BTN = "border border-[var(--border)] px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text)] hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";

const ActionControl: FC<{ action: ClaimAction; slabAddress: string; busy: boolean; onClose: () => void }> = ({ action, slabAddress, busy, onClose }) => {
  switch (action) {
    case "close-and-withdraw":
      return (
        <button type="button" data-testid="claim-action-close-and-withdraw" onClick={onClose} disabled={busy} className={BTN}>
          {busy ? "Working…" : CLAIM_COPY.rows.positions.action}
        </button>
      );
    case "open-earn":
      return (
        <Link href={`/earn/${slabAddress}`} data-testid="claim-action-open-earn" className={BTN}>
          {CLAIM_COPY.rows.earn.action}
        </Link>
      );
    case "recover-to-stakers":
      return (
        <Link href="/stake" data-testid="claim-action-recover-to-stakers" className={BTN}>
          {CLAIM_COPY.rows.stake.recover}
        </Link>
      );
    case "withdraw-stake":
      return (
        <Link href="/stake" data-testid="claim-action-withdraw-stake" className={BTN}>
          {CLAIM_COPY.rows.stake.withdraw}
        </Link>
      );
    case "none":
      return null;
  }
};

/** Container: rendered inside the market's SlabProvider. */
export const ResolvedClaimPanel: FC<{ slabAddress: string; walletConnected: boolean }> = ({ slabAddress, walletConnected }) => {
  const c = useResolvedClaims(slabAddress);
  const positions = c.rows.find((r) => r.kind === "positions");
  const s = useStaleResolve(slabAddress, (positions?.actions.length ?? 0) > 0);
  if (!c.resolved) return null;
  return (
    <ResolvedClaimPanelView
      rows={c.rows}
      window={c.window}
      slabAddress={slabAddress}
      walletConnected={walletConnected}
      loading={c.loading}
      busy={s.busy}
      error={s.error}
      done={s.done}
      waiting={s.waiting}
      onClose={() => void s.settle()}
    />
  );
};
