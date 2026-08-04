/**
 * PoC + regression — the /api/prices/[slab] fallback cache must be bounded.
 *
 * prices/[slab]/route.ts keeps a module-level `fallbackCache = new Map()` keyed
 * on the request slab (and `gt:<slab>` on the GeckoTerminal path, which serves
 * ANY slab and writes an entry on every miss — including null misses). The key
 * space is attacker-controlled (any base58 pubkey), TTL is checked only on read,
 * and nothing evicts — so `GET /api/prices/<random pubkey>` in a loop grows the
 * Map without bound (memory-exhaustion DoS), while also amplifying each miss into
 * an internal /api/markets fetch + a GeckoTerminal fetch.
 *
 * The sibling chart route already caps its GeckoTerminal caches with
 * boundedSet(map, key, value, CACHE_MAX_ENTRIES). This asserts the same LRU cap
 * keeps the Map bounded under a flood of distinct slabs, where a raw Map.set does
 * not.
 */
import { describe, it, expect } from "vitest";
import { boundedSet } from "@/lib/bounded-map";

const CAP = 10_000;
const entry = () => ({ value: null, expiresAt: Date.now() + 60_000 });

describe("prices/[slab] fallback cache bounding", () => {
  it("a raw Map grows without bound under distinct attacker slabs (the bug)", () => {
    const raw = new Map<string, unknown>();
    for (let i = 0; i < CAP * 2; i++) raw.set(`gt:slab_${i}`, entry());
    expect(raw.size).toBe(CAP * 2); // unbounded — grows 1:1 with attacker input
  });

  it("boundedSet caps the Map no matter how many distinct slabs are seen (the fix)", () => {
    const bounded = new Map<string, unknown>();
    for (let i = 0; i < CAP * 2; i++) boundedSet(bounded, `gt:slab_${i}`, entry(), CAP);
    expect(bounded.size).toBe(CAP); // hard cap holds
  });

  it("boundedSet evicts oldest-first, keeping recent entries", () => {
    const bounded = new Map<string, unknown>();
    for (let i = 0; i < CAP + 5; i++) boundedSet(bounded, `gt:slab_${i}`, entry(), CAP);
    expect(bounded.has("gt:slab_0")).toBe(false);         // oldest evicted
    expect(bounded.has(`gt:slab_${CAP + 4}`)).toBe(true); // newest kept
  });
});
