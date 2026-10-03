"use client";

/**
 * Trade-page chart: TradingView Advanced Charts by default, the built-in
 * lightweight-charts chart as the automatic fallback.
 *
 * Falls back (for the rest of the page session) when:
 *   - this build has no library (no TV_LIBRARY_TOKEN at build time — fork PRs, CI, most local dev)
 *   - NEXT_PUBLIC_CHART_ENGINE=lwc (rollback switch) or ?chart=lwc
 *   - the library script fails or takes > 8 s, chartReady takes > 15 s, or the widget throws
 *   - the TradingView subtree throws during render (ErrorBoundary)
 */
import { FC, memo, useCallback, useState } from "react";
import dynamic from "next/dynamic";
import * as Sentry from "@sentry/nextjs";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { selectChartEngine, tvLibraryVersion, type ChartEngine } from "@/lib/tv/config";
import { TvChartPanel } from "./tv/TvChartPanel";

// The fallback chart (and lightweight-charts with it) is only downloaded when it is used.
const TradingChart = dynamic(() => import("./TradingChart").then((m) => m.TradingChart), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse rounded-sm border border-[var(--border)] bg-[var(--panel-bg)]" />,
});

function initialEngine(): ChartEngine {
  let query: string | null = null;
  try {
    query = new URLSearchParams(window.location.search).get("chart");
  } catch {
    /* no window */
  }
  return selectChartEngine({
    libraryVersion: tvLibraryVersion(),
    envEngine: process.env.NEXT_PUBLIC_CHART_ENGINE,
    query,
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

const ChartSwitchInner: FC<{ slabAddress: string; mintAddress?: string }> = ({ slabAddress, mintAddress }) => {
  // Lazy initial state: this component is client-only (dynamic ssr:false), so window exists.
  const [engine, setEngine] = useState<ChartEngine>(initialEngine);

  const fallBack = useCallback((reason: string) => {
    reportFallback(reason);
    setEngine("lwc");
  }, []);

  if (engine === "lwc") {
    return <TradingChart slabAddress={slabAddress} mintAddress={mintAddress} />;
  }
  return (
    <ErrorBoundary label="TvChart" fallback={<TradingChart slabAddress={slabAddress} mintAddress={mintAddress} />}>
      {/* key: each market has its own saved layout, so a market switch builds a fresh widget */}
      <TvChartPanel key={slabAddress} slabAddress={slabAddress} onFailure={fallBack} />
    </ErrorBoundary>
  );
};

/** Memoized for the same reason as TradingChart: the trade page re-renders several times a second. */
export const ChartSwitch = memo(ChartSwitchInner);
