"use client";

import { FC, useMemo, useState } from "react";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useClosePosition } from "@/hooks/useClosePosition";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { AccountKind } from "@percolator/sdk";
import {
  formatTokenAmount,
  formatUsd,
  formatLiqPrice,
  formatPnl,
  formatPercent,
} from "@/lib/format";
import { computeMarkPnl, computeLiqPrice, computePnlPercent } from "@/lib/trading";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockUserAccount } from "@/lib/mock-trade-data";
import { ClosePositionModal } from "./ClosePositionModal";
import { WarmupProgress } from "./WarmupProgress";

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

export const PositionsTable: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const realUserAccount = useUserAccount();
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const userAccount = realUserAccount ?? (mockMode ? getMockUserAccount(slabAddress) : null);
  const config = useMarketConfig();
  const { accounts, config: mktConfig, params } = useSlabState();
  const { priceE6: livePriceE6, priceUsd } = useLivePrice();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const symbol = tokenMeta?.symbol ?? "Token";
  const decimals = tokenMeta?.decimals ?? 6;

  const { closePosition, loading: closeLoading, error: closeError, phase: closePhase } = useClosePosition(slabAddress);

  const [showCloseModal, setShowCloseModal] = useState(false);

  const lpEntry = useMemo(() => {
    return accounts.find(({ account }) => account.kind === AccountKind.LP) ?? null;
  }, [accounts]);
  const lpUnderfunded = lpEntry !== null && lpEntry.account.capital === 0n;

  if (!userAccount) return null;

  const { account } = userAccount;
  const hasPosition = account.positionSize !== 0n;

  if (!hasPosition) {
    return (
      <div className="border border-[var(--border)]/50 bg-[var(--bg)]/80">
        <div className="py-8 text-center">
          <p className="text-[11px] text-[var(--text-muted)]">No open positions</p>
        </div>
      </div>
    );
  }

  const isLong = account.positionSize > 0n;
  const absPosition = abs(account.positionSize);
  const onChainPriceE6 = config?.lastEffectivePriceE6 ?? null;
  const currentPriceE6 = livePriceE6 ?? onChainPriceE6 ?? 0n;
  const entryPriceE6 = account.entryPrice;
  const maintenanceBps = params?.maintenanceMarginBps ?? 500n;

  const pnlTokens = currentPriceE6 > 0n
    ? computeMarkPnl(account.positionSize, entryPriceE6, currentPriceE6)
    : 0n;
  const pnlUsd = priceUsd !== null && currentPriceE6 > 0n
    ? (Number(pnlTokens) / (10 ** decimals)) * priceUsd
    : null;
  const roe = currentPriceE6 > 0n ? computePnlPercent(pnlTokens, account.capital) : 0;

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

  const roeColor =
    roe === 0
      ? "text-[var(--text-muted)]"
      : roe > 0
        ? "text-[var(--long)]"
        : "text-[var(--short)]";

  const handleConfirmClose = async (percent: number) => {
    try {
      await closePosition(percent);
      setShowCloseModal(false);
    } catch {
      // error shown via hook state
    }
  };

  return (
    <div className="border border-[var(--border)]/50 bg-[var(--bg)]/80">
      {/* LP Underfunded warning */}
      {lpUnderfunded && (
        <div className="border-b border-[var(--warning)]/20 bg-[var(--warning)]/5 px-4 py-1.5 text-center">
          <span className="text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--warning)]">
            LP Underfunded
          </span>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full text-[10px]">
          <thead>
            <tr className="border-b border-[var(--border)]/30 text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">Market</th>
              <th className="whitespace-nowrap px-3 py-2 text-left font-medium">Side</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Size</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Entry</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Mark</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Liq. Price</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">PnL</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">ROE%</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Close</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-[var(--border)]/20 transition-colors hover:bg-[var(--accent)]/[0.03]">
              {/* Market */}
              <td className="whitespace-nowrap px-4 py-2.5 text-left">
                <span className="text-[11px] font-medium text-[var(--text)]">{symbol}/USD</span>
              </td>

              {/* Side */}
              <td className="whitespace-nowrap px-3 py-2.5 text-left">
                <span className={`inline-block rounded-sm px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                  isLong
                    ? "bg-[var(--long)]/10 text-[var(--long)]"
                    : "bg-[var(--short)]/10 text-[var(--short)]"
                }`}>
                  {isLong ? "LONG" : "SHORT"}
                </span>
              </td>

              {/* Size */}
              <td className="whitespace-nowrap px-3 py-2.5 text-right" style={{ fontFamily: "var(--font-mono)" }}>
                <span className="text-[var(--text)]">{formatTokenAmount(absPosition, decimals)}</span>
                <span className="ml-1 text-[var(--text-dim)]">{symbol}</span>
              </td>

              {/* Entry */}
              <td className="whitespace-nowrap px-3 py-2.5 text-right text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                {formatUsd(entryPriceE6)}
              </td>

              {/* Mark */}
              <td className="whitespace-nowrap px-3 py-2.5 text-right text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                {formatUsd(currentPriceE6)}
              </td>

              {/* Liq. Price */}
              <td className="whitespace-nowrap px-3 py-2.5 text-right text-[var(--warning)]" style={{ fontFamily: "var(--font-mono)" }}>
                {formatLiqPrice(liqPriceE6)}
              </td>

              {/* PnL */}
              <td className={`whitespace-nowrap px-3 py-2.5 text-right ${pnlColor}`} style={{ fontFamily: "var(--font-mono)" }}>
                <div>{formatPnl(pnlTokens, decimals)} {symbol}</div>
                {pnlUsd !== null && (
                  <div className="text-[9px]">
                    {pnlUsd >= 0 ? "+" : ""}${Math.abs(pnlUsd).toFixed(2)}
                  </div>
                )}
              </td>

              {/* ROE% */}
              <td className={`whitespace-nowrap px-3 py-2.5 text-right font-medium ${roeColor}`} style={{ fontFamily: "var(--font-mono)" }}>
                {formatPercent(roe)}
              </td>

              {/* Close */}
              <td className="whitespace-nowrap px-3 py-2.5 text-right">
                <button
                  onClick={() => setShowCloseModal(true)}
                  disabled={closeLoading || lpUnderfunded}
                  className="rounded-none border border-[var(--short)]/30 px-3 py-1 text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--short)] transition-all duration-150 hover:bg-[var(--short)]/8 hover:border-[var(--short)]/50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Close
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Warmup progress below the position row */}
      <div className="px-4 py-2">
        <WarmupProgress slabAddress={slabAddress} accountIdx={userAccount.idx} />
      </div>

      {/* Close error */}
      {closeError && (
        <div className="mx-4 mb-3 rounded-none border border-[var(--short)]/20 bg-[var(--short)]/5 px-3 py-2">
          <p className="text-[10px] text-[var(--short)]">{closeError}</p>
        </div>
      )}

      {/* Close Position Modal */}
      {showCloseModal && (
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
