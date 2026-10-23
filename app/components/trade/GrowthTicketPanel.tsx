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
import { V22_COPY } from "@/lib/v22/copy";
import type { TierCollateral } from "@/lib/v22/tier-config";
import { unlockLine, type GrowthUnlockView } from "@/lib/v22/growth-unlock";
import { InfoIcon } from "@/components/ui/Tooltip";
import { roomLine, trimLine, type RoomFormat } from "@/lib/v22/growth-room";

export interface GrowthTicketPanelProps {
  view: GrowthMarketView;
  decision: GrowthTicketDecision;
  direction: "long" | "short";
  /**
   * Devnet v2.2: tier badge and the next-unlock line. Absent (or `graduation` false) on every market whose ceiling
   * is fixed at the creator's launch leverage: nothing is said there.
   */
  unlock?: GrowthUnlockView | null;
  /** The market's collateral, so amounts read "$25k" only on USD-like collateral (default: the test USDC). */
  collateral?: TierCollateral;
  /** How sizes read on this ticket (lot exponent + ticker) for the room line; default: tokens without a ticker. */
  sizeFormat?: RoomFormat;
  /** The ticket already pauses opening on this side for another reason (P1: the LP is at its floor): the capacity row says "paused". */
  sidePaused?: boolean;
  /** That pause is because the side is FULL: the row reads "paused (full)". */
  sideFull?: boolean;
}

const levLabel = (x100: number): string => `${(x100 / 100).toFixed(x100 % 100 === 0 ? 0 : 1)}x`;

/** "Full" reasons get the plan's wording; a paused market (loss recovery, not set up, unreadable) keeps its own line. */
const isFullReason = (r: GrowthMarketView["long"]["closedReason"]): boolean => r === "capacity-full" || r === "capacity-zero" || r === null;

export const GrowthTicketPanel: FC<GrowthTicketPanelProps> = ({ view, decision, direction, unlock = null, collateral, sizeFormat = { lotExp: 0, ticker: "" }, sidePaused = false, sideFull = false }) => {
  const openSides = (["long", "short"] as const).filter((side) => !(side === "long" ? view.long : view.short).closed);
  const closedSides = (["long", "short"] as const).filter((side) => (side === "long" ? view.long : view.short).closed);
  const reasonOf = (side: "long" | "short") => (side === "long" ? view.long : view.short).closedReason;
  const closedLine: string | null =
    closedSides.length === 0
      ? null
      : closedSides.length === 2
        ? closedSides.every((s) => isFullReason(reasonOf(s)))
          ? V22_COPY.growth.bothPaused
          : V21_COPY.growthClosed(direction, reasonOf(direction))
        : isFullReason(reasonOf(closedSides[0] as "long" | "short"))
          ? V22_COPY.growth.sidePaused(closedSides[0] as "long" | "short")
          : V21_COPY.growthClosed(closedSides[0] as string, reasonOf(closedSides[0] as "long" | "short"));
  const graduating = !!unlock && unlock.graduation;
  const tier = graduating ? unlock.tier : null;
  const nextLine = graduating ? unlockLine(unlock.unlock, collateral) : null;
  const pct = decision.utilisation === null ? null : Math.round(decision.utilisation * 100);
  const feePct = decision.fee && decision.fee.utilFeeBps > 0 ? `${(decision.fee.utilFeeBps / 100).toFixed(2)}%` : null;
  // A closed side is "paused", never a percentage: 0% full reads as lots of room when there is none.
  const paused = decision.quote.closed || sidePaused;
  const roomText = !paused && decision.roomQ !== null ? roomLine(decision.roomQ, view.quoteInput.priceE6, sizeFormat) : null;
  const trimText = !paused && decision.trimmed && decision.roomQ !== null ? trimLine(decision.roomQ, decision.fillQ, sizeFormat) : null;
  const tone = decision.closed ? "var(--short)" : pct !== null && pct >= 80 ? "var(--warning)" : "var(--accent)";
  return (
    <section aria-label="Dynamic leverage" data-testid="growth-ticket-panel" className="mb-3 border border-[var(--border)]/60 px-3 py-2 text-[11px]">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[var(--text-secondary)]" data-testid="growth-adjusts">{V21_COPY.ticket.adjusts}</p>
        {tier !== null && (
          <span className="shrink-0 whitespace-nowrap text-[10px] text-[var(--text-dim)]" data-testid="growth-tier">
            {V22_COPY.growth.tier(tier)}
            <InfoIcon tooltip={V22_COPY.growth.tierTip} />
          </span>
        )}
      </div>
      {openSides.length > 0 && (
        <p className="mt-1.5 text-[var(--text)]" style={{ fontVariantNumeric: "tabular-nums" }} data-testid="growth-max-now">
          {V22_COPY.growth.maxNow}:{" "}
          {openSides.map((side, i) => {
            const q = side === "long" ? view.long : view.short;
            return (
              <span key={side}>
                {i > 0 && " · "}
                <span className={side === direction ? "text-[var(--text)]" : "text-[var(--text-dim)]"} data-testid={`growth-max-${side}`}>
                  <span className="font-mono">{levLabel(side === direction && decision.fillMaxLeverage !== null ? Math.round(decision.fillMaxLeverage * 100) : q.maxLeverageX100)}</span> {side}
                </span>
              </span>
            );
          })}
        </p>
      )}
      {closedLine && <p className="mt-1.5 text-[var(--short)]" data-testid="growth-closed">{closedLine}</p>}
      {graduating && unlock.sticky && !(openSides.length === 0) && (
        <p className="mt-1 text-[var(--text-secondary)]" data-testid="growth-sticky">{V22_COPY.growth.stickyCap}</p>
      )}
      {nextLine && (
        <p className="mt-1 text-[var(--text-secondary)]" data-testid="growth-unlock">{nextLine}</p>
      )}
      {(pct !== null || paused) && (
        <div className="mt-2" data-testid="growth-capacity">
          <div className="mb-0.5 flex justify-between text-[10px] text-[var(--text-dim)]">
            <span>{V21_COPY.ticket.capacity}</span>
            <span data-testid="growth-capacity-label">{paused ? (sideFull || (decision.quote.closed && (decision.quote.closedReason === "capacity-full" || decision.quote.closedReason === "capacity-zero")) ? V22_COPY.growth.capacityPausedFull : V22_COPY.growth.capacityPaused) : V21_COPY.ticket.capacityUsed(`${pct}%`)}</span>
          </div>
          <div
            role="progressbar"
            aria-label={`${direction} side capacity`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={paused ? 100 : (pct as number)}
            className="h-1.5 w-full overflow-hidden bg-[var(--border)]/40"
          >
            <div className="h-full" style={{ width: paused ? "100%" : `${pct}%`, background: tone }} data-testid="growth-capacity-fill" />
          </div>
        </div>
      )}
      {roomText && <p className="mt-1.5 text-[var(--text-secondary)]" data-testid="growth-room">{roomText}</p>}
      {trimText && <p className="mt-1 text-[var(--warning)]" data-testid="growth-trim-notice">{trimText}</p>}
      {feePct && <p className="mt-2 text-[var(--text-secondary)]" data-testid="growth-fee">{V21_COPY.ticket.fee(feePct)}</p>}
      <p className="mt-2 text-[10px] text-[var(--text-dim)]">{V21_COPY.ticket.closeAlways}</p>
    </section>
  );
};
