"use client";

import { useEffect, useState, useMemo, useRef, Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMarketDiscovery } from "@/hooks/useMarketDiscovery";
import { computeMarketHealth, computeMarketHealthFromStats, sanitizeOnChainValue, isSentinelValue } from "@/lib/health";
import { HealthBadge } from "@/components/market/HealthBadge";
import { formatTokenAmount } from "@/lib/format";
import { getSupabase } from "@/lib/supabase";
import { isSaneMarketValue, isZombieMarket } from "@/lib/activeMarketFilter";
import { BLOCKED_SLAB_ADDRESSES } from "@/lib/blocklist";
import type { Database } from "@/lib/database.types";

type MarketWithStats = Database['public']['Views']['markets_with_stats']['Row'];
import type { DiscoveredMarket } from "@percolator/sdk";
import { PublicKey } from "@solana/web3.js";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";
import { ScrollReveal } from "@/components/ui/ScrollReveal";
import { GlowButton } from "@/components/ui/GlowButton";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import { useAllMarketStats } from "@/hooks/useAllMarketStats";
import { MarketLogo } from "@/components/market/MarketLogo";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { detectOracleMode, resolveMarketPriceE6, priceE6ToUsd } from "@/lib/oraclePrice";
import { formatStatValue } from "@/lib/format";
import { MIN_VAULT_FOR_OI } from "@/lib/phantom-oi";

/** Max sane price (USD) for both active-market filtering and display capping.
 *  Mirrors /api/stats sanitizePrice() cap. Corrupt oracle prices (e.g. $7.9T)
 *  exceed this and are nulled/excluded. */
const MAX_SANE_PRICE_USD = 1_000_000;

/** GH#1483: Upper bound for UI leverage display. The Solana program enforces margin
 *  requirements at execution time, so this is display-only protection against corrupt
 *  DB values (keeper bug, row injection, data corruption). 200x is well above any
 *  legitimate max leverage on Percolator devnet (current max: 20x). */
const MAX_DISPLAY_LEVERAGE = 200;

function formatNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "\u2014";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shortenAddress(addr: string, chars = 4): string {
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

/** Returns true if a numeric value looks like a u64::MAX sentinel (≈1.844e19). */
const isSentinelNum = (v: number) => v > 1e18;

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
  onChain: DiscoveredMarket | null;  // null for Supabase-only markets not yet discovered on-chain
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

// Note: This is a client component, so we set metadata via document.title
// For static metadata export, we'd need a separate server component wrapper

function MarketsPageInner() {
  useEffect(() => { 
    document.title = "Markets — Percolator"; 
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) {
      metaDesc.setAttribute("content", "Browse and trade perpetual futures markets on Solana. Fully on-chain, permissionless.");
    }
  }, []);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { markets: discovered, loading: discoveryLoading, error: discoveryError } = useMarketDiscovery();
  const { statsMap, loading: statsLoading, error: statsError } = useAllMarketStats();

  const loadErrorMessage = useMemo(() => {
    const parts = [discoveryError, statsError].filter(Boolean) as string[];
    return parts.length ? parts.join(" · ") : null;
  }, [discoveryError, statsError]);

  // NOTE: totalActiveMarkets (Supabase-only count) removed — was inconsistent with
  // activeMarkets.length which includes on-chain discovered markets (#847).
  // Use activeMarkets.length as single source of truth for header + footer counts.
  
  // P-MED-2: Read filters from URL params
  const [search, setSearch] = useState(searchParams.get("q") || "");
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  const [sortBy, setSortBy] = useState<SortKey>((searchParams.get("sort") as SortKey) || "volume");
  const [leverageFilter, setLeverageFilter] = useState<LeverageFilter>((searchParams.get("lev") as LeverageFilter) || "all");
  const [oracleFilter, setOracleFilter] = useState<OracleFilter>((searchParams.get("oracle") as OracleFilter) || "all");
  const [showUsd, setShowUsd] = useState<boolean>(searchParams.get("usd") === "true");
  
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
    if (showUsd) params.set("usd", "true");
    
    const newUrl = params.toString() ? `?${params.toString()}` : "/markets";
    router.replace(newUrl, { scroll: false });
  }, [debouncedSearch, sortBy, leverageFilter, oracleFilter, showUsd, router]);

  const merged = useMemo<MergedMarket[]>(() => {
    const result: MergedMarket[] = [];
    const seenSlabs = new Set<string>();

    // 1. On-chain discovered markets (enriched with Supabase stats)
    for (const d of discovered) {
      if (!d?.slabAddress || !d?.config?.collateralMint || !d?.config?.indexFeedId || !d?.params) {
        console.warn("[Markets] Skipping malformed market:", d);
        continue;
      }
      const addr = d.slabAddress.toBase58();
      // GH#1106: deduplicate — same slab can appear from multiple program scans
      if (seenSlabs.has(addr)) continue;
      const mint = d.config.collateralMint.toBase58();
      // GH#1480: Prefer Supabase max_leverage (indexed by keeper, always correct) over
      // on-chain initialMarginBps computation. The on-chain bps → leverage conversion can
      // give 0 when initialMarginBps is misread (e.g. layout mismatch on V1D slabs reads
      // warmup_period_slots instead). Supabase is set at market creation and updated by
      // the indexer, matching what /api/markets returns. Fall back to bps derivation only
      // when no Supabase record exists (new market not yet indexed).
      const stats = statsMap.get(addr) || null;
      const onChainMaxLev = d.params.initialMarginBps > 0n ? Math.floor(10000 / Number(d.params.initialMarginBps)) : 0;
      const supabaseLev = Number(stats?.max_leverage ?? 0);
      const rawLev = (supabaseLev > 0) ? supabaseLev : (onChainMaxLev > 0 ? onChainMaxLev : 10);
      const maxLev = Math.min(MAX_DISPLAY_LEVERAGE, rawLev);
      const oracleMode = detectOracleMode(d.config);
      const isAdminOracle = oracleMode === "hyperp" || oracleMode === "admin";
      seenSlabs.add(addr);
      result.push({ slabAddress: addr, mintAddress: mint, symbol: null, name: null, maxLeverage: maxLev, isAdminOracle, onChain: d, supabase: stats });
    }

    // 2. Supabase-only markets (not discovered on-chain — e.g., different tier, RPC limits)
    for (const [slabAddr, stats] of statsMap) {
      if (seenSlabs.has(slabAddr)) continue;
      // Use Supabase fields for display
      const mint = stats.mint_address ?? "";
      const maxLev = Math.min(MAX_DISPLAY_LEVERAGE, Number(stats.max_leverage) || 10);
      // Without on-chain data, we can't detect oracle mode — use Supabase oracle_authority hint
      const isAdminOracle = stats.oracle_authority != null && stats.oracle_authority !== "";
      result.push({
        slabAddress: slabAddr,
        mintAddress: mint,
        symbol: null,
        name: null,
        maxLeverage: maxLev,
        isAdminOracle,
        onChain: null,
        supabase: stats,
      });
    }

    return result;
  }, [discovered, statsMap]);

  // Only show mock data in development (never in production)
  const effectiveMarkets = merged.length > 0 ? merged : (process.env.NODE_ENV === "development" ? MOCK_MARKETS : []);

  // Fetch on-chain token metadata for ALL markets (no Supabase)
  const allMints = useMemo(() => {
    return effectiveMarkets
      .filter(m => m.mintAddress && m.mintAddress.length >= 32)
      .map(m => {
        try { return new PublicKey(m.mintAddress); } catch { return null; }
      })
      .filter((pk): pk is PublicKey => pk !== null);
  }, [effectiveMarkets]);
  const tokenMetaMap = useMultiTokenMeta(allMints);

  // GH#1531: Filter out zombie markets only — show ALL non-zombie markets in the list
  // and counter. Previously we also gated on isActiveMarket() (price/volume/OI present),
  // which meant markets with no price yet were hidden from the list but still indexed
  // as valid non-zombie markets in /api/markets (total=168). Counter showed 115
  // (activeTotal) but API total was 168, confusing users.
  //
  // Fix: keep the zombie exclusion logic intact (mirrors isZombieMarket() in the API),
  // but drop the isActiveMarket() gate for non-zombie markets. All 168 non-zombie
  // markets are shown; markets with no price display "—" in the price column.
  // On-chain-only markets (no Supabase row) are still excluded to match /api/markets.
  //
  // GH#1536: Previous inline zombie check had three bugs vs the API:
  //   1. Missing Number() coercion for Supabase NUMERIC columns (returned as strings).
  //      `vault_balance === 0` compares "0" (string) to 0 (number) → always false →
  //      zombie markets slip through. This caused UI=171 vs API=168 (3 zombie markets
  //      with vault_balance="0" not being excluded). GH#1494 pattern.
  //   2. total_open_interest included in hasNoStats, violating GH#1502 fix (OI without
  //      accounts is phantom → don't count as activity → always treat as hasNoStats=true
  //      for vault=null markets). isZombieMarket() already implements the correct logic.
  //   3. Duplicate of shared isZombieMarket() logic, creating drift risk.
  // Fix: use isZombieMarket() from activeMarketFilter.ts with explicit Number() coercion.
  const activeMarkets = useMemo(() => {
    // GH#1536: Coerce NUMERIC (string from Supabase) → number | null before
    // isZombieMarket(). TypeScript's `as number | null` is compile-time only.
    const numericOrNull = (v: unknown): number | null => {
      if (v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    // GH#1536: Use sanitizedPrice for zombie check (mirrors /api/markets GH#1506 fix).
    // Raw DB prices > $1M are stale garbage; sanitizePrice nulls them for output but
    // passing raw to isZombieMarket() can make hasActivity=true → not zombie (wrong).
    const sanitizePrice = (v: unknown): number | null => {
      const n = numericOrNull(v);
      if (n == null || n <= 0 || n > MAX_SANE_PRICE_USD) return null;
      return n;
    };
    return effectiveMarkets.filter((m) => {
      // GH#1539: Exclude blocked markets — mirrors /api/markets BLOCKED_MARKET_ADDRESSES filter.
      // Without this, blocked slab addresses (from lib/blocklist.ts) appear in the UI count
      // but not the API total, causing a 2-market discrepancy (170 vs 168).
      if (BLOCKED_SLAB_ADDRESSES.has(m.slabAddress)) return false;

      // GH#1531: Show all non-zombie Supabase markets — counter matches /api/markets total.
      if (m.supabase) {
        const zombie = isZombieMarket({
          vault_balance: numericOrNull(m.supabase.vault_balance),
          c_tot: numericOrNull(m.supabase.c_tot),
          last_price: sanitizePrice(m.supabase.last_price),
          volume_24h: numericOrNull(m.supabase.volume_24h),
          total_open_interest: numericOrNull(m.supabase.total_open_interest),
          total_accounts: numericOrNull(m.supabase.total_accounts),
        });
        return !zombie;
      }

      // GH#1346: On-chain-only markets (no Supabase stats) are NOT shown —
      // /api/markets only sees Supabase data, so including them inflates the count.
      return false;
    });
  }, [effectiveMarkets]);

  // Cap bogus prices: if a resolved price is above $1M per unit it's almost certainly
  // a display error from corrupted on-chain data. We clamp in the display layer.
  // MAX_SANE_PRICE_USD is defined at module level (shared with active-market filtering).

  const filtered = useMemo(() => {
    let list = activeMarkets;
    // Text search — matches on-chain symbol, name, slab address, mint address,
    // OR Supabase market name/symbol (e.g. "BTC-PERP-1", "BTC") — fixes #1132
    // Fix #1146: address fields (slab/mint) are only searched when query is ≥8 chars
    // to prevent short token queries (e.g. "btc") from matching random substrings
    // inside base58 addresses (e.g. slab HC4...1HbTCu9wK contains "btc" lowercased).
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.toLowerCase();
      const isAddressSearch = q.length >= 8;
      list = list.filter((m) => {
        const onChainMeta = tokenMetaMap.get(m.mintAddress);
        return onChainMeta?.symbol?.toLowerCase().includes(q) ||
          onChainMeta?.name?.toLowerCase().includes(q) ||
          m.supabase?.name?.toLowerCase().includes(q) ||
          m.supabase?.symbol?.toLowerCase().includes(q) ||
          (isAddressSearch && m.slabAddress.toLowerCase().includes(q)) ||
          (isAddressSearch && m.mintAddress.toLowerCase().includes(q));
      });
    }
    // Leverage filter — exclude markets with invalid leverage (0, NaN, Infinity)
    // when a filter is active (credit: PhotizoAi #228 for the isFinite guard idea)
    if (leverageFilter !== "all") {
      const minLev = parseInt(leverageFilter);
      list = list.filter((m) => Number.isFinite(m.maxLeverage) && m.maxLeverage >= minLev);
    }
    // Oracle filter
    if (oracleFilter === "admin") {
      list = list.filter((m) => m.isAdminOracle);
    } else if (oracleFilter === "live") {
      list = list.filter((m) => !m.isAdminOracle);
    }
    // Helper to get OI (prefer on-chain, fall back to Supabase)
    // Sanitizes sentinel values (u64::MAX) to 0
    const getOI = (m: MergedMarket): bigint => {
      if (m.onChain) return sanitizeOnChainValue(m.onChain.engine.totalOpenInterest ?? 0n);
      const supaOI = m.supabase?.total_open_interest
        ?? ((m.supabase?.open_interest_long ?? 0) + (m.supabase?.open_interest_short ?? 0));
      return BigInt(isSentinelNum(supaOI) ? 0 : Math.max(0, supaOI));
    };
    // USD-aware OI sort key: converts raw token OI → USD using market price.
    // Markets with no valid price return 0 so they sort to the bottom in USD mode.
    // Fixes #1327: no-price markets with huge raw token OI were floating above real USD markets.
    const getOIUsdSortKey = (m: MergedMarket): number => {
      const onChainPriceE6 = m.onChain ? resolveMarketPriceE6(m.onChain.config) : 0n;
      const rawPrice = m.supabase?.last_price ?? priceE6ToUsd(onChainPriceE6);
      const price = rawPrice != null && rawPrice > 0 && rawPrice <= MAX_SANE_PRICE_USD ? rawPrice : null;
      if (price == null) return 0; // no price → sort to bottom
      const rawDecimals = tokenMetaMap.get(m.mintAddress)?.decimals ?? (m.supabase?.decimals ?? 6);
      const mintDecimals = Math.min(Math.max(rawDecimals, 0), 18);
      return (Number(getOI(m)) / 10 ** mintDecimals) * price;
    };
    list = [...list].sort((a, b) => {
      switch (sortBy) {
        case "volume": {
          // Prefer Supabase volume, fall back to OI
          const volA = BigInt(a.supabase?.volume_24h ?? 0) || getOI(a);
          const volB = BigInt(b.supabase?.volume_24h ?? 0) || getOI(b);
          return volB > volA ? 1 : volB < volA ? -1 : 0;
        }
        case "oi": {
          // In USD mode: sort by USD-equivalent OI; no-price markets → 0 → bottom (fix #1327)
          // In token mode: sort by raw token amount as before
          if (showUsd) {
            return getOIUsdSortKey(b) - getOIUsdSortKey(a);
          }
          const oiA = getOI(a);
          const oiB = getOI(b);
          return oiB > oiA ? 1 : oiB < oiA ? -1 : 0;
        }
        case "health": {
          const ha = a.onChain
            ? computeMarketHealth(a.onChain.engine)
            : (a.supabase ? computeMarketHealthFromStats(a.supabase) : { level: "empty" as const });
          const hb = b.onChain
            ? computeMarketHealth(b.onChain.engine)
            : (b.supabase ? computeMarketHealthFromStats(b.supabase) : { level: "empty" as const });
          // GH#1637: oracle-down sort rank — below Warning but above Empty.
          // GH#1643: Markets with valid oracle but c_tot=0 (health="empty") were ranking
          // after oracle-down markets because "empty"=4 > "oracle-down"=3. Fix: add a
          // "empty-oracle-up" rank (3) for markets that have a working oracle but no capital.
          // These have working oracle feeds so they should rank above oracle-down markets.
          // New order: healthy=0 < caution=1 < warning=2 < empty-oracle-up=3 < oracle-down=4 < empty=5.
          const order: Record<string, number> = { healthy: 0, caution: 1, warning: 2, "empty-oracle-up": 3, "oracle-down": 4, empty: 5 };
          const numericOrNullForSort = (v: unknown): number | null => {
            if (v == null) return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
          };
          // For on-chain markets: isOracleDown when resolveMarketPriceE6 returns 0 OR
          //   when Supabase confirms oracle is stale (mark_price AND index_price both null/zero).
          //   GH#1646: 3 SOL markets (EkQty/DD9Ym/8Wxmx) floated to top of health sort because
          //   their authorityPriceE6 stored a stale non-zero price (last pushed before oracle stopped).
          //   resolveMarketPriceE6 returned non-zero → computeIsOracleDown=false → rank=healthy.
          //   Fix: cross-check with Supabase mark_price+index_price as a secondary oracle-down signal.
          //   If Supabase shows no mark or index price (keeper hasn't indexed an oracle crank),
          //   treat as oracle-down regardless of the stale on-chain authorityPriceE6.
          // For Supabase-only markets: isOracleDown when both mark_price and index_price are null/zero
          // GH#1639: Apply the same MIN_VAULT_FOR_OI guard as route.ts.
          // Markets with vault_balance < MIN_VAULT_FOR_OI have phantom OI zeroed out
          // server-side; calling isOracleDown on them may produce "oracle-down" sort rank
          // instead of "empty", causing client/server sort disagreement at the threshold boundary.
          // Guard: return false (not oracle-down) for sub-threshold markets so they sort as "empty".
          const computeIsOracleDown = (m: MergedMarket): boolean => {
            // Vault guard — mirrors route.ts MIN_VAULT_FOR_OI check (PERC-816 / GH#1639)
            // GH#1658: vault_balance may be 0/null when indexer hasn't populated it yet.
            //   Fallback to c_tot (total vault capacity) so oracle-down markets with a real
            //   c_tot don't get incorrectly excluded by the guard.
            const rawVault = m.supabase?.vault_balance;
            const rawCtot  = m.supabase?.c_tot;
            const vaultBal = numericOrNullForSort(
              rawVault != null && Number(rawVault) > 0 ? rawVault : rawCtot
            );
            if (vaultBal !== null && vaultBal < MIN_VAULT_FOR_OI) {
              // Sub-threshold vault: phantom OI suppressed server-side → treat as empty, not oracle-down
              return false;
            }
            if (m.onChain) {
              const priceE6 = resolveMarketPriceE6(m.onChain.config);
              // Primary: on-chain price is 0 → keeper not cranking
              if (priceE6 === 0n) return true;
              // GH#1646: Secondary: Supabase shows no mark_price + no index_price.
              // A non-zero authorityPriceE6 may be stale (last pushed before oracle stopped).
              // If the Supabase indexer also hasn't recorded any oracle prices for this market,
              // treat it as oracle-down so the sort rank matches the badge.
              if (m.supabase) {
                const mp = numericOrNullForSort(m.supabase.mark_price);
                const ip = numericOrNullForSort(m.supabase.index_price);
                if ((mp == null || mp <= 0) && (ip == null || ip <= 0)) return true;
              }
              return false;
            }
            if (m.supabase) {
              const mp = numericOrNullForSort(m.supabase.mark_price);
              const ip = numericOrNullForSort(m.supabase.index_price);
              return (mp == null || mp <= 0) && (ip == null || ip <= 0);
            }
            return false;
          };
          // GH#1643: Markets with a working oracle but c_tot=0 should sort above oracle-down.
          // Use "empty-oracle-up" rank for empty markets that are NOT oracle-down.
          const getEffectiveSortLevel = (m: MergedMarket, baseLevel: string): string => {
            if (computeIsOracleDown(m)) return "oracle-down";
            if (baseLevel === "empty") return "empty-oracle-up";
            return baseLevel;
          };
          const levelA = getEffectiveSortLevel(a, ha.level);
          const levelB = getEffectiveSortLevel(b, hb.level);
          return (order[levelA] ?? 5) - (order[levelB] ?? 5);
        }
        case "recent": {
          // Sort by created_at descending; fall back to slab address if missing
          const aTime = a.supabase?.created_at;
          const bTime = b.supabase?.created_at;
          if (aTime && bTime) return bTime.localeCompare(aTime);
          if (bTime) return 1;  // b has time, a doesn't → b first
          if (aTime) return -1; // a has time, b doesn't → a first
          return b.slabAddress.localeCompare(a.slabAddress);
        }
        default: return 0;
      }
    });
    return list;
  }, [effectiveMarkets, debouncedSearch, sortBy, leverageFilter, oracleFilter, showUsd, tokenMetaMap]);

  // P-MED-3: Progressive reveal + intersection observer backup
  // Auto-load items in batches via requestAnimationFrame for instant display.
  // The IntersectionObserver is kept as a secondary trigger for user-initiated scroll.
  const filteredLengthRef = useRef(filtered.length);
  filteredLengthRef.current = filtered.length;

  // Primary: progressive auto-reveal (loads all items within ~200ms)
  useEffect(() => {
    if (discoveryLoading || statsLoading) return; // wait for data
    if (displayCount >= filtered.length) return; // all shown

    const handle = requestAnimationFrame(() => {
      setDisplayCount((prev) => {
        const total = filteredLengthRef.current;
        if (prev >= total) return prev;
        return Math.min(prev + 20, total);
      });
    });

    return () => cancelAnimationFrame(handle);
  }, [displayCount, filtered.length, discoveryLoading, statsLoading]);

  // Secondary: IntersectionObserver for scroll-triggered loading (backup)
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setDisplayCount((prev) => {
            const total = filteredLengthRef.current;
            if (prev >= total) return prev;
            return Math.min(prev + 20, total);
          });
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
  }, [filtered.length]);

  // Reset display count when filters change
  useEffect(() => {
    setDisplayCount(20);
  }, [debouncedSearch, leverageFilter, oracleFilter, sortBy]);

  const displayedMarkets = filtered.slice(0, displayCount);
  const loading = discoveryLoading || statsLoading;
  const showDegradedBanner = Boolean(loadErrorMessage && !loading && filtered.length > 0);

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
    <div className="min-h-[calc(100dvh-48px)] relative">
      {/* Grid background — subtle decorative element */}
      <div className="absolute inset-x-0 top-0 h-16 bg-grid pointer-events-none opacity-50" />

      <div className="relative mx-auto max-w-[1100px] px-4 sm:px-6 pt-4 pb-10">
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
            <Link href="/create" aria-label="Launch a new market">
              <GlowButton size="sm">+ LAUNCH MARKET</GlowButton>
            </Link>
          </div>
        </ScrollReveal>

        {/* Search & Sort */}
        <ScrollReveal delay={0.1}>
          {/* Row 1: Search + Sort tabs */}
          <div className="mb-1.5 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-dim)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="search token, address, or mint..."
                className="w-full rounded-sm border border-[var(--border)] bg-[var(--bg-elevated)] py-2.5 pl-10 pr-4 text-sm text-[var(--text)] placeholder-[var(--text-dim)] focus:border-[var(--accent)]/40 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20"
                aria-label="Search markets"
              />
              {hasSearch && (
                <button
                  onClick={clearSearch}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-dim)] hover:text-[var(--text-secondary)] p-1 min-h-[44px] min-w-[44px] flex items-center justify-center"
                  title="Clear search"
                  aria-label="Clear search"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
            {/* Sort tabs + market count (mobile) on same row */}
            <div className="flex items-center gap-3 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
              <div className="relative flex gap-1 rounded-sm border border-[var(--border)] bg-[var(--bg-elevated)] p-1" role="group" aria-label="Sort markets">
                {([
                  { key: "volume" as SortKey, label: "VOLUME" },
                  { key: "oi" as SortKey, label: "OI" },
                  { key: "health" as SortKey, label: "HEALTH" },
                  { key: "recent" as SortKey, label: "RECENT" },
                ]).map((opt) => (
                  <button
                    key={opt.key}
                    onClick={() => setSortBy(opt.key)}
                    className={[
                      "rounded-sm px-3 py-2 sm:py-1.5 text-[10px] font-bold uppercase tracking-[0.08em] transition-all duration-200 min-h-[40px]",
                      sortBy === opt.key
                        ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                        : "text-white/70 hover:text-white",
                    ].join(" ")}
                    aria-pressed={sortBy === opt.key}
                    aria-label={`Sort by ${opt.label}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {/* Separator — mobile only */}
              <span className="sm:hidden h-6 w-px bg-white/15 shrink-0" />

              {/* Results count — mobile only, beside sort tabs */}
              <span className="sm:hidden ml-auto shrink-0 whitespace-nowrap text-sm font-semibold uppercase tracking-[0.08em] text-white tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
                {loading
                  ? <>&hellip; MARKETS</>
                  : (hasSearch || hasActiveFilters) && filtered.length !== activeMarkets.length
                    ? <>{filtered.length} / {activeMarkets.length} {activeMarkets.length !== 1 ? "MARKETS" : "MARKET"}</>
                    : <>{activeMarkets.length} {activeMarkets.length !== 1 ? "MARKETS" : "MARKET"}</>}
              </span>
            </div>
          </div>

          {/* Row 2: Filter pills — single scrollable row on mobile */}
          <div className="mb-6 flex items-center gap-2 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            <span className="hidden sm:inline-block text-[10px] font-semibold uppercase tracking-[0.15em] text-white/70 shrink-0">FILTER:</span>

            {/* USD/Token toggle */}
            <div className="flex gap-1 rounded-sm border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5 shrink-0" role="group" aria-label="Display currency">
              <button
                onClick={() => setShowUsd(false)}
                className={[
                  "rounded-sm px-2.5 py-1.5 sm:py-1 text-[10px] font-bold uppercase tracking-[0.08em] transition-all duration-200 min-h-[36px] sm:min-h-[32px]",
                  !showUsd
                    ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                    : "text-white/70 hover:text-white",
                ].join(" ")}
                aria-pressed={!showUsd}
                aria-label="Display in tokens"
              >
                TOKENS
              </button>
              <button
                onClick={() => setShowUsd(true)}
                className={[
                  "rounded-sm px-2.5 py-1.5 sm:py-1 text-[10px] font-bold uppercase tracking-[0.08em] transition-all duration-200 min-h-[36px] sm:min-h-[32px]",
                  showUsd
                    ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                    : "text-white/70 hover:text-white",
                ].join(" ")}
                aria-pressed={showUsd}
                aria-label="Display in USD"
              >
                USD
              </button>
            </div>

            {/* Separator */}
            <span className="hidden sm:inline-block h-4 w-px bg-[var(--border)] shrink-0" />
            <span className="sm:hidden text-white/40 text-sm font-bold shrink-0">&middot;</span>

            {/* Leverage filter */}
            <div className="flex gap-1 rounded-sm border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5 shrink-0" role="group" aria-label="Filter by leverage">
              {([
                { key: "all" as LeverageFilter, label: "ALL" },
                { key: "5x" as LeverageFilter, label: "5X+" },
                { key: "10x" as LeverageFilter, label: "10X+" },
                { key: "20x" as LeverageFilter, label: "20X+" },
              ]).map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setLeverageFilter(opt.key)}
                  className={[
                    "rounded-sm px-2.5 py-1.5 sm:py-1 text-[10px] font-bold uppercase tracking-[0.08em] transition-all duration-200 min-h-[36px] sm:min-h-[32px]",
                    leverageFilter === opt.key
                      ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                      : "text-white/70 hover:text-white",
                  ].join(" ")}
                  aria-pressed={leverageFilter === opt.key}
                  aria-label={`Filter leverage ${opt.label}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Separator */}
            <span className="hidden sm:inline-block h-4 w-px bg-[var(--border)] shrink-0" />
            <span className="sm:hidden text-white/40 text-sm font-bold shrink-0">&middot;</span>

            {/* Oracle filter */}
            <div className="flex gap-1 rounded-sm border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5 shrink-0" role="group" aria-label="Filter by oracle type">
              {([
                { key: "all" as OracleFilter, label: "ALL ORACLES" },
                { key: "live" as OracleFilter, label: "LIVE FEED" },
                { key: "admin" as OracleFilter, label: "MANUAL" },
              ]).map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setOracleFilter(opt.key)}
                  className={[
                    "rounded-sm px-2.5 py-1.5 sm:py-1 text-[10px] font-bold uppercase tracking-[0.08em] transition-all duration-200 min-h-[36px] sm:min-h-[32px]",
                    oracleFilter === opt.key
                      ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                      : "text-white/70 hover:text-white",
                  ].join(" ")}
                  aria-pressed={oracleFilter === opt.key}
                  aria-label={`Filter oracle ${opt.label}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* P-MED-4: Separate clear buttons */}
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--short)] hover:text-[var(--short)]/80 underline underline-offset-2 shrink-0"
              >
                CLEAR
              </button>
            )}

            {/* Results count — desktop only, in filter row */}
            <span className="hidden sm:inline-block ml-auto text-xs font-semibold uppercase tracking-[0.08em] text-white shrink-0 whitespace-nowrap tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
              {(hasSearch || hasActiveFilters) && filtered.length !== activeMarkets.length
                ? `${filtered.length} / ${activeMarkets.length} MARKETS`
                : `${activeMarkets.length} ${activeMarkets.length !== 1 ? "MARKETS" : "MARKET"}`}
            </span>
          </div>
        </ScrollReveal>

        {showDegradedBanner && (
          <ScrollReveal delay={0.15}>
            <div
              role="alert"
              className="mb-4 rounded-sm border px-4 py-3 text-center text-sm font-mono"
              style={{
                background: "rgba(239,68,68,0.06)",
                borderColor: "rgba(239,68,68,0.3)",
                color: "#f87171",
              }}
            >
              Partial market data: {loadErrorMessage}
            </div>
          </ScrollReveal>
        )}

        {/* Table */}
        <ErrorBoundary label="Markets Table">
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
              ) : loadErrorMessage ? (
                <>
                  <h3 className="text-base font-semibold text-white">couldn&apos;t load markets.</h3>
                  <p className="mt-2 text-sm text-[var(--text-secondary)]">{loadErrorMessage}</p>
                  <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
                    <GlowButton type="button" onClick={() => window.location.reload()}>
                      reload page
                    </GlowButton>
                    <Link href="/create">
                      <GlowButton variant="secondary" size="sm">
                        launch market
                      </GlowButton>
                    </Link>
                  </div>
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
              <div className="relative rounded-sm border border-[var(--border)] hud-corners after:pointer-events-none after:absolute after:right-0 after:top-0 after:bottom-0 after:w-6 after:z-20 after:bg-gradient-to-l after:from-[var(--bg-surface)] after:to-transparent sm:after:hidden">
              <div className="overflow-x-auto" style={{ WebkitOverflowScrolling: "touch" }}>
                {/* Header row: xs=4 cols (name|price|lev|health), sm+=7 cols */}
                {/* GH#1775: sticky inside overflow-x-auto is broken by CSS spec (overflow clips stacking context).
                    Removed sticky top-0 z-10 — header scrolls with content on mobile.
                    Desktop (sm+) is unaffected since the table fits in viewport width. */}
                <div className="grid w-full min-w-[500px] sm:min-w-[700px] grid-cols-[minmax(120px,2.5fr)_minmax(80px,1.2fr)_minmax(50px,0.6fr)_minmax(75px,0.8fr)] sm:grid-cols-[minmax(160px,3fr)_minmax(90px,1.2fr)_minmax(90px,1fr)_minmax(90px,1fr)_minmax(90px,1fr)_minmax(65px,0.8fr)_minmax(80px,0.9fr)] gap-2 sm:gap-4 border-b border-[var(--border)] bg-[var(--bg-surface)] px-3 sm:px-5 py-2.5 text-[9px] sm:text-[10px] font-semibold uppercase tracking-[0.15em] text-[var(--text-dim)]">
                  <div>token</div>
                  <div className="text-right">price</div>
                  <div className="hidden sm:block text-right">OI</div>
                  <div className="hidden sm:block text-right">vol</div>
                  <div className="hidden sm:block text-right">insurance</div>
                  <div className="text-right"><span className="sm:hidden">lev</span><span className="hidden sm:inline">max lev</span></div>
                  <div className="text-right">health</div>
                </div>

                {displayedMarkets.map((m, i) => {
                  // Health: prefer on-chain data, fall back to Supabase stats
                  const health = m.onChain
                    ? computeMarketHealth(m.onChain.engine)
                    : (m.supabase
                      ? computeMarketHealthFromStats(m.supabase)
                      : { level: "empty" as const, label: "No data", insuranceRatio: 0, capitalRatio: 0 });
                  
                  // Price: prefer Supabase, fall back to oracle-mode-aware on-chain price
                  // Cap bogus prices (corrupted on-chain data can produce $4.2T values)
                  const onChainPriceE6 = m.onChain ? resolveMarketPriceE6(m.onChain.config) : 0n;

                  // GH#1631: Override health to "oracle-down" for ALL markets without a valid
                  // oracle price — regardless of whether we have on-chain capital/insurance data.
                  //
                  // Root cause of partial fix in PR #1630:
                  //   The prior check only looked at m.supabase.mark_price / index_price,
                  //   but 67/82 oracle-down markets have m.onChain != null (discovered via RPC)
                  //   with cTot > 0. computeMarketHealth(m.onChain.engine) returns "Healthy"
                  //   because it sees capital, ignoring that the oracle hasn't been cranked.
                  //
                  // Complete fix:
                  //   - On-chain markets: resolveMarketPriceE6 === 0n → oracle is down
                  //   - Supabase-only markets: both mark_price AND index_price null/zero → oracle is down
                  //   - Skip zombie markets (they show "Empty" already)
                  //   - Skip on-chain-only markets with no Supabase (no reliable oracle state signal)
                  const numericOrNull = (v: unknown): number | null => {
                    if (v == null) return null;
                    const n = Number(v);
                    return Number.isFinite(n) ? n : null;
                  };
                  const isOracleDown: boolean = (() => {
                    // GH#1638 / CodeRabbit MAJOR: Apply the same MIN_VAULT_FOR_OI vault guard
                    // as the sort comparator (computeIsOracleDown). Without this guard, markets
                    // with vault_balance < MIN_VAULT_FOR_OI (phantom OI zeroed server-side)
                    // could render an "oracle-down" badge while sorting as "empty", creating a
                    // client/server sort mismatch at the threshold boundary.
                    // Mirror computeIsOracleDown: prefer vault_balance, fall back to c_tot.
                    const rawVaultR = m.supabase?.vault_balance;
                    const rawCtotR  = m.supabase?.c_tot;
                    const vaultBalR = numericOrNull(
                      rawVaultR != null && Number(rawVaultR) > 0 ? rawVaultR : rawCtotR
                    );
                    if (vaultBalR !== null && vaultBalR < MIN_VAULT_FOR_OI) {
                      // Sub-threshold vault: phantom OI suppressed server-side → render as empty, not oracle-down
                      return false;
                    }

                    // On-chain market: use resolveMarketPriceE6 as oracle-availability signal.
                    // If the resolved price is 0n the keeper has not cranked or oracle is unavailable.
                    if (m.onChain) {
                      return onChainPriceE6 === 0n;
                    }
                    // GH#1644: Supabase-only market: last_price=null MUST force "No Oracle" badge.
                    // Previously only mark_price+index_price were checked — but markets like
                    // HKeVEQt3 (8u2PCh5J) had last_price=null (no trades, no oracle crank)
                    // yet showed "Caution" because their OI/collateral triggered computeMarketHealthFromStats.
                    // Fix: any of last_price, mark_price, or index_price being present signals oracle-up;
                    // all three null/zero → oracle is down.
                    if (m.supabase) {
                      const lp = numericOrNull(m.supabase.last_price);
                      const mp = numericOrNull(m.supabase.mark_price);
                      const ip = numericOrNull(m.supabase.index_price);
                      return (lp == null || lp <= 0) && (mp == null || mp <= 0) && (ip == null || ip <= 0);
                    }
                    return false;
                  })();
                  const effectiveHealth = isOracleDown
                    ? { level: "oracle-down" as const, label: "No Oracle", insuranceRatio: 0, capitalRatio: 0 }
                    : health;
                  const rawPrice = m.supabase?.last_price ?? priceE6ToUsd(onChainPriceE6);
                  const lastPrice = rawPrice != null && rawPrice > MAX_SANE_PRICE_USD ? null : rawPrice;
                  const rawDecimals = tokenMetaMap.get(m.mintAddress)?.decimals ?? (m.supabase?.decimals ?? 6);
                  const mintDecimals = Math.min(Math.max(rawDecimals, 0), 18); // clamp to sane range
                  const tokenDivisor = 10 ** mintDecimals;
                  
                  // Token amounts: prefer on-chain, fall back to Supabase
                  // Sanitize sentinel values (u64::MAX = uninitialized on-chain) → show as 0
                  // PERC-234: Supabase values are raw on-chain values (NOT human-readable).
                  // StatsCollector stores safeBigNum(engine.totalOpenInterest) etc. directly.
                  // Do NOT multiply by tokenDivisor — that double-counts decimals.
                  const oiTokensRaw = m.onChain
                    ? sanitizeOnChainValue(m.onChain.engine.totalOpenInterest)
                    : (() => {
                        const v = m.supabase?.total_open_interest ?? ((m.supabase?.open_interest_long ?? 0) + (m.supabase?.open_interest_short ?? 0));
                        const safe = isSentinelNum(v) ? 0 : Math.max(0, v);
                        return BigInt(Math.round(safe));
                      })();
                  const insuranceTokensRaw = m.onChain
                    ? sanitizeOnChainValue(m.onChain.engine.insuranceFund.balance)
                    : (() => {
                        const v = m.supabase?.insurance_balance ?? m.supabase?.insurance_fund ?? 0;
                        const safe = isSentinelNum(v) ? 0 : Math.max(0, v);
                        return BigInt(Math.round(safe));
                      })();
                  const volume24hRaw = m.supabase?.volume_24h != null && !isSentinelNum(m.supabase.volume_24h) && m.supabase.volume_24h > 0
                    ? BigInt(Math.round(m.supabase.volume_24h))
                    : null;
                  
                  // Display values (USD or tokens) — cap token display at 2dp for table readability
                  // #1152/#1153: null/zero → "—" (not "$0.00" which looks broken on devnet)
                  const oiUsd = showUsd && lastPrice != null
                    ? Math.round((Number(oiTokensRaw) / tokenDivisor) * lastPrice * 100) / 100
                    : null;
                  const oiDisplay = oiTokensRaw === 0n ? "—"
                    : oiUsd != null ? (oiUsd > 0 ? formatNum(oiUsd) : "—") : formatStatValue(oiTokensRaw, 'number', mintDecimals);
                  const insUsd = showUsd && lastPrice != null
                    ? Math.round((Number(insuranceTokensRaw) / tokenDivisor) * lastPrice * 100) / 100
                    : null;
                  const insuranceDisplay = insuranceTokensRaw === 0n ? "—"
                    : insUsd != null ? (insUsd > 0 ? formatNum(insUsd) : "—") : formatStatValue(insuranceTokensRaw, 'number', mintDecimals);
                  const volumeDisplay = volume24hRaw != null && volume24hRaw > 0n
                    ? (showUsd && lastPrice != null
                        ? formatNum(Math.round((Number(volume24hRaw) / tokenDivisor) * lastPrice * 100) / 100)
                        : formatTokenAmount(volume24hRaw, mintDecimals, 2))
                    : null;

                  return (
                    <Link
                      key={m.slabAddress}
                      href={`/trade/${m.slabAddress}`}
                      className={[
                        "grid w-full min-w-[500px] sm:min-w-[700px] grid-cols-[minmax(120px,2.5fr)_minmax(80px,1.2fr)_minmax(50px,0.6fr)_minmax(75px,0.8fr)] sm:grid-cols-[minmax(160px,3fr)_minmax(90px,1.2fr)_minmax(90px,1fr)_minmax(90px,1fr)_minmax(90px,1fr)_minmax(65px,0.8fr)_minmax(80px,0.9fr)] gap-2 sm:gap-4 items-center px-3 sm:px-5 py-3 transition-all duration-200 hover:bg-[var(--accent)]/[0.06] border-l-2 border-l-transparent hover:border-l-[var(--accent)]/40",
                        i > 0 ? "border-t border-[var(--border)]" : "",
                        i % 2 === 1 ? "bg-white/[0.05]" : "",
                      ].join(" ")}
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <MarketLogo
                            logoUrl={m.supabase?.logo_url}
                            mintAddress={m.mintAddress}
                            symbol={
                              // GH#1544: prefer on-chain symbol; fall back to Supabase symbol
                              // so anonymous markets show a meaningful abbreviation instead of "?"
                              // Use || (not ??) so empty-string on-chain symbols fall through to
                              // the Supabase fallback — CodeRabbit review fix.
                              tokenMetaMap.get(m.mintAddress)?.symbol ||
                              m.supabase?.symbol ||
                              undefined
                            }
                            size="sm"
                          />
                          <span className="font-semibold text-white text-sm">
                            {(() => {
                              // Helper: detect if a symbol is a truncated address (auto-registered placeholder)
                              const isPlaceholderSymbol = (sym: string | null | undefined, mint: string): boolean => {
                                if (!sym) return true;
                                // Reject if it's the first N chars of the mint address (StatsCollector default)
                                if (mint.startsWith(sym)) return true;
                                // Reject pure hex-like strings (8 chars)
                                if (/^[0-9a-fA-F]{8}$/.test(sym)) return true;
                                // Reject if it looks like a truncated address with ellipsis
                                if (/^[A-Za-z0-9]{3,6}\.\.\.[A-Za-z0-9]{3,6}$/.test(sym)) return true;
                                return false;
                              };
                              const onChainSym = tokenMetaMap.get(m.mintAddress)?.symbol;
                              const supabaseSym = m.supabase?.symbol;
                              const sym = (!isPlaceholderSymbol(onChainSym, m.mintAddress) ? onChainSym : null)
                                || (!isPlaceholderSymbol(supabaseSym, m.mintAddress) && supabaseSym && supabaseSym.length <= 10 ? supabaseSym : null);
                              return sym ? `${sym}/USD` : shortenAddress(m.slabAddress);
                            })()}
                          </span>
                          {m.isAdminOracle && (
                            <span className="border border-[var(--text-dim)]/30 bg-[var(--text-dim)]/[0.08] px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-wider text-[var(--text-dim)]">manual</span>
                          )}
                          {/* GH#1233: warn when admin-oracle market has no price — users cannot open positions */}
                          {m.isAdminOracle && lastPrice === null && (
                            <span
                              title="No oracle price — new position opens are blocked for this market"
                              className="inline-block w-[52px] text-center border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider"
                              style={{ borderColor: "var(--short)", color: "var(--short)", backgroundColor: "rgba(255,60,60,0.06)" }}
                            >
                              no price
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>
                          {(() => {
                            const onChainName = tokenMetaMap.get(m.mintAddress)?.name;
                            const supabaseName = m.supabase?.name;
                            // Filter out placeholder names like "Market XXXXXXXX"
                            const isPlaceholderName = (n: string | null | undefined): boolean => {
                              if (!n) return true;
                              if (/^Market [A-Za-z0-9]{6,}$/.test(n)) return true;
                              if (n.length <= 8 && m.mintAddress.startsWith(n)) return true;
                              // Filter truncated addresses used as names
                              if (/^[A-Za-z0-9]{3,6}\.\.\.[A-Za-z0-9]{3,6}$/.test(n)) return true;
                              return false;
                            };
                            const name = (!isPlaceholderName(onChainName) ? onChainName : null)
                              || (!isPlaceholderName(supabaseName) ? supabaseName : null);
                            return name ? `${name} · ${shortenAddress(m.mintAddress)}` : shortenAddress(m.mintAddress);
                          })()}
                        </div>
                      </div>
                      <div className="text-right truncate">
                        <span className="text-sm text-white tabular-nums" style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>
                          {lastPrice != null
                            ? `$${lastPrice < 0.01 ? lastPrice.toFixed(6) : lastPrice < 1 ? lastPrice.toFixed(4) : lastPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                            : "\u2014"}
                        </span>
                      </div>
                      <div className="hidden sm:block text-right text-sm text-[var(--text-secondary)] truncate tabular-nums" style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>{oiDisplay}</div>
                      <div className="hidden sm:block text-right text-sm text-[var(--text-secondary)] truncate tabular-nums" style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>
                        {volumeDisplay ?? "\u2014"}
                      </div>
                      <div className="hidden sm:block text-right text-sm text-[var(--text)] truncate tabular-nums" style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>{insuranceDisplay}</div>
                      <div className="text-right text-sm text-[var(--text-secondary)] tabular-nums" style={{ fontVariantNumeric: "tabular-nums" }}>{m.maxLeverage}x</div>
                      <div className="text-right"><HealthBadge level={effectiveHealth.level} /></div>
                    </Link>
                  );
                })}
              </div>
              </div>

              {/* P-MED-3: Infinite scroll trigger / end-of-list */}
              {displayCount < filtered.length ? (
                <div ref={observerTarget} className="flex items-center justify-center gap-2 py-4">
                  <div className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
                  <span className="text-xs text-[var(--text-muted)]">Loading more…</span>
                </div>
              ) : filtered.length > 20 ? (
                <div className="flex items-center justify-center gap-3 py-4">
                  <span className="text-[11px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>
                    all {filtered.length} market{filtered.length !== 1 ? "s" : ""} loaded
                  </span>
                  <button
                    onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
                    className="text-[11px] text-[var(--accent)]/60 hover:text-[var(--accent)] transition-colors"
                    aria-label="Scroll to top"
                  >
                    ↑ top
                  </button>
                </div>
              ) : null}
            </>
          )}
          </ScrollReveal>
        </ErrorBoundary>
      </div>
    </div>
  );
}

export default function MarketsPage() {
  return (
    <Suspense fallback={
      <div className="min-h-[calc(100dvh-48px)] relative">
        <div className="absolute inset-x-0 top-0 h-32 bg-grid pointer-events-none" />
        <div className="relative mx-auto max-w-[1100px] px-4 sm:px-6 pt-4 pb-10">
          <div className="mb-8">
            <ShimmerSkeleton className="h-3 w-20 mb-2" />
            <ShimmerSkeleton className="h-8 w-48 mb-2" />
            <ShimmerSkeleton className="h-4 w-72" />
          </div>
          <div className="mb-6 flex gap-3">
            <ShimmerSkeleton className="flex-1 h-11" />
            <ShimmerSkeleton className="h-11 w-48" />
          </div>
          <div className="space-y-2">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <ShimmerSkeleton key={i} className="h-[52px]" />
            ))}
          </div>
        </div>
      </div>
    }>
      <MarketsPageInner />
    </Suspense>
  );
}
