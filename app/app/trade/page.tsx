"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

/**
 * /trade (no slab parameter)
 *
 * Redirects to the highest-volume active market.
 * Falls back to the markets browser if no markets are available.
 *
 * Fixes: GitHub issue #480 — /trade was returning 404 because
 * the only trade route was /trade/[slab] (dynamic segment required).
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

        // Pick by highest 24h volume, falling back to first active, then first overall
        const sorted = [...(active.length > 0 ? active : markets)].sort(
          (a, b) => (b.volume_24h ?? 0) - (a.volume_24h ?? 0)
        );

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

  // Loading / redirecting
  return (
    <div className="min-h-[calc(100vh-48px)] flex flex-col items-center justify-center gap-3">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
      <p className="text-[11px] text-[var(--text-muted)] uppercase tracking-[0.15em]">
        Finding best market…
      </p>
    </div>
  );
}
