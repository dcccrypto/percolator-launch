"use client";

/**
 * Devnet v2.1 (growth-v19): the ticket's dynamic-leverage panel. Renders only for a market whose
 * growth record is on (`TicketLimits.growth` non-null), so a market of today's programs shows
 * nothing new. Pure renderer of lib/v21/growth-market.ts decisions.
 *
 * Shows the live max leverage per side, a capacity bar for the selected side, the busy-side fee
 * when this order owes one, and the one-line "leverage adjusts with market backing". Reducing or
 * closing is never limited by it (said once, calmly).
 */
import { type FC } from "react";
import type { GrowthMarketView, GrowthTicketDecision } from "@/lib/v21/growth-market";
import { V21_COPY } from "@/lib/v21/copy";

export interface GrowthTicketPanelProps {
  view: GrowthMarketView;
  decision: GrowthTicketDecision;
  direction: "long" | "short";
}

const levLabel = (x100: number, closed: boolean): string => (closed ? "full" : `${(x100 / 100).toFixed(x100 % 100 === 0 ? 0 : 1)}x`);

export const GrowthTicketPanel: FC<GrowthTicketPanelProps> = ({ view, decision, direction }) => {
  const pct = decision.utilisation === null ? null : Math.round(decision.utilisation * 100);
  const feePct = decision.fee && decision.fee.utilFeeBps > 0 ? `${(decision.fee.utilFeeBps / 100).toFixed(2)}%` : null;
  const tone = decision.closed ? "var(--short)" : pct !== null && pct >= 80 ? "var(--warning)" : "var(--accent)";
  return (
    <section aria-label="Dynamic leverage" data-testid="growth-ticket-panel" className="mb-3 border border-[var(--border)]/60 px-3 py-2 text-[11px]">
      <p className="text-[var(--text-secondary)]" data-testid="growth-adjusts">{V21_COPY.ticket.adjusts}</p>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-3" style={{ fontVariantNumeric: "tabular-nums" }}>
        {(["long", "short"] as const).map((side) => {
          const q = side === "long" ? view.long : view.short;
          return (
            <div key={side} className={side === direction ? "text-[var(--text)]" : "text-[var(--text-dim)]"} data-testid={`growth-max-${side}`}>
              <dt className="text-[10px] uppercase tracking-[0.12em]">{side}</dt>
              <dd className="font-mono">{levLabel(q.maxLeverageX100, q.closed)}</dd>
            </div>
          );
        })}
      </dl>
      {pct !== null && (
        <div className="mt-2" data-testid="growth-capacity">
          <div className="mb-0.5 flex justify-between text-[10px] text-[var(--text-dim)]">
            <span>{V21_COPY.ticket.capacity}</span>
            <span>{V21_COPY.ticket.capacityUsed(`${pct}%`)}</span>
          </div>
          <div
            role="progressbar"
            aria-label={`${direction} side capacity`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="h-1.5 w-full overflow-hidden bg-[var(--border)]/40"
          >
            <div className="h-full" style={{ width: `${pct}%`, background: tone }} data-testid="growth-capacity-fill" />
          </div>
        </div>
      )}
      {decision.closed && <p className="mt-2 text-[var(--short)]" data-testid="growth-closed">{V21_COPY.growthClosed(direction, decision.quote.closedReason)}</p>}
      {feePct && <p className="mt-2 text-[var(--text-secondary)]" data-testid="growth-fee">{V21_COPY.ticket.fee(feePct)}</p>}
      <p className="mt-2 text-[10px] text-[var(--text-dim)]">{V21_COPY.ticket.closeAlways}</p>
    </section>
  );
};
