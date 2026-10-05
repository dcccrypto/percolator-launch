"use client";

/** Pure renderer for the Move plan (tested without providers). */
import { type FC } from "react";
import Link from "next/link";
import { MOVE_COPY } from "@/lib/v21/move/copy";
import type { MovePlan, MoveStep, PlanSummary } from "@/lib/v21/move/plan";
import { slotsToDuration } from "@/lib/v21/lock-episode";

export interface MovePlanViewProps {
  plan: MovePlan;
  summary: PlanSummary;
  v21Live: boolean;
  running: boolean;
  /** Where the market's own flow lives for a handed-off step. */
  hrefFor: (step: MoveStep) => string;
  onRun: () => void;
  /** Run just this step in place (close, withdraw, Earn request / collect, creator fees). */
  onRunStep?: (step: MoveStep) => void;
  /** Calm reason the last run stopped on an error. */
  error?: string | null;
  onRescan: () => void;
}

const IN_PLACE: readonly MoveStep["kind"][] = ["close", "withdraw", "earn-request", "earn-execute", "claim-creator-fee"];

const dot: Record<MoveStep["status"], string> = {
  done: "bg-[var(--long)]",
  ready: "bg-[var(--accent)]",
  waiting: "bg-[var(--warning)]",
  blocked: "bg-[var(--text-dim)]",
  unavailable: "bg-[var(--text-dim)]",
  skipped: "bg-[var(--text-dim)]",
};

export const MovePlanView: FC<MovePlanViewProps> = ({ plan, summary, v21Live, running, hrefFor, onRun, onRunStep, error, onRescan }) => (
  <div data-testid="move-plan" className="space-y-4">
    <p className="text-[12px] text-[var(--text-secondary)]" data-testid="move-summary">{MOVE_COPY.summary[summary]}</p>
    {!v21Live && <p className="text-[11px] text-[var(--text-dim)]" data-testid="move-not-live">{MOVE_COPY.notLive}</p>}
    {plan.markets.map((m) => (
      <section key={m.slab} className="border border-[var(--border)] px-3 py-2" data-testid={`move-market-${m.slab}`}>
        <h2 className="text-[12px] font-medium text-[var(--text)]">{m.symbol || m.slab.slice(0, 6)} <span className="text-[var(--text-dim)]">v1</span></h2>
        <ol className="mt-1 space-y-1.5">
          {m.steps.map((s) => (
            <li key={s.id} data-testid={`move-step-${s.kind}`} data-status={s.status} className="flex items-start gap-2 text-[11px]">
              <span aria-hidden="true" className={`mt-1 h-1.5 w-1.5 shrink-0 ${dot[s.status]}`} />
              <span className="min-w-0 flex-1">
                <span className="font-medium text-[var(--text)]">{MOVE_COPY.kind[s.kind]}</span>
                <span className="ml-2 text-[var(--text-dim)]">{MOVE_COPY.status[s.status]}</span>
                <span className="block text-[var(--text-secondary)]">{s.line}</span>
                {s.status === "waiting" && s.waitSlots !== undefined && s.waitSlots > 0n && (
                  <span className="block text-[var(--text-dim)]" data-testid="move-countdown">{slotsToDuration(s.waitSlots)} remaining. {MOVE_COPY.whyEarnWait}</span>
                )}
              </span>
              {s.status === "ready" && onRunStep && IN_PLACE.includes(s.kind) && (
                <button type="button" disabled={running} onClick={() => onRunStep(s)} className="border border-[var(--border)] px-2 py-1 text-[10px] uppercase tracking-[0.1em] hover:border-[var(--accent)] disabled:opacity-50" data-testid={`move-do-${s.kind}`}>{running ? MOVE_COPY.working : MOVE_COPY.doStep}</button>
              )}
              {s.status === "ready" && !(onRunStep && IN_PLACE.includes(s.kind)) && (
                <Link href={hrefFor(s)} className="border border-[var(--border)] px-2 py-1 text-[10px] uppercase tracking-[0.1em] hover:border-[var(--accent)]" data-testid={`move-open-${s.kind}`}>{MOVE_COPY.doIt}</Link>
              )}
            </li>
          ))}
        </ol>
      </section>
    ))}
    {error && <p role="alert" className="text-[11px] text-[var(--text-secondary)]" data-testid="move-run-error">{error}</p>}
    <div className="flex gap-2">
      <button type="button" onClick={onRun} disabled={running || summary !== "ready"} className="border border-[var(--border)] px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.1em] hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50" data-testid="move-run">{MOVE_COPY.runReady}</button>
      <button type="button" onClick={onRescan} className="px-3 py-1.5 text-[10px] uppercase tracking-[0.1em] text-[var(--text-dim)]" data-testid="move-rescan">{MOVE_COPY.rescan}</button>
    </div>
  </div>
);
