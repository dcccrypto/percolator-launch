"use client";

import { usePortfolio } from "@/hooks/usePortfolio";
import { useLivePortfolioMetrics } from "@/hooks/useLivePortfolioMetrics";
import { unknownPnlCaveat } from "@/lib/position-pnl";
import { formatSignedUsd } from "@/lib/pnl-card";

/** M15: real per-market trade fee (bps → %) — not a fabricated maker/taker split. */
function formatTradeFeeBps(bps: bigint): string {
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

export function StatsBar() {
  const portfolio = usePortfolio();
  const liveMetrics = useLivePortfolioMetrics(
    portfolio.positions,
    portfolio.totalDeposited,
  );

  const loading = portfolio.loading;
  const positions = liveMetrics.openPositions;

  // Current mark-to-market aggregate from the shared price store.
  // This keeps Dashboard StatsBar aligned with PositionSummary, PnlChart,
  // DashboardHeader, PositionsBar and the trade terminal.
  const totalPnl = Number(liveMetrics.totalUnrealizedPnl) / 1e6;
  const allPnlUnknown = positions.length > 0 && liveMetrics.unknownPnlCount >= positions.length;
  // No position, or none with a known PnL: there is no total to show. A known $0.00 is a total.
  const noPnlTotal = positions.length === 0 || allPnlUnknown;

  // M15: v17 has no maker/taker fee split — "Fee Tier" used to fabricate one
  // (a hardcoded "Maker 0.02% / Taker 0.06%" that doesn't exist in the
  // protocol). Show the real per-market trade fee instead
  // (WrapperConfigV17.tradeFeeBps on v17, RiskParams.tradingFeeBps on v12,
  // both already attached to each position's `market` object) — a single
  // value when every open position shares the same fee, "Varies by market"
  // when they don't.
  const feeBpsValues = Array.from(
    new Set(
      positions
        .map((p) => p.market.configV17?.tradeFeeBps ?? p.market.params?.tradingFeeBps ?? null)
        .filter((v): v is bigint => v != null)
        .map((v) => v.toString()),
    ),
  );
  const feeTierValue =
    positions.length === 0
      ? "--"
      : feeBpsValues.length === 1
        ? formatTradeFeeBps(BigInt(feeBpsValues[0]))
        : feeBpsValues.length > 1
          ? "Varies by market"
          : "--";

  const cards = [
    {
      // GH#2677: this is the mark-to-market PnL of OPEN positions — not an
      // all-time figure (realized PnL is not tracked anywhere), so it must not
      // say "All time". A "Today's PnL" card that sat here was a hard-coded
      // "--" with no data source (no per-trader PnL history exists); it read as
      // "you made nothing today" beside live figures, so it is removed until an
      // equity-snapshot source exists (see the issue for the plan).
      label: "Unrealized PnL",
      // Unknown-PnL positions add 0 to the total: "--" when none is known, a caveat otherwise.
      value: loading ? "..." : noPnlTotal ? "--" : formatSignedUsd(totalPnl),
      sub: unknownPnlCaveat(liveMetrics.unknownPnlCount) ?? "Open positions",
      color: noPnlTotal ? "text-[var(--text-secondary)]" : totalPnl >= 0 ? "text-[var(--long)]" : "text-[var(--short)]",
    },
    {
      label: "Trade Fee",
      value: loading ? "..." : feeTierValue,
      sub: positions.length > 0 ? "Per market" : "No open positions",
      color: "text-[var(--warning)]",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2">
      {cards.map((card) => (
        <div
          key={card.label}
          className="bg-[var(--panel-bg)] p-5 transition-all duration-200 hover:bg-[var(--bg-elevated)] hover:translate-y-[-1px]"
        >
          <p className="mb-2 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-secondary)]">
            {card.label}
          </p>
          <p
            className={`text-2xl font-bold ${card.color}`}
            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
          >
            {card.value}
          </p>
          <p className="mt-0.5 text-[10px] text-[var(--text-secondary)]">{card.sub}</p>
        </div>
      ))}
    </div>
  );
}
