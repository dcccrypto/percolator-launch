"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { formatTokenAmount, formatPriceE6 } from "@/lib/format";
import dynamic from "next/dynamic";
import { ScrollReveal } from "@/components/ui/ScrollReveal";
import { GlowButton } from "@/components/ui/GlowButton";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import { PublicKey } from "@solana/web3.js";
import { isMockMode } from "@/lib/mock-mode";
import { getMockPortfolioPositions } from "@/lib/mock-trade-data";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

function formatPnl(pnl: bigint | undefined | null, decimals = 6): string {
  // P-HIGH-1: Add null coalescing for pnl
  const safePnl = pnl ?? 0n;
  const isNeg = safePnl < 0n;
  const abs = isNeg ? -safePnl : safePnl;
  return `${isNeg ? "-" : "+"}${formatTokenAmount(abs, decimals)}`;
}

export default function PortfolioPage() {
  useEffect(() => { document.title = "Portfolio — Percolator"; }, []);
  const { connected: walletConnected } = useWallet();
  const mockMode = isMockMode();
  const connected = walletConnected || mockMode;
  const portfolio = usePortfolio();

  // In mock mode, use synthetic positions
  const mockPositions = mockMode && !walletConnected ? getMockPortfolioPositions() : null;
  const positions = mockPositions ?? portfolio.positions;
  const totalPnl = mockPositions ? mockPositions.reduce((s, p) => s + p.account.pnl, 0n) : portfolio.totalPnl;
  const totalDeposited = mockPositions ? mockPositions.reduce((s, p) => s + p.account.capital, 0n) : portfolio.totalDeposited;
  const loading = mockPositions ? false : portfolio.loading;
  const refresh = portfolio.refresh;

  // P-HIGH-2: Add auto-refresh every 15s
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
  
  // P-HIGH-3: Check if token metas are still loading
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
            <WalletMultiButton />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-48px)] relative">
      {/* Grid background */}
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />

      <div className="relative mx-auto max-w-4xl px-4 py-10">
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
              <p className="mt-2 text-[13px] text-[var(--text-secondary)]">All positions across Percolator markets</p>
            </div>
            {/* P-HIGH-2: Add refresh button */}
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
          <div className="mb-8 grid grid-cols-3 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)]">
            {[
              { label: "Total Deposited", value: loading ? "\u2026" : formatTokenAmount(totalDeposited), color: "text-white" },
              { label: "Total PnL", value: loading ? "\u2026" : formatPnl(totalPnl), color: totalPnl >= 0n ? "text-[var(--long)]" : "text-[var(--short)]" },
              { label: "Active Positions", value: loading ? "\u2026" : positions.length.toString(), color: "text-white" },
            ].map((stat) => (
              <div key={stat.label} className="bg-[var(--panel-bg)] p-5 transition-colors duration-200 hover:bg-[var(--bg-elevated)]">
                <p className="mb-2 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]">{stat.label}</p>
                <p className={`text-xl font-bold ${stat.color}`} style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                  {stat.value}
                </p>
              </div>
            ))}
          </div>
        </ScrollReveal>

        {/* Positions */}
        <ScrollReveal delay={0.2}>
          {/* P-HIGH-3: Show skeleton while loading OR while token metas are loading */}
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
            <div className="overflow-x-auto border border-[var(--border)] hud-corners">
              {/* Header */}
              <div className="grid min-w-[600px] grid-cols-[2fr_0.7fr_1fr_1fr_1fr_1fr] gap-3 border-b border-[var(--border)] bg-[var(--bg-surface)] px-4 py-2.5 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">
                <div>Market</div>
                <div className="text-center">Side</div>
                <div className="text-right">Size</div>
                <div className="text-right">Entry</div>
                <div className="text-right">Capital</div>
                <div className="text-right">PnL</div>
              </div>

              {positions.map((pos, i) => {
                const side = pos.account.positionSize > 0n ? "Long" : pos.account.positionSize < 0n ? "Short" : "Flat";
                const sizeAbs = pos.account.positionSize < 0n ? -pos.account.positionSize : pos.account.positionSize;
                const pnlPositive = pos.account.pnl >= 0n;

                return (
                  <Link
                    key={`${pos.slabAddress}-${i}`}
                    href={`/trade/${pos.slabAddress}`}
                    className={[
                      "grid min-w-[600px] grid-cols-[2fr_0.7fr_1fr_1fr_1fr_1fr] gap-3 items-center px-4 py-3 transition-all duration-200 hover:bg-[var(--accent)]/[0.04] hover:border-l-2 hover:border-l-[var(--accent)]/30",
                      i > 0 ? "border-t border-[var(--border)]" : "",
                    ].join(" ")}
                  >
                    <div>
                      <span className="text-sm font-semibold text-white" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                        {tokenMetaMap.get(pos.market.config.collateralMint.toBase58())?.symbol ?? pos.slabAddress.slice(0, 8) + "\u2026"}/USD
                      </span>
                      <span className="block text-[10px] text-[var(--text-dim)]">{pos.slabAddress.slice(0, 8)}&hellip;</span>
                    </div>
                    <div className="text-center">
                      <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${
                        side === "Long"
                          ? "bg-[var(--long)]/10 text-[var(--long)]"
                          : side === "Short"
                          ? "bg-[var(--short)]/10 text-[var(--short)]"
                          : "bg-[var(--bg-elevated)] text-[var(--text-secondary)]"
                      }`}>
                        {side.toUpperCase()}
                      </span>
                    </div>
                    <div className="text-right text-sm text-white truncate" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>{formatTokenAmount(sizeAbs)}</div>
                    <div className="text-right text-sm text-[var(--text-secondary)] truncate" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>{formatPriceE6(pos.account.entryPrice)}</div>
                    <div className="text-right text-sm text-[var(--text-secondary)] truncate" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>{formatTokenAmount(pos.account.capital)}</div>
                    <div className={`text-right text-sm font-medium truncate ${pnlPositive ? "text-[var(--long)]" : "text-[var(--short)]"}`} style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                      {formatPnl(pos.account.pnl)}
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </ScrollReveal>
      </div>
    </div>
  );
}
