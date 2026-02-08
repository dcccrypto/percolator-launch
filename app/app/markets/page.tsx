"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { useMarketDiscovery } from "@/hooks/useMarketDiscovery";
import { computeMarketHealth } from "@/lib/health";
import { HealthBadge } from "@/components/market/HealthBadge";
import { formatTokenAmount } from "@/lib/format";
import type { MarketWithStats } from "@/lib/supabase";
import { supabase } from "@/lib/supabase";
import type { DiscoveredMarket } from "@percolator/core";
import { ActivityFeed } from "@/components/market/ActivityFeed";

function formatNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shortenAddress(addr: string, chars = 4): string {
  return `${addr.slice(0, chars)}…${addr.slice(-chars)}`;
}

type SortKey = "volume" | "oi" | "recent" | "health";

interface MergedMarket {
  slabAddress: string;
  symbol: string | null;
  name: string | null;
  onChain: DiscoveredMarket;
  supabase: MarketWithStats | null;
}

export default function MarketsPage() {
  const { markets: discovered, loading: discoveryLoading } = useMarketDiscovery();
  const [supabaseMarkets, setSupabaseMarkets] = useState<MarketWithStats[]>([]);
  const [supabaseLoading, setSupabaseLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("volume");

  useEffect(() => {
    async function load() {
      const { data } = await supabase.from("markets_with_stats").select("*");
      setSupabaseMarkets(data || []);
      setSupabaseLoading(false);
    }
    load();
  }, []);

  const merged = useMemo<MergedMarket[]>(() => {
    const sbMap = new Map<string, MarketWithStats>();
    for (const m of supabaseMarkets) sbMap.set(m.slab_address, m);
    return discovered.map((d) => {
      const addr = d.slabAddress.toBase58();
      const sb = sbMap.get(addr) ?? null;
      return { slabAddress: addr, symbol: sb?.symbol ?? null, name: sb?.name ?? null, onChain: d, supabase: sb };
    });
  }, [discovered, supabaseMarkets]);

  const filtered = useMemo(() => {
    let list = merged;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((m) =>
        m.symbol?.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q) || m.slabAddress.toLowerCase().includes(q)
      );
    }
    list = [...list].sort((a, b) => {
      switch (sortBy) {
        case "volume": return (b.supabase?.volume_total ?? 0) - (a.supabase?.volume_total ?? 0);
        case "oi": return Number(b.onChain.engine.totalOpenInterest - a.onChain.engine.totalOpenInterest);
        case "health": {
          const ha = computeMarketHealth(a.onChain.engine);
          const hb = computeMarketHealth(b.onChain.engine);
          const order: Record<string, number> = { healthy: 0, caution: 1, warning: 2, empty: 3 };
          return (order[ha.level] ?? 5) - (order[hb.level] ?? 5);
        }
        default: return 0;
      }
    });
    return list;
  }, [merged, search, sortBy]);

  const loading = discoveryLoading && supabaseLoading;

  return (
    <div className="terminal-grid min-h-[calc(100vh-48px)]">
      <div className="mx-auto max-w-[1800px] px-3 py-6 lg:px-4">
        {/* Header */}
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Markets</h1>
            <p className="mt-0.5 text-sm text-[#4a5068]">Perpetual futures for any Solana token</p>
          </div>
          <Link
            href="/launch"
            className="rounded-lg bg-[#00d4aa] px-5 py-2 text-center text-sm font-bold text-[#080a0f] transition-all hover:bg-[#00e8bb] hover:shadow-[0_0_20px_rgba(0,212,170,0.15)]"
          >
            + Launch Market
          </Link>
        </div>

        {/* Search & Sort */}
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <svg className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#2a2f40]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search token or address…"
              className="w-full rounded-lg border border-[#1a1d2a] bg-[#0c0e14] py-2 pl-9 pr-4 text-sm text-[#e8eaf0] placeholder-[#2a2f40] focus:border-[#00d4aa]/40 focus:outline-none focus:ring-1 focus:ring-[#00d4aa]/20"
            />
          </div>
          <div className="flex gap-1 rounded-lg bg-[#0c0e14] p-0.5 ring-1 ring-[#1a1d2a]">
            {([
              { key: "volume" as SortKey, label: "Volume" },
              { key: "oi" as SortKey, label: "OI" },
              { key: "health" as SortKey, label: "Health" },
              { key: "recent" as SortKey, label: "Recent" },
            ]).map((opt) => (
              <button
                key={opt.key}
                onClick={() => setSortBy(opt.key)}
                className={`rounded-md px-3 py-1.5 text-[11px] font-medium transition-all ${
                  sortBy === opt.key
                    ? "bg-[#1a1d2a] text-white"
                    : "text-[#4a5068] hover:text-[#7a8194]"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        {loading ? (
          <div className="space-y-1">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-[56px] animate-pulse rounded-lg bg-[#0c0e14] ring-1 ring-[#1a1d2a]" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl bg-[#0c0e14] p-16 text-center ring-1 ring-[#1a1d2a]">
            {search ? (
              <>
                <div className="mb-3 text-3xl text-[#1a1d2a]">🔍</div>
                <h3 className="mb-1 text-lg font-semibold text-white">No markets found</h3>
                <p className="text-sm text-[#4a5068]">Try a different search.</p>
              </>
            ) : (
              <>
                <div className="mb-3 text-3xl text-[#1a1d2a]">🚀</div>
                <h3 className="mb-1 text-lg font-semibold text-white">No markets yet</h3>
                <p className="mb-4 text-sm text-[#4a5068]">Be the first.</p>
                <Link href="/launch" className="inline-block rounded-lg bg-[#00d4aa] px-6 py-2.5 text-sm font-bold text-[#080a0f]">
                  Launch First Market
                </Link>
              </>
            )}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg ring-1 ring-[#1a1d2a]">
            {/* Header row */}
            <div className="grid grid-cols-8 gap-4 bg-[#080a0f] px-4 py-2.5 text-[9px] font-medium uppercase tracking-wider text-[#2a2f40]">
              <div className="col-span-2">Market</div>
              <div className="text-right">Price</div>
              <div className="text-right">Open Interest</div>
              <div className="text-right">Capital</div>
              <div className="text-right">Insurance</div>
              <div className="text-right">Max Lev</div>
              <div className="text-right">Health</div>
            </div>

            {filtered.map((m, i) => {
              const health = computeMarketHealth(m.onChain.engine);
              const maxLev = m.onChain.params.initialMarginBps > 0n
                ? Math.floor(10000 / Number(m.onChain.params.initialMarginBps)) : 0;
              const oiTokens = formatTokenAmount(m.onChain.engine.totalOpenInterest);
              const capitalTokens = formatTokenAmount(m.onChain.engine.cTot);
              const insuranceTokens = formatTokenAmount(m.onChain.engine.insuranceFund.balance);
              const lastPrice = m.supabase?.last_price;

              return (
                <Link
                  key={m.slabAddress}
                  href={`/trade/${m.slabAddress}`}
                  className={`grid grid-cols-8 gap-4 px-4 py-3 transition-all hover:bg-[#131620] ${
                    i > 0 ? "border-t border-[#1a1d2a]/50" : ""
                  } bg-[#0c0e14]`}
                >
                  <div className="col-span-2">
                    <div className="font-semibold text-white">
                      {m.symbol ? `${m.symbol}/USD` : shortenAddress(m.slabAddress)}
                    </div>
                    <div className="text-[11px] text-[#2a2f40]">
                      {m.name ?? shortenAddress(m.onChain.config.collateralMint.toBase58())}
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="data-cell text-sm text-white">
                      {lastPrice != null
                        ? `$${lastPrice < 0.01 ? lastPrice.toFixed(6) : lastPrice < 1 ? lastPrice.toFixed(4) : lastPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : "—"}
                    </span>
                  </div>
                  <div className="data-cell text-right text-sm text-[#7a8194]">{oiTokens}</div>
                  <div className="data-cell text-right text-sm text-[#7a8194]">{capitalTokens}</div>
                  <div className="data-cell text-right text-sm text-[#00d4aa]">{insuranceTokens}</div>
                  <div className="text-right text-sm text-[#7a8194]">{maxLev}×</div>
                  <div className="text-right"><HealthBadge level={health.level} /></div>
                </Link>
              );
            })}
          </div>
        )}

        {/* Activity */}
        <div className="mt-8">
          <h2 className="mb-4 text-lg font-bold text-white">Recent Activity</h2>
          <ActivityFeed />
        </div>
      </div>
    </div>
  );
}
