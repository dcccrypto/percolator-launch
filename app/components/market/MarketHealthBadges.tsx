"use client";

import type { FC } from "react";
import type { MarketHealthRow } from "@/lib/market-health";
import { useSingleMarketHealth } from "@/hooks/useMarketHealth";
import { marketHeaderStatus, type HeaderPriceFacts } from "@/lib/market-header-status";
import { useHeaderPriceFacts } from "@/hooks/useHeaderPriceFacts";
import { StatusLine } from "@/components/ui/StatusLine";

import { TONE_CLASS as TONE, MarketHealthBadges } from "@/components/market/MarketHealthChips";
export { MarketHealthBadges };

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
