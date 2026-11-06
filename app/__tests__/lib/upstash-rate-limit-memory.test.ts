import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUpstashRateLimiter } from "@/lib/upstash-rate-limit";

beforeEach(() => {
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Fallback limiter memory regression", () => {
  it("CONTROL: repeated key is rate-limited", async () => {
    const limiter = createUpstashRateLimiter({
      limit: 2,
      windowMs: 60_000,
      prefix: "audit-control",
    });

    expect((await limiter.check("same-key")).allowed).toBe(true);
    expect((await limiter.check("same-key")).allowed).toBe(true);
    expect((await limiter.check("same-key")).allowed).toBe(false);
  });

  it("REGRESSION: active-key map stays within 500 entries", async () => {
    const OriginalMap = globalThis.Map;
    const created: Map<unknown, unknown>[] = [];

    class ObservedMap<K, V> extends OriginalMap<K, V> {
      constructor(entries?: readonly (readonly [K, V])[] | null) {
        super(entries ?? undefined);
        created.push(this as unknown as Map<unknown, unknown>);
      }
    }

    (globalThis as unknown as { Map: typeof Map }).Map =
      ObservedMap as unknown as typeof Map;

    try {
      const limiter = createUpstashRateLimiter({
        limit: 5,
        windowMs: 3_600_000,
        prefix: "audit-cardinality",
      });

      for (let i = 0; i < 600; i++) {
        await limiter.check(`audit-key-${i}`);
      }

      const tracked = created.find(m => m.has("audit-key-0"));

      expect(tracked).toBeDefined();
      expect(tracked!.size).toBeLessThanOrEqual(500);
    } finally {
      (globalThis as unknown as { Map: typeof Map }).Map =
        OriginalMap;
    }
  });
});

it("REGRESSION: rejected requests must not grow timestamp history indefinitely", async () => {
  const OriginalMap = globalThis.Map;
  const captured: Map<unknown, unknown>[] = [];

  class CapturedMap<K, V> extends OriginalMap<K, V> {
    constructor(entries?: readonly (readonly [K, V])[] | null) {
      super(entries ?? undefined);
      captured.push(this as unknown as Map<unknown, unknown>);
    }
  }

  (globalThis as { Map: typeof Map }).Map =
    CapturedMap as unknown as typeof Map;

  try {
    const limiter = createUpstashRateLimiter({
      limit: 2,
      windowMs: 3_600_000,
      prefix: "audit-rejected-growth",
    });

    let allowed = 0;

    for (let i = 0; i < 1200; i++) {
      const result = await limiter.check("audit-hot-key");
      if (result.allowed) allowed++;
    }

    const tracked = captured.find(m => m.has("audit-hot-key"));

    expect(tracked).toBeDefined();
    expect(allowed).toBe(2);

    const timestamps = tracked!.get("audit-hot-key");

    expect(Array.isArray(timestamps)).toBe(true);

    const storedCount = (timestamps as number[]).length;

    console.log("STORED_TIMESTAMPS:", storedCount);
    console.log("EXPECTED_MAX_TIMESTAMPS:", 2);

    expect(storedCount).toBeLessThanOrEqual(2);
  } finally {
    (globalThis as { Map: typeof Map }).Map = OriginalMap;
  }
});

it("CONTROL: capacity exhaustion cannot reset active rate limits", async () => {
  const limiter = createUpstashRateLimiter({
    limit: 1,
    windowMs: 3_600_000,
    prefix: "audit-capacity-control",
  });

  for (let i = 0; i < 500; i++) {
    expect((await limiter.check(`wallet-${i}`)).allowed).toBe(true);
  }

  // The original key must remain limited.
  expect((await limiter.check("wallet-0")).allowed).toBe(false);

  // A new key must not bypass a full fallback map.
  expect((await limiter.check("wallet-501")).allowed).toBe(false);

  // Rechecking the original key must still be denied.
  expect((await limiter.check("wallet-0")).allowed).toBe(false);
});

it("CONTROL: expired entries release capacity", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

  try {
    const limiter = createUpstashRateLimiter({
      limit: 1,
      windowMs: 1000,
      prefix: "audit-expiry-control",
    });

    for (let i = 0; i < 500; i++) {
      expect((await limiter.check(`expired-${i}`)).allowed).toBe(true);
    }

    expect((await limiter.check("new-key")).allowed).toBe(false);

    vi.advanceTimersByTime(1001);

    expect((await limiter.check("new-key")).allowed).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("CONTROL: existing active key retains remaining quota at capacity", async () => {
  const limiter = createUpstashRateLimiter({
    limit: 2,
    windowMs: 60_000,
    prefix: "audit-existing-key",
  });

  for (let i = 0; i < 500; i++) {
    expect((await limiter.check(`key-${i}`)).allowed).toBe(true);
  }

  // Existing key still has one unit remaining.
  const second = await limiter.check("key-0");
  expect(second.allowed).toBe(true);
  expect(second.remaining).toBe(0);

  // Its quota is exhausted.
  expect((await limiter.check("key-0")).allowed).toBe(false);

  // A previously unseen key cannot exceed capacity.
  expect((await limiter.check("key-500")).allowed).toBe(false);
});

it("CONTROL: weighted request cost is enforced", async () => {
  const limiter = createUpstashRateLimiter({
    limit: 5,
    windowMs: 60_000,
    prefix: "audit-weighted-cost",
  });

  const first = await limiter.check("weighted-key", 3);
  expect(first.allowed).toBe(true);
  expect(first.remaining).toBe(2);

  const second = await limiter.check("weighted-key", 2);
  expect(second.allowed).toBe(true);
  expect(second.remaining).toBe(0);

  const rejected = await limiter.check("weighted-key", 1);
  expect(rejected.allowed).toBe(false);
  expect(rejected.remaining).toBe(0);

  // Different key retains an independent quota.
  expect((await limiter.check("other-key", 5)).allowed).toBe(true);
});

it("CONTROL: rejected requests do not prolong the rate-limit window", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

  try {
    const limiter = createUpstashRateLimiter({
      limit: 1,
      windowMs: 1000,
      prefix: "audit-window-expiry",
    });

    expect((await limiter.check("ip-a")).allowed).toBe(true);

    vi.advanceTimersByTime(900);

    for (let i = 0; i < 100; i++) {
      expect((await limiter.check("ip-a")).allowed).toBe(false);
    }

    // 1,001 ms from the original accepted request.
    vi.advanceTimersByTime(101);

    expect((await limiter.check("ip-a")).allowed).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
