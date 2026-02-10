"use client";

import { FC } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { formatTokenAmount, formatUsd, formatBps } from "@/lib/format";
import { useLivePrice } from "@/hooks/useLivePrice";

export const MarketStatsCard: FC = () => {
  const { engine, params, loading } = useEngineState();
  const { config: mktConfig } = useSlabState();
  const config = useMarketConfig();
  const { priceE6: livePriceE6 } = useLivePrice();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const symbol = tokenMeta?.symbol ?? "Token";

  if (loading || !engine || !config || !params) {
    return (
      <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-5">
        <p className="text-sm text-[var(--text-secondary)]">{loading ? "Loading..." : "Market not loaded"}</p>
      </div>
    );
  }

  const stats = [
    { label: `${symbol} Price`, value: formatUsd(livePriceE6 ?? config.lastEffectivePriceE6) },
    { label: "Open Interest", value: `${formatTokenAmount(engine.totalOpenInterest)}` },
    { label: "Vault", value: `${formatTokenAmount(engine.vault)}` },
    { label: "Trading Fee", value: formatBps(params.tradingFeeBps) },
    { label: "Init. Margin", value: formatBps(params.initialMarginBps) },
    { label: "Accounts", value: engine.numUsedAccounts.toString() },
  ];

  return (
    <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-5">
      <h3 className="mb-4 text-xs font-medium uppercase tracking-wider text-[var(--text-secondary)]">Market Stats</h3>
      <div className="grid grid-cols-3 gap-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-sm p-2 transition-colors duration-150 hover:bg-[var(--accent)]/[0.06]">
            <p className="text-[10px] uppercase text-[var(--text-muted)]">{s.label}</p>
            <p className="text-sm font-medium text-[var(--text)]">{s.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
};
