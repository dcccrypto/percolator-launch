"use client";

import { useCallback, useMemo, useState, useSyncExternalStore, type FC } from "react";
import Link from "next/link";
import useSWR from "swr";
import { MarketLogo } from "@/components/market/MarketLogo";
import { GlassCard } from "@/components/ui/GlassCard";
import { formatMarkPrice, formatStatValue } from "@/lib/format";
import { rowVolumeUsd, qToUsd } from "@/lib/q-usd";
import { subscribeSlab, getSnapshot } from "@/lib/priceStore/priceStore";
import { usePriceFlash } from "@/hooks/usePriceFlash";
import { useAllMarketStats, type MarketWithStats } from "@/hooks/useAllMarketStats";
import { isListedMarketRow } from "@/lib/listed-markets";
import {
  SegmentedControl,
  RailControl,
  COUNT_OPTIONS,
  DEFAULT_RAIL_COUNT,
  type RailCount,
} from "@/components/landing/RailFilter";

/** Decorative right-chevron — same mark the landing page's CTAs use. */
const ARROW = (
  <svg
    className="hidden h-3.5 w-3.5 shrink-0 text-[var(--text-dim)] transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-[var(--accent)] sm:block"
    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
  >
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
);

/** 24h change from the SAME source useLivePrice uses (/api/prices stats), on the
 *  same 10s cadence — the price store's change24h isn't seeded on the landing
 *  page, and the markets row's price_change_pct is unpopulated. Price itself stays
 *  per-tick live via the store (below); this is only the slower 24h aggregate. */
const STATS_SWR = { dedupingInterval: 10_000, refreshInterval: 10_000, revalidateOnFocus: false, shouldRetryOnError: false } as const;
const statsFetcher = (url: string): Promise<{ stats?: { change24h?: number | null } | null }> =>
  fetch(url).then((r) => (r.ok ? r.json() : { stats: null }));

function formatChangePct(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return "—";
  if (pct === 0) return "0.0%";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

/** Stable getServerSnapshot (SSR/first paint) — null price until the store ticks. */
const RETURN_NULL = () => null;

interface RailRowProps {
  slab: string;
  symbol: string;
  name: string;
  mainnetCa: string | null;
  fallbackPrice: number | null;
  volume24h: number | null;
  oiUsd: number | null;
  maxLeverage: number | null;
  isLast: boolean;
}

/**
 * One rail row — subscribes ITSELF to the shared price store for the live price
 * (two narrow selectors: priceUsd for the label, priceE6 for the flash), and
 * pulls the 24h change on a slow 10s poll. A price tick re-renders only this row.
 */
const RailRow: FC<RailRowProps> = ({ slab, symbol, name, mainnetCa, fallbackPrice, volume24h, oiUsd, maxLeverage, isLast }) => {
  const subscribe = useCallback((cb: () => void) => subscribeSlab(slab, cb), [slab]);
  const getPriceUsd = useCallback(() => getSnapshot(slab).priceUsd, [slab]);
  const getPriceE6 = useCallback(() => getSnapshot(slab).priceE6, [slab]);
  const livePriceUsd = useSyncExternalStore(subscribe, getPriceUsd, RETURN_NULL);
  const livePriceE6 = useSyncExternalStore(subscribe, getPriceE6, RETURN_NULL);

  const { data: pricesJson } = useSWR(`/api/prices/${slab}`, statsFetcher, STATS_SWR);
  const change24h = pricesJson?.stats?.change24h ?? null;

  const flash = usePriceFlash(livePriceE6);
  const tintClass = flash === "up" ? "text-[var(--long)]" : flash === "down" ? "text-[var(--short)]" : "text-[var(--text)]";
  const changeClass =
    change24h == null || change24h === 0
      ? "text-[var(--text-dim)]"
      : change24h > 0
        ? "text-[var(--long)]"
        : "text-[var(--short)]";

  const priceLabel = formatMarkPrice(livePriceUsd ?? fallbackPrice);
  const displaySymbol = symbol.replace(/-PERP$/, "");

  return (
    <Link
      href={`/trade/${slab}`}
      className={[
        "group flex items-center gap-3 px-4 py-3.5 transition-colors duration-150 hover:bg-[var(--accent)]/[0.04]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]",
        "sm:gap-4",
        isLast ? "" : "border-b border-[var(--border)]",
      ].join(" ")}
    >
      <MarketLogo mainnetCa={mainnetCa} symbol={displaySymbol} size="sm" decorative />

      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold text-[var(--text)]">{displaySymbol}</div>
        <div className="hidden truncate text-[11px] text-[var(--text-secondary)] sm:block">{name}</div>
      </div>

      {/* Max Lev */}
      <div className="hidden shrink-0 text-right font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--text-secondary)] sm:block" style={{ width: 56 }}>
        {maxLeverage != null ? `${maxLeverage}x` : "—"}
      </div>
      {/* 24h Vol */}
      <div className="hidden shrink-0 text-right font-mono text-[11px] text-[var(--text-secondary)] md:block" style={{ width: 68 }}>
        {formatStatValue(volume24h, "currency")}
      </div>
      {/* Open Interest */}
      <div className="hidden shrink-0 text-right font-mono text-[11px] text-[var(--text-secondary)] lg:block" style={{ width: 98 }}>
        {formatStatValue(oiUsd, "currency")}
      </div>
      {/* Price (live) */}
      <div className={["shrink-0 text-right font-mono text-[13px] font-semibold tabular-nums transition-colors duration-300", tintClass].join(" ")} style={{ width: 88 }}>
        {priceLabel}
      </div>
      {/* 24h Change */}
      <div className={["hidden shrink-0 text-right font-mono text-[11px] tabular-nums sm:block", changeClass].join(" ")} style={{ width: 76 }}>
        {formatChangePct(change24h)}
      </div>
      {/* Trade — visual affordance; the whole row is the link. */}
      <span className="hidden shrink-0 rounded-sm border border-[var(--accent)]/40 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--accent-text)] transition-colors group-hover:bg-[var(--accent)]/10 group-hover:border-[var(--accent)] sm:inline-flex sm:items-center" style={{ width: 70, justifyContent: "center" }}>
        Trade
      </span>
      {ARROW}
    </Link>
  );
};

/** Column header row — mirrors RailRow's flex layout exactly. aria-hidden; visual key only. */
const RailHeader: FC = () => (
  <div
    aria-hidden="true"
    className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--accent)]/[0.02] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--text-dim)] sm:gap-4"
  >
    <div className="shrink-0" style={{ width: 24 }} />
    <div className="min-w-0 flex-1">Market</div>
    <div className="hidden shrink-0 text-right sm:block" style={{ width: 56 }}>Max Lev</div>
    <div className="hidden shrink-0 text-right md:block" style={{ width: 68 }}>24h Vol</div>
    <div className="hidden shrink-0 text-right lg:block" style={{ width: 98 }}>Open Interest</div>
    <div className="shrink-0 text-right" style={{ width: 88 }}>Price</div>
    <div className="hidden shrink-0 text-right sm:block" style={{ width: 76 }}>24h Change</div>
    <div className="hidden shrink-0 sm:block" style={{ width: 70 }} />
    <div className="hidden h-3.5 w-3.5 shrink-0 sm:block" />
  </div>
);

