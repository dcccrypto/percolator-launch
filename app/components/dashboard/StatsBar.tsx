"use client";

import { usePortfolio } from "@/hooks/usePortfolio";

function formatUsd(val: number): string {
  if (val === 0) return "--";
  const sign = val >= 0 ? "+" : "";
  return `${sign}$${Math.abs(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function StatsBar() {
  const { positions, loading } = usePortfolio();

  // Calculate real stats from portfolio positions
  const totalPnlRaw = positions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0n), 0n);
  const totalPnl = Number(totalPnlRaw) / 1e6; // e6 → human
  const wins = positions.filter((p) => (p.unrealizedPnl ?? 0n) > 0n).length;
  const losses = positions.filter((p) => (p.unrealizedPnl ?? 0n) < 0n).length;
  const total = wins + losses;
  const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : "--";

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
      color: "text-[var(--text-muted)]",
    },
    {
      label: "Win Rate",
      value: loading ? "..." : `${winRate}%`,
      sub: total > 0 ? `${wins}W / ${losses}L` : "No trades yet",
      color: "text-white",
    },
    {
      label: "Fee Tier",
      value: "Maker 0.02% / Taker 0.06%",
      sub: "Standard",
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
