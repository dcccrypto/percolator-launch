"use client";

import { use } from "react";
import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { TradeForm } from "@/components/trading/TradeForm";
import { PositionPanel } from "@/components/trading/PositionPanel";
import { MarketStats } from "@/components/market/MarketStats";
import { FundingRate } from "@/components/market/FundingRate";
import { InsuranceFund } from "@/components/market/InsuranceFund";
import { AccountInfo } from "@/components/trading/AccountInfo";
import { DepositWithdraw } from "@/components/trading/DepositWithdraw";
import { HealthBadge } from "@/components/market/HealthBadge";
import { computeMarketHealth } from "@/lib/health";
import { useLivePrice } from "@/hooks/useLivePrice";

function TradePageInner({ slab }: { slab: string }) {
  const { engine } = useSlabState();
  const { priceUsd } = useLivePrice();
  const health = engine ? computeMarketHealth(engine) : null;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Trade</h1>
          <p className="font-mono text-xs text-slate-500">{slab}</p>
        </div>
        {health && <HealthBadge level={health.level} />}
        {priceUsd != null && (
          <div className="ml-auto text-right">
            <div className="text-xs text-slate-500">Jupiter Price</div>
            <div className="font-mono text-lg text-white">
              ${priceUsd < 0.01 ? priceUsd.toFixed(6) : priceUsd < 1 ? priceUsd.toFixed(4) : priceUsd.toFixed(2)}
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left: Trade + Account */}
        <div className="space-y-6">
          <TradeForm slabAddress={slab} />
          <DepositWithdraw slabAddress={slab} />
        </div>

        {/* Middle: Position + Account Info */}
        <div className="space-y-6">
          <PositionPanel />
          <AccountInfo slabAddress={slab} />
          <MarketStats />
        </div>

        {/* Right: Market data */}
        <div className="space-y-6">
          <InsuranceFund />
          <FundingRate />
        </div>
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
