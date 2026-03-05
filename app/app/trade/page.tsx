"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

/**
 * /trade (no slab parameter)
 *
 * Redirects to SOL-PERP (by symbol match) or the highest-volume
 * active market. Falls back to the markets browser if no markets
 * are available.
 *
 * PERC-352: Default to SOL-PERP instead of a blank state.
 * Shows skeleton UI during redirect for perceived performance.
 */

interface MarketRow {
  slab_address: string;
  symbol: string | null;
  volume_24h: number | null;
  total_open_interest: number | null;
  last_price: number | null;
}

export default function TradeRedirectPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [noMarkets, setNoMarkets] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function pickMarket() {
      try {
        const res = await fetch("/api/markets", {
          signal: AbortSignal.timeout(8000),
        });

        if (!res.ok) {
          throw new Error(`Markets API returned ${res.status}`);
        }

        const data = (await res.json()) as { markets?: MarketRow[] };
        if (cancelled) return;

        const markets = data.markets ?? [];

        if (markets.length === 0) {
          setNoMarkets(true);
          return;
        }

        // Filter to markets with a sane last_price (active markets)
        const active = markets.filter(
          (m) => m.last_price != null && m.last_price > 0 && m.last_price < 1e18
        );

        const pool = active.length > 0 ? active : markets;

        // PERC-352: Prefer SOL-PERP or SOL/USD by symbol match
        const solPerp = pool.find((m) => {
          const sym = (m.symbol ?? "").toUpperCase();
          return (
            sym === "SOL-PERP" ||
            sym === "SOL/USD" ||
            sym === "SOL" ||
            sym.startsWith("SOL-") ||
            sym.startsWith("SOL/")
          );
        });

        if (solPerp?.slab_address) {
          router.replace(`/trade/${solPerp.slab_address}`);
          return;
        }

        // Fallback: sort by activity — treat vol=0 and null as dead (-1) so stale
        // slabs don't win over fresh ones. Tiebreaker: OI DESC.
        const sorted = [...pool].sort((a, b) => {
          const va = typeof a.volume_24h === "number" && a.volume_24h > 0 ? a.volume_24h : -1;
          const vb = typeof b.volume_24h === "number" && b.volume_24h > 0 ? b.volume_24h : -1;
          if (vb !== va) return vb - va;
          const oa = typeof a.total_open_interest === "number" && a.total_open_interest > 0 ? a.total_open_interest : -1;
          const ob = typeof b.total_open_interest === "number" && b.total_open_interest > 0 ? b.total_open_interest : -1;
          return ob - oa;
        });

        const target = sorted[0];
        if (target?.slab_address) {
          router.replace(`/trade/${target.slab_address}`);
        } else {
          setNoMarkets(true);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load markets");
      }
    }

    pickMarket();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Error state
  if (error) {
    return (
      <div className="min-h-[calc(100vh-48px)] flex flex-col items-center justify-center gap-3">
        <div className="border border-[var(--short)]/30 bg-[var(--short)]/5 p-6 text-center max-w-md">
          <p className="text-sm font-medium text-[var(--short)]">
            Could not load markets
          </p>
          <p className="mt-2 text-[11px] text-[var(--text-secondary)]">
            {error}
          </p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <button
              onClick={() => window.location.reload()}
              className="border border-[var(--border)] px-4 py-1.5 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text)] transition-colors"
            >
              Retry
            </button>
            <Link
              href="/markets"
              className="border border-[var(--border)] px-4 py-1.5 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text)] transition-colors"
            >
              Browse Markets
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // No markets available
  if (noMarkets) {
    return (
      <div className="min-h-[calc(100vh-48px)] flex flex-col items-center justify-center gap-3">
        <div className="border border-[var(--border)]/50 bg-[var(--bg)]/80 p-6 text-center max-w-md">
          <p className="text-sm font-medium text-[var(--text)]">
            No markets available yet
          </p>
          <p className="mt-2 text-[11px] text-[var(--text-secondary)]">
            Be the first to create a perpetual market on Percolator.
          </p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <Link
              href="/create"
              className="border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-4 py-1.5 text-[11px] text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors"
            >
              Create Market
            </Link>
            <Link
              href="/markets"
              className="border border-[var(--border)] px-4 py-1.5 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text)] transition-colors"
            >
              Browse Markets
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // PERC-352: Skeleton loading state (replaces spinner)
  // Matches the trade page layout to reduce perceived loading time
  return (
    <div className="min-h-[calc(100vh-48px)]">
      {/* Mobile header skeleton */}
      <div className="sticky top-0 z-30 border-b border-[var(--border)]/50 bg-[var(--bg)]/95 px-3 py-2 backdrop-blur-sm lg:hidden">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShimmerSkeleton className="h-8 w-8 rounded-full" />
            <ShimmerSkeleton className="h-5 w-32" />
          </div>
          <ShimmerSkeleton className="h-6 w-20" />
        </div>
      </div>

      {/* Desktop header skeleton */}
      <div className="hidden lg:flex items-start justify-between px-4 py-2 gap-3 border-b border-[var(--border)]/30">
        <div className="min-w-0">
          <ShimmerSkeleton className="h-3 w-16 mb-2" />
          <div className="flex items-center gap-2.5">
            <ShimmerSkeleton className="h-12 w-12 rounded-full" />
            <ShimmerSkeleton className="h-7 w-40" />
          </div>
        </div>
        <ShimmerSkeleton className="h-8 w-24" />
      </div>

      {/* Mobile layout skeleton */}
      <div className="flex flex-col gap-1.5 px-2 pt-2 pb-4 lg:hidden">
        <ShimmerSkeleton className="h-[300px] w-full" />
        <ShimmerSkeleton className="h-[240px] w-full" />
      </div>

      {/* Desktop layout skeleton */}
      <div className="hidden lg:grid grid-cols-[1fr_340px] gap-1.5 px-3 pb-3 pt-1.5">
        <div className="min-w-0 space-y-1.5">
          <ShimmerSkeleton className="h-[500px] w-full" />
          <ShimmerSkeleton className="h-[200px] w-full" />
        </div>
        <div className="min-w-0 space-y-1.5">
          <ShimmerSkeleton className="h-[350px] w-full" />
          <ShimmerSkeleton className="h-[300px] w-full" />
        </div>
      </div>

      {/* Subtle loading indicator */}
      <div className="fixed bottom-20 md:bottom-4 left-1/2 -translate-x-1/2 z-50">
        <div className="flex items-center gap-2 rounded-sm border border-[var(--border)] bg-[var(--bg)]/95 px-3 py-1.5 backdrop-blur-sm">
          <div className="h-3 w-3 animate-spin rounded-full border border-[var(--accent)] border-t-transparent" />
          <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-[0.15em]">
            Loading SOL-PERP…
          </span>
        </div>
      </div>
    </div>
  );
}
