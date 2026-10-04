"use client";

import Link from "next/link";
import { usePortfolio, liveLiquidationSeverity, liveLiquidationDistancePct, type PortfolioPosition } from "@/hooks/usePortfolio";
import { formatTokenAmount, formatUsdPriceE6 } from "@/lib/format";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import { describeLiqPrice } from "@/lib/liq-price-display";
import { describeEntryPrice, DERIVED_ENTRY_TOOLTIP, ESTIMATE_LABEL } from "@/lib/entry-price-display";
import { UNKNOWN_ENTRY_TOOLTIP } from "@/lib/trading";
import { useLivePortfolioMetrics, type LivePositionMetric } from "@/hooks/useLivePortfolioMetrics";
import { LiqPriceValue } from "@/components/trade/LiqPriceValue";
import { computePositionLeverage, describePositionLeverage, POSITION_LEVERAGE_LABEL } from "@/lib/position-leverage";

import { GlowButton } from "@/components/ui/GlowButton";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";


function formatPnl(pnl: bigint | undefined | null, decimals = 6): string {
  const safePnl = pnl ?? 0n;
  const isNeg = safePnl < 0n;
  const abs = isNeg ? -safePnl : safePnl;
  return `${isNeg ? "-" : "+"}${formatTokenAmount(abs, decimals)}`;
}

