"use client";

import { FC } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useUsdToggle } from "@/components/providers/UsdToggleProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { formatTokenAmount, formatUsd, formatBps } from "@/lib/format";
import { useLivePrice } from "@/hooks/useLivePrice";

function formatNum(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const MarketStatsCard: FC = () => {
  const { engine, params, loading } = useEngineState();
  const { config: mktConfig } = useSlabState();
  const config = useMarketConfig();
  const { priceE6: livePriceE6, priceUsd } = useLivePrice();
  const { showUsd } = useUsdToggle();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const symbol = tokenMeta?.symbol ?? "Token";

  if (loading || !engine || !config || !params) {
    return (
      <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <p className="text-[10px] text-[var(--text-secondary)]">{loading ? "Loading..." : "Market not loaded"}</p>
      </div>
    );
  }

  const oiDisplay = showUsd && priceUsd != null
    ? formatNum((Number(engine.totalOpenInterest) / 1e6) * priceUsd)
    : formatTokenAmount(engine.totalOpenInterest);
  const vaultDisplay = showUsd && priceUsd != null
    ? formatNum((Number(engine.vault) / 1e6) * priceUsd)
    : formatTokenAmount(engine.vault);

  const stats = [
    { label: `${symbol} Price`, value: formatUsd(livePriceE6 ?? config.lastEffectivePriceE6) },
    { label: "Open Interest", value: oiDisplay },
    { label: "Vault", value: vaultDisplay },
    { label: "Trading Fee", value: formatBps(params.tradingFeeBps) },
    { label: "Init. Margin", value: formatBps(params.initialMarginBps) },
    { label: "Accounts", value: engine.numUsedAccounts.toString() },
  ];

  return (
    <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
      <div className="grid grid-cols-3 gap-px">
        {stats.map((s) => (
          <div key={s.label} className="p-2 border-b border-r border-[var(--border)]/20 last:border-r-0 [&:nth-child(3n)]:border-r-0 [&:nth-last-child(-n+3)]:border-b-0">
            <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)] truncate">{s.label}</p>
            <p className="text-[11px] font-medium text-[var(--text)] truncate" style={{ fontFamily: "var(--font-mono)" }}>{s.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
};
