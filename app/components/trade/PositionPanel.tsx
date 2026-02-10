"use client";
import { explorerTxUrl } from "@/lib/config";

import { FC, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
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

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

export const PositionPanel: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const { connection } = useConnection();
  const userAccount = useUserAccount();
  const config = useMarketConfig();
  const { trade, loading: closeLoading, error: closeError } = useTrade(slabAddress);
  const { accounts, config: mktConfig, params } = useSlabState();
  const { priceE6: livePriceE6, priceUsd } = useLivePrice();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const symbol = tokenMeta?.symbol ?? "Token";
  const [closeSig, setCloseSig] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const lpIdx = useMemo(() => {
    const lp = accounts.find(({ account }) => account.kind === AccountKind.LP);
    return lp?.idx ?? 0;
  }, [accounts]);

  if (!userAccount) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-6 shadow-sm">
        <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-[#8B95B0]">
          Position
        </h3>
        <div className="space-y-3">
          <div className="h-4 w-24 animate-pulse rounded bg-white/5" />
          <div className="h-4 w-32 animate-pulse rounded bg-white/5" />
          <div className="h-4 w-20 animate-pulse rounded bg-white/5" />
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
      ? "text-[#8B95B0]"
      : pnlTokens > 0n
        ? "text-[#00FFB2]"
        : "text-[#FF4466]";

  const pnlBgColor =
    pnlTokens === 0n
      ? "bg-white/5"
      : pnlTokens > 0n
        ? "bg-[#00FFB2]/10"
        : "bg-[#FF4466]/10";

  const pnlBarWidth = Math.min(100, Math.max(0, Math.abs(roe)));

  let marginHealthStr = "N/A";
  if (hasPosition && absPosition > 0n) {
    const healthPct = Number((account.capital * 100n) / absPosition);
    marginHealthStr = `${healthPct.toFixed(1)}%`;
  }

  async function handleClose() {
    if (!userAccount || !hasPosition) return;
    try {
      // IMPORTANT: Fetch fresh slab data to get the CURRENT on-chain position
      // The prepended crank in useTrade can change position size (funding/settlement)
      // Using stale UI data can cause the close to overshoot and flip the position
      let freshPositionSize = account.positionSize;
      try {
        const { fetchSlab, parseAccount } = await import("@percolator/core");
        const freshData = await fetchSlab(connection, new PublicKey(slabAddress));
        const freshAccount = parseAccount(freshData, userAccount.idx);
        freshPositionSize = freshAccount.positionSize;
      } catch {
        // Fall back to UI state if fresh fetch fails
        console.warn("Could not fetch fresh position — using cached state");
      }

      if (freshPositionSize === 0n) {
        // Position already closed (e.g., liquidated)
        setShowConfirm(false);
        return;
      }

      const freshAbs = freshPositionSize < 0n ? -freshPositionSize : freshPositionSize;
      const freshIsLong = freshPositionSize > 0n;
      const closeSize = freshIsLong ? -freshAbs : freshAbs;

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
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-6 shadow-sm">
      <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-[#8B95B0]">
        Position
      </h3>

      {!hasPosition ? (
        <div className="flex flex-col items-center py-6 text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-white/5">
            <svg className="h-6 w-6 text-[#3D4563]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-[#8B95B0]">No open position</p>
          <p className="mt-1 text-xs text-[#3D4563]">Open a trade to see your position here</p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* PnL highlight bar */}
          <div className={`rounded-lg ${pnlBgColor} p-3`}>
            <div className="flex items-center justify-between">
              <span className="text-xs text-[#8B95B0]">Unrealized PnL</span>
              <div className="text-right">
                <span className={`font-mono text-sm font-bold ${pnlColor}`}>
                  {pnlTokens > 0n ? "+" : pnlTokens < 0n ? "-" : ""}
                  {formatTokenAmount(abs(pnlTokens))} {symbol}
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
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  pnlTokens >= 0n ? "bg-[#00FFB2]" : "bg-[#FF4466]"
                }`}
                style={{ width: `${pnlBarWidth}%` }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-[#3D4563]">
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
            <span className="text-xs text-[#8B95B0]">Direction</span>
            <span
              className={`text-sm font-medium ${
                isLong ? "text-[#00FFB2]" : "text-[#FF4466]"
              }`}
            >
              {isLong ? "LONG" : "SHORT"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-[#8B95B0]">Size</span>
            <span className="font-mono text-sm text-[#F0F4FF]">
              {formatTokenAmount(absPosition)} {symbol}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-[#8B95B0]">Entry Price</span>
            <span className="font-mono text-sm text-[#F0F4FF]">
              {formatUsd(entryPriceE6)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-[#8B95B0]">Market Price</span>
            <span className="font-mono text-sm text-[#F0F4FF]">
              {formatUsd(currentPriceE6)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-[#8B95B0]">Liq. Price</span>
            <span className="font-mono text-sm text-amber-400">
              {liqPriceE6 > 0n ? formatUsd(liqPriceE6) : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-[#8B95B0]">Margin Health</span>
            <span className="font-mono text-sm text-[#8B95B0]">
              {marginHealthStr}
            </span>
          </div>

          {/* Close button with confirmation */}
          {!showConfirm ? (
            <button
              onClick={() => setShowConfirm(true)}
              disabled={closeLoading}
              className="mt-2 w-full rounded-lg border border-[#FF4466]/30 bg-[#FF4466]/10 py-2.5 text-sm font-medium text-[#FF4466] transition-all duration-150 hover:bg-[#FF4466]/20 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-[#FF4466]/30"
            >
              Close Position
            </button>
          ) : (
            <div className="mt-2 space-y-2 rounded-lg border border-[#FF4466]/30 bg-red-900/10 p-3">
              <p className="text-xs text-[#8B95B0]">
                Close {isLong ? "LONG" : "SHORT"}{" "}
                {formatTokenAmount(absPosition)} {symbol}?
              </p>
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#8B95B0]">Est. PnL</span>
                <span className={`font-mono font-medium ${pnlColor}`}>
                  {pnlTokens > 0n ? "+" : pnlTokens < 0n ? "-" : ""}
                  {formatTokenAmount(abs(pnlTokens))} {symbol}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#8B95B0]">You&apos;ll receive</span>
                <span className="font-mono font-medium text-[#F0F4FF]">
                  ~
                  {formatTokenAmount(
                    pnlTokens > 0n
                      ? account.capital + pnlTokens
                      : pnlTokens < 0n
                        ? account.capital > abs(pnlTokens)
                          ? account.capital - abs(pnlTokens)
                          : 0n
                        : account.capital,
                  )}{" "}
                  {symbol}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowConfirm(false)}
                  className="flex-1 rounded-lg border border-white/[0.06] bg-white/5 py-2 text-xs font-medium text-[#8B95B0] transition-colors hover:bg-white/[0.06]"
                >
                  Cancel
                </button>
                <button
                  onClick={handleClose}
                  disabled={closeLoading}
                  className="flex-1 rounded-lg bg-[#FF4466] py-2 text-xs font-medium text-white transition-colors hover:bg-[#FF3355] disabled:opacity-50"
                >
                  {closeLoading ? "Closing..." : "Confirm Close"}
                </button>
              </div>
            </div>
          )}

          {closeError && (
            <div className="rounded-lg border border-[#FF4466]/20 bg-[#FF4466]/10 px-3 py-2">
              <p className="text-xs text-[#FF4466]">{humanizeError(closeError)}</p>
            </div>
          )}

          {closeSig && (
            <p className="text-xs text-[#8B95B0]">
              Closed:{" "}
              <a
                href={`${explorerTxUrl(closeSig)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#7B61FF] hover:underline"
              >
                {closeSig.slice(0, 16)}...
              </a>
            </p>
          )}
        </div>
      )}
    </div>
  );
};
