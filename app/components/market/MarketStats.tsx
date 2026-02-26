"use client";

import { FC } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { useSlabState } from "@/components/providers/SlabProvider";
import { formatTokenAmount, formatUsd, formatBps } from "@/lib/format";
import { sanitizeAccountCount } from "@/lib/health";

export const MarketStats: FC = () => {
  const { engine, params, loading } = useEngineState();
  const config = useMarketConfig();

  if (loading || !engine || !config || !params) {
    return (
      <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-6">
        <p className="text-[var(--text-muted)]">{loading ? "Loading..." : "Market not loaded"}</p>
      </div>
    );
  }

  const stats = [
    { label: "Oracle Price", value: formatUsd(config.lastEffectivePriceE6) },
    { label: "Open Interest", value: formatTokenAmount(engine.totalOpenInterest) },
    { label: "Vault Balance", value: formatTokenAmount(engine.vault) },
    { label: "Trading Fee", value: formatBps(params.tradingFeeBps) },
    { label: "Maintenance Margin", value: formatBps(params.maintenanceMarginBps) },
    { label: "Accounts", value: sanitizeAccountCount(engine.numUsedAccounts ?? 0).toString() },
  ];

  return (
    <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-6">
      <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-[var(--text-muted)]">Market Stats</h3>
      <div className="grid grid-cols-2 gap-4">
        {stats.map((s) => (
          <div key={s.label}>
            <p className="text-xs text-[var(--text-muted)]">{s.label}</p>
            <p className="text-sm font-medium text-white">{s.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
};
