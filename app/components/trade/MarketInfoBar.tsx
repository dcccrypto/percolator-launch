"use client";

import { FC } from "react";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useMarketInfo } from "@/hooks/useMarketInfo";
import { useEngineState } from "@/hooks/useEngineState";
import { useOracleFreshness } from "@/hooks/useOracleFreshness";
import { MarketLogo } from "@/components/market/MarketLogo";
import { formatUsdFromNumber } from "@/lib/format";

interface MarketInfoBarProps {
  slabAddress: string;
  symbol: string;
  logoUrl?: string | null;
  mintAddress?: string | null;
}

function formatCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/**
 * Phase 2: funding rate display — designer note says show funding / 8h.
 * fundingRateBps is per-slot bps. Solana ~9000 slots/hr → convert to 8-hour rate.
 * 8h rate% = (rateBpsPerSlot * slotsPerHr * 8) / 100
 * where slotsPerHr ≈ 9000 (400ms slots), /100 converts bps → percent.
 * Previously used /10000/100 (GH#1943: 10,000x underreport — fixed).
 */
function fundingRateBpsTo8h(rateBps: bigint): number {
  return (Number(rateBps) * 9000 * 8) / 100;
}

/** P3-3: Market health badge — surfaces oracle/liquidity status in the ticker bar */
type HealthBadgeState = "live" | "no-oracle" | "no-liquidity" | "inactive";

function MarketHealthBadge({ oracleDown, vaultEmpty }: { oracleDown: boolean; vaultEmpty: boolean }) {
  let state: HealthBadgeState;
  if (oracleDown && vaultEmpty) state = "inactive";
  else if (vaultEmpty) state = "no-liquidity";
  else if (oracleDown) state = "no-oracle";
  else state = "live";

  const cfg: Record<HealthBadgeState, { label: string; icon: string; cls: string; pulse: boolean; tooltip: string }> = {
    live:          { label: "LIVE",         icon: "●",  cls: "text-green-400 bg-green-500/10 border-green-500/20",  pulse: false, tooltip: "Oracle healthy — market is live" },
    "no-oracle":   { label: "NO ORACLE",    icon: "◉",  cls: "text-amber-400 bg-amber-500/10 border-amber-500/20",  pulse: true,  tooltip: "Oracle not cranked — market paused. Trades are blocked." },
    "no-liquidity":{ label: "NO LIQUIDITY", icon: "⚠",  cls: "text-red-400 bg-red-500/10 border-red-500/20",        pulse: false, tooltip: "No vault liquidity — trades cannot execute until this market is funded." },
    inactive:      { label: "INACTIVE",     icon: "⚠",  cls: "text-red-400 bg-red-500/10 border-red-500/20",        pulse: false, tooltip: "Oracle unavailable and no vault liquidity." },
  };

  const { label, icon, cls, pulse, tooltip } = cfg[state];

  return (
    <span
      title={tooltip}
      className={`shrink-0 inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border ${cls} ${pulse ? "animate-pulse" : ""}`}
    >
      <span>{icon}</span>
      <span>{label}</span>
    </span>
  );
}

