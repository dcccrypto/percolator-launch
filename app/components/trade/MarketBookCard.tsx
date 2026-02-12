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
      <div className="p-3">
        <p className="text-[10px] text-[var(--text-muted)]">{loading ? "Loading…" : "—"}</p>
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
    <div className="p-3">
      {/* Price ladder */}
      <div className="mb-3 grid grid-cols-3 gap-px border border-[var(--border)]/30">
        <div className="bg-[var(--bg)] p-2 text-center">
          <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Bid</p>
          <p className="text-[11px] font-medium text-[var(--long)]" style={{ fontFamily: "var(--font-mono)" }}>${(bestBid / 1_000_000).toFixed(6)}</p>
        </div>
        <div className="bg-[var(--bg)] p-2 text-center border-x border-[var(--border)]/20">
          <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Oracle</p>
          <p className="text-[11px] font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{formatUsd(oraclePrice)}</p>
        </div>
        <div className="bg-[var(--bg)] p-2 text-center">
          <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Ask</p>
          <p className="text-[11px] font-medium text-[var(--short)]" style={{ fontFamily: "var(--font-mono)" }}>${(bestAsk / 1_000_000).toFixed(6)}</p>
        </div>
      </div>

      {/* Depth bars */}
      <div className="mb-3 grid grid-cols-2 gap-1">
        <div className="rounded-none border border-[var(--long)]/10 bg-[var(--long)]/5 p-2 text-center">
          <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--long)]/60">Bid Depth</p>
          <p className="text-[11px] font-semibold text-[var(--long)]" style={{ fontFamily: "var(--font-mono)" }}>{formatTokenAmount(lpTotalCapital)}</p>
        </div>
        <div className="rounded-none border border-[var(--short)]/10 bg-[var(--short)]/5 p-2 text-center">
          <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--short)]/60">Ask Depth</p>
          <p className="text-[11px] font-semibold text-[var(--short)]" style={{ fontFamily: "var(--font-mono)" }}>{formatTokenAmount(lpTotalCapital)}</p>
        </div>
      </div>

      {/* LP table */}
      {lps.length > 0 && (
        <div>
          <div className="mb-1 flex text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
            <span className="w-5">#</span>
            <span className="flex-1">LP</span>
            <span className="w-20 text-right">Capital</span>
            <span className="w-20 text-right">Net Pos</span>
            <span className="w-16" />
          </div>
          <div className="divide-y divide-[var(--border)]/15">
            {lps.map(({ idx, account }, i) => {
              const pct = maxLpCapital > 0n ? Number(account.capital * 100n / maxLpCapital) : 0;
              return (
                <div key={idx} className="flex items-center py-1 text-[10px]">
                  <span className="w-5 text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>{i + 1}</span>
                  <span className="flex-1 text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>{shortenAddress(account.owner.toBase58())}</span>
                  <span className="w-20 text-right text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{formatTokenAmount(account.capital)}</span>
                  <span className={`w-20 text-right ${account.positionSize >= 0n ? "text-[var(--long)]" : "text-[var(--short)]"}`} style={{ fontFamily: "var(--font-mono)" }}>
                    {formatTokenAmount(account.positionSize < 0n ? -account.positionSize : account.positionSize)}
                  </span>
                  <span className="w-16 pl-2">
                    <div className="h-[2px] bg-[var(--border)]/30">
                      <div className="h-[2px] bg-[var(--long)]/50" style={{ width: `${pct}%` }} />
                    </div>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
