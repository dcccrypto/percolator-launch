import { describe, expect, it, vi } from "vitest";

import { bindConfirmedLimitPrice } from "../../lib/confirmedTrade";

describe("bindConfirmedLimitPrice", () => {
  it("submits the exact worst-fill bound reviewed by the user", () => {
    const trade = vi.fn();
    const reviewedWorstFillPriceE6 = 100_500_000n;

    trade(
      bindConfirmedLimitPrice(
        {
          lpIdx: 3,
          userIdx: 7,
          size: 2_000_000n,
        },
        reviewedWorstFillPriceE6,
      ),
    );

    expect(trade).toHaveBeenCalledWith({
      lpIdx: 3,
      userIdx: 7,
      size: 2_000_000n,
      limitPriceE6: reviewedWorstFillPriceE6,
    });
  });

  it("does not replace the reviewed bound with a later live-price bound", () => {
    const reviewedWorstFillPriceE6 = 100_500_000n;
    const laterLivePriceBoundE6 = 101_500_000n;

    const params = bindConfirmedLimitPrice(
      {
        lpIdx: 1,
        userIdx: 9,
        size: -3_000_000n,
      },
      reviewedWorstFillPriceE6,
    );

    expect(params.limitPriceE6).toBe(reviewedWorstFillPriceE6);
    expect(params.limitPriceE6).not.toBe(laterLivePriceBoundE6);
  });

  it("preserves the existing live-price fallback without a valid reviewed bound", () => {
    const baseParams = {
      lpIdx: 1,
      userIdx: 2,
      size: 1_000_000n,
    };

    expect(bindConfirmedLimitPrice(baseParams)).toEqual(baseParams);
    expect(bindConfirmedLimitPrice(baseParams, 0n)).toEqual(baseParams);
    expect(bindConfirmedLimitPrice(baseParams, 0n)).not.toHaveProperty(
      "limitPriceE6",
    );
  });
});
