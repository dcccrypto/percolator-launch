"use client";

/**
 * Cross-navigation cache of market IDENTITY (symbol / name / logo / mainnet
 * CA), keyed by slab address — the naming sibling of lib/slabCache.ts (which
 * caches raw account BYTES for the same instant-open purpose).
 *
 * WHY: the trade page resolves its pair label from `/api/markets/[slab]`,
 * which arrives ~0.2-2s after the page renders. With the instant-open
 * navigation work the terminal now paints immediately, so whatever the
 * fallback chain produces is VISIBLE — and the old fallback (the collateral
 * token's symbol) named every market "USDC/USD" until the fetch landed, or
 * permanently when the fetch failed/returned no registry symbol. The
 * collateral mint is NEVER the traded pair's identity (every playground
 * market collateralizes with sim-USDC), so that fallback is gone; this cache
 * replaces it with the identity the user has almost always already seen —
 * the markets list, the market switcher, or a previous visit to the same
 * trade page all know the real symbol and write it here.
 *
 * Identity is effectively immutable for a market's lifetime, so entries
 * never expire; last write wins. Module-level = session-lifetime, shared by
 * every route in the client bundle.
 */

export interface MarketIdentity {
  symbol?: string;
  name?: string;
  logo_url?: string;
  mainnet_ca?: string | null;
}

const cache = new Map<string, MarketIdentity>();

export function getMarketIdentity(slab: string): MarketIdentity | null {
  return cache.get(slab) ?? null;
}

/** Merge-write: later sources may know MORE fields (e.g. the markets list
 *  knows symbol+logo, the trade-page meta fetch adds mainnet_ca) — never
 *  let a sparser write erase a field a richer one already provided. */
export function setMarketIdentity(slab: string, identity: MarketIdentity): void {
  const prev = cache.get(slab);
  const merged: MarketIdentity = { ...prev };
  if (identity.symbol) merged.symbol = identity.symbol;
  if (identity.name) merged.name = identity.name;
  if (identity.logo_url) merged.logo_url = identity.logo_url;
  if (identity.mainnet_ca !== undefined && identity.mainnet_ca !== null) merged.mainnet_ca = identity.mainnet_ca;
  cache.set(slab, merged);
}
