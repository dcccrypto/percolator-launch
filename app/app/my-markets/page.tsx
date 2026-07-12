"use client";

import { FC, useEffect, useMemo, useRef, useState, useCallback } from "react";
import Link from "next/link";
import gsap from "gsap";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";
import { useCreatedMarkets, type CreatedMarket } from "@/hooks/useCreatedMarkets";
import { CreatorMarketRow } from "@/components/my-markets/CreatorMarketRow";
import { CreatorAttentionStrip } from "@/components/my-markets/CreatorAttentionStrip";
import { toCreatorMarketDetail, unitScaleToDecimals, resolveCreatedMarketPriceE6, type CreatorMarketDetail } from "@/components/my-markets/types";
import { isKeeperFeedDead, isEngineCrankStale } from "@/components/my-markets/attentionLogic";
import { useLiveSlabPrices } from "@/hooks/useLiveSlabPrices";
import { setMarketIdentity } from "@/lib/marketIdentityCache";
import { isMockMode } from "@/lib/mock-mode";
import { getMockMyMarkets } from "@/lib/mock-trade-data";

const pageHeader = (
  <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
    // admin
  </div>
);

/* ─── loading skeleton ─── */
const LoadingSkeleton: FC = () => (
  <div className="min-h-[calc(100dvh-48px)] relative">
    <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
    <main className="relative mx-auto max-w-5xl px-4 py-10">
      <div className="mb-2"><ShimmerSkeleton className="h-3 w-16" /></div>
      <div className="mb-2"><ShimmerSkeleton className="h-7 w-48" /></div>
      <div className="mb-8"><ShimmerSkeleton className="h-4 w-64" /></div>
      <div className="mb-2 border border-[var(--border)] bg-[var(--panel-bg)] p-6 sm:p-8">
        <ShimmerSkeleton className="mb-2 h-3 w-32" />
        <ShimmerSkeleton className="h-9 w-40" />
      </div>
      <div className="mb-8 grid grid-cols-2 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)] sm:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="bg-[var(--panel-bg)] p-5">
            <ShimmerSkeleton className="mb-2 h-2.5 w-20" />
            <ShimmerSkeleton className="h-5 w-16" />
          </div>
        ))}
      </div>
      {[1, 2].map((i) => (
        <div key={i} className="mb-3 border border-[var(--border)] bg-[var(--panel-bg)] p-4">
          <div className="flex items-center gap-4">
            <ShimmerSkeleton className="h-8 w-8 rounded-full" />
            <ShimmerSkeleton className="h-4 w-24" />
            <ShimmerSkeleton className="h-4 w-16" />
            <ShimmerSkeleton className="h-4 w-16 ml-auto" />
          </div>
        </div>
      ))}
    </main>
  </div>
);

/** Batched fetch of /api/markets/[slab] for every created market — the ONE
 *  RPC-heavy-adjacent cost this page still pays, but scoped to markets the
 *  wallet actually created (typically a handful), never the full markets
 *  list. Powers both the Tier-2 tiles (aggregate sums) and each row's
 *  Liquidity/health/dex info — fetched ONCE here, not again when a row's
 *  drawer expands (see CreatorMarketRow's "lazy" doc comment). */
