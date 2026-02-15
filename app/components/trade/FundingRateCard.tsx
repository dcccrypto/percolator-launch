"use client";

import { FC, useState, useEffect, useMemo } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useEngineState } from "@/hooks/useEngineState";
import { useUserAccount } from "@/hooks/useUserAccount";
import { InfoIcon } from "@/components/ui/Tooltip";
import { FundingExplainerModal } from "./FundingExplainerModal";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";

interface FundingData {
  currentRateBpsPerSlot: number;
  hourlyRatePercent: number;
  aprPercent: number;
  direction: "long_pays_short" | "short_pays_long" | "neutral";
  nextFundingSlot: number;
  netLpPosition: bigint;
  currentSlot: number;
}

// Mock data for development
const MOCK_FUNDING: FundingData = {
  currentRateBpsPerSlot: 5,
  hourlyRatePercent: 0.0042,
  aprPercent: 36.79,
  direction: "long_pays_short",
  nextFundingSlot: 123456789,
  netLpPosition: 1500000n,
  currentSlot: 123456289,
};

function formatCountdown(slots: number): string {
  // Solana slots ~400ms each → roughly 2.5 slots per second
  const seconds = Math.floor((slots * 0.4));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

export const FundingRateCard: FC<{ slabAddress: string; simulation?: boolean }> = ({ slabAddress, simulation }) => {
  const { params } = useSlabState();
  const { engine, fundingRate } = useEngineState();
  const userAccount = useUserAccount();
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  
  const [fundingData, setFundingData] = useState<FundingData | null>(mockMode ? MOCK_FUNDING : null);
  const [loading, setLoading] = useState(!mockMode && !simulation);
  const [error, setError] = useState<string | null>(null);
  const [showExplainer, setShowExplainer] = useState(false);
  const [countdown, setCountdown] = useState(0);

  // In simulation mode, derive funding data from on-chain state
  useEffect(() => {
    if (!simulation || !engine) return;
    const rate = Number(fundingRate ?? 0n);
    const hourly = (rate * 9000) / 100;
    const apr = hourly * 24 * 365;
    const netLp = engine.netLpPos ?? 0n;
    setFundingData({
      currentRateBpsPerSlot: rate,
      hourlyRatePercent: hourly,
      aprPercent: apr,
      direction: rate > 0 ? "long_pays_short" : rate < 0 ? "short_pays_long" : "neutral",
      nextFundingSlot: 0,
      netLpPosition: netLp,
      currentSlot: 0,
    });
    setLoading(false);
  }, [simulation, engine, fundingRate]);

  // Fetch funding data from API (non-simulation)
  useEffect(() => {
    if (mockMode || simulation) return;
    
    const fetchFunding = async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/funding/${slabAddress}`);
        if (!res.ok) throw new Error("Failed to fetch funding data");
        const data = await res.json();
        setFundingData({
          ...data,
          netLpPosition: BigInt(data.netLpPosition ?? 0),
        });
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
        // Fallback to on-chain data when API unavailable
        if (engine && fundingRate !== null) {
          const rate = Number(fundingRate);
          const hourly = (rate * 9000) / 100;
          const apr = hourly * 24 * 365;
          const netLp = engine.netLpPos ?? 0n;
          setFundingData({
            currentRateBpsPerSlot: rate,
            hourlyRatePercent: hourly,
            aprPercent: apr,
            direction: rate > 0 ? "long_pays_short" : rate < 0 ? "short_pays_long" : "neutral",
            nextFundingSlot: 0,
            netLpPosition: netLp,
            currentSlot: 0,
          });
        }
      } finally {
        setLoading(false);
      }
    };

    fetchFunding();
    const interval = setInterval(fetchFunding, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [slabAddress, mockMode, simulation, engine, fundingRate]);

  // Update countdown every second
  useEffect(() => {
    if (!fundingData) return;
    
    const interval = setInterval(() => {
      const remaining = fundingData.nextFundingSlot - fundingData.currentSlot;
      setCountdown(Math.max(0, remaining));
    }, 1000);
    
    return () => clearInterval(interval);
  }, [fundingData]);

  const { positionDirection, fundingColor, fundingSign, estimatedFunding24h } = useMemo(() => {
    if (!userAccount || !fundingData) {
      return {
        positionDirection: null,
        fundingColor: "text-[var(--text-muted)]",
        fundingSign: "",
        estimatedFunding24h: null,
      };
    }

    const { account } = userAccount;
    const hasPosition = account.positionSize !== 0n;
    const isLong = account.positionSize > 0n;
    const absPosition = account.positionSize < 0n ? -account.positionSize : account.positionSize;
    
    if (!hasPosition) {
      return {
        positionDirection: null,
        fundingColor: "text-[var(--text-muted)]",
        fundingSign: "",
        estimatedFunding24h: null,
      };
    }

    // Determine if user pays or receives
    let userPays = false;
    if (fundingData.direction === "long_pays_short") {
      userPays = isLong;
    } else if (fundingData.direction === "short_pays_long") {
      userPays = !isLong;
    }

    // Calculate estimated 24h funding
    // hourlyRate * 24 * positionSize (in tokens)
    const positionTokens = Number(absPosition) / 1e6;
    const estimated24h = fundingData.hourlyRatePercent * 24 * positionTokens;

    return {
      positionDirection: isLong ? "LONG" : "SHORT",
      fundingColor: userPays ? "text-[var(--short)]" : "text-[var(--long)]",
      fundingSign: userPays ? "-" : "+",
      estimatedFunding24h: Math.abs(estimated24h),
    };
  }, [userAccount, fundingData]);

  if (loading && !fundingData) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Funding Rate</span>
          <div className="h-4 w-16 animate-pulse rounded-none bg-[var(--border)]" />
        </div>
      </div>
    );
  }

  if (!fundingData) return null;

  const rateDisplay = fundingData.hourlyRatePercent >= 0 
    ? `+${fundingData.hourlyRatePercent.toFixed(4)}%` 
    : `${fundingData.hourlyRatePercent.toFixed(4)}%`;

  const directionText = 
    fundingData.direction === "long_pays_short" ? "Longs pay shorts" :
    fundingData.direction === "short_pays_long" ? "Shorts pay longs" :
    "Balanced";

  return (
    <>
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        {/* Header */}
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
              Funding Rate
            </span>
            <InfoIcon tooltip="Funding rates balance long/short positions. Percolator uses inventory-based funding to protect LPs." />
            <button
              onClick={() => setShowExplainer(true)}
              className="ml-1 text-[9px] text-[var(--accent)] hover:underline"
            >
              Learn more
            </button>
          </div>
        </div>

        {/* Current Rate */}
        <div className="mb-3 flex items-baseline justify-between">
          <div>
            <div
              className={`text-2xl font-bold ${
                fundingData.hourlyRatePercent >= 0 ? "text-[var(--short)]" : "text-[var(--long)]"
              }`}
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {rateDisplay}
            </div>
            <div className="text-[10px] text-[var(--text-dim)]">per hour</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
              {fundingData.aprPercent >= 0 ? "+" : ""}
              {fundingData.aprPercent.toFixed(2)}% APR
            </div>
          </div>
        </div>

        {/* Direction Indicator */}
        <div className="mb-3 rounded-none border-l-2 border-l-[var(--border)] bg-[var(--bg-elevated)] p-2">
          <div className="text-[11px] text-[var(--text-secondary)]">{directionText}</div>
          <div className="mt-0.5 text-[10px] text-[var(--text-dim)]">
            Next funding: {formatCountdown(countdown)}
          </div>
        </div>

        {/* Position-Specific Estimate */}
        {positionDirection && estimatedFunding24h !== null && (
          <div className="rounded-none border border-[var(--border)]/30 bg-[var(--bg)] p-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
                Your Est. Funding (24h)
              </span>
              <span className={`text-sm font-bold ${fundingColor}`} style={{ fontFamily: "var(--font-mono)" }}>
                {fundingSign}${estimatedFunding24h.toFixed(2)}
              </span>
            </div>
            <div className="mt-1 text-[9px] text-[var(--text-dim)]">
              Based on your {positionDirection} position
            </div>
          </div>
        )}

        {error && !mockMode && (
          <div className="mt-2 text-[9px] text-[var(--warning)]">
            {error} (using on-chain data)
          </div>
        )}
      </div>

      {/* Explainer Modal */}
      {showExplainer && <FundingExplainerModal onClose={() => setShowExplainer(false)} />}
    </>
  );
};
