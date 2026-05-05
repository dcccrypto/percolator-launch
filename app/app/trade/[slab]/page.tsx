"use client";

import { use, useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import gsap from "gsap";
import { PublicKey } from "@solana/web3.js";
import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { UsdToggleProvider, useUsdToggle } from "@/components/providers/UsdToggleProvider";
import { TradeForm } from "@/components/trade/TradeForm";
import { PositionPanel } from "@/components/trade/PositionPanel";
import { PositionNftPanel } from "@/components/trade/PositionNftPanel";
import { PositionsTable } from "@/components/trade/PositionsTable";
import { AccountsCard } from "@/components/trade/AccountsCard";
import { DepositTrigger } from "@/components/trade/DepositTrigger";
import { EngineHealthCard } from "@/components/trade/EngineHealthCard";
import { MarketStatsCard } from "@/components/trade/MarketStatsCard";
import { MarketBookCard } from "@/components/trade/MarketBookCard";
import { TradingChart } from "@/components/trade/TradingChart";
import { MarketInfoBar } from "@/components/trade/MarketInfoBar";
import { useIsLargeScreen } from "@/hooks/useIsLargeScreen";
import { useAdvanceOraclePhase } from "@/hooks/useAdvanceOraclePhase";
import { useOrderBookVisibility } from "@/hooks/useOrderBookVisibility";
import { TradeHistory } from "@/components/trade/TradeHistory";
import { LiquidationAnalytics } from "@/components/trade/LiquidationAnalytics";
import { AdlLeaderboard } from "@/components/trade/AdlLeaderboard";
import { CrankHealthCard } from "@/components/trade/CrankHealthCard";
import { SystemCapitalCard } from "@/components/trade/SystemCapitalCard";
import { OpenInterestCard } from "@/components/market/OpenInterestCard";
import { InsuranceDashboard } from "@/components/market/InsuranceDashboard";
import { HealthBadge } from "@/components/market/HealthBadge";
import { ShareButton } from "@/components/market/ShareCard";
import { MarketLogo } from "@/components/market/MarketLogo";
import { MarketSelector } from "@/components/trade/MarketSelector";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { computeMarketHealth } from "@/lib/health";
import { formatUsdFromNumber } from "@/lib/format";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useToast } from "@/hooks/useToast";
import { isPlaceholderSymbol, SLUG_ALIASES } from "@/lib/symbol-utils";
import { OracleBadge } from "@/components/oracle/OracleBadge";
import { useOracleFreshness } from "@/hooks/useOracleFreshness";
import { AutoDepositProvider } from "@/components/providers/AutoDepositProvider";
// DevnetFaucetModal moved to WalletProvider (PERC-808: global placement on all pages)
import { AirdropButton } from "@/components/trade/AirdropButton";
import { getNetwork } from "@/lib/config";

/* ── Reusable tiny components ─────────────────────────────── */

