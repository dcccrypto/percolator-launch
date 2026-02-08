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
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
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
    for (const m of supabaseMarkets) {
      sbMap.set(m.slab_address, m);
    }
    return discovered.map((d) => {
      const addr = d.slabAddress.toBase58();
      const sb = sbMap.get(addr) ?? null;
      return {
        slabAddress: addr,
        symbol: sb?.symbol ?? null,
        name: sb?.name ?? null,
        onChain: d,
        supabase: sb,
      };
    });
  }, [discovered, supabaseMarkets]);

  const filtered = useMemo(() => {
    let list = merged;

    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (m) =>
          (m.symbol?.toLowerCase().includes(q)) ||
          (m.name?.toLowerCase().includes(q)) ||
          m.slabAddress.toLowerCase().includes(q)
      );
    }

    // Sort
    list = [...list].sort((a, b) => {
      switch (sortBy) {
        case "volume":
          return (b.supabase?.volume_total ?? 0) - (a.supabase?.volume_total ?? 0);
        case "oi":
          return Number(b.onChain.engine.totalOpenInterest - a.onChain.engine.totalOpenInterest);
        case "health": {
          const ha = computeMarketHealth(a.onChain.engine);
          const hb = computeMarketHealth(b.onChain.engine);
          const order: Record<string, number> = { healthy: 0, caution: 1, warning: 2, empty: 3 };
          return (order[ha.level] ?? 5) - (order[hb.level] ?? 5);
        }
        case "recent":
        default:
          return 0; // keep discovery order (most recent first usually)
      }
    });

    return list;
  }, [merged, search, sortBy]);

  const loading = discoveryLoading && supabaseLoading;

  return (
    <div className="mx-auto max-w-7xl px-4 py-12">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Markets</h1>
          <p className="mt-1 text-slate-400">Perpetual futures for any Solana token</p>
        </div>
        <Link
          href="/launch"
          className="rounded-xl bg-emerald-500 px-6 py-2.5 text-center font-semibold text-white transition-all duration-150 hover:bg-emerald-400 hover:shadow-lg hover:shadow-emerald-500/20 focus-visible:ring-2 focus-visible:ring-emerald-500"
        >
          + Launch Market
        </Link>
      </div>

      {/* Search & Sort */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#52525b]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by token name or address..."
            className="w-full rounded-lg border border-[#1e2433] bg-[#111318] py-2.5 pl-10 pr-4 text-sm text-[#e4e4e7] placeholder-[#52525b] transition-colors focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          />
        </div>
        <div className="flex gap-1.5">
          {(
            [
              { key: "volume" as SortKey, label: "Volume" },
              { key: "oi" as SortKey, label: "OI" },
              { key: "health" as SortKey, label: "Health" },
              { key: "recent" as SortKey, label: "Recent" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.key}
              onClick={() => setSortBy(opt.key)}
              className={`rounded-lg px-3 py-2 text-xs font-medium transition-all duration-150 ${
                sortBy === opt.key
                  ? "bg-blue-600 text-white shadow-sm shadow-blue-600/20"
                  : "bg-[#111318] text-[#71717a] hover:bg-[#1a1d24] hover:text-[#a1a1aa]"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-[72px] animate-pulse rounded-xl border border-[#1e2433] bg-[#111318]" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-[#1e2433] bg-[#111318] p-16 text-center">
          {search ? (
            <>
              <div className="mb-4 text-5xl">🔍</div>
              <h3 className="mb-2 text-xl font-semibold text-white">No markets found</h3>
              <p className="text-slate-400">Try a different search term.</p>
            </>
          ) : (
            <>
              <div className="mb-4 text-5xl">🚀</div>
              <h3 className="mb-2 text-xl font-semibold text-white">No markets yet</h3>
              <p className="mb-6 text-slate-400">Be the first to launch a perpetual futures market.</p>
              <Link
                href="/launch"
                className="inline-block rounded-xl bg-emerald-500 px-8 py-3 font-semibold text-white hover:bg-emerald-400"
              >
                Launch First Market
              </Link>
            </>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[#1e2433]">
          {/* Header */}
          <div className="grid grid-cols-8 gap-4 border-b border-[#1e2433] bg-[#0a0b0f] px-6 py-3 text-xs font-medium uppercase tracking-wider text-slate-500">
            <div className="col-span-2">Market</div>
            <div className="text-right">Price</div>
            <div className="text-right">Open Interest</div>
            <div className="text-right">Capital</div>
            <div className="text-right">Insurance</div>
            <div className="text-right">Leverage</div>
            <div className="text-right">Health</div>
          </div>

          {/* Rows */}
          {filtered.map((m) => {
            const health = computeMarketHealth(m.onChain.engine);
            const maxLev = m.onChain.params.initialMarginBps > 0n
              ? Math.floor(10000 / Number(m.onChain.params.initialMarginBps))
              : 0;
            const oiTokens = formatTokenAmount(m.onChain.engine.totalOpenInterest);
            const capitalTokens = formatTokenAmount(m.onChain.engine.cTot);
            const insuranceTokens = formatTokenAmount(m.onChain.engine.insuranceFund.balance);
            const lastPrice = m.supabase?.last_price;

            return (
              <Link
                key={m.slabAddress}
                href={`/trade/${m.slabAddress}`}
                className="grid grid-cols-8 gap-4 border-b border-[#1e2433] bg-[#111318] px-6 py-4 transition-all duration-150 hover:bg-[#1a1d24] hover:shadow-sm"
              >
                <div className="col-span-2">
                  <div className="font-semibold text-white">
                    {m.symbol ? `${m.symbol}/USD` : shortenAddress(m.slabAddress)}
                  </div>
                  <div className="text-xs text-slate-500">
                    {m.name ?? shortenAddress(m.onChain.config.collateralMint.toBase58())}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-white">
                    {lastPrice != null ? `$${lastPrice < 0.01 ? lastPrice.toFixed(6) : lastPrice < 1 ? lastPrice.toFixed(4) : lastPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-slate-300">{oiTokens}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-slate-300">{capitalTokens}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-emerald-400">{insuranceTokens}</div>
                </div>
                <div className="text-right">
                  <div className="text-slate-300">{maxLev}x</div>
                </div>
                <div className="text-right">
                  <HealthBadge level={health.level} />
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {/* Recent Activity */}
      <div className="mt-12">
        <h2 className="mb-4 text-xl font-bold text-white">Recent Activity</h2>
        <ActivityFeed />
      </div>
    </div>
  );
}
