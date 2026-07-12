"use client";

import { FC, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useAllMarketStats } from "@/hooks/useAllMarketStats";
import { MarketLogo } from "@/components/market/MarketLogo";

interface MarketSwitcherProps {
  slabAddress: string;
  symbol: string;
  logoUrl?: string | null;
  mintAddress?: string | null;
  /** Mainnet contract address — used to resolve a real DEX logo when logoUrl is unset. */
  mainnetCa?: string | null;
}

interface SwitcherRow {
  slab: string;
  symbol: string;
  name: string | null;
  priceUsd: number | null;
  oiUsd: number;
}

/**
 * The market title in the info bar, upgraded from a static label to a
 * switcher: click → dropdown with the top markets by open interest and a
 * search box, so switching markets doesn't require a round-trip through
 * /markets.
 *
 * Positioning: the info bar is an `overflow-x-auto` scroll container (clips
 * absolute children — the original Share dropdown bug, #2268) AND has
 * `backdrop-blur`, whose backdrop-filter makes the bar the containing block
 * for position:fixed descendants too — a fixed panel rendered inline gets
 * re-anchored to the bar and clipped all the same. The panel is therefore
 * PORTALED to document.body and placed from the trigger's
 * boundingClientRect, clamped to the viewport.
 */
const MarketSwitcherInner: FC<MarketSwitcherProps> = ({ slabAddress, symbol, logoUrl, mintAddress, mainnetCa }) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Only fire the 500-market/30s poll while the dropdown is actually open —
  // this instance was keeping useAllMarketStats' SWR key alive at all times
  // to back a panel that's closed the overwhelming majority of the session.
  // No other trade-page component shares this hook instance's job (grep
  // confirms MarketSwitcher is the only trade-page consumer of
  // useAllMarketStats — markets/page.tsx, portfolio/page.tsx, and
  // MarketSelector.tsx are different pages/flows with their own instances),
  // so gating this one doesn't starve anything else of a warm cache.
  const { statsMap } = useAllMarketStats({ enabled: open });
  const [query, setQuery] = useState("");
  const [panelPos, setPanelPos] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const PANEL_W = 300;

  const openPanel = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Clamp inside the viewport; drop below the trigger.
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_W - 8));
    setPanelPos({ left, top: rect.bottom + 6 });
    setQuery("");
    setOpen(true);
  }, []);

  // Focus the search box as soon as the panel mounts.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Outside click / Escape close.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const allMarkets = useMemo<SwitcherRow[]>(() => {
    const rows: SwitcherRow[] = [];
    for (const [slab, m] of statsMap) {
      if (!m?.symbol) continue;
      // Ranking score only: raw OI atoms × price. Playground markets share
      // 6-decimal collateral, so cross-market ordering is sound; the exact
      // USD figure is never displayed here.
      const oiScore =
        (typeof m.total_open_interest === "number" ? m.total_open_interest : 0) *
        (typeof m.last_price === "number" ? m.last_price : 0);
      rows.push({
        slab,
        symbol: String(m.symbol),
        name: (m.name as string | null) ?? null,
        priceUsd: typeof m.last_price === "number" ? m.last_price : null,
        oiUsd: oiScore,
      });
    }
    rows.sort((a, b) => b.oiUsd - a.oiUsd || a.symbol.localeCompare(b.symbol));
    return rows;
  }, [statsMap]);

  const q = query.trim().toLowerCase();
  const results = useMemo<SwitcherRow[]>(() => {
    if (!q) return allMarkets.slice(0, 3); // top by OI when not searching
    return allMarkets
      .filter(
        (r) =>
          r.symbol.toLowerCase().includes(q) ||
          (r.name ?? "").toLowerCase().includes(q) ||
          r.slab.toLowerCase().startsWith(q),
      )
      .slice(0, 8);
  }, [allMarkets, q]);

  const goTo = useCallback(
    (slab: string) => {
      setOpen(false);
      if (slab !== slabAddress) router.push(`/trade/${slab}`);
    },
    [router, slabAddress],
  );

  const fmtPrice = (p: number | null) =>
    p == null ? "—" : p >= 1 ? `$${p.toFixed(2)}` : `$${p.toPrecision(4)}`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openPanel())}
        aria-expanded={open}
        aria-haspopup="listbox"
        title="Switch market"
        className="group flex shrink-0 items-center gap-2 rounded-sm px-1 py-0.5 transition-colors hover:bg-[var(--bg-elevated)]"
      >
        <MarketLogo logoUrl={logoUrl} mintAddress={mintAddress} mainnetCa={mainnetCa} symbol={symbol} size="sm" />
        <span className="text-sm font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
          {symbol}/USD
          <span className="ml-1.5 text-[9px] font-normal uppercase tracking-[0.12em] text-[var(--text-secondary)]">PERP</span>
        </span>
        <span
          aria-hidden="true"
          className={`text-[9px] text-[var(--text-secondary)] transition-transform duration-150 group-hover:text-[var(--text)] ${open ? "rotate-180" : ""}`}
        >
          ▼
        </span>
      </button>

      {open && panelPos && typeof document !== "undefined" && createPortal(
        <div
          ref={panelRef}
          role="listbox"
          aria-label="Switch market"
          className="fixed z-50 border border-[var(--border)] bg-[var(--bg-elevated)]/95 shadow-xl backdrop-blur-sm"
          style={{ left: panelPos.left, top: panelPos.top, width: PANEL_W }}
        >
          {/* Search */}
          <div className="border-b border-[var(--border)]/60 p-2">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && results.length > 0) goTo(results[0].slab);
              }}
              placeholder="Search markets…"
              className="w-full rounded-none border border-[var(--border)]/40 bg-[var(--bg)] px-2 py-1.5 text-[12px] text-[var(--text)] placeholder-[var(--text-muted)] focus:border-[var(--accent)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20"
              style={{ fontFamily: "var(--font-mono)" }}
            />
          </div>

          {/* Section label */}
          <div className="px-3 pb-1 pt-2 text-[9px] font-medium uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            {q ? "Results" : "Top markets"}
          </div>

          {/* Rows */}
          <div className="max-h-72 overflow-y-auto pb-1">
            {results.length === 0 && (
              <p className="px-3 py-3 text-[11px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
                No markets match &quot;{query.trim()}&quot;
              </p>
            )}
            {results.map((r) => {
              const isCurrent = r.slab === slabAddress;
              return (
                <button
                  key={r.slab}
                  type="button"
                  role="option"
                  aria-selected={isCurrent}
                  onClick={() => goTo(r.slab)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--bg-surface)] ${
                    isCurrent ? "bg-[var(--accent)]/[0.06]" : ""
                  }`}
                >
                  <span className="min-w-0">
                    <span className={`block truncate text-[12px] font-bold ${isCurrent ? "text-[var(--accent)]" : "text-[var(--text)]"}`} style={{ fontFamily: "var(--font-mono)" }}>
                      {r.symbol}/USD
                      {isCurrent && <span className="ml-1.5 text-[8px] font-normal uppercase tracking-[0.12em] text-[var(--accent)]">current</span>}
                    </span>
                    {r.name && (
                      <span className="block truncate text-[10px] text-[var(--text-secondary)]">{r.name}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
                    {fmtPrice(r.priceUsd)}
                  </span>
                </button>
              );
            })}
          </div>

          {/* All markets link */}
          <a
            href="/markets"
            className="block border-t border-[var(--border)]/60 px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)] transition-colors hover:text-[var(--accent)]"
          >
            All markets →
          </a>
        </div>,
        document.body,
      )}
    </>
  );
};

export const MarketSwitcher = memo(MarketSwitcherInner);
