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
  // C2: Track fresh account data for preview
  const [freshPreviewData, setFreshPreviewData] = useState<{
    capital: bigint;
    positionSize: bigint;
    entryPrice: bigint;
  } | null>(null);

  const lpIdx = useMemo(() => {
    const lp = accounts.find(({ account }) => account.kind === AccountKind.LP);
    return lp?.idx ?? 0;
  }, [accounts]);

  if (!userAccount) {
    return (
      <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-5">
        <h3 className="mb-4 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
          Position
        </h3>
        <div className="space-y-3">
          <div className="h-3 w-24 rounded-sm bg-[var(--border)]" />
          <div className="h-3 w-32 rounded-sm bg-[var(--border)]" />
          <div className="h-3 w-20 rounded-sm bg-[var(--border)]" />
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

  // C2: Use fresh preview data when available (during close confirmation)
  const displayData = freshPreviewData ?? {
    capital: account.capital,
    positionSize: account.positionSize,
    entryPrice: account.entryPrice,
  };

  const pnlTokens = computeMarkPnl(
    displayData.positionSize,
    displayData.entryPrice,
    currentPriceE6,
  );
  const pnlUsd =
    priceUsd !== null ? (Number(pnlTokens) / 1e6) * priceUsd : null;
  const roe = computePnlPercent(pnlTokens, displayData.capital);

  const maintenanceBps = params?.maintenanceMarginBps ?? 500n;
  const liqPriceE6 = computeLiqPrice(
    entryPriceE6,
    account.capital,
    account.positionSize,
    maintenanceBps,
  );

  const pnlColor =
    pnlTokens === 0n
      ? "text-[var(--text-muted)]"
      : pnlTokens > 0n
        ? "text-[var(--long)]"
        : "text-[var(--short)]";

  const pnlBgColor =
    pnlTokens === 0n
      ? "bg-[var(--border-subtle)]"
      : pnlTokens > 0n
        ? "bg-[var(--long)]/10"
        : "bg-[var(--short)]/10";

  const pnlBarWidth = Math.min(100, Math.max(0, Math.abs(roe)));

  let marginHealthStr = "N/A";
  if (hasPosition && absPosition > 0n) {
    const healthPct = Number((account.capital * 100n) / absPosition);
    marginHealthStr = `${healthPct.toFixed(1)}%`;
  }

  async function handleClose() {
    if (!userAccount || !hasPosition) return;
    try {
      let freshPositionSize = account.positionSize;
      let freshCapital = account.capital;
      let freshEntryPrice = account.entryPrice;
      try {
        const { fetchSlab, parseAccount } = await import("@percolator/core");
        const freshData = await fetchSlab(connection, new PublicKey(slabAddress));
        const freshAccount = parseAccount(freshData, userAccount.idx);
        freshPositionSize = freshAccount.positionSize;
        freshCapital = freshAccount.capital;
        freshEntryPrice = freshAccount.entryPrice;
        // C2: Store fresh data for preview
        setFreshPreviewData({
          capital: freshCapital,
          positionSize: freshPositionSize,
          entryPrice: freshEntryPrice,
        });
      } catch {
        console.warn("Could not fetch fresh position — using cached state");
        setFreshPreviewData(null);
      }

      if (freshPositionSize === 0n) {
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
    <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-5">
      <h3 className="mb-4 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
        Position
      </h3>

      {!hasPosition ? (
        <div className="flex flex-col items-center py-6 text-center">
          <p className="text-sm text-[var(--text-muted)]">No open position</p>
          <p className="mt-1 text-xs text-[var(--text-dim)]">Open a trade to see your position here</p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* PnL highlight bar */}
          <div className={`rounded-sm ${pnlBgColor} p-3`}>
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--text-muted)]">Unrealized PnL</span>
              <div className="text-right">
                <span className={`text-sm font-bold ${pnlColor}`}>
                  {pnlTokens > 0n ? "+" : pnlTokens < 0n ? "-" : ""}
                  {formatTokenAmount(abs(pnlTokens))} {symbol}
                </span>
                {pnlUsd !== null && (
                  <span className={`ml-1.5 text-xs ${pnlColor}`}>
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
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-[var(--border)]">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  pnlTokens >= 0n ? "bg-[var(--long)]" : "bg-[var(--short)]"
                }`}
                style={{ width: `${pnlBarWidth}%` }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-[var(--text-dim)]">
              <span>
                ROE:{" "}
                <span className={pnlColor}>
                  {roe >= 0 ? "+" : ""}
                  {roe.toFixed(2)}%
                </span>
              </span>
            </div>
          </div>

          {/* Position details */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--text-muted)]">Direction</span>
            <span className={`text-sm font-medium ${isLong ? "text-[var(--long)]" : "text-[var(--short)]"}`}>
              {isLong ? "LONG" : "SHORT"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--text-muted)]">Size</span>
            <span className="text-sm text-[var(--text)]">
              {formatTokenAmount(absPosition)} {symbol}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--text-muted)]">Entry Price</span>
            <span className="text-sm text-[var(--text)]">
              {formatUsd(entryPriceE6)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--text-muted)]">Market Price</span>
            <span className="text-sm text-[var(--text)]">
              {formatUsd(currentPriceE6)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--text-muted)]">Liq. Price</span>
            <span className="text-sm text-[var(--warning)]">
              {liqPriceE6 > 0n ? formatUsd(liqPriceE6) : "-"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--text-muted)]">Margin Health</span>
            <span className="text-sm text-[var(--text-secondary)]">
              {marginHealthStr}
            </span>
          </div>

          {/* Close button with confirmation */}
          {!showConfirm ? (
            <button
              onClick={() => setShowConfirm(true)}
              disabled={closeLoading}
              className="mt-2 w-full rounded-sm border border-[var(--short)]/30 py-2.5 text-sm font-medium text-[var(--short)] transition-all duration-150 hover:bg-[var(--short)]/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Close Position
            </button>
          ) : (
            <div className="mt-2 space-y-2 rounded-sm border border-[var(--short)]/30 p-3">
              <p className="text-xs text-[var(--text-muted)]">
                Close {isLong ? "LONG" : "SHORT"}{" "}
                {formatTokenAmount(absPosition)} {symbol}?
              </p>
              <div className="flex items-center justify-between text-xs">
                <span className="text-[var(--text-muted)]">Est. PnL</span>
                <span className={`font-medium ${pnlColor}`}>
                  {pnlTokens > 0n ? "+" : pnlTokens < 0n ? "-" : ""}
                  {formatTokenAmount(abs(pnlTokens))} {symbol}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-[var(--text-muted)]">You&apos;ll receive</span>
                <span className="font-medium text-[var(--text)]">
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
                  className="flex-1 rounded-sm border border-[var(--border)] py-2 text-xs font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-elevated)]"
                >
                  Cancel
                </button>
                <button
                  onClick={handleClose}
                  disabled={closeLoading}
                  className="flex-1 rounded-sm bg-[var(--short)] py-2 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
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
            <p className="text-xs text-[var(--text-muted)]">
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
      )}
    </div>
  );
};
