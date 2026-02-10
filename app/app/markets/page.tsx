"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import Link from "next/link";
import { useMarketDiscovery } from "@/hooks/useMarketDiscovery";
import { computeMarketHealth } from "@/lib/health";
import { HealthBadge } from "@/components/market/HealthBadge";
import { formatTokenAmount } from "@/lib/format";
import type { MarketWithStats } from "@/lib/supabase";
import { getSupabase } from "@/lib/supabase";
import type { DiscoveredMarket } from "@percolator/core";
import { PublicKey } from "@solana/web3.js";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";
import { ScrollReveal } from "@/components/ui/ScrollReveal";
import { GlowButton } from "@/components/ui/GlowButton";

function formatNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "\u2014";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shortenAddress(addr: string, chars = 4): string {
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

type SortKey = "volume" | "oi" | "recent" | "health";
type LeverageFilter = "all" | "5x" | "10x" | "20x";
type OracleFilter = "all" | "admin" | "live";

interface MergedMarket {
  slabAddress: string;
  mintAddress: string;
  symbol: string | null;
  name: string | null;
  maxLeverage: number;
  isAdminOracle: boolean;
  onChain: DiscoveredMarket;
  supabase: MarketWithStats | null;
}

export default function MarketsPage() {
  const { markets: discovered, loading: discoveryLoading } = useMarketDiscovery();
  const [supabaseMarkets, setSupabaseMarkets] = useState<MarketWithStats[]>([]);
  const [supabaseLoading, setSupabaseLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("volume");
  const [leverageFilter, setLeverageFilter] = useState<LeverageFilter>("all");
  const [oracleFilter, setOracleFilter] = useState<OracleFilter>("all");

  useEffect(() => {
    async function load() {
      try {
        const { data } = await getSupabase().from("markets_with_stats").select("*");
        setSupabaseMarkets(data || []);
      } catch (e) {
        console.error("[Markets] Supabase fetch failed:", e);
        setSupabaseMarkets([]);
      } finally {
        setSupabaseLoading(false);
      }
    }
    load();
  }, []);

  const merged = useMemo<MergedMarket[]>(() => {
    const sbMap = new Map<string, MarketWithStats>();
    for (const m of supabaseMarkets) sbMap.set(m.slab_address, m);
    return discovered.map((d) => {
      const addr = d.slabAddress.toBase58();
      const mint = d.config.collateralMint.toBase58();
      const sb = sbMap.get(addr) ?? null;
      const maxLev = d.params.initialMarginBps > 0n ? Math.floor(10000 / Number(d.params.initialMarginBps)) : 0;
      const isAdminOracle = d.config.indexFeedId.equals(PublicKey.default);
      return { slabAddress: addr, mintAddress: mint, symbol: sb?.symbol ?? null, name: sb?.name ?? null, maxLeverage: maxLev, isAdminOracle, onChain: d, supabase: sb };
    });
  }, [discovered, supabaseMarkets]);

  const filtered = useMemo(() => {
    let list = merged;
    // Text search — matches symbol, name, slab address, OR mint address
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((m) =>
        m.symbol?.toLowerCase().includes(q) ||
        m.name?.toLowerCase().includes(q) ||
        m.slabAddress.toLowerCase().includes(q) ||
        m.mintAddress.toLowerCase().includes(q)
      );
    }
    // Leverage filter
    if (leverageFilter !== "all") {
      const maxLev = parseInt(leverageFilter);
      list = list.filter((m) => m.maxLeverage >= maxLev);
    }
    // Oracle filter
    if (oracleFilter === "admin") {
      list = list.filter((m) => m.isAdminOracle);
    } else if (oracleFilter === "live") {
      list = list.filter((m) => !m.isAdminOracle);
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
  }, [merged, search, sortBy, leverageFilter, oracleFilter]);

  const loading = discoveryLoading || supabaseLoading;

  return (
    <div className="min-h-[calc(100vh-48px)] relative">
      {/* Grid background */}
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />

      <div className="relative mx-auto max-w-4xl px-4 py-10">
        {/* Header */}
        <ScrollReveal>
          <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
                // browse
              </div>
              <h1 className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
                <span className="font-normal text-white/50">All </span>Markets
              </h1>
              <p className="mt-2 text-[13px] text-[var(--text-secondary)]">perpetual futures, pick your poison.</p>
            </div>
            <Link href="/create">
              <GlowButton size="sm">+ launch market</GlowButton>
            </Link>
          </div>
        </ScrollReveal>

        {/* Search & Sort */}
        <ScrollReveal delay={0.1}>
          <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-dim)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="search token, address, or mint..."
                className="w-full rounded-sm border border-[var(--border)] bg-[var(--bg-elevated)] py-2.5 pl-10 pr-4 text-sm text-[var(--text)] placeholder-[var(--text-dim)] focus:border-[var(--accent)]/40 focus:outline-none"
              />
            </div>
            <div className="relative flex gap-1 rounded-sm border border-[var(--border)] bg-[var(--bg-elevated)] p-1">
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
                    "rounded-sm px-3 py-1.5 text-[11px] font-medium transition-all duration-200",
                    sortBy === opt.key
                      ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                      : "text-[var(--text-dim)] hover:text-[var(--text-secondary)]",
                  ].join(" ")}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Filters row */}
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <span className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">filter:</span>

            {/* Leverage filter */}
            <div className="flex gap-1 rounded-sm border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5">
              {([
                { key: "all" as LeverageFilter, label: "all" },
                { key: "5x" as LeverageFilter, label: "5x+" },
                { key: "10x" as LeverageFilter, label: "10x+" },
                { key: "20x" as LeverageFilter, label: "20x+" },
              ]).map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setLeverageFilter(opt.key)}
                  className={[
                    "rounded-sm px-2.5 py-1 text-[10px] font-medium transition-all duration-200",
                    leverageFilter === opt.key
                      ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                      : "text-[var(--text-dim)] hover:text-[var(--text-secondary)]",
                  ].join(" ")}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Oracle filter */}
            <div className="flex gap-1 rounded-sm border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5">
              {([
                { key: "all" as OracleFilter, label: "all oracles" },
                { key: "live" as OracleFilter, label: "live feed" },
                { key: "admin" as OracleFilter, label: "manual" },
              ]).map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setOracleFilter(opt.key)}
                  className={[
                    "rounded-sm px-2.5 py-1 text-[10px] font-medium transition-all duration-200",
                    oracleFilter === opt.key
                      ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                      : "text-[var(--text-dim)] hover:text-[var(--text-secondary)]",
                  ].join(" ")}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Active filter count */}
            {(leverageFilter !== "all" || oracleFilter !== "all" || search.trim()) && (
              <button
                onClick={() => { setLeverageFilter("all"); setOracleFilter("all"); setSearch(""); }}
                className="text-[10px] text-[var(--short)] hover:text-[var(--short)]/80 underline underline-offset-2"
              >
                clear filters
              </button>
            )}

            {/* Results count */}
            <span className="ml-auto text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>
              {filtered.length} market{filtered.length !== 1 ? "s" : ""}
            </span>
          </div>
        </ScrollReveal>

        {/* Table */}
        <ScrollReveal delay={0.2}>
          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <ShimmerSkeleton key={i} className="h-[52px]" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-16 text-center">
              {search ? (
                <>
                  <h3 className="text-base font-semibold text-white">nothing here.</h3>
                  <p className="mt-1 text-sm text-[var(--text-secondary)]">try a different search.</p>
                </>
              ) : (
                <>
                  <h3 className="text-base font-semibold text-white">no markets yet. be the main character.</h3>
                  <div className="mt-4">
                    <Link href="/create">
                      <GlowButton>launch first market</GlowButton>
                    </Link>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-sm border border-[var(--border)] hud-corners">
              {/* Header row */}
              <div className="grid min-w-[640px] grid-cols-[2fr_1fr_1fr_1fr_1fr_0.7fr_0.7fr] gap-3 border-b border-[var(--border)] bg-[var(--bg-surface)] px-4 py-2.5 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">
                <div>token</div>
                <div className="text-right">price</div>
                <div className="text-right">OI</div>
                <div className="text-right">volume</div>
                <div className="text-right hidden sm:block">insurance</div>
                <div className="text-right hidden sm:block">max lev</div>
                <div className="text-right">health</div>
              </div>

              {filtered.map((m, i) => {
                const health = computeMarketHealth(m.onChain.engine);
                const oiTokens = formatTokenAmount(m.onChain.engine.totalOpenInterest);
                const insuranceTokens = formatTokenAmount(m.onChain.engine.insuranceFund.balance);
                const lastPrice = m.supabase?.last_price;

                return (
                  <Link
                    key={m.slabAddress}
                    href={`/trade/${m.slabAddress}`}
                    className={[
                      "grid min-w-[640px] grid-cols-[2fr_1fr_1fr_1fr_1fr_0.7fr_0.7fr] gap-3 items-center px-4 py-3 transition-all duration-200 hover:bg-[var(--accent)]/[0.04] hover:border-l-2 hover:border-l-[var(--accent)]/30",
                      i > 0 ? "border-t border-[var(--border)]" : "",
                    ].join(" ")}
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-white text-sm">
                          {m.symbol ? `${m.symbol}/USD` : shortenAddress(m.slabAddress)}
                        </span>
                        {m.isAdminOracle && (
                          <span className="border border-[var(--text-dim)]/30 bg-[var(--text-dim)]/[0.08] px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-wider text-[var(--text-dim)]">manual</span>
                        )}
                      </div>
                      <div className="text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>
                        {m.name ? `${m.name} · ${shortenAddress(m.mintAddress)}` : shortenAddress(m.mintAddress)}
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-sm text-white" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                        {lastPrice != null
                          ? `$${lastPrice < 0.01 ? lastPrice.toFixed(6) : lastPrice < 1 ? lastPrice.toFixed(4) : lastPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                          : "\u2014"}
                      </span>
                    </div>
                    <div className="text-right text-sm text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>{oiTokens}</div>
                    <div className="text-right text-sm text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>{m.supabase?.volume_24h ? formatNum(m.supabase.volume_24h) : "\u2014"}</div>
                    <div className="text-right text-sm text-[var(--text)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>{insuranceTokens}</div>
                    <div className="text-right text-sm text-[var(--text-secondary)]">{m.maxLeverage}x</div>
                    <div className="text-right"><HealthBadge level={health.level} /></div>
                  </Link>
                );
              })}
            </div>
          )}
        </ScrollReveal>
      </div>
    </div>
  );
}
