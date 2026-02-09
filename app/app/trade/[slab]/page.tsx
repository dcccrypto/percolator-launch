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
import { HealthBadge } from "@/components/market/HealthBadge";
import { ShareButton } from "@/components/market/ShareCard";
import { GlassCard } from "@/components/ui/GlassCard";
import { computeMarketHealth } from "@/lib/health";
import { useLivePrice } from "@/hooks/useLivePrice";

function Collapsible({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <GlassCard padding="none" hover={false}>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-5 py-4 text-left text-sm font-medium text-[#8B95B0] transition-colors hover:text-[#F0F4FF] md:hidden"
      >
        {title}
        <span className={`text-xs text-[#3D4563] transition-transform duration-200 ${open ? "rotate-180" : ""}`}>▼</span>
      </button>
      <div className={`${open ? "block" : "hidden"} md:block`}>{children}</div>
    </GlassCard>
  );
}

function TradePageInner({ slab }: { slab: string }) {
  const { engine } = useSlabState();
  const { priceUsd } = useLivePrice();
  const health = engine ? computeMarketHealth(engine) : null;
  const containerRef = useRef<HTMLDivElement>(null);

  // Page entrance animation
  useEffect(() => {
    if (!containerRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const panels = containerRef.current.querySelectorAll(".trade-panel");
    gsap.fromTo(
      panels,
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.5, stagger: 0.08, ease: "power3.out", delay: 0.1 }
    );
  }, []);

  return (
    <div ref={containerRef} className="mx-auto max-w-7xl px-3 py-4 sm:px-4 sm:py-8">
      {/* Header */}
      <div className="trade-panel mb-4 flex flex-wrap items-center gap-3 sm:mb-6 sm:gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-white sm:text-2xl" style={{ fontFamily: "var(--font-space-grotesk)" }}>Trade</h1>
          <p className="truncate font-[var(--font-jetbrains-mono)] text-[10px] text-[#3D4563] sm:text-xs">{slab}</p>
        </div>
        {health && <HealthBadge level={health.level} />}
        <div className="ml-auto flex items-center gap-3">
          <ShareButton
            slabAddress={slab}
            marketName="TOKEN"
            price={BigInt(Math.round((priceUsd ?? 0) * 1e6))}
          />
          {priceUsd != null && (
            <div className="text-right">
              <div className="text-[10px] text-[#3D4563] sm:text-xs">Jupiter Price</div>
              <div className="font-[var(--font-jetbrains-mono)] text-base font-bold text-white sm:text-lg">
                ${priceUsd < 0.01 ? priceUsd.toFixed(6) : priceUsd < 1 ? priceUsd.toFixed(4) : priceUsd.toFixed(2)}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Main grid */}
      <div className="grid gap-4 sm:gap-5 lg:grid-cols-3">
        {/* Left column */}
        <div className="space-y-4 sm:space-y-5 lg:col-span-2">
          <GlassCard padding="none" hover={false} className="trade-panel overflow-hidden">
            <PriceChart slabAddress={slab} />
          </GlassCard>
          <GlassCard padding="none" hover={false} className="trade-panel">
            <TradeForm slabAddress={slab} />
          </GlassCard>
          <div className="trade-panel">
            <GlassCard padding="none" hover={false}>
              <PositionPanel slabAddress={slab} />
            </GlassCard>
          </div>
        </div>

        {/* Right column */}
        <div className="space-y-4 sm:space-y-5">
          <div className="trade-panel">
            <GlassCard padding="none" hover={false}>
              <AccountsCard />
            </GlassCard>
          </div>
          <div className="trade-panel">
            <GlassCard padding="none" hover={false}>
              <DepositWithdrawCard slabAddress={slab} />
            </GlassCard>
          </div>
          <div className="trade-panel">
            <Collapsible title="Engine Health" defaultOpen={false}>
              <EngineHealthCard />
            </Collapsible>
          </div>
          <div className="trade-panel">
            <GlassCard padding="none" hover={false}>
              <MarketStatsCard />
            </GlassCard>
          </div>
        </div>
      </div>

      {/* Full-width */}
      <div className="trade-panel mt-4 sm:mt-5">
        <Collapsible title="Market Book" defaultOpen={false}>
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
