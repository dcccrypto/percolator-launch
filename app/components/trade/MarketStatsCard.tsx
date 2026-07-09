"use client";

import { FC, useState, useMemo } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useUsdToggle } from "@/components/providers/UsdToggleProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { formatTokenAmount, formatCompactTokenAmount, formatUsd, formatUsdPriceE6, formatBps } from "@/lib/format";
import { sanitizeOnChainValue, sanitizeAccountCount, sanitizeBps, sanitizeFundingRateBps } from "@/lib/health";
import { useLivePrice } from "@/hooks/useLivePrice";
import { resolveMarketPriceE6, computeMarketSpread } from "@/lib/oraclePrice";
import { FundingRateCard } from "./FundingRateCard";
import { FundingRateChart } from "./FundingRateChart";
import { sanitizeSymbol } from "@/lib/symbol-utils";
import { OracleFreshnessIndicator } from "@/components/oracle/OracleFreshnessIndicator";
import { useMarketInfo } from "@/hooks/useMarketInfo";

function formatNum(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Convert fundingRateBpsPerSlotLast (i64) to 8-hour percentage.
 * Solana slots ≈ 400ms → 9000 slots/hr → 72000 slots/8h
 * 8h rate% = (rateBpsPerSlot * slotsPerHr * 8) / 100
 * where /100 converts bps → percent.
 * Previously used /10000/100 (GH#1943: 10,000x underreport — fixed).
 * Consistent with MarketInfoBar label "/ 8h".
 */
function fundingRateBpsTo8h(rateBps: bigint): number {
  return (Number(rateBps) * 9000 * 8) / 100;
}

export const MarketStatsCard: FC = () => {
  // totalOI/oiLong/oiShort work on BOTH v12 and v17; vault is engine-only (null on v17).
  const { engine, params, fundingRate, loading, totalOI: totalOIField, oiLong, oiShort, vault: vaultField } = useEngineState();
  const { config: mktConfig, slabAddress, wrapperConfigV17 } = useSlabState();
  const config = useMarketConfig();
  const { market: marketInfo } = useMarketInfo(slabAddress);
  const { priceE6: livePriceE6, priceUsd } = useLivePrice();
  const { showUsd } = useUsdToggle();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const mintAddress = mktConfig?.collateralMint?.toBase58() ?? "";
  // BUG FIX: Use Supabase market symbol for display, fall back to collateral token symbol
  const collateralSymbol = sanitizeSymbol(tokenMeta?.symbol, mintAddress);
  const symbol = marketInfo?.symbol ?? collateralSymbol;
  const [showFundingChart, setShowFundingChart] = useState(false);

  // ─── Mark / Index / Spread ────────────────────────────────────────────────
  // Shared with MarketInfoBar's top-bar spread stat — see lib/oraclePrice.ts.
  const { markPriceE6, indexPriceE6, spreadBps, oracleMode } = useMemo(
    () => computeMarketSpread(mktConfig, wrapperConfigV17?.oracleMode),
    [mktConfig, wrapperConfigV17],
  );

  // ─── Funding Rate ──────────────────────────────────────────────────────────
  // sanitizeFundingRateBps guards against garbage on-chain values (e.g. wrong
  // offset reads on old devnet slabs) that would render as e.g. "+1.6e15%/hr".
  // Valid range matches the on-chain guard: abs(rate) <= 10_000 bps/slot.
  const fundingHourlyPct = sanitizeFundingRateBps(fundingRate) !== null
    ? fundingRateBpsTo8h(sanitizeFundingRateBps(fundingRate)!)
    : null;

  // P2-04: v17 markets set engine=null (no legacy engine block). Treat wrapperConfigV17
  // as the "loaded" signal for v17 so Stats tab doesn't show "Market not loaded" when
  // price/chart are live. Stats that require engine fall back to 0/unavailable for v17.
  const isV17 = wrapperConfigV17 !== null;
  if (loading || (!engine && !isV17) || !config) {
    return (
      <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <p className="text-[10px] text-[var(--text-secondary)]">{loading ? "Loading..." : "Market not loaded"}</p>
      </div>
    );
  }

  const decimals = tokenMeta?.decimals ?? 6;
  const tokenDivisor = 10 ** decimals;
  // Sanitize sentinel values (u64::MAX) from uninitialized on-chain fields.
  // totalOI/oiLong/oiShort come from useEngineState and work on v12 AND v17.
  // vault is engine-only → null on v17 → renders "—".
  const totalOI = sanitizeOnChainValue(totalOIField ?? 0n);
  const vaultAtoms = vaultField != null ? sanitizeOnChainValue(vaultField) : null;
  const oiLongAtoms = oiLong != null ? sanitizeOnChainValue(oiLong) : null;
  const oiShortAtoms = oiShort != null ? sanitizeOnChainValue(oiShort) : null;
  const fmtOI = (atoms: bigint): string =>
    showUsd && priceUsd != null
      ? formatNum((Number(atoms) / tokenDivisor) * priceUsd)
      : formatCompactTokenAmount(atoms, decimals);
  const fmtOIFull = (atoms: bigint): string =>
    showUsd && priceUsd != null
      ? formatNum((Number(atoms) / tokenDivisor) * priceUsd)
      : formatTokenAmount(atoms, decimals);
  const oiDisplay = fmtOI(totalOI);
  const oiFullDisplay = fmtOIFull(totalOI);
  // GH#2334 follow-up: "Vault"/"Market LP" — engine.vault is v12-only (always
  // null on v17, which every playground market is now). On v17, fall back to
  // /api/markets/[slab]'s vault_balance — the real on-chain LP-portfolio
  // capital (see lib/lp-portfolio.ts), not the Supabase-only value that used
  // to be null for every v17 row. Mirrors the same vault_balance ?? c_tot
  // precedent used on the /markets list page.
  const marketLpFromApi = (() => {
    const raw = marketInfo?.vault_balance ?? marketInfo?.c_tot;
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? BigInt(Math.round(n)) : null;
  })();
  const marketLpAtoms = vaultAtoms ?? marketLpFromApi;
  const vaultDisplay = marketLpAtoms != null ? fmtOI(marketLpAtoms) : "—";
  const vaultFullDisplay = marketLpAtoms != null ? fmtOIFull(marketLpAtoms) : "—";
  const oiLongDisplay = oiLongAtoms != null ? fmtOI(oiLongAtoms) : "—";
  const oiLongFullDisplay = oiLongAtoms != null ? fmtOIFull(oiLongAtoms) : "—";
  const oiShortDisplay = oiShortAtoms != null ? fmtOI(oiShortAtoms) : "—";
  const oiShortFullDisplay = oiShortAtoms != null ? fmtOIFull(oiShortAtoms) : "—";

  // Spread display: "+$0.06 (+0.03%)" or "—" for pyth-pinned / unavailable
  const showSpread = oracleMode !== "pyth-pinned" && markPriceE6 !== null && indexPriceE6 !== null;
  const spreadAbs = showSpread && markPriceE6 !== null && indexPriceE6 !== null
    ? markPriceE6 - indexPriceE6
    : null;
  const spreadDisplayValue = (() => {
    if (!showSpread || spreadAbs === null || spreadBps === null) return "—";
    const absSpread = spreadAbs < 0n ? -spreadAbs : spreadAbs;
    const sign = spreadAbs >= 0n ? "+" : "−";
    const dollarPart = formatUsd(absSpread).replace("$", `${sign}$`);
    const pctPart = `${sign}${Math.abs(spreadBps / 100).toFixed(2)}%`;
    return `${dollarPart} (${pctPart})`;
  })();
  // Color spread amber if abs spread > 0.5% (50 bps)
  const spreadColor = (() => {
    if (!showSpread || spreadBps === null) return "text-[var(--text-secondary)]";
    const absBps = Math.abs(spreadBps);
    if (absBps > 50) return "text-amber-400";
    if (spreadAbs !== null && spreadAbs > 0n) return "text-[var(--long)]";
    if (spreadAbs !== null && spreadAbs < 0n) return "text-[var(--short)]";
    return "text-[var(--text-secondary)]";
  })();

  // Funding rate display: "+0.0081%/8h" — consistent with MarketInfoBar label
  const fundingDisplay = fundingHourlyPct !== null
    ? `${fundingHourlyPct >= 0 ? "+" : ""}${fundingHourlyPct.toFixed(4)}%/8h`
    : "—";
  const fundingColor = fundingHourlyPct === null
    ? "text-[var(--text-secondary)]"
    : fundingHourlyPct > 0
      ? "text-[var(--short)]" // longs pay shorts → short favorable
      : fundingHourlyPct < 0
        ? "text-[var(--long)]" // shorts pay longs → long favorable
        : "text-[var(--text-secondary)]";

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
      value: markPriceE6 !== null ? formatUsdPriceE6(markPriceE6) : formatUsdPriceE6(livePriceE6 ?? (mktConfig ? resolveMarketPriceE6(mktConfig) : 0n)),
      tooltip: "EMA mark price used for liquidations and PnL",
    },
    {
      label: "Index",
      value: indexPriceE6 !== null ? formatUsdPriceE6(indexPriceE6) : "—",
      tooltip: "On-chain oracle index price",
    },
    {
      label: "Spread",
      // Bug #851: full spread value in tooltip since display cell truncates long values
      value: spreadDisplayValue,
      tooltip: spreadDisplayValue !== "—" ? `${spreadDisplayValue} — Mark–Index spread. Amber if >0.5%.` : "Mark – Index spread. Amber if >0.5%.",
      valueClass: spreadColor,
    },
    // Row 2 — Market health
    { label: "Open Interest", value: oiDisplay, tooltip: oiFullDisplay },
    { label: "OI Long", value: oiLongDisplay, tooltip: oiLongFullDisplay, valueClass: oiLongAtoms != null ? "text-[var(--long)]" : undefined },
    { label: "OI Short", value: oiShortDisplay, tooltip: oiShortFullDisplay, valueClass: oiShortAtoms != null ? "text-[var(--short)]" : undefined },
    { label: "Market LP", value: vaultDisplay, tooltip: vaultFullDisplay },
    {
      label: "Funding/8h",
      value: fundingDisplay,
      tooltip: "8-hour funding rate. Positive: longs pay shorts.",
      valueClass: fundingColor,
    },
    // Row 3 — Market parameters
    // Bug #845: on-chain tradingFeeBps / initialMarginBps are 0 for many devnet slabs (init bug).
    // Fall back to DB values (via useMarketInfo) when on-chain is 0 or out-of-range.
    {
      label: "Trading Fee",
      value: (() => {
        // v17: use wrapperConfigV17.tradeFeeBps; v12: params.tradingFeeBps
        const onChain = params
          ? sanitizeBps(params.tradingFeeBps, 5_000)
          : (isV17 && wrapperConfigV17 ? sanitizeBps(Number(wrapperConfigV17.tradeFeeBps), 5_000) : null);
        if (onChain != null && onChain > 0) return formatBps(onChain);
        // Fallback: use DB trading_fee_bps
        const dbFee = marketInfo?.trading_fee_bps;
        if (dbFee != null && dbFee > 0) return formatBps(dbFee);
        return "—";
      })(),
    },
    {
      label: "Init. Margin",
      value: (() => {
        const onChain = params ? sanitizeBps(params.initialMarginBps) : null;
        if (onChain != null && onChain > 0) return formatBps(onChain);
        // Fallback: derive from max_leverage (initialMarginBps = 10000 / max_leverage)
        const maxLev = marketInfo?.max_leverage;
        if (maxLev != null && maxLev > 0) {
          const impliedMarginBps = Math.round(10000 / maxLev);
          return formatBps(impliedMarginBps);
        }
        return "—";
      })(),
    },
    {
      label: "Accounts",
      // engine.numUsedAccounts is v12-only (legacy fixed-size accounts array;
      // always null on v17 — v17 portfolios are standalone accounts with no
      // used-count field in the SDK). `?? 0` here would render a literal "0"
      // for a v17 market that may have many open portfolios — mirrors the
      // vaultAtoms/vaultDisplay null-vs-zero distinction above: show "—" when
      // the field is genuinely unavailable rather than a misleading "0".
      value: engine
        ? sanitizeAccountCount(engine.numUsedAccounts, params ? Number(params.maxAccounts) : undefined).toString()
        : "—",
    },
  ];

  return (
    <div className="space-y-1.5">
      {/* P3-4: Market Stats Grid — 3×3, improved label/value hierarchy */}
      <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <div className="grid grid-cols-3 gap-x-4 gap-y-3">
          {stats.map((s) => (
            <div
              key={s.label}
              /* min-w-0 prevents the grid cell from overflowing its track (#864) */
              className="min-w-0 overflow-hidden"
            >
              <p
                className="text-[10px] uppercase tracking-widest text-[var(--text)] font-medium leading-tight mb-0.5"
                style={{ wordBreak: "break-word", overflowWrap: "anywhere" }}
                title={s.label}
              >
                {s.label}
              </p>
              <p
                className={`text-sm font-mono truncate ${s.valueClass ?? "text-[var(--text)]"}`}
                title={s.tooltip ?? s.value}
                style={{ fontVariantNumeric: "tabular-nums" }}
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
              className="flex w-full items-center justify-between px-2 py-1 text-left text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)] transition-colors hover:text-[var(--text)]"
            >
              <span>Funding History</span>
              <span className={`text-[9px] text-[var(--text-secondary)] transition-transform duration-200 ${showFundingChart ? "rotate-180" : ""}`}>▾</span>
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
