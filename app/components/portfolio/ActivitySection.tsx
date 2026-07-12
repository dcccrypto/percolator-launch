"use client";

import { TradeStatsPanel } from "@/components/trade/TradeStatsPanel";
import { TradeHistoryTable } from "@/components/trade/TradeHistoryTable";
import type { TraderStatsResponse } from "@/hooks/useTraderStats";
import type { MarketWithStats } from "@/hooks/useAllMarketStats";

export interface ActivitySectionProps {
  wallet: string | null;
  /** Max trade-history rows to show (default 20, loads more on demand). */
  pageSize?: number;
  traderStats: {
    stats: TraderStatsResponse | null;
    loading: boolean;
    error: string | null;
    refresh: () => void;
  };
  /** slab_address -> market stats, threaded down so TradeHistoryTable rows
   *  show the resolved market symbol instead of a truncated slab address. */
  statsMap: Map<string, MarketWithStats>;
}

/**
 * Trade history + aggregate stats banner, grouped into one component so the
 * portfolio page can lazy-load BOTH below-the-fold pieces with a single
 * `next/dynamic` wrapper (PERF PLAN #4) instead of one per component.
 *
 * TradeStatsPanel intentionally stays silent (returns `null`) when there's
 * no trade activity and no error — TradeHistoryTable is the one place that
 * surfaces a message for that combined "nothing to show" state (see its own
 * doc comment above its empty-state branch), so the two never show
 * duplicate/conflicting copy for the same underlying "indexer has no data
 * for this wallet yet" condition.
 */
export function ActivitySection({ wallet, pageSize = 20, traderStats, statsMap }: ActivitySectionProps) {
  return (
    <>
      {(traderStats.stats || traderStats.loading) && (
        <div className="mb-2">
          <TradeStatsPanel
            stats={traderStats.stats}
            loading={traderStats.loading}
            error={traderStats.error}
            onRetry={traderStats.refresh}
          />
        </div>
      )}
      <TradeHistoryTable wallet={wallet} pageSize={pageSize} statsMap={statsMap} />
    </>
  );
}
