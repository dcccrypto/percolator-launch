"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import Link from "next/link";
import gsap from "gsap";
import { useMarketDiscovery } from "@/hooks/useMarketDiscovery";
import { computeMarketHealth } from "@/lib/health";
import { HealthBadge } from "@/components/market/HealthBadge";
import { formatTokenAmount } from "@/lib/format";
import type { MarketWithStats } from "@/lib/supabase";
import { supabase } from "@/lib/supabase";
import type { DiscoveredMarket } from "@percolator/core";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

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
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function load() {
      const { data } = await supabase.from("markets_with_stats").select("*");
      setSupabaseMarkets(data || []);
      setSupabaseLoading(false);
    }
    load();
  }, []);

  // Page fade in
  useEffect(() => {
    if (!pageRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    gsap.fromTo(pageRef.current, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power2.out" });
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
        case "volume": return (b.supabase?.volume_24h ?? 0) - (a.supabase?.volume_24h ?? 0);
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

  const loading = discoveryLoading || supabaseLoading;

  return (
    <div ref={pageRef} className="min-h-[calc(100vh-48px)] opacity-0">
      <div className="mx-auto max-w-5xl px-4 py-10">
        {/* Header */}
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>markets</h1>
            <p className="mt-1 text-sm text-[#71717a]">perpetual futures, pick your poison.</p>
          </div>
          <Link href="/create">
            <button className="rounded-[4px] bg-[#00FFB2] px-5 py-2.5 text-sm font-bold text-[#09090b] transition-opacity hover:opacity-85">
              + launch market
            </button>
          </Link>
        </div>

        {/* Search & Sort */}
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#3f3f46]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="search token or address..."
              className="w-full rounded-[4px] border border-[#1a1a1f] bg-[#111113] py-2.5 pl-10 pr-4 text-sm text-[#fafafa] placeholder-[#3f3f46] focus:border-[#3f3f46] focus:outline-none"
            />
          </div>
          <div className="flex gap-1 rounded-[4px] border border-[#1a1a1f] bg-[#111113] p-1">
            {([
              { key: "volume" as SortKey, label: "volume" },
              { key: "oi" as SortKey, label: "OI" },
              { key: "health" as SortKey, label: "health" },
              { key: "recent" as SortKey, label: "recent" },
            ]).map((opt) => (
              <button
                key={opt.key}
                onClick={() => setSortBy(opt.key)}
                className={[
                  "rounded-[4px] px-3 py-1.5 text-[11px] font-medium transition-colors",
                  sortBy === opt.key
                    ? "bg-[#1a1a1f] text-[#00FFB2]"
                    : "text-[#3f3f46] hover:text-[#71717a]",
                ].join(" ")}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <ShimmerSkeleton key={i} className="h-[52px]" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-[4px] border border-[#1a1a1f] bg-[#111113] p-16 text-center">
            {search ? (
              <>
                <h3 className="text-base font-semibold text-white">nothing here.</h3>
                <p className="mt-1 text-sm text-[#71717a]">try a different search.</p>
              </>
            ) : (
              <>
                <div className="mb-4 text-4xl">🧪</div>
                <h3 className="text-lg font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>no markets yet — be the first to create one</h3>
                <p className="mt-2 text-sm text-[#71717a]">launch a perpetual futures market for any solana token in under 60 seconds.</p>
                <div className="mt-5">
                  <Link href="/create">
                    <button className="rounded-[4px] bg-[#00FFB2] px-5 py-2.5 text-sm font-bold text-[#09090b] transition-opacity hover:opacity-85">
                      + launch first market
                    </button>
                  </Link>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="overflow-hidden rounded-[4px] border border-[#1a1a1f]">
            {/* Header row */}
            <div className="grid grid-cols-8 gap-4 border-b border-[#1a1a1f] bg-[#111113] px-4 py-3 text-[10px] font-medium uppercase tracking-[0.15em] text-[#3f3f46]">
              <div className="col-span-2">token</div>
              <div className="text-right">price</div>
              <div className="text-right">OI</div>
              <div className="text-right">volume</div>
              <div className="text-right">insurance</div>
              <div className="text-right">max lev</div>
              <div className="text-right">health</div>
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
                  className={[
                    "grid grid-cols-8 gap-4 px-4 py-3.5 transition-colors hover:bg-[#111113]",
                    i > 0 ? "border-t border-[#1a1a1f]" : "",
                  ].join(" ")}
                >
                  <div className="col-span-2">
                    <div className="font-semibold text-white text-sm">
                      {m.symbol ? `${m.symbol}/USD` : shortenAddress(m.slabAddress)}
                    </div>
                    <div className="text-[11px] text-[#3f3f46]">
                      {m.name ?? shortenAddress(m.onChain.config.collateralMint.toBase58())}
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-sm text-white" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                      {lastPrice != null
                        ? `$${lastPrice < 0.01 ? lastPrice.toFixed(6) : lastPrice < 1 ? lastPrice.toFixed(4) : lastPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : "—"}
                    </span>
                  </div>
                  <div className="text-right text-sm text-[#71717a]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>{oiTokens}</div>
                  <div className="text-right text-sm text-[#71717a]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>{capitalTokens}</div>
                  <div className="text-right text-sm text-[#00FFB2]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>{insuranceTokens}</div>
                  <div className="text-right text-sm text-[#71717a]">{maxLev}x</div>
                  <div className="text-right"><HealthBadge level={health.level} /></div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
