/**
 * The trade-page chart height must stay CLAMPED so it can't balloon on a big
 * monitor or get squished on a laptop (the "chart is sometimes too big/too
 * little" report). Desktop clamps the grid Chart row; mobile clamps the chart
 * container. Guards against a revert to the unbounded `1fr` / `45svh`.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const PAGE = fs.readFileSync(
  path.resolve(__dirname, "../../../app/trade/[slab]/page.tsx"),
  "utf8",
);
const CHART = fs.readFileSync(
  path.resolve(__dirname, "../../../components/trade/TradingChart.tsx"),
  "utf8",
);

describe("trade chart height clamp", () => {
  it("desktop grid Chart row is clamped, not a bare 1fr; dock takes the rest", () => {
    expect(PAGE).toContain("clamp(560px, 72dvh, 860px)");
    expect(PAGE).toContain("minmax(220px, 1fr)");
    // the old unbounded chart row is gone
    expect(PAGE).not.toContain('"auto minmax(0,1fr) minmax(220px,340px)"');
  });

  it("mobile chart container height is clamped (still fills the grid on desktop)", () => {
    expect(CHART).toContain("h-[clamp(400px,60svh,640px)] lg:h-full");
    expect(CHART).not.toContain('"w-full h-[45svh] lg:h-full"');
  });
});
