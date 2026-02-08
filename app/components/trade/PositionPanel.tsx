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

export const PositionPanel: FC = () => {
  const userAccount = useUserAccount();
  const config = useMarketConfig();
  const { trade, loading: closeLoading, error: closeError } = useTrade();
  const { accounts, config: mktConfig } = useSlabState();
  const { priceE6: livePriceE6 } = useLivePrice();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const symbol = tokenMeta?.symbol ?? "Token";
  const [closeSig, setCloseSig] = useState<string | null>(null);

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
        <p className="text-sm text-[#71717a]">No active position</p>
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

  const pnlColor =
    pnlPerc === 0n
      ? "text-[#71717a]"
      : pnlPerc > 0n
        ? "text-emerald-400"
        : "text-red-400";

  let marginHealthStr = "N/A";
  if (hasPosition && absPosition > 0n) {
    const healthPct = Number((account.capital * 100n) / absPosition);
    marginHealthStr = `${healthPct.toFixed(1)}%`;
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
            <span className="text-xs text-[#71717a]">Unrealized PnL</span>
            <span className={`text-sm font-medium ${pnlColor}`}>
              {pnlPerc > 0n ? "+" : pnlPerc < 0n ? "-" : ""}
              {formatTokenAmount(abs(pnlPerc))} {symbol}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-[#71717a]">Margin</span>
            <span className="text-sm text-[#71717a]">{marginHealthStr}</span>
          </div>

          <button
            onClick={handleClose}
            disabled={closeLoading}
            className="mt-2 w-full rounded-lg border border-[#1e1e2e] bg-[#1a1a2e] py-2.5 text-sm font-medium text-[#e4e4e7] transition-colors hover:bg-[#1e1e2e] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {closeLoading ? "Closing..." : "Close Position"}
          </button>

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
