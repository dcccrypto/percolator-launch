/**
 * The positions dock is a wide (10-column) horizontally-scrolling table, so on a
 * phone the rightmost Close / Share-PnL actions scroll off the right edge and are
 * unreachable without sideways-scrolling the table. They are pinned (sticky
 * right-0) with an opaque background so they stay in view.
 *
 * Source-binding (same rationale as LiveMarketRail-header.test): asserting a
 * layout class by rendering the dock would need a dozen hook/provider mocks.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../../../components/trade/PositionsDock.tsx"),
  "utf8",
);

describe("PositionsDock sticky action column", () => {
  it("pins the Close header to the right edge with an opaque background", () => {
    expect(SRC).toMatch(/<th className="sticky right-0 z-20[^"]*bg-\[var\(--panel-bg\)\][^"]*">Close<\/th>/);
  });

  it("pins the action cell (Share PnL + Close) to the right edge", () => {
    const tdIdx = SRC.indexOf('<td className="sticky right-0 z-10');
    expect(tdIdx).toBeGreaterThan(-1);
    // The pinned cell is the one that holds the actions.
    expect(SRC.slice(tdIdx, tdIdx + 400)).toContain("PnlShareButton");
    expect(SRC.slice(tdIdx, tdIdx + 400)).toContain("bg-[var(--panel-bg)]");
  });
});
