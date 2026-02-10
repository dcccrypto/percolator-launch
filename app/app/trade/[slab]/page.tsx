"use client";

import { use, useState, useRef, useEffect } from "react";
import gsap from "gsap";
import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { TradeForm } from "@/components/trade/TradeForm";
import { PositionPanel } from "@/components/trade/PositionPanel";
import { AccountsCard } from "@/components/trade/AccountsCard";
import { DepositWithdrawCard } from "@/components/trade/DepositWithdrawCard";
import { EngineHealthCard } from "@/components/trade/EngineHealthCard";
import { MarketStatsCard } from "@/components/trade/MarketStatsCard";
import { MarketBookCard } from "@/components/trade/MarketBookCard";
import { PriceChart } from "@/components/trade/PriceChart";
import { TradeHistory } from "@/components/trade/TradeHistory";
import { HealthBadge } from "@/components/market/HealthBadge";
import { ShareButton } from "@/components/market/ShareCard";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { computeMarketHealth } from "@/lib/health";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { InfoBanner } from "@/components/ui/InfoBanner";

function Collapsible({ title, defaultOpen = true, badge, children }: { title: string; defaultOpen?: boolean; badge?: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)]">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-5 py-4 text-left text-xs font-medium uppercase tracking-wider text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
        style={{ fontFamily: "var(--font-jetbrains-mono)" }}
      >
        <span className="flex items-center gap-2">
          {title}
          {badge}
        </span>
        <span className={`text-[10px] text-[var(--text-muted)] transition-transform duration-200 ${open ? "rotate-180" : ""}`}>&#9660;</span>
      </button>
      <div className={open ? "block" : "hidden"}>{children}</div>
    </div>
  );
}

function TradePageInner({ slab }: { slab: string }) {
  const { engine, config } = useSlabState();
  const tokenMeta = useTokenMeta(config?.collateralMint ?? null);
  const { priceUsd: livePriceUsd, change24h } = useLivePrice();
  const symbol = tokenMeta?.symbol ?? null;
  const onChainPrice = config?.lastEffectivePriceE6 ?? config?.authorityPriceE6 ?? null;
  const priceUsd = livePriceUsd ?? (onChainPrice ? Number(onChainPrice) / 1e6 : null);
  const health = engine ? computeMarketHealth(engine) : null;
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pageRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      pageRef.current.style.opacity = "1";
      return;
    }
    gsap.fromTo(pageRef.current, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power2.out" });
  }, []);

  return (
    <div ref={pageRef} className="mx-auto max-w-7xl px-4 py-6 gsap-fade">
      {/* Header */}
      <div className="mb-6 space-y-2">
        {/* Line 1: comment prefix */}
        <div className="text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
          // trade
        </div>

        {/* Line 2: title + price */}
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-xl font-bold tracking-tight text-[var(--text)] sm:text-2xl" style={{ fontFamily: "var(--font-space-grotesk)" }}>
            {symbol ? `${symbol}/USD` : "\u2014"}
            <span className="ml-2 text-sm font-normal text-[var(--text-muted)]">PERP</span>
          </h1>
          {priceUsd != null && (
            <div className="shrink-0 text-2xl font-bold text-[var(--text)] sm:text-3xl" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
              ${priceUsd < 0.01 ? priceUsd.toFixed(6) : priceUsd < 1 ? priceUsd.toFixed(4) : priceUsd.toFixed(2)}
            </div>
          )}
        </div>

        {/* Line 3: address, badge, share, 24h stats */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="text-[var(--text-muted)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
            {slab.slice(0, 4)}&hellip;{slab.slice(-4)}
          </span>
          {health && <HealthBadge level={health.level} />}
          <ShareButton
            slabAddress={slab}
            marketName={symbol ?? (config?.collateralMint ? `${config.collateralMint.toBase58().slice(0, 4)}…${config.collateralMint.toBase58().slice(-4)}` : "TOKEN")}
            price={BigInt(Math.round((priceUsd ?? 0) * 1e6))}
          />
          {change24h != null && (
            <span className={change24h >= 0 ? "text-[var(--long)]" : "text-[var(--short)]"}>
              {change24h >= 0 ? "\u25B2" : "\u25BC"} {change24h >= 0 ? "+" : ""}{change24h.toFixed(2)}%
            </span>
          )}
        </div>
      </div>

      {/* Admin oracle banner */}
      {config?.indexFeedId && config.indexFeedId.toBase58() === "11111111111111111111111111111111" && (
        <div className="mb-4">
          <InfoBanner variant="warning">Admin Oracle — prices are pushed manually by the market creator</InfoBanner>
        </div>
      )}

      {/* Quick start guide */}
      <div className="mb-4 rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
        <span className="text-[var(--text-muted)]">quick start:</span>
        <span className="whitespace-nowrap"><span className="text-[var(--long)]">1</span> connect wallet</span>
        <span className="hidden sm:inline text-[var(--border)]">&rarr;</span>
        <span className="whitespace-nowrap"><span className="text-[var(--long)]">2</span> create account</span>
        <span className="hidden sm:inline text-[var(--border)]">&rarr;</span>
        <span className="whitespace-nowrap"><span className="text-[var(--long)]">3</span> deposit collateral</span>
        <span className="hidden sm:inline text-[var(--border)]">&rarr;</span>
        <span className="whitespace-nowrap"><span className="text-[var(--long)]">4</span> trade</span>
      </div>

      {/* Main grid */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Left column */}
        <div className="space-y-4 lg:col-span-2">
          <ErrorBoundary label="PriceChart">
            <div className="overflow-hidden rounded-sm border border-[var(--border)] bg-[var(--panel-bg)]">
              <PriceChart slabAddress={slab} />
            </div>
          </ErrorBoundary>
          <ErrorBoundary label="TradeForm">
            <TradeForm slabAddress={slab} />
          </ErrorBoundary>
          <ErrorBoundary label="PositionPanel">
            <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)]">
              <PositionPanel slabAddress={slab} />
            </div>
          </ErrorBoundary>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          <ErrorBoundary label="AccountsCard">
            <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)]">
              <AccountsCard />
            </div>
          </ErrorBoundary>
          <ErrorBoundary label="DepositWithdrawCard">
            <DepositWithdrawCard slabAddress={slab} />
          </ErrorBoundary>
          <ErrorBoundary label="EngineHealthCard">
            <Collapsible title="engine health" defaultOpen={false} badge={health && <HealthBadge level={health.level} />}>
              <EngineHealthCard />
            </Collapsible>
          </ErrorBoundary>
          <ErrorBoundary label="MarketStatsCard">
            <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)]">
              <MarketStatsCard />
            </div>
          </ErrorBoundary>
          <ErrorBoundary label="TradeHistory">
            <Collapsible title="recent trades" defaultOpen={true}>
              <TradeHistory slabAddress={slab} />
            </Collapsible>
          </ErrorBoundary>
        </div>
      </div>

      {/* Full-width */}
      <div className="mt-4">
        <ErrorBoundary label="MarketBookCard">
          <Collapsible title="market book" defaultOpen={false}>
            <MarketBookCard />
          </Collapsible>
        </ErrorBoundary>
      </div>
    </div>
  );
}

export default function TradePage({ params }: { params: Promise<{ slab: string }> }) {
  const { slab } = use(params);

  return (
    <SlabProvider slabAddress={slab}>
      <TradePageInner slab={slab} />
    </SlabProvider>
  );
}
