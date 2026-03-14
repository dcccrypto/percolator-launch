/**
 * Client-side blocklist for known-bad / stale market slab addresses.
 *
 * These are markets that have been blocked in the API route
 * (app/api/markets/route.ts HARDCODED_BLOCKED_MARKETS) but whose rows
 * are still visible via the Supabase anon client in
 * markets_with_stats. Any hook or page that queries the view directly
 * MUST filter these out before rendering or aggregating values.
 *
 * Keep in sync with the server-side HARDCODED_BLOCKED_MARKETS set in
 * app/api/markets/route.ts.
 */
export const BLOCKED_SLAB_ADDRESSES: ReadonlySet<string> = new Set([
  // Stale SOL/USD slab — on-chain slab no longer exists; shows $100 last_price
  // causing "Failed to load market" on click. Blocked via PR #1179.
  "BxJPaMaCfEGTBsjZ8wfj3Yfzf4wpasmxKAEvqZZRcGPP",
]);

/**
 * Returns true if the slab address should be excluded from UI rendering.
 */
export function isBlockedSlab(slabAddress: string | null | undefined): boolean {
  if (!slabAddress) return false;
  return BLOCKED_SLAB_ADDRESSES.has(slabAddress);
}
