/**
 * Discord report: a white line flashed under the /markets table header on every sort click.
 * Rows have `transition-all` and only rows past the first had a top border, colour included. A re-sort
 * moving a row into or out of first place removed (or added) the colour class, so the border fell back
 * to Tailwind v4's default (currentColor, the near-white text) and faded toward it for 200 ms.
 * The colour is now on every row; only the width depends on the row index.
 * Source check, like the other /markets page tests: the page needs every discovery/stats hook to render.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const src = fs.readFileSync(path.resolve(__dirname, "../../app/markets/page.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("/markets rows keep their top-border colour across a re-sort", () => {
  it("every row carries the top-border colour; only the width depends on the index", () => {
    expect(src).toMatch(/"border-t-\[color:var\(--border\)\]",\s*i > 0 \? "border-t" : "",/);
  });

  it("rows transition colours only, so a border width change doesn't animate either", () => {
    expect(src).toContain("py-3 transition-colors duration-200 hover:bg-[var(--accent)]/[0.06] border-l-2");
  });

  it("the colour is never tied to the row index", () => {
    expect(src).not.toMatch(/i > 0 \? "border-t border-\[var\(--border\)\]"/);
  });
});
