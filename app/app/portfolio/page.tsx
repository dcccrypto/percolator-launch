"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { usePortfolio, getLiquidationSeverity } from "@/hooks/usePortfolio";
import { formatTokenAmount, formatPriceE6 } from "@/lib/format";
import dynamic from "next/dynamic";
import { ScrollReveal } from "@/components/ui/ScrollReveal";
import { GlowButton } from "@/components/ui/GlowButton";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import { PublicKey } from "@solana/web3.js";
import { isMockMode } from "@/lib/mock-mode";
import { getMockPortfolioPositions } from "@/lib/mock-trade-data";

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

function formatPnlPct(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

export default function PortfolioPage() {
  useEffect(() => { document.title = "Portfolio — Percolator"; }, []);
  const { connected: walletConnected } = useWalletCompat();
  const mockMode = isMockMode();
  const connected = walletConnected || mockMode;
  const portfolio = usePortfolio();

  // In mock mode, use synthetic positions
  const mockPositions = mockMode && !walletConnected ? getMockPortfolioPositions() : null;
  const positions = mockPositions ?? portfolio.positions ?? [];
  const totalPnl = mockPositions ? mockPositions.reduce((s, p) => s + (p.account.pnl ?? 0n), 0n) : (portfolio.totalPnl ?? 0n);
  const totalDeposited = mockPositions ? mockPositions.reduce((s, p) => s + (p.account.capital ?? 0n), 0n) : (portfolio.totalDeposited ?? 0n);
  const totalValue = portfolio.totalValue ?? totalDeposited + totalPnl;
  const totalUnrealizedPnl = portfolio.totalUnrealizedPnl ?? 0n;
  const atRiskCount = portfolio.atRiskCount ?? 0;
  const loading = mockPositions ? false : portfolio.loading;
  const refresh = portfolio.refresh;

  // Auto-refresh every 15s
  useEffect(() => {
    if (!connected || !refresh) return;
    const interval = setInterval(() => {
      refresh();
    }, 15_000);
    return () => clearInterval(interval);
  }, [connected, refresh]);

  // Resolve collateral mint addresses to token symbols
  const collateralMints = positions.map((pos) => pos.market.config.collateralMint);
  const tokenMetaMap = useMultiTokenMeta(collateralMints);
  const tokenMetasLoading = collateralMints.length > 0 && tokenMetaMap.size === 0;

  if (!connected) {
    return (
      <div className="min-h-[calc(100vh-48px)] relative">
        <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
          <div className="relative mx-auto max-w-4xl px-4 py-10">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
            // portfolio
          </div>
          <h1 className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
            <span className="font-normal text-white/50">Your </span>Positions
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
    <div className="min-h-[calc(100vh-48px)] relative">
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
              <h1 className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
                <span className="font-normal text-white/50">Your </span>Positions
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
                onClick={() => refresh()}
                disabled={loading}
                className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-2 text-xs text-[var(--text-secondary)] transition-all hover:border-[var(--accent)]/40 hover:text-[var(--text)] disabled:opacity-40"
              >
                {loading ? "Refreshing..." : "Refresh"}
              </button>
            )}
          </div>
        </ScrollReveal>

        {/* Summary stats */}
        <ScrollReveal stagger={0.08}>
          <div className="mb-8 grid grid-cols-2 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)] sm:grid-cols-4">
            {[
              {
                label: "Portfolio Value",
                value: loading ? "\u2026" : formatTokenAmount(totalValue),
                color: "text-white",
              },
              {
                label: "Total Deposited",
                value: loading ? "\u2026" : formatTokenAmount(totalDeposited),
                color: "text-[var(--text-secondary)]",
              },
              {
                label: "Unrealized PnL",
                value: loading ? "\u2026" : formatPnl(totalUnrealizedPnl),
                color: totalUnrealizedPnl >= 0n ? "text-[var(--long)]" : "text-[var(--short)]",
                sub: loading ? undefined : `${totalDeposited > 0n ? formatPnlPct(Number((totalUnrealizedPnl * 10000n) / (totalDeposited || 1n)) / 100) : "0.00%"}`,
              },
              {
                label: "Positions",
                value: loading ? "\u2026" : positions.length.toString(),
                color: "text-white",
                sub: atRiskCount > 0 ? `${atRiskCount} at risk` : undefined,
                subColor: atRiskCount > 0 ? "text-[var(--short)]" : undefined,
              },
            ].map((stat) => (
              <div key={stat.label} className="bg-[var(--panel-bg)] p-5 transition-colors duration-200 hover:bg-[var(--bg-elevated)]">
                <p className="mb-2 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]">{stat.label}</p>
                <p className={`text-xl font-bold ${stat.color}`} style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
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
          {loading || tokenMetasLoading ? (
            <div className="space-y-px">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-14 animate-pulse bg-[var(--panel-bg)] border border-[var(--border)]" />
              ))}
            </div>
          ) : positions.length === 0 ? (
            <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-10 text-center">
              <h3 className="mb-1 text-[15px] font-semibold text-white">No positions yet</h3>
              <p className="mb-4 text-[13px] text-[var(--text-secondary)]">Browse markets to start trading.</p>
              <Link href="/markets">
                <GlowButton>Browse Markets</GlowButton>
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {positions.map((pos, i) => {
                const posSize = pos.account?.positionSize ?? 0n;
                const posCapital = pos.account?.capital ?? 0n;
                const posEntry = pos.account?.entryPrice ?? 0n;
                const side = posSize > 0n ? "Long" : posSize < 0n ? "Short" : "Flat";
                const sizeAbs = posSize < 0n ? -posSize : posSize;
                // Handle both enriched PortfolioPosition and raw mock positions
                const unrealizedPnl: bigint = "unrealizedPnl" in pos ? (pos as any).unrealizedPnl : (pos.account?.pnl ?? 0n);
                const pnlPercent: number = "pnlPercent" in pos ? (pos as any).pnlPercent : 0;
                const oraclePriceE6: bigint = "oraclePriceE6" in pos ? (pos as any).oraclePriceE6 : 0n;
                const liquidationPriceE6: bigint = "liquidationPriceE6" in pos ? (pos as any).liquidationPriceE6 : 0n;
                const liquidationDistancePct: number = "liquidationDistancePct" in pos ? (pos as any).liquidationDistancePct : 100;
                const leverage: number = "leverage" in pos ? (pos as any).leverage : 0;
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
                          <span className="text-sm font-semibold text-white" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
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
                            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                          >
                            {formatPnl(unrealizedPnl)}
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
                          <p className="text-[12px] text-white" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                            {formatTokenAmount(sizeAbs)}
                          </p>
                        </div>
                        <div>
                          <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">Entry</p>
                          <p className="text-[12px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                            {formatPriceE6(posEntry)}
                          </p>
                        </div>
                        <div>
                          <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">Mark Price</p>
                          <p className="text-[12px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                            {oraclePriceE6 > 0n ? formatPriceE6(oraclePriceE6) : "—"}
                          </p>
                        </div>
                        <div>
                          <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">Capital</p>
                          <p className="text-[12px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                            {formatTokenAmount(posCapital)}
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
                              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
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

        {/* Position history placeholder */}
        {positions.length > 0 && (
          <ScrollReveal delay={0.3}>
            <div className="mt-8">
              <h2 className="mb-3 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
                // trade history
              </h2>
              <div className="border border-dashed border-[var(--border)] bg-[var(--panel-bg)]/50 p-8 text-center">
                <p className="text-[13px] text-[var(--text-dim)]">
                  Position history and closed trades coming soon
                </p>
                <p className="mt-1 text-[10px] text-[var(--text-dim)]/60">
                  Requires indexer integration for historical trade data
                </p>
              </div>
            </div>
          </ScrollReveal>
        )}
      </div>
    </div>
  );
}