/**
 * The landing page's live market rail — real devnet markets, real ticking prices.
 * Rows come from /api/markets (same source as /markets), filtered with
 * isListedMarketRow(), ranked "trending" by 24h platform volume desc, top `count`
 * (a 5/10/20 control). Each row subscribes to the price store for its live price
 * and polls /api/prices for the 24h change.
 */
export function LiveMarketRail() {
  const { statsMap, loading, error } = useAllMarketStats();
  const [count, setCount] = useState<RailCount>(DEFAULT_RAIL_COUNT);

  const rows = useMemo(
    () =>
      [...statsMap.values()]
        .filter((m) => !!m.slab_address && isListedMarketRow(m.slab_address, m))
        .sort(
          (a, b) =>
            (rowVolumeUsd(b) ?? 0) - (rowVolumeUsd(a) ?? 0) ||
            (a.slab_address as string).localeCompare(b.slab_address as string),
        )
        .slice(0, Number(count)),
    [statsMap, count],
  );

  // Prefer the server-enriched OI USD when /api/markets attached it (not on the
  // view's TS type), else derive it from the OI "Q" amount at the row's price —
  // same convention as rowVolumeUsd / the trade page's oiUsd.
  const oiOf = (m: MarketWithStats): number | null => {
    const usd = (m as { total_open_interest_usd?: number | null }).total_open_interest_usd;
    if (typeof usd === "number" && Number.isFinite(usd)) return usd;
    return qToUsd(m.total_open_interest, m.last_price);
  };

  return (
    <GlassCard padding="none" elevation="md" className="overflow-hidden" hover={false}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--text-dim)]">
          Trending by 24h volume · live prices
        </span>
        <RailControl label="Show">
          <SegmentedControl value={count} onChange={setCount} options={COUNT_OPTIONS} ariaLabel="Rows to show" />
        </RailControl>
      </div>
      <RailHeader />
      {rows.map((m, i) => {
        const slab = m.slab_address as string;
        return (
          <RailRow
            key={slab}
            slab={slab}
            symbol={m.symbol || `${slab.slice(0, 4)}…${slab.slice(-4)}`}
            name={m.name ?? ""}
            mainnetCa={m.mainnet_ca}
            fallbackPrice={m.last_price ?? null}
            volume24h={rowVolumeUsd(m) || null}
            oiUsd={oiOf(m)}
            maxLeverage={m.max_leverage ?? null}
            isLast={i === rows.length - 1}
          />
        );
      })}
      {rows.length === 0 && (error || !loading) && (
        <div className="px-4 py-6 text-center text-[11px] text-[var(--text-secondary)]">
          {error ? (
            <Link href="/markets" className="hover:text-[var(--accent)]">Couldn&apos;t load markets. Open the market list</Link>
          ) : (
            <Link href="/create" className="hover:text-[var(--accent)]">No markets yet. Create the first one</Link>
          )}
        </div>
      )}
    </GlassCard>
  );
}
