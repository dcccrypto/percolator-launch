"use client";

import { FC, useState } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useUsdToggle } from "@/components/providers/UsdToggleProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { formatTokenAmount, formatUsd, formatBps } from "@/lib/format";
import { useLivePrice } from "@/hooks/useLivePrice";
import { FundingRateCard } from "./FundingRateCard";
import { FundingRateChart } from "./FundingRateChart";
import { OpenInterestCard } from "../market/OpenInterestCard";
import { InsuranceDashboard } from "../market/InsuranceDashboard";

function formatNum(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const MarketStatsCard: FC = () => {
  const { engine, params, loading } = useEngineState();
  const { config: mktConfig, slabAddress } = useSlabState();
  const config = useMarketConfig();
  const { priceE6: livePriceE6, priceUsd } = useLivePrice();
  const { showUsd } = useUsdToggle();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const symbol = tokenMeta?.symbol ?? "Token";
  const [showFundingChart, setShowFundingChart] = useState(false);
  const [activeTab, setActiveTab] = useState<"stats" | "advanced">("stats");

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
    <div className="space-y-1.5">
      {/* Tab Navigation */}
      <div className="flex gap-1">
        <button
          onClick={() => setActiveTab("stats")}
          className={`flex-1 rounded-none border px-3 py-2 text-[10px] font-medium uppercase tracking-[0.1em] transition-colors ${
            activeTab === "stats"
              ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
              : "border-[var(--border)]/50 bg-[var(--bg)]/80 text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text)]"
          }`}
        >
          Stats
        </button>
        <button
          onClick={() => setActiveTab("advanced")}
          className={`flex-1 rounded-none border px-3 py-2 text-[10px] font-medium uppercase tracking-[0.1em] transition-colors ${
            activeTab === "advanced"
              ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
              : "border-[var(--border)]/50 bg-[var(--bg)]/80 text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text)]"
          }`}
        >
          Advanced
        </button>
      </div>

      {/* Stats Tab */}
      {activeTab === "stats" && (
        <>
          {/* Market Stats Grid */}
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

          {/* Funding Rate Section */}
          {slabAddress && (
            <>
              <FundingRateCard slabAddress={slabAddress} />
              
              {/* Funding Chart Toggle */}
              <button
                onClick={() => setShowFundingChart(!showFundingChart)}
                className="w-full rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text)]"
              >
                {showFundingChart ? "Hide" : "Show"} Funding History
              </button>
              
              {showFundingChart && <FundingRateChart slabAddress={slabAddress} />}
            </>
          )}
        </>
      )}

      {/* Advanced Tab */}
      {activeTab === "advanced" && slabAddress && (
        <>
          <OpenInterestCard slabAddress={slabAddress} />
          <InsuranceDashboard slabAddress={slabAddress} />
        </>
      )}
    </div>
  );
};
