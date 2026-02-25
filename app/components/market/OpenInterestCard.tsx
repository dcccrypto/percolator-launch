"use client";

import { FC, useState, useEffect, useMemo } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { InfoIcon } from "@/components/ui/Tooltip";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";

interface OpenInterestData {
  totalOi: string; // U128 as string (token units e6)
  longOi: string;
  shortOi: string;
  netLpPosition: string; // I128 as string (can be negative)
  historicalOi: Array<{ timestamp: number; totalOi: number; longOi: number; shortOi: number }>;
}

// Mock data for development — use fixed timestamps to avoid SSR/client hydration mismatch
const MOCK_BASE_TS = 1739600000000; // fixed reference point
const MOCK_OI: OpenInterestData = {
  totalOi: "5234123000000", // $5,234,123
  longOi: "2850000000000", // $2,850,000 (54.5%)
  shortOi: "2384123000000", // $2,384,123 (45.5%)
  netLpPosition: "465877000000", // +$465,877 (long)
  historicalOi: [
    { timestamp: MOCK_BASE_TS - 24 * 60 * 60 * 1000, totalOi: 4800000, longOi: 2500000, shortOi: 2300000 },
    { timestamp: MOCK_BASE_TS - 20 * 60 * 60 * 1000, totalOi: 4950000, longOi: 2600000, shortOi: 2350000 },
    { timestamp: MOCK_BASE_TS - 16 * 60 * 60 * 1000, totalOi: 5100000, longOi: 2750000, shortOi: 2380000 },
    { timestamp: MOCK_BASE_TS - 12 * 60 * 60 * 1000, totalOi: 5200000, longOi: 2800000, shortOi: 2400000 },
    { timestamp: MOCK_BASE_TS - 8 * 60 * 60 * 1000, totalOi: 5150000, longOi: 2820000, shortOi: 2330000 },
    { timestamp: MOCK_BASE_TS - 4 * 60 * 60 * 1000, totalOi: 5220000, longOi: 2840000, shortOi: 2380000 },
    { timestamp: MOCK_BASE_TS, totalOi: 5234123, longOi: 2850000, shortOi: 2384123 },
  ],
};