function UsdToggleButton() {
  const { showUsd, setShowUsd } = useUsdToggle();
  return (
    <div className="flex gap-0.5 rounded-sm border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5">
      <button
        onClick={() => setShowUsd(false)}
        className={[
          "rounded-sm px-2 py-0.5 text-[9px] font-medium transition-all duration-200",
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
          "rounded-sm px-2 py-0.5 text-[9px] font-medium transition-all duration-200",
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

function Collapsible({ title, defaultOpen = true, badge, children }: { title: string; defaultOpen?: boolean; badge?: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)] transition-colors hover:text-[var(--text-secondary)]"
      >
        <span className="flex items-center gap-2">
          {title}
          {badge}
        </span>
        <span className={`text-[9px] text-[var(--text-dim)] transition-transform duration-200 ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      <div className={open ? "block" : "hidden"}>{children}</div>
    </div>
  );
}

function Tabs({ tabs, children, defaultTab }: { tabs: string[]; children: React.ReactNode[]; defaultTab?: number }) {
  const [active, setActive] = useState(defaultTab ?? 0);
  return (
    <div>
      {/* overflow-x-auto + whitespace-nowrap prevents 5-tab bar from overflowing at 375px (#860) */}
      <div className="overflow-x-auto border-b border-[var(--border)]/50 bg-transparent">
        <div className="flex whitespace-nowrap">
          {tabs.map((label, i) => (
            <button
              key={label}
              onClick={() => setActive(i)}
              className={`shrink-0 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] transition-colors border-b-2 ${
                active === i
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--border)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div>{children[active]}</div>
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
      className="ml-1.5 inline-flex items-center text-[var(--text-dim)] transition-colors hover:text-[var(--accent)]"
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

/* ── Main inner page ──────────────────────────────────────── */

function TradePageInner({ slab }: { slab: string }) {
  // Render TradingChart exactly once by tracking breakpoint in JS.
  // CSS-only hidden/shown dual-mount caused two ChartEmptyState instances to stack
  // during SSR/hydration before the responsive classes were applied (P0 render bug).
  const isLargeScreen = useIsLargeScreen();
  const [orderBookVisible, toggleOrderBook] = useOrderBookVisibility();

  const { engine, config, header, accounts, loading: slabLoading, error: slabError } = useSlabState();
  useAdvanceOraclePhase(slab);
  const tokenMeta = useTokenMeta(config?.collateralMint ?? null);
  const { priceUsd } = useLivePrice();
  const health = engine ? computeMarketHealth(engine) : null;
  const { mode: oracleMode, level: oracleLevel } = useOracleFreshness();
  const oracleBadgeStatus = oracleLevel === "stale" ? "stale" : "healthy";
  const pageRef = useRef<HTMLDivElement>(null);
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
            // GH#1210: used to determine whether Get Token button should be shown
            mainnet_ca: d.market.mainnet_ca ?? null,
          });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [slab]);

  // Resolve symbol: Supabase market symbol (trading pair) → on-chain (collateral) → truncated address
  // BUG FIX: Supabase symbol represents the TRADING PAIR (e.g. "SOL"), while on-chain
  // tokenMeta symbol is the COLLATERAL token (e.g. "USDC"). Previously on-chain was
  // preferred, causing a USDC-collateralized SOL market to show as "USDC/USD".
  const collateralMintAddress = config?.collateralMint?.toBase58() ?? "";
  // BUG FIX: Use the trading pair's base asset mint (mainnet_ca from Supabase) for the chart
  // and logo, NOT the collateral mint. A SOL/USD perp collateralized in USDC should show
  // SOL candles in the chart, not USDC candles.
  const mintAddress = supabaseMarket?.mainnet_ca ?? collateralMintAddress;
  const onChainSymbol = tokenMeta?.symbol ?? null;
  const supabaseSymbol = supabaseMarket?.symbol ?? null;
  const symbol = (() => {
    // 1. Supabase symbol (market trading pair — authoritative for display)
    if (!isPlaceholderSymbol(supabaseSymbol, mintAddress)) return supabaseSymbol!;
    // 2. On-chain symbol (collateral token — fallback when no DB entry)
    if (!isPlaceholderSymbol(onChainSymbol, mintAddress)) return onChainSymbol!;
    // 3. Fallback: truncated mint address
    if (config?.collateralMint) {
      const b58 = config.collateralMint.toBase58();
      return `${b58.slice(0, 4)}…${b58.slice(-4)}`;
    }
    return "TOKEN";
  })();

  // Logo URL from Supabase market data
  const logoUrl = supabaseMarket?.logo_url ?? null;

  // Dynamic page title and meta tags
  useEffect(() => {
    document.title = `Trade ${symbol} | Percolator`;
    
    // Update meta description
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) {
      const priceText = priceUsd != null ? `Current price: ${formatUsdFromNumber(priceUsd)}` : "";
      metaDesc.setAttribute("content", `Trade ${symbol} perpetual futures on Percolator. ${priceText}`);
    }

    // Update OG tags dynamically
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) ogTitle.setAttribute("content", `Trade ${symbol} | Percolator`);
    
    const ogDesc = document.querySelector('meta[property="og:description"]');
    if (ogDesc) {
      const priceText = priceUsd != null ? `Current price: ${formatUsdFromNumber(priceUsd)}` : "";
      ogDesc.setAttribute("content", `Trade ${symbol} perpetual futures on Percolator. ${priceText}`);
    }
    
  }, [symbol, priceUsd]);

  // Track whether the fade-in animation has already been applied
  const animatedRef = useRef(false);

  useEffect(() => {
    if (!pageRef.current || animatedRef.current) return;
    animatedRef.current = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      pageRef.current.style.opacity = "1";
      return;
    }
    gsap.fromTo(pageRef.current, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power2.out" });
  }); // No deps — runs every render until pageRef is available

  // Loading state — show while slab data is being fetched
  if (slabLoading && !engine) {
    return (
      <div className="min-h-[calc(100dvh-48px)] flex flex-col items-center justify-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
        <p className="text-[11px] text-[var(--text-muted)] uppercase tracking-[0.15em]">Loading market data...</p>
        <p className="text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>{slab.slice(0, 8)}...{slab.slice(-8)}</p>
      </div>
    );
  }

  // Error state — show when slab data fails to load
  if (slabError && !engine) {
    // Detect "account not found on-chain" — show network-aware helpful message
    // instead of a generic error (PERC-8375)
    const isNotFound =
      slabError.includes("not found on-chain") ||
      slabError.includes("Market not found") ||
      slabError.includes("Account not found");

    if (isNotFound) {
      const network = getNetwork();
      return (
        <div className="min-h-[calc(100dvh-48px)] flex flex-col items-center justify-center gap-3 px-4">
          <div className="border border-[var(--border)]/60 bg-[var(--bg-elevated)] p-6 text-center max-w-sm w-full">
            {/* Icon */}
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
                    className="w-full border border-[var(--accent)]/40 bg-[var(--accent)]/5 px-4 py-2 text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors"
                  >
                    Switch to Devnet &amp; Retry
                  </button>
                  <a
                    href="/markets"
                    className="w-full border border-[var(--border)] px-4 py-2 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text)] transition-colors"
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
                    className="w-full border border-[var(--border)] px-4 py-2 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text)] transition-colors"
                  >
                    Switch to Mainnet
                  </button>
                  <a
                    href="/markets"
                    className="w-full border border-[var(--border)] px-4 py-2 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text)] transition-colors"
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
            className="mt-4 border border-[var(--border)] px-4 py-1.5 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text)] transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // #1155: Show warning banner when market has loaded but no oracle price available
  const hasNoPriceData = !slabLoading && engine && priceUsd == null;

  return (
    <div ref={pageRef} className="mx-auto max-w-[1920px] overflow-x-hidden gsap-fade">

      {/* #1155: No oracle price banner */}
      {hasNoPriceData && (
        <div className="border-b border-[var(--warning)]/30 bg-[var(--warning)]/5 px-4 py-2.5 text-center">
          <p className="text-[11px] font-medium text-[var(--warning)]">
            ⚠ No oracle price available for this market — prices may be stale or unavailable
          </p>
        </div>
      )}

      {/* ── MOBILE: Sticky header ── */}
      <div className="sticky top-0 z-30 border-b border-[var(--border)]/50 bg-[var(--bg)]/95 px-3 py-2 backdrop-blur-sm lg:hidden">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <MarketLogo logoUrl={logoUrl} mintAddress={config?.collateralMint?.toBase58()} symbol={symbol} size="sm" />
              <h1 className="text-sm font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>
                {symbol}/USD <span className="text-[10px] font-normal uppercase tracking-[0.15em] text-[var(--text-muted)]">PERP</span>
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
            <UsdToggleButton />
            {health && <HealthBadge level={health.level} />}
            {oracleMode && <OracleBadge mode={oracleMode} status={oracleBadgeStatus} />}
          </div>
        </div>
        <div className="mt-1 flex items-center gap-2 flex-wrap">
          <span className="flex items-center text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>
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
          <ShareButton
            slabAddress={slab}
            marketName={symbol}
            price={BigInt(Math.round((priceUsd ?? 0) * 1e6))}
          />
        </div>
      </div>

      {/* ── Market info bar (all breakpoints — horizontally scrollable on mobile) ── */}
      <MarketInfoBar slabAddress={slab} symbol={symbol} logoUrl={logoUrl} mintAddress={mintAddress} />


      {/* ── Quick start guide — desktop only, hidden after first trade ── */}
      {accounts.filter(a => a.account.capital > 0n || a.account.positionSize !== 0n).length === 0 && (
      <div className="hidden md:flex mx-4 mb-2 mt-2 rounded-none border border-[var(--border)]/30 bg-[var(--bg)]/80 px-3 py-1.5 items-center gap-4 text-[10px] text-[var(--text-secondary)] uppercase tracking-[0.1em]">
        <span className="text-[var(--text-dim)]">quick start:</span>
        <span><span className="text-[var(--long)]">1</span> connect wallet</span>
        <span className="text-[var(--text-dim)]">&rarr;</span>
        <span><span className="text-[var(--long)]">2</span> create account</span>
        <span className="text-[var(--text-dim)]">&rarr;</span>
        <span><span className="text-[var(--long)]">3</span> deposit collateral</span>
        <span className="text-[var(--text-dim)]">&rarr;</span>
        <span><span className="text-[var(--long)]">4</span> trade</span>
      </div>
      )}

      {/* ════════════════════════════════════════════════════════
          MOBILE LAYOUT  (< lg)
          Single column, everything stacked
          ════════════════════════════════════════════════════════ */}
      <div className="flex flex-col gap-1.5 px-2 pt-2 pb-4 lg:hidden min-w-0 w-full">
        {/* Chart — only mount on mobile to prevent dual ChartEmptyState stacking */}
        {!isLargeScreen && (
          <ErrorBoundary label="TradingChart">
            <div className="w-full overflow-hidden">
              <TradingChart slabAddress={slab} mintAddress={mintAddress || undefined} />
            </div>
          </ErrorBoundary>
        )}

        {/* Deposit trigger */}
        <ErrorBoundary label="DepositTrigger">
          <DepositTrigger slabAddress={slab} />
        </ErrorBoundary>

        {/* Trade form */}
        <ErrorBoundary label="TradeForm">
          <TradeForm slabAddress={slab} />
        </ErrorBoundary>

        {/* Position — collapsible */}
        <ErrorBoundary label="PositionPanel">
          <Collapsible title="Position" defaultOpen={true}>
            <PositionPanel slabAddress={slab} />
          </Collapsible>
        </ErrorBoundary>

        {/* Position NFT */}
        <ErrorBoundary label="PositionNftPanel">
          <Collapsible title="Position NFT" defaultOpen={false}>
            <PositionNftPanel slabAddress={slab} />
          </Collapsible>
        </ErrorBoundary>

        <ErrorBoundary label="AccountsCard">
          <Collapsible title="Positions & Liqs" defaultOpen={false}>
            <AccountsCard />
          </Collapsible>
        </ErrorBoundary>

        {/* Bottom tabs — "Book" tab only appears when the user has opted-in.
            Toggle persists via useOrderBookVisibility (localStorage). */}
        <Tabs tabs={orderBookVisible
          ? ["Stats", "Trades", "Health", "Risk", "ADL", "Book"]
          : ["Stats", "Trades", "Health", "Risk", "ADL"]}>
          <ErrorBoundary label="MarketStatsCard"><MarketStatsCard /></ErrorBoundary>
          <ErrorBoundary label="TradeHistory"><TradeHistory slabAddress={slab} /></ErrorBoundary>
          <ErrorBoundary label="EngineHealthCard">
            <EngineHealthCard />
            <div className="mt-2"><CrankHealthCard /></div>
          </ErrorBoundary>
          <ErrorBoundary label="RiskAnalytics">
            <OpenInterestCard slabAddress={slab} />
            <div className="mt-2"><InsuranceDashboard slabAddress={slab} /></div>
            <div className="mt-2"><CrankHealthCard /></div>
            <div className="mt-2"><LiquidationAnalytics /></div>
            <div className="mt-2"><SystemCapitalCard /></div>
          </ErrorBoundary>
          <ErrorBoundary label="AdlLeaderboard">
            <AdlLeaderboard slabAddress={slab} />
          </ErrorBoundary>
          {orderBookVisible && (
            <ErrorBoundary label="MarketBookCard"><MarketBookCard /></ErrorBoundary>
          )}
        </Tabs>
        {!orderBookVisible && (
          <button
            type="button"
            onClick={toggleOrderBook}
            className="mt-2 w-full rounded-none border border-[var(--border)]/40 bg-[var(--bg)]/40 px-3 py-1.5 text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)] hover:border-[var(--accent)]/30 hover:text-[var(--text-secondary)]"
          >
            ⟨ Show order book
          </button>
        )}
      </div>

      {/* ════════════════════════════════════════════════════════
          DESKTOP LAYOUT  (≥ lg / 1024px)
          Three columns when order book visible, two when collapsed.
          Middle column (Book) can be toggled off via the × on the book
          or the "Show order book" button rendered inline.
          ════════════════════════════════════════════════════════ */}
      <div className={`hidden lg:grid gap-4 px-4 lg:px-6 pb-3 pt-2 ${
        orderBookVisible
          ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,220px)_minmax(0,340px)]"
          : "lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]"
      }`}>
        {/* ── Left column: Chart + Positions ── */}
        <div className="min-w-0 flex flex-col gap-0">
          {/* Chart — only mount on desktop to prevent dual ChartEmptyState stacking */}
          {isLargeScreen && (
            <ErrorBoundary label="TradingChart">
              {/* Chart height bumped 500 → 640 so the time axis + price axis
                  labels + volume pane can all render without clipping against
                  the container edges. Component internals (TradingChart.tsx)
                  also set w-full h-full so autoSize: true fills this wrapper. */}
              <div className="h-[640px] overflow-hidden">
                <TradingChart slabAddress={slab} mintAddress={mintAddress || undefined} />
              </div>
            </ErrorBoundary>
          )}

          {/* My Positions / Account — tabbed */}
          <Tabs tabs={["My Positions", "Positions & Liqs"]}>
            <ErrorBoundary label="PositionsTable"><PositionsTable slabAddress={slab} /></ErrorBoundary>
            <ErrorBoundary label="AccountsCard"><AccountsCard /></ErrorBoundary>
          </Tabs>
        </div>

        {/* ── Middle column: Order Book (toggleable) ── */}
        {orderBookVisible && (
          <div className="min-w-0">
            <ErrorBoundary label="MarketBookCard">
              <MarketBookCard />
            </ErrorBoundary>
          </div>
        )}

        {/* ── Right column: Trade Panel ── */}
        <div className="min-w-0 space-y-1.5">
          <div className="sticky top-0 z-20 space-y-1.5">
            <ErrorBoundary label="DepositTrigger">
              <DepositTrigger slabAddress={slab} />
            </ErrorBoundary>
            <ErrorBoundary label="TradeForm">
              <TradeForm slabAddress={slab} />
            </ErrorBoundary>
            <ErrorBoundary label="PositionNftPanel">
              <PositionNftPanel slabAddress={slab} />
            </ErrorBoundary>
          </div>

          {/* Market info tabs — Book removed (now in middle column) */}
          <Tabs tabs={["Stats", "Trades", "Health", "Risk", "ADL"]}>
            <ErrorBoundary label="MarketStatsCard"><MarketStatsCard /></ErrorBoundary>
            <ErrorBoundary label="TradeHistory"><TradeHistory slabAddress={slab} /></ErrorBoundary>
            <ErrorBoundary label="EngineHealthCard">
              <EngineHealthCard />
              <div className="mt-2"><CrankHealthCard /></div>
            </ErrorBoundary>
            <ErrorBoundary label="RiskAnalytics">
              <OpenInterestCard slabAddress={slab} />
              <div className="mt-1.5"><InsuranceDashboard slabAddress={slab} /></div>
              <div className="mt-1.5"><LiquidationAnalytics /></div>
              <div className="mt-1.5"><SystemCapitalCard /></div>
            </ErrorBoundary>
            <ErrorBoundary label="AdlLeaderboard">
              <AdlLeaderboard slabAddress={slab} />
            </ErrorBoundary>
          </Tabs>
          {!orderBookVisible && (
            <button
              type="button"
              onClick={toggleOrderBook}
              className="w-full rounded-none border border-[var(--border)]/40 bg-[var(--bg)]/40 px-3 py-1.5 text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)] hover:border-[var(--accent)]/30 hover:text-[var(--text-secondary)]"
            >
              ⟨ Show order book
            </button>
          )}
        </div>
      </div>

    </div>
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
          className="mt-4 inline-block border border-[var(--border)] px-4 py-1.5 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text)] transition-colors"
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
        // Normalize: "SOL-PERP" → "SOL", then match against symbol
        const slugNorm = slug.toUpperCase().replace(/-PERP$/, "");

        // Sort to prefer the most active slab when multiple markets share the same symbol / mint.
        // Treat volume_24h=0 and null identically as "no volume" (-1) so a stale slab with
        // explicit vol=0 never beats a fresh slab with vol=null (fixes issue #721).
        // Tiebreakers: total_open_interest DESC, then created_at DESC (newest wins).
        const sorted = [...markets].sort((a, b) => {
          const va = typeof a.volume_24h === "number" && a.volume_24h > 0 ? a.volume_24h : -1;
          const vb = typeof b.volume_24h === "number" && b.volume_24h > 0 ? b.volume_24h : -1;
          if (vb !== va) return vb - va;
          const oa = typeof a.total_open_interest === "number" && a.total_open_interest > 0 ? a.total_open_interest : -1;
          const ob = typeof b.total_open_interest === "number" && b.total_open_interest > 0 ? b.total_open_interest : -1;
          if (ob !== oa) return ob - oa;
          return new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime();
        });

        // 1. Try matching by symbol name
        let match = sorted.find((m) => {
          const sym = (m.symbol ?? "").toUpperCase().replace(/-PERP$/, "");
          return sym === slugNorm || (m.symbol ?? "").toUpperCase() === slug.toUpperCase();
        });

        // 2. If no symbol match, try well-known slug aliases (e.g. SOL → mint address)
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
      <p className="text-[11px] text-[var(--text-muted)] uppercase tracking-[0.15em]">Resolving market…</p>
      <p className="text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>{slug}</p>
    </div>
  );
}

export default function TradePage({ params }: { params: Promise<{ slab: string }> }) {
  const { slab } = use(params);

  // If not a valid pubkey, try resolving as a market slug (e.g. SOL-PERP)
  if (!isValidPublicKey(slab)) {
    // Not a valid base58 pubkey — try slug resolution (e.g. "SOL-PERP" → actual slab address)
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
