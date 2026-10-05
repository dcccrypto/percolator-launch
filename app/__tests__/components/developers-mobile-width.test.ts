/**
 * #65: on phones /developers was 444px wide at 390px. The Risk Engine formula cards are grid items,
 * whose min-width defaults to their content, so the longest formula line widened the card and the
 * page (the code block's own overflow-x-auto never applied). min-w-0 lets the cards shrink and the
 * code blocks scroll. Layout was measured in Chromium; this pins the class.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(resolve(process.cwd(), "app/developers/DevelopersClient.tsx"), "utf8");

describe("#65: /developers fits a phone", () => {
  it("both formula cards can shrink below their code's width", () => {
    const cards = [...src.matchAll(/<div className="([^"]*)">\s*<h3[^>]*>\s*(H — Fair Exits|A\/K — Fair Overhang)/g)];
    expect(cards).toHaveLength(2);
    for (const [, cls, title] of cards) expect(cls.split(/\s+/), title).toContain("min-w-0");
  });

  it("their code blocks scroll sideways", () => {
    const pres = [...src.matchAll(/<pre className="([^"]*)"/g)].map((m) => m[1].split(/\s+/));
    expect(pres.length).toBeGreaterThanOrEqual(2);
    for (const cls of pres) expect(cls).toContain("overflow-x-auto");
  });
});
