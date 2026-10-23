"use client";

import { baseSymbol } from "@/lib/symbol-utils";
import { FC, KeyboardEvent as ReactKeyboardEvent, memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useAllMarketStats } from "@/hooks/useAllMarketStats";
import { peekPortfolioSnapshot, portfolioCacheKey, usePortfolio, type PortfolioPosition } from "@/hooks/usePortfolio";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { useWatchlist } from "@/hooks/useWatchlist";
import { MarketLogo } from "@/components/market/MarketLogo";
import { getNetwork } from "@/lib/config";
import { setMarketIdentity } from "@/lib/marketIdentityCache";
import { isMockMode } from "@/lib/mock-mode";
import { getMockPortfolioPositions } from "@/lib/mock-trade-data";
import {
  SWITCHER_TABS,
  TOP_COUNT,
  browsableRows,
  myTradeRows,
  readSwitcherTab,
  saveSwitcherTab,
  searchRows,
  watchlistRows,
  type SwitcherRow,
  type SwitcherTab,
} from "@/lib/market-switcher-lists";

interface MarketSwitcherProps {
  slabAddress: string;
  symbol: string;
  logoUrl?: string | null;
  mintAddress?: string | null;
  /** Mainnet contract address — used to resolve a real DEX logo when logoUrl is unset. */
  mainnetCa?: string | null;
}

/** How often an open dropdown re-reads the shared positions snapshot (a cache read, no RPC). */
const SNAPSHOT_POLL_MS = 5_000;

/** Small text on the LONG/SHORT chips: the side colour pulled toward the text colour so it reads at 8px in both themes. */
const SIDE_CHIP = {
  long: "border-[var(--long)]/40 text-[color-mix(in_srgb,var(--long)_70%,var(--text))]",
  short: "border-[var(--short)]/40 text-[color-mix(in_srgb,var(--short)_70%,var(--text))]",
} as const;

