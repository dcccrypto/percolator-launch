"use client";

import { FC, useEffect, useRef, useState } from "react";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useMarketInfo } from "@/hooks/useMarketInfo";
import { useEngineState } from "@/hooks/useEngineState";
import { useOracleFreshness } from "@/hooks/useOracleFreshness";
import { MarketLogo } from "@/components/market/MarketLogo";
import { formatUsdFromNumber, formatMarkPrice } from "@/lib/format";

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
    live:          { label: "LIVE",         icon: "●",  cls: "text-[var(--long)] bg-[var(--long)]/10 border-[var(--long)]/20",       pulse: false, tooltip: "Oracle healthy - market is live" },
    "no-oracle":   { label: "NO ORACLE",    icon: "◉",  cls: "text-[var(--warning)] bg-[var(--warning)]/10 border-[var(--warning)]/20", pulse: true,  tooltip: "Oracle not cranked - market paused. Trades are blocked." },
    "no-liquidity":{ label: "NO LIQUIDITY", icon: "⚠",  cls: "text-[var(--short)] bg-[var(--short)]/10 border-[var(--short)]/20",     pulse: false, tooltip: "No vault liquidity - trades cannot execute until this market is funded." },
    inactive:      { label: "INACTIVE",     icon: "⚠",  cls: "text-[var(--short)] bg-[var(--short)]/10 border-[var(--short)]/20",     pulse: false, tooltip: "Oracle unavailable and no vault liquidity." },
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

/**
 * Header mark price with a subtle up/down tick flash — the classic perp-DEX
 * micro-interaction. On each price change we compare the new priceE6 against
 * the previous one and briefly tint the text long-green (up) or short-red
 * (down), easing back to the neutral resting color over ~300ms. The resting
 * color is neutral so the semantic long/short flash reads clearly (the 24h
 * direction is carried by the change badge, not this number). No layout shift.
 */
function MarkPrice({ priceUsd, priceE6 }: { priceUsd: number | null; priceE6: bigint | null }) {
  const prevE6 = useRef<bigint | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (priceE6 == null) return;
    const prev = prevE6.current;
    if (prev != null && priceE6 !== prev) {
      setFlash(priceE6 > prev ? "up" : "down");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setFlash(null), 300);
    }
    prevE6.current = priceE6;
  }, [priceE6]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const flashColor =
    flash === "up" ? "text-[var(--long)]" : flash === "down" ? "text-[var(--short)]" : "text-[var(--text)]";

  return (
    <span
      className={`text-2xl font-bold tabular-nums shrink-0 transition-colors duration-300 ease-out ${flashColor}`}
      style={{ fontFamily: "var(--font-mono)" }}
    >
      {formatMarkPrice(priceUsd)}
    </span>
  );
}

