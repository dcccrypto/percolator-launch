"use client";

import { use, useState, useEffect, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { UsdToggleProvider, useUsdToggle } from "@/components/providers/UsdToggleProvider";
import { OrderTicket } from "@/components/trade/OrderTicket";
import { PositionNftPanel } from "@/components/trade/PositionNftPanel";
import { PositionsDock } from "@/components/trade/PositionsDock";
import { MarketBookCard } from "@/components/trade/MarketBookCard";
import { TradingChart } from "@/components/trade/TradingChart";
import { MarketInfoBar } from "@/components/trade/MarketInfoBar";
import { useIsLargeScreen } from "@/hooks/useIsLargeScreen";
import { useAdvanceOraclePhase } from "@/hooks/useAdvanceOraclePhase";
import { useOrderBookVisibility } from "@/hooks/useOrderBookVisibility";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { formatUsdFromNumber } from "@/lib/format";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useToast } from "@/hooks/useToast";
import { isPlaceholderSymbol, SLUG_ALIASES } from "@/lib/symbol-utils";
import { AutoDepositProvider } from "@/components/providers/AutoDepositProvider";
// DevnetFaucetModal moved to WalletProvider (PERC-808: global placement on all pages)
import { AirdropButton } from "@/components/trade/AirdropButton";
import { ShareButton } from "@/components/market/ShareCard";
import { getNetwork } from "@/lib/config";
import { RenderProfiler } from "@/components/dev/RenderProfiler";

/**
 * Phase 3 (trade-terminal rebuild) layout notes:
 *
 * - Named CSS Grid areas (dYdX `--layout` pattern from perp-dex-reference-
 *   patterns.md Area 1), expressed as React inline styles rather than a CSS
 *   custom property + styled-components (this codebase has neither
 *   styled-components nor a CSS-in-JS layer — Tailwind + plain `style` is
 *   the native equivalent here). Areas: MarketBar (top strip) / Chart
 *   (dominant center) / Orderbook (optional column, hidden by default) /
 *   OrderTicket (~340px right rail) / PositionsDock (bottom-docked tabs).
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

function UsdToggleButton() {
  const { showUsd, setShowUsd } = useUsdToggle();
  return (
    <div className="flex gap-0.5 rounded-sm border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5">
      <button
        onClick={() => setShowUsd(false)}
        className={[
          "rounded-sm px-2 py-0.5 text-[9px] font-medium transition-colors duration-150",
          !showUsd
            ? "bg-[var(--accent)]/10 text-[var(--accent)]"
            : "text-[var(--text-dim)] hover:text-[var(--text-secondary)]",
        ].join(" ")}
      >
        tokens
      </button>
      <button
        onClick={() => setShowUsd(true)}
        className={[
          "rounded-sm px-2 py-0.5 text-[9px] font-medium transition-colors duration-150",
          showUsd
            ? "bg-[var(--accent)]/10 text-[var(--accent)]"
            : "text-[var(--text-dim)] hover:text-[var(--text-secondary)]",
        ].join(" ")}
      >
        usd
      </button>
    </div>
  );
}

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
      className="inline-flex items-center text-[var(--text-dim)] transition-colors duration-150 hover:text-[var(--accent)]"
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

function OrderTicketRail({ slab }: { slab: string }) {
  // Phase 4: DepositTrigger + AccountRiskSidebar + TradeForm consolidated
  // into the single new OrderTicket (its own "account row" now covers
  // balance/buying-power/deposit; its receipt covers the liq-price preview
  // AccountRiskSidebar used to show separately). PositionNftPanel stays —
  // distinct feature (position-as-NFT), not order-entry — candidate to move
  // into PositionsDock in Phase 5 alongside the rest of "position" UI.
  return (
    <div className="flex h-full flex-col gap-1.5 overflow-y-auto">
      <ErrorBoundary label="OrderTicket">
        <RenderProfiler id="OrderTicket">
          <OrderTicket slabAddress={slab} />
        </RenderProfiler>
      </ErrorBoundary>
      <ErrorBoundary label="PositionNftPanel"><PositionNftPanel slabAddress={slab} /></ErrorBoundary>
    </div>
  );
}

/* Phase 5: PositionsDock is now the single new components/trade/PositionsDock.tsx
 * (own internal Positions/Trades tabs, memoized, isolated live-price row —
 * see that file). The page-local wrapper this used to need is gone. */

