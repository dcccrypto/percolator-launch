import { FC } from "react";
import type { HealthLevel } from "@/lib/health";
import { Tooltip } from "@/components/ui/Tooltip";

const STYLES: Record<HealthLevel, string> = {
  healthy: "bg-[var(--long)]/10 text-[var(--long)] ring-1 ring-[var(--long)]/20",
  caution: "bg-[var(--warning)]/10 text-[var(--warning)] ring-1 ring-[var(--warning)]/20",
  // UX WP-10 (GL-1, §4.3): nearly every devnet market reads "low liquidity"; it does not change
  // what a user can do, so it is neutral text, not a red danger badge.
  warning: "bg-[var(--bg-surface)] text-[var(--text-secondary)]",
  empty: "bg-[var(--bg-surface)] text-[var(--text-secondary)]",
  "needs-liquidity": "bg-[var(--bg-surface)] text-[var(--text-secondary)] ring-1 ring-[var(--warning)]/20",
  // Close-only: ADL reduce-only, or no capital on the other side (lib/market-health-overlay.ts).
  "close-only": "bg-[var(--warning)]/10 text-[var(--warning)] ring-1 ring-[var(--warning)]/20",
  // GH#1622: amber pulsing badge — oracle keeper hasn't cranked this market
  "oracle-down": "bg-[var(--warning)]/10 text-[var(--warning)] ring-1 ring-[var(--warning)]/30 animate-pulse",
};

/** The text each badge shows. Exported so the /markets HEALTH header names exactly these. */
export const HEALTH_LABELS: Record<HealthLevel, string> = {
  healthy: "Healthy",
  caution: "Caution",
  warning: "Low Liq",
  empty: "Empty",
  "oracle-down": "Awaiting price",
  "close-only": "Close-only",
  "needs-liquidity": "Needs liquidity",
};

const TOOLTIPS: Record<HealthLevel, string> = {
  healthy: "Market has sufficient insurance and liquidity to handle normal trading activity.",
  caution: "Insurance fund is getting low relative to open positions. Market still works but may struggle with large liquidations.",
  warning: "Very low liquidity. Large trades may fail or cause high slippage. Trade with caution.",
  empty: "No active positions or liquidity in this market.",
  "needs-liquidity": "No funds on the other side of new trades yet. Closing and withdrawing work; opening resumes once the market is funded.",
  "close-only": "New positions can't open on this market right now. Closing and withdrawing work.",
  // GH#1622: no price has been published yet — new positions are blocked on-chain
  "oracle-down": "Waiting for this market's first price. New positions open once it lands; closing and withdrawing still work.",
};

/**
 * Hover text for the /markets HEALTH column header. Built from HEALTH_LABELS so it can only name
 * badges the column actually renders (it used to say "Low Liquidity" / "No Oracle", which no
 * badge shows, and left out "Empty").
 */
export const HEALTH_HEADER_TOOLTIP =
  `How well the market's insurance fund and collateral cover its open interest: ` +
  `${HEALTH_LABELS.healthy}, ${HEALTH_LABELS.caution} or ${HEALTH_LABELS.warning}. ` +
  `${HEALTH_LABELS.empty} means the market has no positions or liquidity. ` +
  `${HEALTH_LABELS["oracle-down"]} means the market has no price yet. ` +
  `${HEALTH_LABELS["close-only"]} means new positions can't open right now; closing still works. ` +
  `${HEALTH_LABELS["needs-liquidity"]} means the market has no funds to take the other side yet.`;

export const HealthBadge: FC<{ level: HealthLevel }> = ({ level }) => (
  <Tooltip text={TOOLTIPS[level]}>
    <span className={`inline-block whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-bold ${STYLES[level]}${level === "caution" || level === "oracle-down" ? " animate-pulse" : ""}`}>
      {HEALTH_LABELS[level]}
    </span>
  </Tooltip>
);
