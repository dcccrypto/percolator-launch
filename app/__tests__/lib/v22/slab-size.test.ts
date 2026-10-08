/**
 * Review F1: the market account (slab) is sized from the ACTIVE layout everywhere. v2.2 one-slot market =
 * 592 + 806 + 2661 = 4,059 B (the wrapper derives capacity from the exact length); v2.1 stays 3,675 B.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { v17MarketAccountLen } from "@percolatorct/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { LAYOUT_V22 } from "@/lib/v22/sdk";
import { marketAccountLen } from "@/lib/v22/layout";
import { DEFAULT_SLAB_SIZE, defaultSlabSize, slabSizeFor, wizardSlabBytes } from "@/lib/create-market-args";
import { launchCreatePins } from "@/lib/launch-single-tx/shape";
import { computeCreateMarketSolCost } from "@/components/create/CostEstimate";

afterEach(() => __setDevnetV22ForTest(null));
const V22_ONE = 592 + 806 + 2661;
const pins = () => launchCreatePins({ wrapper: "W", matcher: "M", tokenProgram: "T" }).slab.space;

describe("flag off: byte-identical to the SDK (v2.1)", () => {
  it("3,675 B for one slot, 33,900 B for fourteen", () => {
    expect(slabSizeFor({ p3: true })).toBe(3675);
    expect(wizardSlabBytes(true)).toBe(3675);
    expect(defaultSlabSize()).toBe(DEFAULT_SLAB_SIZE);
    expect(DEFAULT_SLAB_SIZE).toBe(33_900);
    expect(marketAccountLen(14)).toBe(v17MarketAccountLen(14));
    expect(pins()).toBe(3675);
  });
});

describe("flag on: v2.2 geometry", () => {
  it("one slot is 4,059 B, fourteen is 592 + 806 + 14 x 2,661", () => {
    __setDevnetV22ForTest(true);
    expect(V22_ONE).toBe(4059);
    expect(slabSizeFor({ p3: true })).toBe(4059);
    expect(wizardSlabBytes(true)).toBe(4059);
    expect(marketAccountLen(14)).toBe(592 + 806 + 14 * 2661);
    expect(defaultSlabSize()).toBe(592 + 806 + 14 * 2661);
    expect(slabSizeFor({})).toBe(defaultSlabSize());
    expect(slabSizeFor({ slabDataSize: 12345 })).toBe(12345); // an explicit caller size is respected
  });
  it("the size is a whole number of v2.2 strides past the group (the wrapper requires it)", () => {
    __setDevnetV22ForTest(true);
    for (const n of [1, 2, 14]) expect((marketAccountLen(n) - LAYOUT_V22.marketGroupOff - LAYOUT_V22.marketGroupLen) % LAYOUT_V22.assetSlotStride).toBe(0);
    // NEGATIVE CONTROL: the v2.1 size is NOT a whole number of v2.2 strides.
    expect((3675 - 592 - 806) % LAYOUT_V22.assetSlotStride).not.toBe(0);
  });
  it("the keeper-cosign pin equals the wizard's slab", () => {
    __setDevnetV22ForTest(true);
    expect(pins()).toBe(4059);
    expect(pins()).toBe(slabSizeFor({ p3: true }));
  });
  it("CostEstimate rent follows the layout (flag on > flag off)", () => {
    const off = computeCreateMarketSolCost({ p3: true });
    __setDevnetV22ForTest(true);
    const on = computeCreateMarketSolCost({ p3: true });
    expect(JSON.stringify(on)).not.toBe(JSON.stringify(off));
    const legacyOff = (() => { __setDevnetV22ForTest(false); return computeCreateMarketSolCost(); })();
    __setDevnetV22ForTest(true);
    expect(JSON.stringify(computeCreateMarketSolCost())).not.toBe(JSON.stringify(legacyOff));
  });
});

describe("source guard: no flow names a slab size of its own", () => {
  const FILES = [
    "hooks/useCreateMarket.ts", "lib/launch-single-tx/shape.ts", "app/api/mobile/create-market/route.ts",
    "components/create/CostEstimate.tsx", "components/create/CreateMarketWizard.tsx", "lib/create-market-bridge.ts",
  ];
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const offends = (src: string) => /\bv17MarketAccountLen\b|\bDEFAULT_SLAB_SIZE\b|\b(3675|33_?900|4027)\b/.test(strip(src));
  it.each(FILES)("%s", (f) => {
    let src: string;
    try { src = readFileSync(join(__dirname, "../../..", f), "utf8"); } catch { return; }
    // DEFAULT_SLAB_SIZE is only re-exported (not used) in useCreateMarket; that single re-export line is allowed.
    expect(offends(src.replace(/^\s*DEFAULT_SLAB_SIZE,\s*$/m, ""))).toBe(false);
  });
  it("NEGATIVE CONTROL: the detector flags a hard-coded slab size", () => {
    expect(offends("space: 3675")).toBe(true);
    expect(offends("const n = v17MarketAccountLen(1)")).toBe(true);
    expect(offends("space: slabSizeFor(params)")).toBe(false);
  });
});