function formatUsdAmount(amountRaw: string | bigint, decimals: number = 6): string {
  const num = typeof amountRaw === "string" ? BigInt(amountRaw) : amountRaw;
  const usd = Number(num) / (10 ** decimals);
  return usd.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function formatSignedUsdAmount(amountRaw: string, decimals: number = 6): string {
  const num = BigInt(amountRaw ?? "0");
  const usd = Number(num) / (10 ** decimals);
  const formatted = Math.abs(usd).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return usd >= 0 ? `+$${formatted}` : `-$${formatted}`;
}

export const OpenInterestCard: FC<{ slabAddress: string }> = ({
  slabAddress,
}) => {
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const { engine } = useEngineState();
  const { config } = useSlabState();
  const tokenMeta = useTokenMeta(config?.collateralMint ?? null);
  const tokenDecimals = tokenMeta?.decimals ?? 6;

  const [oiData, setOiData] = useState<OpenInterestData | null>(
    mockMode ? MOCK_OI : null
  );
  const [loading, setLoading] = useState(!mockMode);
  const [error, setError] = useState<string | null>(null);

  // Fetch OI data from API
  useEffect(() => {
    if (mockMode) return;

    const fetchOi = async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/open-interest/${slabAddress}`);
        if (!res.ok) throw new Error("Failed to fetch open interest data");
        const data = await res.json();
        setOiData(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
        // Fallback to on-chain data when API unavailable
        if (engine) {
          const totalOi = engine.totalOpenInterest?.toString() ?? "0";
          const netLp = engine.netLpPos ?? 0n;
          const totalOiBn = engine.totalOpenInterest ?? 0n;
          const netLpBn = netLp < 0n ? -netLp : netLp;
          const longOi = totalOiBn > netLpBn ? (totalOiBn + netLp) / 2n : 0n;
          const shortOi = totalOiBn > netLpBn ? (totalOiBn - netLp) / 2n : 0n;
          setOiData({
            totalOi,
            longOi: (longOi < 0n ? 0n : longOi).toString(),
            shortOi: (shortOi < 0n ? 0n : shortOi).toString(),
            netLpPosition: netLp.toString(),
            historicalOi: [],
          });
        }
      } finally {
        setLoading(false);
      }
    };

    fetchOi();
    const interval = setInterval(fetchOi, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [slabAddress, mockMode, engine]);

  // Calculate percentages, imbalance, and OI utilization
  const { longPct, shortPct, imbalancePct, imbalanceLabel, imbalanceColor, oiUtilPct, oiUtilColor } =
    useMemo(() => {
      if (!oiData) {
        return {
          longPct: 50,
          shortPct: 50,
          imbalancePct: 0,
          imbalanceLabel: "Balanced",
          imbalanceColor: "text-[var(--text-muted)]",
          oiUtilPct: 0,
          oiUtilColor: "var(--accent)",
        };
      }

      const totalNum = Number(BigInt(oiData.totalOi ?? "0"));
      const longNum = Number(BigInt(oiData.longOi ?? "0"));
      const shortNum = Number(BigInt(oiData.shortOi ?? "0"));

      const longPercent = totalNum > 0 ? (longNum / totalNum) * 100 : 50;
      const shortPercent = totalNum > 0 ? (shortNum / totalNum) * 100 : 50;
      const imbalance = longPercent - shortPercent;

      // OI Utilization: ratio of total OI to max capacity
      // Use maxOpenInterest from market data if available, otherwise default to $5M
      const maxOi = 5_000_000 * 1e6; // $5M in e6 units — placeholder until market.maxOpenInterest is available
      const utilization = maxOi > 0 ? Math.min(totalNum / maxOi, 1) : 0;
      // Dynamic color based on utilization level
      const utilColor =
        utilization < 0.5 ? "var(--accent)" :     // purple — normal
        utilization < 0.8 ? "var(--warning)" :     // yellow — elevated
        "var(--short)";                             // red — near capacity

      let label = "Balanced";
      let color = "text-[var(--text-muted)]";

      if (Math.abs(imbalance) < 5) {
        label = "Balanced";
        color = "text-[var(--long)]";
      } else if (imbalance > 0) {
        if (imbalance > 15) {
          label = "Heavily long-heavy";
          color = "text-[var(--warning)]";
        } else {
          label = "Slightly long-heavy";
          color = "text-[var(--text-secondary)]";
        }
      } else {
        if (imbalance < -15) {
          label = "Heavily short-heavy";
          color = "text-[var(--warning)]";
        } else {
          label = "Slightly short-heavy";
          color = "text-[var(--text-secondary)]";
        }
      }

      return {
        longPct: longPercent,
        shortPct: shortPercent,
        imbalancePct: imbalance,
        imbalanceLabel: label,
        imbalanceColor: color,
        oiUtilPct: utilization * 100,
        oiUtilColor: utilColor,
      };
    }, [oiData]);

  if (loading && !oiData) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
            Open Interest
          </span>
          <div className="h-4 w-16 animate-pulse rounded-none bg-[var(--border)]" />
        </div>
      </div>
    );
  }

  if (!oiData || !oiData.totalOi || !oiData.longOi || !oiData.shortOi || !oiData.netLpPosition) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
            Open Interest
          </span>
          <span className="text-[10px] text-[var(--text-dim)]">No data available</span>
        </div>
      </div>
    );
  }

  const totalOiUsd = formatUsdAmount(oiData.totalOi, tokenDecimals);
  const longOiUsd = formatUsdAmount(oiData.longOi, tokenDecimals);
  const shortOiUsd = formatUsdAmount(oiData.shortOi, tokenDecimals);
  const lpNetUsd = formatSignedUsdAmount(oiData.netLpPosition, tokenDecimals);
  const lpDirection = BigInt(oiData.netLpPosition ?? "0") >= 0n ? "long" : "short";

  return (
    <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-2">
      {/* Header row: label + total OI value */}
      <div className="mb-1.5 flex items-baseline justify-between">
        <div className="flex items-center gap-1">
          <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
            Open Interest
          </span>
          <InfoIcon tooltip="Total notional value of all open positions in the market." />
        </div>
        <span
          className="text-sm font-bold text-[var(--text)]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          ${totalOiUsd}
        </span>
      </div>

      {/* OI Utilization bar with label */}
      <div className="mb-1.5">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[9px] uppercase tracking-[0.04em] text-[var(--text-dim)]">
            OI Utilization
          </span>
          <span
            className="text-[9px] font-medium"
            style={{ fontFamily: "var(--font-mono)", color: oiUtilColor, fontVariantNumeric: "tabular-nums" }}
          >
            {Math.round(oiUtilPct)}%
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-sm bg-[var(--border)]/30">
          <div
            className="h-full transition-all duration-500 ease-out rounded-sm"
            style={{ width: `${oiUtilPct}%`, backgroundColor: oiUtilColor }}
          />
        </div>
      </div>

      {/* Long/Short bars — compact inline */}
      <div className="mb-1.5 space-y-1">
        <div>
          <div className="mb-0.5 flex items-center justify-between">
            <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-dim)]">Long</span>
            <span className="text-[10px] font-medium text-[var(--long)]" style={{ fontFamily: "var(--font-mono)" }}>
              ${longOiUsd} ({longPct.toFixed(1)}%)
            </span>
          </div>
          <div className="h-1 w-full overflow-hidden bg-[var(--border)]/30">
            <div className="h-full bg-[var(--long)]" style={{ width: `${longPct}%` }} />
          </div>
        </div>
        <div>
          <div className="mb-0.5 flex items-center justify-between">
            <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-dim)]">Short</span>
            <span className="text-[10px] font-medium text-[var(--short)]" style={{ fontFamily: "var(--font-mono)" }}>
              ${shortOiUsd} ({shortPct.toFixed(1)}%)
            </span>
          </div>
          <div className="h-1 w-full overflow-hidden bg-[var(--border)]/30">
            <div className="h-full bg-[var(--short)]" style={{ width: `${shortPct}%` }} />
          </div>
        </div>
      </div>

      {/* Imbalance + LP Net — compact two-column row */}
      <div className="mb-1.5 grid grid-cols-2 gap-1">
        <div className="rounded-none border-l-2 border-l-[var(--border)] bg-[var(--bg-elevated)] px-1.5 py-1">
          <div className="text-[8px] uppercase tracking-[0.1em] text-[var(--text-dim)]">Imbalance</div>
          <div className={`text-[11px] font-bold ${imbalanceColor}`} style={{ fontFamily: "var(--font-mono)" }}>
            {imbalancePct >= 0 ? "+" : ""}{imbalancePct.toFixed(1)}%
          </div>
          <div className="text-[8px] text-[var(--text-dim)]">{imbalanceLabel}</div>
        </div>
        <div className="rounded-none border border-[var(--border)]/30 bg-[var(--bg)] px-1.5 py-1">
          <div className="flex items-center gap-0.5">
            <span className="text-[8px] uppercase tracking-[0.1em] text-[var(--text-dim)]">LP Net</span>
            <InfoIcon tooltip="The aggregate position LPs must hold to balance trader positions. Drives funding rates." />
          </div>
          <div className={`text-[11px] font-bold ${lpDirection === "long" ? "text-[var(--long)]" : "text-[var(--short)]"}`} style={{ fontFamily: "var(--font-mono)" }}>
            {lpNetUsd}
          </div>
          <div className="text-[8px] text-[var(--text-dim)]">({lpDirection})</div>
        </div>
      </div>

      {/* 24h OI mini chart */}
      <div className="rounded-none border border-[var(--border)]/30 bg-[var(--bg-elevated)] px-1.5 py-1">
        <div className="mb-0.5 flex items-center justify-between">
          <span className="text-[8px] uppercase tracking-[0.1em] text-[var(--text-dim)]">24h OI</span>
          {oiData.historicalOi && oiData.historicalOi.length > 1 && oiData.historicalOi[0].totalOi > 0 && (
            <span className="text-[9px] text-[var(--accent)]" style={{ fontFamily: "var(--font-mono)" }}>
              {((oiData.historicalOi[oiData.historicalOi.length - 1].totalOi / oiData.historicalOi[0].totalOi - 1) * 100) >= 0 ? "+" : ""}
              {((oiData.historicalOi[oiData.historicalOi.length - 1].totalOi / oiData.historicalOi[0].totalOi - 1) * 100).toFixed(1)}%
            </span>
          )}
        </div>
        {oiData.historicalOi && oiData.historicalOi.length > 0 ? (
          <div className="flex h-8 items-end justify-between gap-[1px]">
            {oiData.historicalOi.map((point, idx) => {
              const maxOi = Math.max(...oiData.historicalOi.map((p) => p.totalOi)) || 1;
              const longHeight = (point.longOi / maxOi) * 100;
              const shortHeight = (point.shortOi / maxOi) * 100;
              return (
                <div
                  key={idx}
                  className="relative flex-1"
                  title={`Total: $${point.totalOi.toLocaleString()}`}
                >
                  <div className="absolute bottom-0 w-full bg-[var(--long)]/40" style={{ height: `${longHeight}%` }} />
                  <div className="absolute w-full bg-[var(--short)]/40" style={{ bottom: `${longHeight}%`, height: `${shortHeight}%` }} />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex h-8 items-center justify-center text-[9px] text-[var(--text-dim)]">No data</div>
        )}
      </div>

      {error && !mockMode && (
        <div className="mt-1 text-[8px] text-[var(--warning)]">{error} (on-chain fallback)</div>
      )}
    </div>
  );
};
