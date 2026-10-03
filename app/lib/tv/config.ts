/**
 * Which chart engine the trade page renders.
 *
 * TradingView Advanced Charts is the default whenever the library was
 * deployed with this build (NEXT_PUBLIC_TV_LIBRARY_VERSION is set by
 * next.config.ts from what scripts/fetch-tv-library.mjs installed). The
 * built-in lightweight-charts chart ("lwc") is the automatic fallback: builds
 * without the library, a load/ready timeout, or a runtime error.
 *
 * Overrides, strongest first:
 *   NEXT_PUBLIC_CHART_ENGINE=lwc   build-time kill switch (rollback without removing the token)
 *   ?chart=lwc | ?chart=tv         per-visit, for support and comparison
 */

export type ChartEngine = "tv" | "lwc";

/** Public path the library is served from (gitignored public/ folder). */
export const TV_LIBRARY_PATH = "/charting_library/";
export const TV_LOADER_SRC = `${TV_LIBRARY_PATH}charting_library.standalone.js`;
/** Our theme CSS for the chart iframe (committed; outside the library folder). */
export const TV_CUSTOM_CSS_URL = "/tv-theme/percolator.css";

/** Script must load within this, or the page falls back to the lwc chart. */
export const TV_LOAD_TIMEOUT_MS = 8_000;
/** chartReady() must resolve within this, or the page falls back. */
export const TV_READY_TIMEOUT_MS = 15_000;

export function tvLibraryVersion(): string {
  return process.env.NEXT_PUBLIC_TV_LIBRARY_VERSION ?? "";
}

export interface EngineInputs {
  /** NEXT_PUBLIC_TV_LIBRARY_VERSION — empty when the build has no library. */
  libraryVersion: string;
  /** NEXT_PUBLIC_CHART_ENGINE. */
  envEngine: string | undefined;
  /** The `chart` query parameter, if any. */
  query: string | null;
}

/** Pure engine choice. A missing library always wins over any request for TV. */
export function selectChartEngine({ libraryVersion, envEngine, query }: EngineInputs): ChartEngine {
  if (!libraryVersion) return "lwc";
  if (envEngine === "lwc") return "lwc";
  if (query === "lwc") return "lwc";
  return "tv";
}
