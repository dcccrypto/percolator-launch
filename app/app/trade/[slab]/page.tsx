"use client";

import { UnsupportedLayoutNotice } from "@/components/v22/UnsupportedLayoutNotice";
import { use, useState, useEffect, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { MobileTradeBand } from "@/components/trade/MobileTradeBand";
import { isInsideModalSurface } from "@/hooks/useOtherModalOpen";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { isBlockedSlab } from "@/lib/blocklist";
import { UsdToggleProvider } from "@/components/providers/UsdToggleProvider";
import { OrderTicket } from "@/components/trade/OrderTicket";
import { useTicketRow, ticketRowShortLabel } from "@/lib/limits/ticket-status-store";
import { PositionsDock } from "@/components/trade/PositionsDock";
import dynamic from "next/dynamic";
import { MarketInfoBar } from "@/components/trade/MarketInfoBar";
import { MarketLimitsStrip } from "@/components/limits/MarketLimitsStrip";
import { MarketHeaderStatus, TradeMarketHealthBanner } from "@/components/market/MarketHealthBadges";
import { AnalyticsDock } from "@/components/trade/AnalyticsDock";
import { useIsLargeScreen } from "@/hooks/useIsLargeScreen";
import { useAdvanceOraclePhase } from "@/hooks/useAdvanceOraclePhase";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { Tooltip } from "@/components/ui/Tooltip";
import { useLivePriceHasData, livePriceJsonFetcher } from "@/hooks/useLivePrice";
import { getMarketIdentity, setMarketIdentity } from "@/lib/marketIdentityCache";
import { useToast } from "@/hooks/useToast";
import { isPlaceholderSymbol, SLUG_ALIASES } from "@/lib/symbol-utils";
// DevnetFaucetModal moved to WalletProvider (PERC-808: global placement on all pages)
import { getNetwork } from "@/lib/config";
import { RenderProfiler } from "@/components/dev/RenderProfiler";
import TradingPageLoading from "./loading";

// Lazy-load the chart so it streams AFTER the order ticket + positions are
// interactive, instead of blocking the trade page's initial load. ssr:false —
// the chart is client-only. ChartSwitch is the single seam that picks the chart
// (see components/trade/ChartSwitch.tsx and lib/chart-engine.ts).
const TradingChart = dynamic(
  () => import("@/components/trade/ChartSwitch").then((m) => m.ChartSwitch),
  {
    ssr: false,
    loading: () => (
      <div className="h-full w-full animate-pulse rounded-sm border border-[var(--border)] bg-[var(--panel-bg)]" />
    ),
  },
);

/**
 * Phase 3 (trade-terminal rebuild) layout notes:
 *
 * - Named CSS Grid areas (dYdX `--layout` pattern from perp-dex-reference-
 *   patterns.md Area 1), expressed as React inline styles rather than a CSS
 *   custom property + styled-components (this codebase has neither
 *   styled-components nor a CSS-in-JS layer — Tailwind + plain `style` is
 *   the native equivalent here). Areas: MarketBar (top strip) / Chart
 *   (dominant center) / OrderTicket (~340px right rail) / PositionsDock
 *   (bottom-docked tabs).
 * - Desktop vs. mobile is a JS boolean fork (`useIsLargeScreen`), not a CSS
 *   dual-mount — same reasoning the pre-rebuild page already used for
 *   `TradingChart` specifically (avoid double-mounting live-subscribing
 *   components); Phase 3 extends that same discipline to every panel that
 *   holds hooks, not just the chart, closing the "mobile + desktop both
 *   always mounted" gap Phase 0 measured (12+ simultaneous component
 *   instances for what should be ~5-8).
 * - Analytics clutter (engine/crank/insurance/liquidation/system-capital/
 *   ADL/open-interest cards, "all accounts" table, the quick-start guide)
 *   moved OFF this page to a dedicated `/analytics/[slab]` route — see that
 *   file. Linked from the utility row below MarketBar.
 * - OrderTicket rail: Phase 4 replaced DepositTrigger + AccountRiskSidebar +
 *   TradeForm with the single new `OrderTicket` component (its own "account
 *   row" now covers balance/buying-power/deposit; its receipt covers the
 *   liq-price preview AccountRiskSidebar used to show separately).
 *   `PositionNftPanel` stays alongside it for now — a distinct feature
 *   (position-as-NFT), not order-entry. PositionsDock (PositionsTable +
 *   TradeHistory tabs) is still a TEMPORARY composition — Phase 5 replaces
 *   it with a single new `PositionsDock` component. `PositionPanel` and
 *   `PositionsTable` were
 *   confirmed (by direct read) to be parallel desktop/mobile implementations
 *   of the same "user's current position" data — kept only `PositionsTable`
 *   here (fits the dock's tabular shape; `PositionPanel` was mobile-only in
 *   the pre-rebuild page) to avoid mounting both redundantly. `AccountsCard`
 *   ("all accounts on this market") moved to /analytics — it's a market-wide
 *   view, not the trader's own position.
 * - No "Open Orders" tab: Percolator has no resting limit-order book (trades
 *   execute immediately against an LP portfolio via TradeCpi) — the task
 *   brief's "Positions / Open Orders / Trades" tab set doesn't map 1:1 onto
 *   this protocol's model, so PositionsDock ships with the two tabs that
 *   actually correspond to real data: Positions, Trades.
 */

/* ── Reusable tiny components ─────────────────────────────── */

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        toast("Address copied to clipboard!", "success");
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--accent)]"
      title="Copy address"
    >
      {copied ? (
        <svg className="h-3 w-3 text-[var(--long)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  );
}

/* Phase 5: the page-local `Tabs` helper is gone — its only remaining
 * consumer (the old PositionsDockShell) was replaced by
 * components/trade/PositionsDock.tsx, which has its own internal tab strip
 * (`DockTabs`, same shape) since it no longer depends on this page module. */

/* ── Order ticket rail (Phase 3 shell — Phase 4 replaces contents with a single OrderTicket) ── */

/**
 * Design pass (visual-only): OrderTicket + PositionNftPanel used to be two
 * separate small bordered boxes stacked with a gap — on desktop that left a
 * tall dead void below them (the rail spans the full Chart+PositionsDock
 * height, but the two cards together were much shorter than that). `framed`
 * makes this a SINGLE elevated panel (matching the Chart/PositionsDock
 * surface treatment) that stretches to fill the rail's height, with an
 * interior divider instead of two separate borders — OrderTicket/
 * PositionNftPanel no longer paint their own outer border+bg (see those
 * files), so there's exactly one border here, not a stack of them. On mobile
 * (`framed` false, inside the bottom sheet) the sheet itself already
 * supplies the frame, so this just stacks the two with a plain divider.
 */
function OrderTicketRail({ slab, framed = false }: { slab: string; framed?: boolean }) {
  // Phase 4: DepositTrigger + AccountRiskSidebar + TradeForm consolidated
  // into the single new OrderTicket (its own "account row" now covers
  // balance/buying-power/deposit; its receipt covers the liq-price preview
  // AccountRiskSidebar used to show separately). PositionNftPanel stays —
  // distinct feature (position-as-NFT), not order-entry — candidate to move
  // into PositionsDock in Phase 5 alongside the rest of "position" UI.
  return (
    <div
      className={
        framed
          ? "flex h-full flex-col overflow-y-auto border border-[var(--border)] bg-[var(--panel-bg)]"
          : "flex flex-col gap-3"
      }
    >
      <ErrorBoundary label="OrderTicket">
        <RenderProfiler id="OrderTicket">
          <OrderTicket slabAddress={slab} />
        </RenderProfiler>
      </ErrorBoundary>
      {/* UX WP-9 (§3.13, NF-1): the Position NFT panel left the ticket rail; its actions are in
          the position row's "⋯" menu (components/trade/PositionNftMenu.tsx). */}
    </div>
  );
}

/* Phase 5: PositionsDock is now the single new components/trade/PositionsDock.tsx
 * (own internal Positions/Trades tabs, memoized, isolated live-price row —
 * see that file). The page-local wrapper this used to need is gone. */

/* ── Mobile order sheet — tap-to-open bottom sheet, 150ms functional slide (no decorative animation) ── */

/**
 * Focusable-element selector for the sheet's focus trap. Mirrors
 * ClosePositionModal.tsx / TradeConfirmationModal.tsx's own copy of this
 * exact selector (excludes `[disabled]` controls so a disabled boundary
 * element can't break the Tab-wrap).
 */
const SHEET_FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function MobileOrderSheet({ slab }: { slab: string }) {
  const [open, setOpen] = useState(false);
  // UX WP-3 (§4.2): the collapsed bar names a blocked ticket ("Trade · Close-only").
  const ticketRow = useTicketRow(slab);
  const ticketRowLabel = ticketRowShortLabel(ticketRow);
  const sheetRef = useRef<HTMLDivElement>(null);
  // Portal gate, same pattern as components/ui/Tooltip.tsx: render nothing on
  // the server or on the first client pass so hydration matches, then attach
  // the modal layer to <body>.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // While the bottom-sheet (role="dialog" aria-modal) is open, lock background
  // scroll and close it on Escape — otherwise the page scrolls behind the sheet
  // and there's no keyboard dismissal. Restore overflow + detach the listener on
  // cleanup (and whenever `open` flips back to false).
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    const prevHtmlOverflow = document.documentElement.style.overflow;
    // Lock BOTH elements: `globals.css` sets `html { overflow-x: hidden }`, which
    // makes <html> itself the viewport scroller (overflow-y computes to `auto`).
    // The UA propagates <html>'s overflow to the viewport and only falls back to
    // <body>'s when <html> itself is `visible` — so locking body alone locked
    // nothing and the page behind the sheet kept scrolling under a 40% backdrop.
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    // iOS Safari ignores overflow:hidden on the viewport scroller entirely, so a
    // touch outside the sheet still drags the page behind it. Block those moves
    // while allowing the sheet's own `overflow-y-auto` region to keep scrolling.
    const handleTouchMove = (e: TouchEvent) => {
      // Touches inside the sheet, or inside a dialog opened on top of it
      // (trade confirm, close position), keep their own scrolling.
      if (isInsideModalSurface(e.target, sheetRef.current)) return;
      e.preventDefault();
    };
    document.addEventListener("touchmove", handleTouchMove, { passive: false });

    // BUG 21 fix: move initial focus into the dialog (APG dialog pattern —
    // mirrors ClosePositionModal/TradeConfirmationModal) so Tab starts
    // trapped inside it instead of leaving focus on the "Trade" trigger
    // button underneath.
    const sheet = sheetRef.current;
    const focusable = sheet?.querySelectorAll<HTMLElement>(SHEET_FOCUSABLE_SELECTOR);
    focusable?.[0]?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // BUG 22 fix: this is a document-level listener, same as
        // TradeConfirmationModal's / ClosePositionModal's own Escape
        // handlers — when the order ticket inside this sheet opens one of
        // those (or PositionsDock/PositionPanel opens ClosePositionModal
        // while this sheet is open), a single Escape keypress used to fire
        // BOTH: the dialog cancelled AND this sheet collapsed underneath it.
        // Those modals mark `document.body.dataset.percOpenDialogs` while
        // mounted (see their own mount effects) — if one is up, let IT own
        // this keypress and leave the sheet alone.
        const childDialogOpen = Number(document.body.dataset.percOpenDialogs ?? "0") > 0;
        if (childDialogOpen) return;
        setOpen(false);
        return;
      }
      if (e.key === "Tab") {
        const items = sheetRef.current?.querySelectorAll<HTMLElement>(SHEET_FOCUSABLE_SELECTOR);
        if (!items || items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.documentElement.style.overflow = prevHtmlOverflow;
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <>
      {/* Trigger band: portaled to <body> and docked on MobileBottomNav; it
          steps aside while any other modal dialog is open (see
          components/trade/MobileTradeBand.tsx). */}
      <MobileTradeBand
        open={open}
        onOpen={() => setOpen(true)}
        label={ticketRowLabel}
        ticketRow={ticketRow}
        sheetRef={sheetRef}
      />

      {/* Backdrop + sheet are portaled to <body> — the same thing every other
          dialog in this codebase already does (components/ui/Modal.tsx,
          ClosePositionModal, TradeConfirmationModal, InsuranceTopUpModal,
          SendPositionNftModal, InsuranceExplainerModal). This sheet was the
          only one left inline, and inline it sits inside the trade page's
          `animate-fade-in` wrapper (see the TradePageInner root). While that
          opacity animation is below 1 it creates a stacking context, which
          caps this layer's z-[60]/z-[61] INSIDE the wrapper — so
          MobileBottomNav (z-50, a sibling of <main> in app/layout.tsx) painted
          straight over the sheet's submit buttons and swallowed the taps needed
          to send the trade. Portaled into <body>, the z-index competes with the
          nav directly and 61 > 50 always wins, regardless of animation state. */}
      {mounted &&
        createPortal(
          <>
            {open && (
              <div
                className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm lg:hidden"
                onClick={() => setOpen(false)}
                aria-hidden="true"
              />
            )}

            <div
              ref={sheetRef}
              // BUG 21 fix: `inert` when closed — previously the sheet stayed
              // fully mounted off-screen (`translate-y-full`) with no `inert`/
              // `aria-hidden`, so its inputs/buttons stayed in the Tab order and
              // the accessibility tree even though invisible. Native `inert`
              // removes both without unmounting the form (unmounting would lose
              // in-progress input on every close).
              inert={!open ? true : undefined}
              className={`fixed inset-x-0 bottom-0 z-[61] max-h-[85dvh] overflow-y-auto rounded-t-md border-t border-[var(--border)] bg-[var(--bg)] transition-transform duration-150 ease-out lg:hidden ${
                open ? "translate-y-0" : "translate-y-full"
              }`}
              role="dialog"
              aria-modal="true"
              aria-label="Order ticket"
            >
              <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--border)]/50 bg-[var(--bg)] px-3 py-2">
                <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Order ticket</span>
                <button onClick={() => setOpen(false)} className="-mr-3 flex h-10 w-10 items-center justify-center text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text)]" aria-label="Close">
                  ✕
                </button>
              </div>
              {/* The sheet covers MobileBottomNav while open, so its final
                  controls sit at the viewport's bottom edge: they need their
                  own clearance there (plus the iOS home-indicator safe area) or
                  the last row lands flush against — or underneath — the edge. */}
              <div className="space-y-1.5 p-3 pb-[calc(2rem+env(safe-area-inset-bottom,0px))]">
                <OrderTicketRail slab={slab} />
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

/* ── Main inner page ──────────────────────────────────────── */

const MARKET_META_SWR_OPTS = { dedupingInterval: 10_000, refreshInterval: 0, revalidateOnFocus: false, revalidateIfStale: false, shouldRetryOnError: false } as const;

function TradePageInner({ slab }: { slab: string }) {
  const isLargeScreen = useIsLargeScreen();

  const { engine, config, header, loading: slabLoading, error: slabError, layoutUnsupported } = useSlabState();
  useAdvanceOraclePhase(slab);
  // Boolean presence subscription, NOT the full live-price state: this keeps the
  // trade-page shell OFF the ~4-5/sec price-tick re-render path (it only needs to
  // know whether a price exists, for the no-data gate below). See useLivePriceHasData.
  const hasPrice = useLivePriceHasData();
  const shortAddress = `${slab.slice(0, 4)}…${slab.slice(-4)}`;

  // Fetch Supabase market data (symbol, name, logo, mainnet_ca) as fallback for on-chain resolution
  // Shares the SAME SWR key useLivePrice already fetches (/api/markets/[slab]) via
  // the same exported fetcher, so the two dedupe into one request per load
  // instead of a raw fetch() + an SWR fetch of the identical URL.
  const { data: marketMetaJson } = useSWR<{ market?: { symbol?: string; name?: string; logo_url?: string; mainnet_ca?: string | null } }>(`/api/markets/${slab}`, livePriceJsonFetcher, MARKET_META_SWR_OPTS);
  // Seed identity synchronously from lib/marketIdentityCache — the markets
  // list / market switcher / a previous visit already knew this market's real
  // symbol+logo and wrote them there, so an in-app navigation renders the
  // correct pair name on its FIRST frame instead of flashing a fallback while
  // /api/markets/[slab] is in flight.
  const [supabaseMarket, setSupabaseMarket] = useState<{ symbol?: string; name?: string; logo_url?: string; mainnet_ca?: string | null } | null>(() => getMarketIdentity(slab));
  useEffect(() => {
    const m = marketMetaJson?.market;
    if (!m) return;
    setSupabaseMarket({ symbol: m.symbol ?? undefined, name: m.name ?? undefined, logo_url: m.logo_url ?? undefined, mainnet_ca: m.mainnet_ca ?? null });
    // Write back so the switcher/other routes and the next visit to this
    // market start with the resolved identity.
    setMarketIdentity(slab, { symbol: m.symbol ?? undefined, name: m.name ?? undefined, logo_url: m.logo_url ?? undefined, mainnet_ca: m.mainnet_ca ?? null });
  }, [marketMetaJson, slab]);

  // Resolve symbol: identity cache / market meta (trading pair) → truncated slab address.
  const collateralMintAddress = config?.collateralMint?.toBase58() ?? "";
  const mintAddress = supabaseMarket?.mainnet_ca ?? collateralMintAddress;
  // GH#chart-empty: TradingChart's GeckoTerminal lookup (useTokenChart) needs the market's
  // MAINNET token CA, never the devnet Sim-USDC collateral mint (`collateralMintAddress`) —
  // charting "Sim-USDC vs itself" is meaningless. `mintAddress` above intentionally falls
  // back to the collateral mint (for symbol/logo resolution elsewhere), but on first render
  // (before the `/api/markets/[slab]` fetch above resolves) that fallback fires, so
  // useTokenChart briefly fetches the WRONG mint before re-fetching the correct one once
  // `supabaseMarket` loads — a wasted request today (GeckoTerminal 404s either way while the
  // indexer backend is down) and a real wrong-chart flash once it's back. Pass `undefined`
  // instead of the collateral mint while the real CA is still unknown.
  const chartMintAddress = supabaseMarket?.mainnet_ca ?? undefined;
  const supabaseSymbol = supabaseMarket?.symbol ?? null;
  const symbol = (() => {
    if (!isPlaceholderSymbol(supabaseSymbol, mintAddress)) return supabaseSymbol!;
    // NO collateral-token fallback here: every playground market collateralizes
    // with sim-USDC, so the old `tokenMeta.symbol` tier named ANY market whose
    // metadata was still loading (or missing from the registry) "USDC/USD" —
    // the single most-reported identity bug. The collateral mint is never the
    // traded pair. Unknown identity renders as the truncated slab address,
    // which is honest and can't be mistaken for a different market.
    return shortAddress;
  })();
  const logoUrl = supabaseMarket?.logo_url ?? null;

  // Dynamic tab title — the symbol is resolved client-side (Supabase → on-chain
  // → truncated address), which is strictly more available than the server's
  // generateMetadata() `fetchMarketMeta`: on a devnet market the indexer doesn't
  // know, the server title falls back to the generic "Perpetual Futures Market"
  // while this still shows the real ticker. Only document.title is touched here.
  //
  // The og:*/meta[description] tags are intentionally NOT rewritten client-side:
  // social crawlers (Twitter/Discord/Facebook) never execute JS, so mutating
  // them after hydration is a no-op for their only purpose (link previews) —
  // layout.tsx's server-rendered generateMetadata is the sole source of truth
  // for those.
  useEffect(() => {
    document.title = `Trade ${symbol} | Percolator`;
  }, [symbol]);

  if (slabLoading && !engine) {
    return <TradingPageLoading />;
  }

  if (layoutUnsupported) {
    return (
      <div className="min-h-[calc(100dvh-48px)] flex items-center justify-center px-4">
        <UnsupportedLayoutNotice className="max-w-sm w-full" />
      </div>
    );
  }

  if (slabError && !config) {
    const isNotFound =
      slabError.includes("not found on-chain") ||
      slabError.includes("Market not found") ||
      slabError.includes("Account not found");

    if (isNotFound) {
      const network = getNetwork();
      return (
        <div className="min-h-[calc(100dvh-48px)] flex flex-col items-center justify-center gap-3 px-4">
          <div className="border border-[var(--border)]/60 bg-[var(--bg-elevated)] p-6 text-center max-w-sm w-full">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border)]/60 bg-[var(--bg)]/80">
              <svg className="h-5 w-5 text-[var(--text-dim)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
            </div>
            {network === "mainnet" ? (
              <>
                <p className="text-sm font-semibold text-[var(--text)]">Market launching soon</p>
                <p className="mt-2 text-[11px] text-[var(--text-secondary)] leading-relaxed">
                  This market hasn&apos;t been deployed to mainnet yet. It may be in devnet testing or pending launch.
                </p>
                <div className="mt-4 flex flex-col gap-2">
                  {/* GH#2704: no "Switch to Devnet" here either. getNetwork() returns "mainnet" on a
                      mainnet build before it reads the override, so the button only reloaded
                      this same screen. */}
                  <a
                    href="/markets"
                    className="w-full border border-[var(--border)] px-4 py-2 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text)] transition-colors duration-150"
                  >
                    Browse Live Markets
                  </a>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-[var(--text)]">Market not found on devnet</p>
                <p className="mt-2 text-[11px] text-[var(--text-secondary)] leading-relaxed">
                  This market doesn&apos;t exist on devnet. It may have been closed, or the link may be for a different network.
                </p>
                <div className="mt-4 flex flex-col gap-2">
                  {/* UX WP-10 (CN-1): the playground is devnet only, so it offers no mainnet switch. */}
                  <a
                    href="/markets"
                    className="w-full border border-[var(--border)] px-4 py-2 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text)] transition-colors duration-150"
                  >
                    Browse Markets
                  </a>
                </div>
              </>
            )}
            <p className="mt-4 text-[9px] text-[var(--text-dim)] break-all font-mono opacity-60">{slab}</p>
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-[calc(100dvh-48px)] flex flex-col items-center justify-center gap-3">
        <div className="border border-[var(--short)]/30 bg-[var(--short)]/5 p-6 text-center max-w-md">
          <p className="text-sm font-medium text-[var(--short)]">Failed to load market</p>
          <p className="mt-2 text-[11px] text-[var(--text-secondary)]">{slabError}</p>
          <p className="mt-2 text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>{slab}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 border border-[var(--border)] px-4 py-1.5 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text)] transition-colors duration-150"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Gate on `config` (populated for BOTH v12 and v17 once loaded), NOT `engine`
  // — `engine` is always null for v17 markets, which made this permanently
  // false there, so the "no oracle price" warning could never appear on a v17
  // market even during a genuine price outage. `config` is the version-agnostic
  // "market loaded" signal.
  const hasNoPriceData = !slabLoading && !!config && !hasPrice;

  // Desktop grid — named areas (dYdX pattern, see file-header comment).
  const gridStyle: CSSProperties = {
    gridTemplateAreas: '"MarketBar MarketBar" "Chart OrderTicket" "PositionsDock OrderTicket"',
    gridTemplateColumns: "minmax(0,1fr) 340px",
    // Chart row is CLAMPED (not a bare 1fr) so it can't balloon on a big
    // monitor or get squished on a laptop — min 560px, prefers ~72dvh, caps at
    // 860px. The positions dock takes the remaining space (1fr) so there's no
    // empty gap when the chart hits its cap on a tall screen.
    gridTemplateRows: "auto clamp(560px, 72dvh, 860px) minmax(220px, 1fr)",
  };

  return (
    <RenderProfiler id="TradePageInner">
    <div className="mx-auto max-w-[1920px] overflow-x-hidden animate-fade-in">
      {/* Retired market (2026-07-31 audit): this page deliberately still
          renders on a direct URL — it is the ONLY self-serve surface where a
          depositor can reach funds stuck in a retired market — but without
          this banner it looked like a LIVE market with a silently frozen
          price. Opens/deposits are blocked at the ticket + hook level;
          close/withdraw stay available. */}
      {isBlockedSlab(slab) && (
        <div className="border-b border-[var(--short)]/40 bg-[var(--short)]/[0.07] px-4 py-2.5 text-center">
          <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-[var(--short)]">
            Market retired — close &amp; withdraw only
          </p>
          <p className="mt-0.5 text-[10px] text-[var(--text-secondary)]">
            This market no longer trades and its price is frozen. New positions and deposits are
            disabled; existing positions can be closed and funds withdrawn where the market allows it.
          </p>
        </div>
      )}
      {hasNoPriceData && (
        <div className="border-b border-[var(--warning)]/30 bg-[var(--warning)]/5 px-4 py-2.5 text-center">
          <p className="text-[11px] font-medium text-[var(--warning)]">
            Prices for this market aren&apos;t available right now. They update automatically.
          </p>
        </div>
      )}

      {/* Utility row — market address + admin status. (Share, the tokens/usd
          toggle, and the Analytics link were removed; analytics now lives in
          the bottom AnalyticsDock.) */}

      {/* MarketBar — always mounted, already responsive/scrollable on mobile */}
      <MarketInfoBar slabAddress={slab} symbol={symbol} logoUrl={logoUrl} mintAddress={mintAddress} mainnetCa={chartMintAddress} />
      {/* UX WP-10 (§4.3): ONE status line under the header, only when the market is not live. */}
      <MarketHeaderStatus slab={slab} />
      {/* UX WP-10 (GL-1, §4.3): the market address and admin status left the page chrome; they sit
          in a collapsed "Market details" disclosure (the "ADMIN ACTIVE" chip is no longer shown by
          default above every market). */}
      <details data-testid="market-details" className="border-b border-[var(--border)]/30 px-3 py-1 text-[10px] text-[var(--text-secondary)]">
        <summary className="cursor-pointer select-none py-0.5">Market details</summary>
      {/* The health detail lines (payout level etc.) and the limits strip (OI vs cap, liquidity,
          band, skew) live here now, not as rows above the chart. */}
      <TradeMarketHealthBanner slab={slab} />
      <MarketLimitsStrip slab={slab} symbol={symbol} />
      <div className="flex items-center gap-3 py-1 overflow-x-auto whitespace-nowrap scrollbar-none">
        <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]" style={{ fontFamily: "var(--font-mono)" }}>
          {shortAddress}
          <CopyButton text={slab} />
        </span>
        {header?.admin && (
          <Tooltip
            text={
              header.admin.toBase58() === "11111111111111111111111111111111"
                ? "Admin key burned (set to the system program's default null address). No one can change this market's config, pause it, or touch its funds — it runs purely on its own code from here on."
                : "This market still has a live admin key that can change config, pause the market, or adjust parameters. Not yet renounced."
            }
          >
            <span className={`text-[9px] font-medium uppercase tracking-[0.12em] px-1.5 py-0.5 rounded-sm border ${
              header.admin.toBase58() === "11111111111111111111111111111111"
                ? "border-[var(--long)]/30 bg-[var(--long)]/5 text-[var(--long)]"
                : "border-[var(--warning)]/30 bg-[var(--warning)]/5 text-[var(--warning)]"
            }`}>
              {header.admin.toBase58() === "11111111111111111111111111111111" ? "Admin Renounced" : "Admin Active"}
            </span>
          </Tooltip>
        )}
      </div>
      </details>

      {/* ════════════════ DESKTOP (≥ lg) — named grid ════════════════ */}
      {isLargeScreen && (
        <div
          className="hidden lg:grid gap-3 px-4 lg:px-6 pb-11 pt-2 min-h-[calc(100dvh-150px)]"
          style={gridStyle}
        >
          <div style={{ gridArea: "Chart" }} className="min-w-0 min-h-0">
            <ErrorBoundary label="TradingChart">
              <RenderProfiler id="TradingChart">
                <div className="h-full overflow-hidden">
                  <TradingChart slabAddress={slab} mintAddress={chartMintAddress} />
                </div>
              </RenderProfiler>
            </ErrorBoundary>
          </div>

          <div style={{ gridArea: "OrderTicket" }} className="min-w-0 min-h-0">
            <RenderProfiler id="OrderTicketRail">
              <OrderTicketRail slab={slab} framed />
            </RenderProfiler>
          </div>

          <div style={{ gridArea: "PositionsDock" }} className="min-w-0 min-h-0 flex flex-col border border-[var(--border)] bg-[var(--panel-bg)]">
            <div className="flex min-h-0 flex-1 items-stretch justify-between border-b border-[var(--border)]/30 px-1">
              <RenderProfiler id="PositionsDock">
                <div className="min-h-0 min-w-0 flex-1">
                  <ErrorBoundary label="PositionsDock"><PositionsDock slabAddress={slab} /></ErrorBoundary>
                </div>
              </RenderProfiler>
            </div>
          </div>
        </div>
      )}

      {/* ════════════════ MOBILE (< lg) — chart full-width, positions inline, order ticket as bottom sheet ════════════════ */}
      {!isLargeScreen && (
        // pb-32 clears both the order-sheet trigger bar (~48px) and, below
        // md, the global MobileBottomNav stacked beneath it (~56px+safe-area).
        <div className="flex flex-col gap-1.5 px-2 pt-2 pb-32 lg:hidden min-w-0 w-full">
          <ErrorBoundary label="TradingChart">
            <RenderProfiler id="TradingChart">
              <div className="w-full overflow-hidden">
                <TradingChart slabAddress={slab} mintAddress={chartMintAddress} />
              </div>
            </RenderProfiler>
          </ErrorBoundary>

          <div className="h-[45vh] min-h-[280px] border border-[var(--border)] bg-[var(--panel-bg)]">
            <ErrorBoundary label="PositionsDock"><PositionsDock slabAddress={slab} /></ErrorBoundary>
          </div>

          <MobileOrderSheet slab={slab} />
        </div>
      )}

      {/* Sticky analytics dock (desktop only; self-hides < lg). Inline
          capital/health/liquidation/fee reads on hover — no trip to
          /analytics. Lives inside SlabProvider so it reuses the page's
          already-loaded slab data (no extra RPC). */}
      <AnalyticsDock slab={slab} />
    </div>
    </RenderProfiler>
  );
}

function isValidPublicKey(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

function InvalidAddressPage({ address }: { address: string }) {
  return (
    <div className="min-h-[calc(100dvh-48px)] flex flex-col items-center justify-center gap-3">
      <div className="border border-[var(--short)]/30 bg-[var(--short)]/5 p-6 text-center max-w-md">
        <p className="text-sm font-medium text-[var(--short)]">Market not found</p>
        <p className="mt-2 text-[11px] text-[var(--text-secondary)]">
          No market exists for this address or symbol.
        </p>
        <p className="mt-2 text-[10px] text-[var(--text-dim)] break-all" style={{ fontFamily: "var(--font-mono)" }}>{address}</p>
        <a
          href="/markets"
          className="mt-4 inline-block border border-[var(--border)] px-4 py-1.5 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text)] transition-colors duration-150"
        >
          Browse Markets
        </a>
      </div>
    </div>
  );
}

/**
 * Handles slugs like "SOL-PERP" or "SOL" that are not valid Solana public keys.
 * Fetches the markets index and redirects to the resolved slab address.
 */
function SlugResolvePage({ slug }: { slug: string }) {
  const router = useRouter();
  const [resolveError, setResolveError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/markets")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const markets: Array<{ slab_address: string; symbol?: string; mint_address?: string; volume_24h?: number | null; total_open_interest?: number | null; created_at?: string }> = data.markets ?? [];
        const slugNorm = slug.toUpperCase().replace(/-PERP$/, "");

        const sorted = [...markets].sort((a, b) => {
          const va = typeof a.volume_24h === "number" && a.volume_24h > 0 ? a.volume_24h : -1;
          const vb = typeof b.volume_24h === "number" && b.volume_24h > 0 ? b.volume_24h : -1;
          if (vb !== va) return vb - va;
          const oa = typeof a.total_open_interest === "number" && a.total_open_interest > 0 ? a.total_open_interest : -1;
          const ob = typeof b.total_open_interest === "number" && b.total_open_interest > 0 ? b.total_open_interest : -1;
          if (ob !== oa) return ob - oa;
          return new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime();
        });

        let match = sorted.find((m) => {
          const sym = (m.symbol ?? "").toUpperCase().replace(/-PERP$/, "");
          return sym === slugNorm || (m.symbol ?? "").toUpperCase() === slug.toUpperCase();
        });

        if (!match) {
          const aliasMint = SLUG_ALIASES[slugNorm];
          if (aliasMint) {
            match = sorted.find((m) => m.mint_address === aliasMint);
          }
        }
        if (match) {
          router.replace(`/trade/${match.slab_address}`);
        } else {
          setResolveError(true);
        }
      })
      .catch(() => {
        if (!cancelled) setResolveError(true);
      });
    return () => { cancelled = true; };
  }, [slug, router]);

  if (resolveError) {
    return <InvalidAddressPage address={slug} />;
  }

  return <TradingPageLoading />;
}

export default function TradePage({ params }: { params: Promise<{ slab: string }> }) {
  const { slab } = use(params);

  if (!isValidPublicKey(slab)) {
    return <SlugResolvePage slug={slab} />;
  }

  return (
    // key={slab} forces a clean remount of the whole trade subtree on a market
    // switch. Next.js App Router reuses client components when only the [slab]
    // param changes, so without this the terminal briefly shows the NEW market's
    // name/URL but the PREVIOUS market's price/balance/positions/config until the
    // RPC round-trip resolves — a trading-correctness risk (review numbers for SOL,
    // submit on BONK). Remounting resets SlabProvider/useMarketInfo/OrderTicket to
    // a clean loading state instead of leaking stale state across markets.
    <SlabProvider key={slab} slabAddress={slab}>
      <UsdToggleProvider>
        {/* Item-4 (let the user choose): AutoDepositProvider used to silently
            initUser+deposit a system-chosen starter amount here after the
            faucet. Onboarding now completes through OrderTicket's "Start
            Trading" CTA, whose deposit amount is an editable prefilled field. */}
        <TradePageInner slab={slab} />
      </UsdToggleProvider>
    </SlabProvider>
  );
}
