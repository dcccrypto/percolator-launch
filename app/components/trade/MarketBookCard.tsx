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
      <div className="rounded-xl border border-[#1e1e2e] bg-[#12121a] p-5">
        <p className="text-sm text-[#71717a]">{loading ? "Loading..." : "Market not loaded"}</p>
      </div>
    );
  }

  const oraclePrice = livePriceE6 ?? config.lastEffectivePriceE6;
  const feeBps = Number(params.tradingFeeBps);
  const bestBid = oraclePrice > 0n ? Number(oraclePrice) * (1 - feeBps / 10000) : 0;
  const bestAsk = oraclePrice > 0n ? Number(oraclePrice) * (1 + feeBps / 10000) : 0;

  // LP depth = sum of LP capital
  const lpTotalCapital = lps.reduce((sum, { account }) => sum + account.capital, 0n);

  // Max depth for bar scaling
  const maxLpCapital = lps.length > 0
    ? lps.reduce((max, { account }) => account.capital > max ? account.capital : max, 0n)
    : 1n;

  return (
    <div className="rounded-xl border border-[#1e1e2e] bg-[#12121a] p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wider text-[#71717a]">Market Book</h3>
        <span className="rounded-full bg-[#1a1a2e] px-2 py-0.5 text-xs text-[#71717a]">
          {lps.length} LP{lps.length !== 1 ? "s" : ""} quoting
        </span>
      </div>

      {/* Price ladder */}
      <div className="mb-4 flex items-center justify-between rounded-lg bg-[#1a1a28] px-3 py-2.5">
        <div className="text-center">
          <p className="text-[10px] uppercase text-[#52525b]">Best Bid</p>
          <p className="font-mono text-sm font-medium text-emerald-400">
            ${(bestBid / 1_000_000).toFixed(6)}
          </p>
        </div>
        <div className="text-center">
          <p className="text-[10px] uppercase text-[#52525b]">Oracle</p>
          <p className="font-mono text-sm font-medium text-[#e4e4e7]">
            {formatUsd(oraclePrice)}
          </p>
        </div>
        <div className="text-center">
          <p className="text-[10px] uppercase text-[#52525b]">Best Ask</p>
          <p className="font-mono text-sm font-medium text-red-400">
            ${(bestAsk / 1_000_000).toFixed(6)}
          </p>
        </div>
      </div>

      {/* Depth summary */}
      <div className="mb-4 flex gap-2">
        <div className="flex-1 rounded-lg bg-emerald-900/20 p-2 text-center">
          <p className="text-[10px] uppercase text-emerald-400/70">Bid Depth</p>
          <p className="text-sm font-medium text-emerald-400">{formatTokenAmount(lpTotalCapital)}</p>
        </div>
        <div className="flex-1 rounded-lg bg-red-900/20 p-2 text-center">
          <p className="text-[10px] uppercase text-red-400/70">Ask Depth</p>
          <p className="text-sm font-medium text-red-400">{formatTokenAmount(lpTotalCapital)}</p>
        </div>
      </div>

      {/* LP table */}
      {lps.length > 0 && (
        <div>
          <div className="mb-1 flex text-[10px] uppercase text-[#52525b]">
            <span className="w-6">#</span>
            <span className="flex-1">LP</span>
            <span className="w-24 text-right">Capital</span>
            <span className="w-24 text-right">Net Pos</span>
            <span className="w-16" />
          </div>
          {lps.map(({ idx, account }, i) => {
            const pct = maxLpCapital > 0n ? Number(account.capital * 100n / maxLpCapital) : 0;
            return (
              <div key={idx} className="flex items-center py-1 text-xs">
                <span className="w-6 text-[#52525b]">{i + 1}</span>
                <span className="flex-1 font-mono text-[#71717a]">{shortenAddress(account.owner.toBase58())}</span>
                <span className="w-24 text-right text-[#e4e4e7]">{formatTokenAmount(account.capital)}</span>
                <span className={`w-24 text-right ${account.positionSize >= 0n ? "text-emerald-400" : "text-red-400"}`}>
                  {formatTokenAmount(account.positionSize < 0n ? -account.positionSize : account.positionSize)}
                </span>
                <span className="w-16 pl-2">
                  <div className="h-1.5 rounded-full bg-[#1a1a2e]">
                    <div className="h-1.5 rounded-full bg-blue-500/60" style={{ width: `${pct}%` }} />
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
