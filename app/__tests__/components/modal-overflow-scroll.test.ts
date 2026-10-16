/**
 * A dialog taller than the screen must scroll, not clip (iPhone landscape is ~340-390px
 * tall; Confirm Trade measures ~565px, Close Position ~740px).
 *
 * `flex items-center` on a fixed overlay centres an overflowing panel, pushing its top
 * (title, X) above the viewport where no scroll can reach it. The overlay scrolls and the
 * panel centres itself with `my-auto`, which falls back to the top edge once it overflows.
 * jsdom has no layout, so this pins the classes; the heights were measured in Chrome.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OVERLAYS = [
  "components/ui/Modal.tsx",
  "components/trade/TradeConfirmationModal.tsx",
  "components/trade/ClosePositionModal.tsx",
  "components/trade/SendPositionNftModal.tsx",
  "components/devnet/DevnetFaucetModal.tsx",
];

const read = (f: string) => fs.readFileSync(path.resolve(__dirname, "../..", f), "utf8");

describe("tall dialogs scroll instead of clipping", () => {
  it.each(OVERLAYS)("%s: overlay scrolls, panel centres with my-auto", (f) => {
    const src = read(f);
    const overlay = src.match(/className=\{?[`"]fixed inset-0[^`"]*/)![0];
    expect(overlay).toContain("overflow-y-auto");
    expect(overlay).not.toContain("items-center");
    expect(src).toMatch(/className=\{?[`"][^`"]*\bmy-auto\b/);
  });

  it("CreatorMarketRow burn-admin dialog scrolls", () => {
    const src = read("components/my-markets/CreatorMarketRow.tsx");
    const burn = src.slice(src.indexOf("{showBurnConfirm && ("));
    expect(burn).toMatch(/^[\s\S]{0,200}fixed inset-0 z-50 flex justify-center overflow-y-auto/);
    expect(burn).toMatch(/^[\s\S]{0,400}mx-4 my-auto/);
  });
});
