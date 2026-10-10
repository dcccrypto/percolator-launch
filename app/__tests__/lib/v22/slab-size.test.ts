/**
 * Review F1: the market account (slab) is sized from the ACTIVE layout everywhere. v2.2 one-slot market =
 * 592 + 806 + 2661 = 4,059 B (the wrapper derives capacity from the exact length); v2.1 stays 3,675 B.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { v17MarketAccountLen } from "@percolatorct/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { LAYOUT_V22 } from "@/lib/v22/sdk";
import { marketAccountLen } from "@/lib/v22/layout";
import {
  DEFAULT_SLAB_SIZE, LAUNCH_ASSET_SLOTS, V17_MAX_PORTFOLIO_ASSETS, V22_MAX_PORTFOLIO_ASSETS, assetSlotsForSlabLen, buildV17InitMarketArgs, defaultSlabSize,
  marketAssetSlotsFor, maxPortfolioAssets, slabSizeFor, wizardSlabBytes,
} from "@/lib/create-market-args";
import { deriveMarketParams } from "@/lib/market-params";
import { launchCreatePins } from "@/lib/launch-single-tx/shape";
import { computeCreateMarketSolCost } from "@/components/create/CostEstimate";

afterEach(() => __setDevnetV22ForTest(null));
const V22_ONE = 592 + 806 + 2661;
const pins = () => launchCreatePins({ wrapper: "W", matcher: "M", tokenProgram: "T" }).slab.space;

describe("flag off: byte-identical to the SDK (v2.1)", () => {
  beforeEach(() => __setDevnetV22ForTest(false)); // the override beats NEXT_PUBLIC_DEVNET_V22, so a flag-on run still pins the v2.1 numbers here
  it("3,675 B for one slot (every launch, #3357), 33,900 B for fourteen (an old market's size)", () => {
    expect(slabSizeFor({ p3: true })).toBe(3675);
    expect(wizardSlabBytes(true)).toBe(3675);
    expect(wizardSlabBytes(false)).toBe(3675);
    expect(defaultSlabSize()).toBe(DEFAULT_SLAB_SIZE);
    expect(DEFAULT_SLAB_SIZE).toBe(3_675);
    expect(slabSizeFor({})).toBe(3_675);
    expect(marketAccountLen(14)).toBe(v17MarketAccountLen(14));
    expect(v17MarketAccountLen(14)).toBe(33_900);
    expect(pins()).toBe(3675);
  });
  it("the slot cap and the slot lookup are the v2.1 ones: 14, and 1..14 resolve", () => {
    expect(maxPortfolioAssets()).toBe(V17_MAX_PORTFOLIO_ASSETS);
    for (let n = 1; n <= 14; n++) expect(assetSlotsForSlabLen(v17MarketAccountLen(n))).toBe(n);
    expect(assetSlotsForSlabLen(4_059)).toBeNull(); // a v2.2 length is not a v2.1 market
    expect(buildV17InitMarketArgs({ initialPriceE6: 1_000_000n, tradingFeeBps: 10 }, deriveMarketParams(5, 1_000_000_000n, 1_000_000n)).maxPortfolioAssets).toBe(1);
  });
});

describe("flag on: v2.2 geometry", () => {
  it("a launch is ONE slot, 4,059 B; the cap is 4 slots = 12,042 B (final: percolator-prog#546)", () => {
    __setDevnetV22ForTest(true);
    expect(V22_ONE).toBe(4059);
    expect(LAUNCH_ASSET_SLOTS).toBe(1);
    expect(slabSizeFor({ p3: true })).toBe(4059);
    expect(wizardSlabBytes(true)).toBe(4059);
    expect(wizardSlabBytes(false)).toBe(4059);
    expect(defaultSlabSize()).toBe(4059);
    expect(slabSizeFor({})).toBe(4059);
    expect(marketAccountLen(V22_MAX_PORTFOLIO_ASSETS)).toBe(592 + 806 + 4 * 2661);
    expect(marketAccountLen(4)).toBe(12_042);
    expect(slabSizeFor({ assetSlots: 4 })).toBe(12_042); // a resumed 4-slot market keeps its capacity
  });
  it("InitMarket never asks for more than the program's cap of 4 (error 14 above it); slot lookup is the v2.2 stride", () => {
    __setDevnetV22ForTest(true);
    expect(V22_MAX_PORTFOLIO_ASSETS).toBe(4);
    expect(maxPortfolioAssets()).toBe(4);
    const args = buildV17InitMarketArgs({ initialPriceE6: 1_000_000n, tradingFeeBps: 10 }, deriveMarketParams(5, 1_000_000_000n, 1_000_000n));
    expect(args.maxPortfolioAssets).toBe(1);
    expect(args.maxPortfolioAssets).toBeLessThanOrEqual(V22_MAX_PORTFOLIO_ASSETS);
    expect(marketAssetSlotsFor({ p3: true })).toBe(1);
    for (const [n, len] of [[1, 4_059], [2, 6_720], [3, 9_381], [4, 12_042]] as const) {
      expect(marketAccountLen(n)).toBe(len);
      expect(assetSlotsForSlabLen(len)).toBe(n);
    }
    expect(assetSlotsForSlabLen(marketAccountLen(5))).toBeNull(); // not a market the program accepts
    expect(assetSlotsForSlabLen(3_675)).toBeNull(); // NEGATIVE CONTROL: a v2.1 length is not a v2.2 market
  });
  it("a 5-slot (or v2.1 14-slot) InitMarket is refused client-side with the flag on, allowed with it off", () => {
    const d = deriveMarketParams(5, 1_000_000_000n, 1_000_000n);
    const p = (assetSlots: number) => ({ initialPriceE6: 1_000_000n, tradingFeeBps: 10, assetSlots });
    __setDevnetV22ForTest(true);
    expect(buildV17InitMarketArgs(p(4), d).maxPortfolioAssets).toBe(4);
    expect(() => buildV17InitMarketArgs(p(5), d)).toThrow(/cap of 4/);
    expect(() => buildV17InitMarketArgs(p(14), d)).toThrow(/cap of 4/);
    __setDevnetV22ForTest(false);
    expect(buildV17InitMarketArgs(p(14), d).maxPortfolioAssets).toBe(14); // v2.1 unchanged
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
    __setDevnetV22ForTest(false);
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
  // An import specifier line is allowed (the flag-off arm below needs it). The one allowed call form: the layout-aware ternary whose flag-off arm is the v2.1 call (a playground source guard pins that literal).
  const layoutAware = (s: string) => s.replace(/isDevnetV22Enabled\(\)\s*\?\s*marketAccountLen\((\w+)\)\s*:\s*v17MarketAccountLen\(\1\)/g, "marketAccountLen($1)");
  const offends = (src: string) => /\bv17MarketAccountLen\b|\bDEFAULT_SLAB_SIZE\b|\b(3675|33_?900|4027)\b/.test(layoutAware(strip(src)).replace(/^\s*v17MarketAccountLen,\s*$/m, ""));
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
    expect(offends("const n = isDevnetV22Enabled() ? marketAccountLen(k) : v17MarketAccountLen(k)")).toBe(false);
    expect(offends("const n = isDevnetV22Enabled() ? marketAccountLen(k) : v17MarketAccountLen(j)")).toBe(true);
    expect(offends("const n = cond ? marketAccountLen(k) : v17MarketAccountLen(k)")).toBe(true);
  });
});
