/**
 * slabCache freshness tiers.
 *
 * Regression test for the markets→trade "instant open" seed missing in the
 * normal browse-then-click flow: prefetchSlabsBatch warms the cache when
 * /markets loads, but FRESH_MS is 20s and users typically browse longer than
 * that before clicking — getCachedSlab returned null, SlabProvider's
 * seed-before-paint was skipped, and the trade page showed the full-page
 * skeleton for an entire RPC round-trip (~560ms measured on the live site).
 *
 * The fix splits the cache into two read tiers:
 *   - getCachedSlab (20s)  — "fresh enough to skip a refetch" (prefetch dedup)
 *   - getSeedSlab   (10min) — "usable as a stale-while-revalidate seed frame";
 *     SlabProvider's own poll fires immediately after seeding and byte-dedups,
 *     so the seed only bounds how stale the ONE pre-paint frame can be.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { getCachedSlab, getSeedSlab, setCachedSlab } from "@/lib/slabCache";

const SLAB = "7RXTVmGcJMDqqTCFu5ADQRyLDvVZBi3r5U5WXzoULHJV";
const OWNER = new PublicKey("69VUZ7a2BeXBTpRRManLamF5UWTaNR9B1hy5Se3cdXy9");

describe("slabCache freshness tiers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fresh entry (<20s) is returned by both tiers", () => {
    setCachedSlab(SLAB, new Uint8Array([1, 2, 3]), OWNER);
    vi.advanceTimersByTime(10_000);
    expect(getCachedSlab(SLAB)).not.toBeNull();
    expect(getSeedSlab(SLAB)).not.toBeNull();
  });

  it("stale entry (>20s, <10min) is rejected for prefetch dedup but still usable as a seed", () => {
    setCachedSlab(SLAB, new Uint8Array([1, 2, 3]), OWNER);
    vi.advanceTimersByTime(60_000); // typical browse-the-list-then-click delay
    expect(getCachedSlab(SLAB)).toBeNull(); // hover/batch prefetch should re-fetch
    const seed = getSeedSlab(SLAB); // ...but the trade page still opens instantly
    expect(seed).not.toBeNull();
    expect(Array.from(seed!.data)).toEqual([1, 2, 3]);
  });

  it("very old entry (>10min) is rejected by both tiers", () => {
    setCachedSlab(SLAB, new Uint8Array([1, 2, 3]), OWNER);
    vi.advanceTimersByTime(11 * 60_000);
    expect(getCachedSlab(SLAB)).toBeNull();
    expect(getSeedSlab(SLAB)).toBeNull();
  });
});
