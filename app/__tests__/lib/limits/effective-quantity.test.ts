// @vitest-environment node
/**
 * M-3: port of engine 35ddd692 `kernel_adl_effective_quantity_ceil` (v16.rs:1677) and
 * `effective_abs_quantity_for_leg` (:1695). Vectors are hand-derived from those bodies.
 */
import { describe, it, expect } from "vitest";
import {
  adlEffectiveQuantityCeil,
  effectiveLeg,
  MIN_A_SIDE,
  MAX_POSITION_ABS_Q,
  SIDE_MODE_RESET_PENDING,
} from "@/lib/limits/effective-quantity";

const ONE = 1_000_000_000_000_000n;
const asset = (o: Partial<Parameters<typeof effectiveLeg>[0]> = {}) => ({
  aLong: ONE, aShort: ONE, epochLong: 3n, epochShort: 5n, modeLong: 0, modeShort: 0, ...o,
});
const leg = (o: Partial<Parameters<typeof effectiveLeg>[1]> = {}) => ({
  active: true, side: 0, basisPosQ: 1_000_000n, aBasis: ONE, epochSnap: 3n, ...o,
});

describe("adlEffectiveQuantityCeil (kernel_adl_effective_quantity_ceil)", () => {
  it("un-deleveraged: effective == raw", () => {
    expect(adlEffectiveQuantityCeil(22_736_956n, ONE, ONE)).toBe(22_736_956n);
  });
  it("halved side: exact half", () => {
    expect(adlEffectiveQuantityCeil(1_000_000n, ONE, ONE / 2n)).toBe(500_000n);
  });
  it("rounds UP (ceil), never floor: 330_000 at a = 0.6060606…", () => {
    const a = (ONE * 20n) / 33n; // 606_060_606_060_606
    // 330_000 * a / ONE = 199_999.99999999998 -> ceil 200_000 (floor would be 199_999)
    expect(adlEffectiveQuantityCeil(330_000n, ONE, a)).toBe(200_000n);
  });
  it("relative to a leg's own a_basis (opened after a partial ADL)", () => {
    expect(adlEffectiveQuantityCeil(1_000_000n, ONE / 2n, ONE / 4n)).toBe(500_000n);
    expect(adlEffectiveQuantityCeil(1_000_000n, ONE / 2n, ONE / 2n)).toBe(1_000_000n);
  });
  it("InvalidLeg bounds → null", () => {
    expect(adlEffectiveQuantityCeil(MAX_POSITION_ABS_Q + 1n, ONE, ONE)).toBeNull();
    expect(adlEffectiveQuantityCeil(1n, MIN_A_SIDE - 1n, MIN_A_SIDE - 1n)).toBeNull();
    expect(adlEffectiveQuantityCeil(1n, ONE + 1n, ONE)).toBeNull();
    expect(adlEffectiveQuantityCeil(1n, ONE / 2n, ONE)).toBeNull(); // current_a > a_basis
    expect(adlEffectiveQuantityCeil(1n, ONE, 0n)).toBeNull();
  });
});

describe("effectiveLeg (effective_abs_quantity_for_leg)", () => {
  it("current-epoch long scales by a_long; short by a_short and is negative", () => {
    expect(effectiveLeg(asset({ aLong: ONE / 2n }), leg())).toEqual({ kind: "live", absQ: 500_000n, signedQ: 500_000n });
    expect(
      effectiveLeg(asset({ aShort: (ONE * 8617n) / 10_000n }), leg({ side: 1, basisPosQ: -22_736_956n, epochSnap: 5n })),
    ).toEqual({ kind: "live", absQ: 19_592_435n, signedQ: -19_592_435n });
  });
  it("the OTHER side's factor never applies", () => {
    expect(effectiveLeg(asset({ aShort: ONE / 2n }), leg())).toEqual({ kind: "live", absQ: 1_000_000n, signedQ: 1_000_000n });
  });
  it("prior-reset obligation (ResetPending, epoch_snap + 1 == epoch) owns 0", () => {
    expect(effectiveLeg(asset({ epochLong: 4n, modeLong: SIDE_MODE_RESET_PENDING }), leg())).toEqual({ kind: "reset", absQ: 0n, signedQ: 0n });
  });
  it("negative control: a mismatched epoch that is NOT a prior-reset obligation is invalid", () => {
    expect(effectiveLeg(asset({ epochLong: 4n, modeLong: 0 }), leg())).toEqual({ kind: "invalid" });
    expect(effectiveLeg(asset({ epochLong: 5n, modeLong: SIDE_MODE_RESET_PENDING }), leg())).toEqual({ kind: "invalid" });
  });
  it("inactive leg is invalid", () => {
    expect(effectiveLeg(asset(), leg({ active: false }))).toEqual({ kind: "invalid" });
  });
});
