/**
 * S27: the desktop results count on /markets printed "0 MARKETS" for the whole cold load (the list
 * of active markets is empty until stats load). The mobile count already showed "… MARKETS".
 * Source check, like the other /markets page tests: the page needs every discovery/stats hook to render.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const src = fs.readFileSync(path.resolve(__dirname, "../../app/markets/page.tsx"), "utf8").replace(/\r\n/g, "\n");
const block = (marker: string) => {
  const i = src.indexOf(marker);
  return src.slice(i, src.indexOf("</span>", i));
};

describe("/markets results count while loading", () => {
  it("the desktop count shows the loading text before the count, like the mobile one", () => {
    const desktop = block("{/* Results count — desktop only");
    expect(desktop).toMatch(/\{loading\s*\?\s*"\u2026 MARKETS"/);
    const mobile = block("{/* Results count — mobile only");
    expect(mobile).toMatch(/\{loading\s*\?\s*<>&hellip; MARKETS<\/>/);
  });
});
