/**
 * Cross-REPO blocklist sync: app ⊆ indexer.
 *
 * The 2026-07-31 audit found 35 app entries missing from the indexer copy —
 * drift that was structurally undetectable because the existing sync test
 * (blocklist-edge-sync.test.ts) only compares the two APP-side copies. The
 * indexer copy is what stops a deleted market being re-registered from chain,
 * so an entry missing THERE quietly undoes a retirement.
 *
 * This test compares against the sibling checkout at ../../percolator-indexer.
 * When that checkout is absent (fresh CI clone of this repo alone) it SKIPS —
 * loudly, so the skip shows in the run output rather than masquerading as a
 * pass. On any machine that has both repos (every maintainer machine), drift
 * fails the suite.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BLOCKED_SLAB_ADDRESSES } from "@/lib/blocklist";

const INDEXER_BLOCKLIST = join(
  __dirname,
  "../../../../percolator-indexer/src/blocklist.ts",
);

describe("app blocklist ⊆ indexer blocklist", () => {
  it.skipIf(!existsSync(INDEXER_BLOCKLIST))(
    "every app entry exists in percolator-indexer/src/blocklist.ts",
    () => {
      const src = readFileSync(INDEXER_BLOCKLIST, "utf8");
      const indexerEntries = new Set(
        src.match(/"([1-9A-HJ-NP-Za-km-z]{32,44})"/g)?.map((m) => m.slice(1, -1)) ?? [],
      );
      const missing = [...BLOCKED_SLAB_ADDRESSES].filter((e) => !indexerEntries.has(e));
      expect(
        missing,
        `entries missing from the INDEXER blocklist (a deleted market re-registers ` +
          `from chain without them): ${missing.join(", ")}`,
      ).toEqual([]);
    },
  );
});
