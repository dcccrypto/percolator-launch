"use client";

import { FC, useState, useEffect, useMemo } from "react";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useLivePrice } from "@/hooks/useLivePrice";
import { InfoIcon } from "@/components/ui/Tooltip";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";

interface OpenInterestData {
  totalOi: string; // U128 as string
  longOi: string;
  shortOi: string;
  netLpPosition: string; // I128 as string (can be negative)
  historicalOi: Array<{ timestamp: number; totalOi: number; longOi: number; shortOi: number }>;
  /**
   * H12: v12's totalOi/longOi/shortOi are already collateral-notional (USD)
   * atoms. v17's are base-asset "Q" quantities (fixed-point, scale 1e6) —
   * printing them straight as `$` was the bug (no price multiplication).
   * True on the v17 branch of /api/open-interest/[slab] (both possible
   * shapes there); undefined/false elsewhere (v12, mock, on-chain fallback).
   */
  isV17?: boolean;
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
  isV17: false,
};

/** v17 base-asset "Q" fixed-point scale (matches parseMarketGroupV17OI / api/markets). */
const V17_Q_SCALE = 1_000_000;

/**
 * H12: format a raw OI amount as USD.
 *  - v12: the raw value is already collateral-notional (USD) atoms — divide
 *    by the collateral token's decimals only, as before.
 *  - v17: the raw value is a base-asset "Q" quantity — divide by the fixed
 *    Q scale (1e6) and multiply by the live USD price. Returns null when the
 *    price isn't available yet rather than silently printing a wrong number.
 */