export const MarketInfoBar: FC<MarketInfoBarProps> = ({ slabAddress, symbol, logoUrl, mintAddress }) => {
  const { priceUsd, change24h, high24h, low24h } = useLivePrice();
  const { market } = useMarketInfo(slabAddress);
  const { fundingRate, engine } = useEngineState();
  const { level: oracleLevel } = useOracleFreshness();

  const priceDisplay = formatUsdFromNumber(priceUsd);

  const change24hDisplay = change24h ?? 0;
  const isUp = change24hDisplay >= 0;

  const funding8h = fundingRate != null ? fundingRateBpsTo8h(fundingRate) : null;
  const fundingColor = funding8h != null ? (funding8h < 0 ? "text-orange-400" : "text-green-400") : "text-[var(--text)]";

  // P3-3: oracle + vault status for health badge
  // oracleDown = unavailable (never cranked) or stale — oracleReady && unavailable is
  // always false (they're mutually exclusive), so check level directly.
  const oracleDown = oracleLevel === "unavailable" || oracleLevel === "stale";
  // vaultEmpty = engine loaded but vault is 0
  const vaultEmpty = engine !== null && (engine.vault ?? 0n) === 0n;

  const volume = market?.volume_24h as number | null | undefined;

  // GH#1626: total_open_interest is raw on-chain atoms — convert to USD
  const rawOiAtoms = market?.total_open_interest as number | null | undefined;
  const decimals = (market?.decimals as number | null | undefined) ?? 6;
  const oi: number | null | undefined = (() => {
    if (rawOiAtoms == null) return null;
    const tokenAmount = rawOiAtoms / Math.pow(10, decimals);
    if (priceUsd != null && priceUsd > 0) return tokenAmount * priceUsd;
    return tokenAmount;
  })();

  return (
    <div
      data-testid="market-info-bar"
      className="sticky top-0 z-30 w-full border-b border-[var(--border)]/50 bg-[var(--bg)]/95 backdrop-blur-sm px-4 py-2.5 flex items-center gap-5 overflow-x-auto whitespace-nowrap scrollbar-none"
    >
      {/* Symbol + Logo */}
      <div className="flex items-center gap-2 shrink-0">
        <MarketLogo logoUrl={logoUrl} mintAddress={mintAddress} symbol={symbol} size="sm" />
        <span className="text-sm font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
          {symbol}/USD
          <span className="ml-1.5 text-[9px] font-normal uppercase tracking-[0.12em] text-[var(--text-dim)]">PERP</span>
        </span>
      </div>

      <span className="h-4 w-px bg-[var(--border)]/40 shrink-0" />

      {/* Mark Price — large, colored by direction */}
      <span
        className={`text-2xl font-bold tabular-nums shrink-0 ${isUp ? "text-green-400" : "text-red-400"}`}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {priceDisplay}
      </span>

      {/* 24h change badge */}
      <span
        className={`shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded ${
          change24h == null
            ? "bg-[var(--border)]/30 text-[var(--text-dim)]"
            : isUp
              ? "bg-green-500/15 text-green-400 border border-green-500/20"
              : "bg-red-500/15 text-red-400 border border-red-500/20"
        }`}
      >
        {change24h == null ? "0.00%" : `${isUp ? "+" : ""}${change24hDisplay.toFixed(2)}%`}
      </span>

      <span className="h-4 w-px bg-[var(--border)]/40 shrink-0" />

      {/* Stats group — flex-1 fills remaining space so ml-auto on badge works correctly */}
      <div className="flex flex-1 items-center gap-4 min-w-0">
        {/* Volume 24h */}
        <div className="flex flex-col shrink-0">
          <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-dim)]">Vol 24h</span>
          <span className="text-xs font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
            {formatCompact(volume as number)}
          </span>
        </div>

        {/* OI */}
        <div className="flex flex-col shrink-0">
          <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-dim)]">Open Interest</span>
          <span className="text-xs font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
            {formatCompact(oi as number)}
          </span>
        </div>

        {/* 5.6: 24h High */}
        <div className="flex flex-col shrink-0">
          <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-dim)]">24h High</span>
          <span className="text-xs font-medium text-[var(--long)]" style={{ fontFamily: "var(--font-mono)" }}>
            {formatUsdFromNumber(high24h)}
          </span>
        </div>

        {/* 5.6: 24h Low */}
        <div className="flex flex-col shrink-0">
          <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-dim)]">24h Low</span>
          <span className="text-xs font-medium text-[var(--short)]" style={{ fontFamily: "var(--font-mono)" }}>
            {formatUsdFromNumber(low24h)}
          </span>
        </div>

        {/* Funding Rate — P3-6: pr-2 padding prevents right-edge clipping */}
        {funding8h != null && (
          <div className="flex flex-col shrink-0 pr-2">
            <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-dim)]">Funding / 8h</span>
            <span className={`text-xs font-semibold ${fundingColor}`} style={{ fontFamily: "var(--font-mono)" }}>
              {funding8h >= 0 ? "+" : ""}{funding8h.toFixed(4)}%
            </span>
          </div>
        )}

        {/* P3-3: Market health badge — ml-auto pushes to far right within flex-1 group */}
        <span className="ml-auto h-4 w-px bg-[var(--border)]/40 shrink-0" />
        <MarketHealthBadge oracleDown={oracleDown} vaultEmpty={vaultEmpty} />
      </div>
    </div>
  );
};
