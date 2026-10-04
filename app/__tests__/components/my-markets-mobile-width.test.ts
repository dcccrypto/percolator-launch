/**
 * /my-markets was 654px wide on a 390px phone: each market row was one non-wrapping flex line of
 * fixed-width columns, and <html> clips horizontal overflow, so the right half of the row
 * (liquidity, insurance, health and the expand chevron, which opens the claim/logo drawer) was
 * cut off and unreachable. The rows now wrap below `sm`; the stat cells can shrink and use a
 * smaller figure on phones. Measured with Playwright at 390x844: scrollWidth 654 -> 390.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8");

describe("/my-markets fits a phone", () => {
  it("the market row wraps below sm and stays one line from sm up", () => {
    expect(read("components/my-markets/CreatorMarketRow.tsx")).toContain(
      'className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-left transition-colors hover:bg-[var(--bg-elevated)] sm:flex-nowrap"',
    );
  });

  it("stat cells can shrink in the two-column phone grid", () => {
    const page = read("app/my-markets/page.tsx");
    expect(page).toContain('<div key={stat.label} className="min-w-0 bg-[var(--panel-bg)] p-5');
    expect(page).toContain('className="text-base font-bold tabular-nums text-[var(--text)] sm:text-xl"');
  });
});
