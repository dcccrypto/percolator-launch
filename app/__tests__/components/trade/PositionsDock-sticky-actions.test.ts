/**
 * The positions dock is a wide (10-column) horizontally-scrolling table, so on a
 * phone the rightmost Close / Share-PnL actions scroll off the right edge and are
 * unreachable without sideways-scrolling the table. They are pinned (sticky
 * right-0) with an opaque background so they stay in view. Since the phone card
 * layout (#3465) the pin applies from `lg` up (`lg:sticky`); below `lg` the row is
 * a card and the actions take their own full-width row, so nothing needs pinning.
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
    expect(SRC).toMatch(/<th className="lg:sticky right-0 z-20[^"]*bg-\[var\(--panel-bg\)\][^"]*">Close<\/th>/);
  });

  it("pins the action cell (Share PnL + Close) to the right edge", () => {
    const tdIdx = SRC.indexOf("<td className={`lg:sticky right-0 z-10");
    expect(tdIdx).toBeGreaterThan(-1);
    // The pinned cell is the one that holds the actions.
    expect(SRC.slice(tdIdx, tdIdx + 400)).toContain("PnlShareButton");
    expect(SRC.slice(tdIdx, tdIdx + 400)).toContain("bg-[var(--panel-bg)]");
  });

  it("lifts an open row menu above the next row's pinned cell", () => {
    // Each pinned cell is its own z-10 stacking context, so the next row's cell
    // (later in the DOM) would paint over this row's open NFT menu.
    const tdIdx = SRC.indexOf("<td className={`lg:sticky right-0 z-10");
    expect(SRC.slice(tdIdx, tdIdx + 120)).toContain("has-[[role=menu]]:z-30");
  });

  it("below lg the actions are a full-width card row, not pinned (#3465)", () => {
    const tdIdx = SRC.indexOf("<td className={`lg:sticky right-0 z-10");
    expect(SRC.slice(tdIdx, tdIdx + 300)).toContain("${MOBILE_CARD_ACTIONS}");
    // no unconditional sticky pin is left on the header or the action cell
    expect(SRC).not.toMatch(/<th className="sticky right-0/);
    expect(SRC).not.toMatch(/<td className=\{`sticky right-0/);
  });
});
