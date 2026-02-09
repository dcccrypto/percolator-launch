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
import { ActivityFeed } from "@/components/market/ActivityFeed";
import { GlassCard } from "@/components/ui/GlassCard";
import { GlowButton } from "@/components/ui/GlowButton";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";
import { ScrollReveal } from "@/components/ui/ScrollReveal";

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
  const [searchFocused, setSearchFocused] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function load() {
      const { data } = await supabase.from("markets_with_stats").select("*");
      setSupabaseMarkets(data || []);
      setSupabaseLoading(false);
    }
    load();
  }, []);

  // Staggered row entrance
  useEffect(() => {
    if (!listRef.current || discoveryLoading) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rows = listRef.current.querySelectorAll(".market-row");
    gsap.fromTo(rows, { opacity: 0, x: -20 }, { opacity: 1, x: 0, duration: 0.4, stagger: 0.06, ease: "power3.out" });
  }, [discoveryLoading, search, sortBy]);

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
    <div className="min-h-[calc(100vh-48px)]">
      <div className="mx-auto max-w-7xl px-3 py-6 lg:px-4">
        {/* Header */}
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>Markets</h1>
            <p className="mt-1 text-sm text-[#8B95B0]">Perpetual futures for any Solana token</p>
          </div>
          <Link href="/create">
            <GlowButton>+ Launch Market</GlowButton>
          </Link>
        </div>

        {/* Search & Sort */}
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className={`relative flex-1 transition-all duration-300 ${searchFocused ? "scale-[1.01]" : ""}`}>
            <svg className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#3D4563]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              placeholder="Search token or address…"
              className={[
                "w-full rounded-xl border bg-white/[0.03] py-2.5 pl-10 pr-4 text-sm text-[#F0F4FF] placeholder-[#3D4563] backdrop-blur-sm",
                "focus:outline-none transition-all duration-300",
                searchFocused
                  ? "border-[#00FFB2]/30 shadow-[0_0_20px_rgba(0,255,178,0.08)]"
                  : "border-white/[0.06]",
              ].join(" ")}
            />
          </div>
          <div className="flex gap-1 rounded-xl border border-white/[0.06] bg-white/[0.02] p-1 backdrop-blur-sm">
            {([
              { key: "volume" as SortKey, label: "Volume" },
              { key: "oi" as SortKey, label: "OI" },
              { key: "health" as SortKey, label: "Health" },
              { key: "recent" as SortKey, label: "Recent" },
            ]).map((opt) => (
              <button
                key={opt.key}
                onClick={() => setSortBy(opt.key)}
                className={[
                  "rounded-lg px-3 py-1.5 text-[11px] font-medium transition-all duration-200",
                  sortBy === opt.key
                    ? "bg-[#00FFB2]/[0.1] text-[#00FFB2] shadow-[0_0_10px_rgba(0,255,178,0.08)]"
                    : "text-[#3D4563] hover:text-[#8B95B0]",
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
              <ShimmerSkeleton key={i} className="h-[60px]" rounded="xl" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <GlassCard glow className="p-16 text-center">
            {search ? (
              <>
                <div className="mb-4 text-4xl opacity-30">🔍</div>
                <h3 className="mb-2 text-lg font-semibold text-white">No markets found</h3>
                <p className="text-sm text-[#8B95B0]">Try a different search.</p>
              </>
            ) : (
              <>
                <div className="mb-4 text-4xl opacity-30">🚀</div>
                <h3 className="mb-2 text-lg font-semibold text-white">No markets yet</h3>
                <p className="mb-6 text-sm text-[#8B95B0]">Be the first to launch.</p>
                <Link href="/create">
                  <GlowButton>Launch First Market</GlowButton>
                </Link>
              </>
            )}
          </GlassCard>
        ) : (
          <div ref={listRef} className="overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.01] backdrop-blur-sm">
            {/* Header row */}
            <div className="grid grid-cols-8 gap-4 border-b border-white/[0.04] px-5 py-3 text-[9px] font-medium uppercase tracking-[0.15em] text-[#3D4563]">
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
                  className={[
                    "market-row grid grid-cols-8 gap-4 px-5 py-4 transition-all duration-200",
                    "hover:bg-[#00FFB2]/[0.02] hover:shadow-[inset_0_0_30px_rgba(0,255,178,0.02)]",
                    i > 0 ? "border-t border-white/[0.03]" : "",
                  ].join(" ")}
                >
                  <div className="col-span-2">
                    <div className="font-semibold text-white transition-colors group-hover:text-[#00FFB2]">
                      {m.symbol ? `${m.symbol}/USD` : shortenAddress(m.slabAddress)}
                    </div>
                    <div className="text-[11px] text-[#3D4563]">
                      {m.name ?? shortenAddress(m.onChain.config.collateralMint.toBase58())}
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="font-[var(--font-jetbrains-mono)] text-sm text-white">
                      {lastPrice != null
                        ? `$${lastPrice < 0.01 ? lastPrice.toFixed(6) : lastPrice < 1 ? lastPrice.toFixed(4) : lastPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : "—"}
                    </span>
                  </div>
                  <div className="font-[var(--font-jetbrains-mono)] text-right text-sm text-[#8B95B0]">{oiTokens}</div>
                  <div className="font-[var(--font-jetbrains-mono)] text-right text-sm text-[#8B95B0]">{capitalTokens}</div>
                  <div className="font-[var(--font-jetbrains-mono)] text-right text-sm text-[#00FFB2]">{insuranceTokens}</div>
                  <div className="text-right text-sm text-[#8B95B0]">{maxLev}×</div>
                  <div className="text-right"><HealthBadge level={health.level} /></div>
                </Link>
              );
            })}
          </div>
        )}

        {/* Activity */}
        <ScrollReveal className="mt-10">
          <h2 className="mb-5 text-xl font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>Recent Activity</h2>
          <GlassCard padding="none" hover={false}>
            <ActivityFeed />
          </GlassCard>
        </ScrollReveal>
      </div>
    </div>
  );
}