function formatPnlPct(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function PositionCard({
  pos,
  live,
  symbol,
  decimals = 6,
}: {
  pos: PortfolioPosition;
  live: LivePositionMetric;
  symbol: string;
  decimals?: number;
}) {
  // Exposure actually carried (ADL-adjusted); equals nominal basis on
  // markets that never deleveraged. See lib/v17-adl.ts.
  const posSize = pos.effectiveSize;
  const side = posSize > 0n ? "Long" : posSize < 0n ? "Short" : "Flat";
  const sizeAbs = posSize < 0n ? -posSize : posSize;
  const markE6 = live.markE6;
  // At the live mark, like /portfolio's cards and strip (the poll's figure lagged them).
  const liquidationDistancePct = liveLiquidationDistancePct(pos, markE6);
  const severity = liveLiquidationSeverity(pos, markE6);
  // Current effective leverage: nominal notional / (capital + pnl) at the live mark.
  const leverageDisplay = describePositionLeverage(
    computePositionLeverage({
      sizeQ: pos.account?.positionSize ?? 0n,
      // Same live mark as the Mark / PnL / ROE cells below (and as the
      // portfolio page's card), not the slower portfolio scan snapshot.
      markPriceE6: markE6 > 0n ? markE6 : null,
      capital: pos.account?.capital,
      pnl: pos.account?.pnl,
      collateralDecimals: decimals,
    }),
  );
  const hasPosition = posSize !== 0n;

  // #2660/#2671: keep the Entry cell's trust verdict aligned with the shared
  // live metric. Unknown entry still renders "--", never fake zero PnL.
  const entryDisplay = describeEntryPrice({
    entryE6: pos.effectiveEntryPrice,
    source: pos.entryPriceSource,
  });
  const hasValidOracle = markE6 > 0n;
  const pnlIsKnown = live.pnlKnown;

  // Cross-margin: where collateral covers the position there is no liquidation
  // price, and a bare "—" says nothing about risk. Show margin health instead
  // (#2634 / #2558) — one shared derivation, see lib/liq-price-display.ts.
  const liqDisplay = describeLiqPrice({
    liqPriceE6: pos.liquidationPriceE6,
    positionSize: pos.account?.positionSize ?? 0n,
    capital: pos.account?.capital ?? 0n,
    markPriceE6: pos.oraclePriceE6,
    maintenanceMarginBps: pos.maintenanceMarginBps,
    // Same verdict as the Entry cell, so the two cannot contradict (#2671).
    hasResolvedEntry: entryDisplay.known,
    formatPrice: formatUsdPriceE6,
    unknownText: "—",
  });

  return (
    <Link
      href={`/trade/${pos.slabAddress}`}
      className={[
        "block border bg-[var(--panel-bg)] transition-all duration-200 hover:bg-[var(--bg-elevated)]",
        severity === "danger" && hasPosition
          ? "border-[var(--short)]/40"
          : severity === "warning" && hasPosition
          ? "border-[var(--warning)]/30"
          : "border-[var(--border)] hover:border-[var(--accent)]/30",
      ].join(" ")}
    >
      {/* Liquidation warning */}
      {severity === "danger" && hasPosition && (
        <div className="flex items-center gap-2 border-b border-[var(--short)]/20 bg-[var(--short)]/5 px-3 py-1">
          <span className="text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--short)]">
            ⚠ Liq Risk — {liquidationDistancePct.toFixed(1)}% away
          </span>
        </div>
      )}

      <div className="p-3">
        {/* Row 1: Market, Side, PnL */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span
              className="text-[11px] font-semibold text-[var(--text)]"
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            >
              {symbol}
            </span>
            <span
              className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                side === "Long"
                  ? "bg-[var(--long)]/10 text-[var(--long)]"
                  : side === "Short"
                  ? "bg-[var(--short)]/10 text-[var(--short)]"
                  : "bg-[var(--bg-elevated)] text-[var(--text-secondary)]"
              }`}
            >
              {side.toUpperCase()}
            </span>
            {leverageDisplay.known && (
              <span className="text-[9px] font-bold text-[var(--warning)]" title={leverageDisplay.title}>
                {POSITION_LEVERAGE_LABEL} {leverageDisplay.text}
              </span>
            )}
          </div>
          <div className="text-right">
            {pnlIsKnown ? (
              <>
                <span
                  className={`text-[11px] font-bold ${live.pnl >= 0n ? "text-[var(--long)]" : "text-[var(--short)]"}`}
                  style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                >
                  {formatPnl(live.pnl, decimals)}
                </span>
                <span
                  className={`ml-1 text-[9px] ${live.pnlPercent >= 0 ? "text-[var(--long)]/70" : "text-[var(--short)]/70"}`}
                >
                  {formatPnlPct(live.pnlPercent)}
                </span>
                {live.isEstimate && (
                  <span className="ml-1 text-[9px] text-[var(--text-dim)]" title={DERIVED_ENTRY_TOOLTIP}>{ESTIMATE_LABEL}</span>
                )}
              </>
            ) : (
              <span
                className="text-[11px] font-bold text-[var(--text-secondary)]"
                style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                title={hasValidOracle ? UNKNOWN_ENTRY_TOOLTIP : undefined}
              >
                --
              </span>
            )}
          </div>
        </div>

        {/* Row 2: Key metrics */}
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
          <div>
            <span className="text-[var(--text-secondary)]">Size: </span>
            <span className="text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
              {formatTokenAmount(sizeAbs, decimals)}
            </span>
          </div>
          <div>
            <span className="text-[var(--text-secondary)]">Entry: </span>
            <span className="text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }} title={entryDisplay.title}>
              {entryDisplay.text}
            </span>
          </div>
          <div>
            <span className="text-[var(--text-secondary)]">Mark: </span>
            <span className="text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
              {markE6 > 0n ? formatUsdPriceE6(markE6) : "—"}
            </span>
          </div>
          <div>
            <span className="text-[var(--text-secondary)]">Liq: </span>
            <LiqPriceValue
              display={liqDisplay}
              className={`${
                severity === "danger" ? "font-semibold text-[var(--short)]" : severity === "warning" ? "text-[var(--warning)]" : "text-[var(--text-secondary)]"
              }`}
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            />
          </div>
        </div>

        {/* Margin health bar */}
        {hasPosition && liquidationDistancePct < 100 && (
          <div className="mt-2">
            <div className="flex items-center justify-between text-[8px] text-[var(--text-secondary)]">
              <span>Margin Health</span>
              <span
                className={
                  severity === "danger"
                    ? "font-bold text-[var(--short)]"
                    : severity === "warning"
                    ? "font-bold text-[var(--warning)]"
                    : "text-[var(--text-secondary)]"
                }
              >
                {liquidationDistancePct.toFixed(0)}%
              </span>
            </div>
            <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-[var(--border)]">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.min(liquidationDistancePct, 100)}%`,
                  backgroundColor:
                    severity === "danger"
                      ? "var(--short)"
                      : severity === "warning"
                      ? "var(--warning)"
                      : "var(--long)",
                }}
              />
            </div>
          </div>
        )}
      </div>
    </Link>
  );
}

