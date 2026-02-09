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
import { computeMarketHealth } from "@/lib/health";
import { useLivePrice } from "@/hooks/useLivePrice";

function Collapsible({ title, defaultOpen = true, badge, children }: { title: string; defaultOpen?: boolean; badge?: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-[4px] border border-[#1a1a1f] bg-[#111113]">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-5 py-4 text-left text-sm font-medium text-[#71717a] transition-colors hover:text-[#fafafa]"
      >
        <span className="flex items-center gap-2">
          {title}
          {badge}
        </span>
        <span className={`text-xs text-[#3f3f46] transition-transform duration-200 ${open ? "rotate-180" : ""}`}>v</span>
      </button>
      <div className={open ? "block" : "hidden"}>{children}</div>
    </div>
  );
}

function TradePageInner({ slab }: { slab: string }) {
  const { engine } = useSlabState();
  const { priceUsd } = useLivePrice();
  const health = engine ? computeMarketHealth(engine) : null;
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pageRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    gsap.fromTo(pageRef.current, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power2.out" });
  }, []);

  return (
    <div ref={pageRef} className="mx-auto max-w-7xl px-4 py-6 opacity-0">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>trade</h1>
          <p className="truncate text-[11px] text-[#3f3f46]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>{slab}</p>
        </div>
        <div className="ml-auto flex items-center gap-4">
          {health && <HealthBadge level={health.level} />}
          <ShareButton
            slabAddress={slab}
            marketName="TOKEN"
            price={BigInt(Math.round((priceUsd ?? 0) * 1e6))}
          />
          {priceUsd != null && (
            <div className="text-right">
              <div className="text-3xl font-bold text-white" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                ${priceUsd < 0.01 ? priceUsd.toFixed(6) : priceUsd < 1 ? priceUsd.toFixed(4) : priceUsd.toFixed(2)}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Quick start guide */}
      <div className="mb-4 rounded-[4px] border border-[#1a1a1f] bg-[#111113] px-4 py-2.5 flex items-center gap-6 text-xs text-[#71717a]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
        <span className="text-[#3f3f46]">quick start:</span>
        <span><span className="text-[#00FFB2]">1</span> connect wallet</span>
        <span className="text-[#1a1a1f]">→</span>
        <span><span className="text-[#00FFB2]">2</span> deposit collateral</span>
        <span className="text-[#1a1a1f]">→</span>
        <span><span className="text-[#00FFB2]">3</span> trade</span>
      </div>

      {/* Main grid */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Left column */}
        <div className="space-y-4 lg:col-span-2">
          <div className="overflow-hidden rounded-[4px] border border-[#1a1a1f] bg-[#111113]">
            <PriceChart slabAddress={slab} />
          </div>
          <div className="rounded-[4px] border border-[#1a1a1f] bg-[#111113]">
            <TradeForm slabAddress={slab} />
          </div>
          <div className="rounded-[4px] border border-[#1a1a1f] bg-[#111113]">
            <PositionPanel slabAddress={slab} />
          </div>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          <div className="rounded-[4px] border border-[#1a1a1f] bg-[#111113]">
            <AccountsCard />
          </div>
          <div className="rounded-[4px] border border-[#1a1a1f] bg-[#111113]">
            <DepositWithdrawCard slabAddress={slab} />
          </div>
          <Collapsible title="engine health" defaultOpen={false} badge={health && <HealthBadge level={health.level} />}>
            <EngineHealthCard />
          </Collapsible>
          <div className="rounded-[4px] border border-[#1a1a1f] bg-[#111113]">
            <MarketStatsCard />
          </div>
          <Collapsible title="recent trades" defaultOpen={true}>
            <TradeHistory slabAddress={slab} />
          </Collapsible>
        </div>
      </div>

      {/* Full-width */}
      <div className="mt-4">
        <Collapsible title="market book" defaultOpen={false}>
          <MarketBookCard />
        </Collapsible>
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
