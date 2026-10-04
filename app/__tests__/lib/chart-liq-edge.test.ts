import { describe, it, expect } from "vitest";
import { liqEdgeFromCoordinate } from "@/lib/chart-liq-edge";

describe("liqEdgeFromCoordinate", () => {
  const H = 400;

  it("returns null when the liq line is within the pane", () => {
    expect(liqEdgeFromCoordinate(0, H)).toBeNull();
    expect(liqEdgeFromCoordinate(200, H)).toBeNull();
    expect(liqEdgeFromCoordinate(H, H)).toBeNull();
  });

  it("flags a line above the top of the pane (negative coordinate)", () => {
    expect(liqEdgeFromCoordinate(-1, H)).toBe("above");
    expect(liqEdgeFromCoordinate(-5000, H)).toBe("above");
  });

  it("flags a line below the bottom of the pane", () => {
    expect(liqEdgeFromCoordinate(H + 1, H)).toBe("below");
    expect(liqEdgeFromCoordinate(10_000, H)).toBe("below");
  });

  it("treats a missing coordinate or an unlaid-out pane as not-off-screen", () => {
    expect(liqEdgeFromCoordinate(null, H)).toBeNull();
    expect(liqEdgeFromCoordinate(Number.NaN, H)).toBeNull();
    expect(liqEdgeFromCoordinate(-10, 0)).toBeNull();
    expect(liqEdgeFromCoordinate(-10, -5)).toBeNull();
  });
});
