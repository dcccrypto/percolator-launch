import { describe, expect, it } from "vitest";
import { v17MarketAccountLen } from "@percolatorct/sdk";
import { MARKET_HEALTH_SLICE_LEN } from "@/lib/market-health";

describe("market health slice vs a one-slot market", () => {
  it("the slice is no longer than a one-slot market account (zero slack today): growth of slot 0 must fail here, not make the health route skip one-slot markets", () => {
    expect(MARKET_HEALTH_SLICE_LEN).toBeLessThanOrEqual(v17MarketAccountLen(1));
  });
});
