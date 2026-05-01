"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { usePortfolio, getLiquidationSeverity, type PortfolioPosition } from "@/hooks/usePortfolio";
import { useLpPositions } from "@/hooks/useLpPositions";
import { LpPositionsPanel } from "@/components/portfolio/LpPositionsPanel";
import { formatTokenAmount, formatPriceE6 } from "@/lib/format";
import dynamic from "next/dynamic";
import { ScrollReveal } from "@/components/ui/ScrollReveal";
import { GlowButton } from "@/components/ui/GlowButton";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import { PublicKey } from "@solana/web3.js";
import { isMockMode } from "@/lib/mock-mode";
import { getMockPortfolioPositions } from "@/lib/mock-trade-data";
import { TradeHistoryTable } from "@/components/trade/TradeHistoryTable";
import { TradeStatsPanel } from "@/components/trade/TradeStatsPanel";
import { useTraderStats } from "@/hooks/useTraderStats";

const ConnectButton = dynamic(
  () => import("@/components/wallet/ConnectButton").then((m) => m.ConnectButton),
  { ssr: false }
);

function formatPnl(pnl: bigint | undefined | null, decimals = 6): string {
  const safePnl = pnl ?? 0n;
  const isNeg = safePnl < 0n;
  const abs = isNeg ? -safePnl : safePnl;
  return `${isNeg ? "-" : "+"}${formatTokenAmount(abs, decimals)}`;
}

