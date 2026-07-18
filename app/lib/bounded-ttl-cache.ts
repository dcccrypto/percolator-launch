/**
 * Bounded in-memory TTL cache (GH#2416).
 *
 * A plain `Map` used as a TTL cache leaks: when an entry goes stale it is
 * ignored by the freshness check but never deleted, so both the key and the
 * cached value stay strongly referenced and unreclaimable. On a route whose
 * cache key derives from request input, an unauthenticated caller can mint
 * unlimited unique keys and grow the map until the process dies.
 *
 * This bounds it three ways:
 *   1. Expired entries are deleted on access, not merely ignored.
 *   2. A sweep drops all expired entries once the map reaches its cap.
 *   3. If the map is still at its cap after sweeping, the oldest entry is
 *      evicted so an insert can never grow it past `maxEntries`.
 *
 * Eviction is insertion-order (FIFO), not strict LRU — `set()` on an existing
 * key re-inserts it at the end, but a plain `get()` does not promote. That is
 * deliberate: it bounds memory, which is the security property here, without
 * paying a delete+insert on every read. Do not rely on this for hit-rate
 * optimisation of a hot key set.
 *
 * Mirrors the eviction approach already used by `createMemoryRateLimiter`.
 */

export interface BoundedTtlCacheOptions {
  /** Entry lifetime in milliseconds. */
  ttlMs: number;
  /** Hard cap on entries. Default 500. */
  maxEntries?: number;
}

export interface BoundedTtlCache<T> {
  /** Returns the value if present and unexpired; deletes it if expired. */
  get(key: string): T | undefined;
  /** Stores a value, pruning and evicting as needed to respect maxEntries. */
  set(key: string, value: T): void;
  /** Current entry count (may include not-yet-swept expired entries). */
  size(): number;
  /** Drops everything. Intended for tests. */
  clear(): void;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export function createBoundedTtlCache<T>(
  options: BoundedTtlCacheOptions,
): BoundedTtlCache<T> {
  const { ttlMs, maxEntries = 500 } = options;

  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`bounded-ttl-cache: ttlMs must be a positive finite number, got ${ttlMs}`);
  }
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
    throw new Error(
      `bounded-ttl-cache: maxEntries must be a positive finite number, got ${maxEntries}`,
    );
  }

  const map = new Map<string, Entry<T>>();

  function sweepExpired(now: number): void {
    for (const [k, entry] of map.entries()) {
      if (now >= entry.expiresAt) map.delete(k);
    }
  }

  return {
    get(key: string): T | undefined {
      const entry = map.get(key);
      if (entry === undefined) return undefined;

      if (Date.now() >= entry.expiresAt) {
        // Delete rather than merely ignore — otherwise a stale entry occupies
        // its slot forever and the map only ever grows.
        map.delete(key);
        return undefined;
      }
      return entry.value;
    },

    set(key: string, value: T): void {
      const now = Date.now();

      // Re-insert so a refreshed key moves to the end of the iteration order
      // and is not the next eviction victim purely because it was cached early.
      map.delete(key);

      if (map.size >= maxEntries) {
        sweepExpired(now);
      }
      while (map.size >= maxEntries) {
        // Map iteration order is insertion order, so the first key is oldest.
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }

      map.set(key, { value, expiresAt: now + ttlMs });
    },

    size(): number {
      return map.size;
    },

    clear(): void {
      map.clear();
    },
  };
}
