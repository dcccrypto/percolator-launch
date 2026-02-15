"use client";

import { FC, useState, useEffect, useMemo } from "react";
import { useEngineState } from "@/hooks/useEngineState";
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

function formatUsdAmount(amountE6: string | bigint): string {
  const num = typeof amountE6 === "string" ? BigInt(amountE6) : amountE6;
  const usd = Number(num) / 1e6;
  return usd.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function formatSignedUsdAmount(amountE6: string): string {
  const num = BigInt(amountE6);
  const usd = Number(num) / 1e6;
  const formatted = Math.abs(usd).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return usd >= 0 ? `+$${formatted}` : `-$${formatted}`;
}

export const OpenInterestCard: FC<{ slabAddress: string; simulation?: boolean }> = ({
  slabAddress, simulation,
}) => {
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const { engine } = useEngineState();

  const [oiData, setOiData] = useState<OpenInterestData | null>(
    mockMode ? MOCK_OI : null
  );
  const [loading, setLoading] = useState(!mockMode && !simulation);
  const [error, setError] = useState<string | null>(null);

  // In simulation mode, derive from on-chain state
  useEffect(() => {
    if (!simulation || !engine) return;
    const totalOi = engine.totalOpenInterest ?? 0n;
    const netLpPos = engine.netLpPos ?? 0n;
    // Clamp to avoid negative values when netLpPos > totalOi
    const rawLong = (totalOi + netLpPos) / 2n;
    const rawShort = (totalOi - netLpPos) / 2n;
    const longOi = rawLong < 0n ? 0n : rawLong;
    const shortOi = rawShort < 0n ? 0n : rawShort;
    setOiData({
      totalOi: totalOi.toString(),
      longOi: longOi.toString(),
      shortOi: shortOi.toString(),
      netLpPosition: netLpPos.toString(),
      historicalOi: [],
    });
    setLoading(false);
  }, [simulation, engine]);

  // Fetch OI data from API (non-simulation)
  useEffect(() => {
    if (mockMode || simulation) return;

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
  }, [slabAddress, mockMode, simulation, engine]);

  // Calculate percentages and imbalance
  const { longPct, shortPct, imbalancePct, imbalanceLabel, imbalanceColor } =
    useMemo(() => {
      if (!oiData) {
        return {
          longPct: 50,
          shortPct: 50,
          imbalancePct: 0,
          imbalanceLabel: "Balanced",
          imbalanceColor: "text-[var(--text-muted)]",
        };
      }

      const totalNum = Number(BigInt(oiData.totalOi));
      const longNum = Number(BigInt(oiData.longOi));
      const shortNum = Number(BigInt(oiData.shortOi));

      const longPercent = totalNum > 0 ? (longNum / totalNum) * 100 : 50;
      const shortPercent = totalNum > 0 ? (shortNum / totalNum) * 100 : 50;
      const imbalance = longPercent - shortPercent;

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

  const totalOiUsd = formatUsdAmount(oiData.totalOi);
  const longOiUsd = formatUsdAmount(oiData.longOi);
  const shortOiUsd = formatUsdAmount(oiData.shortOi);
  const lpNetUsd = formatSignedUsdAmount(oiData.netLpPosition);
  const lpDirection = BigInt(oiData.netLpPosition) >= 0n ? "long" : "short";

  return (
    <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
      {/* Header */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
            Open Interest
          </span>
          <InfoIcon tooltip="Total notional value of all open positions in the market." />
        </div>
      </div>

      {/* Total OI */}
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
          Total OI
        </div>
        <div
          className="text-2xl font-bold text-[var(--text)]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          ${totalOiUsd}
        </div>
      </div>

      {/* Long/Short Breakdown */}
      <div className="mb-3 space-y-2">
        {/* Long */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
              Long
            </span>
            <span
              className="text-[11px] font-medium text-[var(--long)]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              ${longOiUsd} ({longPct.toFixed(1)}%)
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-none bg-[var(--border)]/30">
            <div
              className="h-full bg-[var(--long)]"
              style={{ width: `${longPct}%` }}
            />
          </div>
        </div>

        {/* Short */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
              Short
            </span>
            <span
              className="text-[11px] font-medium text-[var(--short)]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              ${shortOiUsd} ({shortPct.toFixed(1)}%)
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-none bg-[var(--border)]/30">
            <div
              className="h-full bg-[var(--short)]"
              style={{ width: `${shortPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* Imbalance */}
      <div className="mb-3 rounded-none border-l-2 border-l-[var(--border)] bg-[var(--bg-elevated)] p-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
            Imbalance
          </span>
          <div className="text-right">
            <div
              className={`text-sm font-bold ${imbalanceColor}`}
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {imbalancePct >= 0 ? "+" : ""}
              {imbalancePct.toFixed(1)}%
            </div>
            <div className="text-[9px] text-[var(--text-dim)]">
              {imbalanceLabel}
            </div>
          </div>
        </div>
      </div>

      {/* LP Net Position */}
      <div className="mb-3 rounded-none border border-[var(--border)]/30 bg-[var(--bg)] p-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
              LP Net Position
            </span>
            <InfoIcon tooltip="The aggregate position LPs must hold to balance trader positions. Drives funding rates." />
          </div>
          <div className="text-right">
            <span
              className={`text-sm font-bold ${
                lpDirection === "long"
                  ? "text-[var(--long)]"
                  : "text-[var(--short)]"
              }`}
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {lpNetUsd}
            </span>
            <div className="text-[9px] text-[var(--text-dim)]">
              ({lpDirection})
            </div>
          </div>
        </div>
      </div>

      {/* 24h OI Chart (Simple Bar Chart) */}
      <div className="rounded-none border border-[var(--border)]/30 bg-[var(--bg-elevated)] p-2">
        <div className="mb-1 text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
          24h OI History
        </div>
        {oiData.historicalOi && oiData.historicalOi.length > 0 ? (
          <>
            <div className="flex h-16 items-end justify-between gap-[2px]">
              {oiData.historicalOi.map((point, idx) => {
                const maxOi = Math.max(
                  ...oiData.historicalOi.map((p) => p.totalOi)
                ) || 1;
                const height = (point.totalOi / maxOi) * 100;
                const longHeight = (point.longOi / maxOi) * 100;
                const shortHeight = (point.shortOi / maxOi) * 100;

                return (
                  <div
                    key={idx}
                    className="relative flex-1"
                    title={`Total: $${point.totalOi.toLocaleString()}\nLong: $${point.longOi.toLocaleString()}\nShort: $${point.shortOi.toLocaleString()}`}
                  >
                    {/* Stacked bars */}
                    <div
                      className="absolute bottom-0 w-full rounded-none bg-[var(--long)]/40 transition-all hover:bg-[var(--long)]/60"
                      style={{ height: `${longHeight}%` }}
                    />
                    <div
                      className="absolute w-full rounded-none bg-[var(--short)]/40 transition-all hover:bg-[var(--short)]/60"
                      style={{
                        bottom: `${longHeight}%`,
                        height: `${shortHeight}%`,
                      }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="mt-1 flex justify-between text-[9px] text-[var(--text-dim)]">
              <span>24h ago</span>
              <span className="text-[var(--accent)]">
                {oiData.historicalOi[0].totalOi > 0
                  ? ((oiData.historicalOi[oiData.historicalOi.length - 1].totalOi /
                      oiData.historicalOi[0].totalOi -
                      1) *
                      100) >= 0
                    ? "+"
                    : ""
                  : "+"}{" "}
                {oiData.historicalOi[0].totalOi > 0
                  ? Math.abs(
                      (oiData.historicalOi[oiData.historicalOi.length - 1].totalOi /
                        oiData.historicalOi[0].totalOi -
                        1) *
                        100
                    ).toFixed(1)
                  : "0.0"}
                %
              </span>
            </div>
          </>
        ) : (
          <div className="flex h-16 items-center justify-center text-[10px] text-[var(--text-dim)]">
            No historical data
          </div>
        )}
      </div>

      {error && !mockMode && (
        <div className="mt-2 text-[9px] text-[var(--warning)]">
          {error} (using on-chain data)
        </div>
      )}
    </div>
  );
};
