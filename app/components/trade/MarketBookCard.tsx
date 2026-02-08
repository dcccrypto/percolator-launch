"use client";

import { FC, useMemo } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useLivePrice } from "@/hooks/useLivePrice";
import { formatUsd, formatTokenAmount, shortenAddress } from "@/lib/format";
import { AccountKind } from "@percolator/core";

export const MarketBookCard: FC = () => {
  const { engine, params, loading } = useEngineState();
  const config = useMarketConfig();
  const { accounts, config: mktConfig } = useSlabState();
  const { priceE6: livePriceE6 } = useLivePrice();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const symbol = tokenMeta?.symbol ?? "Token";

  const lps = useMemo(
    () => accounts.filter(({ account }) => account.kind === AccountKind.LP),
    [accounts],
  );

  if (loading || !engine || !config || !params) {
    return (
      <div className="p-4">
        <p className="text-sm text-[#4a5068]">{loading ? "Loading…" : "—"}</p>
      </div>
    );
  }

  const oraclePrice = livePriceE6 ?? config.lastEffectivePriceE6;
  const feeBps = Number(params.tradingFeeBps);
  const bestBid = oraclePrice > 0n ? Number(oraclePrice) * (1 - feeBps / 10000) : 0;
  const bestAsk = oraclePrice > 0n ? Number(oraclePrice) * (1 + feeBps / 10000) : 0;
  const lpTotalCapital = lps.reduce((sum, { account }) => sum + account.capital, 0n);
  const maxLpCapital = lps.length > 0
    ? lps.reduce((max, { account }) => account.capital > max ? account.capital : max, 0n) : 1n;

  return (
    <div className="p-4">
      {/* Price ladder */}
      <div className="mb-4 grid grid-cols-3 gap-px overflow-hidden rounded-lg bg-[#1a1d2a]">
        <div className="bg-[#080a0f] p-3 text-center">
          <p className="text-[9px] uppercase tracking-wider text-[#4a5068]">Bid</p>
          <p className="data-cell text-sm font-medium text-[#00e68a]">${(bestBid / 1_000_000).toFixed(6)}</p>
        </div>
        <div className="bg-[#080a0f] p-3 text-center">
          <p className="text-[9px] uppercase tracking-wider text-[#4a5068]">Oracle</p>
          <p className="data-cell text-sm font-medium text-[#e8eaf0]">{formatUsd(oraclePrice)}</p>
        </div>
        <div className="bg-[#080a0f] p-3 text-center">
          <p className="text-[9px] uppercase tracking-wider text-[#4a5068]">Ask</p>
          <p className="data-cell text-sm font-medium text-[#ff4d6a]">${(bestAsk / 1_000_000).toFixed(6)}</p>
        </div>
      </div>

      {/* Depth bars */}
      <div className="mb-4 grid grid-cols-2 gap-2">
        <div className="rounded-md bg-[#00e68a]/5 p-2.5 text-center ring-1 ring-[#00e68a]/10">
          <p className="text-[9px] uppercase tracking-wider text-[#00e68a]/60">Bid Depth</p>
          <p className="data-cell text-sm font-semibold text-[#00e68a]">{formatTokenAmount(lpTotalCapital)}</p>
        </div>
        <div className="rounded-md bg-[#ff4d6a]/5 p-2.5 text-center ring-1 ring-[#ff4d6a]/10">
          <p className="text-[9px] uppercase tracking-wider text-[#ff4d6a]/60">Ask Depth</p>
          <p className="data-cell text-sm font-semibold text-[#ff4d6a]">{formatTokenAmount(lpTotalCapital)}</p>
        </div>
      </div>

      {/* LP table */}
      {lps.length > 0 && (
        <div>
          <div className="mb-1 flex text-[9px] uppercase tracking-wider text-[#2a2f40]">
            <span className="w-6">#</span>
            <span className="flex-1">LP</span>
            <span className="w-24 text-right">Capital</span>
            <span className="w-24 text-right">Net Pos</span>
            <span className="w-20" />
          </div>
          {lps.map(({ idx, account }, i) => {
            const pct = maxLpCapital > 0n ? Number(account.capital * 100n / maxLpCapital) : 0;
            return (
              <div key={idx} className="flex items-center border-t border-[#1a1d2a]/30 py-1.5 text-[11px]">
                <span className="w-6 text-[#2a2f40]">{i + 1}</span>
                <span className="data-cell flex-1 text-[#4a5068]">{shortenAddress(account.owner.toBase58())}</span>
                <span className="data-cell w-24 text-right text-[#e8eaf0]">{formatTokenAmount(account.capital)}</span>
                <span className={`data-cell w-24 text-right ${account.positionSize >= 0n ? "text-[#00e68a]" : "text-[#ff4d6a]"}`}>
                  {formatTokenAmount(account.positionSize < 0n ? -account.positionSize : account.positionSize)}
                </span>
                <span className="w-20 pl-3">
                  <div className="h-1 rounded-full bg-[#1a1d2a]">
                    <div className="h-1 rounded-full bg-[#00d4aa]/50" style={{ width: `${pct}%` }} />
                  </div>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
