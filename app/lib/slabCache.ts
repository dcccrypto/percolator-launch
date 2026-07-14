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

/** How long a cached slab is considered fresh enough to SKIP a re-fetch —
 *  the dedup horizon for prefetchSlab/prefetchSlabsBatch. */
const FRESH_MS = 20_000;

/** How old an entry can be and still serve as the SEED for the trade page's
 *  first paint (stale-while-revalidate). Deliberately much longer than
 *  FRESH_MS: the provider's own poll fires immediately after seeding and
 *  byte-dedups, so this only bounds how stale the ONE pre-paint frame can be
 *  — and a minutes-old frame for ~500ms beats the full-page skeleton it
 *  replaces. (With the old single 20s tier, any user who browsed /markets
 *  for >20s before clicking missed the seed and got the skeleton for a full
 *  RPC round-trip — ~560ms measured on the live site.) */
const SEED_MAX_AGE_MS = 10 * 60_000;

export function getCachedSlab(slab: string): CachedSlab | null {
  const e = cache.get(slab);
  if (!e) return null;
  if (dateNow() - e.ts > FRESH_MS) return null;
  return e;
}

/** Stale-tolerant read for SlabProvider's seed-before-paint — see
 *  SEED_MAX_AGE_MS above. Prefetch callers must keep using getCachedSlab so
 *  a stale-but-seedable entry still gets refreshed by hover/batch warms. */
export function getSeedSlab(slab: string): CachedSlab | null {
  const e = cache.get(slab);
  if (!e) return null;
  if (dateNow() - e.ts > SEED_MAX_AGE_MS) return null;
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

/**
 * Warm the cache for MANY slabs in one batched RPC (getMultipleAccountsInfo,
 * chunked at 100) — call once when the markets list loads so EVERY market opens
 * instantly, not just hovered ones. Skips slabs already fresh or in flight.
 */
export function prefetchSlabsBatch(connection: Connection, slabs: string[]): void {
  const keys: string[] = [];
  const pks: PublicKey[] = [];
  for (const s of slabs) {
    if (getCachedSlab(s) || inflight.has(s)) continue;
    try {
      pks.push(new PublicKey(s));
      keys.push(s);
    } catch {
      /* skip invalid */
    }
  }
  if (pks.length === 0) return;
  const p = (async () => {
    try {
      for (let i = 0; i < pks.length; i += 100) {
        const chunkPks = pks.slice(i, i + 100);
        const chunkKeys = keys.slice(i, i + 100);
        const infos = await connection.getMultipleAccountsInfo(chunkPks);
        infos.forEach((info, j) => {
          if (info) setCachedSlab(chunkKeys[j], new Uint8Array(info.data), info.owner);
        });
      }
    } catch {
      /* best-effort */
    } finally {
      keys.forEach((k) => inflight.delete(k));
    }
  })();
  keys.forEach((k) => inflight.set(k, p));
}

function dateNow(): number {
  return Date.now();
}
