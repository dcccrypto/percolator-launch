import { describe, expect, it } from "vitest";
import { liqEdgeFromRange } from "@/lib/tv/liqEdge";

const R = { from: 0.0030, to: 0.0040 };
describe("liqEdgeFromRange", () => {
  it("above / below the visible price range", () => {
    expect(liqEdgeFromRange(1.1583, R)).toBe("above"); // Squid's real report: liq $1.1583 vs a ~$0.045 chart
    expect(liqEdgeFromRange(0.001, R)).toBe("below");
  });
  it("NEGATIVE CONTROLS: in view, exactly on the edge, no liq, no/invalid range -> null", () => {
    expect(liqEdgeFromRange(0.0035, R)).toBeNull();
    expect(liqEdgeFromRange(0.0040, R)).toBeNull();
    expect(liqEdgeFromRange(0.0030, R)).toBeNull();
    expect(liqEdgeFromRange(null, R)).toBeNull();
    expect(liqEdgeFromRange(0, R)).toBeNull();
    expect(liqEdgeFromRange(NaN, R)).toBeNull();
    expect(liqEdgeFromRange(2, null)).toBeNull();
    expect(liqEdgeFromRange(2, { from: 1, to: 1 })).toBeNull();
    expect(liqEdgeFromRange(2, { from: NaN, to: 1 })).toBeNull();
  });
});
