"use client";

import { FC, useState, useMemo } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useUsdToggle } from "@/components/providers/UsdToggleProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { formatTokenAmount, formatCompactTokenAmount, formatUsd, formatBps } from "@/lib/format";
import { sanitizeOnChainValue, sanitizeAccountCount, sanitizeBps } from "@/lib/health";
import { useLivePrice } from "@/hooks/useLivePrice";
import { resolveMarketPriceE6, sanitizePriceE6, detectOracleMode } from "@/lib/oraclePrice";
import { FundingRateCard } from "./FundingRateCard";
import { FundingRateChart } from "./FundingRateChart";
import { sanitizeSymbol } from "@/lib/symbol-utils";
import { OracleFreshnessIndicator } from "@/components/oracle/OracleFreshnessIndicator";

function formatNum(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Format a price in E6 format as a USD string with appropriate precision. */
function formatPriceE6(priceE6: bigint): string {
  const price = Number(priceE6) / 1_000_000;
  if (price >= 1_000) return `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (price >= 1) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(6)}`;
}

/**
 * Convert fundingRateBpsPerSlotLast (i64) to hourly percentage.
 * Solana slots ≈ 400ms → 9000 slots/hr
 * hourlyRate% = (rateBpsPerSlot * 9000) / 10000
 */
function fundingRateBpsToHourly(rateBps: bigint): number {
  return (Number(rateBps) * 9000) / 10000;
}

export const MarketStatsCard: FC = () => {
  const { engine, params, fundingRate, loading } = useEngineState();
  const { config: mktConfig, slabAddress } = useSlabState();
  const config = useMarketConfig();
  const { priceE6: livePriceE6, priceUsd } = useLivePrice();
  const { showUsd } = useUsdToggle();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const mintAddress = mktConfig?.collateralMint?.toBase58() ?? "";
  const symbol = sanitizeSymbol(tokenMeta?.symbol, mintAddress);
  const [showFundingChart, setShowFundingChart] = useState(false);

  // ─── Mark / Index / Spread ────────────────────────────────────────────────
  const { markPriceE6, indexPriceE6, spreadBps, oracleMode } = useMemo(() => {
    if (!mktConfig) return { markPriceE6: null, indexPriceE6: null, spreadBps: null, oracleMode: null };

    const mode = detectOracleMode(mktConfig);
    let mark: bigint | null = null;
    let index: bigint | null = null;

    if (mode === "hyperp" || mode === "admin") {
      // authorityPriceE6 = latest pushed/mark price
      // lastEffectivePriceE6 = EMA / effective / index price
      mark = sanitizePriceE6(mktConfig.authorityPriceE6);
      index = sanitizePriceE6(mktConfig.lastEffectivePriceE6);
      if (mark === 0n) mark = null;
      if (index === 0n) index = null;
    } else {
      // pyth-pinned: mark ≈ index (Pyth IS the oracle — no separate mark/index distinction)
      const p = sanitizePriceE6(mktConfig.lastEffectivePriceE6);
      mark = p > 0n ? p : null;
      index = mark;
    }

    let bps: number | null = null;
    if (mark !== null && index !== null && index > 0n) {
      bps = (Number(mark - index) / Number(index)) * 10000;
    }

    return { markPriceE6: mark, indexPriceE6: index, spreadBps: bps, oracleMode: mode };
  }, [mktConfig]);

  // ─── Funding Rate ──────────────────────────────────────────────────────────
  const fundingHourlyPct = fundingRate !== null ? fundingRateBpsToHourly(fundingRate) : null;

  if (loading || !engine || !config || !params) {
    return (
      <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <p className="text-[10px] text-[var(--text-secondary)]">{loading ? "Loading..." : "Market not loaded"}</p>
      </div>
    );
  }

  const decimals = tokenMeta?.decimals ?? 6;
  const tokenDivisor = 10 ** decimals;
  // Sanitize sentinel values (u64::MAX) from uninitialized on-chain fields
  const totalOI = sanitizeOnChainValue(engine.totalOpenInterest ?? 0n);
  const vault = sanitizeOnChainValue(engine.vault ?? 0n);
  const oiDisplay = showUsd && priceUsd != null
    ? formatNum((Number(totalOI) / tokenDivisor) * priceUsd)
    : formatCompactTokenAmount(totalOI, decimals);
  const vaultDisplay = showUsd && priceUsd != null
    ? formatNum((Number(vault) / tokenDivisor) * priceUsd)
    : formatCompactTokenAmount(vault, decimals);
  // Full-precision tooltips for truncated stat cells (D1/D2)
  const oiFullDisplay = showUsd && priceUsd != null
    ? formatNum((Number(totalOI) / tokenDivisor) * priceUsd)
    : formatTokenAmount(totalOI, decimals);
  const vaultFullDisplay = showUsd && priceUsd != null
    ? formatNum((Number(vault) / tokenDivisor) * priceUsd)
    : formatTokenAmount(vault, decimals);

  // Spread display: "+$0.06 (+0.03%)" or "—" for pyth-pinned / unavailable
  const showSpread = oracleMode !== "pyth-pinned" && markPriceE6 !== null && indexPriceE6 !== null;
  const spreadAbs = showSpread && markPriceE6 !== null && indexPriceE6 !== null
    ? markPriceE6 - indexPriceE6
    : null;
  const spreadDisplayValue = (() => {
    if (!showSpread || spreadAbs === null || spreadBps === null) return "—";
    const absSpread = spreadAbs < 0n ? -spreadAbs : spreadAbs;
    const sign = spreadAbs >= 0n ? "+" : "−";
    // formatPriceE6 returns "$X.XX" — replace the $ with sign+$
    const dollarPart = formatPriceE6(absSpread).replace("$", `${sign}$`);
    const pctPart = `${sign}${Math.abs(spreadBps / 100).toFixed(2)}%`;
    return `${dollarPart} (${pctPart})`;
  })();
  // Color spread amber if abs spread > 0.5% (50 bps)
  const spreadColor = (() => {
    if (!showSpread || spreadBps === null) return "text-[var(--text-dim)]";
    const absBps = Math.abs(spreadBps);
    if (absBps > 50) return "text-amber-400";
    if (spreadAbs !== null && spreadAbs > 0n) return "text-[var(--long)]";
    if (spreadAbs !== null && spreadAbs < 0n) return "text-[var(--short)]";
    return "text-[var(--text-dim)]";
  })();

  // Funding rate display: "+0.0081%/hr"
  const fundingDisplay = fundingHourlyPct !== null
    ? `${fundingHourlyPct >= 0 ? "+" : ""}${fundingHourlyPct.toFixed(4)}%/hr`
    : "—";
  const fundingColor = fundingHourlyPct === null
    ? "text-[var(--text-dim)]"
    : fundingHourlyPct > 0
      ? "text-[var(--short)]" // longs pay shorts → short favorable
      : fundingHourlyPct < 0
        ? "text-[var(--long)]" // shorts pay longs → long favorable
        : "text-[var(--text-dim)]";

  type StatCell = {
    label: string;
    value: string;
    tooltip?: string;
    valueClass?: string;
  };

  const stats: StatCell[] = [
    // Row 1 — Pricing signals
    {
      label: "Mark",
      value: markPriceE6 !== null ? formatPriceE6(markPriceE6) : formatUsd(livePriceE6 ?? (mktConfig ? resolveMarketPriceE6(mktConfig) : 0n)),
      tooltip: "EMA mark price used for liquidations and PnL",
    },
    {
      label: "Index",
      value: indexPriceE6 !== null ? formatPriceE6(indexPriceE6) : "—",
      tooltip: "On-chain oracle index price",
    },
    {
      label: "Spread",
      value: spreadDisplayValue,
      tooltip: "Mark – Index spread. Amber if >0.5%.",
      valueClass: spreadColor,
    },
    // Row 2 — Market health
    { label: "Open Interest", value: oiDisplay, tooltip: oiFullDisplay },
    { label: "Vault", value: vaultDisplay, tooltip: vaultFullDisplay },
    {
      label: "Funding/hr",
      value: fundingDisplay,
      tooltip: "Hourly funding rate. Positive: longs pay shorts.",
      valueClass: fundingColor,
    },
    // Row 3 — Market parameters
    { label: "Trading Fee", value: sanitizeBps(params.tradingFeeBps, 5_000) != null ? formatBps(sanitizeBps(params.tradingFeeBps, 5_000)!) : "—" },
    { label: "Init. Margin", value: sanitizeBps(params.initialMarginBps) != null ? formatBps(sanitizeBps(params.initialMarginBps)!) : "—" },
    { label: "Accounts", value: sanitizeAccountCount(engine.numUsedAccounts ?? 0, params ? Number(params.maxAccounts) : undefined).toString() },
  ];

  return (
    <div className="space-y-1.5">
      {/* Market Stats Grid — 3×3 */}
      <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-2">
        <div className="grid grid-cols-3 gap-px">
          {stats.map((s) => (
            <div
              key={s.label}
              className="px-1.5 py-1 overflow-hidden border-b border-r border-[var(--border)]/20 [&:nth-child(3n)]:border-r-0 [&:nth-last-child(-n+3)]:border-b-0"
            >
              <p className="text-[8px] uppercase tracking-[0.1em] text-[var(--text-muted)] truncate">{s.label}</p>
              <p
                className={`text-[11px] font-medium truncate ${s.valueClass ?? "text-[var(--text)]"}`}
                title={s.tooltip ?? s.value}
                style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
              >
                {s.value}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Oracle Freshness Indicator — P0 */}
      <OracleFreshnessIndicator />

      {/* Funding Rate Section — detailed view with explainer + countdown */}
      {slabAddress && (
        <>
          <FundingRateCard slabAddress={slabAddress} />

          {/* Funding Chart Toggle */}
          <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80">
            <button
              onClick={() => setShowFundingChart(!showFundingChart)}
              className="flex w-full items-center justify-between px-2 py-1 text-left text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)] transition-colors hover:text-[var(--text-secondary)]"
            >
              <span>Funding History</span>
              <span className={`text-[9px] text-[var(--text-dim)] transition-transform duration-200 ${showFundingChart ? "rotate-180" : ""}`}>▾</span>
            </button>
            {showFundingChart && (
              <div className="px-2 pb-2">
                <FundingRateChart slabAddress={slabAddress} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
