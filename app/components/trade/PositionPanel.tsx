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
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockUserAccount } from "@/lib/mock-trade-data";

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

export const PositionPanel: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const { connection } = useConnection();
  const realUserAccount = useUserAccount();
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const userAccount = realUserAccount ?? (mockMode ? getMockUserAccount(slabAddress) : null);
  const config = useMarketConfig();
  const { trade, loading: closeLoading, error: closeError } = useTrade(slabAddress);
  const { accounts, config: mktConfig, params } = useSlabState();
  const { priceE6: livePriceE6, priceUsd } = useLivePrice();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const symbol = tokenMeta?.symbol ?? "Token";
  const [closeSig, setCloseSig] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [freshPreviewData, setFreshPreviewData] = useState<{
    capital: bigint;
    positionSize: bigint;
    entryPrice: bigint;
  } | null>(null);

  const lpEntry = useMemo(() => {
    return accounts.find(({ account }) => account.kind === AccountKind.LP) ?? null;
  }, [accounts]);
  const lpIdx = lpEntry?.idx ?? 0;

  // Bug #267a67ef: LP with 0 capital cannot accept counterparty positions
  const lpUnderfunded = lpEntry !== null && lpEntry.account.capital === 0n;

  if (!userAccount) {
    return (
      <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <div className="flex flex-col items-center py-6 text-center">
          <p className="text-[11px] font-medium text-[var(--text-muted)]">No open position</p>
          <p className="mt-1.5 text-[10px] text-[var(--text-dim)] leading-relaxed max-w-[240px]">
            Connect your wallet and deposit collateral to start trading.
          </p>
        </div>
      </div>
    );
  }

  const { account } = userAccount;
  const hasPosition = account.positionSize !== 0n;
  const isLong = account.positionSize > 0n;
  const absPosition = abs(account.positionSize);
  const onChainPriceE6 = config?.lastEffectivePriceE6 ?? null;
  const currentPriceE6 = livePriceE6 ?? onChainPriceE6 ?? 0n;

  const entryPriceE6 = account.entryPrice;

  const displayData = freshPreviewData ?? {
    capital: account.capital,
    positionSize: account.positionSize,
    entryPrice: account.entryPrice,
  };

  // Bug fix: Don't compute P&L with stale/zero price to avoid flash
  const pnlTokens = currentPriceE6 > 0n ? computeMarkPnl(
    displayData.positionSize,
    displayData.entryPrice,
    currentPriceE6,
  ) : 0n;
  const pnlUsd =
    priceUsd !== null && currentPriceE6 > 0n ? (Number(pnlTokens) / 1e6) * priceUsd : null;
  const roe = currentPriceE6 > 0n ? computePnlPercent(pnlTokens, displayData.capital) : 0;

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

  const pnlBarWidth = Math.min(100, Math.max(0, Math.abs(roe)));

  let marginHealthStr = "N/A";
  if (hasPosition && absPosition > 0n) {
    const healthPct = Number((account.capital * 100n) / absPosition);
    marginHealthStr = `${healthPct.toFixed(1)}%`;
  }

  async function handleClose() {
    if (!userAccount || !hasPosition) return;
    if (mockMode) { setShowConfirm(false); return; }
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
    <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">

      {!hasPosition ? (
        <div className="flex flex-col items-center py-6 text-center">
          <p className="text-[11px] font-medium text-[var(--text-muted)]">No open position</p>
          {account.capital > 0n ? (
            <p className="mt-1.5 text-[10px] text-[var(--text-dim)] leading-relaxed max-w-[240px]">
              You have collateral deposited — use the trade form to open a position.
            </p>
          ) : (
            <p className="mt-1.5 text-[10px] text-[var(--text-dim)] leading-relaxed max-w-[240px]">
              Deposit collateral to start trading. Head to the <span className="text-[var(--accent)]">Deposit</span> tab to fund your account.
            </p>
          )}
        </div>
      ) : (
        <div>
          {/* PnL highlight */}
          <div className={`rounded-none border-l-2 ${pnlTokens >= 0n ? "border-l-[var(--long)]" : "border-l-[var(--short)]"} bg-[var(--bg)] p-2.5 mb-2`}>
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Unrealized PnL</span>
              <div className="text-right">
                <span className={`text-sm font-bold ${pnlColor}`} style={{ fontFamily: "var(--font-mono)" }}>
                  {pnlTokens > 0n ? "+" : pnlTokens < 0n ? "-" : ""}
                  {formatTokenAmount(abs(pnlTokens))} {symbol}
                </span>
                {pnlUsd !== null && (
                  <span className={`ml-1.5 text-[10px] ${pnlColor}`} style={{ fontFamily: "var(--font-mono)" }}>
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
            <div className="mt-1.5 h-[2px] w-full overflow-hidden bg-[var(--border)]/50">
              <div
                className={`h-full transition-all duration-500 ${
                  pnlTokens >= 0n ? "bg-[var(--long)]" : "bg-[var(--short)]"
                }`}
                style={{ width: `${pnlBarWidth}%` }}
              />
            </div>
            <div className="mt-1 text-[9px] text-[var(--text-dim)]">
              ROE:{" "}
              <span className={pnlColor} style={{ fontFamily: "var(--font-mono)" }}>
                {roe >= 0 ? "+" : ""}
                {roe.toFixed(2)}%
              </span>
            </div>
          </div>

          {/* Position details — spreadsheet rows */}
          <div className="divide-y divide-[var(--border)]/30">
            <div className="flex items-center justify-between py-1.5">
              <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Direction</span>
              <span className={`text-[11px] font-medium ${isLong ? "text-[var(--long)]" : "text-[var(--short)]"}`}>
                {isLong ? "LONG" : "SHORT"}
              </span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Size</span>
              <span className="text-[11px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                {formatTokenAmount(absPosition)} {symbol}
              </span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Entry Price</span>
              <span className="text-[11px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                {formatUsd(entryPriceE6)}
              </span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Market Price</span>
              <span className="text-[11px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                {formatUsd(currentPriceE6)}
              </span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Liq. Price</span>
              <span className="text-[11px] text-[var(--warning)]" style={{ fontFamily: "var(--font-mono)" }}>
                {liqPriceE6 > 0n ? formatUsd(liqPriceE6) : "-"}
              </span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Margin Health</span>
              <span className="text-[11px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
                {marginHealthStr}
              </span>
            </div>
          </div>

          {/* LP underfunded warning */}
          {lpUnderfunded && (
            <div className="mt-2 rounded-none border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-2.5">
              <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--warning)]">⚠ LP Has No Capital</p>
              <p className="mt-1 text-[10px] text-[var(--warning)]/70">
                The liquidity provider has no capital to back the counterparty position. Closing trades will fail until the LP is funded.
              </p>
            </div>
          )}

          {/* Close button with confirmation */}
          {!showConfirm ? (
            <button
              onClick={() => setShowConfirm(true)}
              disabled={closeLoading || lpUnderfunded}
              className="mt-2 w-full rounded-none border border-[var(--short)]/30 py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--short)] transition-all duration-150 hover:bg-[var(--short)]/8 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Close Position
            </button>
          ) : (
            <div className="mt-2 rounded-none border border-[var(--short)]/30 p-2.5">
              <p className="text-[10px] text-[var(--text-muted)]">
                Close {isLong ? "LONG" : "SHORT"}{" "}
                <span style={{ fontFamily: "var(--font-mono)" }}>{formatTokenAmount(absPosition)}</span> {symbol}?
              </p>
              <div className="mt-1.5 divide-y divide-[var(--border)]/20">
                <div className="flex items-center justify-between py-1">
                  <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Est. PnL</span>
                  <span className={`text-[10px] font-medium ${pnlColor}`} style={{ fontFamily: "var(--font-mono)" }}>
                    {pnlTokens > 0n ? "+" : pnlTokens < 0n ? "-" : ""}
                    {formatTokenAmount(abs(pnlTokens))} {symbol}
                  </span>
                </div>
                <div className="flex items-center justify-between py-1">
                  <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">You&apos;ll receive</span>
                  <span className="text-[10px] font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                    ~
                    {formatTokenAmount(
                      pnlTokens > 0n
                        ? displayData.capital + pnlTokens
                        : pnlTokens < 0n
                          ? displayData.capital > abs(pnlTokens)
                            ? displayData.capital - abs(pnlTokens)
                            : 0n
                          : displayData.capital,
                    )}{" "}
                    {symbol}
                  </span>
                </div>
              </div>
              <div className="mt-2 flex gap-1">
                <button
                  onClick={() => setShowConfirm(false)}
                  className="flex-1 rounded-none border border-[var(--border)]/50 py-1.5 text-[10px] font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-elevated)]"
                >
                  Cancel
                </button>
                <button
                  onClick={handleClose}
                  disabled={closeLoading}
                  className="flex-1 rounded-none bg-[var(--short)] py-1.5 text-[10px] font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
                >
                  {closeLoading ? "Closing..." : "Confirm Close"}
                </button>
              </div>
            </div>
          )}

          {closeError && (
            <div className="mt-2 rounded-none border border-[var(--short)]/20 bg-[var(--short)]/5 px-3 py-2">
              <p className="text-[10px] text-[var(--short)]">{humanizeError(closeError)}</p>
            </div>
          )}

          {closeSig && (
            <p className="mt-2 text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>
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
