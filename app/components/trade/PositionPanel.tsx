"use client";
import { explorerTxUrl } from "@/lib/config";

import { FC, useMemo, useState, useRef, useEffect } from "react";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { useTrade } from "@/hooks/useTrade";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { AccountKind } from "@percolator/core";
import { formatTokenAmount, formatUsd } from "@/lib/format";
import { useLivePrice } from "@/hooks/useLivePrice";
import {
  computeMarkPnl,
  computeLiqPrice,
  computePnlPercent,
} from "@/lib/trading";
import { humanizeError } from "@/lib/errorMessages";
import gsap from "gsap";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

export const PositionPanel: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const userAccount = useUserAccount();
  const config = useMarketConfig();
  const { trade, loading: closeLoading, error: closeError } = useTrade(slabAddress);
  const { accounts, config: mktConfig, params } = useSlabState();
  const { priceE6: livePriceE6, priceUsd } = useLivePrice();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const symbol = tokenMeta?.symbol ?? "Token";
  const decimals = tokenMeta?.decimals ?? 6;
  const [closeSig, setCloseSig] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const prefersReduced = usePrefersReducedMotion();
  const pnlBarRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);

  const lpIdx = useMemo(() => {
    const lp = accounts.find(({ account }) => account.kind === AccountKind.LP);
    return lp?.idx ?? 0;
  }, [accounts]);

  if (!userAccount) {
    return (
      <div className="p-6">
        <h3 className="mb-4 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
          Position
        </h3>
        <div className="space-y-3">
          <div className="h-4 w-24 animate-pulse rounded bg-[var(--bg-surface)]" />
          <div className="h-4 w-32 animate-pulse rounded bg-[var(--bg-surface)]" />
          <div className="h-4 w-20 animate-pulse rounded bg-[var(--bg-surface)]" />
        </div>
      </div>
    );
  }

  const { account } = userAccount;
  const hasPosition = account.positionSize !== 0n;
  const isLong = account.positionSize > 0n;
  const absPosition = abs(account.positionSize);
  const onChainPriceE6 = config?.lastEffectivePriceE6 ?? 0n;
  const currentPriceE6 = livePriceE6 ?? onChainPriceE6;

  const entryPriceE6 = account.entryPrice;

  // --- PnL via trading.ts utilities ---
  const pnlTokens = computeMarkPnl(
    account.positionSize,
    entryPriceE6,
    currentPriceE6,
  );
  const pnlUsd =
    priceUsd !== null ? (Number(pnlTokens) / 1e6) * priceUsd : null;
  const roe = computePnlPercent(pnlTokens, account.capital);

  // --- Liquidation price ---
  const maintenanceBps = params?.maintenanceMarginBps ?? 100n;
  const liqPriceE6 = computeLiqPrice(
    entryPriceE6,
    account.capital,
    account.positionSize,
    maintenanceBps,
  );

  // --- Colours ---
  const pnlColor =
    pnlTokens === 0n
      ? "text-[var(--text-secondary)]"
      : pnlTokens > 0n
        ? "text-[var(--long)]"
        : "text-[var(--short)]";

  const pnlBgColor =
    pnlTokens === 0n
      ? "bg-[var(--bg-surface)]"
      : pnlTokens > 0n
        ? "bg-[var(--long)]/10"
        : "bg-[var(--short)]/10";

  const pnlBarWidth = Math.min(100, Math.max(0, Math.abs(roe)));

  // Margin health: how far we are from liquidation.
  // 100% = at entry (max health), 0% = at liq price (liquidatable)
  let marginHealthStr = "N/A";
  let marginHealthPct = 100;
  if (hasPosition && absPosition > 0n && currentPriceE6 > 0n) {
    if (liqPriceE6 > 0n) {
      // Edge case: when liqPriceE6 === currentPriceE6, dist=0 so marginHealthPct=0%
      // which is correct — position is at liquidation price.
      if (isLong) {
        const range = Number(entryPriceE6 - liqPriceE6);
        const dist = Number(currentPriceE6 - liqPriceE6);
        marginHealthPct = range > 0 ? Math.max(0, Math.min(100, (dist / range) * 100)) : 0;
      } else {
        const range = Number(liqPriceE6 - entryPriceE6);
        const dist = Number(liqPriceE6 - currentPriceE6);
        marginHealthPct = range > 0 ? Math.max(0, Math.min(100, (dist / range) * 100)) : 0;
      }
    } else {
      // Fallback: equity-based margin ratio
      const notional = Number(absPosition) * Number(currentPriceE6) / 1e6;
      const equity = Number(account.capital) + Number(pnlTokens);
      marginHealthPct = notional > 0 ? Math.max(0, (equity / notional) * 100) : 0;
    }
    marginHealthStr = `${marginHealthPct.toFixed(1)}%`;
  }

  async function handleClose() {
    if (!userAccount || !hasPosition) return;
    try {
      const closeSize = isLong ? -absPosition : absPosition;
      const sig = await trade({
        lpIdx,
        userIdx: userAccount.idx,
        size: closeSize,
      });
      setCloseSig(sig ?? null);
      setShowConfirm(false);
    } catch {
      // error set by hook
    }
  }

  return (
    <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-6">
      <h3 className="mb-4 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
        Position
      </h3>

      {!hasPosition ? (
        <div className="flex flex-col items-center py-6 text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--bg-surface)]">
            <svg className="h-6 w-6 text-[var(--text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-[var(--text-secondary)]">No open position</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">Open a trade to see your position here</p>
        </div>
      ) : (
        <PnlBarAnimator
          pnlBarWidth={pnlBarWidth}
          pnlBarRef={pnlBarRef}
          prefersReduced={prefersReduced}
          showConfirm={showConfirm}
          confirmRef={confirmRef}
        >
          <div className="space-y-3">
            {/* PnL highlight bar */}
            <div className={`rounded-sm ${pnlBgColor} p-3`}>
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--text-secondary)]">Unrealized PnL</span>
                <div className="text-right">
                  <span className={`font-mono text-sm font-bold ${pnlColor}`}>
                    {pnlTokens > 0n ? "+" : pnlTokens < 0n ? "-" : ""}
                    {formatTokenAmount(abs(pnlTokens), decimals)} {symbol}
                  </span>
                  {pnlUsd !== null && (
                    <span className={`ml-1.5 font-mono text-xs ${pnlColor}`}>
                      ({pnlUsd >= 0 ? "+" : ""}$
                      {Math.abs(pnlUsd).toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                      )
                    </span>
                  )}
                </div>
              </div>
              {/* PnL bar */}
              <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-[var(--border)]">
                <div
                  ref={pnlBarRef}
                  className={`h-full rounded-full ${
                    pnlTokens >= 0n ? "bg-[var(--long)]" : "bg-[var(--short)]"
                  }`}
                  style={{ width: `${pnlBarWidth}%` }}
                />
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-[var(--text-muted)]">
                <span>
                  PnL%:{" "}
                  <span className={`font-mono ${pnlColor}`}>
                    {roe >= 0 ? "+" : ""}
                    {roe.toFixed(2)}%
                  </span>
                </span>
              </div>
            </div>

            {/* Position details */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--text-secondary)]">Direction</span>
              <span
                className={`text-sm font-medium ${
                  isLong ? "text-[var(--long)]" : "text-[var(--short)]"
                }`}
              >
                {isLong ? "LONG" : "SHORT"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--text-secondary)]">Size</span>
              <span className="font-mono text-sm text-[var(--text)]">
                {formatTokenAmount(absPosition, decimals)} {symbol}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--text-secondary)]">Entry Price</span>
              <span className="font-mono text-sm text-[var(--text)]">
                {formatUsd(entryPriceE6)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--text-secondary)]">Market Price</span>
              <span className="font-mono text-sm text-[var(--text)]">
                {formatUsd(currentPriceE6)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--text-secondary)]">Liq. Price</span>
              <span className="font-mono text-sm text-[var(--warning)]">
                {liqPriceE6 > 0n ? formatUsd(liqPriceE6) : "\u2014"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--text-secondary)]">Margin Health</span>
              <span className={`font-mono text-sm ${
                marginHealthPct <= 0 ? "text-[var(--short)]" :
                marginHealthPct < 30 ? "text-[var(--warning)]" :
                "text-[var(--text-secondary)]"
              }`}>
                {marginHealthStr}
              </span>
            </div>

            {/* Close button with confirmation */}
            {!showConfirm ? (
              <button
                onClick={() => setShowConfirm(true)}
                disabled={closeLoading}
                className="mt-2 w-full rounded-sm border border-[var(--short)]/30 bg-[var(--short)]/10 py-2.5 text-sm font-medium text-[var(--short)] transition-all duration-150 hover:bg-[var(--short)]/20 hover:scale-[1.02] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-[var(--short)]/30"
              >
                Close Position
              </button>
            ) : (
              <div
                ref={confirmRef}
                className="mt-2 space-y-2 rounded-sm border border-[var(--short)]/30 bg-[var(--short)]/5 p-3 overflow-hidden"
              >
                <p className="text-xs text-[var(--text-secondary)]">
                  Close {isLong ? "LONG" : "SHORT"}{" "}
                  {formatTokenAmount(absPosition, decimals)} {symbol}?
                </p>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--text-secondary)]">Est. PnL</span>
                  <span className={`font-mono font-medium ${pnlColor}`}>
                    {pnlTokens > 0n ? "+" : pnlTokens < 0n ? "-" : ""}
                    {formatTokenAmount(abs(pnlTokens), decimals)} {symbol}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--text-secondary)]">You&apos;ll receive</span>
                  <span className="font-mono font-medium text-[var(--text)]">
                    ~
                    {formatTokenAmount(
                      pnlTokens > 0n
                        ? account.capital + pnlTokens
                        : pnlTokens < 0n
                          ? account.capital > abs(pnlTokens)
                            ? account.capital - abs(pnlTokens)
                            : 0n
                          : account.capital,
                      decimals,
                    )}{" "}
                    {symbol}
                  </span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowConfirm(false)}
                    className="flex-1 rounded-sm border border-[var(--border)] bg-[var(--bg-surface)] py-2 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--border)]"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleClose}
                    disabled={closeLoading}
                    className="flex-1 rounded-sm bg-[var(--short)] py-2 text-xs font-medium text-white transition-colors hover:bg-[var(--short)] disabled:opacity-50"
                  >
                    {closeLoading ? "Closing..." : "Confirm Close"}
                  </button>
                </div>
              </div>
            )}

            {closeError && (
              <div className="rounded-sm border border-[var(--short)]/20 bg-[var(--short)]/10 px-3 py-2">
                <p className="text-xs text-[var(--short)]">{humanizeError(closeError)}</p>
              </div>
            )}

            {closeSig && (
              <p className="text-xs text-[var(--text-secondary)]">
                Closed:{" "}
                <a
                  href={`${explorerTxUrl(closeSig)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--accent)] hover:underline"
                >
                  {closeSig.slice(0, 16)}...
                </a>
              </p>
            )}
          </div>
        </PnlBarAnimator>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Helper wrapper that runs GSAP side-effects for the position view  */
/* ------------------------------------------------------------------ */
function PnlBarAnimator({
  pnlBarWidth,
  pnlBarRef,
  prefersReduced,
  showConfirm,
  confirmRef,
  children,
}: {
  pnlBarWidth: number;
  pnlBarRef: React.RefObject<HTMLDivElement | null>;
  prefersReduced: boolean;
  showConfirm: boolean;
  confirmRef: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  // Animate PnL bar width
  useEffect(() => {
    if (prefersReduced || !pnlBarRef.current) return;
    gsap.to(pnlBarRef.current, {
      width: `${pnlBarWidth}%`,
      duration: 0.5,
      ease: "power2.out",
    });
  }, [pnlBarWidth, prefersReduced, pnlBarRef]);

  // Animate confirmation panel expand
  useEffect(() => {
    if (!showConfirm || prefersReduced || !confirmRef.current) return;
    gsap.fromTo(
      confirmRef.current,
      { height: 0, opacity: 0 },
      { height: "auto", opacity: 1, duration: 0.3 },
    );
  }, [showConfirm, prefersReduced, confirmRef]);

  return <>{children}</>;
}
