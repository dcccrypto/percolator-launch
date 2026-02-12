"use client";

import { useEffect, useState, useMemo, useRef, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
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

/* ─── Mock markets for local design testing ─── */
function mockEngine(oi: bigint, capital: bigint, insurance: bigint) {
  return { totalOpenInterest: oi, cTot: capital, insuranceFund: { balance: insurance } } as unknown as DiscoveredMarket["engine"];
}
function mockMarket(
  slab: string, mint: string, symbol: string, name: string,
  leverage: number, admin: boolean, price: number, vol24h: number,
  oi: bigint, capital: bigint, insurance: bigint,
): MergedMarket {
  return {
    slabAddress: slab, mintAddress: mint, symbol, name,
    maxLeverage: leverage, isAdminOracle: admin,
    onChain: { engine: mockEngine(oi, capital, insurance) } as DiscoveredMarket,
    supabase: { last_price: price, volume_24h: vol24h } as MarketWithStats,
  };
}
const MOCK_MARKETS: MergedMarket[] = [
  mockMarket("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", "So11111111111111111111111111111111111111112", "SOL", "Solana", 20, false, 148.52, 2_340_000, 85_000_000_000n, 120_000_000_000n, 15_000_000_000n),
  mockMarket("9mRGKzEEQBus4bZ1YKg4tVEMx7fPYEBV5Pz9bGJjp7Cr", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC", "USD Coin", 10, false, 1.00, 890_000, 42_000_000_000n, 80_000_000_000n, 10_000_000_000n),
  mockMarket("4nF7d2Z3oF8bTKwhat9k8xsR1TLAo9U7Bd2Rk3pYJne5", "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", "WIF", "dogwifhat", 20, false, 0.847, 1_120_000, 65_000_000_000n, 90_000_000_000n, 8_000_000_000n),
  mockMarket("B8mnfpCEt2z3SMz4giHGPNMB3DzBAJEYrPq9Uhnj4zXh", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "JUP", "Jupiter", 10, false, 0.624, 540_000, 30_000_000_000n, 55_000_000_000n, 6_000_000_000n),
  mockMarket("HN7cABqLq46Es1jh92hQnvWo6BuZPdSmTQ5P2NMeVRgr", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "BONK", "Bonk", 5, true, 0.0000182, 320_000, 18_000_000_000n, 40_000_000_000n, 5_000_000_000n),
  mockMarket("FMJ1DFWV96VKb5z8hnRp5LJaP7RPAywUbioiRvLqZafV", "RaydiumPoolxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "RAY", "Raydium", 10, false, 2.18, 410_000, 22_000_000_000n, 45_000_000_000n, 4_000_000_000n),
  mockMarket("3Kat5BEzHTZmJYBR1QnP4FCn2jJRYkSgnTMGV4cANQrM", "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE", "ORCA", "Orca", 10, false, 3.42, 180_000, 12_000_000_000n, 28_000_000_000n, 3_000_000_000n),
  mockMarket("5F2nFaJfVoR91EVBTzkg9hEb8w2jhaQD65FKmjfwUzSN", "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", "mSOL", "Marinade SOL", 15, false, 162.10, 670_000, 50_000_000_000n, 70_000_000_000n, 9_000_000_000n),
  mockMarket("ArK3jGAHqPxTEHsMgrLwRbKMzH4DS7nVPEfkjxhpb9fn", "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", "WETH", "Wrapped Ether", 20, false, 3_241.88, 1_870_000, 78_000_000_000n, 110_000_000_000n, 12_000_000_000n),
  mockMarket("2qVfA7g3bKfc7WJBb6RvTa5rJFmB8itu4C88Rdg1xN8z", "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", "PYTH", "Pyth Network", 10, true, 0.312, 95_000, 5_000_000_000n, 12_000_000_000n, 1_200_000_000n),
];

function MarketsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { markets: discovered, loading: discoveryLoading } = useMarketDiscovery();
  const [supabaseMarkets, setSupabaseMarkets] = useState<MarketWithStats[]>([]);
  const [supabaseLoading, setSupabaseLoading] = useState(true);
  
  // P-MED-2: Read filters from URL params
  const [search, setSearch] = useState(searchParams.get("q") || "");
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  const [sortBy, setSortBy] = useState<SortKey>((searchParams.get("sort") as SortKey) || "volume");
  const [leverageFilter, setLeverageFilter] = useState<LeverageFilter>((searchParams.get("lev") as LeverageFilter) || "all");
  const [oracleFilter, setOracleFilter] = useState<OracleFilter>((searchParams.get("oracle") as OracleFilter) || "all");
  
  // P-MED-3: Pagination state for infinite scroll
  const [displayCount, setDisplayCount] = useState(20);
  const observerTarget = useRef<HTMLDivElement>(null);

  // P-MED-1: Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // P-MED-2: Update URL params when filters change
  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (sortBy !== "volume") params.set("sort", sortBy);
    if (leverageFilter !== "all") params.set("lev", leverageFilter);
    if (oracleFilter !== "all") params.set("oracle", oracleFilter);
    
    const newUrl = params.toString() ? `?${params.toString()}` : "/markets";
    router.replace(newUrl, { scroll: false });
  }, [debouncedSearch, sortBy, leverageFilter, oracleFilter, router]);

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
    return discovered
      .filter((d) => {
        // Skip malformed markets with undefined PublicKey fields
        if (!d?.slabAddress || !d?.config?.collateralMint || !d?.config?.indexFeedId || !d?.params) {
          console.warn("[Markets] Skipping malformed market:", d);
          return false;
        }
        return true;
      })
      .map((d) => {
        const addr = d.slabAddress.toBase58();
        const mint = d.config.collateralMint.toBase58();
        const sb = sbMap.get(addr) ?? null;
        const maxLev = d.params.initialMarginBps > 0n ? Math.floor(10000 / Number(d.params.initialMarginBps)) : 0;
        const isAdminOracle = d.config.indexFeedId.equals(PublicKey.default);
        return { slabAddress: addr, mintAddress: mint, symbol: sb?.symbol ?? null, name: sb?.name ?? null, maxLeverage: maxLev, isAdminOracle, onChain: d, supabase: sb };
      });
  }, [discovered, supabaseMarkets]);

  // Only show mock data in development (never in production)
  const effectiveMarkets = merged.length > 0 ? merged : (process.env.NODE_ENV === "development" ? MOCK_MARKETS : []);

  const filtered = useMemo(() => {
    let list = effectiveMarkets;
    // Text search — matches symbol, name, slab address, OR mint address
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.toLowerCase();
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
        case "oi": {
          // P-CRITICAL-5: Add null coalescing before BigInt sort
          const oiA = a.onChain.engine.totalOpenInterest ?? 0n;
          const oiB = b.onChain.engine.totalOpenInterest ?? 0n;
          return oiB > oiA ? 1 : oiB < oiA ? -1 : 0;
        }
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
  }, [effectiveMarkets, debouncedSearch, sortBy, leverageFilter, oracleFilter]);

  // P-MED-3: Infinite scroll observer
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && displayCount < filtered.length) {
          setDisplayCount((prev) => Math.min(prev + 20, filtered.length));
        }
      },
      { threshold: 0.1 }
    );

    const currentTarget = observerTarget.current;
    if (currentTarget) {
      observer.observe(currentTarget);
    }

    return () => {
      if (currentTarget) {
        observer.unobserve(currentTarget);
      }
    };
  }, [displayCount, filtered.length]);

  // Reset display count when filters change
  useEffect(() => {
    setDisplayCount(20);
  }, [debouncedSearch, leverageFilter, oracleFilter, sortBy]);

  const displayedMarkets = filtered.slice(0, displayCount);
  const loading = discoveryLoading || supabaseLoading;

  // P-MED-4: Separate clear functions
  const clearFilters = () => {
    setLeverageFilter("all");
    setOracleFilter("all");
  };

  const clearSearch = () => {
    setSearch("");
  };

  const hasActiveFilters = leverageFilter !== "all" || oracleFilter !== "all";
  const hasSearch = search.trim() !== "";

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
              {hasSearch && (
                <button
                  onClick={clearSearch}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-dim)] hover:text-[var(--text-secondary)]"
                  title="Clear search"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
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

            {/* P-MED-4: Separate clear buttons */}
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
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
              {hasSearch || hasActiveFilters ? (
                <>
                  <h3 className="text-base font-semibold text-white">nothing here.</h3>
                  <p className="mt-1 text-sm text-[var(--text-secondary)]">try a different search or filter.</p>
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
            <>
              <div className="relative rounded-sm border border-[var(--border)] hud-corners overflow-x-clip">
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

                {displayedMarkets.map((m, i) => {
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
              
              {/* P-MED-3: Infinite scroll trigger */}
              {displayCount < filtered.length && (
                <div ref={observerTarget} className="py-4 text-center">
                  <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
                </div>
              )}
            </>
          )}
        </ScrollReveal>
      </div>
    </div>
  );
}

export default function MarketsPage() {
  return (
    <Suspense fallback={
      <div className="min-h-[calc(100vh-48px)] flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
      </div>
    }>
      <MarketsPageInner />
    </Suspense>
  );
}
