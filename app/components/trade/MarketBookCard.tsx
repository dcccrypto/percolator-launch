"use client";

import { FC, useMemo } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useOrderBookVisibility } from "@/hooks/useOrderBookVisibility";
import { formatUsdPriceE6, formatTokenAmount, shortenAddress } from "@/lib/format";
import { resolveMarketPriceE6 } from "@/lib/oraclePrice";
import { AccountKind } from "@percolatorct/sdk";

const LP_TABLE_CAP = 5;

export const MarketBookCard: FC = () => {
  const { engine, params, loading } = useEngineState();
  const config = useMarketConfig();
  const { accounts, config: mktConfig } = useSlabState();
  const { priceE6: livePriceE6 } = useLivePrice();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const symbol = tokenMeta?.symbol ?? "Token";
  const decimals = tokenMeta?.decimals ?? 6;
  const [, toggleBook] = useOrderBookVisibility();

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

  const oraclePrice = livePriceE6 ?? (mktConfig ? resolveMarketPriceE6(mktConfig) : 0n);
  const feeBps = Number(params.tradingFeeBps ?? 0n);
  const bestBidE6 = oraclePrice > 0n ? BigInt(Math.round(Number(oraclePrice) * (1 - feeBps / 10000))) : 0n;
  const bestAskE6 = oraclePrice > 0n ? BigInt(Math.round(Number(oraclePrice) * (1 + feeBps / 10000))) : 0n;

  // 2.2: Spread (BigInt)
  const spreadE6 = bestAskE6 - bestBidE6;
  const spreadUsd = Number(spreadE6) / 1_000_000;
  const oraclePriceUsd = Number(oraclePrice) / 1_000_000;
  const spreadPct = oraclePriceUsd > 0 ? (spreadUsd / oraclePriceUsd) * 100 : 0;

  const lpTotalCapital = lps.reduce((sum, { account }) => sum + account.capital, 0n);

  // 2.3: Depth — bid side = total LP capital; ask side = LP capital - open long positions (clamped ≥ 0)
  const openLongPositions = engine.totalOpenInterest > 0n ? engine.totalOpenInterest : 0n;
  const askDepth = lpTotalCapital > openLongPositions
    ? lpTotalCapital - openLongPositions
    : 0n;

  // Pool utilisation for fill bars: openLong / totalCapital
  const bidUtilPct = lpTotalCapital > 0n
    ? Math.min(100, Number(openLongPositions * 100n / lpTotalCapital))
    : 0;
  const askUtilPct = lpTotalCapital > 0n
    ? Math.min(100, Number((lpTotalCapital - askDepth) * 100n / lpTotalCapital))
    : 0;

  // 2.4: Per-LP utilisation = positionSize / capital
  const maxLpCapital = lps.length > 0
    ? lps.reduce((max, { account }) => account.capital > max ? account.capital : max, 0n) : 1n;

  const displayedLps = lps.slice(0, LP_TABLE_CAP);
  const hiddenLpCount = Math.max(0, lps.length - LP_TABLE_CAP);

  return (
    <div className="p-3">
      {/* Header with hide control — lets the user collapse the order book
          when they prefer a cleaner trade view. Persists via localStorage. */}
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[9px] font-semibold uppercase tracking-[0.15em] text-[var(--text)]">
          Order Book
        </span>
        <button
          type="button"
          onClick={toggleBook}
          aria-label="Hide order book"
          title="Hide order book"
          className="rounded-none border border-[var(--border)]/40 px-1.5 py-0.5 text-[10px] leading-none text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text)] focus-visible:ring-1 focus-visible:ring-[var(--accent)]/30"
        >
          ×
        </button>
      </div>

      {/* 2.1: Price ladder — bigger fonts */}
      <div className="mb-2 grid grid-cols-3 gap-px border border-[var(--border)]/30">
        {/* Bid */}
        <div className="bg-[var(--bg)] p-2 text-center">
          <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text)]">Bid</p>
          <p className="text-[11px] font-medium text-[var(--long)]" style={{ fontFamily: "var(--font-mono)" }}>{formatUsdPriceE6(bestBidE6)}</p>
        </div>
        {/* Oracle — subtle accent border + bg */}
        <div className="p-2 text-center border-x border-[var(--accent)]/20 bg-[var(--accent)]/[0.03]">
          <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text)]">Oracle</p>
          <p
            className="text-[13px] font-medium text-[var(--text)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {formatUsdPriceE6(oraclePrice)}
          </p>
        </div>
        {/* Ask */}
        <div className="bg-[var(--bg)] p-2 text-center">
          <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text)]">Ask</p>
          <p className="text-[11px] font-medium text-[var(--short)]" style={{ fontFamily: "var(--font-mono)" }}>{formatUsdPriceE6(bestAskE6)}</p>
        </div>
      </div>

      {/* 2.2: Spread row */}
      {oraclePrice > 0n && (
        <div className="mb-3 flex items-center justify-between px-0.5">
          <span className="text-[9px] uppercase tracking-[0.12em] text-[var(--text)] font-mono">Spread</span>
          <span className="text-[9px] text-[var(--text)] font-mono">
            ${spreadUsd.toFixed(spreadUsd < 0.001 ? 6 : 4)}{" "}
            <span className="text-[var(--text-secondary)]">({spreadPct.toFixed(3)}%)</span>
          </span>
        </div>
      )}

      {/* 2.3: Depth bars — differentiated bid/ask with fill bar */}
      <div className="mb-3 grid grid-cols-2 gap-1">
        <div className="rounded-none border border-[var(--long)]/10 bg-[var(--long)]/5 p-2">
          <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--long)]/60">Bid Depth</p>
          <p
            className="text-[11px] font-semibold text-[var(--long)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {formatTokenAmount(lpTotalCapital, decimals)}
          </p>
          {/* 3px utilisation fill bar */}
          <div className="mt-1.5 h-[3px] w-full bg-[var(--border)]/20 overflow-hidden">
            <div
              className="h-full bg-[var(--long)]/40 transition-all duration-500"
              style={{ width: `${bidUtilPct}%` }}
            />
          </div>
        </div>
        <div className="rounded-none border border-[var(--short)]/10 bg-[var(--short)]/5 p-2">
          <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--short)]/60">Ask Depth</p>
          <p
            className="text-[11px] font-semibold text-[var(--short)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {formatTokenAmount(askDepth, decimals)}
          </p>
          {/* 3px utilisation fill bar */}
          <div className="mt-1.5 h-[3px] w-full bg-[var(--border)]/20 overflow-hidden">
            <div
              className="h-full bg-[var(--short)]/40 transition-all duration-500"
              style={{ width: `${askUtilPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* 2.4: LP table — with UTILISATION column, capped at 5 */}
      {lps.length > 0 && (
        <div>
          {/* Header */}
          <div className="mb-1 flex gap-1 text-[8px] uppercase tracking-[0.1em] text-[var(--text)] font-medium">
            <span className="w-5">#</span>
            <span className="flex-1">L.P.</span>
            <span className="w-20 text-right">Capital</span>
            <span className="w-20 text-right">Net Pos</span>
            <span className="w-16 text-right">Util</span>
          </div>
          <div className="divide-y divide-[var(--border)]/15">
            {displayedLps.map(({ idx, account }, i) => {
              const capPct = maxLpCapital > 0n ? Number(account.capital * 100n / maxLpCapital) : 0;
              // Utilisation = abs(positionSize) / capital
              const utilPct = account.capital > 0n
                ? Math.min(100, Number(
                    (account.positionSize < 0n ? -account.positionSize : account.positionSize)
                    * 100n / account.capital
                  ))
                : 0;
              const utilColor = utilPct > 80
                ? "text-[var(--short)]"
                : utilPct > 50
                  ? "text-amber-400"
                  : "text-[var(--text-dim)]";

              return (
                <div key={idx} className="flex items-center gap-1 py-1 text-[10px]">
                  <span className="w-5 text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>{i + 1}</span>
                  <span className="flex-1 text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>{shortenAddress(account.owner.toBase58())}</span>
                  <span className="w-20 text-right text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{formatTokenAmount(account.capital, decimals)}</span>
                  <span className={`w-20 text-right ${account.positionSize >= 0n ? "text-[var(--long)]" : "text-[var(--short)]"}`} style={{ fontFamily: "var(--font-mono)" }}>
                    {formatTokenAmount(account.positionSize < 0n ? -account.positionSize : account.positionSize, decimals)}
                  </span>
                  <span className={`w-16 text-right font-medium ${utilColor}`} style={{ fontFamily: "var(--font-mono)" }}>
                    {utilPct.toFixed(1)}%
                  </span>
                </div>
              );
            })}
            {/* +N more row */}
            {hiddenLpCount > 0 && (
              <div className="py-1 text-center">
                <span className="text-[9px] text-[var(--text-secondary)]">+{hiddenLpCount} more</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
