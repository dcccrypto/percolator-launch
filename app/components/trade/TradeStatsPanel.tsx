"use client";

import { FC } from "react";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";
import { formatTokenAmount } from "@/lib/format";
import type { TraderStatsResponse } from "@/hooks/useTraderStats";

interface TradeStatsPanelProps {
  stats: TraderStatsResponse | null;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}

function StatCell({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  highlight?: "long" | "short" | "neutral";
}) {
  const valueColor =
    highlight === "long"
      ? "text-[var(--long)]"
      : highlight === "short"
        ? "text-[var(--short)]"
        : "text-[var(--text)]";

  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">
        {label}
      </p>
      <p
        className={`text-[14px] font-semibold leading-tight ${valueColor} truncate`}
        style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </p>
      {sub && (
        <p className="text-[10px] text-[var(--text-muted)] leading-tight">{sub}</p>
      )}
    </div>
  );
}

function formatVolume(rawStr: string): string {
  try {
    const raw = BigInt(rawStr);
    return formatTokenAmount(raw, 6);
  } catch {
    return "—";
  }
}

function formatFees(rawStr: string): string {
  try {
    const raw = BigInt(rawStr);
    return formatTokenAmount(raw, 6);
  } catch {
    return "—";
  }
}

function longShortBar(longTrades: number, shortTrades: number) {
  const total = longTrades + shortTrades;
  if (total === 0) return null;
  const longPct = Math.round((longTrades / total) * 100);
  const shortPct = 100 - longPct;
  return (
    <div className="mt-2 flex items-center gap-2">
      <span className="text-[10px] text-[var(--long)] font-medium w-8 text-right">{longPct}%</span>
      <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-[var(--border)] flex">
        <div
          className="h-full bg-[var(--long)] transition-all duration-500"
          style={{ width: `${longPct}%` }}
        />
        <div
          className="h-full bg-[var(--short)] transition-all duration-500"
          style={{ width: `${shortPct}%` }}
        />
      </div>
      <span className="text-[10px] text-[var(--short)] font-medium w-8">{shortPct}%</span>
    </div>
  );
}

/**
 * Compact stats banner shown above the trade history table on the portfolio page.
 * PERC-481: Trade statistics panel.
 */
export const TradeStatsPanel: FC<TradeStatsPanelProps> = ({
  stats,
  loading,
  error,
  onRetry,
}) => {
  if (loading) {
    return (
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="space-y-1.5">
              <ShimmerSkeleton className="h-2.5 w-16" />
              <ShimmerSkeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error || !stats || stats.totalTrades === 0) {
    // If no trades yet, skip rendering (table will show empty state)
    if (!error && (!stats || stats.totalTrades === 0)) return null;
    return (
      <div className="border border-[var(--border)]/40 bg-[var(--panel-bg)]/60 px-4 py-3 flex items-center justify-between">
        <p className="text-[11px] text-[var(--text-muted)]">
          {error ?? "No trading activity yet"}
        </p>
        {error && onRetry && (
          <button
            onClick={onRetry}
            className="text-[10px] text-[var(--accent)] hover:underline"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  const longPct =
    stats.totalTrades > 0
      ? ((stats.longTrades / stats.totalTrades) * 100).toFixed(0)
      : "—";

  return (
    <div className="border border-[var(--border)] bg-[var(--panel-bg)]">
      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-px bg-[var(--border)] sm:grid-cols-4">
        {/* Total trades */}
        <div className="bg-[var(--panel-bg)] p-3.5">
          <StatCell
            label="Total Trades"
            value={stats.totalTrades.toLocaleString()}
            sub={`${stats.uniqueMarkets} market${stats.uniqueMarkets !== 1 ? "s" : ""}`}
          />
        </div>

        {/* Volume */}
        <div className="bg-[var(--panel-bg)] p-3.5">
          <StatCell
            label="Volume Traded"
            value={formatVolume(stats.totalVolume)}
          />
        </div>

        {/* Fees paid */}
        <div className="bg-[var(--panel-bg)] p-3.5">
          <StatCell
            label="Fees Paid"
            value={formatFees(stats.totalFees)}
            highlight="short"
          />
        </div>

        {/* Long / short split */}
        <div className="bg-[var(--panel-bg)] p-3.5">
          <StatCell
            label="Long / Short Split"
            value={
              <span>
                <span className="text-[var(--long)]">{stats.longTrades.toLocaleString()}</span>
                <span className="text-[var(--text-muted)] mx-1 text-[12px]">/</span>
                <span className="text-[var(--short)]">{stats.shortTrades.toLocaleString()}</span>
              </span>
            }
            sub={`${longPct}% long bias`}
          />
          {longShortBar(stats.longTrades, stats.shortTrades)}
        </div>
      </div>
    </div>
  );
};
