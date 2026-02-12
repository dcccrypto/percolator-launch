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
import { useToast } from "@/hooks/useToast";

function Collapsible({ title, defaultOpen = true, badge, children }: { title: string; defaultOpen?: boolean; badge?: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)]">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
      >
        <span className="flex items-center gap-2">
          {title}
          {badge}
        </span>
        <span className={`text-[10px] text-[var(--text-dim)] transition-transform duration-200 ${open ? "rotate-180" : ""}`}>v</span>
      </button>
      <div className={open ? "block" : "hidden"}>{children}</div>
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

function TradePageInner({ slab }: { slab: string }) {
  const { engine, config } = useSlabState();
  const tokenMeta = useTokenMeta(config?.collateralMint ?? null);
  const { priceUsd } = useLivePrice();
  const health = engine ? computeMarketHealth(engine) : null;
  const pageRef = useRef<HTMLDivElement>(null);

  const symbol = tokenMeta?.symbol ?? (config?.collateralMint ? `${config.collateralMint.toBase58().slice(0, 4)}…${config.collateralMint.toBase58().slice(-4)}` : "TOKEN");
  const shortAddress = `${slab.slice(0, 4)}…${slab.slice(-4)}`;

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
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-widest text-[var(--accent)]">// TRADE</p>
          <h1 className="text-2xl font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>
            {symbol}/USD <span className="text-base font-normal text-[var(--text-muted)]">PERP</span>
          </h1>
          <div className="mt-1.5 flex items-center gap-3">
            <span className="flex items-center text-[11px] text-[var(--text-dim)]">
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
        {priceUsd != null && (
          <div className="text-right">
            <div className="text-3xl font-bold text-[var(--text)]">
              ${priceUsd < 0.01 ? priceUsd.toFixed(6) : priceUsd < 1 ? priceUsd.toFixed(4) : priceUsd.toFixed(2)}
            </div>
          </div>
        )}
      </div>

      {/* Quick start guide */}
      <div className="mb-4 rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-2.5 flex items-center gap-4 text-xs text-[var(--text-secondary)]">
        <span className="text-[var(--text-dim)]">quick start:</span>
        <span><span className="text-[var(--long)]">1</span> connect wallet</span>
        <span className="text-[var(--text-dim)]">&rarr;</span>
        <span><span className="text-[var(--long)]">2</span> create account</span>
        <span className="text-[var(--text-dim)]">&rarr;</span>
        <span><span className="text-[var(--long)]">3</span> deposit collateral</span>
        <span className="text-[var(--text-dim)]">&rarr;</span>
        <span><span className="text-[var(--long)]">4</span> trade</span>
      </div>

      {/* Main grid */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Left column */}
        <div className="space-y-4 lg:col-span-2">
          <ErrorBoundary label="PriceChart">
            <PriceChart slabAddress={slab} />
          </ErrorBoundary>
          <ErrorBoundary label="TradeForm">
            <TradeForm slabAddress={slab} />
          </ErrorBoundary>
          <ErrorBoundary label="PositionPanel">
            <PositionPanel slabAddress={slab} />
          </ErrorBoundary>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          <ErrorBoundary label="DepositWithdrawCard">
            <DepositWithdrawCard slabAddress={slab} />
          </ErrorBoundary>
          <ErrorBoundary label="AccountsCard">
            <AccountsCard />
          </ErrorBoundary>
          <ErrorBoundary label="EngineHealthCard">
            <Collapsible title="engine health" defaultOpen={false} badge={health && <HealthBadge level={health.level} />}>
              <EngineHealthCard />
            </Collapsible>
          </ErrorBoundary>
          <ErrorBoundary label="MarketStatsCard">
            <MarketStatsCard />
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
