"use client";

/**
 * The trade page's chart: TradingView Advanced Charts by default, the built-in lightweight-charts chart
 * as the automatic fallback. Both read the same perp datafeed (Mark / Oracle / Last, push-fed).
 *
 * TradingView is used when this build has the library (the build step installs it from Vercel Blob or a
 * private GitHub source, see scripts/fetch-tv-library.mjs). The built-in chart - the perp-standard
 * PerpChart when the price feed is configured, else the original TradingChart - takes over, for the rest of
 * the page session, when:
 *   - this build has no library (fork PRs, CI, most local dev)
 *   - NEXT_PUBLIC_CHART_ENGINE=lwc (rollback switch) or ?chart=lwc (?chart=legacy also asks for the old chart)
 *   - the library script fails or takes > 8 s, chartReady takes > 15 s, or the widget throws
 *   - the TradingView subtree throws during render (ErrorBoundary)
 */
import { FC, memo, useCallback, useState } from "react";
import * as Sentry from "@sentry/nextjs";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { chartQueryParam, selectBuiltInChart } from "@/lib/chart-engine";
import { selectChartEngine, tvLibraryVersion, type ChartEngine } from "@/lib/tv/config";
import { perpChartEnabled } from "@/lib/tv/data";
import { PerpChart } from "./perp/PerpChart";
import { TradingChart } from "./TradingChart";
import { TvChartPanel } from "./tv/TvChartPanel";

function initialEngine(): ChartEngine {
  return selectChartEngine({
    libraryVersion: tvLibraryVersion(),
    envEngine: process.env.NEXT_PUBLIC_CHART_ENGINE,
    query: chartQueryParam(),
  });
}

function reportFallback(reason: string): void {
  console.warn(`[ChartSwitch] TradingView chart unavailable (${reason}) — using the built-in chart.`);
  try {
    Sentry.captureMessage("chart_engine_fallback", { level: "warning", tags: { reason } });
  } catch {
    /* telemetry is optional */
  }
}

/** The built-in chart: perp-standard PerpChart, or the original TradingChart (?chart=legacy, rollback, no feed). */
function BuiltInChart({ slabAddress, mintAddress }: { slabAddress: string; mintAddress?: string }) {
  const [which] = useState(() => selectBuiltInChart({ perpEnabled: perpChartEnabled(), query: chartQueryParam() }));
  const legacy = <TradingChart slabAddress={slabAddress} mintAddress={mintAddress} />;
  if (which === "legacy") return legacy;
  return (
    <ErrorBoundary label="PerpChart" fallback={legacy}>
      <PerpChart slabAddress={slabAddress} mintAddress={mintAddress} />
    </ErrorBoundary>
  );
}

const ChartSwitchInner: FC<{ slabAddress: string; mintAddress?: string }> = ({ slabAddress, mintAddress }) => {
  // Lazy initial state: this component is client-only (dynamic ssr:false), so window exists.
  const [engine, setEngine] = useState<ChartEngine>(initialEngine);

  const fallBack = useCallback((reason: string) => {
    reportFallback(reason);
    setEngine("lwc");
  }, []);

  if (engine === "lwc") return <BuiltInChart slabAddress={slabAddress} mintAddress={mintAddress} />;
  return (
    <ErrorBoundary label="TvChart" fallback={<BuiltInChart slabAddress={slabAddress} mintAddress={mintAddress} />}>
      {/* key: each market has its own saved layout, so a market switch builds a fresh widget */}
      <TvChartPanel key={slabAddress} slabAddress={slabAddress} onFailure={fallBack} />
    </ErrorBoundary>
  );
};

/** Memoized: the trade page re-renders several times a second. */
export const ChartSwitch = memo(ChartSwitchInner);
