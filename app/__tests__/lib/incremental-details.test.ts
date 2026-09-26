/**
 * My Markets showed truncated mint addresses instead of tickers and logos for
 * about a second after load.
 *
 * The page fetches `/api/markets/[slab]` per market and publishes the whole map
 * in one `Promise.all(...).then(setDetails)`, so no row renders until the
 * SLOWEST market settles. Measured live: four markets returned in 517-635ms
 * and the list waited 1022ms.
 *
 * See lib/incremental-details.ts.
 */

import { describe, expect, it } from "vitest";
import { applyResolved, seedFromCache } from "@/lib/incremental-details";

const SLABS = ["slabA", "slabB", "slabC"];
type Detail = { symbol: string };

describe("a row must not wait for its siblings", () => {
  it("shows a market as soon as its own fetch lands", () => {
    // THE BUG: with Promise.all this map stays empty until slabC settles, so
    // A and B render their mint addresses while their data is already back.
    let map: Record<string, Detail> = {};
    map = applyResolved(map, { slab: "slabA", detail: { symbol: "COLLECT" } }, SLABS);
    expect(map).toEqual({ slabA: { symbol: "COLLECT" } });

    map = applyResolved(map, { slab: "slabB", detail: { symbol: "SOLCAT" } }, SLABS);
    expect(Object.keys(map)).toEqual(["slabA", "slabB"]);
  });

  it("CONTROL: a slow sibling never removes a row already resolved", () => {
    // Without this, "merge incrementally" could be implemented as a replace,
    // which would make each arrival wipe the previous one — strictly worse
    // than the all-at-once behaviour it replaces.
    let map: Record<string, Detail> = { slabA: { symbol: "COLLECT" } };
    map = applyResolved(map, { slab: "slabB", detail: { symbol: "SOLCAT" } }, SLABS);
    expect(map.slabA).toEqual({ symbol: "COLLECT" });
    expect(map.slabB).toEqual({ symbol: "SOLCAT" });
  });
});

describe("a failed read must not undo a row", () => {
  it("keeps the existing detail when a fetch returns null", () => {
    // One transient 500 reverting a row to its mint address is the same class
    // of bug as the wait it is replacing, just intermittent.
    const map: Record<string, Detail> = { slabA: { symbol: "COLLECT" } };
    const next = applyResolved(map, { slab: "slabA", detail: null }, SLABS);
    expect(next.slabA).toEqual({ symbol: "COLLECT" });
  });

  it("returns the SAME object on a no-op, so nothing re-renders", () => {
    const map: Record<string, Detail> = { slabA: { symbol: "COLLECT" } };
    expect(applyResolved(map, { slab: "slabA", detail: null }, SLABS)).toBe(map);
    expect(applyResolved(map, { slab: "unknown", detail: { symbol: "X" } }, SLABS)).toBe(map);
  });
});

describe("a late response must not paint into the wrong list", () => {
  it("drops a result for a slab that is no longer listed", () => {
    // A wallet switch, or a market the creator no longer owns: the in-flight
    // request still resolves and must not inject a stranger's market.
    const map: Record<string, Detail> = {};
    const next = applyResolved(map, { slab: "someoneElse", detail: { symbol: "GHOST" } }, SLABS);
    expect(next).toEqual({});
  });

  it("CONTROL: a result that IS listed still lands", () => {
    // Guards against "drop everything", which would fix the stale-paint by
    // never painting at all.
    const next = applyResolved({}, { slab: "slabC", detail: { symbol: "TEXTIT" } }, SLABS);
    expect(next).toEqual({ slabC: { symbol: "TEXTIT" } });
  });
});

describe("the identity cache is read, not just written", () => {
  it("seeds known markets synchronously, before any request", () => {
    // The page already writes every resolved identity to the cross-navigation
    // cache and never reads it back, so returning to My Markets re-showed mint
    // addresses for a full second with the answer already in memory.
    const cache: Record<string, Detail> = { slabA: { symbol: "COLLECT" } };
    const seeded = seedFromCache(SLABS, (s) => cache[s] ?? null);
    expect(seeded).toEqual({ slabA: { symbol: "COLLECT" } });
  });

  it("CONTROL: a cache miss contributes nothing rather than a blank entry", () => {
    // A `{ slabB: null }` entry would render as a resolved-but-empty row,
    // which is worse than the honest mint-address placeholder.
    const seeded = seedFromCache(SLABS, () => null);
    expect(seeded).toEqual({});
    expect(Object.keys(seeded)).toHaveLength(0);
  });
});
