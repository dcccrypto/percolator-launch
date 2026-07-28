/**
 * Enforces the "KEEP IN SYNC" contract between the two blocklists.
 *
 * There are deliberately two:
 *   - `lib/blocklist.ts`      — canonical, Node runtime, reads env-var overrides
 *   - `lib/blocklist-edge.ts` — edge-pure copy imported ONLY by middleware.ts
 *
 * The split exists because importing the env-reading module into the Edge
 * middleware co-bundled Node-only code and Vercel's deploy-time validator
 * rejected it. The cost of that split is drift: the edge file carries a
 * "KEEP IN SYNC with HARDCODED_BLOCKED_SLABS" comment and nothing enforced it.
 *
 * Drift is not cosmetic. Entries here are blocked for reasons including a wrong
 * `oracle_authority` (price-manipulation risk, GH#837) and corrupt on-chain OI.
 * A slab present in one list and missing from the other is reachable through
 * whichever layer forgot it.
 */

import { describe, it, expect } from "vitest";

import { BLOCKED_SLAB_ADDRESSES as EDGE_BLOCKED } from "@/lib/blocklist-edge";
import { BLOCKED_SLAB_ADDRESSES as CANONICAL_BLOCKED } from "@/lib/blocklist";

describe("blocklist-edge stays in sync with the canonical blocklist", () => {
  // The canonical set folds in env-var overrides, which the edge set
  // intentionally omits. This suite runs with neither var set, so the two
  // reduce to the same hardcoded list.
  it("runs without env-var overrides, so the sets are directly comparable", () => {
    expect(process.env.NEXT_PUBLIC_BLOCKED_MARKET_ADDRESSES ?? "").toBe("");
    expect(process.env.BLOCKED_MARKET_ADDRESSES ?? "").toBe("");
  });

  it("blocks nothing in the canonical list that the Edge middleware misses", () => {
    const missingAtEdge = [...CANONICAL_BLOCKED].filter((a) => !EDGE_BLOCKED.has(a));

    // A slab here is blocked by the API routes but still served by the Edge
    // middleware — add it to lib/blocklist-edge.ts.
    expect(missingAtEdge).toEqual([]);
  });

  it("blocks nothing at the Edge that the canonical list has dropped", () => {
    const extraAtEdge = [...EDGE_BLOCKED].filter((a) => !CANONICAL_BLOCKED.has(a));

    // A slab here is 404'd by the middleware but absent from the canonical
    // list — either re-add it to HARDCODED_BLOCKED_SLABS or remove it here.
    expect(extraAtEdge).toEqual([]);
  });

  it("has a non-trivial number of entries in both", () => {
    // Guards against a refactor that empties one set and makes the two
    // difference assertions above pass vacuously.
    expect(EDGE_BLOCKED.size).toBeGreaterThan(20);
    expect(CANONICAL_BLOCKED.size).toBeGreaterThan(20);
    expect(EDGE_BLOCKED.size).toBe(CANONICAL_BLOCKED.size);
  });
});
