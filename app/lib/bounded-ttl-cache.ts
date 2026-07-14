interface CacheEntry<Value> {
  value: Value;
  expiresAt: number;
}

interface BoundedTtlCacheOptions {
  maxEntries: number;
  ttlMs: number;
  now?: () => number;
}

/**
 * Small in-memory TTL cache with deterministic LRU eviction.
 *
 * Security properties:
 * - Enforces a hard maximum cardinality.
 * - Actively removes expired entries.
 * - Refreshes recency on successful reads.
 * - Evicts the least-recently-used entry before capacity overflow.
 *
 * This cache is process-local and is intended only for short-lived,
 * non-authoritative API response caching.
 */
export class BoundedTtlCache<Key, Value> {
  private readonly entries = new Map<Key, CacheEntry<Value>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor({
    maxEntries,
    ttlMs,
    now = Date.now,
  }: BoundedTtlCacheOptions) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError("maxEntries must be a positive safe integer");
    }

    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError("ttlMs must be a positive finite number");
    }

    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get size(): number {
    this.deleteExpired();
    return this.entries.size;
  }

  get(key: Key): Value | undefined {
    const entry = this.entries.get(key);

    if (!entry) {
      return undefined;
    }

    const now = this.now();

    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }

    // Map iteration order is insertion order. Reinsert a successful hit so
    // the first entry always represents the least-recently-used item.
    this.entries.delete(key);
    this.entries.set(key, entry);

    return entry.value;
  }

  set(key: Key, value: Value): void {
    const now = this.now();

    this.deleteExpired(now);

    // Replacing an existing key must also refresh its LRU position.
    this.entries.delete(key);

    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();

      if (oldest.done) {
        break;
      }

      this.entries.delete(oldest.value);
    }

    this.entries.set(key, {
      value,
      expiresAt: now + this.ttlMs,
    });
  }

  delete(key: Key): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private deleteExpired(now = this.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}
