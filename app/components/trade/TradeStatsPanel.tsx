"use client";

import { FC } from "react";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";
import { formatStatValue } from "@/lib/format";
import type { TraderStatsResponse } from "@/hooks/useTraderStats";
import {
  FEES_UNRECORDED_NOTE,
  feesPaidDisplay,
  volumeDisplay,
  volumeNote,
} from "@/lib/trade-stats-display";

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
    // totalVolume is micro-USD too: the route sums |size| x USD price (#76; it was a bare 6-dp number).
    return formatStatValue(BigInt(rawStr), "currency");
  } catch {
    return "—";
  }
}

function formatFees(rawStr: string): string {
  try {
    // totalFees is micro-USD (the indexer records `fee` in USD).
    return formatStatValue(BigInt(rawStr), "currency");
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
          className="h-full bg-[var(--long)] transition-[width] duration-500"
          style={{ width: `${longPct}%` }}
        />
        <div
          className="h-full bg-[var(--short)] transition-[width] duration-500"
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

  // "0" is not a fee, and an understated sum is not a volume — see
  // lib/trade-stats-display.ts and #2567. Derived once, after the guards
  // above make `stats` non-null, so both cells read one decision rather than
  // re-deriving it inline.
  const fees = feesPaidDisplay(stats.totalTrades, stats.feesRecorded, stats.totalFees);
  const volume = volumeDisplay(
    stats.totalTrades,
    stats.tradesMissingPrice,
    stats.totalVolume,
  );

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
            // GH#2510: when the API reports `truncated`, these numbers cover
            // only part of the wallet's history, so they must not be labelled
            // as totals. The API being honest is not enough on its own — the
            // panel is where a reader forms the belief.
            label={stats.truncated ? "Trades (partial)" : "Total Trades"}
            value={stats.totalTrades.toLocaleString()}
            sub={
              stats.truncated
                ? "partial history — showing the earliest trades only"
                : `${stats.uniqueMarkets} market${stats.uniqueMarkets !== 1 ? "s" : ""}`
            }
          />
        </div>

        {/* Volume — understated, not wrong, when a trade has no recorded
            price: those rows contribute nothing to size x price. #2567. */}
        <div className="bg-[var(--panel-bg)] p-3.5">
          <StatCell
            label="Volume Traded"
            value={
              volume.kind === "no-trades"
                ? "—"
                : volume.kind === "unknown"
                  ? "—"
                  : formatVolume(volume.atoms)
            }
            sub={volumeNote(volume)}
          />
        </div>

        {/* Fees paid — "0" here was a false statement: the fee column is 0 on
            every row because the indexer's extraction is neutered (#153), so
            the amount is unknown, not nil. #2567. */}
        <div className="bg-[var(--panel-bg)] p-3.5">
          <StatCell
            label="Fees Paid"
            value={fees.kind === "known" ? formatFees(fees.atoms) : "—"}
            sub={fees.kind === "unrecorded" ? FEES_UNRECORDED_NOTE : undefined}
            highlight={fees.kind === "known" ? "short" : undefined}
          />
        </div>

        {/* Buy / sell split: fills, not positions (closing a long is a sell, #3314) */}
        <div className="bg-[var(--panel-bg)] p-3.5">
          <StatCell
            label="Buy / Sell Split"
            value={
              <span>
                <span className="text-[var(--long)]">{stats.longTrades.toLocaleString()}</span>
                <span className="text-[var(--text-muted)] mx-1 text-[12px]">/</span>
                <span className="text-[var(--short)]">{stats.shortTrades.toLocaleString()}</span>
              </span>
            }
            sub={`${longPct}% buys`}
          />
          {longShortBar(stats.longTrades, stats.shortTrades)}
        </div>
      </div>
    </div>
  );
};
