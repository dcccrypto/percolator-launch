"use client";

import { Connection, PublicKey } from "@solana/web3.js";

/**
 * Cross-navigation cache of raw slab account bytes, keyed by slab address.
 *
 * Purpose: make clicking a market feel INSTANT. Without this, opening
 * /trade/[slab] mounts SlabProvider, which does a fresh getAccountInfo (~200-500ms
 * on devnet) and shows a full-page skeleton until it lands. By warming this cache
 * on market-row hover (prefetchSlab) and seeding SlabProvider from it synchronously
 * on mount, the terminal renders immediately with no loading skeleton; the
 * provider's own poll then refreshes in the background (and byte-equality dedups
 * the no-op re-parse when the fetched bytes match the cached ones).
 */
type CachedSlab = { data: Uint8Array; owner: PublicKey; ts: number };

const cache = new Map<string, CachedSlab>();
const inflight = new Map<string, Promise<void>>();

/** How long a cached slab is considered fresh enough to seed the first render.
 *  The provider re-fetches immediately on mount regardless, so this only bounds
 *  how stale the ONE seed frame can be. */
const FRESH_MS = 20_000;

export function getCachedSlab(slab: string): CachedSlab | null {
  const e = cache.get(slab);
  if (!e) return null;
  if (dateNow() - e.ts > FRESH_MS) return null;
  return e;
}

export function setCachedSlab(slab: string, data: Uint8Array, owner: PublicKey): void {
  cache.set(slab, { data, owner, ts: dateNow() });
}

/**
 * Warm the cache for a slab — call on market-row hover/focus so the trade page
 * can seed from it and skip the loading skeleton. No-ops if already fresh or a
 * fetch is already in flight.
 */
export function prefetchSlab(connection: Connection, slab: string): void {
  if (getCachedSlab(slab) || inflight.has(slab)) return;
  let slabPk: PublicKey;
  try {
    slabPk = new PublicKey(slab);
  } catch {
    return;
  }
  const p = (async () => {
    try {
      const info = await connection.getAccountInfo(slabPk);
      if (info) setCachedSlab(slab, new Uint8Array(info.data), info.owner);
    } catch {
      /* prefetch is best-effort — the provider's own fetch is the source of truth */
    } finally {
      inflight.delete(slab);
    }
  })();
  inflight.set(slab, p);
}

function dateNow(): number {
  return Date.now();
}
