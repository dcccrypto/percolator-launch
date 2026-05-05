"use client";

import { FC, useState, useRef, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useAllMarketStats } from "@/hooks/useAllMarketStats";
import { useLivePrice } from "@/hooks/useLivePrice";
import { MarketLogo } from "@/components/market/MarketLogo";
import { formatUsdPriceE6, formatUsdFromNumber } from "@/lib/format";

interface MarketSelectorProps {
  currentSlabAddress: string;
  symbol: string;
  logoUrl: string | null;
}

function formatVolume(vol: number | null): string {
  if (vol == null || vol === 0) return "—";
  const v = vol / 1e6;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

/** Format a 24h % change with sign and cap. */
function formatChange(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return "—";
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

/** Colour class for 24h change. */
function changeColor(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct) || pct === 0) return "text-[var(--text-dim)]";
  return pct > 0 ? "text-[var(--long)]" : "text-[var(--short)]";
}

export const MarketSelector: FC<MarketSelectorProps> = ({
  currentSlabAddress,
  symbol,
  logoUrl,
}) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapperRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const { statsMap, loading } = useAllMarketStats();
  const { priceE6: livePriceE6, change24h: change24hPct } = useLivePrice();

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Focus search on open
  useEffect(() => {
    if (open && searchRef.current) {
      searchRef.current.focus();
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  const markets = useMemo(() => {
    const all = Array.from(statsMap.values())
      .filter((m) => m.slab_address && m.slab_address !== currentSlabAddress)
      .sort((a, b) => (b.volume_24h ?? 0) - (a.volume_24h ?? 0));

    if (!search.trim()) return all;

    const q = search.toLowerCase();
    return all.filter(
      (m) =>
        (m.symbol?.toLowerCase().includes(q)) ||
        (m.name?.toLowerCase().includes(q)) ||
        (m.slab_address?.toLowerCase().includes(q))
    );
  }, [statsMap, currentSlabAddress, search]);

  // Current market's current-market stat row (for pinned row)
  const currentMarket = statsMap.get(currentSlabAddress) ?? null;

  const handleSelect = (slabAddress: string) => {
    setOpen(false);
    setSearch("");
    router.push(`/trade/${slabAddress}`);
  };

  // Format live price for trigger display
  const livePriceDisplay = livePriceE6 != null && livePriceE6 > 0n
    ? formatUsdPriceE6(livePriceE6)
    : currentMarket?.last_price != null
      ? formatUsdFromNumber(currentMarket.last_price)
      : null;

  return (
    <div ref={wrapperRef} className="relative">
      {/* 1.1: Richer trigger button */}
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-sm px-2 py-1 transition-colors hover:bg-[var(--accent)]/[0.06]"
      >
        {/* Logo 16×16 */}
        <MarketLogo
          logoUrl={logoUrl}
          mintAddress={currentMarket?.mint_address ?? null}
          symbol={symbol}
          size="sm"
          pixelOverride={16}
        />

        {/* Symbol + PERP + price/change stacked */}
        <div className="flex flex-col items-start">
          <div className="flex items-center gap-1.5">
            <span
              className="text-sm font-bold text-[var(--text)]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {symbol}/USD
            </span>
            <span className="text-[10px] font-normal text-[var(--text-muted)]">PERP</span>
          </div>
          {livePriceDisplay && (
            <div className="flex items-center gap-1.5">
              <span
                className="text-[10px] text-[var(--text-secondary)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {livePriceDisplay}
              </span>
              {change24hPct != null && (
                <span
                  className={`text-[9px] ${changeColor(change24hPct)}`}
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {formatChange(change24hPct)}
                </span>
              )}
            </div>
          )}
        </div>

        <svg
          className={`h-3.5 w-3.5 text-[var(--text-dim)] transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        // 1.2: Widened to 380px
        <div className="absolute left-0 top-full z-50 mt-1 w-[380px] border border-[var(--border)] bg-[var(--bg)] shadow-lg shadow-black/20">
          {/* Search */}
          <div className="border-b border-[var(--border)]/50 px-3 py-2">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search markets..."
              className="w-full bg-transparent text-[11px] text-[var(--text)] placeholder:text-[var(--text-dim)] outline-none"
              style={{ fontFamily: "var(--font-mono)" }}
            />
          </div>

          {/* Current market pinned row */}
          {currentMarket && !search.trim() && (
            <div className="border-b border-[var(--border)]/30 bg-[var(--accent)]/[0.03]">
              <div className="flex items-center px-3 py-1.5 text-[8px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">
                <span className="text-[var(--accent)]/60">▶ Current</span>
              </div>
              <div className="flex items-center px-3 pb-2">
                <div className="flex flex-1 items-center gap-1.5 min-w-0">
                  <MarketLogo
                    logoUrl={currentMarket.logo_url}
                    mintAddress={currentMarket.mint_address ?? null}
                    symbol={currentMarket.symbol ?? undefined}
                    size="sm"
                    pixelOverride={14}
                  />
                  <span className="text-[11px] font-medium text-[var(--accent)]">
                    {currentMarket.symbol ?? currentMarket.slab_address?.slice(0, 6)}/USD
                  </span>
                  {currentMarket.max_leverage && (
                    <span className="text-[8px] text-[var(--text-dim)]">
                      {currentMarket.max_leverage}x
                    </span>
                  )}
                </div>
                <span
                  className="w-24 text-right text-[10px] text-[var(--text-secondary)]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {livePriceDisplay ?? formatUsdFromNumber(currentMarket.last_price)}
                </span>
                <span
                  className={`w-16 text-right text-[10px] ${changeColor(change24hPct)}`}
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {formatChange(change24hPct)}
                </span>
                <span
                  className="w-16 text-right text-[10px] text-[var(--text-dim)]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {formatVolume(currentMarket.volume_24h)}
                </span>
              </div>
            </div>
          )}

          {/* 1.2: Updated header row with 24H column */}
          <div className="flex items-center px-3 py-1.5 text-[8px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)] border-b border-[var(--border)]/30">
            <span className="flex-1">Market</span>
            <span className="w-24 text-right">Price</span>
            <span className="w-16 text-right">24H</span>
            <span className="w-16 text-right">Vol</span>
          </div>

          {/* Market list */}
          <div className="max-h-[320px] overflow-y-auto">
            {/* 1.3: Skeleton loading state */}
            {loading && markets.length === 0 ? (
              <div className="divide-y divide-[var(--border)]/10">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-2.5">
                    <div className="h-3.5 w-3.5 animate-pulse bg-[var(--border)]/20 rounded-none" />
                    <div className="flex-1 h-3 animate-pulse bg-[var(--border)]/20 rounded-none" />
                    <div className="w-16 h-3 animate-pulse bg-[var(--border)]/20 rounded-none" />
                    <div className="w-12 h-3 animate-pulse bg-[var(--border)]/20 rounded-none" />
                    <div className="w-12 h-3 animate-pulse bg-[var(--border)]/20 rounded-none" />
                  </div>
                ))}
              </div>
            ) : markets.length === 0 ? (
              <div className="py-6 text-center">
                <p className="text-[10px] text-[var(--text-muted)]">
                  {search ? "No markets found" : "No other markets available"}
                </p>
                {/* 1.3: Browse all link */}
                <a
                  href="/markets"
                  className="mt-2 inline-block text-[10px] text-[var(--accent)] hover:underline"
                >
                  Browse all markets →
                </a>
              </div>
            ) : (
              markets.map((m) => {
                // Compute 24h change from mark_price vs last_price (proxy)
                // The DB doesn't store a dedicated change_24h column.
                // We use (mark_price - last_price) / last_price as a rough estimate.
                const mChange24h =
                  m.mark_price != null && m.last_price != null && m.last_price > 0
                    ? ((m.mark_price - m.last_price) / m.last_price) * 100
                    : null;

                const isOracleDown = m.last_price == null && (m.mark_price == null);

                return (
                  <button
                    key={m.slab_address}
                    onClick={() => handleSelect(m.slab_address!)}
                    className="flex w-full items-center px-3 py-2 text-left transition-colors hover:bg-[var(--accent)]/[0.04]"
                  >
                    {/* Logo 14×14 + Symbol */}
                    <div className="flex flex-1 items-center gap-1.5 min-w-0">
                      <MarketLogo
                        logoUrl={m.logo_url}
                        mintAddress={m.mint_address ?? null}
                        symbol={m.symbol ?? undefined}
                        size="sm"
                        pixelOverride={14}
                      />
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] font-medium text-[var(--text)]">
                          {m.symbol ?? m.slab_address?.slice(0, 6)}/USD
                        </span>
                        {m.max_leverage && (
                          <span className="text-[8px] text-[var(--text-dim)]">
                            {m.max_leverage}x
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Price / NO ORACLE badge */}
                    {isOracleDown ? (
                      <span className="w-24 flex justify-end">
                        <span className="text-[8px] text-amber-400 border border-amber-400/30 px-1">
                          NO ORACLE
                        </span>
                      </span>
                    ) : (
                      <span
                        className="w-24 text-right text-[10px] text-[var(--text-secondary)]"
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {formatUsdFromNumber(m.last_price)}
                      </span>
                    )}

                    {/* 24H change */}
                    <span
                      className={`w-16 text-right text-[10px] ${changeColor(mChange24h)}`}
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {isOracleDown ? "—" : formatChange(mChange24h)}
                    </span>

                    {/* Volume */}
                    <span
                      className="w-16 text-right text-[10px] text-[var(--text-dim)]"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {formatVolume(m.volume_24h)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
