/**
 * #3609: the wrapper's favourable-side close refusal (Custom 104, `band_favourable_close_refused_view` on
 * feat/v22-rc23-2026-10-22) binds ANY fill whose REDUCING part lands on the favoured side: a partial close, a full
 * close, or a flip (the whole instruction fails, so the flip's opening part never lands either). An order that only
 * grows the position is not refused by this rule. `orderBlockedByBand` is that rule on top of `closeBlockedByBand`.
 */
import { describe, expect, it } from "vitest";
import { closeBlockedByBand, orderBlockedByBand, type BandRentView } from "@/lib/v22/band-rent-state";

const view = (lagging: boolean, favourableCloseSide: "long" | "short" | null, floorStuck = false): BandRentView =>
  ({
    assetIndex: 0,
    lotExp: 0,
    band: { enabled: true, bandBps: 130, epochSlots: 0n, pinSlots: 0n, maxPositionsPerSide: 0n, minLegNotionalAtoms: 0n, recoveryMinutes: 0 },
    price: { capBpsPerSlot: 4n, markE6: 110_000_000n, targetE6: 100_000_000n, lagging, floorStuck, favourableCloseSide },
    rent: { enabled: false, maxE9PerSlot: 0n, kinkBps: 0, rateLongE9: 0n, rateShortE9: 0n },
  }) as BandRentView;

const LONG = 40_000_000n;

describe("orderBlockedByBand mirrors band_favourable_close_refused_view", () => {
  const longFavoured = view(true, "long");
  it("a long on the favoured side: partial close, full close and flip are refused", () => {
    expect(orderBlockedByBand(longFavoured, LONG, -5_000_000n)).toBe(true); // partial
    expect(orderBlockedByBand(longFavoured, LONG, -LONG)).toBe(true); // full
    expect(orderBlockedByBand(longFavoured, LONG, -50_000_000n)).toBe(true); // flip to short 10
  });
  it("a short on the favoured side is refused the same way", () => {
    const shortFavoured = view(true, "short");
    expect(orderBlockedByBand(shortFavoured, -LONG, 5_000_000n)).toBe(true);
    expect(orderBlockedByBand(shortFavoured, -LONG, 50_000_000n)).toBe(true);
  });
  it("CONTROL: an increase on the same side, or a fresh open, is never refused by this rule", () => {
    expect(orderBlockedByBand(longFavoured, LONG, 5_000_000n)).toBe(false);
    expect(orderBlockedByBand(longFavoured, 0n, -5_000_000n)).toBe(false);
    expect(orderBlockedByBand(longFavoured, 0n, 5_000_000n)).toBe(false);
    expect(orderBlockedByBand(longFavoured, LONG, 0n)).toBe(false);
  });
  it("CONTROL: the unfavoured side, a price that is not lagging, a floor-stuck price, or no band view: not refused", () => {
    expect(orderBlockedByBand(view(true, "short"), LONG, -5_000_000n)).toBe(false);
    expect(orderBlockedByBand(view(false, null), LONG, -5_000_000n)).toBe(false);
    expect(orderBlockedByBand(view(true, null, true), LONG, -5_000_000n)).toBe(false);
    expect(orderBlockedByBand(null, LONG, -5_000_000n)).toBe(false);
  });
  it("agrees with closeBlockedByBand for a full close (one source of truth)", () => {
    for (const v of [view(true, "long"), view(true, "short"), view(false, null), view(true, null, true)]) {
      expect(orderBlockedByBand(v, LONG, -LONG)).toBe(closeBlockedByBand(v, "long"));
      expect(orderBlockedByBand(v, -LONG, LONG)).toBe(closeBlockedByBand(v, "short"));
    }
  });
});
