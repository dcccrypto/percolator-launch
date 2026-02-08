"use client";

import { use, useState } from "react";
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
import { computeMarketHealth } from "@/lib/health";
import { useLivePrice } from "@/hooks/useLivePrice";

function Collapsible({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-zinc-800 bg-[#0d1117]">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-slate-300 md:hidden"
      >
        {title}
        <span className="text-xs text-slate-500">{open ? "▲" : "▼"}</span>
      </button>
      <div className={`${open ? "block" : "hidden"} md:block`}>{children}</div>
    </div>
  );
}

function TradePageInner({ slab }: { slab: string }) {
  const { engine } = useSlabState();
  const { priceUsd } = useLivePrice();
  const health = engine ? computeMarketHealth(engine) : null;

  return (
    <div className="mx-auto max-w-7xl px-3 py-4 sm:px-4 sm:py-8">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center gap-3 sm:mb-6 sm:gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-white sm:text-2xl">Trade</h1>
          <p className="truncate font-mono text-[10px] text-slate-500 sm:text-xs">{slab}</p>
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
              <div className="text-[10px] text-slate-500 sm:text-xs">Jupiter Price</div>
              <div className="font-mono text-base text-white sm:text-lg">
                ${priceUsd < 0.01 ? priceUsd.toFixed(6) : priceUsd < 1 ? priceUsd.toFixed(4) : priceUsd.toFixed(2)}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Main grid */}
      <div className="grid gap-4 sm:gap-6 lg:grid-cols-3">
        {/* Left column — 2/3 */}
        <div className="space-y-4 sm:space-y-6 lg:col-span-2">
          <PriceChart slabAddress={slab} />
          <TradeForm slabAddress={slab} />
          <PositionPanel slabAddress={slab} />
        </div>

        {/* Right column — 1/3 */}
        <div className="space-y-4 sm:space-y-6">
          <AccountsCard />
          <DepositWithdrawCard slabAddress={slab} />
          <Collapsible title="Engine Health" defaultOpen={false}>
            <EngineHealthCard />
          </Collapsible>
          <MarketStatsCard />
        </div>
      </div>

      {/* Full-width below */}
      <div className="mt-4 sm:mt-6">
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