function useCreatorMarketDetails(slabs: string[]) {
  const slabsKey = useMemo(() => [...slabs].sort().join(","), [slabs]);
  const [details, setDetails] = useState<Record<string, CreatorMarketDetail>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const list = slabsKey ? slabsKey.split(",") : [];
    if (list.length === 0) {
      setDetails({});
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all(
      list.map(async (slab) => {
        try {
          const res = await fetch(`/api/markets/${slab}`);
          if (!res.ok) return null;
          const body = (await res.json()) as { market?: Record<string, unknown> };
          if (!body.market) return null;
          return toCreatorMarketDetail(body.market);
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      const next: Record<string, CreatorMarketDetail> = {};
      results.forEach((d, i) => {
        if (d) {
          next[list[i]] = d;
          // Feed the cross-navigation identity cache as each market resolves
          // so /trade/[slab] never flashes a placeholder name for a market
          // this creator just clicked into from their own dashboard.
          setMarketIdentity(list[i], {
            symbol: d.symbol ?? undefined,
            name: d.name ?? undefined,
            logo_url: d.logo_url ?? undefined,
            mainnet_ca: d.mainnet_ca ?? null,
          });
        }
      });
      setDetails(next);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [slabsKey]);

  return { details, detailsLoading: loading };
}

const MyMarketsPage: FC = () => {
  const {
    myMarkets: realMyMarkets,
    loading: realLoading,
    error,
    connected: walletConnected,
    refetch: refetchMarkets,
    currentSlot: chainCurrentSlot,
  } = useCreatedMarkets();

  const mockMode = isMockMode();
  const connected = walletConnected || mockMode;
  // Design-preview only (never in production — see isMockMode's own gate).
  // getMockMyMarkets() returns a mix of admin/lp/trader roles from the old
  // model; this page shows "markets you created" only, so every mock entry
  // is treated as one regardless of its (now-unused) `role` field.
  const mockMarkets = useMemo(() => (mockMode ? (getMockMyMarkets() as unknown as CreatedMarket[]) : []), [mockMode]);
  const myMarkets = realMyMarkets.length === 0 && mockMode ? mockMarkets : realMyMarkets;
  const loading = mockMode ? false : realLoading;

  const [refreshing, setRefreshing] = useState(false);
  const [expandedSlab, setExpandedSlab] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pageRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      pageRef.current.style.opacity = "1";
      return;
    }
    gsap.fromTo(pageRef.current, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power2.out" });
  }, []);

  const slabs = useMemo(() => myMarkets.map((m) => m.slabAddress.toBase58()), [myMarkets]);
  const { details, detailsLoading } = useCreatorMarketDetails(slabs);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetchMarkets?.();
    setTimeout(() => setRefreshing(false), 500);
  }, [refetchMarkets]);

  // Live price roll-up for the hero — reuses the same shared WS price store
  // the rows tick off (see hooks/useLiveSlabPrices.ts).
  const livePrices = useLiveSlabPrices(slabs);

  // ── Tier-2 aggregate sums ──
  // Liquidity Seeded: sum of the LIVE on-chain LP capital across every
  // resolved market's /api/markets/[slab] detail. "N of M markets" sub-label
  // while some details are still in flight — never fabricate a partial sum
  // as if it were the total.
  const resolvedCount = slabs.filter((s) => details[s]).length;
  const liquiditySeededTotal = useMemo(() => {
    let sum = 0;
    for (const m of myMarkets) {
      const d = details[m.slabAddress.toBase58()];
      const decimals = unitScaleToDecimals(m.configV17?.unitScale ?? m.config?.unitScale);
      const atoms = d?.vault_balance ?? (m.configV17 ? null : Number(m.engine?.vault ?? 0n));
      if (atoms != null) sum += atoms / 10 ** decimals;
    }
    return sum;
  }, [myMarkets, details]);
  const storedLpCollateralTotal = useMemo(() => {
    let sum = 0;
    let any = false;
    for (const m of myMarkets) {
      const d = details[m.slabAddress.toBase58()];
      if (d?.lp_collateral == null) continue;
      any = true;
      const decimals = unitScaleToDecimals(m.configV17?.unitScale ?? m.config?.unitScale);
      sum += d.lp_collateral / 10 ** decimals;
    }
    return any ? sum : null;
  }, [myMarkets, details]);
  // Only worth a sub-label when it materially diverges from the live sum —
  // same rule CreatorMarketRow applies per-market.
  const lpCollateralDivergesAgg =
    storedLpCollateralTotal != null && storedLpCollateralTotal > 0 &&
    (liquiditySeededTotal > storedLpCollateralTotal * 2 || liquiditySeededTotal * 2 < storedLpCollateralTotal);

  // Aggregate OI: sum resolved v17Stats only (bigint, atoms) — "N of M
  // markets" sub while others load, never fabricated for unresolved ones.
  const v17MarketsList = myMarkets.filter((m) => !!m.configV17);
  const oiResolvedCount = v17MarketsList.filter((m) => m.v17Stats).length;
  // OI is a QUANTITY of each market's own underlying asset, not a shared
  // collateral-scale dollar figure (unlike Liquidity/Insurance, which are all
  // sim-USDC) — summing raw OI across markets pricing different assets (e.g.
  // SOL OI + JUP OI) is meaningless without converting each to USD first.
  // Prefer the live price-store tick (hooks/useLiveSlabPrices.ts); fall back
  // to the market's own oracle price when the feed hasn't ticked yet.
  const aggregateOiTotal = useMemo(() => {
    let sum = 0;
    for (const m of myMarkets) {
      const decimals = unitScaleToDecimals(m.configV17?.unitScale ?? m.config?.unitScale);
      const slab = m.slabAddress.toBase58();
      const priceE6 = livePrices.get(slab) ?? resolveCreatedMarketPriceE6(m);
      const priceUsd = priceE6 > 0n ? Number(priceE6) / 1_000_000 : 0;
      if (priceUsd <= 0) continue; // no price yet → excluded, not fabricated as 0-value OI
      if (m.configV17) {
        if (!m.v17Stats) continue;
        const oiUnits = Number(m.v17Stats.oi.totalLongOiQ + m.v17Stats.oi.totalShortOiQ) / 10 ** decimals;
        sum += oiUnits * priceUsd;
      } else {
        const oiUnits = Number(m.engine?.totalOpenInterest ?? 0n) / 10 ** decimals;
        sum += oiUnits * priceUsd;
      }
    }
    return sum;
  }, [myMarkets, livePrices]);

  // Insurance — today's summary-bar line for this was already correct
  // (real v17 data via v17Stats), kept as-is.
  const totalInsurance = useMemo(() => {
    let sum = 0;
    for (const m of myMarkets) {
      const decimals = unitScaleToDecimals(m.configV17?.unitScale ?? m.config?.unitScale);
      if (m.configV17) {
        sum += Number(m.v17Stats?.oi.insuranceBalance ?? 0n) / 10 ** decimals;
      } else {
        sum += Number(m.engine?.insuranceFund?.balance ?? 0n) / 10 ** decimals;
      }
    }
    return sum;
  }, [myMarkets]);

  // Needs Attention — count only (the strip below has the detail); red
  // sub-label when > 0. Same detection functions the strip uses, so the
  // tile count and the strip's rows can never disagree.
  const needsAttentionCount = useMemo(
    () => myMarkets.filter((m) => isKeeperFeedDead(m, chainCurrentSlot) || isEngineCrankStale(m, chainCurrentSlot)).length,
    [myMarkets, chainCurrentSlot],
  );

  const fmtUsd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  if (!connected) {
    return (
      <div className="min-h-[calc(100dvh-48px)] relative">
        <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
        <main className="relative mx-auto max-w-5xl px-4 py-10">
          {pageHeader}
          <h1 className="text-xl font-medium tracking-[-0.01em] text-[var(--text)] sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
            <span className="font-normal text-[var(--text-muted)]">Your </span>Markets
          </h1>
          <p className="mt-2 mb-8 text-[13px] text-[var(--text-secondary)]">manage the markets you created.</p>
          <div className="border border-[var(--border)]/50 bg-[var(--panel-bg)] p-10 text-center">
            <p className="text-[11px] text-[var(--text-secondary)]">connect your wallet to see your markets</p>
          </div>
        </main>
      </div>
    );
  }

  if (loading) return <LoadingSkeleton />;

  if (error) {
    return (
      <div className="min-h-[calc(100dvh-48px)] relative">
        <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
        <main className="relative mx-auto max-w-5xl px-4 py-10">
          {pageHeader}
          <h1 className="text-xl font-medium tracking-[-0.01em] text-[var(--text)] sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
            <span className="font-normal text-[var(--text-muted)]">Your </span>Markets
          </h1>
          <p className="mt-2 mb-8 text-[13px] text-[var(--text-secondary)]">manage the markets you created.</p>
          <div className="border border-[var(--border)]/50 bg-[var(--panel-bg)] p-10 text-center">
            <p className="text-[11px] text-[var(--short)]">{error}</p>
          </div>
        </main>
      </div>
    );
  }

  if (myMarkets.length === 0) {
    return (
      <div className="min-h-[calc(100dvh-48px)] relative">
        <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
        <main className="relative mx-auto max-w-5xl px-4 py-10">
          {pageHeader}
          <h1 className="text-xl font-medium tracking-[-0.01em] text-[var(--text)] sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
            <span className="font-normal text-[var(--text-muted)]">Your </span>Markets
          </h1>
          <p className="mt-2 mb-8 text-[13px] text-[var(--text-secondary)]">manage the markets you created.</p>
          <div className="border border-[var(--border)]/50 bg-[var(--panel-bg)] p-10 text-center">
            <p className="mb-4 text-[11px] text-[var(--text-secondary)]">
              you haven&apos;t created a market with this wallet yet.
            </p>
            <div className="flex flex-col items-center gap-3">
              <Link href="/create" className="border border-[var(--accent)]/30 px-4 py-1.5 text-[10px] uppercase tracking-[0.15em] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10">
                launch a market
              </Link>
              <Link href="/portfolio" className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text)]">
                Have open positions on other markets? See your Portfolio →
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-48px)] relative">
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
      <main ref={pageRef} className="relative mx-auto max-w-5xl px-4 py-10 gsap-fade">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            {pageHeader}
            <h1 className="text-xl font-medium tracking-[-0.01em] text-[var(--text)] sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
              <span className="font-normal text-[var(--text-muted)]">Your </span>Markets
            </h1>
            <p className="mt-2 text-[13px] text-[var(--text-secondary)]">manage the markets you created.</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={handleRefresh}
              disabled={refreshing || loading}
              className="border border-[var(--border)]/30 px-3 py-1.5 text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)] transition-all hover:border-[var(--accent)]/30 hover:text-[var(--text)] disabled:opacity-40"
            >
              {refreshing ? "refreshing..." : "refresh"}
            </button>
            <Link href="/create" className="border border-[var(--accent)]/30 bg-[var(--accent)]/5 px-3 py-1.5 text-[10px] uppercase tracking-[0.1em] text-[var(--accent)] transition-all hover:bg-[var(--accent)]/10">
              + new market
            </Link>
          </div>
        </div>

        {/* Attention strip — zero height unless something actually needs it. */}
        <CreatorAttentionStrip markets={myMarkets} details={details} currentSlot={chainCurrentSlot} />

        {/* Hero: Markets Created count + live total-liquidity-seeded sub-line. */}
        <div className="mb-2 border border-[var(--border)] bg-[var(--panel-bg)] p-6 transition-colors duration-200 hover:bg-[var(--bg-elevated)] sm:p-8">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--text)]">Markets Created</p>
          <p className="text-3xl font-bold tabular-nums text-[var(--text)] sm:text-4xl" style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>
            {myMarkets.length}
          </p>
          <p className="mt-2 text-[11px] text-[var(--text-secondary)]">
            {resolvedCount < slabs.length && detailsLoading
              ? `Resolving liquidity seeded — ${resolvedCount} of ${slabs.length} markets…`
              : `${fmtUsd(liquiditySeededTotal)} liquidity seeded across your markets`}
          </p>
        </div>

        {/* Tier-2 tiles */}
        <div className="mb-8 grid grid-cols-2 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)] sm:grid-cols-4">
          {[
            {
              label: "Liquidity Seeded",
              value: fmtUsd(liquiditySeededTotal),
              sub: lpCollateralDivergesAgg && storedLpCollateralTotal != null
                ? `stored at creation: ${fmtUsd(storedLpCollateralTotal)}`
                : undefined,
            },
            {
              label: "Aggregate OI",
              value: fmtUsd(aggregateOiTotal),
              sub: oiResolvedCount < v17MarketsList.length ? `${oiResolvedCount} of ${myMarkets.length} markets` : undefined,
            },
            {
              label: "Insurance",
              value: fmtUsd(totalInsurance),
            },
            {
              label: "Needs Attention",
              value: needsAttentionCount.toString(),
              sub: needsAttentionCount > 0 ? "see above" : undefined,
              subColor: needsAttentionCount > 0 ? "text-[var(--short)]" : undefined,
            },
          ].map((stat) => (
            <div key={stat.label} className="bg-[var(--panel-bg)] p-5 transition-colors duration-200 hover:bg-[var(--bg-elevated)]">
              <p className="mb-2 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text)]">{stat.label}</p>
              <p className="text-xl font-bold tabular-nums text-[var(--text)]" style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>
                {stat.value}
              </p>
              {stat.sub && (
                <p className={`mt-0.5 text-[10px] font-medium ${stat.subColor ?? "text-[var(--text-secondary)]"}`}>{stat.sub}</p>
              )}
            </div>
          ))}
        </div>

        {/* Market rows — dense collapsed rows with an inline expand drawer. */}
        <div className="grid gap-3">
          {myMarkets.map((m) => {
            const slab = m.slabAddress.toBase58();
            return (
              <CreatorMarketRow
                key={slab}
                market={m}
                detail={details[slab] ?? null}
                chainCurrentSlot={chainCurrentSlot}
                expanded={expandedSlab === slab}
                onToggleExpand={() => setExpandedSlab((cur) => (cur === slab ? null : slab))}
              />
            );
          })}
        </div>
      </main>
    </div>
  );
};

export default MyMarketsPage;
