/**
 * Blocklist for known-bad / stale market slab addresses.
 *
 * SINGLE SOURCE OF TRUTH for both server-side API routes and client-side UI.
 * All hardcoded addresses live here. Runtime overrides come from the
 * NEXT_PUBLIC_BLOCKED_MARKET_ADDRESSES env var (comma-separated), which is
 * readable by both server and client code.
 *
 * GH#1539: Previously the API routes also read BLOCKED_MARKET_ADDRESSES (server-only
 * env var) while the UI only read this hardcoded set, causing a count mismatch
 * (e.g. 170 UI vs 168 API). Fix: unified env var with NEXT_PUBLIC_ prefix so both
 * sides see the same blocklist.
 */
import { HARDCODED_BLOCKED_SLABS } from "./blocklist-data";


/**
 * Combined blocklist: hardcoded + NEXT_PUBLIC_BLOCKED_MARKET_ADDRESSES env var.
 *
 * GH#1539: Both API routes and client-side UI use this single set, eliminating
 * the server-only BLOCKED_MARKET_ADDRESSES env var that caused count drift.
 * Migrate any existing BLOCKED_MARKET_ADDRESSES values to
 * NEXT_PUBLIC_BLOCKED_MARKET_ADDRESSES for parity.
 */
export const BLOCKED_SLAB_ADDRESSES: ReadonlySet<string> = new Set([
  ...HARDCODED_BLOCKED_SLABS,
  ...(
    (typeof process !== "undefined" ? process.env?.NEXT_PUBLIC_BLOCKED_MARKET_ADDRESSES : undefined) ?? ""
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // GH#1539 backwards compat: also read the old server-only env var so API routes
  // don't lose overrides until deployment configs are migrated.
  ...(
    (typeof process !== "undefined" ? process.env?.BLOCKED_MARKET_ADDRESSES : undefined) ?? ""
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]);

/**
 * Returns true if the slab address should be excluded from UI rendering.
 */
export function isBlockedSlab(slabAddress: string | null | undefined): boolean {
  if (!slabAddress) return false;
  return BLOCKED_SLAB_ADDRESSES.has(slabAddress);
}

/**
 * GH#1539: Detect legacy env var drift at startup.
 *
 * If BLOCKED_MARKET_ADDRESSES (server-only) is populated but
 * NEXT_PUBLIC_BLOCKED_MARKET_ADDRESSES is not, the UI will silently miss
 * those entries (client code cannot read server-only env vars).  Warn loudly
 * so ops teams catch misconfigurations before they cause a UI/API count
 * mismatch again.
 *
 * Call this once from your app startup (e.g. instrumentation.ts) or rely
 * on the automatic check that fires during module initialisation below.
 */
export function validateBlocklist(): void {
  if (typeof process === "undefined") return; // edge / browser — skip
  const serverOnly = (process.env.BLOCKED_MARKET_ADDRESSES ?? "").trim();
  const publicVar = (process.env.NEXT_PUBLIC_BLOCKED_MARKET_ADDRESSES ?? "").trim();
  if (serverOnly && !publicVar) {
    // eslint-disable-next-line no-console
    console.warn(
      "[blocklist] WARNING: BLOCKED_MARKET_ADDRESSES is set but " +
        "NEXT_PUBLIC_BLOCKED_MARKET_ADDRESSES is not. Client-side UI will NOT " +
        "see the server-only entries, which can recreate the GH#1539 UI/API " +
        "count mismatch. Migrate the value to NEXT_PUBLIC_BLOCKED_MARKET_ADDRESSES."
    );
  }
}

// NOTE: previously this module auto-ran `validateBlocklist()` at import time.
// blocklist.ts is imported by the Edge middleware, and a top-level side effect that
// reads a server-only env var (process.env.BLOCKED_MARKET_ADDRESSES) at module
// evaluation makes Vercel's Edge-Function analyzer reject the module ("referencing
// unsupported modules"). Call validateBlocklist() explicitly from a Node-runtime
// entrypoint (e.g. instrumentation.ts) instead of running it at import.
