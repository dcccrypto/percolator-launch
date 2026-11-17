// @vitest-environment node
// Defensive branches of planLaunchV22 that real SDK defaults can never reach (the SDK's own defaults always
// validate and the default band clears its genesis floor at every legal price). The SDK is mocked at the seam
// to prove the plan turns each refusal into one calm issue and never into params.
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ genesisOk: true, minAnchor: 1231n as bigint | null, rentThrows: false }));

vi.mock("@/lib/v22/sdk", async (orig) => {
  const real = await orig<typeof import("@/lib/v22/sdk")>();
  return {
    ...real,
    bandGenesisPriceOkV22: (...a: Parameters<typeof real.bandGenesisPriceOkV22>) => (mocks.genesisOk ? real.bandGenesisPriceOkV22(...a) : false),
    bandMinWideAnchorV22: (...a: Parameters<typeof real.bandMinWideAnchorV22>) => (mocks.minAnchor === null ? null : real.bandMinWideAnchorV22(...a)),
    assertRentBlockV22: (...a: Parameters<typeof real.assertRentBlockV22>) => {
      if (mocks.rentThrows) throw new Error("bad rent");
      return real.assertRentBlockV22(...a);
    },
  };
});

import { planLaunchV22, toLaunchParams } from "@/lib/v22/launch-plan";
import { V22_COPY } from "@/lib/v22/copy";
import { __setLotMarketsEnabledForTest } from "@/lib/v22/lot";

__setLotMarketsEnabledForTest(true);
const input = { tokenPriceE6: 25_000_000n, collateralDecimals: 6, oracleMode: "keeper" as const, growthOn: true };

describe("planLaunchV22 defensive refusals", () => {
  it("band genesis price too low: band-price-floor issue with the needed price, no params", () => {
    mocks.genesisOk = false;
    const p = planLaunchV22(input);
    expect(p.issues[0]!.code).toBe("band-price-floor");
    expect(p.issues[0]!.message).toBe(V22_COPY.wizard.priceFloor("$0.1231"));
    expect(toLaunchParams(p)).toBeUndefined();
    mocks.genesisOk = true;
  });
  it("no representable wide anchor: the floor line says 'more'", () => {
    mocks.genesisOk = false;
    mocks.minAnchor = null;
    const p = planLaunchV22(input);
    expect(p.issues[0]!.message).toBe(V22_COPY.wizard.priceFloor("more"));
    mocks.genesisOk = true;
    mocks.minAnchor = 1231n;
  });
  it("invalid holding-fee block: rent-invalid issue, no rent, no params", () => {
    mocks.rentThrows = true;
    const p = planLaunchV22(input);
    expect(p.issues[0]).toEqual({ code: "rent-invalid", message: "The holding fee setting isn't valid." });
    expect(p.rent).toBeUndefined();
    expect(toLaunchParams(p)).toBeUndefined();
    mocks.rentThrows = false;
  });
});
