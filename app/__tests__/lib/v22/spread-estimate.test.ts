// @vitest-environment node
/** M7: the pre-trade "Spread / price impact" figure comes from the matcher's own context and is never a silent zero. */
import { describe, expect, it } from "vitest";
import type { MatcherCtxView, V2BlockView } from "@/lib/limits/decode";
import { spreadCostAtoms, spreadEstimateFromCtx, spreadValueText } from "@/lib/v22/spread-estimate";

const v2: V2BlockView = {
  flags: 1, feeLoBps: 10, feeHiBps: 80, feeColdBps: 10, volAMilli: 1000, volBDen: 100, volAlphaBps: 1000, volWarmupLeft: 0,
  volMoveCap10bps: 100, volRefSlots: 25, thinRebateMultBps: 100, skewCapBps: 100, rebateCapBps: 50, maxMarkAgeSlots: 150,
  observedStaleSlots: 0, boundAssetPlus1: 1, skewRefInventory: 1_000_000_000n, volVarE4: 0n, volLastPriceE6: 0n, volLastSlot: 0n,
};
const ctx = (over: Partial<MatcherCtxView> = {}): MatcherCtxView => ({
  kind: 2, tradingFeeBps: 0, baseSpreadBps: 5, maxTotalBps: 100, impactKBps: 5000, liquidityNotionalE6: 1_000_000_000_000n,
  maxFillAbs: 100_000_000_000n, inventoryBase: 0n, maxInventoryAbs: 0n, feeToInsuranceBps: 0, skewSpreadMultBps: 300, v2, ...over,
});

describe("spreadEstimateFromCtx", () => {
  it("adaptive matcher: the quote's total bps for this size (5 base + 10 fee + 1 impact + 15 skew = 31)", () => {
    const e = spreadEstimateFromCtx(ctx(), 1_000_000n, 100_000_000n, true);
    expect(e).toMatchObject({ kind: "quote", bps: 31 });
    expect(spreadValueText(e)).toBe("~0.31% (est.)");
  });
  it("legacy matcher: an honest RANGE from the base spread to max_total, never a point 0", () => {
    const e = spreadEstimateFromCtx(ctx({ kind: 1, v2: null, baseSpreadBps: 20, maxTotalBps: 80 }), 1_000_000n, 100_000_000n, true);
    expect(e).toEqual({ kind: "range", minBps: 20, maxBps: 80 });
    expect(spreadValueText(e)).toBe("0.20% to 0.80% (est. range)");
  });
  it("unknown (no context / no price / no size) is null and reads as unavailable, never 0%", () => {
    expect(spreadEstimateFromCtx(null, 1_000_000n, 1n, true)).toBeNull();
    expect(spreadEstimateFromCtx(ctx(), 0n, 1n, true)).toBeNull();
    expect(spreadEstimateFromCtx(ctx(), 1_000_000n, 0n, true)).toBeNull();
    const t = spreadValueText(null);
    expect(t).toMatch(/not available/i);
    expect(t).not.toMatch(/0\.00%|\+0/);
  });
});

describe("spreadCostAtoms", () => {
  it("cost of the point estimate on the notional; the floor of a range; null when unknown", () => {
    expect(spreadCostAtoms({ kind: "quote", bps: 23, execPriceE6: null }, 40_000_000n)).toBe(92_000n);
    expect(spreadCostAtoms({ kind: "range", minBps: 20, maxBps: 80 }, 40_000_000n)).toBe(80_000n);
    expect(spreadCostAtoms(null, 40_000_000n)).toBeNull();
  });
});
