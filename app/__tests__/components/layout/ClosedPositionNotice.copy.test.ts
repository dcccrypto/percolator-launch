/** #3468 follow-up: the notice states a liquidation price only when the shared display says there is one. */
import { describe, expect, it } from "vitest";
import { noticeCopy } from "@/components/layout/ClosedPositionNotice";
import type { ClosedNotice } from "@/lib/closed-positions";

const base: ClosedNotice = {
  key: "S:1", slab: "S", symbol: "BATON", side: "short", sizeAbs: "5000000", markE6: "10000", liqPriceE6: "16100",
  lastSeenAt: 1_000, detectedAt: 2_000,
};

describe("noticeCopy liquidation price", () => {
  it("states a real price", () => {
    expect(noticeCopy(base, 1_000).body).toContain("Its liquidation price was $0.0161");
  });
  it("says nothing for 0 or the u64::MAX 'no price' sentinel", () => {
    for (const liqPriceE6 of ["0", "18446744073709551615", ""]) {
      expect(noticeCopy({ ...base, liqPriceE6 }, 1_000).body).not.toContain("liquidation price was");
    }
  });
});
