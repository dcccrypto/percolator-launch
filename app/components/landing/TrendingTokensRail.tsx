"use client";

import { useMemo, useState, type FC } from "react";
import Link from "next/link";
import useSWR from "swr";
import { MarketLogo } from "@/components/market/MarketLogo";
import { GlassCard } from "@/components/ui/GlassCard";
import { formatMarkPrice, formatStatValue } from "@/lib/format";
import { useAllMarketStats } from "@/hooks/useAllMarketStats";
import type { TrendingToken, TrendingTokensResult } from "@/lib/trending-tokens";

/** Rows shown on the landing page; "All tokens" could later deep-link a full view. */
const RAIL_LIMIT = 8;

const LAUNCHPAD_LABEL: Record<TrendingToken["launchpad"], string> = {
  pumpfun: "Pump.fun",
};

const shortCa = (ca: string) => `${ca.slice(0, 4)}…${ca.slice(-4)}`;

const fetcher = (url: string): Promise<TrendingTokensResult> =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`trending ${r.status}`);
    return r.json();
  });

/** Copy-to-clipboard contract-address chip with a brief "copied" confirmation. */
const CopyCa: FC<{ ca: string }> = ({ ca }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(ca);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard blocked — no-op */
        }
      }}
      title={`Copy contract address\n${ca}`}
      aria-label={copied ? "Contract address copied" : `Copy contract address ${ca}`}
      className="inline-flex items-center gap-1.5 rounded-sm border border-[var(--border)] px-2 py-1 font-mono text-[10px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/40 hover:text-[var(--text)]"
    >
      <span className="tabular-nums">{shortCa(ca)}</span>
      <span aria-hidden="true" className={copied ? "text-[var(--long)]" : ""}>{copied ? "✓" : "⧉"}</span>
    </button>
  );
};

const TrendingRow: FC<{ t: TrendingToken; isLast: boolean }> = ({ t, isLast }) => (
  <div
    className={[
      "flex items-center gap-3 px-4 py-3.5 sm:gap-4",
      isLast ? "" : "border-b border-[var(--border)]",
    ].join(" ")}
  >
    <MarketLogo logoUrl={t.logoUrl} mainnetCa={t.mint} symbol={t.symbol} size="sm" decorative />

    <div className="min-w-0 flex-1">
      <div className="truncate text-[13px] font-semibold text-[var(--text)]">{t.symbol}</div>
      <div className="hidden truncate text-[11px] text-[var(--text-secondary)] sm:block">{t.name}</div>
    </div>

    <div className="hidden shrink-0 sm:block" style={{ minWidth: 72 }}>
      <span className="rounded-sm border border-[var(--border)] bg-[var(--accent)]/[0.04] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--text-secondary)]">
        {LAUNCHPAD_LABEL[t.launchpad]}
      </span>
    </div>

    <div className="hidden shrink-0 lg:block" style={{ minWidth: 92 }}>
      <CopyCa ca={t.mint} />
    </div>

    <div
      className="hidden shrink-0 text-right font-mono text-[11px] text-[var(--text-secondary)] sm:block"
      style={{ minWidth: 68 }}
    >
      {formatStatValue(t.marketCapUsd, "currency")}
    </div>

    <div
      className="hidden shrink-0 text-right font-mono text-[11px] text-[var(--text-secondary)] md:block"
      style={{ minWidth: 68 }}
    >
      {formatStatValue(t.volume24hUsd, "currency")}
    </div>

    <div className="shrink-0 text-right font-mono text-[13px] font-semibold tabular-nums text-[var(--text)]" style={{ minWidth: 84 }}>
      {formatMarkPrice(t.priceUsd)}
    </div>

    <Link
      href={`/create?mint=${t.mint}`}
      className="group shrink-0 rounded-sm border border-[var(--accent)]/40 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10 hover:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    >
      <span className="hidden sm:inline">Create Market </span>
      <span className="sm:hidden">Create </span>→
    </Link>
  </div>
);

const TrendingHeader: FC = () => (
  <div
    aria-hidden="true"
    className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--accent)]/[0.02] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--text-dim)] sm:gap-4"
  >
    <div className="shrink-0" style={{ width: 24 }} />
    <div className="min-w-0 flex-1">Token</div>
    <div className="hidden shrink-0 sm:block" style={{ minWidth: 72 }}>Launchpad</div>
    <div className="hidden shrink-0 lg:block" style={{ minWidth: 92 }}>Contract</div>
    <div className="hidden shrink-0 text-right sm:block" style={{ minWidth: 68 }}>Market Cap</div>
    <div className="hidden shrink-0 text-right md:block" style={{ minWidth: 68 }}>24h Vol</div>
    <div className="shrink-0 text-right" style={{ minWidth: 84 }}>Price</div>
    {/* trailing spacer ~ the Create Market button */}
    <div className="shrink-0" style={{ width: 92 }} />
  </div>
);

/**
 * Landing-page "Tokens Trending" rail — trending launchpad tokens (pump.fun) that
 * pass the safety screen (lib/trending-tokens) and do NOT yet have a Percolator
 * perp, each with a Create Market CTA that deep-links the wizard prefilled with
 * the token's mint. Data polls /api/trending-tokens every 15s (that route is
 * CDN-cached, so this is cheap regardless of how many visitors are on the page).
 */
export function TrendingTokensRail() {
  const { data, error, isLoading } = useSWR<TrendingTokensResult>("/api/trending-tokens", fetcher, {
    refreshInterval: 15_000,
    revalidateOnFocus: false,
    dedupingInterval: 10_000,
  });
  const { statsMap } = useAllMarketStats();

  // Exclude tokens that already have a Percolator perp — it's "trending tokens
  // WITHOUT a perp market". Match on the market's mainnet_ca (the same mainnet
  // mint a trending token carries).
  const listedCa = useMemo(() => {
    const set = new Set<string>();
    for (const m of statsMap.values()) if (m.mainnet_ca) set.add(m.mainnet_ca);
    return set;
  }, [statsMap]);

  const rows = useMemo(
    () => (data?.tokens ?? []).filter((t) => !listedCa.has(t.mint)).slice(0, RAIL_LIMIT),
    [data, listedCa],
  );

  return (
    <GlassCard padding="none" elevation="md" className="overflow-hidden" hover={false}>
      <TrendingHeader />
      {rows.map((t, i) => (
        <TrendingRow key={t.mint} t={t} isLast={i === rows.length - 1} />
      ))}
      {rows.length === 0 && (error || !isLoading) && (
        <div className="px-4 py-6 text-center text-[11px] text-[var(--text-secondary)]">
          {error
            ? "Couldn't load trending tokens right now."
            : "No trending tokens clear the safety screen right now — check back soon."}
        </div>
      )}
    </GlassCard>
  );
}
