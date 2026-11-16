"use client";

import type { FC } from "react";
import { Tooltip } from "@/components/ui/Tooltip";
import type { HealthBadge, HealthBadgeTone, MarketHealthRow } from "@/lib/market-health";
import { LIST_BADGE_IDS } from "@/lib/market-header-status";

// List-card chips only. Split out of MarketHealthBadges.tsx so /markets does not pull the
// trade header's oracle-freshness / SlabProvider chain into its first-load bundle.
/**
 * v18 market-health badges ("LP depleted", "Payout haircut x%", "Resolved", …)
 * from /api/markets/health. Renders nothing while health is unknown — a
 * missing read must never look like a healthy market or a broken one.
 */
export const TONE_CLASS: Record<HealthBadgeTone, string> = {
  danger: "border-[var(--short)]/40 bg-[var(--short)]/[0.08] text-[var(--short)]",
  warning: "border-[var(--warning)]/40 bg-[var(--warning)]/[0.08] text-[var(--warning)]",
  info: "border-[var(--text-dim)]/30 bg-[var(--text-dim)]/[0.08] text-[var(--text-secondary)]",
};

/** Market cards show at most this many; the trade banner shows all. */
const COMPACT_MAX = 2;

export const MarketHealthBadges: FC<{
  row: MarketHealthRow | null | undefined;
  compact?: boolean;
  /** Hide info-tone badges (repairable / refreshing) — card lists. */
  hideInfo?: boolean;
}> = ({ row, compact = false, hideInfo = false }) => {
  if (!row) return null;
  let badges: HealthBadge[] = row.badges;
  // UX WP-10 (§4.3): lists show only the states that change what a user can do
  // (Close-only / Paused / Settled); the rest lives in the trade page's Market details.
  if (hideInfo) badges = badges.filter((b) => LIST_BADGE_IDS.has(b.id));
  if (compact) badges = badges.slice(0, COMPACT_MAX);
  if (badges.length === 0) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {badges.map((b) => (
        <Tooltip key={b.id} text={b.detail}>
          <span
            data-testid="market-health-badge"
            data-badge={b.id}
            className={`whitespace-nowrap border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider ${TONE_CLASS[b.tone]}`}
          >
            {b.label}
          </span>
        </Tooltip>
      ))}
    </span>
  );
};
