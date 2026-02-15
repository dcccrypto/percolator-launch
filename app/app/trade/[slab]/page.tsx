"use client";

import { use, useState, useRef, useEffect } from "react";
import gsap from "gsap";
import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { UsdToggleProvider, useUsdToggle } from "@/components/providers/UsdToggleProvider";
import { TradeForm } from "@/components/trade/TradeForm";
import { PositionPanel } from "@/components/trade/PositionPanel";
import { AccountsCard } from "@/components/trade/AccountsCard";
import { DepositWithdrawCard } from "@/components/trade/DepositWithdrawCard";
import { EngineHealthCard } from "@/components/trade/EngineHealthCard";
import { MarketStatsCard } from "@/components/trade/MarketStatsCard";
import { MarketBookCard } from "@/components/trade/MarketBookCard";
import { TradingChart } from "@/components/trade/TradingChart";
import { TradeHistory } from "@/components/trade/TradeHistory";
import { LiquidationAnalytics } from "@/components/trade/LiquidationAnalytics";
import { CrankHealthCard } from "@/components/trade/CrankHealthCard";
import { SystemCapitalCard } from "@/components/trade/SystemCapitalCard";
import { HealthBadge } from "@/components/market/HealthBadge";
import { ShareButton } from "@/components/market/ShareCard";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { computeMarketHealth } from "@/lib/health";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useToast } from "@/hooks/useToast";

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
      <div className="flex border-b border-[var(--border)]/50 bg-transparent">
        {tabs.map((label, i) => (
          <button
            key={label}
            onClick={() => setActive(i)}
            className={`px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] transition-colors border-b-2 ${
              active === i
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--border)]"
            }`}
          >
            {label}
          </button>
        ))}
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
  const { engine, config, accounts, loading: slabLoading, error: slabError } = useSlabState();
  const tokenMeta = useTokenMeta(config?.collateralMint ?? null);
  const { priceUsd } = useLivePrice();
  const health = engine ? computeMarketHealth(engine) : null;
  const pageRef = useRef<HTMLDivElement>(null);
  // No wallet/account → Deposit tab (2), has capital → Position tab (0)
  const hasCapital = accounts.some(a => a.account.capital > 0n || a.account.positionSize !== 0n);
  const defaultLeftTab = hasCapital ? 0 : 2;

  const symbol = tokenMeta?.symbol ?? (config?.collateralMint ? `${config.collateralMint.toBase58().slice(0, 4)}…${config.collateralMint.toBase58().slice(-4)}` : "TOKEN");
  const shortAddress = `${slab.slice(0, 4)}…${slab.slice(-4)}`;

  // Dynamic page title
  useEffect(() => {
    document.title = `${symbol}/USD — Percolator`;
  }, [symbol]);

  const priceDisplay = priceUsd != null
    ? `$${priceUsd < 0.01 ? priceUsd.toFixed(6) : priceUsd < 1 ? priceUsd.toFixed(4) : priceUsd.toFixed(2)}`
    : null;

  useEffect(() => {
    if (!pageRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      pageRef.current.style.opacity = "1";
      return;
    }
    gsap.fromTo(pageRef.current, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power2.out" });
  }, []);

  // Loading state — show while slab data is being fetched
  if (slabLoading && !engine) {
    return (
      <div className="min-h-[calc(100vh-48px)] flex flex-col items-center justify-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
        <p className="text-[11px] text-[var(--text-muted)] uppercase tracking-[0.15em]">Loading market data...</p>
        <p className="text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>{slab.slice(0, 8)}...{slab.slice(-8)}</p>
      </div>
    );
  }

  // Error state — show when slab data fails to load
  if (slabError && !engine) {
    return (
      <div className="min-h-[calc(100vh-48px)] flex flex-col items-center justify-center gap-3">
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

  return (
    <div ref={pageRef} className="mx-auto max-w-7xl overflow-x-hidden gsap-fade">

      {/* ── MOBILE: Sticky header ── */}
      <div className="sticky top-0 z-30 border-b border-[var(--border)]/50 bg-[var(--bg)]/95 px-3 py-2 backdrop-blur-sm lg:hidden">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>
              {symbol}/USD <span className="text-[10px] font-normal uppercase tracking-[0.15em] text-[var(--text-muted)]">PERP</span>
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <UsdToggleButton />
            {health && <HealthBadge level={health.level} />}
            {priceDisplay && (
              <span className="text-sm font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{priceDisplay}</span>
            )}
          </div>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span className="flex items-center text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>
            {shortAddress}
            <CopyButton text={slab} />
          </span>
          <ShareButton
            slabAddress={slab}
            marketName={symbol}
            price={BigInt(Math.round((priceUsd ?? 0) * 1e6))}
          />
        </div>
      </div>

      {/* ── DESKTOP: Full header ── */}
      <div className="hidden lg:flex items-start justify-between px-4 py-2 gap-3 border-b border-[var(--border)]/30">
        <div className="min-w-0">
          <p className="mb-0.5 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--accent)]/70">// TRADE</p>
          <h1 className="text-lg font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>
            {symbol}/USD <span className="text-xs font-normal text-[var(--text-muted)]">PERP</span>
          </h1>
          <div className="mt-0.5 flex items-center gap-3">
            <span className="flex items-center text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>
              {shortAddress}
              <CopyButton text={slab} />
            </span>
            {health && <HealthBadge level={health.level} />}
            <ShareButton
              slabAddress={slab}
              marketName={symbol}
              price={BigInt(Math.round((priceUsd ?? 0) * 1e6))}
            />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <UsdToggleButton />
          {priceDisplay && (
            <div className="text-right">
              <div className="text-xl font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{priceDisplay}</div>
            </div>
          )}
        </div>
      </div>

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
        {/* Chart */}
        <ErrorBoundary label="TradingChart">
          <div className="w-full overflow-hidden">
            <TradingChart slabAddress={slab} />
          </div>
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

        {/* Account / Deposit — collapsible */}
        <ErrorBoundary label="DepositWithdrawCard">
          <Collapsible title="Deposit / Withdraw" defaultOpen={false}>
            <DepositWithdrawCard slabAddress={slab} />
          </Collapsible>
        </ErrorBoundary>

        <ErrorBoundary label="AccountsCard">
          <Collapsible title="Positions & Liqs" defaultOpen={false}>
            <AccountsCard />
          </Collapsible>
        </ErrorBoundary>

        {/* Bottom tabs: Stats | Trades | Book */}
        <Tabs tabs={["Stats", "Trades", "Risk", "Book"]}>
          <ErrorBoundary label="MarketStatsCard"><MarketStatsCard /></ErrorBoundary>
          <ErrorBoundary label="TradeHistory"><TradeHistory slabAddress={slab} /></ErrorBoundary>
          <ErrorBoundary label="RiskAnalytics">
            <CrankHealthCard />
            <div className="mt-2"><LiquidationAnalytics /></div>
            <div className="mt-2"><SystemCapitalCard /></div>
          </ErrorBoundary>
          <ErrorBoundary label="MarketBookCard"><MarketBookCard /></ErrorBoundary>
        </Tabs>
      </div>

      {/* ════════════════════════════════════════════════════════
          DESKTOP LAYOUT  (≥ lg / 1024px)
          Two columns: left ~68%, right ~32%
          ════════════════════════════════════════════════════════ */}
      <div className="hidden lg:grid grid-cols-[1fr_340px] gap-1.5 px-3 pb-3 pt-1.5">
        {/* ── Left column ── */}
        <div className="min-w-0 space-y-1.5">
          {/* Chart */}
          <ErrorBoundary label="TradingChart">
            <TradingChart slabAddress={slab} />
          </ErrorBoundary>

          {/* Position / Account / Deposit — tabbed */}
          <Tabs tabs={["Position", "Positions & Liqs", "Deposit"]} defaultTab={defaultLeftTab}>
            <ErrorBoundary label="PositionPanel"><PositionPanel slabAddress={slab} /></ErrorBoundary>
            <ErrorBoundary label="AccountsCard"><AccountsCard /></ErrorBoundary>
            <ErrorBoundary label="DepositWithdrawCard"><DepositWithdrawCard slabAddress={slab} /></ErrorBoundary>
          </Tabs>
        </div>

        {/* ── Right column ── */}
        <div className="min-w-0 space-y-1.5">
          {/* Trade form — sticky */}
          <div className="sticky top-0 z-20">
            <ErrorBoundary label="TradeForm">
              <TradeForm slabAddress={slab} />
            </ErrorBoundary>
          </div>

          {/* Market info tabs */}
          <Tabs tabs={["Stats", "Trades", "Health", "Risk", "Book"]}>
            <ErrorBoundary label="MarketStatsCard"><MarketStatsCard /></ErrorBoundary>
            <ErrorBoundary label="TradeHistory"><TradeHistory slabAddress={slab} /></ErrorBoundary>
            <ErrorBoundary label="EngineHealthCard">
              <EngineHealthCard />
              <div className="mt-2"><CrankHealthCard /></div>
            </ErrorBoundary>
            <ErrorBoundary label="RiskAnalytics">
              <LiquidationAnalytics />
              <div className="mt-2"><SystemCapitalCard /></div>
            </ErrorBoundary>
            <ErrorBoundary label="MarketBookCard"><MarketBookCard /></ErrorBoundary>
          </Tabs>
        </div>
      </div>
    </div>
  );
}

export default function TradePage({ params }: { params: Promise<{ slab: string }> }) {
  const { slab } = use(params);

  return (
    <SlabProvider slabAddress={slab}>
      <UsdToggleProvider>
        <TradePageInner slab={slab} />
      </UsdToggleProvider>
    </SlabProvider>
  );
}