/* ── Mobile order sheet — tap-to-open bottom sheet, 150ms functional slide (no decorative animation) ── */

function MobileOrderSheet({ slab }: { slab: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* Raised above the global MobileBottomNav (components/layout/MobileBottomNav.tsx,
          fixed bottom-0, ~56px, md:hidden) below the md breakpoint, where both are
          visible simultaneously; flush with bottom-0 at md+ where that nav hides
          itself (its own md:hidden) but this trigger is still relevant up to lg. */}
      <div className="fixed inset-x-0 bottom-16 z-40 border-t border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur-sm md:bottom-0 lg:hidden">
        <button
          onClick={() => setOpen(true)}
          className="flex w-full items-center justify-center gap-2 py-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--text)]"
        >
          Trade
        </button>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-[60] bg-black/40 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      <div
        className={`fixed inset-x-0 bottom-0 z-[61] max-h-[85dvh] overflow-y-auto rounded-t-md border-t border-[var(--border)] bg-[var(--bg)] transition-transform duration-150 ease-out lg:hidden ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
        role="dialog"
        aria-modal="true"
        aria-label="Order ticket"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--border)]/50 bg-[var(--bg)] px-3 py-2">
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Order ticket</span>
          <button onClick={() => setOpen(false)} className="text-[var(--text-dim)] transition-colors duration-150 hover:text-[var(--text)]" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="space-y-1.5 p-3">
          <OrderTicketRail slab={slab} />
        </div>
      </div>
    </>
  );
}

/* ── Main inner page ──────────────────────────────────────── */

function TradePageInner({ slab }: { slab: string }) {
  const isLargeScreen = useIsLargeScreen();
  const [orderBookVisible, toggleOrderBook] = useOrderBookVisibility();

  const { engine, config, header, loading: slabLoading, error: slabError } = useSlabState();
  useAdvanceOraclePhase(slab);
  const tokenMeta = useTokenMeta(config?.collateralMint ?? null);
  const { priceUsd } = useLivePrice();
  const shortAddress = `${slab.slice(0, 4)}…${slab.slice(-4)}`;

  // Fetch Supabase market data (symbol, name, logo, mainnet_ca) as fallback for on-chain resolution
  const [supabaseMarket, setSupabaseMarket] = useState<{ symbol?: string; name?: string; logo_url?: string; mainnet_ca?: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/markets/${slab}`)
      .then(r => r.json())
      .then(d => {
        if (!cancelled && d.market) {
          setSupabaseMarket({
            symbol: d.market.symbol ?? undefined,
            name: d.market.name ?? undefined,
            logo_url: d.market.logo_url ?? undefined,
            mainnet_ca: d.market.mainnet_ca ?? null,
          });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [slab]);

  // Resolve symbol: Supabase market symbol (trading pair) → on-chain (collateral) → truncated address
  const collateralMintAddress = config?.collateralMint?.toBase58() ?? "";
  const mintAddress = supabaseMarket?.mainnet_ca ?? collateralMintAddress;
  const onChainSymbol = tokenMeta?.symbol ?? null;
  const supabaseSymbol = supabaseMarket?.symbol ?? null;
  const symbol = (() => {
    if (!isPlaceholderSymbol(supabaseSymbol, mintAddress)) return supabaseSymbol!;
    if (!isPlaceholderSymbol(onChainSymbol, mintAddress)) return onChainSymbol!;
    if (config?.collateralMint) {
      const b58 = config.collateralMint.toBase58();
      return `${b58.slice(0, 4)}…${b58.slice(-4)}`;
    }
    return "TOKEN";
  })();
  const logoUrl = supabaseMarket?.logo_url ?? null;

  // Dynamic page title and meta tags
  useEffect(() => {
    document.title = `Trade ${symbol} | Percolator`;
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) {
      const priceText = priceUsd != null ? `Current price: ${formatUsdFromNumber(priceUsd)}` : "";
      metaDesc.setAttribute("content", `Trade ${symbol} perpetual futures on Percolator. ${priceText}`);
    }
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) ogTitle.setAttribute("content", `Trade ${symbol} | Percolator`);
    const ogDesc = document.querySelector('meta[property="og:description"]');
    if (ogDesc) {
      const priceText = priceUsd != null ? `Current price: ${formatUsdFromNumber(priceUsd)}` : "";
      ogDesc.setAttribute("content", `Trade ${symbol} perpetual futures on Percolator. ${priceText}`);
    }
  }, [symbol, priceUsd]);

  if (slabLoading && !engine) {
    return (
      <div className="min-h-[calc(100dvh-48px)] flex flex-col items-center justify-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
        <p className="text-[11px] text-[var(--text-secondary)] uppercase tracking-[0.15em]">Loading market data...</p>
        <p className="text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>{slab.slice(0, 8)}...{slab.slice(-8)}</p>
      </div>
    );
  }

  if (slabError && !engine) {
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
                <p className="mt-3 text-[10px] text-[var(--text-dim)]">
                  Try switching to <span className="text-[var(--accent)] font-medium">Devnet</span> to trade this market now.
                </p>
                <div className="mt-4 flex flex-col gap-2">
                  <button
                    onClick={() => {
                      if (typeof window !== "undefined") {
                        localStorage.setItem("percolator-network", "devnet");
                        window.location.reload();
                      }
                    }}
                    className="w-full border border-[var(--accent)]/40 bg-[var(--accent)]/5 px-4 py-2 text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors duration-150"
                  >
                    Switch to Devnet &amp; Retry
                  </button>
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
                  This slab account doesn&apos;t exist on the current devnet. The market may have been closed, or you may be looking at a mainnet market address.
                </p>
                <div className="mt-4 flex flex-col gap-2">
                  <button
                    onClick={() => {
                      if (typeof window !== "undefined") {
                        localStorage.setItem("percolator-network", "mainnet");
                        window.location.reload();
                      }
                    }}
                    className="w-full border border-[var(--border)] px-4 py-2 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text)] transition-colors duration-150"
                  >
                    Switch to Mainnet
                  </button>
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
  const hasNoPriceData = !slabLoading && !!config && priceUsd == null;

  // Desktop grid — named areas (dYdX pattern, see file-header comment).
  // Orderbook column width collapses to 0 when hidden; the area itself is
  // still declared in the template (simpler than swapping two full
  // template strings) but nothing is placed in it.
  const gridStyle: CSSProperties = {
    gridTemplateAreas: '"MarketBar MarketBar" "Chart OrderTicket" "PositionsDock OrderTicket"',
    gridTemplateColumns: orderBookVisible ? "minmax(0,1fr) 340px" : "minmax(0,1fr) 340px",
    gridTemplateRows: "auto minmax(0,1fr) minmax(220px,340px)",
  };
  // When the order book is visible it takes its own column between Chart and
  // OrderTicket — swap in a 3-column template rather than trying to make one
  // template string cover both states.
  if (orderBookVisible) {
    gridStyle.gridTemplateAreas = '"MarketBar MarketBar MarketBar" "Chart Orderbook OrderTicket" "PositionsDock PositionsDock OrderTicket"';
    gridStyle.gridTemplateColumns = "minmax(0,1fr) 220px 340px";
  }

  return (
    <RenderProfiler id="TradePageInner">
    <div className="mx-auto max-w-[1920px] overflow-x-hidden animate-fade-in">
      {hasNoPriceData && (
        <div className="border-b border-[var(--warning)]/30 bg-[var(--warning)]/5 px-4 py-2.5 text-center">
          <p className="text-[11px] font-medium text-[var(--warning)]">
            ⚠ No oracle price available for this market — prices may be stale or unavailable
          </p>
        </div>
      )}

      {/* Utility row — market address, devnet faucet, share, analytics link.
          Shown on all breakpoints (the pre-rebuild page only showed this on
          mobile; desktop had no equivalent, which was inconsistent). */}
      <div className="flex items-center gap-3 border-b border-[var(--border)]/30 px-3 py-1.5 overflow-x-auto whitespace-nowrap scrollbar-none">
        <span className="flex items-center gap-1 text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>
          {shortAddress}
          <CopyButton text={slab} />
        </span>
        {header?.admin && (
          <span className={`text-[9px] font-medium uppercase tracking-[0.12em] px-1.5 py-0.5 rounded-sm border ${
            header.admin.toBase58() === "11111111111111111111111111111111"
              ? "border-[var(--long)]/30 bg-[var(--long)]/5 text-[var(--long)]"
              : "border-[var(--warning)]/30 bg-[var(--warning)]/5 text-[var(--warning)]"
          }`}>
            {header.admin.toBase58() === "11111111111111111111111111111111" ? "Admin Renounced" : "Admin Active"}
          </span>
        )}
        <AirdropButton mintAddress={mintAddress} symbol={symbol} isDevnetMirror={supabaseMarket ? !!supabaseMarket.mainnet_ca : true} />
        <ShareButton slabAddress={slab} marketName={symbol} price={BigInt(Math.round((priceUsd ?? 0) * 1e6))} />
        <UsdToggleButton />
        <a
          href={`/analytics/${slab}`}
          className="ml-auto shrink-0 text-[10px] uppercase tracking-[0.12em] text-[var(--text-dim)] transition-colors duration-150 hover:text-[var(--accent)]"
        >
          Analytics →
        </a>
      </div>

      {/* MarketBar — always mounted, already responsive/scrollable on mobile */}
      <MarketInfoBar slabAddress={slab} symbol={symbol} logoUrl={logoUrl} mintAddress={mintAddress} />

      {/* ════════════════ DESKTOP (≥ lg) — named grid ════════════════ */}
      {isLargeScreen && (
        <div
          className="hidden lg:grid gap-3 px-4 lg:px-6 pb-3 pt-2 min-h-[calc(100dvh-140px)]"
          style={gridStyle}
        >
          <div style={{ gridArea: "Chart" }} className="min-w-0 min-h-0">
            <ErrorBoundary label="TradingChart">
              <RenderProfiler id="TradingChart">
                <div className="h-full overflow-hidden">
                  <TradingChart slabAddress={slab} mintAddress={mintAddress || undefined} />
                </div>
              </RenderProfiler>
            </ErrorBoundary>
          </div>

          {orderBookVisible && (
            <div style={{ gridArea: "Orderbook" }} className="min-w-0 min-h-0 overflow-y-auto">
              <ErrorBoundary label="MarketBookCard"><MarketBookCard /></ErrorBoundary>
            </div>
          )}

          <div style={{ gridArea: "OrderTicket" }} className="min-w-0 min-h-0">
            <RenderProfiler id="OrderTicketRail">
              <OrderTicketRail slab={slab} />
            </RenderProfiler>
          </div>

          <div style={{ gridArea: "PositionsDock" }} className="min-w-0 min-h-0 flex flex-col border border-[var(--border)]/50 bg-[var(--bg)]/80">
            <div className="flex min-h-0 flex-1 items-stretch justify-between border-b border-[var(--border)]/30 px-1">
              <RenderProfiler id="PositionsDock">
                <div className="min-h-0 min-w-0 flex-1">
                  <ErrorBoundary label="PositionsDock"><PositionsDock slabAddress={slab} /></ErrorBoundary>
                </div>
              </RenderProfiler>
              <button
                type="button"
                onClick={toggleOrderBook}
                className="shrink-0 self-start px-2 pt-1.5 text-[9px] uppercase tracking-[0.12em] text-[var(--text-dim)] transition-colors duration-150 hover:text-[var(--text-secondary)]"
              >
                {orderBookVisible ? "Hide book" : "Show book"}
              </button>
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
                <TradingChart slabAddress={slab} mintAddress={mintAddress || undefined} />
              </div>
            </RenderProfiler>
          </ErrorBoundary>

          <div className="h-[45vh] min-h-[280px] border border-[var(--border)]/50 bg-[var(--bg)]/80">
            <ErrorBoundary label="PositionsDock"><PositionsDock slabAddress={slab} /></ErrorBoundary>
          </div>

          <MobileOrderSheet slab={slab} />
        </div>
      )}
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

  return (
    <div className="min-h-[calc(100dvh-48px)] flex flex-col items-center justify-center gap-3">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
      <p className="text-[11px] text-[var(--text-secondary)] uppercase tracking-[0.15em]">Resolving market…</p>
      <p className="text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>{slug}</p>
    </div>
  );
}

export default function TradePage({ params }: { params: Promise<{ slab: string }> }) {
  const { slab } = use(params);

  if (!isValidPublicKey(slab)) {
    return <SlugResolvePage slug={slab} />;
  }

  return (
    <SlabProvider slabAddress={slab}>
      <UsdToggleProvider>
        <AutoDepositProvider slabAddress={slab}>
          <TradePageInner slab={slab} />
        </AutoDepositProvider>
      </UsdToggleProvider>
    </SlabProvider>
  );
}
