"use client";

import { getMockDashboardStats } from "@/lib/mock-dashboard-data";

function formatUsd(val: number): string {
  const sign = val >= 0 ? "+" : "";
  return `${sign}$${Math.abs(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function StatsBar() {
  const stats = getMockDashboardStats();

  const cards = [
    {
      label: "Total PnL",
      value: formatUsd(stats.totalPnl),
      sub: "All time",
      color: stats.totalPnl >= 0 ? "text-[var(--long)]" : "text-[var(--short)]",
    },
    {
      label: "Today's PnL",
      value: formatUsd(stats.todayPnl),
      sub: "Last 24h",
      color: stats.todayPnl >= 0 ? "text-[var(--long)]" : "text-[var(--short)]",
    },
    {
      label: "Win Rate",
      value: `${stats.winRate}%`,
      sub: `${stats.wins}W / ${stats.losses}L`,
      color: "text-white",
    },
    {
      label: "Fee Tier",
      value: `Maker ${stats.feeTier.maker}% / Taker ${stats.feeTier.taker}%`,
      sub: `Tier ${stats.feeTier.tier} of ${stats.feeTier.maxTier}`,
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
          <p className="mb-2 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]">
            {card.label}
          </p>
          <p
            className={`text-lg font-bold ${card.color}`}
            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
          >
            {card.value}
          </p>
          <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">{card.sub}</p>
        </div>
      ))}
    </div>
  );
}
