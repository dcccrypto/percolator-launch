"use client";

import { useEffect, useMemo, useRef, useState, type FC } from "react";
import Link from "next/link";
import useSWR from "swr";
import { MarketLogo } from "@/components/market/MarketLogo";
import { GlassCard } from "@/components/ui/GlassCard";
import { formatMarkPrice, formatStatValue } from "@/lib/format";
import { useAllMarketStats } from "@/hooks/useAllMarketStats";
import {
  MIN_LIQUIDITY_USD,
  type TrendingToken,
  type TrendingTokensResult,
} from "@/lib/trending-tokens";

/** Rows shown on the landing page. */
const RAIL_LIMIT = 8;

/** DEX display names (TrendingToken.dexId is always one of SUPPORTED_DEX_IDS). */
const DEX_LABEL: Record<string, string> = { pumpswap: "PumpSwap", meteora: "Meteora" };
const dexLabel = (id: string) => DEX_LABEL[id] ?? id;
const chartHost = (url: string) => (url.includes("geckoterminal.com") ? "GeckoTerminal" : "DexScreener");

/** User-facing copy. Exported so tests assert the exact strings. The table lists
 *  third-party tokens; nothing here may read as Percolator vetting them. */
export const TRENDING_COPY = {
  loading: "Loading trending tokens…",
  unavailable: "Trending data is unavailable right now.",
  empty: "No trending tokens match the listing filters right now.",
  disclaimer: "Third-party tokens, not reviewed by Percolator. Do your own research.",
  filters: `Shown: PumpSwap or Meteora pools quoted in SOL or USDC, liquidity ≥ $${(MIN_LIQUIDITY_USD / 1000).toFixed(0)}K, with no Percolator market yet. Data: GeckoTerminal, DexScreener.`,
} as const;

const shortCa = (ca: string) => `${ca.slice(0, 4)}…${ca.slice(-4)}`;

const fetcher = (url: string): Promise<TrendingTokensResult> =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`trending ${r.status}`);
    return r.json();
  });

/** Copy-to-clipboard contract-address chip with a brief "copied" confirmation. */
const CopyCa: FC<{ ca: string }> = ({ ca }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(ca);
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1200);
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
    {/* Clicking the token opens its pool chart (DexScreener / GeckoTerminal) in a new tab. */}
    <a
      href={t.chartUrl}
      target="_blank"
      rel="noopener noreferrer nofollow"
      title={`View the ${t.symbol} pool on ${chartHost(t.chartUrl)}`}
      className="group/tok flex min-w-0 flex-1 items-center gap-3 focus-visible:outline-none sm:gap-4"
    >
      <MarketLogo logoUrl={t.logoUrl} mainnetCa={t.mint} symbol={t.symbol} size="sm" decorative />
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold text-[var(--text)] transition-colors group-hover/tok:text-[var(--accent-text)]">{t.symbol}</div>
        <div className="hidden truncate text-[11px] text-[var(--text-secondary)] sm:block">{t.name}</div>
      </div>
    </a>

    <div className="hidden shrink-0 sm:block" style={{ minWidth: 72 }}>
      <span className="rounded-sm border border-[var(--border)] bg-[var(--accent)]/[0.04] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--text-secondary)]">
        {dexLabel(t.dexId)}
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

    {/* Hands ONLY the mint to the wizard, which runs its own pool search, USD-quote and
        keeper-floor checks and duplicate-market check — no pool is pre-selected here. */}
    <Link
      href={`/create?mint=${encodeURIComponent(t.mint)}`}
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
    <div className="hidden shrink-0 sm:block" style={{ minWidth: 72 }}>DEX</div>
    <div className="hidden shrink-0 lg:block" style={{ minWidth: 92 }}>Contract</div>
    <div className="hidden shrink-0 text-right sm:block" style={{ minWidth: 68 }}>Market Cap</div>
    <div className="hidden shrink-0 text-right md:block" style={{ minWidth: 68 }}>24h Vol</div>
    <div className="shrink-0 text-right" style={{ minWidth: 84 }}>Price</div>
    {/* trailing spacer ~ the Create Market button */}
    <div className="shrink-0" style={{ width: 92 }} />
  </div>
);

/**
 * Landing-page "Trending on Solana DEXs" rail — third-party tokens trending on
 * Solana DEXs (lib/trending-tokens) that do NOT yet have a Percolator market, each
 * with a Create Market CTA that deep-links the wizard prefilled with the mint.
 * Polls /api/trending-tokens every 60s (CDN-cached for 60s).
 *
 * States, each with its own copy: loading; unavailable (our API failed, or every
 * upstream source failed — `sourceEmpty`); empty (sources answered, nothing
 * matched the filters); rows.
 */
export function TrendingTokensRail() {
  const { data, error } = useSWR<TrendingTokensResult>("/api/trending-tokens", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: false,
    dedupingInterval: 30_000,
  });
  const { statsMap, loading: statsLoading, error: statsError } = useAllMarketStats();

  // Exclude tokens that already have a Percolator market (any row /api/markets
  // returns, zombies included) — matched on the market's mainnet_ca.
  const listedCa = useMemo(() => {
    const set = new Set<string>();
    for (const m of statsMap.values()) if (m.mainnet_ca) set.add(m.mainnet_ca);
    return set;
  }, [statsMap]);

  // Hold rows until the market list has loaded, so an already-listed token never
  // flashes up with a Create CTA. If the market list fails, the wizard's own
  // duplicate-market check still stands, so rows are shown rather than hidden forever.
  const marketsKnown = !statsLoading || statsMap.size > 0 || !!statsError;

  const rows = useMemo(
    () => (marketsKnown ? (data?.tokens ?? []).filter((t) => !listedCa.has(t.mint)).slice(0, RAIL_LIMIT) : []),
    [data, listedCa, marketsKnown],
  );

  let message: string | null = null;
  if (rows.length === 0) {
    if (error || data?.sourceEmpty) message = TRENDING_COPY.unavailable;
    else if (!data || !marketsKnown) message = TRENDING_COPY.loading;
    else message = TRENDING_COPY.empty;
  }

  return (
    <div>
      <GlassCard padding="none" elevation="md" className="overflow-hidden" hover={false}>
        <TrendingHeader />
        {rows.map((t, i) => (
          <TrendingRow key={t.mint} t={t} isLast={i === rows.length - 1} />
        ))}
        {message && (
          <div
            role="status"
            data-state={message === TRENDING_COPY.unavailable ? "unavailable" : message === TRENDING_COPY.empty ? "empty" : "loading"}
            className="px-4 py-6 text-center text-[11px] text-[var(--text-secondary)]"
          >
            {message}
          </div>
        )}
      </GlassCard>
      <p className="mt-3 text-[10px] leading-relaxed text-[var(--text-dim)]">
        {TRENDING_COPY.disclaimer} {TRENDING_COPY.filters}
      </p>
    </div>
  );
}
