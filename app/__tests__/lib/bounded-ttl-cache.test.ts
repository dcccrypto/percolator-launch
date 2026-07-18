/**
 * GH#2416 — bounded TTL cache.
 *
 * The oracle API routes previously used plain `Map`s as TTL caches. Stale
 * entries were ignored by the freshness check but never deleted, and there was
 * no cap, so an unauthenticated caller who controls part of the cache key could
 * mint unlimited unique keys and exhaust process memory.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createBoundedTtlCache } from "@/lib/bounded-ttl-cache";

afterEach(() => {
  vi.useRealTimers();
});

describe("createBoundedTtlCache", () => {
  it("never exceeds maxEntries no matter how many unique keys arrive", () => {
    const cache = createBoundedTtlCache<number>({ ttlMs: 60_000, maxEntries: 10 });

    // The attack: unlimited distinct keys, all within TTL so none expire.
    for (let i = 0; i < 5_000; i++) {
      cache.set(`attacker-key-${i}`, i);
      expect(cache.size()).toBeLessThanOrEqual(10);
    }

    expect(cache.size()).toBe(10);
  });

  it("deletes an expired entry on access rather than merely ignoring it", () => {
    vi.useFakeTimers();
    const cache = createBoundedTtlCache<string>({ ttlMs: 1_000, maxEntries: 100 });

    cache.set("k", "v");
    expect(cache.size()).toBe(1);

    vi.advanceTimersByTime(1_001);

    expect(cache.get("k")).toBeUndefined();
    // The old code left the entry in the Map here — that is the leak.
    expect(cache.size()).toBe(0);
  });

  it("serves an unexpired value", () => {
    vi.useFakeTimers();
    const cache = createBoundedTtlCache<string>({ ttlMs: 5_000, maxEntries: 100 });

    cache.set("k", "v");
    vi.advanceTimersByTime(4_999);
    expect(cache.get("k")).toBe("v");
  });

  it("treats the TTL boundary as expired", () => {
    vi.useFakeTimers();
    const cache = createBoundedTtlCache<string>({ ttlMs: 1_000, maxEntries: 100 });

    cache.set("k", "v");
    vi.advanceTimersByTime(1_000);
    expect(cache.get("k")).toBeUndefined();
  });

  it("sweeps expired entries before evicting live ones", () => {
    vi.useFakeTimers();
    const cache = createBoundedTtlCache<number>({ ttlMs: 1_000, maxEntries: 5 });

    for (let i = 0; i < 5; i++) cache.set(`old-${i}`, i);
    expect(cache.size()).toBe(5);

    // All five lapse, so a new insert should reclaim them rather than evict.
    vi.advanceTimersByTime(1_001);
    cache.set("fresh", 99);

    expect(cache.size()).toBe(1);
    expect(cache.get("fresh")).toBe(99);
  });

  it("evicts oldest-first when everything is still live", () => {
    const cache = createBoundedTtlCache<number>({ ttlMs: 60_000, maxEntries: 3 });

    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4); // pushes out "a"

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("d")).toBe(4);
    expect(cache.size()).toBe(3);
  });

  it("re-inserting a key refreshes it instead of duplicating or evicting it", () => {
    const cache = createBoundedTtlCache<number>({ ttlMs: 60_000, maxEntries: 3 });

    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 10); // refresh — moves "a" to the end
    cache.set("c", 3);
    cache.set("d", 4); // evicts oldest, which is now "b" not "a"

    expect(cache.size()).toBe(3);
    expect(cache.get("a")).toBe(10);
    expect(cache.get("b")).toBeUndefined();
  });

  it("rejects nonsensical construction rather than silently misbehaving", () => {
    expect(() => createBoundedTtlCache({ ttlMs: 0 })).toThrow(/ttlMs/);
    expect(() => createBoundedTtlCache({ ttlMs: NaN })).toThrow(/ttlMs/);
    expect(() => createBoundedTtlCache({ ttlMs: 1_000, maxEntries: 0 })).toThrow(/maxEntries/);
  });
});
