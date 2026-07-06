"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface MarketEntry {
  slab_address: string;
  symbol?: string;
  // GH#1270: Use pre-computed USD fields from /api/markets so we don't display
  // raw token micro-units (which produce "$2000.0B" instead of "$2.0K").
  // The API computes these via rawToUsd(raw, decimals, price) in the GET handler.
  volume_24h_usd?: number | null;
  total_open_interest_usd?: number | null;
}

function formatCompact(val: number): string {
  if (val >= 1_000_000_000) return `$${(val / 1_000_000_000).toFixed(1)}B`;
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(1)}K`;
  return `$${val.toFixed(2)}`;
}

export function Watchlist() {
  const [markets, setMarkets] = useState<MarketEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch("/api/markets?limit=10");
        if (resp.ok) {
          const data = await resp.json();
          setMarkets(data.markets ?? []);
        }
      } catch {
        // silently fail
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="border border-[var(--border)] bg-[var(--panel-bg)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-secondary)]">
          Markets
        </p>
        <Link href="/markets" className="text-[10px] text-[var(--text-secondary)] transition-colors hover:text-[var(--accent)]">
          View All →
        </Link>
      </div>

      <div className="max-h-[280px] overflow-y-auto">
        {loading ? (
          <div className="px-4 py-6 text-center text-[10px] text-[var(--text-secondary)]">Loading markets...</div>
        ) : markets.length === 0 ? (
          <div className="px-4 py-6 text-center text-[10px] text-[var(--text-secondary)]">No markets found</div>
        ) : (
          markets.slice(0, 10).map((m) => (
            <Link
              key={m.slab_address}
              href={`/trade/${m.slab_address}`}
              className="flex items-center gap-3 border-b border-[rgba(255,255,255,0.04)] px-4 py-2.5 transition-colors hover:bg-[rgba(255,255,255,0.02)]"
            >
              <span className="w-[90px] rounded border border-[var(--accent)]/20 bg-[var(--accent)]/5 px-1.5 py-0.5 text-center text-[10px] font-bold text-[var(--accent)] truncate">
                {m.symbol ? `${m.symbol}-PERP` : `${m.slab_address.slice(0, 6)}…`}
              </span>
              <div className="flex-1 text-right">
                <p className="text-[9px] text-[var(--text-secondary)]">
                  Vol: {m.volume_24h_usd != null && m.volume_24h_usd > 0 ? formatCompact(m.volume_24h_usd) : "--"}
                </p>
                <p className="text-[9px] text-[var(--text-secondary)]">
                  OI: {m.total_open_interest_usd != null && m.total_open_interest_usd > 0 ? formatCompact(m.total_open_interest_usd) : "--"}
                </p>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
