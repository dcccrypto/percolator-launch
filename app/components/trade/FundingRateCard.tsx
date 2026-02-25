"use client";

import { FC, useState, useEffect, useMemo } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useEngineState } from "@/hooks/useEngineState";
import { useUserAccount } from "@/hooks/useUserAccount";
import { InfoIcon } from "@/components/ui/Tooltip";
import { FundingExplainerModal } from "./FundingExplainerModal";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";
import { useTokenMeta } from "@/hooks/useTokenMeta";

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
  if (!Number.isFinite(slots) || slots <= 0) return "—";
  // Solana slots ~400ms each → roughly 2.5 slots per second
  const seconds = Math.floor(slots * 0.4);
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

export const FundingRateCard: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const { params, config } = useSlabState();
  const { engine, fundingRate } = useEngineState();
  const userAccount = useUserAccount();
  const tokenMeta = useTokenMeta(config?.collateralMint ?? null);
  const collateralDecimals = tokenMeta?.decimals ?? 6;
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  
  const [fundingData, setFundingData] = useState<FundingData | null>(mockMode ? MOCK_FUNDING : null);
  const [loading, setLoading] = useState(!mockMode);
  const [error, setError] = useState<string | null>(null);
  const [showExplainer, setShowExplainer] = useState(false);
  const [countdown, setCountdown] = useState(0);

  // Fetch funding data from API, fall back to on-chain data
  useEffect(() => {
    if (mockMode) return;
    
    const fetchFunding = async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/funding/${slabAddress}`);
        if (!res.ok) throw new Error("API unavailable");
        const data = await res.json();
        setFundingData({
          ...data,
          netLpPosition: BigInt(data.netLpPosition ?? 0),
        });
        setError(null);
      } catch {
        // Silently fall back to on-chain data — no error shown to user
        if (engine && fundingRate !== null) {
          const rate = Number(fundingRate);
          const hourly = (rate * 9000) / 10000;
          const apr = hourly * 24 * 365;
          const netLp = engine?.netLpPos ?? 0n;
          setFundingData({
            currentRateBpsPerSlot: rate,
            hourlyRatePercent: hourly,
            aprPercent: apr,
            direction: rate > 0 ? "long_pays_short" : rate < 0 ? "short_pays_long" : "neutral",
            nextFundingSlot: 0,
            netLpPosition: netLp,
            currentSlot: 0,
          });
          setError(null); // Clear error — on-chain data is valid
        }
      } finally {
        setLoading(false);
      }
    };

    fetchFunding();
    const interval = setInterval(fetchFunding, 30000);
    return () => clearInterval(interval);
  }, [slabAddress, mockMode, engine, fundingRate]);

  // Update countdown every second
  useEffect(() => {
    if (!fundingData) return;
    
    const { nextFundingSlot, currentSlot } = fundingData;
    // Skip countdown when slot data is missing/invalid (e.g. on-chain fallback sets both to 0)
    if (!nextFundingSlot || !currentSlot || !Number.isFinite(nextFundingSlot) || !Number.isFinite(currentSlot)) {
      setCountdown(0);
      return;
    }

    const initialRemaining = nextFundingSlot - currentSlot;
    setCountdown(Math.max(0, initialRemaining));
    
    // Decrement by ~2.5 slots per second (Solana's ~400ms slot time)
    const interval = setInterval(() => {
      setCountdown((prev) => Math.max(0, prev - 2.5));
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
    const positionTokens = Number(absPosition) / (10 ** collateralDecimals);
    const estimated24h = (fundingData.hourlyRatePercent / 100) * 24 * positionTokens;

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

  const hourlyRatePercent = fundingData.hourlyRatePercent ?? 0;
  const rateDisplay = hourlyRatePercent >= 0 
    ? `+${hourlyRatePercent.toFixed(4)}%` 
    : `${hourlyRatePercent.toFixed(4)}%`;

  const directionText = 
    fundingData.direction === "long_pays_short" ? "Longs pay shorts" :
    fundingData.direction === "short_pays_long" ? "Shorts pay longs" :
    "Balanced";

  return (
    <>
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-2">
        {/* Header row: label + rate + APR */}
        <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
              Funding Rate
            </span>
            <InfoIcon tooltip="Funding rates balance long/short positions. Percolator uses inventory-based funding to protect LPs." />
            <button
              onClick={() => setShowExplainer(true)}
              className="text-[8px] text-[var(--accent)] hover:underline"
            >
              more
            </button>
          </div>
          <div className="flex items-baseline gap-1.5">
            <span
              className={`text-sm font-bold ${hourlyRatePercent >= 0 ? "text-[var(--short)]" : "text-[var(--long)]"}`}
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {rateDisplay}
            </span>
            <span className="text-[9px] text-[var(--text-dim)]">/hr</span>
          </div>
        </div>

        {/* APR + Direction — compact row */}
        <div className="mb-1 flex items-center justify-between">
          <div className="rounded-none border-l-2 border-l-[var(--border)] bg-[var(--bg-elevated)] px-1.5 py-0.5">
            <span className="text-[10px] text-[var(--text-secondary)]">{directionText}</span>
            {countdown > 0 && (
              <span className="ml-1.5 text-[9px] text-[var(--text-dim)]">· next {formatCountdown(countdown)}</span>
            )}
          </div>
          <span className="text-[10px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
            {(fundingData.aprPercent ?? 0) >= 0 ? "+" : ""}{(fundingData.aprPercent ?? 0).toFixed(1)}% APR
          </span>
        </div>

        {/* Position-Specific Estimate */}
        {positionDirection && estimatedFunding24h !== null && (
          <div className="rounded-none border border-[var(--border)]/30 bg-[var(--bg)] px-1.5 py-1">
            <div className="flex items-center justify-between">
              <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-dim)]">
                Est. 24h ({positionDirection})
              </span>
              <span className={`text-[11px] font-bold ${fundingColor}`} style={{ fontFamily: "var(--font-mono)" }}>
                {fundingSign}{estimatedFunding24h.toFixed(4)} tokens
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Explainer Modal */}
      {showExplainer && <FundingExplainerModal onClose={() => setShowExplainer(false)} />}
    </>
  );
};
