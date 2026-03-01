"use client";

import Link from "next/link";
import { usePortfolio, getLiquidationSeverity, type PortfolioPosition } from "@/hooks/usePortfolio";
import { formatTokenAmount, formatPriceE6 } from "@/lib/format";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import { isMockMode } from "@/lib/mock-mode";
import { getMockPortfolioPositions } from "@/lib/mock-trade-data";
import { GlowButton } from "@/components/ui/GlowButton";
import { useWalletCompat } from "@/hooks/useWalletCompat";

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

function PositionCard({ pos, symbol }: { pos: PortfolioPosition; symbol: string }) {
  const posSize = pos.account?.positionSize ?? 0n;
  const side = posSize > 0n ? "Long" : posSize < 0n ? "Short" : "Flat";
  const sizeAbs = posSize < 0n ? -posSize : posSize;
  const severity = getLiquidationSeverity(pos.liquidationDistancePct);
  const hasPosition = posSize !== 0n;
  // PERC-297: Guard PnL display when oracle price is unavailable
  const hasValidOracle = pos.oraclePriceE6 > 0n;

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
            ⚠ Liq Risk — {pos.liquidationDistancePct.toFixed(1)}% away
          </span>
        </div>
      )}

      <div className="p-3">
        {/* Row 1: Market, Side, PnL */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span
              className="text-[11px] font-semibold text-white"
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
            {pos.leverage > 0 && (
              <span className="text-[9px] font-bold text-[var(--warning)]">
                {pos.leverage.toFixed(1)}×
              </span>
            )}
          </div>
          <div className="text-right">
            {hasValidOracle ? (
              <>
                <span
                  className={`text-[11px] font-bold ${pos.unrealizedPnl >= 0n ? "text-[var(--long)]" : "text-[var(--short)]"}`}
                  style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                >
                  {formatPnl(pos.unrealizedPnl)}
                </span>
                <span
                  className={`ml-1 text-[9px] ${pos.pnlPercent >= 0 ? "text-[var(--long)]/70" : "text-[var(--short)]/70"}`}
                >
                  {formatPnlPct(pos.pnlPercent)}
                </span>
              </>
            ) : (
              <span className="text-[11px] font-bold text-[var(--text-dim)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                --
              </span>
            )}
          </div>
        </div>

        {/* Row 2: Key metrics */}
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
          <div>
            <span className="text-[var(--text-dim)]">Size: </span>
            <span className="text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
              {formatTokenAmount(sizeAbs)}
            </span>
          </div>
          <div>
            <span className="text-[var(--text-dim)]">Entry: </span>
            <span className="text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
              {formatPriceE6(pos.account.entryPrice)}
            </span>
          </div>
          <div>
            <span className="text-[var(--text-dim)]">Mark: </span>
            <span className="text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
              {pos.oraclePriceE6 > 0n ? formatPriceE6(pos.oraclePriceE6) : "—"}
            </span>
          </div>
          <div>
            <span className="text-[var(--text-dim)]">Liq: </span>
            <span
              className={`${
                severity === "danger" ? "font-semibold text-[var(--short)]" : severity === "warning" ? "text-[var(--warning)]" : "text-[var(--text-secondary)]"
              }`}
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            >
              {hasPosition && pos.liquidationPriceE6 > 0n ? formatPriceE6(pos.liquidationPriceE6) : "—"}
            </span>
          </div>
        </div>

        {/* Margin health bar */}
        {hasPosition && pos.liquidationDistancePct < 100 && (
          <div className="mt-2">
            <div className="flex items-center justify-between text-[8px] text-[var(--text-dim)]">
              <span>Margin Health</span>
              <span
                className={
                  severity === "danger"
                    ? "font-bold text-[var(--short)]"
                    : severity === "warning"
                    ? "font-bold text-[var(--warning)]"
                    : "text-[var(--text-muted)]"
                }
              >
                {pos.liquidationDistancePct.toFixed(0)}%
              </span>
            </div>
            <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-[var(--border)]">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.min(pos.liquidationDistancePct, 100)}%`,
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
  const mockMode = isMockMode();
  const portfolio = usePortfolio();

  const mockPositions = mockMode && !connected ? getMockPortfolioPositions() : null;
  const positions = (mockPositions ?? portfolio.positions ?? []) as PortfolioPosition[];
  const loading = mockPositions ? false : portfolio.loading;

  const collateralMints = positions.map((pos) => pos.market.config.collateralMint);
  const tokenMetaMap = useMultiTokenMeta(collateralMints);

  return (
    <div className="flex h-full flex-col border border-[var(--border)] bg-[var(--panel-bg)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <div className="flex items-center gap-2">
          <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]">
            Open Positions
          </p>
          <span className="text-[9px] font-bold text-[var(--text-muted)]">
            ({positions.length})
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
              <div key={i} className="h-24 animate-pulse rounded-sm bg-[var(--border)]" />
            ))}
          </div>
        ) : positions.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center">
            <div className="mb-3 text-2xl opacity-30">📊</div>
            <p className="text-[13px] font-medium text-[var(--text-secondary)]">No open positions</p>
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">Start trading →</p>
            <Link href="/markets" className="mt-3">
              <GlowButton>Browse Markets</GlowButton>
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {positions.slice(0, 8).map((pos, i) => (
              <PositionCard
                key={`${pos.slabAddress}-${i}`}
                pos={pos}
                symbol={
                  tokenMetaMap.get(pos.market.config.collateralMint.toBase58())?.symbol
                    ? `${tokenMetaMap.get(pos.market.config.collateralMint.toBase58())!.symbol}/USD`
                    : `${pos.slabAddress.slice(0, 6)}…/USD`
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
