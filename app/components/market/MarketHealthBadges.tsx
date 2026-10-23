"use client";

import type { FC } from "react";
import { Tooltip } from "@/components/ui/Tooltip";
import type { HealthBadge, HealthBadgeTone, MarketHealthRow } from "@/lib/market-health";
import { useSingleMarketHealth } from "@/hooks/useMarketHealth";
import { LIST_BADGE_IDS, marketHeaderStatus, type HeaderPriceFacts } from "@/lib/market-header-status";
import { useHeaderPriceFacts } from "@/hooks/useHeaderPriceFacts";
import { StatusLine } from "@/components/ui/StatusLine";

/**
 * v18 market-health badges ("LP depleted", "Payout haircut x%", "Resolved", …)
 * from /api/markets/health. Renders nothing while health is unknown — a
 * missing read must never look like a healthy market or a broken one.
 */
const TONE: Record<HealthBadgeTone, string> = {
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
            className={`whitespace-nowrap border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider ${TONE[b.tone]}`}
          >
            {b.label}
          </span>
        </Tooltip>
      ))}
    </span>
  );
};

/**
 * Trade-page banner: one line per danger/warning badge with its explanation.
 * Info badges ("Needs repair" / "Refreshing") are shown as chips only.
 */
export const MarketHealthBanner: FC<{ row: MarketHealthRow | null | undefined }> = ({ row }) => {
  if (!row) return null;
  const serious = row.badges.filter((b) => b.tone !== "info");
  if (serious.length === 0) return null;
  return (
    <div data-testid="market-health-banner" className="border-b border-[var(--border)] bg-[var(--bg-surface)] px-4 py-2" role="status">
      {serious.map((b) => (
        <div key={b.id} className="flex items-start gap-2 py-0.5 text-[11px] leading-snug">
          <span
            data-testid="market-health-badge"
            data-badge={b.id}
            className={`mt-px shrink-0 whitespace-nowrap border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider ${TONE[b.tone]}`}
          >
            {b.label}
          </span>
          <span className="text-[var(--text-secondary)]">{b.detail}</span>
        </div>
      ))}
    </div>
  );
};

/** Trade page: live health banner for one market (shares the hook's cache). Kept for Details. */
export const TradeMarketHealthBanner: FC<{ slab: string }> = ({ slab }) => {
  const row = useSingleMarketHealth(slab);
  return <MarketHealthBanner row={row} />;
};

/**
 * UX WP-10 (audit §4.3): the ONE header status line, only when the market is not simply live
 * (lib/market-header-status.ts). Replaces the health-banner stack and the limits strip row.
 */
export const MarketHeaderStatusView: FC<{ row: MarketHealthRow | null | undefined; price?: HeaderPriceFacts }> = ({ row, price }) => {
  const st = marketHeaderStatus(row, Date.now(), price);
  if (!st) return null;
  return (
    <div data-testid="market-header-status" className="border-b border-[var(--border)]">
      <StatusLine message={st} legacyTestId="market-health-banner" />
    </div>
  );
};

export const MarketHeaderStatus: FC<{ slab: string }> = ({ slab }) => {
  const row = useSingleMarketHealth(slab);
  const price = useHeaderPriceFacts();
  return <MarketHeaderStatusView row={row} price={price} />;
};