export const MarketInfoBar: FC<MarketInfoBarProps> = ({ slabAddress, symbol, logoUrl, mintAddress }) => {
  const { priceUsd, priceE6, change24h, high24h, low24h } = useLivePrice();
  const { market } = useMarketInfo(slabAddress);
  const { fundingRate, engine, totalOI, insuranceBalance, hasData: engineHasData } = useEngineState();
  const { level: oracleLevel } = useOracleFreshness();

  const change24hDisplay = change24h ?? 0;
  const isUp = change24hDisplay >= 0;

  const funding8h = fundingRate != null ? fundingRateBpsTo8h(fundingRate) : null;
  const fundingColor = funding8h != null ? (funding8h < 0 ? "text-[var(--warning)]" : "text-[var(--long)]") : "text-[var(--text)]";

  // P3-3: oracle + vault status for health badge
  // oracleDown = unavailable (never cranked) or stale — oracleReady && unavailable is
  // always false (they're mutually exclusive), so check level directly.
  const oracleDown = oracleLevel === "unavailable" || oracleLevel === "stale";
  // vaultEmpty = engine loaded but vault is 0.
  // BUG 21 fix: `engine` is always null on v17 (legacy block; see useEngineState /
  // SlabProvider), so this check was dead there — a drained-vault v17 market always
  // badged green "LIVE". v17 has no vault-capital field in the parsed slab state at
  // all, so fall back to the group-level insurance reserve + total OI (both
  // v17-available via parseMarketGroupV17OI, exposed as
  // useEngineState().insuranceBalance/totalOI) as a conservative no-liquidity
  // signal: only flag "no liquidity" once real v17 data has loaded and both read
  // zero — a stale/loading read must not falsely show "LIVE" either.
  const vaultEmpty = engine !== null
    ? (engine.vault ?? 0n) === 0n
    : engineHasData && insuranceBalance != null && totalOI != null
      ? insuranceBalance === 0n && totalOI === 0n
      : false;

  const volume = market?.volume_24h as number | null | undefined;

  // Open interest: prefer the authoritative on-chain figure (bigint atoms, quote
  // units e6) from the engine/market-group — it's present locally even when the
  // indexer isn't, so we never show a misleading "$0" from a null indexer row.
  // Fall back to the indexer's total_open_interest (base-token atoms → USD via
  // price, GH#1626) only when on-chain OI is unavailable, then to a quiet "—".
  const rawOiAtoms = market?.total_open_interest as number | null | undefined;
  const decimals = (market?.decimals as number | null | undefined) ?? 6;
  const oi: number | null = (() => {
    // BUG 13 fix: this branch omitted `* priceUsd`, rendering raw base-token
    // quantity as if it were USD (e.g. "100 SOL OI" showed as "$100"). Mirror the
    // fallback branch below: scale to a token count, then convert to USD via the
    // live price when available.
    if (totalOI != null) {
      const tokenAmount = Number(totalOI) / 1_000_000;
      return priceUsd != null && priceUsd > 0 ? tokenAmount * priceUsd : tokenAmount;
    }
    if (rawOiAtoms == null) return null;
    const tokenAmount = rawOiAtoms / Math.pow(10, decimals);
    if (priceUsd != null && priceUsd > 0) return tokenAmount * priceUsd;
    return tokenAmount;
  })();

  return (
    <div
      data-testid="market-info-bar"
      className="sticky top-0 z-30 w-full border-b border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur-sm px-4 py-3 flex items-center gap-5 overflow-x-auto whitespace-nowrap scrollbar-none"
    >
      {/* Symbol + Logo */}
      <div className="flex items-center gap-2 shrink-0">
        <MarketLogo logoUrl={logoUrl} mintAddress={mintAddress} symbol={symbol} size="sm" />
        <span className="text-sm font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
          {symbol}/USD
          <span className="ml-1.5 text-[9px] font-normal uppercase tracking-[0.12em] text-[var(--text-dim)]">PERP</span>
        </span>
      </div>

      <span className="h-6 w-px bg-[var(--border)] shrink-0" />

      {/* Mark Price — large; flashes long/short on each tick (see MarkPrice) */}
      <MarkPrice priceUsd={priceUsd} priceE6={priceE6} />

      {/* 24h change badge — semantic long/short tokens, same as the rest of
          the terminal (was hardcoded Tailwind green/red before). */}
      <span
        className={`shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded-sm ${
          change24h == null
            ? "bg-[var(--border)]/30 text-[var(--text-dim)]"
            : isUp
              ? "bg-[var(--long)]/15 text-[var(--long)] border border-[var(--long)]/20"
              : "bg-[var(--short)]/15 text-[var(--short)] border border-[var(--short)]/20"
        }`}
      >
        {change24h == null ? "0.00%" : `${isUp ? "+" : ""}${change24hDisplay.toFixed(2)}%`}
      </span>

      <span className="h-6 w-px bg-[var(--border)] shrink-0" />

      {/* Stats group — flex-1 fills remaining space so ml-auto on badge works correctly */}
      <div className="flex flex-1 items-center gap-5 min-w-0">
        {/* Volume 24h */}
        <div className="flex flex-col shrink-0">
          <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-dim)]">Vol 24h</span>
          <span
            className={`text-xs font-medium ${volume == null ? "text-[var(--text-dim)]" : "text-[var(--text)]"}`}
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {volume == null ? "—" : formatCompact(volume as number)}
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
        <span className="ml-auto h-6 w-px bg-[var(--border)] shrink-0" />
        <MarketHealthBadge oracleDown={oracleDown} vaultEmpty={vaultEmpty} />
      </div>
    </div>
  );
};
