"use client";

import { lotExpOf, qToTokenQ } from "@/lib/v22/lot";
import { FC, useState, useEffect, useMemo } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import { computePositionPnl } from "@/lib/position-pnl";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

import { useEngineState } from "@/hooks/useEngineState";
import { useUserAccount } from "@/hooks/useUserAccount";
import { InfoIcon } from "@/components/ui/Tooltip";
import { FundingExplainerModal } from "./FundingExplainerModal";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";
import { sanitizeFundingRateBps } from "@/lib/health";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { readV17MaxAbsFunding } from "@/lib/v17-engine-config";
import { pollWhenVisible } from "@/lib/pollWhenVisible";

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
  const { params, config, raw, adlFactors, wrapperConfigV17 } = useSlabState();
  const { engine, fundingRate, isV17 } = useEngineState();
  const userAccount = useUserAccount();
  const tokenMeta = useTokenMeta(config?.collateralMint ?? null);
  const collateralDecimals = tokenMeta?.decimals ?? 6;
  const mockMode = isMockMode() && isMockSlab(slabAddress);

  // M19: funding is OFF at the protocol level for this market when
  // max_abs_funding_e9_per_slot is 0 — gate the whole funding surface on it
  // rather than fetching/rendering a rate that can never actually apply.
  const v17MaxAbsFunding = isV17 && raw ? readV17MaxAbsFunding(raw) : null;
  const fundingDisabled = isV17 && v17MaxAbsFunding === 0n;

  const [fundingData, setFundingData] = useState<FundingData | null>(mockMode ? MOCK_FUNDING : null);
  const [loading, setLoading] = useState(!mockMode);
  const [error, setError] = useState<string | null>(null);
  const [showExplainer, setShowExplainer] = useState(false);
  const [countdown, setCountdown] = useState(0);

  // Fetch funding data from API, fall back to on-chain data.
  // GH#1832: AbortController prevents stale responses from a previous market
  // overwriting the current market's data on fast market switches.
  useEffect(() => {
    if (mockMode) return;
    if (fundingDisabled) {
      // Funding can never apply on this market — don't fetch/poll a rate
      // that's structurally clamped to 0, and don't leave loading spinning.
      setLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const { signal } = controller;

    const fetchFunding = async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/funding/${slabAddress}`, { signal });
        if (!res.ok) throw new Error("API unavailable");
        const data = await res.json();
        if (cancelled) return;
        // GH#funding-display: percolator-api GET /funding/:slab returns
        // { currentRateBpsPerSlot, hourlyRatePercent, annualizedPercent, netLpPosition, ... }
        // — it does NOT return `direction`, `aprPercent`, `nextFundingSlot`, or
        // `currentSlot`. Spreading the raw response left those fields undefined,
        // so userPays was always false (every position showed "receiving") and
        // APR was stuck at "+0.0%". Map the real fields onto FundingData's
        // normalized shape, deriving `direction` from the rate's sign the same
        // way the on-chain fallback below does (rate > 0 → longs pay shorts,
        // per the API's own metadata.explanation.sign convention).
        const rate = Number(data.currentRateBpsPerSlot ?? 0);
        setFundingData({
          currentRateBpsPerSlot: rate,
          hourlyRatePercent: Number(data.hourlyRatePercent ?? 0),
          aprPercent: Number(data.annualizedPercent ?? 0),
          direction: rate > 0 ? "long_pays_short" : rate < 0 ? "short_pays_long" : "neutral",
          nextFundingSlot: 0,
          netLpPosition: BigInt(data.netLpPosition ?? 0),
          currentSlot: 0,
        });
        if (!cancelled) setError(null);
      } catch (err) {
        // Ignore AbortError — this is expected when switching markets
        if (err instanceof DOMException && err.name === "AbortError") return;
        // Silently fall back to on-chain data — no error shown to user
        if (!cancelled && engine && sanitizeFundingRateBps(fundingRate) !== null) {
          const rate = Number(sanitizeFundingRateBps(fundingRate)!);
          // /100 converts bps → percent (GH#1943: was /10000)
          const hourly = (rate * 9000) / 100;
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
        if (!cancelled) setLoading(false);
      }
    };

    fetchFunding();
    // Visibility-gated so hidden tabs don't keep polling funding data.
    const dispose = pollWhenVisible(fetchFunding, 30000);
    return () => {
      cancelled = true;
      controller.abort();
      dispose();
    };
  }, [slabAddress, mockMode, engine, fundingRate, fundingDisabled]);

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
    // Funding accrues through the same per-side `f` accumulator that `k` does,
    // scaled by the side's live ADL factor (v16.rs:9564-9576), so a deleveraged
    // leg pays/receives funding on its REDUCED exposure, not its nominal basis.
    // Same effective-size rule as every PnL surface (lib/position-pnl.ts mirrors the
    // engine's effective_abs_quantity_for_leg). When the ADL state is unknown there is
    // NO raw-size fallback: the line is skipped rather than showing raw-size funding.
    const effSize = computePositionPnl({
      basisQ: account.positionSize,
      aBasis: account.adlABasis ?? 0n,
      epochSnap: account.adlEpochSnap,
      adlFactors,
      adlApplicable: wrapperConfigV17 !== null,
      markE6: 0n,
      onChainPnl: 0n,
      initialMarginBps: 1000n,
      capital: account.capital,
    }).effectiveSize;
    if (hasPosition && effSize === null) {
      return {
        positionDirection: null,
        fundingColor: "text-[var(--text-muted)]",
        fundingSign: "",
        estimatedFunding24h: null,
      };
    }
    const absPosition = effSize === null ? 0n : effSize < 0n ? -effSize : effSize;
    
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
    // v2.2: the position is in LOTS; the estimate is in tokens (lib/v22/lot.ts). lotExp 0 = identical to before.
    const positionTokens = Number(qToTokenQ(absPosition, lotExpOf(raw))) / (10 ** collateralDecimals);
    const estimated24h = (fundingData.hourlyRatePercent / 100) * 24 * positionTokens;

    return {
      positionDirection: isLong ? "LONG" : "SHORT",
      fundingColor: userPays ? "text-[var(--short)]" : "text-[var(--long)]",
      fundingSign: userPays ? "-" : "+",
      estimatedFunding24h: Math.abs(estimated24h),
    };
  }, [userAccount, fundingData, adlFactors, wrapperConfigV17, raw]);

  if (loading && !fundingData) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">Funding Rate</span>
          <ShimmerSkeleton className="h-4 w-16" rounded="none" />
        </div>
      </div>
    );
  }

  // M19: funding is structurally OFF (max_abs_funding_e9_per_slot == 0) —
  // say so plainly instead of presenting a full funding-rate/APR/countdown
  // product that can never actually charge or pay anyone.
  if (fundingDisabled) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">Funding Rate</span>
            <InfoIcon tooltip="Funding is disabled for this market — the protocol's max funding rate is set to 0, so the applied rate is always exactly 0." />
          </div>
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">Off (disabled)</span>
        </div>
      </div>
    );
  }

  if (!fundingData) return null;

  const hourlyRatePercent = fundingData.hourlyRatePercent ?? 0;
  // Convert hourly rate to 8h rate for display — consistent with MarketStatsCard and MarketInfoBar
  const eightHourRatePercent = hourlyRatePercent * 8;
  const rateDisplay = eightHourRatePercent >= 0 
    ? `+${eightHourRatePercent.toFixed(4)}%` 
    : `${eightHourRatePercent.toFixed(4)}%`;

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
            <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text)]">
              Funding Rate
            </span>
            <InfoIcon tooltip="Funding rates balance long/short positions. Percolator uses inventory-based funding to protect the market's liquidity." />
            <button
              onClick={() => setShowExplainer(true)}
              className="text-[8px] text-[var(--accent)] hover:underline"
            >
              more
            </button>
          </div>
          <div className="flex items-baseline gap-1.5">
            <span
              className={`text-sm font-bold ${eightHourRatePercent >= 0 ? "text-[var(--short)]" : "text-[var(--long)]"}`}
              style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
            >
              {rateDisplay}
            </span>
            <span className="text-[9px] text-[var(--text)]">/8h</span>
          </div>
        </div>

        {/* APR + Direction — compact row */}
        <div className="mb-1 flex items-center justify-between">
          <div className="rounded-none border-l-2 border-l-[var(--border)] bg-[var(--bg-elevated)] px-1.5 py-0.5">
            <span className="text-[10px] text-[var(--text-secondary)]">{directionText}</span>
            {countdown > 0 && (
              <span className="ml-1.5 text-[9px] text-[var(--text-secondary)]">· next {formatCountdown(countdown)}</span>
            )}
          </div>
          <span className="text-[10px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
            {(fundingData.aprPercent ?? 0) >= 0 ? "+" : ""}{(fundingData.aprPercent ?? 0).toFixed(1)}% APR
          </span>
        </div>

        {/* Position-Specific Estimate */}
        {positionDirection && estimatedFunding24h !== null && (
          <div className="rounded-none border border-[var(--border)]/30 bg-[var(--bg)] px-1.5 py-1">
            <div className="flex items-center justify-between">
              <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--text)]">
                Est. 24h ({positionDirection})
              </span>
              <span className={`text-[11px] font-bold ${fundingColor}`} style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
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
