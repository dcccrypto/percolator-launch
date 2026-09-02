import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// #2243 — the footer social icons carried `title` only. `title` is not a reliable
// accessible name (screen readers vary, and it is invisible on keyboard focus), so
// each link needs an explicit aria-label and each decorative glyph aria-hidden.
describe("#2243 footer social links have accessible names", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../../components/layout/Footer.tsx"),
    "utf8",
  );

  const socials = ["GitHub", "X (Twitter)", "Discord", "Telegram"];

  it.each(socials)("labels the %s link", (name) => {
    expect(src).toContain(`aria-label="Percolator on ${name}"`);
  });

  it("hides every decorative social glyph from the a11y tree", () => {
    // Count the social anchors by their aria-labels, then require at least as many
    // aria-hidden svgs — so adding a link without hiding its glyph fails here.
    const labelled = (src.match(/aria-label="Percolator on /g) ?? []).length;
    const hidden = (src.match(/<svg aria-hidden="true"/g) ?? []).length;
    expect(labelled).toBe(socials.length);
    expect(hidden).toBeGreaterThanOrEqual(labelled);
  });
});