export function PositionSummary() {
  const { connected } = useWalletCompat();
  const portfolio = usePortfolio();

  const loading = portfolio.loading;

  // Only OPEN positions (the hook drops closed size-0 "Flat" rows that still
  // have a portfolio account), each paired with its OWN live metric. One
  // entry per portfolio — two portfolios on the same market stay two cards
  // with their own PnL, never one entry looked up by slab.
  const liveMetrics = useLivePortfolioMetrics(
    (portfolio.positions ?? []) as PortfolioPosition[],
    portfolio.totalDeposited ?? 0n,
  );
  const positions = liveMetrics.openPositions;

  // v17 markets return an empty `market.config` from the SDK (real value in
  // `market.configV17.collateralMint`) — use the pre-resolved `pos.collateralMint`
  // (set by usePortfolio) instead of `pos.market.config.collateralMint`, which is
  // undefined for v17 markets and crashes `.toBase58()` (this is the crash that
  // took down the whole dashboard shell — no error boundary here).
  const collateralMints = positions.map((pos) => pos.collateralMint);
  const tokenMetaMap = useMultiTokenMeta(collateralMints);

  return (
    <div className="flex h-full flex-col border border-[var(--border)] bg-[var(--panel-bg)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <div className="flex items-center gap-2">
          <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-secondary)]">
            Open Positions
          </p>
          <span className="text-[9px] font-bold text-[var(--text-secondary)]">
            ({portfolio.error ? "—" : positions.length})
          </span>
          {positions.length > 0 && (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--long)]" />
          )}
        </div>
      </div>

      {/* Position list */}
      <div className="flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <ShimmerSkeleton key={i} className="h-24" />
            ))}
          </div>
        ) : portfolio.error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <span className="text-2xl leading-none">⚠️</span>
            <div>
              <p className="text-[12px] font-semibold text-[var(--text-secondary)]">Couldn't load your positions</p>
              <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">Please try refreshing</p>
            </div>
            <button
              onClick={portfolio.refresh}
              className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-2 text-xs text-[var(--text-secondary)] transition-all hover:border-[var(--accent)]/40 hover:text-[var(--text)]"
            >
              Retry
            </button>
          </div>
        ) : positions.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center">
            <div className="mb-3 text-2xl opacity-30">📊</div>
            <p className="text-[13px] font-medium text-[var(--text-secondary)]">No open positions</p>
            <p className="mt-1 text-[11px] text-[var(--text-secondary)]">Start trading →</p>
            <Link href="/markets" className="mt-3">
              <GlowButton>Browse Markets</GlowButton>
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {liveMetrics.livePositions.slice(0, 8).map((live, i) => {
              const pos = live.position;
              return (
              <PositionCard
                key={`${pos.slabAddress}-${pos.idx}-${i}`}
                pos={pos}
                live={live}
                symbol={
                  // P1: label by the market's own symbol (e.g. "SOL-PERP"), not the
                  // collateral token — sim-USDC is the SAME collateral across every
                  // market (see PLAYGROUND.md), so the old collateralMint lookup
                  // rendered "USDC/USD" for every position regardless of market.
                  pos.symbol
                    ? `${pos.symbol}/USD`
                    : tokenMetaMap.get(pos.collateralMint.toBase58())?.symbol
                    ? `${tokenMetaMap.get(pos.collateralMint.toBase58())!.symbol}/USD`
                    : `${pos.slabAddress.slice(0, 6)}…/USD`
                }
                decimals={tokenMetaMap.get(pos.collateralMint.toBase58())?.decimals ?? 6}
              />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
