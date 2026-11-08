// @vitest-environment node
/** M7: the pre-trade "Spread / price impact" figure comes from the matcher's own context and is never a silent zero. */
import { describe, expect, it } from "vitest";
import type { MatcherCtxView, V2BlockView } from "@/lib/limits/decode";
import { estimatedTotalFeeBps } from "@/lib/limits/estimated-fee";
import { feeBpsWithSpread, spreadEstimateFromCtx, spreadValueText } from "@/lib/v22/spread-estimate";

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
    expect(spreadValueText(e)).toBe("~0.31% (est., not charged on this market: fills settle at the mark)");
  });
  it("legacy matcher: an honest RANGE from the base spread to max_total, never a point 0", () => {
    const e = spreadEstimateFromCtx(ctx({ kind: 1, v2: null, baseSpreadBps: 20, maxTotalBps: 80 }), 1_000_000n, 100_000_000n, true);
    expect(e).toEqual({ kind: "range", minBps: 20, maxBps: 80 });
    expect(spreadValueText(e)).toBe("0.20% to 0.80% (est. range, not charged on this market: fills settle at the mark)");
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

describe("fee channel (M-3)", () => {
  it("inFee is carried onto the estimate, worded, and removes the separate cost", () => {
    const e = spreadEstimateFromCtx(ctx(), 1_000_000n, 100_000_000n, true, true)!;
    expect(e).toMatchObject({ kind: "quote", bps: 31, inFee: true });
    expect(spreadValueText(e)).toBe("~0.31% (est., included in the trading fee)");
  });
});

describe("feeBpsWithSpread: decide on the QUOTE, not on 'above base' (M-B)", () => {
  const q = { kind: "quote" as const, bps: 23, execPriceE6: null, inFee: true };
  it("P2 off + a busy-side fee (30 base + 200 util + 23 requested): the estimate is above base WITHOUT the quote, so the requested bps IS added: 253, not 230", () => {
    const est = estimatedTotalFeeBps(30n, { charged: false, requestedBps: 0n, utilFeeBps: 200n });
    expect(est).toBe(230n);
    expect(feeBpsWithSpread(est, q, false)).toBe(253n);
  });
  it("P2 on with a CHARGED quote (30 + 23 + 200): already in the estimate, not added a second time", () => {
    const est = estimatedTotalFeeBps(30n, { charged: true, requestedBps: 23n, utilFeeBps: 200n });
    expect(est).toBe(253n);
    expect(feeBpsWithSpread(est, q, true)).toBe(253n);
  });
  it("P2 off, no busy-side fee: base 30 + 23 = 53; channel off or no estimate: unchanged", () => {
    expect(feeBpsWithSpread(30n, q, false)).toBe(53n);
    expect(feeBpsWithSpread(30n, { kind: "quote", bps: 23, execPriceE6: null }, false)).toBe(30n);
    expect(feeBpsWithSpread(30n, null, false)).toBe(30n);
  });
});
