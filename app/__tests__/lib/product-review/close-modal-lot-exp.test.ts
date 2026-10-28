/**
 * Product review 2026-10-28 (T-5): every ClosePositionModal call site passes the market's lot exponent, so the modal's size and entry
 * use the same units as the row it was opened from (Portfolio and the trade page's "other markets" list used to omit it: lotExp 0).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = (rel: string) => readFileSync(path.resolve(__dirname, "../../..", rel), "utf8");
const sites = ["components/portfolio/PortfolioPositionsView.tsx", "components/trade/OtherMarketPositions.tsx"];

describe("close modal lot units", () => {
  it.each(sites)("%s passes lotExp to ClosePositionModal", (rel) => {
    const s = src(rel);
    const i = s.indexOf("<ClosePositionModal");
    expect(i).toBeGreaterThan(-1);
    const block = s.slice(i, s.indexOf("/>", s.indexOf("onConfirm", i)) > 0 ? s.indexOf("onConfirm", i) : i + 2000);
    expect(block).toMatch(/lotExp=\{pos\.lotExp \?\? 0\}/);
  });
});