function formatOiUsd(
  amountRaw: string | bigint,
  isV17: boolean,
  priceUsd: number | null,
  collateralDecimals: number,
): string | null {
  const num = typeof amountRaw === "string" ? BigInt(amountRaw || "0") : amountRaw;
  if (isV17) {
    if (priceUsd == null) return null;
    const usd = (Number(num) / V17_Q_SCALE) * priceUsd;
    return usd.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  const usd = Number(num) / (10 ** collateralDecimals);
  return usd.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
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
  const { engine, isV17, oiLong, oiShort } = useEngineState();
  const { config } = useSlabState();
  const tokenMeta = useTokenMeta(config?.collateralMint ?? null);
  const tokenDecimals = tokenMeta?.decimals ?? 6;
  const { priceUsd } = useLivePrice();

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
        // Fallback to on-chain data when API unavailable. useEngineState()
        // unifies v12 (engine.longOi/shortOi) and v17 (parseMarketGroupV17OI,
        // via oiLong/oiShort) — the old fallback only ever read the v12
        // fields, so it silently produced nothing on v17 markets.
        if (isV17 && oiLong != null && oiShort != null) {
          setOiData({
            totalOi: (oiLong + oiShort).toString(),
            longOi: oiLong.toString(),
            shortOi: oiShort.toString(),
            netLpPosition: "0",
            historicalOi: [],
            isV17: true,
          });
        } else if (engine) {
          const longOi = engine.longOi ?? 0n;
          const shortOi = engine.shortOi ?? 0n;
          const totalOi = (longOi + shortOi).toString();
          setOiData({
            totalOi,
            longOi: longOi.toString(),
            shortOi: shortOi.toString(),
            netLpPosition: (engine.netLpPos ?? 0n).toString(),
            historicalOi: [],
            isV17: false,
          });
        }
      } finally {
        setLoading(false);
      }
    };

    fetchOi();
    const interval = setInterval(fetchOi, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [slabAddress, mockMode, engine, isV17, oiLong, oiShort]);

  // Calculate percentages and imbalance (unaffected by USD conversion — a
  // uniform price multiplier cancels out of a long/short ratio).
  const { longPct, shortPct, imbalancePct, imbalanceLabel, imbalanceColor } =
    useMemo(() => {
      if (!oiData) {
        return {
          longPct: 50,
          shortPct: 50,
          imbalancePct: 0,
          imbalanceLabel: "Balanced",
          imbalanceColor: "text-[var(--text-secondary)]",
        };
      }

      const totalNum = Number(BigInt(oiData.totalOi ?? "0"));
      const longNum = Number(BigInt(oiData.longOi ?? "0"));
      const shortNum = Number(BigInt(oiData.shortOi ?? "0"));

      const longPercent = totalNum > 0 ? (longNum / totalNum) * 100 : 50;
      const shortPercent = totalNum > 0 ? (shortNum / totalNum) * 100 : 50;
      const imbalance = longPercent - shortPercent;

      let label = "Balanced";
      let color = "text-[var(--text-secondary)]";

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
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">
            Open Interest
          </span>
          <ShimmerSkeleton className="h-4 w-16" rounded="none" />
        </div>
      </div>
    );
  }

  if (!oiData) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">
            Open Interest
          </span>
          <span className="text-[10px] text-[var(--text-secondary)]">No data available</span>
        </div>
      </div>
    );
  }

  // H12: oiData.isV17 (set by the fetch/fallback above) is the source of
  // truth for how to interpret the raw numbers; fall back to the live hook's
  // isV17 only for defensive/legacy shapes.
  const dataIsV17 = oiData.isV17 ?? isV17;
  const totalOiUsd = formatOiUsd(oiData.totalOi || "0", dataIsV17, priceUsd, tokenDecimals);
  const longOiUsd = formatOiUsd(oiData.longOi || "0", dataIsV17, priceUsd, tokenDecimals);
  const shortOiUsd = formatOiUsd(oiData.shortOi || "0", dataIsV17, priceUsd, tokenDecimals);
  // v17 has no per-portfolio LP-net aggregation server-side yet (the API
  // always returns "0") — showing it as real data would fabricate a $0 LP
  // position. Only render it on v12, where it's genuinely computed.
  const lpNetUsd = formatSignedUsdAmount(oiData.netLpPosition || "0", tokenDecimals);
  const lpDirection = BigInt(oiData.netLpPosition ?? "0") >= 0n ? "long" : "short";

  return (
    <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-2">
      {/* Header row: label + total OI value */}
      <div className="mb-1.5 flex items-baseline justify-between">
        <div className="flex items-center gap-1">
          <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-secondary)]">
            Open Interest
          </span>
          <InfoIcon tooltip="Total notional value of all open positions in the market." />
        </div>
        <span
          className="text-sm font-bold text-[var(--text)]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {totalOiUsd != null ? `$${totalOiUsd}` : "—"}
        </span>
      </div>

      {/* Long/Short bars — compact inline */}
      <div className="mb-1.5 space-y-1">
        <div>
          <div className="mb-0.5 flex items-center justify-between">
            <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-secondary)]">Long</span>
            <span className="text-[10px] font-medium text-[var(--long)]" style={{ fontFamily: "var(--font-mono)" }}>
              {longOiUsd != null ? `$${longOiUsd}` : "—"} ({longPct.toFixed(1)}%)
            </span>
          </div>
          <div className="h-1 w-full overflow-hidden bg-[var(--border)]/30">
            <div className="h-full bg-[var(--long)]" style={{ width: `${longPct}%` }} />
          </div>
        </div>
        <div>
          <div className="mb-0.5 flex items-center justify-between">
            <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-secondary)]">Short</span>
            <span className="text-[10px] font-medium text-[var(--short)]" style={{ fontFamily: "var(--font-mono)" }}>
              {shortOiUsd != null ? `$${shortOiUsd}` : "—"} ({shortPct.toFixed(1)}%)
            </span>
          </div>
          <div className="h-1 w-full overflow-hidden bg-[var(--border)]/30">
            <div className="h-full bg-[var(--short)]" style={{ width: `${shortPct}%` }} />
          </div>
        </div>
      </div>

      {/* Imbalance + LP Net — compact two-column row. LP Net is v12-only real
          data (v17 has no per-portfolio aggregation yet, see above). */}
      <div className={`mb-1.5 grid gap-1 ${dataIsV17 ? "grid-cols-1" : "grid-cols-2"}`}>
        <div className="rounded-none border-l-2 border-l-[var(--border)] bg-[var(--bg-elevated)] px-1.5 py-1">
          <div className="text-[8px] uppercase tracking-[0.1em] text-[var(--text-secondary)]">Imbalance</div>
          <div className={`text-[11px] font-bold ${imbalanceColor}`} style={{ fontFamily: "var(--font-mono)" }}>
            {imbalancePct >= 0 ? "+" : ""}{imbalancePct.toFixed(1)}%
          </div>
          <div className="text-[8px] text-[var(--text-secondary)]">{imbalanceLabel}</div>
        </div>
        {!dataIsV17 && (
        <div className="rounded-none border border-[var(--border)]/30 bg-[var(--bg)] px-1.5 py-1">
          <div className="flex items-center gap-0.5">
            <span className="text-[8px] uppercase tracking-[0.1em] text-[var(--text-secondary)]">LP Net</span>
            <InfoIcon tooltip="The aggregate position LPs must hold to balance trader positions. Drives funding rates." />
          </div>
          <div className={`text-[11px] font-bold ${lpDirection === "long" ? "text-[var(--long)]" : "text-[var(--short)]"}`} style={{ fontFamily: "var(--font-mono)" }}>
            {lpNetUsd}
          </div>
          <div className="text-[8px] text-[var(--text-secondary)]">({lpDirection})</div>
        </div>
        )}
      </div>

      {/* 24h OI mini chart */}
      <div className="rounded-none border border-[var(--border)]/30 bg-[var(--bg-elevated)] px-1.5 py-1">
        <div className="mb-0.5 flex items-center justify-between">
          <span className="text-[8px] uppercase tracking-[0.1em] text-[var(--text-secondary)]">24h OI</span>
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
          <div className="flex h-8 items-center justify-center text-[9px] text-[var(--text-secondary)]">No data</div>
        )}
      </div>

      {error && !mockMode && (
        <div className="mt-1 text-[8px] text-[var(--warning)]">{error} (on-chain fallback)</div>
      )}
    </div>
  );
};
