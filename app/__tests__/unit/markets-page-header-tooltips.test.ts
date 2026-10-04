/**
 * /markets column headers: only VAULT explained itself on hover. Every metric header now carries
 * a tooltip saying what it measures, in the same `title` form as VAULT.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { BANNED } from "@/__tests__/lib/banned-terms-harvest";

const src = fs.readFileSync(path.resolve(__dirname, "../../app/markets/page.tsx"), "utf8");
const header = src.slice(src.indexOf("<div>token</div>"), src.indexOf("health</div>") + "health</div>".length);

const titleOf = (label: RegExp) => {
  const m = header.match(new RegExp(`title="([^"]+)">${label.source}`));
  return m ? m[1] : null;
};

describe("/markets column header tooltips", () => {
  it.each([
    ["price", /price</],
    ["OI", /OI</],
    ["vol", /vol</],
    ["vault", /vault</],
    ["max lev", /<span className="sm:hidden">lev</],
    ["health", /health</],
  ])("%s has a tooltip", (_name, label) => {
    expect(titleOf(label)).toBeTruthy();
  });

  it("OI and vol say they follow the USD / tokens filter", () => {
    expect(titleOf(/OI</)).toMatch(/open interest/i);
    expect(titleOf(/OI</)).toMatch(/USD or in tokens/);
    expect(titleOf(/vol</)).toMatch(/24 hours/);
    expect(titleOf(/vol</)).toMatch(/USD or in tokens/);
  });

  it("health names the labels the column shows", () => {
    for (const label of ["Healthy", "Caution", "Low Liquidity", "No Oracle"]) {
      expect(titleOf(/health</)).toContain(label);
    }
  });

  it("no tooltip uses a banned term", () => {
    const titles = [...header.matchAll(/title="([^"]+)"/g)].map((m) => m[1]);
    expect(titles.length).toBe(6);
    for (const t of titles) for (const [term, re] of BANNED) expect(t, term).not.toMatch(re);
  });
});