/**
 * The market title in the info bar, upgraded from a static label to a
 * switcher: click → dropdown with a search box and three lists, so switching
 * markets doesn't require a round-trip through /markets:
 *   - Top markets: the top markets by open interest;
 *   - My trades:   markets the wallet has an open position in (with its side);
 *   - Watchlist:   markets the user starred (the same list as ☆ and the
 *                  portfolio watchlist, kept in step by useWatchlist).
 * Search always covers every market, whichever list is open. The last list
 * chosen is remembered per browser. The lists follow the ARIA tabs pattern
 * (arrow keys between tabs, one tab stop), ArrowDown/ArrowUp move between the
 * search box and the rows, and closing hands focus back to the trigger.
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
  const { statsMap, loading, error } = useAllMarketStats({ enabled: open });
  const { connected, publicKey } = useWalletCompat();
  const mockMode = isMockMode();
  const { watchlist, unwatch } = useWatchlist();
  const [tab, setTab] = useState<SwitcherTab>("top");
  const [query, setQuery] = useState("");
  const [panelPos, setPanelPos] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const tabRefs = useRef<Partial<Record<SwitcherTab, HTMLButtonElement | null>>>({});
  const idBase = useId();
  const tabId = (key: SwitcherTab) => `${idBase}-tab-${key}`;
  const listId = `${idBase}-list`;

  // My trades reads the positions snapshot the site-wide scan (the header positions strip and the
  // liquidation alert, both mounted for any connected wallet) already keeps warm — a cache read, no RPC.
  // Only when there is no snapshot at all and the user is looking at My trades does this instance scan.
  // The snapshot is read DURING render, not in an effect: an effect left it null on the first open render, so a
  // switcher reopened on My trades started its own full scan even with a warm snapshot in the cache.
  const walletKey = publicKey?.toBase58() ?? null;
  const [snapshotTick, setSnapshotTick] = useState(0);
  useEffect(() => {
    if (!open || !connected || !walletKey) return;
    const timer = setInterval(() => setSnapshotTick((n) => n + 1), SNAPSHOT_POLL_MS);
    return () => clearInterval(timer);
  }, [open, connected, walletKey]);
  const snapshot = useMemo<PortfolioPosition[] | null>(
    () => (open && connected && walletKey ? (peekPortfolioSnapshot(portfolioCacheKey(walletKey, getNetwork()))?.positions ?? null) : null),
    // snapshotTick re-reads the cache every SNAPSHOT_POLL_MS while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, connected, walletKey, snapshotTick],
  );
  const fallback = usePortfolio(open && connected && tab === "mine" && snapshot === null);
  // Mock book only when DISCONNECTED (same gate as the positions dock): a connected wallet in ?mock=1 never
  // sees synthetic positions.
  const mockPositions = useMemo(() => (mockMode && !connected ? getMockPortfolioPositions() : null), [mockMode, connected]);
  const positions = mockPositions ?? snapshot ?? fallback.positions;
  const positionsLoading = !mockPositions && snapshot === null && fallback.loading;
  const positionsError = !mockPositions && snapshot === null ? fallback.error : null;

  const PANEL_W = 300;

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const openPanel = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Clamp inside the viewport; drop below the trigger.
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_W - 8));
    setPanelPos({ left, top: rect.bottom + 6 });
    setQuery("");
    setTab(readSwitcherTab());
    setOpen(true);
  }, []);

  const chooseTab = useCallback((next: SwitcherTab, focusTab = false) => {
    setTab(next);
    saveSwitcherTab(next);
    if (focusTab) tabRefs.current[next]?.focus();
  }, []);

  // Focus the search box as soon as the panel mounts.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Outside click / Escape / focus leaving the panel close it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as Node | null;
      if (!t || panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open, close]);

  // Every browsable market; hidden markets (listing-hidden, half-made, unpriceable) are still reachable by link.
  const allMarkets = useMemo(() => browsableRows(statsMap), [statsMap]);
  const mine = useMemo(
    () =>
      myTradeRows(
        positions.map((p) => ({ slabAddress: p.slabAddress, symbol: p.symbol, positionSize: p.account?.positionSize ?? 0n })),
        statsMap,
      ),
    [positions, statsMap],
  );
  const watched = useMemo(() => watchlistRows(watchlist, statsMap), [watchlist, statsMap]);

  const searching = query.trim().length > 0;
  const results = useMemo<SwitcherRow[]>(() => {
    if (searching) return searchRows(allMarkets, query);
    if (tab === "mine") return mine;
    if (tab === "watch") return watched;
    return allMarkets.slice(0, TOP_COUNT);
  }, [searching, allMarkets, query, tab, mine, watched]);

  const goTo = useCallback(
    (slab: string) => {
      close(true);
      if (slab !== slabAddress) {
        // Seed the destination's identity BEFORE navigating so the trade page
        // renders the right pair label on its first frame instead of flashing
        // a fallback while /api/markets/[slab] loads. Never a stand-in symbol:
        // the identity cache does not expire.
        const row = results.find((r) => r.slab === slab) ?? allMarkets.find((r) => r.slab === slab);
        if (row?.symbol && !row.placeholder) setMarketIdentity(slab, { symbol: row.symbol, name: row.name ?? undefined });
        router.push(`/trade/${slab}`);
      }
    },
    [close, router, slabAddress, results, allMarkets],
  );

  const fmtPrice = (p: number | null) =>
    p == null ? "—" : p >= 1 ? `$${p.toFixed(2)}` : `$${p.toPrecision(4)}`;

  /** The empty-list line for whatever is showing. */
  const emptyMessage = (): string => {
    if (searching) {
      // With no markets loaded, a query can't be what failed to match.
      if (allMarkets.length > 0) return `No markets match "${query.trim()}"`;
      return loading ? "Loading markets…" : error ? "Couldn't load markets" : "No markets yet";
    }
    if (tab === "mine") {
      if (!connected && !mockMode) return "Connect your wallet to see your trades";
      if (positionsLoading) return "Loading your positions…";
      if (positionsError) return "Couldn't load your positions";
      return "No open positions";
    }
    if (tab === "watch") {
      if (watchlist.length === 0) return "Star a market with ☆ to add it here";
      return loading ? "Loading markets…" : error ? "Couldn't load markets" : "Your watched markets aren't listed right now";
    }
    return loading ? "Loading markets…" : error ? "Couldn't load markets" : "No markets yet";
  };

  // The Watchlist count matches the rows shown once the market list is in (a delisted market isn't listed).
  const tabCount = (key: SwitcherTab): number | null =>
    key === "mine" ? (mine.length || null) : key === "watch" ? ((statsMap.size > 0 ? watched.length : watchlist.length) || null) : null;

  const onTabKey = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = SWITCHER_TABS.length;
    const to =
      e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    chooseTab(SWITCHER_TABS[to].key, true);
  };

  const rowButtons = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-switcher-row]") ?? []);
  const onRowKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = rowButtons();
    const i = rows.indexOf(e.currentTarget);
    if (e.key === "ArrowDown") rows[Math.min(i + 1, rows.length - 1)]?.focus();
    else if (i <= 0) inputRef.current?.focus();
    else rows[i - 1]?.focus();
  };

  const listLabel = searching ? "Search results" : SWITCHER_TABS.find((t) => t.key === tab)?.label;
  const removable = !searching && tab === "watch";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close(false) : openPanel())}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Switch market"
        className="group flex shrink-0 items-center gap-2 rounded-sm px-1 py-0.5 transition-colors hover:bg-[var(--bg-elevated)]"
      >
        <MarketLogo logoUrl={logoUrl} mintAddress={mintAddress} mainnetCa={mainnetCa} symbol={symbol} size="sm" />
        <span className="text-sm font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
          {baseSymbol(symbol)}
          <span className="hidden md:inline">/USD</span>
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
          role="dialog"
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
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  rowButtons()[0]?.focus();
                }
              }}
              placeholder="Search markets…"
              aria-label="Search markets"
              aria-controls={listId}
              className="w-full rounded-none border border-[var(--border)]/40 bg-[var(--bg)] px-2 py-1.5 text-[12px] text-[var(--text)] placeholder-[var(--text-muted)] focus:border-[var(--accent)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20"
              style={{ fontFamily: "var(--font-mono)" }}
            />
          </div>

          {/* Lists — hidden while searching, since search covers every market */}
          {searching ? (
            <div className="px-3 pb-1 pt-2 text-[9px] font-medium uppercase tracking-[0.18em] text-[var(--text-secondary)]">
              Results
            </div>
          ) : (
            <div role="tablist" aria-label="Market lists" className="flex border-b border-[var(--border)]/60 px-1">
              {SWITCHER_TABS.map((t, i) => {
                const on = tab === t.key;
                const count = tabCount(t.key);
                return (
                  <button
                    key={t.key}
                    ref={(el) => {
                      tabRefs.current[t.key] = el;
                    }}
                    id={tabId(t.key)}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    aria-label={count !== null ? `${t.label}, ${count}` : undefined}
                    aria-controls={listId}
                    tabIndex={on ? 0 : -1}
                    onClick={() => chooseTab(t.key)}
                    onKeyDown={(e) => onTabKey(e, i)}
                    className={`flex flex-1 items-center justify-center gap-1 whitespace-nowrap border-b-2 px-1.5 pb-1.5 pt-2 text-[9px] font-medium uppercase tracking-[0.14em] transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)] ${
                      on
                        ? "border-[var(--accent)] text-[var(--accent-text)]"
                        : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text)]"
                    }`}
                  >
                    {t.label}
                    {count !== null && (
                      <span className={`tabular-nums ${on ? "text-[var(--accent-text)]" : "text-[var(--text-secondary)]"}`}>{count}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Empty line sits outside the listbox (a listbox holds only options) and is announced. */}
          {results.length === 0 && (
            <p role="status" className="px-3 py-3 text-[11px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
              {emptyMessage()}
            </p>
          )}

          {/* Rows: each market is its own button; Watchlist rows also get a remove button beside it. */}
          <ul
            ref={listRef}
            id={listId}
            aria-label={listLabel}
            aria-labelledby={searching ? undefined : tabId(tab)}
            className={results.length > 0 ? "max-h-72 overflow-y-auto pb-1 pt-1" : ""}
          >
            {results.map((r) => {
              const isCurrent = r.slab === slabAddress;
              const pair = `${baseSymbol(r.symbol)}/USD`;
              return (
                <li
                  key={r.slab}
                  className={`flex items-stretch transition-colors hover:bg-[var(--bg-surface)] ${isCurrent ? "bg-[var(--accent)]/[0.06]" : ""}`}
                >
                  <button
                    type="button"
                    data-switcher-row=""
                    aria-current={isCurrent ? "true" : undefined}
                    title={`${pair}${r.name ? ` · ${r.name}` : ""}`}
                    // Full-route prefetch on hover/focus: goTo uses router.push, which
                    // (unlike an in-viewport <Link prefetch>) does no prefetching — so
                    // switching markets paid the dynamic /trade/[slab] RSC round-trip
                    // behind the route loading skeleton. Mirrors the markets-page rows.
                    onMouseEnter={() => { if (!isCurrent) router.prefetch(`/trade/${r.slab}`); }}
                    onFocus={() => { if (!isCurrent) router.prefetch(`/trade/${r.slab}`); }}
                    onClick={() => goTo(r.slab)}
                    onKeyDown={onRowKey}
                    className={`flex min-w-0 flex-1 items-center justify-between gap-2 py-2 text-left focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)] ${removable ? "pl-3 pr-1" : "px-3"}`}
                  >
                    <span className="min-w-0">
                      <span className={`block truncate text-[12px] font-bold ${isCurrent ? "text-[var(--accent-text)]" : "text-[var(--text)]"}`} style={{ fontFamily: "var(--font-mono)" }}>
                        {pair}
                        {isCurrent && <span className="ml-1.5 text-[8px] font-normal uppercase tracking-[0.12em] text-[var(--accent-text)]">current</span>}
                      </span>
                      {r.name && (
                        <span className="block truncate text-[10px] text-[var(--text-secondary)]">{r.name}</span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {r.side && (
                        <span className={`border px-1 py-px text-[8px] font-semibold uppercase tracking-[0.12em] ${SIDE_CHIP[r.side]}`}>
                          {r.side}
                        </span>
                      )}
                      <span className="text-[11px] tabular-nums text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
                        {fmtPrice(r.priceUsd)}
                      </span>
                    </span>
                  </button>
                  {removable && (
                    <button
                      type="button"
                      onClick={() => {
                        unwatch(r.slab);
                        inputRef.current?.focus();
                      }}
                      aria-label={`Remove ${pair} from your watchlist`}
                      title="Remove from watchlist"
                      className="flex w-9 shrink-0 items-center justify-center text-[13px] text-[var(--accent-text)] transition-colors hover:text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]"
                    >
                      <span aria-hidden="true">★</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>

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
