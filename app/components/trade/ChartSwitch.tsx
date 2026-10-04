"use client";

/**
 * The trade page's chart entry point. Renders the perp-standard chart (Mark / Oracle / Last, push-fed)
 * when the price feed is configured, else the original trade/DEX-built chart.
 *
 *   ?chart=legacy              the original chart (support / comparison)
 *   NEXT_PUBLIC_PERP_CHART=0   rollback switch
 *   no NEXT_PUBLIC_WS_URL      nothing to push from: the original chart
 *
 * A render error in the perp chart falls back to the original chart for the page session.
 */
import { FC, memo, useState } from "react";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { chartQueryParam, selectBuiltInChart } from "@/lib/chart-engine";
import { perpChartEnabled } from "@/lib/tv/data";
import { PerpChart } from "./perp/PerpChart";
import { TradingChart } from "./TradingChart";

const ChartSwitchInner: FC<{ slabAddress: string; mintAddress?: string }> = ({ slabAddress, mintAddress }) => {
  // Lazy initial state: this component is client-only (dynamic ssr:false), so window exists.
  const [which] = useState(() => selectBuiltInChart({ perpEnabled: perpChartEnabled(), query: chartQueryParam() }));
  const legacy = <TradingChart slabAddress={slabAddress} mintAddress={mintAddress} />;
  if (which === "legacy") return legacy;
  return (
    <ErrorBoundary label="PerpChart" fallback={legacy}>
      <PerpChart slabAddress={slabAddress} mintAddress={mintAddress} />
    </ErrorBoundary>
  );
};

/** Memoized: the trade page re-renders several times a second. */
export const ChartSwitch = memo(ChartSwitchInner);
