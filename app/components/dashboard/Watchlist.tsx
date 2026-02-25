"use client";

import { useMemo, useCallback } from "react";
import { LineChart, Line, ResponsiveContainer } from "recharts";
import { getMockWatchlist, type WatchlistItem } from "@/lib/mock-dashboard-data";
import Link from "next/link";

function formatCompact(val: number): string {
  if (val >= 1_000_000_000) return `$${(val / 1_000_000_000).toFixed(1)}B`;
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(1)}K`;
  return `$${val.toFixed(2)}`;
}

function formatPrice(val: number): string {
  if (val >= 1000) return `$${val.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (val >= 1) return `$${val.toFixed(2)}`;
  return `$${val.toFixed(4)}`;
}

function MiniSparkline({ data, positive }: { data: number[]; positive: boolean }) {
  const chartData = data.map((v, i) => ({ i, v }));
  return (
    <div style={{ width: 60, height: 28 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData}>
          <Line
            type="monotone"
            dataKey="v"
            stroke={positive ? "var(--long)" : "var(--short)"}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function WatchlistRow({ item }: { item: WatchlistItem }) {
  const positive = item.change24h >= 0;

  // Map market name to a slab address — in production this would come from market discovery
  // For now, link to the markets page
  return (
    <Link
      href="/markets"
      className="flex items-center gap-3 border-b border-[rgba(255,255,255,0.04)] px-4 py-2.5 transition-colors hover:bg-[rgba(255,255,255,0.02)]"
    >
      {/* Market badge */}
      <span className="w-[72px] rounded border border-[var(--accent)]/20 bg-[var(--accent)]/5 px-1.5 py-0.5 text-center text-[10px] font-bold text-[var(--accent)]">
        {item.market}
      </span>

      {/* Price */}
      <span
        className="w-[72px] text-right text-[12px] font-bold text-white"
        style={{ fontFamily: "var(--font-jetbrains-mono)" }}
      >
        {formatPrice(item.price)}
      </span>

      {/* 24h change */}
      <span
        className={`w-[52px] text-right text-[10px] font-bold ${positive ? "text-[var(--long)]" : "text-[var(--short)]"}`}
      >
        {positive ? "▲" : "▼"} {Math.abs(item.change24h).toFixed(1)}%
      </span>

      {/* Sparkline */}
      <MiniSparkline data={item.sparkline} positive={positive} />

      {/* Vol + OI */}
      <div className="flex-1 text-right">
        <p className="text-[9px] text-[var(--text-muted)]">
          Vol: {formatCompact(item.volume24h)}
        </p>
        <p className="text-[9px] text-[var(--text-dim)]">
          OI: {formatCompact(item.openInterest)}
        </p>
      </div>
    </Link>
  );
}

export function Watchlist() {
  const watchlist = useMemo(() => getMockWatchlist(), []);

  return (
    <div className="border border-[var(--border)] bg-[var(--panel-bg)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]">
          Watchlist
        </p>
        <button
          className="text-[10px] text-[var(--text-dim)] transition-colors hover:text-[var(--accent)]"
          title="Add market to watchlist"
        >
          + Add
        </button>
      </div>

      {/* Rows */}
      <div>
        {watchlist.map((item) => (
          <WatchlistRow key={item.market} item={item} />
        ))}
      </div>
    </div>
  );
}
