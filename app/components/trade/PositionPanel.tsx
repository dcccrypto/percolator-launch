"use client";

import { FC, useMemo, useState } from "react";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { useClosePosition } from "@/hooks/useClosePosition";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { AccountKind } from "@percolator/sdk";
import { formatTokenAmount, formatUsd, formatLiqPrice } from "@/lib/format";
import { useLivePrice } from "@/hooks/useLivePrice";
import {
  computeMarkPnl,
  computeLiqPrice,
  computePnlPercent,
} from "@/lib/trading";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockUserAccount } from "@/lib/mock-trade-data";
import { WarmupProgress } from "./WarmupProgress";
import { ClosePositionModal } from "./ClosePositionModal";

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

export const PositionPanel: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const realUserAccount = useUserAccount();
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const userAccount = realUserAccount ?? (mockMode ? getMockUserAccount(slabAddress) : null);
  const config = useMarketConfig();
  const { engine: engineState, fundingRate } = useEngineState();
  const { accounts, config: mktConfig, params } = useSlabState();
  const { priceE6: livePriceE6, priceUsd } = useLivePrice();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const symbol = tokenMeta?.symbol ?? "Token";
  const decimals = tokenMeta?.decimals ?? 6;

  const { closePosition, loading: closeLoading, error: closeError } = useClosePosition(slabAddress);
  const [showCloseModal, setShowCloseModal] = useState(false);

  const lpEntry = useMemo(() => {
    return accounts.find(({ account }) => account.kind === AccountKind.LP) ?? null;
  }, [accounts]);

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

  // Bug fix: Don't compute P&L with stale/zero price to avoid flash
  const pnlTokens = currentPriceE6 > 0n ? computeMarkPnl(
    account.positionSize,
    account.entryPrice,
    currentPriceE6,
  ) : 0n;
  const pnlUsdRaw =
    priceUsd !== null && currentPriceE6 > 0n ? (Number(pnlTokens) / 10 ** decimals) * priceUsd : null;
  const pnlUsd = pnlUsdRaw !== null && Number.isFinite(pnlUsdRaw) ? pnlUsdRaw : null;
  const roe = currentPriceE6 > 0n ? computePnlPercent(pnlTokens, account.capital) : 0;

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

  // Compute estimated 24h funding from on-chain funding rate
  let estFunding24hDisplay = "—";
  let estFundingColor = "text-[var(--text-muted)]";
  if (hasPosition && fundingRate != null) {
    const rateBpsPerSlot = Number(fundingRate);
    const slotsPerHour = 9000; // Solana ~400ms per slot
    const hourlyRatePercent = (rateBpsPerSlot * slotsPerHour) / 10000;
    const positionTokens = Number(absPosition) / (10 ** decimals);
    const est24h = Math.abs((hourlyRatePercent / 100) * 24 * positionTokens);
    // Determine if user pays or receives
    const longsPay = rateBpsPerSlot > 0;
    const userPays = isLong ? longsPay : !longsPay;
    if (est24h > 0 && rateBpsPerSlot !== 0) {
      const sign = userPays ? "-" : "+";
      estFundingColor = userPays ? "text-[var(--short)]" : "text-[var(--long)]";
      estFunding24hDisplay = `${sign}${est24h < 0.0001 ? est24h.toFixed(6) : est24h.toFixed(4)} ${symbol}`;
    }
  }

  const handleConfirmClose = async (percent: number) => {
    try {
      await closePosition(percent);
      setShowCloseModal(false);
    } catch {
      // error shown via hook state
    }
  };

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
          <div className={`rounded-none border-l-2 ${pnlTokens >= 0n ? "border-l-[var(--long)]" : "border-l-[var(--short)]"} bg-[var(--bg)] p-2.5 mb-2 min-h-[60px]`}>
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Unrealized PnL</span>
              <div className="text-right">
                <span className={`text-sm font-bold ${pnlColor} tabular-nums`} style={{ fontFamily: "var(--font-mono)" }}>
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
                {formatLiqPrice(liqPriceE6)}
              </span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Margin Health</span>
              <span className="text-[11px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
                {marginHealthStr}
              </span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Est. Funding (24h)</span>
              <span className={`text-[11px] font-medium ${estFundingColor}`} style={{ fontFamily: "var(--font-mono)" }}>
                {estFunding24hDisplay}
              </span>
            </div>
          </div>

          {/* Warmup Progress (if active) */}
          <div className="mt-3 border-t border-[var(--border)] pt-3">
            <WarmupProgress 
              slabAddress={slabAddress} 
              accountIdx={userAccount.idx}
              tokenDecimals={decimals}
            />
          </div>

          {/* LP underfunded warning */}
          {lpUnderfunded && (
            <div className="mt-2 rounded-none border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-2.5">
              <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--warning)]">LP Has No Capital</p>
              <p className="mt-1 text-[10px] text-[var(--warning)]/70">
                The liquidity provider has no capital to back the counterparty position. Closing trades will fail until the LP is funded.
              </p>
            </div>
          )}

          {/* Close button */}
          <button
            onClick={() => setShowCloseModal(true)}
            disabled={closeLoading || lpUnderfunded}
            className="mt-2 w-full rounded-none border border-[var(--short)]/30 py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--short)] transition-all duration-150 hover:bg-[var(--short)]/8 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Close Position
          </button>

          {closeError && (
            <div className="mt-2 rounded-none border border-[var(--short)]/20 bg-[var(--short)]/5 px-3 py-2">
              <p className="text-[10px] text-[var(--short)]">{closeError}</p>
            </div>
          )}
        </div>
      )}

      {/* Close Position Modal */}
      {showCloseModal && hasPosition && (
        <ClosePositionModal
          positionSize={account.positionSize}
          entryPrice={entryPriceE6}
          currentPrice={currentPriceE6}
          capital={account.capital}
          symbol={symbol}
          decimals={decimals}
          priceUsd={priceUsd}
          isLong={isLong}
          loading={closeLoading}
          onConfirm={handleConfirmClose}
          onCancel={() => setShowCloseModal(false)}
        />
      )}
    </div>
  );
};
