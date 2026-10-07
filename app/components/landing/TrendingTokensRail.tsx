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
  rankForTimeframe,
  volumeForTimeframe,
  changeForTimeframe,
  type Timeframe,
  type TrendingToken,
  type TrendingTokensResult,
} from "@/lib/trending-tokens";
import {
  SegmentedControl,
  RailControl,
  COUNT_OPTIONS,
  DEFAULT_RAIL_COUNT,
  type RailCount,
} from "@/components/landing/RailFilter";

/** How often the client re-polls the list; the API response is CDN-cached for the same. */
const REFRESH_MS = 60_000;

/** Shared FIXED column widths (px) — used by BOTH the header and the rows. Each is
 *  sized to fit the widest of {header label, cell data}, and applied as `width` (not
 *  `minWidth`) so a long uppercase label can't grow the header cell and nudge the
 *  columns to its right out of line with the data. */
const W = { dex: 72, ca: 100, mc: 80, vol: 72, chg: 64, trend: 52, price: 92 } as const;
/** The Create-Market button has a FIXED width, matched by the header's trailing spacer,
 *  so the right-hand columns line up with their labels (not pushed by the button). */
const CTA_W = "w-[104px] sm:w-[132px]";

const TF_OPTIONS = [
  { value: "1h", label: "1H" },
  { value: "24h", label: "24H" },
] as const;

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

function formatChangePct(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return "—";
  if (pct === 0) return "0.0%";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

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

/** Tiny volume-rate sparkline: avg hourly $ volume over [24h, 6h, 1h, 5m]. Rising bars
 *  = activity accelerating. Coloured by overall direction; the newest bar is solid. */
const TrendBars: FC<{ series: number[] }> = ({ series }) => {
  const s = series.length ? series : [0, 0, 0, 0];
  const max = Math.max(...s, Number.EPSILON);
  const up = s[s.length - 1] >= s[0];
  const color = up ? "var(--long)" : "var(--short)";
  const bw = 7;
  const gap = 4;
  const H = 18;
  return (
    <svg width={(bw + gap) * s.length - gap} height={H} viewBox={`0 0 ${(bw + gap) * s.length - gap} ${H}`} aria-hidden="true" className="block">
      {s.map((v, i) => {
        const h = Math.max(2, (v / max) * (H - 2));
        return (
          <rect
            key={i}
            x={i * (bw + gap)}
            y={H - h}
            width={bw}
            height={h}
            rx={1.5}
            fill={color}
            opacity={i === s.length - 1 ? 1 : 0.3 + 0.15 * i}
          />
        );
      })}
    </svg>
  );
};

const TrendingRow: FC<{ t: TrendingToken; tf: Timeframe; isLast: boolean }> = ({ t, tf, isLast }) => {
  const change = changeForTimeframe(t, tf);
  const changeClass =
    change == null || change === 0
      ? "text-[var(--text-dim)]"
      : change > 0
        ? "text-[var(--long)]"
        : "text-[var(--short)]";
  return (
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

      <div className="hidden shrink-0 sm:block" style={{ width: W.dex }}>
        <span className="rounded-sm border border-[var(--border)] bg-[var(--accent)]/[0.04] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--text-secondary)]">
          {dexLabel(t.dexId)}
        </span>
      </div>

      <div className="hidden shrink-0 lg:block" style={{ width: W.ca }}>
        <CopyCa ca={t.mint} />
      </div>

      <div className="hidden shrink-0 text-right font-mono text-[11px] text-[var(--text-secondary)] sm:block" style={{ width: W.mc }}>
        {formatStatValue(t.marketCapUsd, "currency")}
      </div>

      {/* Volume — swaps with the selected timeframe. */}
      <div className="hidden shrink-0 text-right font-mono text-[11px] text-[var(--text-secondary)] md:block" style={{ width: W.vol }}>
        {formatStatValue(volumeForTimeframe(t, tf), "currency")}
      </div>

      {/* Change — swaps with the timeframe, coloured green/red. */}
      <div className={["hidden shrink-0 text-right font-mono text-[11px] tabular-nums md:block", changeClass].join(" ")} style={{ width: W.chg }}>
        {formatChangePct(change)}
      </div>

      {/* Trend — volume-rate sparkline. */}
      <div className="hidden shrink-0 lg:flex lg:justify-end" style={{ width: W.trend }}>
        <TrendBars series={t.trend ?? []} />
      </div>

      <div className="shrink-0 text-right font-mono text-[13px] font-semibold tabular-nums text-[var(--text)]" style={{ width: W.price }}>
        {formatMarkPrice(t.priceUsd)}
      </div>

      {/* Hands ONLY the mint to the wizard, which runs its own pool search, USD-quote and
          keeper-floor checks and duplicate-market check — no pool is pre-selected here. */}
      <Link
        href={`/create?mint=${encodeURIComponent(t.mint)}`}
        className={[
          CTA_W,
          "group inline-flex shrink-0 items-center justify-center rounded-sm border border-[var(--accent)]/40 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10 hover:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        ].join(" ")}
      >
        <span className="hidden sm:inline">Create Market&nbsp;</span>
        <span className="sm:hidden">Create&nbsp;</span>→
      </Link>
    </div>
  );
};

const TrendingHeader: FC<{ tf: Timeframe }> = ({ tf }) => (
  <div
    aria-hidden="true"
    className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--accent)]/[0.02] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--text-dim)] sm:gap-4"
  >
    <div className="min-w-0 flex-1">Token</div>
    <div className="hidden shrink-0 sm:block" style={{ width: W.dex }}>DEX</div>
    <div className="hidden shrink-0 lg:block" style={{ width: W.ca }}>Contract</div>
    <div className="hidden shrink-0 text-right sm:block" style={{ width: W.mc }}>Market Cap</div>
    <div className="hidden shrink-0 text-right md:block" style={{ width: W.vol }}>{tf === "1h" ? "1h Vol" : "24h Vol"}</div>
    <div className="hidden shrink-0 text-right md:block" style={{ width: W.chg }}>{tf === "1h" ? "1h %" : "24h %"}</div>
    <div className="hidden shrink-0 text-right lg:block" style={{ width: W.trend }}>Trend</div>
    <div className="shrink-0 text-right" style={{ width: W.price }}>Price</div>
    {/* trailing spacer = the Create Market button's fixed width, so columns stay aligned */}
    <div className={[CTA_W, "shrink-0"].join(" ")} />
  </div>
);

