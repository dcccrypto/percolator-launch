/**
 * Loads the TradingView standalone loader with a <script> tag, once per page.
 *
 * Deliberately NOT an `import`: the library is not in the repo (licence), so
 * the bundler must never try to resolve it, and our JS bundle stays the same
 * size. The loader defines `window.TradingView`; everything else it needs it
 * fetches itself into its own same-origin iframe.
 */
import type { TvGlobal } from "./types";
import { TV_LOADER_SRC, TV_LOAD_TIMEOUT_MS } from "./config";

declare global {
  interface Window {
    TradingView?: TvGlobal;
  }
}

let pending: Promise<TvGlobal> | null = null;

function isTvGlobal(v: unknown): v is TvGlobal {
  return typeof v === "object" && v !== null && typeof (v as { widget?: unknown }).widget === "function";
}

export class TvLoadError extends Error {
  constructor(
    message: string,
    readonly reason: "timeout" | "script-error" | "no-global" | "no-dom",
  ) {
    super(message);
    this.name = "TvLoadError";
  }
}

/**
 * Resolves with `window.TradingView`. Rejects (TvLoadError) when the script
 * fails, does not define the global, or takes longer than `timeoutMs`. A
 * rejection is remembered for the page session — the caller falls back to the
 * built-in chart rather than retrying on every render.
 */
export function loadTradingView(src: string = TV_LOADER_SRC, timeoutMs: number = TV_LOAD_TIMEOUT_MS): Promise<TvGlobal> {
  if (pending) return pending;
  pending = new Promise<TvGlobal>((resolve, reject) => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      reject(new TvLoadError("no DOM", "no-dom"));
      return;
    }
    if (isTvGlobal(window.TradingView)) {
      resolve(window.TradingView);
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.tvLoader = "1";
    const timer = window.setTimeout(() => {
      reject(new TvLoadError(`chart library did not load within ${timeoutMs}ms`, "timeout"));
    }, timeoutMs);
    script.onload = () => {
      window.clearTimeout(timer);
      if (isTvGlobal(window.TradingView)) resolve(window.TradingView);
      else reject(new TvLoadError("chart library loaded but defined no TradingView global", "no-global"));
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      reject(new TvLoadError("chart library script failed to load", "script-error"));
    };
    document.head.appendChild(script);
  });
  return pending;
}

/** Test-only: forget the singleton. */
export function resetTradingViewLoaderForTests(): void {
  pending = null;
}
