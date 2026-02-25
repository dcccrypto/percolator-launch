"use client";

import { FC, useState, useEffect, useMemo } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { InfoIcon } from "@/components/ui/Tooltip";
import { InsuranceExplainerModal } from "./InsuranceExplainerModal";
import { InsuranceTopUpModal } from "./InsuranceTopUpModal";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";

interface InsuranceData {
  balance: string; // U128 as string (in token units e6)
  feeRevenue: string; // U128 as string
  dailyAccumulationRate: number; // USD per day
  coverageRatio: number; // Insurance / total_risk
  historicalBalance: Array<{ timestamp: number; balance: number }>; // 7-day history
  totalRisk: string; // Total open interest
}

// Mock data for development — use fixed timestamps to avoid SSR/client hydration mismatch
const MOCK_BASE_TS = 1739600000000; // fixed reference point
const MOCK_INSURANCE: InsuranceData = {
  balance: "125432000000", // $125,432
  feeRevenue: "12543000000", // $12,543
  dailyAccumulationRate: 234, // $234/day
  coverageRatio: 8.5, // 8.5x coverage
  totalRisk: "14750000000", // $14,750 total risk
  historicalBalance: [
    { timestamp: MOCK_BASE_TS - 7 * 24 * 60 * 60 * 1000, balance: 120000 },
    { timestamp: MOCK_BASE_TS - 6 * 24 * 60 * 60 * 1000, balance: 121200 },
    { timestamp: MOCK_BASE_TS - 5 * 24 * 60 * 60 * 1000, balance: 122100 },
    { timestamp: MOCK_BASE_TS - 4 * 24 * 60 * 60 * 1000, balance: 123000 },
    { timestamp: MOCK_BASE_TS - 3 * 24 * 60 * 60 * 1000, balance: 123800 },
    { timestamp: MOCK_BASE_TS - 2 * 24 * 60 * 60 * 1000, balance: 124500 },
    { timestamp: MOCK_BASE_TS - 1 * 24 * 60 * 60 * 1000, balance: 125000 },
    { timestamp: MOCK_BASE_TS, balance: 125432 },
  ],
};

