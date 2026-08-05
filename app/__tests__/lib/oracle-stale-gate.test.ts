/**
 * Regression — GH#2484: a stale oracle must block trading for EVERY oracle mode.
 *
 * The gate used to be an inline allowlist (`mode === "admin" || "hyperp" ||
 * "keeper"`) duplicated across four trade components. It leaked twice: "keeper"
 * was missing (H7), then "pyth-pinned" (GH#2484) — so a stale Pyth market stayed
 * tradeable while admin/hyperp/keeper markets in the identical state were blocked.
 *
 * Two things are asserted here, deliberately:
 *
 *  1. The predicate blocks every member of the OracleMode union — driven off the
 *     union itself, not a hand-written list, so a new mode fails this test rather
 *     than silently passing. (The Record<OracleMode, boolean> exemption map also
 *     makes an unclassified new mode a COMPILE error; this is the runtime half.)
 *
 *  2. No trade component has re-inlined the allowlist. That is what binds the
 *     four call sites: a unit test of the predicate alone would still pass if a
 *     component reverted to its own copy, which is exactly how this bug spread.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OracleMode } from "@/lib/oraclePrice";
import type { FreshnessLevel } from "@/hooks/useOracleFreshness";
import { isOracleStaleBlocking, STALE_EXEMPT_MODES } from "@/lib/oracle-stale-gate";

// Derived from the exemption map, which is a Record over the union — adding a
// mode to OracleMode without classifying it fails to compile, and once
// classified it automatically appears here.
const ALL_MODES = Object.keys(STALE_EXEMPT_MODES) as OracleMode[];

describe("isOracleStaleBlocking", () => {
  it("covers every OracleMode member (the union has not outgrown the map)", () => {
    expect(ALL_MODES).toEqual(
      expect.arrayContaining(["admin", "hyperp", "keeper", "pyth-pinned"]),
    );
    expect(ALL_MODES).toHaveLength(4);
  });

  it.each(ALL_MODES)("blocks a stale oracle for mode %s", (mode) => {
    expect(isOracleStaleBlocking("stale", mode, true)).toBe(true);
  });

  it.each(ALL_MODES)("does not block fresh or aging for mode %s", (mode) => {
    expect(isOracleStaleBlocking("fresh", mode, true)).toBe(false);
    expect(isOracleStaleBlocking("aging", mode, true)).toBe(false);
  });

  it("leaves the 'unavailable' level to the caller's own handling", () => {
    // Callers compose this themselves — OrderTicket excludes it, the position
    // panels fold it in — so the predicate must not claim it.
    for (const mode of ALL_MODES) {
      expect(isOracleStaleBlocking("unavailable" as FreshnessLevel, mode, true)).toBe(false);
    }
  });

  it("does not block before a price has been seen, or before the mode resolves", () => {
    expect(isOracleStaleBlocking("stale", "pyth-pinned", false)).toBe(false);
    expect(isOracleStaleBlocking("stale", null, true)).toBe(false);
  });

  it("exempts nothing today — every mode is blocked when stale", () => {
    expect(Object.values(STALE_EXEMPT_MODES).some(Boolean)).toBe(false);
  });
});

describe("the trade surfaces use the shared gate, not their own allowlist", () => {
  const FILES = [
    "components/trade/OrderTicket.tsx",
    "components/trade/PositionPanel.tsx",
    "components/trade/PositionsDock.tsx",
    "components/trade/OtherMarketPositions.tsx",
  ];

  it.each(FILES)("%s calls isOracleStaleBlocking", (rel) => {
    const src = readFileSync(resolve(__dirname, "../..", rel), "utf8");
    expect(src).toContain("isOracleStaleBlocking(");
  });

  it.each(FILES)("%s has no inline oracle-mode allowlist", (rel) => {
    const src = readFileSync(resolve(__dirname, "../..", rel), "utf8");
    // The exact shape that leaked twice: a disjunction of mode equality checks
    // guarding the stale branch.
    expect(src).not.toMatch(/oracleMode === "[a-z-]+"\s*\|\|\s*oracleMode === "[a-z-]+"/);
  });
});
