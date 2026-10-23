import { describe, it, expect } from "vitest";
import { isLaunchablePriceUsd, lowestLeverageTrackablePriceUsd } from "@/lib/launch-price-floor";
import { minTrackablePriceE6 } from "@/lib/initial-price";

describe("launch price floor", () => {
  it("is the 2x trackable floor: cap 15 bps/slot -> ceil(10000/15) = 667 e6", () => {
    expect(minTrackablePriceE6(15)).toBe(667n);
    expect(lowestLeverageTrackablePriceUsd()).toBeCloseTo(0.000667, 9);
  });
  it("launchable from the floor up; not under it; fails closed on a missing price", () => {
    expect(isLaunchablePriceUsd(0.000667)).toBe(true);
    expect(isLaunchablePriceUsd(0.000666)).toBe(false);
    expect(isLaunchablePriceUsd(0.0047)).toBe(true);
    expect(isLaunchablePriceUsd(null)).toBe(false);
    expect(isLaunchablePriceUsd(0)).toBe(false);
    expect(isLaunchablePriceUsd(Number.NaN)).toBe(false);
  });
});
