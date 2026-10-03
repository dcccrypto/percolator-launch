"use client";

import { usePortfolio } from "@/hooks/usePortfolio";
import { useLivePortfolioMetrics } from "@/hooks/useLivePortfolioMetrics";

/**
 * PnL Chart — shows real portfolio PnL.
 * Previously used getMockPnlHistory. Now shows current PnL from positions.
 * Full historical chart requires trade history indexing (future work).
 *
 * GH#2677: a 24H/7D/30D/ALL range selector used to sit in the header. It only
 * changed which button was highlighted — the figure is the CURRENT unrealized
 * PnL under every range (no per-trader PnL history exists to slice), and it
 * defaulted to "7D", a range it never represented. Removed until an
 * equity-snapshot source exists; the header states what the number is.
 */
export function PnlChart() {
  const portfolio = usePortfolio();
  const liveMetrics = useLivePortfolioMetrics(
    portfolio.positions,
    portfolio.totalDeposited,
  );

  const openPositions = liveMetrics.openPositions;
  const loading = portfolio.loading;
  const pnlFloat = Number(liveMetrics.totalUnrealizedPnl) / 1e6;
  const isPositive = pnlFloat >= 0;
  const hasData = openPositions.length > 0;

  return (
    <div className="border border-[var(--border)] bg-[var(--panel-bg)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-secondary)]">
          Portfolio PnL
        </p>
        <p className="text-[9px] font-medium text-[var(--text-secondary)]">
          Unrealized · now
        </p>
      </div>

      {/* Chart area */}
      <div className="flex h-[200px] items-center justify-center px-5">
        {loading ? (
          <p className="text-[11px] text-[var(--text-secondary)]">Loading...</p>
        ) : portfolio.error ? (
          <div className="text-center">
            <p className="text-[11px] text-[var(--text-secondary)]">Couldn't load your positions</p>
            <p className="mt-1 text-[9px] text-[var(--text-secondary)]">Please try refreshing</p>
          </div>
        ) : !hasData ? (
          <div className="text-center">
            <p className="text-[11px] text-[var(--text-secondary)]">No positions yet</p>
            <p className="mt-1 text-[9px] text-[var(--text-secondary)]">Open a trade to see your PnL</p>
          </div>
        ) : (
          <div className="text-center">
            <p className={`text-4xl font-bold tabular-nums ${isPositive ? "text-[var(--long)]" : "text-[var(--short)]"}`}
               style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
              {isPositive ? "+" : ""}${Math.abs(pnlFloat).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            <p className="mt-1 text-[9px] text-[var(--text-secondary)]">
              Across {openPositions.length} position{openPositions.length !== 1 ? "s" : ""} • Historical chart coming soon
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
