/**
 * M-8: the wizard must refuse an opening price so small that the mark cannot
 * move once the market has open interest.
 *
 * `clampTowardEngineDt` below is a line-for-line port of the deployed rule
 * (wrapper 553d76f0, `oracle_v16::clamp_toward_engine_dt`):
 *
 *   max_delta = p_last * cap_bps * dt_slots / 10_000   (u128, floor)
 *   target > p_last ? min(target, p_last + max_delta) : max(target, p_last - max_delta)
 *
 * The tests prove the floor is EXACT: at the floor a one-slot accrual moves
 * the mark, one atom below it the mark is frozen, for every leverage the
 * wizard offers.
 */
import { describe, expect, it } from "vitest";
import {
  minTrackablePriceE6,
  toInitialPriceE6,
  withTrackableFloor,
} from "@/lib/initial-price";
import { deriveLaunchMarketParams, MAX_LEVERAGE_X, MIN_LEVERAGE_X } from "@/lib/market-params";

function clampTowardEngineDt(pLast: bigint, target: bigint, capBps: bigint, dt: bigint): bigint {
  if (pLast === 0n || target === 0n) return target;
  if (capBps === 0n || dt === 0n) return pLast;
  const maxDelta = (pLast * capBps * dt) / 10_000n;
  if (target > pLast) return target < pLast + maxDelta ? target : pLast + maxDelta;
  const lo = pLast > maxDelta ? pLast - maxDelta : 0n;
  return target > lo ? target : lo;
}

function capFor(leverage: number): number {
  return deriveLaunchMarketParams({
    initialMarginBps: Math.ceil(10_000 / leverage),
    lpCollateral: 0n,
    initialPriceE6: 1_000_000n,
  }).maxPriceMoveBpsPerSlot;
}

describe("minTrackablePriceE6 matches the deployed price-move clamp", () => {
  for (let lev = MIN_LEVERAGE_X; lev <= MAX_LEVERAGE_X; lev++) {
    it(`${lev}x: moves at the floor, frozen one atom below it`, () => {
      const cap = capFor(lev);
      const min = minTrackablePriceE6(cap);
      const c = BigInt(cap);
      // At the floor, a one-slot accrual toward a far target moves both ways.
      expect(clampTowardEngineDt(min, min * 2n, c, 1n)).toBeGreaterThan(min);
      expect(clampTowardEngineDt(min, 1n, c, 1n)).toBeLessThan(min);
      // One atom below, it is stuck no matter how far the target is.
      const below = min - 1n;
      expect(clampTowardEngineDt(below, below * 100n, c, 1n)).toBe(below);
      expect(clampTowardEngineDt(below, 1n, c, 1n)).toBe(below);
    });
  }

  it("10x (cap 4 bps) floors at $0.0025; 2x (cap 15 bps) at $0.000667", () => {
    expect(capFor(10)).toBe(4);
    expect(minTrackablePriceE6(4)).toBe(2_500n);
    expect(minTrackablePriceE6(15)).toBe(667n);
  });

  it("the live PERC price (~$0.0036) is still accepted at 10x", () => {
    expect(withTrackableFloor(toInitialPriceE6("0.0036"), 4)).toEqual({ ok: true, e6: 3_600n });
  });
});

describe("withTrackableFloor refuses below the floor with the reason", () => {
  it("BONK-sized price at 10x is refused, with the floor attached", () => {
    expect(withTrackableFloor(toInitialPriceE6("0.00002"), 4)).toEqual({
      ok: false,
      reason: "below-trackable",
      price: 0.00002,
      minPrice: 0.0025,
    });
  });

  it("exactly the floor is accepted", () => {
    expect(withTrackableFloor(toInitialPriceE6("0.0025"), 4)).toEqual({ ok: true, e6: 2_500n });
    expect(withTrackableFloor(toInitialPriceE6("0.002499"), 4)).toMatchObject({ reason: "below-trackable" });
  });

  it("passes other failures through untouched", () => {
    expect(withTrackableFloor(toInitialPriceE6(null), 4)).toEqual({ ok: false, reason: "missing" });
    expect(withTrackableFloor(toInitialPriceE6("0.00000001"), 4)).toMatchObject({ reason: "below-minimum" });
  });
});

describe("devnet v2.2 lot markets: the floor applies to the per-LOT price (browser E2E 2026-10-16)", () => {
  // 8PzFWyLp…pump at $0.001794 (1,794 e6), 10x cap 4 bps -> floor 2,500 e6 per priced unit.
  const tok = { ok: true as const, e6: 1_794n };
  it("a lot of 10^4 tokens ($17.94) moves: launchable", () => {
    expect(withTrackableFloor(tok, 4, 4)).toEqual(tok);
  });
  it("NEGATIVE CONTROL: priced per token (lotExp 0) it is still refused, reported per token", () => {
    expect(withTrackableFloor(tok, 4, 0)).toEqual({ ok: false, reason: "below-trackable", price: 0.001794, minPrice: 0.0025 });
    expect(withTrackableFloor(tok, 4)).toMatchObject({ ok: false, reason: "below-trackable" });
  });
  it("too small even per lot: minPrice is the per-token floor for that lot", () => {
    expect(withTrackableFloor({ ok: true, e6: 1n }, 4, 2)).toEqual({ ok: false, reason: "below-trackable", price: 0.000001, minPrice: 0.000025 });
  });
});