function formatPnlPct(pct: number | null | undefined): string {
  if (pct == null) return "0.00%";
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

export default function PortfolioPage() {
  useEffect(() => { document.title = "Portfolio — Percolator"; }, []);
  const { connected: walletConnected, publicKey: walletPublicKey } = useWalletCompat();
  const mockMode = isMockMode();
  const connected = walletConnected || mockMode;
  const portfolio = usePortfolio();

  // In mock mode, use synthetic positions
  const mockPositions = mockMode && !walletConnected ? getMockPortfolioPositions() : null;
  const positions: PortfolioPosition[] = mockPositions ?? portfolio.positions ?? [];
  const atRiskCount = portfolio.atRiskCount ?? 0;
  const loading = mockPositions ? false : portfolio.loading;
  const refresh = portfolio.refresh;

  // LP positions (insurance fund deposits)
  const lpPositions = useLpPositions();
  const isRefreshing = portfolio.isRefreshing || lpPositions.isRefreshing;

  // PERC-481: Aggregate trade statistics
  const traderStats = useTraderStats(walletPublicKey?.toBase58() ?? null);

  // Auto-refresh handled by usePortfolio hook (30s interval + visibility change)

  // Resolve collateral mint addresses to token symbols and decimals
  const collateralMints = positions.map((pos) => pos.market.config.collateralMint);
  const tokenMetaMap = useMultiTokenMeta(collateralMints);

  // Helper: get collateral decimals for a position from token metadata
  const getDecimals = (pos: typeof positions[number]) =>
    tokenMetaMap.get(pos.market.config.collateralMint.toBase58())?.decimals ?? 6;

  // Compute USD-normalized totals using each position's oracle price and correct decimals.
  // Raw on-chain capital is in collateral token native units (e.g. lamports for SOL, 9 dec).
  // Formula: usdValue = (rawCapital / 10^decimals) * (oraclePriceE6 / 10^6)
  //                    = (rawCapital * oraclePriceE6) / (10^decimals * 10^6)
  // Filter out empty/closed accounts (FLAT with zero capital) — they clutter the list
  const activePositions = positions.filter(
    (pos) => pos.account.positionSize !== 0n || pos.account.capital > 0n
  );

  // GH#1808: Only block on tokenMetas if positions are still loading too. If positions have
  // loaded (loading=false) but tokenMetas haven't resolved, the fetch likely failed silently —
  // unblock the UI instead of leaving it stuck in infinite skeleton state.
  const tokenMetasLoading = collateralMints.length > 0 && tokenMetaMap.size === 0 && loading;

  const computeUsdTotals = () => {
    let depositedUsd = 0;
    let unrealizedPnlUsd = 0;
    for (const pos of activePositions) {
      const decimals = getDecimals(pos);
      const divisor = 10 ** decimals;
      const oraclePrice = Number(pos.oraclePriceE6) / 1e6;
      // Skip positions with no oracle price — don't fallback to 1 which treats raw capital as USD
      const price = oraclePrice > 0 ? oraclePrice : 0;
      const capital = Number(pos.account.capital ?? 0n) / divisor;
      depositedUsd += capital * price;
      const unrealized = Number(pos.unrealizedPnl) / divisor;
      unrealizedPnlUsd += unrealized * price;
    }
    return { depositedUsd, unrealizedPnlUsd, valueUsd: depositedUsd + unrealizedPnlUsd };
  };
  // Don't compute USD totals until token metadata (decimals) has loaded —
  // using the default 6 decimals for a 9-decimal token inflates values 1000x
  const usdTotals = activePositions.length > 0 && !tokenMetasLoading
    ? computeUsdTotals()
    : { depositedUsd: 0, unrealizedPnlUsd: 0, valueUsd: 0 };

  if (!connected) {
    return (
      <div className="min-h-[calc(100dvh-48px)] relative">
        <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
          <div className="relative mx-auto max-w-4xl px-4 py-10">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
            // portfolio
          </div>
          <h1 className="text-xl font-medium tracking-[-0.01em] text-[var(--text)] sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
            <span className="font-normal text-[var(--text-muted)]">Your </span>Positions
          </h1>
          <p className="mt-2 mb-8 text-[13px] text-[var(--text-secondary)]">View all your positions across markets</p>
          <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-10 text-center">
            <p className="mb-4 text-[13px] text-[var(--text-secondary)]">Connect your wallet to view positions</p>
            <ConnectButton />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-48px)] relative">
      {/* Grid background */}
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />

      <div className="relative mx-auto max-w-5xl px-4 py-10">
        {/* Header */}
        <ScrollReveal>
          <div className="mb-8 flex items-start justify-between gap-4">
            <div>
              <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
                // portfolio
              </div>
              <h1 className="text-xl font-medium tracking-[-0.01em] text-[var(--text)] sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
                <span className="font-normal text-[var(--text-muted)]">Your </span>Positions
              </h1>
              <p className="mt-2 text-[13px] text-[var(--text-secondary)]">
                All positions across Percolator markets
                {atRiskCount > 0 && (
                  <span className="ml-2 inline-flex items-center gap-1 rounded-sm bg-[var(--short)]/10 px-2 py-0.5 text-[10px] font-bold text-[var(--short)]">
                    ⚠ {atRiskCount} at risk
                  </span>
                )}
              </p>
            </div>
            {refresh && (
              <button
                onClick={() => { refresh(); lpPositions.refresh(); }}
                disabled={loading || lpPositions.loading || isRefreshing}
                className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-2 text-xs text-[var(--text-secondary)] transition-all hover:border-[var(--accent)]/40 hover:text-[var(--text)] disabled:opacity-40"
              >
                Refresh
              </button>
            )}
          </div>
        </ScrollReveal>

        {/* Summary stats */}
        <ScrollReveal stagger={0.08}>
          <div className="mb-8 grid grid-cols-2 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)] sm:grid-cols-5">
            {/* #863: gate loading shimmer on walletConnected; show "—" (muted) when no wallet */}
            {[
              {
                label: "Portfolio Value",
                value: !walletConnected ? "—" : (loading || tokenMetasLoading) ? "\u2026" : `$${usdTotals.valueUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                color: !walletConnected ? "text-[var(--text-dim)]" : "text-[var(--text)]",
              },
              {
                label: "Total Deposited",
                value: !walletConnected ? "—" : (loading || tokenMetasLoading) ? "\u2026" : `$${usdTotals.depositedUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                color: !walletConnected ? "text-[var(--text-dim)]" : "text-[var(--text-secondary)]",
              },
              {
                label: "Unrealized PnL",
                value: !walletConnected ? "—" : (loading || tokenMetasLoading) ? "\u2026" : `${usdTotals.unrealizedPnlUsd >= 0 ? "+" : ""}$${Math.abs(usdTotals.unrealizedPnlUsd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                color: !walletConnected ? "text-[var(--text-dim)]" : usdTotals.unrealizedPnlUsd >= 0 ? "text-[var(--long)]" : "text-[var(--short)]",
                sub: !walletConnected || loading || tokenMetasLoading ? undefined : `${usdTotals.depositedUsd > 0 ? formatPnlPct((usdTotals.unrealizedPnlUsd / usdTotals.depositedUsd) * 100) : "0.00%"}`,
              },
              {
                label: "LP Value",
                value: !walletConnected ? "—" : lpPositions.loading ? "\u2026" : `$${lpPositions.totalRedeemable.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                color: !walletConnected ? "text-[var(--text-dim)]" : lpPositions.totalRedeemable > 0 ? "text-[var(--cyan)]" : "text-[var(--text-dim)]",
                sub: walletConnected && lpPositions.positions.length > 0
                  ? `${lpPositions.positions.length} pool${lpPositions.positions.length > 1 ? "s" : ""}`
                  : undefined,
              },
              {
                label: "Positions",
                value: !walletConnected ? "—" : loading ? "\u2026" : activePositions.length.toString(),
                color: !walletConnected ? "text-[var(--text-dim)]" : "text-[var(--text)]",
                sub: walletConnected && atRiskCount > 0 ? `${atRiskCount} at risk` : undefined,
                subColor: atRiskCount > 0 ? "text-[var(--short)]" : undefined,
              },
            ].map((stat, idx, arr) => (
              <div key={stat.label} className={`bg-[var(--panel-bg)] p-5 transition-colors duration-200 hover:bg-[var(--bg-elevated)]${idx === arr.length - 1 && arr.length % 2 !== 0 ? " col-span-2 sm:col-span-1" : ""}`}>
                <p className="mb-2 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]">{stat.label}</p>
                <p className={`text-xl font-bold tabular-nums ${stat.color}`} style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>
                  {stat.value}
                </p>
                {stat.sub && (
                  <p className={`mt-0.5 text-[10px] font-medium ${stat.subColor ?? stat.color}`}>
                    {stat.sub}
                  </p>
                )}
              </div>
            ))}
          </div>
        </ScrollReveal>

        {/* Positions */}
        <ScrollReveal delay={0.2}>
          {/* #863: only show shimmer when wallet is actually connected (prevents infinite skeleton when unauthenticated) */}
          {(loading || tokenMetasLoading) && walletConnected ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="border border-[var(--border)] bg-[var(--panel-bg)] p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <ShimmerSkeleton className="h-5 w-28" />
                      <ShimmerSkeleton className="h-5 w-14 rounded" />
                      <ShimmerSkeleton className="h-5 w-10 rounded" />
                    </div>
                    <div className="text-right flex items-center gap-2">
                      <ShimmerSkeleton className="h-5 w-20" />
                      <ShimmerSkeleton className="h-4 w-14" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-5">
                    {[1, 2, 3, 4, 5].map((j) => (
                      <div key={j}>
                        <ShimmerSkeleton className="h-3 w-12 mb-1.5" />
                        <ShimmerSkeleton className="h-4 w-16" />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : activePositions.length === 0 ? (
            <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-10 text-center">
              <h3 className="mb-1 text-[15px] font-semibold text-[var(--text)]">No positions yet</h3>
              <p className="mb-4 text-[13px] text-[var(--text-secondary)]">Browse markets to start trading.</p>
              <Link href="/markets">
                <GlowButton>Browse Markets</GlowButton>
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {activePositions.map((pos, i) => {
                const posSize = pos.account?.positionSize ?? 0n;
                const posCapital = pos.account?.capital ?? 0n;
                const posEntry = pos.effectiveEntryPrice;
                const side = posSize > 0n ? "Long" : posSize < 0n ? "Short" : "Flat";
                const sizeAbs = posSize < 0n ? -posSize : posSize;
                const { unrealizedPnl, pnlPercent, oraclePriceE6, liquidationPriceE6, liquidationDistancePct, leverage } = pos;
                const pnlPositive = unrealizedPnl >= 0n;
                const severity = getLiquidationSeverity(liquidationDistancePct);
                const hasPosition = posSize !== 0n;

                return (
                  <Link
                    key={`${pos.slabAddress}-${i}`}
                    href={`/trade/${pos.slabAddress}`}
                    className={[
                      "block border bg-[var(--panel-bg)] transition-all duration-200 hover:bg-[var(--bg-elevated)]",
                      severity === "danger" && hasPosition
                        ? "border-[var(--short)]/40 hover:border-[var(--short)]/60"
                        : severity === "warning" && hasPosition
                        ? "border-[var(--warning)]/30 hover:border-[var(--warning)]/50"
                        : "border-[var(--border)] hover:border-[var(--accent)]/30",
                    ].join(" ")}
                  >
                    {/* Liquidation warning banner */}
                    {severity === "danger" && hasPosition && (
                      <div className="flex items-center gap-2 border-b border-[var(--short)]/20 bg-[var(--short)]/5 px-4 py-1.5">
                        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--short)]">
                          ⚠ Liquidation Risk — {liquidationDistancePct.toFixed(1)}% away
                        </span>
                      </div>
                    )}
                    {severity === "warning" && hasPosition && (
                      <div className="flex items-center gap-2 border-b border-[var(--warning)]/20 bg-[var(--warning)]/5 px-4 py-1.5">
                        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--warning)]">
                          ⚡ Approaching Liquidation — {liquidationDistancePct.toFixed(1)}% away
                        </span>
                      </div>
                    )}

                    <div className="p-4">
                      {/* Row 1: Market name, side, PnL */}
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-semibold text-[var(--text)]" style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>
                            {tokenMetaMap.get(pos.market.config.collateralMint.toBase58())?.symbol ?? pos.slabAddress.slice(0, 8) + "\u2026"}/USD
                          </span>
                          <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${
                            side === "Long"
                              ? "bg-[var(--long)]/10 text-[var(--long)]"
                              : side === "Short"
                              ? "bg-[var(--short)]/10 text-[var(--short)]"
                              : "bg-[var(--bg-elevated)] text-[var(--text-secondary)]"
                          }`}>
                            {side.toUpperCase()}
                          </span>
                          {leverage > 0 && (
                            <span className="rounded bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] font-bold text-[var(--accent)]">
                              {leverage.toFixed(1)}x
                            </span>
                          )}
                        </div>
                        <div className="text-right">
                          <span
                            className={`text-sm font-bold ${pnlPositive ? "text-[var(--long)]" : "text-[var(--short)]"}`}
                            style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}
                          >
                            {formatPnl(unrealizedPnl, getDecimals(pos))}
                          </span>
                          <span
                            className={`ml-2 text-[10px] font-medium ${pnlPositive ? "text-[var(--long)]/70" : "text-[var(--short)]/70"}`}
                          >
                            {formatPnlPct(pnlPercent)}
                          </span>
                        </div>
                      </div>

                      {/* Row 2: Details grid */}
                      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-5">
                        <div>
                          <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">Size</p>
                          <p className="text-[12px] text-[var(--text)]" style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>
                            {formatTokenAmount(sizeAbs, getDecimals(pos))}
                          </p>
                        </div>
                        <div>
                          <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">Entry</p>
                          <p className="text-[12px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>
                            {formatPriceE6(posEntry)}
                          </p>
                        </div>
                        <div>
                          <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">Mark Price</p>
                          <p className="text-[12px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>
                            {oraclePriceE6 > 0n ? formatPriceE6(oraclePriceE6) : "—"}
                          </p>
                        </div>
                        <div>
                          <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">Capital</p>
                          <p className="text-[12px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>
                            {formatTokenAmount(posCapital, getDecimals(pos))}
                          </p>
                        </div>
                        <div>
                          <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">Liq. Price</p>
                          <div className="flex items-center gap-1.5">
                            {/* Liquidation severity dot */}
                            {hasPosition && (
                              <span
                                className={`inline-block h-1.5 w-1.5 rounded-full ${
                                  severity === "danger"
                                    ? "bg-[var(--short)] shadow-[0_0_6px_var(--short)]"
                                    : severity === "warning"
                                    ? "bg-[var(--warning)] shadow-[0_0_6px_var(--warning)]"
                                    : "bg-[var(--long)]"
                                }`}
                              />
                            )}
                            <p
                              className={`text-[12px] ${
                                severity === "danger" && hasPosition
                                  ? "font-semibold text-[var(--short)]"
                                  : severity === "warning" && hasPosition
                                  ? "text-[var(--warning)]"
                                  : "text-[var(--text-secondary)]"
                              }`}
                              style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}
                            >
                              {hasPosition && liquidationPriceE6 > 0n
                                ? formatPriceE6(liquidationPriceE6)
                                : "—"}
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Liquidation distance bar */}
                      {hasPosition && liquidationDistancePct < 100 && (
                        <div className="mt-3">
                          <div className="flex items-center justify-between text-[9px] text-[var(--text-dim)]">
                            <span>Liquidation Distance</span>
                            <span className={
                              severity === "danger"
                                ? "font-bold text-[var(--short)]"
                                : severity === "warning"
                                ? "font-bold text-[var(--warning)]"
                                : "text-[var(--text-muted)]"
                            }>
                              {liquidationDistancePct.toFixed(1)}%
                            </span>
                          </div>
                          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--border)]">
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
              })}
            </div>
          )}
        </ScrollReveal>

        {/* LP positions */}
        <ScrollReveal delay={0.25}>
          <div className="mt-8">
            <LpPositionsPanel
              loading={lpPositions.loading}
              positions={lpPositions.positions}
              totalRedeemable={lpPositions.totalRedeemable}
              error={lpPositions.error}
              onRetry={lpPositions.refresh}
            />
          </div>
        </ScrollReveal>

        {/* Trade history + stats */}
        <ScrollReveal delay={0.3}>
          <div className="mt-8">
            <h2 className="mb-3 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
              // trade history
            </h2>
            {/* PERC-481: Aggregate stats banner */}
            {(traderStats.stats || traderStats.loading) && (
              <div className="mb-2">
                <TradeStatsPanel
                  stats={traderStats.stats}
                  loading={traderStats.loading}
                  error={traderStats.error}
                  onRetry={traderStats.refresh}
                />
              </div>
            )}
            <TradeHistoryTable
              wallet={walletPublicKey?.toBase58() ?? null}
              pageSize={20}
            />
          </div>
        </ScrollReveal>
      </div>
    </div>
  );
}
