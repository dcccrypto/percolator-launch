"use client";

import { FC } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { useSlabState } from "@/components/providers/SlabProvider";
import { formatTokenAmount, formatUsd, formatBps } from "@/lib/format";

export const MarketStats: FC = () => {
  const { engine, params, loading } = useEngineState();
  const config = useMarketConfig();

  if (loading || !engine || !config || !params) {
    return (
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.05] p-6">
        <p className="text-[#3D4563]">{loading ? "Loading..." : "Market not loaded"}</p>
      </div>
    );
  }

  const stats = [
    { label: "Oracle Price", value: formatUsd(config.lastEffectivePriceE6) },
    { label: "Open Interest", value: formatTokenAmount(engine.totalOpenInterest) },
    { label: "Vault Balance", value: formatTokenAmount(engine.vault) },
    { label: "Trading Fee", value: formatBps(params.tradingFeeBps) },
    { label: "Maintenance Margin", value: formatBps(params.maintenanceMarginBps) },
    { label: "Accounts", value: engine.numUsedAccounts.toString() },
  ];

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.05] p-6">
      <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-[#3D4563]">Market Stats</h3>
      <div className="grid grid-cols-2 gap-4">
        {stats.map((s) => (
          <div key={s.label}>
            <p className="text-xs text-[#3D4563]">{s.label}</p>
            <p className="text-sm font-medium text-white">{s.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
};
