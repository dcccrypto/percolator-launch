"use client";

import { FC, memo, useMemo } from "react";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useMarketInfo } from "@/hooks/useMarketInfo";
import { useEngineState } from "@/hooks/useEngineState";
import { useOracleFreshness } from "@/hooks/useOracleFreshness";
import { useSingleMarketHealth } from "@/hooks/useMarketHealth";
import { marketHeaderStatus, type HeaderStatus } from "@/lib/market-header-status";
import { useSlabState } from "@/components/providers/SlabProvider";
import { usePriceFlash } from "@/hooks/usePriceFlash";
import { MarketSwitcher } from "@/components/trade/MarketSwitcher";
import { WatchButton } from "@/components/market/WatchButton";
import { TokenCopyMenu } from "@/components/trade/TokenCopyMenu";
import { formatUsdFromNumber, formatMarkPrice } from "@/lib/format";
import { formatCompactUsd } from "@/lib/formatters";
import { rowVolumeUsd, Q_SCALE } from "@/lib/q-usd";
import { computeMarketSpread } from "@/lib/oraclePrice";

interface MarketInfoBarProps {
  slabAddress: string;
  symbol: string;
  logoUrl?: string | null;
  mintAddress?: string | null;
  /** Mainnet contract address — used to resolve a real DEX logo when logoUrl is unset. */
  mainnetCa?: string | null;
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
type HealthBadgeState = "live" | "no-oracle" | "no-liquidity" | "inactive" | "settled" | "close-only" | "paused" | "catching-up";

/**
 * The badge follows the status line rendered under this bar (MarketHeaderStatus, the same
 * marketHeaderStatus(row)): a settled, close-only, paused or catching-up market must not read
 * green "LIVE" above a line saying new positions are refused. A settled market says so first: it
 * is terminal, so "no oracle" or "no liquidity" would point at a fix that will never come. The
 * oracle/vault states then keep their place ahead of the other statuses.
 */
export function healthBadgeState(oracleDown: boolean, vaultEmpty: boolean, status: HeaderStatus | null): HealthBadgeState {
  if (status?.kind === "resolved") return "settled";
  if (oracleDown && vaultEmpty) return "inactive";
  if (vaultEmpty) return "no-liquidity";
  if (oracleDown) return "no-oracle";
  if (status?.kind === "adl-reduce-only") return "close-only";
  if (status?.kind === "engine-catching-up") return "catching-up";
  if (status) return "paused";
  return "live";
}

export const MarketHealthBadge = memo(function MarketHealthBadge({ oracleDown, vaultEmpty, status }: { oracleDown: boolean; vaultEmpty: boolean; status: HeaderStatus | null }) {
  const state = healthBadgeState(oracleDown, vaultEmpty, status);

  const cfg: Record<HealthBadgeState, { label: string; icon: string; cls: string; pulse: boolean; tooltip: string }> = {
    live:          { label: "LIVE",         icon: "●",  cls: "text-[var(--long)] bg-[var(--long)]/10 border-[var(--long)]/20",       pulse: false, tooltip: "Oracle healthy - market is live" },
    "no-oracle":   { label: "NO ORACLE",    icon: "◉",  cls: "text-[var(--warning)] bg-[var(--warning)]/10 border-[var(--warning)]/20", pulse: true,  tooltip: "Oracle not cranked - market paused. Trades are blocked." },
    "no-liquidity":{ label: "NO LIQUIDITY", icon: "⚠",  cls: "text-[var(--short)] bg-[var(--short)]/10 border-[var(--short)]/20",     pulse: false, tooltip: "No vault liquidity - trades cannot execute until this market is funded." },
    inactive:      { label: "INACTIVE",     icon: "⚠",  cls: "text-[var(--short)] bg-[var(--short)]/10 border-[var(--short)]/20",     pulse: false, tooltip: "Oracle unavailable and no vault liquidity." },
    settled:       { label: "SETTLED",      icon: "■",  cls: "text-[var(--text-secondary)] bg-[var(--bg-surface)] border-[var(--border)]", pulse: false, tooltip: status?.body ?? "" },
    "close-only":  { label: "CLOSE-ONLY",   icon: "◉",  cls: "text-[var(--warning)] bg-[var(--warning)]/10 border-[var(--warning)]/20", pulse: false, tooltip: status?.body ?? "" },
    paused:        { label: "PAUSED",       icon: "◉",  cls: "text-[var(--warning)] bg-[var(--warning)]/10 border-[var(--warning)]/20", pulse: false, tooltip: status?.body ?? "" },
    "catching-up": { label: "CATCHING UP",  icon: "◉",  cls: "text-[var(--warning)] bg-[var(--warning)]/10 border-[var(--warning)]/20", pulse: true,  tooltip: status?.body ?? "" },
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
});

/**
 * Header mark price with a subtle up/down tick flash — the classic perp-DEX
 * micro-interaction, easing back to the neutral resting color over ~300ms
 * via `usePriceFlash` (extracted here originally; now shared with
 * PositionsDock/MarketBookCard — see that hook for the single source of
 * truth). The resting color is neutral so the semantic long/short flash
 * reads clearly (the 24h direction is carried by the change badge, not this
 * number). No layout shift.
 */
function MarkPrice({ priceUsd, priceE6 }: { priceUsd: number | null; priceE6: bigint | null }) {
  const flash = usePriceFlash(priceE6);
  const flashColor =
    flash === "up" ? "text-[var(--long)]" : flash === "down" ? "text-[var(--short)]" : "text-[var(--text)]";

  return (
    <span
      data-testid="header-price"
      className={`text-base md:text-2xl font-bold tabular-nums shrink-0 whitespace-nowrap transition-colors duration-300 ease-out ${flashColor}`}
      style={{ fontFamily: "var(--font-mono)" }}
    >
      {formatMarkPrice(priceUsd)}
    </span>
  );
}

export const MarketInfoBar: FC<MarketInfoBarProps> = ({ slabAddress, symbol, logoUrl, mintAddress, mainnetCa }) => {
  const { priceUsd, priceE6, change24h, high24h, low24h } = useLivePrice();
  const { market } = useMarketInfo(slabAddress);
  const { fundingRate, engine, totalOI, insuranceBalance, hasData: engineHasData } = useEngineState();
  const { level: oracleLevel } = useOracleFreshness();
  const { config: mktConfig, wrapperConfigV17 } = useSlabState();

  const change24hDisplay = change24h ?? 0;
  const isUp = change24hDisplay >= 0;

  const funding8h = fundingRate != null ? fundingRateBpsTo8h(fundingRate) : null;
  // GH#funding-display: this used to invert the convention used everywhere
  // else in the terminal (FundingRateCard.tsx, MarketStatsCard.tsx) — positive
  // rate (longs pay shorts) was colored --long (green) here but --short (red)
  // there, and negative rate used --warning instead of --long. Positive =
  // longs pay shorts = short-favorable = --short; negative = long-favorable =
  // --long, matching MarketStatsCard's documented convention.
  const fundingColor =
    funding8h == null
      ? "text-[var(--text)]"
      : funding8h > 0
        ? "text-[var(--short)]" // longs pay shorts → short favorable
        : funding8h < 0
          ? "text-[var(--long)]" // shorts pay longs → long favorable
          : "text-[var(--text)]";

  // Mark/index spread — same math as MarketStatsCard (lib/oraclePrice.ts). Hidden for
  // pyth-pinned markets where mark === index by definition (no separate oracle to diverge).
  const { spreadBps, oracleMode: spreadOracleMode } = useMemo(
    () => computeMarketSpread(mktConfig, wrapperConfigV17?.oracleMode),
    [mktConfig, wrapperConfigV17],
  );
  const showSpread = spreadOracleMode !== null && spreadOracleMode !== "pyth-pinned" && spreadBps !== null;
  // Amber past 50bps — matches MarketStatsCard's "wide spread" threshold.
  const spreadColor = showSpread && Math.abs(spreadBps!) > 50 ? "text-[var(--warning)]" : "text-[var(--text)]";

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
  // Same row and same derivation as the MarketHeaderStatus line the trade page renders under this bar.
  const healthRow = useSingleMarketHealth(slabAddress);
  const headerStatus = useMemo(() => marketHeaderStatus(healthRow), [healthRow]);

  // volume_24h is the indexer's SUM(ABS(size)) in engine Q units (base-asset
  // amount, POS_SCALE 1e6) — NOT dollars. It used to be formatted as USD
  // directly (SOL read "$3.4M" for ~$397 of volume). Prefer the API's own
  // volume_24h_usd; otherwise convert here with the live price.
  const volume: number | null = rowVolumeUsd(
    market ? { ...(market as { volume_24h_usd?: number | null }), last_price: priceUsd } : null,
  );

  // Open interest: prefer the authoritative on-chain figure (bigint atoms, quote
  // units e6) from the engine/market-group — it's present locally even when the
  // indexer isn't, so we never show a misleading "$0" from a null indexer row.
  // Fall back to the indexer's total_open_interest (base-token atoms → USD via
  // price, GH#1626) only when on-chain OI is unavailable, then to a quiet "—".
  const rawOiAtoms = market?.total_open_interest as number | null | undefined;
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
    // Q units (1e6), not the mint's decimals — SOL (9dp) read 1000x low.
    const tokenAmount = rawOiAtoms / Q_SCALE;
    if (priceUsd != null && priceUsd > 0) return tokenAmount * priceUsd;
    return tokenAmount;
  })();