/**
 * Landing-page "Trending on Solana DEXs" rail — third-party tokens trending on
 * Solana DEXs (lib/trending-tokens) that do NOT yet have a Percolator market, each
 * with a Create Market CTA that deep-links the wizard prefilled with the mint.
 * Polls /api/trending-tokens every 60s (CDN-cached for 60s). A 1H/24H timeframe
 * re-ranks by that window's momentum; a 5/10/20 control sets how many rows show.
 *
 * States, each with its own copy: loading; unavailable (our API failed, every
 * candidate source failed, or the DexScreener lookup failed and left nothing —
 * `sourceEmpty`); empty (every lookup answered, nothing matched the filters); rows.
 */
export function TrendingTokensRail() {
  // Default to 1H: the point of the list is to surface momentum as it builds.
  const [tf, setTf] = useState<Timeframe>("1h");
  const [count, setCount] = useState<RailCount>(DEFAULT_RAIL_COUNT);

  const { data, error } = useSWR<TrendingTokensResult>("/api/trending-tokens", fetcher, {
    refreshInterval: REFRESH_MS,
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

  const rows = useMemo(() => {
    if (!marketsKnown) return [];
    const unlisted = (data?.tokens ?? []).filter((t) => !listedCa.has(t.mint));
    return rankForTimeframe(unlisted, tf).slice(0, Number(count));
  }, [data, listedCa, marketsKnown, tf, count]);

  let message: string | null = null;
  if (rows.length === 0) {
    if (error || data?.sourceEmpty) message = TRENDING_COPY.unavailable;
    else if (!data || !marketsKnown) message = TRENDING_COPY.loading;
    else message = TRENDING_COPY.empty;
  }

  return (
    <div>
      <GlassCard padding="none" elevation="md" className="overflow-hidden" hover={false}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--text-dim)]">
            Live · updates every 60s
          </span>
          <div className="flex items-center gap-3">
            <RailControl label="Window">
              <SegmentedControl value={tf} onChange={setTf} options={TF_OPTIONS} ariaLabel="Trending timeframe" />
            </RailControl>
            <RailControl label="Show">
              <SegmentedControl value={count} onChange={setCount} options={COUNT_OPTIONS} ariaLabel="Rows to show" />
            </RailControl>
          </div>
        </div>
        <TrendingHeader tf={tf} />
        {rows.map((t, i) => (
          <TrendingRow key={t.mint} t={t} tf={tf} isLast={i === rows.length - 1} />
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
