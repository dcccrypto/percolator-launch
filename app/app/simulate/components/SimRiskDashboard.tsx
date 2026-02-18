"use client";

import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { EngineHealthCard } from "@/components/trade/EngineHealthCard";
import { FundingRateCard } from "@/components/trade/FundingRateCard";
import { InsuranceLPPanel } from "@/components/trade/InsuranceLPPanel";
import { LiquidationAnalytics } from "@/components/trade/LiquidationAnalytics";
import { CrankHealthCard } from "@/components/trade/CrankHealthCard";
import { SystemCapitalCard } from "@/components/trade/SystemCapitalCard";

interface Props {
  slabAddress: string;
}

export function SimRiskDashboard({ slabAddress }: Props) {
  return (
    <div className="space-y-1.5">
      {/* Section header */}
      <div className="px-1">
        <div className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--accent)]/60">
          // RISK DASHBOARD
        </div>
      </div>

      {/* Engine Health */}
      <ErrorBoundary label="EngineHealthCard">
        <div>
          <div className="px-1 pb-1">
            <span className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Engine Health</span>
          </div>
          <EngineHealthCard />
        </div>
      </ErrorBoundary>

      {/* Funding Rate */}
      <ErrorBoundary label="FundingRateCard">
        <div>
          <div className="px-1 pb-1">
            <span className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Funding Rate</span>
          </div>
          <FundingRateCard slabAddress={slabAddress} />
        </div>
      </ErrorBoundary>

      {/* Two-column grid for smaller cards */}
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <ErrorBoundary label="CrankHealthCard">
          <div>
            <div className="px-1 pb-1">
              <span className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Crank Health</span>
            </div>
            <CrankHealthCard />
          </div>
        </ErrorBoundary>

        <ErrorBoundary label="SystemCapitalCard">
          <div>
            <div className="px-1 pb-1">
              <span className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">System Capital</span>
            </div>
            <SystemCapitalCard />
          </div>
        </ErrorBoundary>
      </div>

      {/* Liquidation Analytics */}
      <ErrorBoundary label="LiquidationAnalytics">
        <div>
          <div className="px-1 pb-1">
            <span className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Liquidation Analytics</span>
          </div>
          <LiquidationAnalytics />
        </div>
      </ErrorBoundary>

      {/* Insurance LP */}
      <ErrorBoundary label="InsuranceLPPanel">
        <div>
          <div className="px-1 pb-1">
            <span className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Insurance Fund</span>
          </div>
          <InsuranceLPPanel />
        </div>
      </ErrorBoundary>
    </div>
  );
}
