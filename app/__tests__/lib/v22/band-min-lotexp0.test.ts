/**
 * #3604: on a band market without lots (lotExp 0: every token priced at $10 or more), bandMinLeg rounded the minimum up
 * to a whole "lot", which there is a whole token. A $5,000 token with a 100 USDC minimum showed "1 lots (about 5,000
 * USDC)" and refused every order under one token, though the program takes any leg worth 100 USDC.
 */
import { describe, expect, it } from "vitest";
import { bandMinLeg, bandMinLegExactQ, legBelowBandMin, minNotionalUnitsUp, type BandRentView } from "@/lib/v22/band-rent-state";

const view = (lotExp: number, markE6: bigint, minLegNotionalAtoms = 100_000_000n): BandRentView =>
  ({
    assetIndex: 0,
    lotExp,
    band: { enabled: true, bandBps: 130, epochSlots: 600n, pinSlots: 9000n, maxPositionsPerSide: 256n, minLegNotionalAtoms, recoveryMinutes: 64 },
    price: { markE6, targetE6: markE6, lagging: false, floorStuck: false, favourableCloseSide: null },
    rent: { enabled: false, maxE9PerSlot: 0n, kinkBps: 0, rateLongE9: 0n, rateShortE9: 0n },
  }) as unknown as BandRentView;

describe("#3604: the band minimum on a market without lots", () => {
  const v = view(0, 5_000_000_000n); // $5,000 per token, 100 USDC minimum

  it("is the exact minimum (0.02 token = 100 USDC), not one whole token", () => {
    const m = bandMinLeg(v)!;
    expect(m.wholeLots).toBe(false);
    expect(m.minQ).toBe(20_000n);
    expect(m.notionalAtoms).toBe(100_000_000n);
    expect(m.minQ).toBeGreaterThanOrEqual(bandMinLegExactQ(v)!);
  });

  it("a 0.5-token order (2,500 USDC) is allowed; 0.01 token (50 USDC) is still refused", () => {
    expect(legBelowBandMin(v, 0n, 500_000n)).toBe(false);
    expect(legBelowBandMin(v, 0n, 10_000n)).toBe(true);
  });

  it("an uneven minimum rounds up, so the program's floored notional still meets it", () => {
    const odd = bandMinLeg(view(0, 3_000_000_000n))!; // 100 / 3,000 = 0.0333… token
    expect(odd.minQ).toBe(33_334n);
    expect(odd.notionalAtoms).toBeGreaterThanOrEqual(100_000_000n);
    expect(legBelowBandMin(view(0, 3_000_000_000n), 0n, 33_333n)).toBe(true);
  });

  it("CONTROL: a lot market keeps whole lots (100 USDC at 32.12 per lot = 4 lots)", () => {
    const m = bandMinLeg(view(1, 32_116_513n))!;
    expect(m.lots).toBe(4n);
    expect(m.minQ).toBe(4_000_000n);
  });
});

describe("#3604 follow-up: the shown minimum is one the program accepts when typed", () => {
  // The ticket turns a typed notional N (atoms) into Q = floor(N * 1e6 / mark).
  const typedQ = (shownUnits: number, markE6: bigint): bigint => (BigInt(Math.round(shownUnits * 100)) * 10_000n * 1_000_000n) / markE6;

  it("$10.003001: the floored notional is exactly 100.000000 but the product is above it, so the figure is 100.01, not 100", () => {
    const v = view(0, 10_003_001n);
    const m = bandMinLeg(v)!;
    expect(m.minQ).toBe(9_997_000n);
    const shown = minNotionalUnitsUp(m.notionalAtoms, 6);
    expect(shown).toBe(100.01);
    expect(typedQ(shown, 10_003_001n)).toBeGreaterThanOrEqual(m.minQ);
    expect(legBelowBandMin(v, 0n, typedQ(shown, 10_003_001n))).toBe(false);
  });

  it("over 20,000 marks from $10 to $10.02, typing the shown minimum is never refused", () => {
    for (let markE6 = 10_000_000n; markE6 < 10_020_000n; markE6 += 1n) {
      const v = view(0, markE6);
      const shown = minNotionalUnitsUp(bandMinLeg(v)!.notionalAtoms, 6);
      if (legBelowBandMin(v, 0n, typedQ(shown, markE6))) throw new Error(`mark ${markE6}: shown ${shown} is refused`);
    }
  });

  it("rounds up to the cent in integer maths, at any decimals", () => {
    expect(minNotionalUnitsUp(100_000_000n, 6)).toBe(100);
    expect(minNotionalUnitsUp(100_000_004n, 6)).toBe(100.01);
    expect(minNotionalUnitsUp(128_466_052n, 6)).toBe(128.47);
    expect(minNotionalUnitsUp(3n, 1)).toBe(0.3); // float 3 / 0.1 = 30.000000000000004 would show 0.31
    expect(minNotionalUnitsUp(100n, 0)).toBe(100);
  });
});
