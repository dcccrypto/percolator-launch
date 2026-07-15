import { describe, expect, it } from "vitest";

import { BoundedTtlCache } from "@/lib/bounded-ttl-cache";

describe("BoundedTtlCache", () => {
  it("returns a fresh value before its TTL expires", () => {
    let now = 1_000;

    const cache = new BoundedTtlCache<string, string>({
      maxEntries: 2,
      ttlMs: 100,
      now: () => now,
    });

    cache.set("market-a", "value-a");
    now = 1_099;

    expect(cache.get("market-a")).toBe("value-a");
    expect(cache.size).toBe(1);
  });

  it("deletes and no longer returns an expired entry", () => {
    let now = 1_000;

    const cache = new BoundedTtlCache<string, string>({
      maxEntries: 2,
      ttlMs: 100,
      now: () => now,
    });

    cache.set("market-a", "value-a");
    now = 1_100;

    expect(cache.get("market-a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("removes expired entries before inserting a new value", () => {
    let now = 1_000;

    const cache = new BoundedTtlCache<string, string>({
      maxEntries: 2,
      ttlMs: 100,
      now: () => now,
    });

    cache.set("expired-a", "value-a");
    cache.set("expired-b", "value-b");

    now = 1_101;
    cache.set("fresh-c", "value-c");

    expect(cache.size).toBe(1);
    expect(cache.get("expired-a")).toBeUndefined();
    expect(cache.get("expired-b")).toBeUndefined();
    expect(cache.get("fresh-c")).toBe("value-c");
  });

  it("never grows beyond its configured maximum cardinality", () => {
    const cache = new BoundedTtlCache<string, string>({
      maxEntries: 2,
      ttlMs: 1_000,
    });

    cache.set("market-a", "value-a");
    cache.set("market-b", "value-b");
    cache.set("market-c", "value-c");

    expect(cache.size).toBe(2);
    expect(cache.get("market-a")).toBeUndefined();
    expect(cache.get("market-b")).toBe("value-b");
    expect(cache.get("market-c")).toBe("value-c");
  });

  it("evicts the least-recently-used entry after a cache hit", () => {
    const cache = new BoundedTtlCache<string, string>({
      maxEntries: 2,
      ttlMs: 1_000,
    });

    cache.set("market-a", "value-a");
    cache.set("market-b", "value-b");

    // Refresh market-a recency, making market-b the LRU entry.
    expect(cache.get("market-a")).toBe("value-a");

    cache.set("market-c", "value-c");

    expect(cache.get("market-b")).toBeUndefined();
    expect(cache.get("market-a")).toBe("value-a");
    expect(cache.get("market-c")).toBe("value-c");
    expect(cache.size).toBe(2);
  });

  it("refreshes the value, TTL, and LRU position when replacing a key", () => {
    let now = 1_000;

    const cache = new BoundedTtlCache<string, string>({
      maxEntries: 2,
      ttlMs: 100,
      now: () => now,
    });

    cache.set("market-a", "old-a");
    cache.set("market-b", "value-b");

    now = 1_050;
    cache.set("market-a", "new-a");

    cache.set("market-c", "value-c");

    expect(cache.get("market-b")).toBeUndefined();
    expect(cache.get("market-a")).toBe("new-a");

    now = 1_149;
    expect(cache.get("market-a")).toBe("new-a");

    now = 1_150;
    expect(cache.get("market-a")).toBeUndefined();
  });

  it("supports explicit deletion and clearing", () => {
    const cache = new BoundedTtlCache<string, string>({
      maxEntries: 3,
      ttlMs: 1_000,
    });

    cache.set("market-a", "value-a");
    cache.set("market-b", "value-b");

    expect(cache.delete("market-a")).toBe(true);
    expect(cache.delete("missing")).toBe(false);
    expect(cache.get("market-a")).toBeUndefined();

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get("market-b")).toBeUndefined();
  });

  it("rejects invalid resource-bound configuration", () => {
    expect(
      () =>
        new BoundedTtlCache({
          maxEntries: 0,
          ttlMs: 1_000,
        }),
    ).toThrow("maxEntries must be a positive safe integer");

    expect(
      () =>
        new BoundedTtlCache({
          maxEntries: 10,
          ttlMs: 0,
        }),
    ).toThrow("ttlMs must be a positive finite number");
  });
});
