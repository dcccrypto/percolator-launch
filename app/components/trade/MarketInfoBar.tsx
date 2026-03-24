"use client";

import { FC } from "react";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useMarketInfo } from "@/hooks/useMarketInfo";
import { useEngineState } from "@/hooks/useEngineState";

interface MarketInfoBarProps {
  slabAddress: string;
  symbol: string;
  // logoUrl accepted but not rendered in bar (used by parent for MarketLogo)
  logoUrl?: string | null;
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
 * 8h rate% = (rateBps * 9000 * 8) / 10000 / 100
 */
function fundingRateBpsTo8h(rateBps: bigint): number {
  return ((Number(rateBps) * 9000 * 8) / 10000) / 100;
}

export const MarketInfoBar: FC<MarketInfoBarProps> = ({ slabAddress, symbol }) => {
  const { priceUsd, change24h } = useLivePrice();
  const { market } = useMarketInfo(slabAddress);
  const { fundingRate } = useEngineState();

  const priceDisplay = priceUsd != null
    ? `$${priceUsd < 0.01 ? priceUsd.toFixed(6) : priceUsd < 1 ? priceUsd.toFixed(4) : priceUsd.toFixed(2)}`
    : "—";

  // Always show badge — display "0.00%" when no change data is available (devnet null/0)
  const has24hChange = true;
  const change24hDisplay = change24h ?? 0;
  const isUp = change24hDisplay >= 0;

  // Phase 2: use 8h rate to match UI label (was hourly, label said /8h — now consistent)
  const funding8h = fundingRate != null ? fundingRateBpsTo8h(fundingRate) : null;
  const fundingColor = funding8h != null ? (funding8h < 0 ? "text-orange-400" : "text-green-400") : "text-[var(--text)]";

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
      className="bg-[var(--bg)]/95 border-b border-[var(--border)]/50 px-4 py-2 flex items-center gap-4 overflow-x-auto whitespace-nowrap backdrop-blur-sm"
    >
      {/* Symbol */}
      <span className="text-sm font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
        {symbol}/USD
        <span className="ml-1.5 text-[9px] font-normal uppercase tracking-[0.12em] text-[var(--text-dim)]">PERP</span>
      </span>

      <span className="h-3.5 w-px bg-[var(--border)]/40 shrink-0" />

      {/* Mark Price — color based on 24h direction for immediate at-a-glance read */}
      <span
        className={`text-lg font-bold tabular-nums ${has24hChange ? (isUp ? "text-green-400" : "text-red-400") : "text-[var(--text)]"}`}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {priceDisplay}
      </span>

      {/* 24h change badge — always visible; shows "0.00%" when devnet price data returns null */}
      <span className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-sm ${change24h == null ? "bg-[var(--border)]/30 text-[var(--text-dim)]" : isUp ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
        {change24h == null ? "0.00%" : `${isUp ? "+" : ""}${change24hDisplay.toFixed(2)}%`}
      </span>

      <span className="h-3.5 w-px bg-[var(--border)]/40 shrink-0" />

      {/* Volume 24h */}
      <span className="text-[10px] text-[var(--text-muted)]">
        Vol 24h: <span className="text-[var(--text)] font-medium">{formatCompact(volume as number)}</span>
      </span>

      {/* OI */}
      <span className="text-[10px] text-[var(--text-muted)]">
        OI: <span className="text-[var(--text)] font-medium">{formatCompact(oi as number)}</span>
      </span>

      {/* Phase 2: Funding rate — 8h rate in sub-header (designer note: surface it here like Hyperliquid) */}
      {funding8h != null && (
        <span className="text-[10px] text-[var(--text-muted)] shrink-0">
          Funding:{" "}
          <span className={`font-semibold ${fundingColor}`}>
            {funding8h >= 0 ? "+" : ""}{funding8h.toFixed(4)}%
          </span>
          <span className="text-[var(--text-dim)]"> / 8h</span>
        </span>
      )}
    </div>
  );
};
