/**
 * PERC-808: Live protocol Volume + OI bar for the dashboard
 *
 * M13/H10: previously queried the `markets_with_stats` Supabase view directly
 * — dead in the playground (D-OPS2), so this silently rendered $0/$0/0 under
 * an always-on pulsing "live" dot. Now fetches the same aggregate from
 * /api/stats, which (as of this fix) has a devnet on-chain-discovery path
 * that works with no DB dependency — see api/stats/route.ts. The "live" dot
 * is gated on that endpoint's own `live` flag (true only for a genuine
 * successful fetch, false for its zero-stats degrade) instead of being
 * hardcoded on. Polls every 30 seconds for live updates.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

interface ProtocolStats {
  volume24h: number;
  openInterest: number;
  activeMarkets: number;
  traders: number | null;
  /** true only when /api/stats served real data (not its zero-stats degrade). */
  live: boolean;
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
      const res = await fetch("/api/stats");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStats({
        volume24h: Number(data.totalVolume24h) || 0,
        openInterest: Number(data.totalOpenInterest) || 0,
        activeMarkets: Number(data.activeTotal ?? data.totalMarkets) || 0,
        traders: data.totalTraders != null ? Number(data.totalTraders) : null,
        live: data.live === true,
      });
    } catch {
      // non-fatal — keep showing stale stats, but the fetch itself failed so
      // it's no longer "live".
      setStats((prev) => (prev ? { ...prev, live: false } : prev));
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

  const isLive = stats?.live === true;

  const items = [
    {
      label: "24h Volume",
      value: loading ? null : formatUsd(stats?.volume24h ?? 0),
      live: isLive,
      color: (stats?.volume24h ?? 0) > 0 ? "text-[var(--long)]" : "text-[var(--text-secondary)]",
    },
    {
      label: "Open Interest",
      value: loading ? null : formatUsd(stats?.openInterest ?? 0),
      live: false,
      color: (stats?.openInterest ?? 0) > 0 ? "text-[var(--text)]" : "text-[var(--text-secondary)]",
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
            <span className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-secondary)]">
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
            <ShimmerSkeleton className="h-4 w-12 rounded" />
          )}
        </div>
      ))}
    </div>
  );
}