function formatUsdAmount(amountRaw: string | bigint, decimals: number = 6): string {
  const num = typeof amountRaw === "string" ? BigInt(amountRaw) : amountRaw;
  const value = Number(num) / (10 ** decimals);
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

export const InsuranceDashboard: FC<{ slabAddress: string }> = ({
  slabAddress,
}) => {
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const { engine, insuranceFund, totalOI } = useEngineState();
  const { config } = useSlabState();
  const tokenMeta = useTokenMeta(config?.collateralMint ?? null);
  const decimals = tokenMeta?.decimals ?? 6;

  const [insuranceData, setInsuranceData] = useState<InsuranceData | null>(
    mockMode ? MOCK_INSURANCE : null
  );
  const [loading, setLoading] = useState(!mockMode);
  const [error, setError] = useState<string | null>(null);
  const [showExplainer, setShowExplainer] = useState(false);
  const [showTopUp, setShowTopUp] = useState(false);

  // Fetch insurance data from API
  useEffect(() => {
    if (mockMode) return;

    const fetchInsurance = async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/insurance/${slabAddress}`);
        if (!res.ok) throw new Error("Failed to fetch insurance data");
        const data = await res.json();
        // Map API response shape to InsuranceData interface
        const balance = data.balance ?? data.currentBalance ?? "0";
        const feeRevenue = data.feeRevenue ?? "0";
        const totalRisk = data.totalRisk ?? data.totalOpenInterest ?? "0";
        const balanceNum = Number(BigInt(balance));
        const riskNum = Number(BigInt(totalRisk));
        const coverageRatio = riskNum > 0 ? balanceNum / riskNum : 0;
        const historicalBalance = (data.historicalBalance ?? data.history ?? []).map((h: { timestamp: string | number; balance: string | number }) => ({
          timestamp: typeof h.timestamp === "string" ? new Date(h.timestamp).getTime() : h.timestamp,
          balance: typeof h.balance === "string" ? Number(BigInt(h.balance)) / (10 ** decimals) : h.balance,
        }));
        setInsuranceData({
          balance,
          feeRevenue,
          totalRisk,
          coverageRatio,
          dailyAccumulationRate: data.dailyAccumulationRate ?? 0,
          historicalBalance,
        });
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
        // Fallback to on-chain data when API unavailable
        if (engine) {
          const balance = engine.insuranceFund?.balance ?? 0n;
          const feeRev = engine.insuranceFund?.feeRevenue ?? 0n;
          const totalOi = engine.totalOpenInterest ?? 0n;
          const ratio = totalOi > 0n ? Number(balance * 10000n / totalOi) / 10000 : 0;
          setInsuranceData({
            balance: balance.toString(),
            feeRevenue: feeRev.toString(),
            totalRisk: totalOi.toString(),
            coverageRatio: ratio,
            dailyAccumulationRate: 0,
            historicalBalance: [],
          });
        }
      } finally {
        setLoading(false);
      }
    };

    fetchInsurance();
    const interval = setInterval(fetchInsurance, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [slabAddress, mockMode, engine]);

  // Calculate health status
  const healthStatus = useMemo(() => {
    if (!insuranceData) return { color: "text-[var(--text-muted)]", dotColor: "bg-[var(--text-muted)]", label: "Unknown", borderColor: "border-[var(--border)]", bgColor: "bg-transparent" };

    const ratio = insuranceData.coverageRatio ?? 0;

    if (ratio >= 5) {
      return {
        color: "text-[var(--long)]",
        dotColor: "bg-[var(--long)]",
        label: "Healthy",
        borderColor: "border-[var(--long)]",
        bgColor: "bg-[var(--long)]/5",
      };
    } else if (ratio >= 2) {
      return {
        color: "text-[var(--warning)]",
        dotColor: "bg-[var(--warning)]",
        label: "Moderate",
        borderColor: "border-[var(--warning)]",
        bgColor: "bg-[var(--warning)]/5",
      };
    } else {
      return {
        color: "text-[var(--short)]",
        dotColor: "bg-[var(--short)]",
        label: "Low",
        borderColor: "border-[var(--short)]",
        bgColor: "bg-[var(--short)]/5",
      };
    }
  }, [insuranceData]);

  if (loading && !insuranceData) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
            Insurance Fund
          </span>
          <div className="h-4 w-16 animate-pulse rounded-none bg-[var(--border)]" />
        </div>
      </div>
    );
  }

  if (!insuranceData || !insuranceData.balance || !insuranceData.feeRevenue) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
            Insurance Fund
          </span>
          <span className="text-[10px] text-[var(--text-dim)]">No data available</span>
        </div>
      </div>
    );
  }

  const balanceUsd = formatUsdAmount(insuranceData.balance, decimals);
  const feeRevenueUsd = formatUsdAmount(insuranceData.feeRevenue, decimals);

  return (
    <>
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-2">
        {/* Header row: label + balance */}
        <div className="mb-1.5 flex items-baseline justify-between">
          <div className="flex items-center gap-1">
            <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
              Insurance Fund
            </span>
            <InfoIcon tooltip="Safety net that protects LPs from bankruptcy during extreme market events." />
            <button
              onClick={() => setShowExplainer(true)}
              className="text-[8px] text-[var(--accent)] hover:underline"
            >
              more
            </button>
          </div>
          <span
            className="text-sm font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            ${balanceUsd}
          </span>
        </div>

        {/* Fee Revenue row */}
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-dim)]">Fee Revenue</span>
          <div className="flex items-baseline gap-1">
            <span className="text-[11px] font-medium text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
              ${feeRevenueUsd}
            </span>
            {insuranceData.dailyAccumulationRate != null && (
              <span className="text-[9px] text-[var(--long)]">(+${insuranceData.dailyAccumulationRate}/d)</span>
            )}
          </div>
        </div>

        {/* Health + Coverage — compact inline */}
        <div className={`mb-1.5 rounded-none border-l-2 ${healthStatus.borderColor} ${healthStatus.bgColor} px-1.5 py-1`}>
          <div className="flex items-center gap-1.5">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${healthStatus.dotColor}`} />
            <span className="text-[10px] font-medium text-[var(--text)]">
              <span className={healthStatus.color}>{healthStatus.label}</span>
            </span>
            {insuranceData.coverageRatio != null && typeof insuranceData.coverageRatio === "number" && (
              <span className="text-[9px] text-[var(--text-dim)]">
                {insuranceData.coverageRatio.toFixed(1)}x coverage
              </span>
            )}
          </div>
        </div>

        {/* 7-day mini chart */}
        <div className="rounded-none border border-[var(--border)]/30 bg-[var(--bg-elevated)] px-1.5 py-1">
          <div className="mb-0.5 flex items-center justify-between">
            <span className="text-[8px] uppercase tracking-[0.1em] text-[var(--text-dim)]">7d Trend</span>
            {insuranceData.historicalBalance && insuranceData.historicalBalance.length > 1 && insuranceData.historicalBalance[0].balance > 0 && (
              <span className="text-[9px] text-[var(--long)]" style={{ fontFamily: "var(--font-mono)" }}>
                +{((insuranceData.historicalBalance[insuranceData.historicalBalance.length - 1].balance / insuranceData.historicalBalance[0].balance - 1) * 100).toFixed(1)}%
              </span>
            )}
          </div>
          {insuranceData.historicalBalance && insuranceData.historicalBalance.length > 0 ? (
            <div className="flex h-6 items-end justify-between gap-[1px]">
              {insuranceData.historicalBalance.map((point, idx) => {
                const maxBalance = Math.max(...insuranceData.historicalBalance.map((p) => p.balance)) || 1;
                const height = (point.balance / maxBalance) * 100;
                return (
                  <div
                    key={idx}
                    className="flex-1 bg-[var(--long)]/30 hover:bg-[var(--long)]/50"
                    style={{ height: `${height}%` }}
                    title={`$${point.balance.toLocaleString()}`}
                  />
                );
              })}
            </div>
          ) : (
            <div className="flex h-6 items-center justify-center text-[9px] text-[var(--text-dim)]">No data</div>
          )}
        </div>

        {error && !mockMode && (
          <div className="mt-1 text-[8px] text-[var(--warning)]">{error} (on-chain fallback)</div>
        )}
      </div>

      {/* Modals */}
      {showExplainer && (
        <InsuranceExplainerModal onClose={() => setShowExplainer(false)} />
      )}
      {showTopUp && (
        <InsuranceTopUpModal
          slabAddress={slabAddress}
          currentBalance={insuranceData.balance}
          onClose={() => setShowTopUp(false)}
        />
      )}
    </>
  );
};
