"use client";

import { useMemo } from "react";
import { usePortfolio } from "@/hooks/usePortfolio";

function formatUsd(val: number): string {
  if (val === 0) return "--";
  const sign = val >= 0 ? "+" : "";
  return `${sign}$${Math.abs(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** M15: real per-market trade fee (bps → %) — not a fabricated maker/taker split. */
function formatTradeFeeBps(bps: bigint): string {
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

export function StatsBar() {
  const { positions, loading } = usePortfolio();

  // Calculate real stats from portfolio positions (memoized — pure over `positions`)
  const { totalPnl, wins, losses, total, winRate } = useMemo(() => {
    const totalPnlRaw = positions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0n), 0n);
    const totalPnl = Number(totalPnlRaw) / 1e6; // e6 → human
    const wins = positions.filter((p) => (p.unrealizedPnl ?? 0n) > 0n).length;
    const losses = positions.filter((p) => (p.unrealizedPnl ?? 0n) < 0n).length;
    const total = wins + losses;
    const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : "--";
    return { totalPnl, wins, losses, total, winRate };
  }, [positions]);

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
      label: "Total PnL",
      value: loading ? "..." : formatUsd(totalPnl),
      sub: "All time",
      color: totalPnl >= 0 ? "text-[var(--long)]" : "text-[var(--short)]",
    },
    {
      label: "Today's PnL",
      value: "--",
      sub: "Last 24h",
      color: "text-[var(--text-secondary)]",
    },
    {
      label: "Win Rate",
      value: loading ? "..." : `${winRate}%`,
      sub: total > 0 ? `${wins}W / ${losses}L` : "No trades yet",
      color: "text-[var(--text)]",
    },
    {
      label: "Trade Fee",
      value: loading ? "..." : feeTierValue,
      sub: positions.length > 0 ? "Per market" : "No open positions",
      color: "text-[var(--warning)]",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)] lg:grid-cols-4">
      {cards.map((card) => (
        <div
          key={card.label}
          className="bg-[var(--panel-bg)] p-5 transition-all duration-200 hover:bg-[var(--bg-elevated)] hover:translate-y-[-1px]"
        >
          <p className="mb-2 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-secondary)]">
            {card.label}
          </p>
          <p
            className={`text-lg font-bold ${card.color}`}
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
