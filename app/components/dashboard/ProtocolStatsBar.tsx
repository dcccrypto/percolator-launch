/**
 * PERC-808: Live protocol Volume + OI bar for the dashboard
 *
 * Fetches aggregated 24h volume and total open interest from
 * the markets_with_stats Supabase view and displays them as
 * a compact stats strip. Polls every 30 seconds for live updates.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { isActiveMarket } from "@/lib/activeMarketFilter";
import { isBlockedSlab } from "@/lib/blocklist";

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
const MAX_USD_PER_MARKET = 10_000_000; // $10M cap per market to filter corrupted data

export function ProtocolStatsBar() {
  const [stats, setStats] = useState<ProtocolStats | null>(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchStats() {
    try {
      const { data } = await getSupabase()
        .from("markets_with_stats")
        .select("slab_address, symbol, volume_24h, last_price, decimals, total_open_interest, open_interest_long, open_interest_short")
        .returns<{
          slab_address: string;
          symbol: string | null;
          volume_24h: number | null;
          last_price: number | null;
          decimals: number | null;
          total_open_interest: number | null;
          open_interest_long: number | null;
          open_interest_short: number | null;
        }[]>();

      if (!data || data.length === 0) {
        setStats({ volume24h: 0, openInterest: 0, activeMarkets: 0, traders: null });
        return;
      }

      const scaleFactor = (decimals: number | null) => Math.pow(10, decimals ?? 6);

      let vol24h = 0;
      let oi = 0;
      let activeCount = 0;

      for (const row of data) {
        if (!row.slab_address || isBlockedSlab(row.slab_address)) continue;

        const price = row.last_price ?? 0;
        const dec = scaleFactor(row.decimals);

        // Volume: stored in token units, convert to USD
        const rawVol = Number(row.volume_24h ?? 0);
        const volUsd = rawVol > 0 ? (rawVol / dec) * price : 0;

        // OI: stored in token units, convert to USD
        const rawOi = Number(row.total_open_interest ?? 0);
        const oiUsd = rawOi > 0 ? (rawOi / dec) * price : 0;

        // Sanity cap: skip markets with absurdly high values (corrupted data)
        const capVol = volUsd > MAX_USD_PER_MARKET ? 0 : volUsd;
        const capOi = oiUsd > MAX_USD_PER_MARKET ? 0 : oiUsd;

        if (isActiveMarket({ volume_24h: capVol, total_open_interest: capOi })) {
          activeCount++;
        }

        vol24h += capVol;
        oi += capOi;
      }

      setStats({
        volume24h: vol24h,
        openInterest: oi,
        activeMarkets: activeCount,
        traders: null, // Not available in current view
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
