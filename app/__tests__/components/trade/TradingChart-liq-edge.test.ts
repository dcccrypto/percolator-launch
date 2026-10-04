/**
 * The liquidation line can be drawn off the top/bottom of the visible price
 * range (a far-above-entry liq on a low-leverage short), where lightweight-charts
 * never autoscales to include it — so the user can't see their liq. A pinned
 * chip points to the edge it hides behind.
 *
 * Source-binding (same rationale as PositionsDock-sticky-actions.test): rendering
 * TradingChart to assert this would need the whole lightweight-charts +
 * price-store + provider stack. Instead we bind the wiring.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../../../components/trade/TradingChart.tsx"),
  "utf8",
);

describe("TradingChart off-screen liq indicator", () => {
  it("derives the edge from the pure helper (unit-tested separately)", () => {
    expect(SRC).toContain("liqEdgeFromCoordinate");
  });

  it("renders the chip only when the liq line exists and is off-screen", () => {
    expect(SRC).toMatch(/liqLinePrice != null && liqEdge/);
  });

  it("mirrors the edge in a ref so the hot tick path re-renders only on a flip", () => {
    expect(SRC).toContain("liqEdgeRef");
    expect(SRC).toMatch(/next !== liqEdgeRef\.current/);
  });

  it("rechecks the edge on the tick path and on pan/zoom, not just on redraw", () => {
    // Appears in the line-draw effect, the live-tick effect, and the
    // visible-range handler.
    const calls = SRC.match(/recomputeLiqEdge\(\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});
