"use client";

import { FC, useMemo, useState } from "react";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { useTrade } from "@/hooks/useTrade";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { AccountKind } from "@percolator/core";
import { formatTokenAmount, formatUsd } from "@/lib/format";
import { useLivePrice } from "@/hooks/useLivePrice";

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function relativeTime(slotDiff: bigint): string {
  const seconds = Number(slotDiff) / 2.5;
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h ago`;
  return `${(seconds / 86400).toFixed(1)}d ago`;
}

export const PositionPanel: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const userAccount = useUserAccount();
  const config = useMarketConfig();
  const { trade, loading: closeLoading, error: closeError } = useTrade(slabAddress);
  const { accounts, config: mktConfig } = useSlabState();
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
      <div className="rounded-xl border border-[#1e1e2e] bg-[#12121a] p-6 shadow-sm">
        <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-[#71717a]">
          Position
        </h3>
        <div className="space-y-3">
          <div className="h-4 w-24 animate-pulse rounded bg-[#1a1a2e]" />
          <div className="h-4 w-32 animate-pulse rounded bg-[#1a1a2e]" />
          <div className="h-4 w-20 animate-pulse rounded bg-[#1a1a2e]" />
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

  const entryPriceE6 = account.reservedPnl > 0n
    ? account.reservedPnl
    : account.entryPrice;

  let pnlPerc = 0n;
  if (hasPosition && currentPriceE6 > 0n && entryPriceE6 > 0n) {
    const priceDelta = currentPriceE6 - entryPriceE6;
    pnlPerc = (account.positionSize * priceDelta) / currentPriceE6;
  }

  // PnL in USD
  const pnlUsd = priceUsd !== null ? (Number(pnlPerc) / 1e6) * priceUsd : null;

  // ROE: PnL / capital * 100
  const roe = account.capital > 0n && hasPosition
    ? Number(pnlPerc * 10000n / account.capital) / 100
    : 0;

  const pnlColor =
    pnlPerc === 0n
      ? "text-[#71717a]"
      : pnlPerc > 0n
        ? "text-emerald-400"
        : "text-red-400";

  const pnlBgColor =
    pnlPerc === 0n
      ? "bg-[#1a1a2e]"
      : pnlPerc > 0n
        ? "bg-emerald-500/10"
        : "bg-red-500/10";

  // PnL bar width (clamped to 0-100%)
  const pnlBarWidth = Math.min(100, Math.max(0, Math.abs(roe)));

  let marginHealthStr = "N/A";
  if (hasPosition && absPosition > 0n) {
    const healthPct = Number((account.capital * 100n) / absPosition);
    marginHealthStr = `${healthPct.toFixed(1)}%`;
  }

  // Time since opened — use lastUpdateSlot if available
  const timeOpen: string | null = null;

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
    <div className="rounded-xl border border-[#1e1e2e] bg-[#12121a] p-6 shadow-sm">
      <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-[#71717a]">
        Position
      </h3>

      {!hasPosition ? (
        <p className="text-sm text-[#71717a]">No open position</p>
      ) : (
        <div className="space-y-3">
          {/* PnL highlight bar */}
          <div className={`rounded-lg ${pnlBgColor} p-3`}>
            <div className="flex items-center justify-between">
              <span className="text-xs text-[#71717a]">Unrealized PnL</span>
              <div className="text-right">
                <span className={`text-sm font-bold ${pnlColor}`}>
                  {pnlPerc > 0n ? "+" : pnlPerc < 0n ? "-" : ""}
                  {formatTokenAmount(abs(pnlPerc))} {symbol}
                </span>
                {pnlUsd !== null && (
                  <span className={`ml-1.5 text-xs ${pnlColor}`}>
                    ({pnlUsd >= 0 ? "+" : ""}${Math.abs(pnlUsd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})
                  </span>
                )}
              </div>
            </div>
            {/* PnL bar */}
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-[#1e1e2e]">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  pnlPerc >= 0n ? "bg-emerald-500" : "bg-red-500"
                }`}
                style={{ width: `${pnlBarWidth}%` }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-[#52525b]">
              <span>ROE: <span className={pnlColor}>{roe >= 0 ? "+" : ""}{roe.toFixed(2)}%</span></span>
              {timeOpen && <span>Opened {timeOpen}</span>}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-[#71717a]">Direction</span>
            <span
              className={`text-sm font-medium ${
                isLong ? "text-emerald-400" : "text-red-400"
              }`}
            >
              {isLong ? "LONG" : "SHORT"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-[#71717a]">Size</span>
            <span className="text-sm text-[#e4e4e7]">
              {formatTokenAmount(absPosition)} {symbol}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-[#71717a]">Entry Price</span>
            <span className="text-sm text-[#e4e4e7]">
              {formatUsd(entryPriceE6)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-[#71717a]">Current Price</span>
            <span className="text-sm text-[#e4e4e7]">
              {formatUsd(currentPriceE6)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-[#71717a]">Margin Health</span>
            <span className="text-sm text-[#a1a1aa]">{marginHealthStr}</span>
          </div>

          {/* Close button with confirmation */}
          {!showConfirm ? (
            <button
              onClick={() => setShowConfirm(true)}
              disabled={closeLoading}
              className="mt-2 w-full rounded-lg border border-[#1e1e2e] bg-[#1a1a2e] py-2.5 text-sm font-medium text-[#e4e4e7] transition-all duration-150 hover:bg-red-600/20 hover:border-red-600/30 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-red-500/30"
            >
              Close Position
            </button>
          ) : (
            <div className="mt-2 space-y-2 rounded-lg border border-red-600/30 bg-red-900/10 p-3">
              <p className="text-xs text-[#a1a1aa]">
                Close {isLong ? "LONG" : "SHORT"} {formatTokenAmount(absPosition)} {symbol}?
              </p>
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#71717a]">Est. PnL</span>
                <span className={`font-medium ${pnlColor}`}>
                  {pnlPerc > 0n ? "+" : pnlPerc < 0n ? "-" : ""}{formatTokenAmount(abs(pnlPerc))} {symbol}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#71717a]">You&apos;ll receive</span>
                <span className="font-medium text-[#e4e4e7]">
                  ~{formatTokenAmount(pnlPerc > 0n ? account.capital + pnlPerc : pnlPerc < 0n ? (account.capital > abs(pnlPerc) ? account.capital - abs(pnlPerc) : 0n) : account.capital)} {symbol}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowConfirm(false)}
                  className="flex-1 rounded-lg border border-[#1e1e2e] bg-[#1a1a2e] py-2 text-xs font-medium text-[#71717a] transition-colors hover:bg-[#1e1e2e]"
                >
                  Cancel
                </button>
                <button
                  onClick={handleClose}
                  disabled={closeLoading}
                  className="flex-1 rounded-lg bg-red-600 py-2 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
                >
                  {closeLoading ? "Closing..." : "Confirm Close"}
                </button>
              </div>
            </div>
          )}

          {closeError && (
            <p className="text-xs text-red-400">{closeError}</p>
          )}

          {closeSig && (
            <p className="text-xs text-[#71717a]">
              Closed:{" "}
              <a
                href={`https://explorer.solana.com/tx/${closeSig}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline"
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
