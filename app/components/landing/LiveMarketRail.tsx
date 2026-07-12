"use client";

import { useCallback, useEffect, useState, useSyncExternalStore, type FC } from "react";
import Link from "next/link";
import { MarketLogo } from "@/components/market/MarketLogo";
import { GlassCard } from "@/components/ui/GlassCard";
import { formatMarkPrice, formatStatValue } from "@/lib/format";
import { subscribeSlab, getSnapshot } from "@/lib/priceStore/priceStore";
import { usePriceFlash } from "@/hooks/usePriceFlash";
import { useAllMarketStats } from "@/hooks/useAllMarketStats";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";

/** Decorative right-chevron — same mark used by every other CTA on the
 *  landing page (see app/app/page.tsx's ARROW), duplicated here rather than
 *  imported since it's a leaf presentational constant, not shared state. */
const ARROW = (
  <svg
    className="hidden h-3.5 w-3.5 shrink-0 text-[var(--text-dim)] transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-[var(--accent)] sm:block"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
);

/**
 * Fires once, ~`delayMs` after mount. Used to defer the rail's secondary
 * (volume / max-leverage) stats fetch so it doesn't compete on the network
 * for the same tick as the hero's ScrollReveal/gsap work and the live price
 * WS handshake — those are the primary signal and should paint first. The
 * fetch itself is cheap once it fires (SWR-shared, 30s dedup), this just
 * changes *when* it's kicked off.
 */
function useDeferredMount(delayMs = 250): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setReady(true), delayMs);
    return () => window.clearTimeout(id);
  }, [delayMs]);
  return ready;
}

/** The six born-immortal curated devnet markets (lib/playground-slab-meta.ts) —
 *  a fixed, ordered set so the rail never reflows as data loads (zero layout
 *  shift). Real on-chain markets, not mock data. */
const RAIL_SLABS = Object.keys(PLAYGROUND_SLAB_META);

interface RailRowProps {
  slab: string;
  symbol: string;
  name: string;
  mainnetCa: string;
  fallbackPrice: number | null;
  volume24h: number | null;
  maxLeverage: number | null;
  isLast: boolean;
}

/**
 * One rail row — subscribes ITSELF to the shared price store
 * (lib/priceStore/priceStore.ts), mirroring the `LiveRowPrice` leaf pattern
 * already proven on app/markets/page.tsx. Two narrow selectors (priceUsd for
 * the label, priceE6 for the flash) rather than one subscription to the
 * whole `PriceState` object — `PriceState` also carries change24h/high24h/
 * low24h/loading, none of which this row renders, so a store update to any
 * of those (e.g. `setStats24h`) would otherwise re-render this row for
 * nothing. A tick re-renders only this row, never the rail or the page —
 * no new WebSocket, no page-level re-render.
 */
const RailRow: FC<RailRowProps> = ({
  slab,
  symbol,
  name,
  mainnetCa,
  fallbackPrice,
  volume24h,
  maxLeverage,
  isLast,
}) => {
  const subscribe = useCallback((cb: () => void) => subscribeSlab(slab, cb), [slab]);
  const getPriceUsd = useCallback(() => getSnapshot(slab).priceUsd, [slab]);
  const getPriceE6 = useCallback(() => getSnapshot(slab).priceE6, [slab]);
  const getServerPriceUsd = useCallback(() => null, []);
  const getServerPriceE6 = useCallback(() => null, []);
  const livePriceUsd = useSyncExternalStore(subscribe, getPriceUsd, getServerPriceUsd);
  const livePriceE6 = useSyncExternalStore(subscribe, getPriceE6, getServerPriceE6);

  // Same green/up · red/down tick-flash micro-interaction used across the
  // trade terminal (MarketInfoBar / PositionsDock), keyed on the store's
  // post-invert priceE6 so it fires exactly when a real tick lands.
  const flash = usePriceFlash(livePriceE6);
  const tintClass =
    flash === "up" ? "text-[var(--long)]" : flash === "down" ? "text-[var(--short)]" : "text-[var(--text)]";

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
      {/* decorative: the symbol text right next to it already gives the
          logo's accessible name — an alt/initials duplicate would make the
          link's a11y name read "SOL SOL". */}
      <MarketLogo mainnetCa={mainnetCa} symbol={displaySymbol} size="sm" decorative />

      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold text-[var(--text)]">{displaySymbol}</div>
        <div className="hidden truncate text-[11px] text-[var(--text-secondary)] sm:block">{name}</div>
      </div>

      {/* Slot is always rendered (never conditionally omitted) so arriving
          stats don't pop the column in and shove the price/arrow — matches
          the volume column below, which formatStatValue already placeholds
          with "—". */}
      <div
        className="hidden shrink-0 text-right font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--text-secondary)] sm:block"
        style={{ minWidth: 28 }}
      >
        {maxLeverage != null ? `${maxLeverage}x` : "—"}
      </div>

      <div
        className="hidden shrink-0 text-right font-mono text-[11px] text-[var(--text-secondary)] md:block"
        style={{ minWidth: 68 }}
      >
        {formatStatValue(volume24h, "currency")}
      </div>

      <div
        className={[
          "shrink-0 text-right font-mono text-[13px] font-semibold tabular-nums transition-colors duration-300",
          tintClass,
        ].join(" ")}
        style={{ minWidth: 84 }}
      >
        {priceLabel}
      </div>

      {ARROW}
    </Link>
  );
};

/**
 * The landing page's live market rail — real devnet markets, real ticking
 * prices, zero decoration. Row identity/order is fixed (RAIL_SLABS) so
 * arriving stats/ticks never reflow the list; only price text + color update.
 *
 * The secondary volume/max-leverage stats (`useAllMarketStats`, a ~500-market
 * fetch) are deferred a beat past mount so the primary signal — logo, symbol,
 * and the live price off `priceStore` — never waits on it. Each row already
 * subscribes to `priceStore` directly regardless of this gate.
 */
export function LiveMarketRail() {
  const statsEnabled = useDeferredMount();
  const { statsMap } = useAllMarketStats({ enabled: statsEnabled });

  return (
    <GlassCard padding="none" elevation="md" className="overflow-hidden" hover={false}>
      {RAIL_SLABS.map((slab, i) => {
        const meta = PLAYGROUND_SLAB_META[slab];
        const stats = statsMap.get(slab);
        return (
          <RailRow
            key={slab}
            slab={slab}
            symbol={meta.symbol}
            name={meta.name}
            mainnetCa={meta.mainnet_ca}
            fallbackPrice={stats?.last_price ?? null}
            // `|| null` (not `?? null`): a literal 0 here means "trade-tape
            // indexer has no data", not "zero volume" — /markets renders the
            // same state as "—", and this rail showed "$0.00" for it. Map 0
            // to null so formatStatValue renders the same "—" convention.
            volume24h={stats?.volume_24h || null}
            maxLeverage={stats?.max_leverage ?? null}
            isLast={i === RAIL_SLABS.length - 1}
          />
        );
      })}
    </GlassCard>
  );
}