  return (
    <div
      data-testid="market-info-bar"
      className="sticky top-0 z-30 w-full border-b border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur-sm px-4 py-2 md:py-3 flex flex-col gap-1.5 md:flex-row md:items-center md:gap-5 md:overflow-x-auto whitespace-nowrap scrollbar-none"
    >
      {/* UX WP-10 (MB-2): on mobile two rows — row 1 "[logo] SOL  $89.55  +2.3%" (16 px mono,
          never truncated), row 2 the stat chips, scrolling on their own. One row from md up. */}
      <div data-testid="market-info-primary" className="flex min-w-0 items-center gap-3 md:shrink-0 md:gap-5">
      {/* Symbol + Logo — now a dropdown market switcher (top markets + search) */}
      <MarketSwitcher slabAddress={slabAddress} symbol={symbol} logoUrl={logoUrl} mintAddress={mintAddress} mainnetCa={mainnetCa} />

      {/* Watch this market: the star alone (hover says "Add <symbol> to your watchlist"), so the
          Copy address menu fits beside it. */}
      <span className="hidden md:inline-flex">
        <WatchButton slab={slabAddress} symbol={symbol} variant="icon" />
      </span>

      {/* Copy the slab address / CA / ticker, or search on X. Below md: the glyph alone. */}
      <TokenCopyMenu slabAddress={slabAddress} symbol={symbol} mainnetCa={mainnetCa} />

      <span className="hidden md:block h-6 w-px bg-[var(--border)] shrink-0" />

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

      </div>
      <span className="hidden md:block h-6 w-px bg-[var(--border)] shrink-0" />

      {/* Stats group — flex-1 fills remaining space so ml-auto on badge works correctly.
          Mobile: its own horizontally scrollable chip row. */}
      <div data-testid="market-info-stats" className="flex flex-1 items-center gap-5 min-w-0 overflow-x-auto scrollbar-none">
        {/* Volume 24h */}
        <div className="flex flex-col shrink-0">
          <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">Vol 24h</span>
          <span
            className={`text-xs font-medium ${volume == null ? "text-[var(--text-dim)]" : "text-[var(--text)]"}`}
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {volume == null ? "—" : formatCompactUsd(volume as number)}
          </span>
        </div>

        {/* OI */}
        <div className="flex flex-col shrink-0">
          <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">Open Interest</span>
          <span className="text-xs font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
            {formatCompactUsd(oi as number)}
          </span>
        </div>

        {/* 5.6: 24h High */}
        <div className="flex flex-col shrink-0">
          <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">24h High</span>
          <span className="text-xs font-medium text-[var(--long)]" style={{ fontFamily: "var(--font-mono)" }}>
            {formatUsdFromNumber(high24h)}
          </span>
        </div>

        {/* 5.6: 24h Low */}
        <div className="flex flex-col shrink-0">
          <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">24h Low</span>
          <span className="text-xs font-medium text-[var(--short)]" style={{ fontFamily: "var(--font-mono)" }}>
            {formatUsdFromNumber(low24h)}
          </span>
        </div>

        {/* Mark/Index spread — hidden for pyth-pinned markets (mark === index there) */}
        {showSpread && (
          <div className="flex flex-col shrink-0">
            <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">Spread</span>
            <span className={`text-xs font-medium ${spreadColor}`} style={{ fontFamily: "var(--font-mono)" }}>
              {spreadBps! >= 0 ? "+" : ""}{(spreadBps! / 100).toFixed(2)}%
            </span>
          </div>
        )}

        {/* Funding Rate — P3-6: pr-2 padding prevents right-edge clipping */}
        {funding8h != null && (
          <div className="flex flex-col shrink-0 pr-2">
            <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">Funding / 8h</span>
            <span className={`text-xs font-semibold ${fundingColor}`} style={{ fontFamily: "var(--font-mono)" }}>
              {funding8h >= 0 ? "+" : ""}{funding8h.toFixed(4)}%
            </span>
          </div>
        )}

        {/* P3-3: Market health badge — ml-auto pushes to far right within flex-1 group */}
        <span className="ml-auto h-6 w-px bg-[var(--border)] shrink-0" />
        <MarketHealthBadge oracleDown={oracleDown} vaultEmpty={vaultEmpty} status={headerStatus} />
      </div>
    </div>
  );
};
