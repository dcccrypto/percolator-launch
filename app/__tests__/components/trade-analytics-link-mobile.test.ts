/**
 * #62: the only link from a trade page to /analytics/[slab] was in the AnalyticsDock, which is
 * desktop-only (hidden below lg). Phones and tablets now get a "Full analytics" link on the
 * Market details line.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const page = readFileSync(resolve(process.cwd(), "app/trade/[slab]/page.tsx"), "utf8");
const dock = readFileSync(resolve(process.cwd(), "components/trade/AnalyticsDock.tsx"), "utf8");

function linkTag(): string {
  const at = page.indexOf('data-testid="market-analytics-link"');
  expect(at, "analytics link").toBeGreaterThan(-1);
  return page.slice(page.lastIndexOf("<a", at), page.indexOf(">", at));
}

describe("#62: analytics link below lg", () => {
  it("the dock that carries the desktop link is hidden below lg", () => {
    expect(dock).toMatch(/className=\{`fixed inset-x-0 bottom-0[^`]*\bhidden\b[^`]*\blg:block\b/);
  });

  it("the trade page links to /analytics/[slab], shown only below lg", () => {
    const tag = linkTag();
    expect(tag).toContain("href={`/analytics/${slab}`}");
    expect(tag.split(/[\s"]+/)).toContain("lg:hidden");
  });

  it("the link sits outside <details>, so a tap navigates instead of toggling it", () => {
    const at = page.indexOf('data-testid="market-analytics-link"');
    expect(page.indexOf("</details>")).toBeLessThan(at);
    expect(page.indexOf('data-testid="market-details"')).toBeLessThan(at);
  });

  it("it's pinned to the Market details line: absolute inside a relative wrapper", () => {
    expect(linkTag().split(/[\s"]+/)).toContain("absolute");
    const details = page.indexOf('data-testid="market-details"');
    expect(page.slice(page.lastIndexOf("<div", details), details)).toMatch(/<div className="relative">\s*<details $/);
  });
});
