/**
 * PERC-808: Live protocol Volume + OI bar for the dashboard
 *
 * Fetches aggregated 24h volume and total open interest from
 * the markets_with_stats Supabase view and displays them as
 * a compact stats strip. Polls every 30 seconds for live updates.
 */

"use client";

import { useEffect, useRef, useState } from "react";
// GH#1332: Moved OI/volume calculation to /api/stats (single source of truth)

interface ProtocolStats {
  volume24h: number;
  openInterest: number;
  activeMarkets: number;
  traders: number | null;
}

function formatUsd(val: number): string {
  if (val === 0) return "$0";
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(1)}K`;
  return `$${val.toFixed(0)}`;
}

function Pulse() {
  return (
    <span className="relative flex h-1.5 w-1.5">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--long)] opacity-60" />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--long)]" />
    </span>
  );
}

const POLL_INTERVAL_MS = 30_000;

export function ProtocolStatsBar() {
  const [stats, setStats] = useState<ProtocolStats | null>(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchStats() {
    try {
      // GH#1332: Fetch from /api/stats instead of duplicating OI/volume logic.
      // The API route has proper phantom OI guards (vault check, accounts check,
      // no $1 fallback) that the previous client-side calculation was missing,
      // causing dashboard to show $117K OI vs /api/stats $64.6K.
      const res = await fetch("/api/stats");
      if (!res.ok) throw new Error(`stats ${res.status}`);
      const data = await res.json();

      setStats({
        volume24h: data.totalVolume24h ?? 0,
        openInterest: data.totalOpenInterest ?? 0,
        activeMarkets: data.totalMarkets ?? 0,
        traders: data.totalTraders ?? null,
      });
    } catch {
      // non-fatal — keep showing stale stats
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchStats();
    timerRef.current = setInterval(fetchStats, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const items = [
    {
      label: "24h Volume",
      value: loading ? null : formatUsd(stats?.volume24h ?? 0),
      live: true,
      color: (stats?.volume24h ?? 0) > 0 ? "text-[var(--long)]" : "text-[var(--text-muted)]",
    },
    {
      label: "Open Interest",
      value: loading ? null : formatUsd(stats?.openInterest ?? 0),
      live: false,
      color: (stats?.openInterest ?? 0) > 0 ? "text-white" : "text-[var(--text-muted)]",
    },
    {
      label: "Active Markets",
      value: loading ? null : String(stats?.activeMarkets ?? 0),
      live: false,
      color: "text-[var(--accent)]",
    },
  ];

  return (
    <div className="flex items-center gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)]">
      {items.map((item) => (
        <div
          key={item.label}
          className="flex flex-1 items-center justify-between bg-[var(--panel-bg)] px-4 py-3 transition-colors hover:bg-[var(--bg-elevated)]"
        >
          <div className="flex items-center gap-1.5">
            {item.live && <Pulse />}
            <span className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]">
              {item.label}
            </span>
          </div>
          {item.value !== null ? (
            <span
              className={`text-sm font-bold tabular-nums ${item.color}`}
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            >
              {item.value}
            </span>
          ) : (
            <span className="h-4 w-12 animate-pulse rounded bg-[var(--border)]" />
          )}
        </div>
      ))}
    </div>
  );
}
