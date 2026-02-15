"use client";

import { FC, useState, useEffect, useMemo } from "react";
import { useEngineState } from "@/hooks/useEngineState";
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

function formatUsdAmount(amountE6: string | bigint): string {
  const num = typeof amountE6 === "string" ? BigInt(amountE6) : amountE6;
  const usd = Number(num) / 1e6;
  return usd.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

export const InsuranceDashboard: FC<{ slabAddress: string; simulation?: boolean }> = ({
  slabAddress, simulation,
}) => {
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const { engine, insuranceFund, totalOI } = useEngineState();

  const [insuranceData, setInsuranceData] = useState<InsuranceData | null>(
    mockMode ? MOCK_INSURANCE : null
  );
  const [loading, setLoading] = useState(!mockMode && !simulation);
  const [error, setError] = useState<string | null>(null);
  const [showExplainer, setShowExplainer] = useState(false);
  const [showTopUp, setShowTopUp] = useState(false);

  // In simulation mode, derive from on-chain state
  useEffect(() => {
    if (!simulation || !engine) return;
    const balance = (insuranceFund?.balance ?? 0n).toString();
    const feeRev = (insuranceFund?.feeRevenue ?? 0n).toString();
    const risk = (totalOI ?? 0n).toString();
    const healthRatio = Number(totalOI ?? 0n) > 0
      ? Number(insuranceFund?.balance ?? 0n) / Number(totalOI ?? 0n)
      : 0;
    setInsuranceData({
      balance, feeRevenue: feeRev, dailyAccumulationRate: 0,
      coverageRatio: healthRatio, totalRisk: risk, historicalBalance: [],
    });
    setLoading(false);
  }, [simulation, engine, insuranceFund, totalOI]);

  // Fetch insurance data from API (non-simulation)
  useEffect(() => {
    if (mockMode || simulation) return;

    const fetchInsurance = async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/insurance/${slabAddress}`);
        if (!res.ok) throw new Error("Failed to fetch insurance data");
        const data = await res.json();
        setInsuranceData(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
        // Fallback to on-chain data when API unavailable
        if (engine) {
          const balance = engine.insuranceFund?.balance ?? 0n;
          const feeRev = engine.insuranceFund?.feeRevenue ?? 0n;
          const totalOi = engine.totalOpenInterest ?? 0n;
          const ratio = totalOi > 0n ? Number(balance * 10000n / totalOi) / 100 : 0;
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
  }, [slabAddress, mockMode, simulation, engine]);

  // Calculate health status
  const healthStatus = useMemo(() => {
    if (!insuranceData) return { color: "text-[var(--text-muted)]", dotColor: "bg-[var(--text-muted)]", label: "Unknown" };

    const ratio = insuranceData.coverageRatio;

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

  const balanceUsd = formatUsdAmount(insuranceData.balance);
  const feeRevenueUsd = formatUsdAmount(insuranceData.feeRevenue);

  return (
    <>
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        {/* Header */}
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
              Insurance Fund
            </span>
            <InfoIcon tooltip="Safety net that protects LPs from bankruptcy during extreme market events." />
            <button
              onClick={() => setShowExplainer(true)}
              className="ml-1 text-[9px] text-[var(--accent)] hover:underline"
            >
              Learn more
            </button>
          </div>
        </div>

        {/* Balance & Revenue */}
        <div className="mb-3 space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
              Balance
            </span>
            <span
              className="text-2xl font-bold text-[var(--text)]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              ${balanceUsd}
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
              Fee Revenue
            </span>
            <div className="text-right">
              <span
                className="text-sm font-medium text-[var(--text-secondary)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                ${feeRevenueUsd}
              </span>
              {insuranceData.dailyAccumulationRate != null && (
                <span className="ml-1.5 text-[10px] text-[var(--long)]">
                  (+${insuranceData.dailyAccumulationRate}/day)
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Health Status */}
        <div
          className={`mb-3 rounded-none border-l-2 ${healthStatus.borderColor} ${healthStatus.bgColor} p-2.5`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`inline-block w-2 h-2 rounded-full ${healthStatus.dotColor}`} />
              <div>
                <div className="text-[11px] font-medium text-[var(--text)]">
                  Health: <span className={healthStatus.color}>{healthStatus.label}</span>
                </div>
                {insuranceData.coverageRatio != null && (
                  <div className="text-[10px] text-[var(--text-dim)]">
                    Coverage Ratio: {insuranceData.coverageRatio.toFixed(1)}x total risk
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Mini Sparkline Chart (simplified) */}
        <div className="mb-3 rounded-none border border-[var(--border)]/30 bg-[var(--bg-elevated)] p-2">
          <div className="mb-1 text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
            7-Day Balance Trend
          </div>
          {insuranceData.historicalBalance && insuranceData.historicalBalance.length > 0 ? (
            <>
              <div className="flex h-12 items-end justify-between gap-[2px]">
                {insuranceData.historicalBalance.map((point, idx) => {
                  const maxBalance = Math.max(
                    ...insuranceData.historicalBalance.map((p) => p.balance)
                  ) || 1;
                  const height = (point.balance / maxBalance) * 100;
                  return (
                    <div
                      key={idx}
                      className="flex-1 rounded-none bg-[var(--long)]/30 transition-all hover:bg-[var(--long)]/50"
                      style={{ height: `${height}%` }}
                      title={`$${point.balance.toLocaleString()}`}
                    />
                  );
                })}
              </div>
              <div className="mt-1 flex justify-between text-[9px] text-[var(--text-dim)]">
                <span>7d ago</span>
                <span className="text-[var(--long)]">+{insuranceData.historicalBalance[0].balance > 0 ? ((insuranceData.historicalBalance[insuranceData.historicalBalance.length - 1].balance / insuranceData.historicalBalance[0].balance - 1) * 100).toFixed(1) : "0.0"}%</span>
              </div>
            </>
          ) : (
            <div className="flex h-12 items-center justify-center text-[10px] text-[var(--text-dim)]">
              No historical data
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2">
          <button
            onClick={() => setShowTopUp(true)}
            className="flex-1 rounded-none border border-[var(--accent)]/30 bg-[var(--accent)]/10 py-2 text-[10px] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/20"
          >
            Top Up Insurance
          </button>
          <button
            onClick={() => setShowExplainer(true)}
            className="flex-1 rounded-none border border-[var(--border)]/50 py-2 text-[10px] font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-elevated)]"
          >
            Learn More
          </button>
        </div>

        {error && !mockMode && (
          <div className="mt-2 text-[9px] text-[var(--warning)]">
            {error} (using on-chain data)
          </div>
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
