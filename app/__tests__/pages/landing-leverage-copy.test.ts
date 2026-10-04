/**
 * The landing page's "Go long or short" step and the site-wide ticker promised "up to 20x
 * leverage"; the cap is MAX_LEVERAGE_X (10), enforced by the create wizard. Both now read
 * the constant.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("leverage claims read the enforced cap", () => {
  it.each(["app/page.tsx", "components/layout/TickerBanner.tsx"])("%s takes the number from MAX_LEVERAGE_X", (file) => {
    const src = readFileSync(resolve(process.cwd(), file), "utf8");
    expect(src).toContain("up to ${MAX_LEVERAGE_X}x leverage");
    expect(src).not.toMatch(/up to \d+x leverage/);
  });
});
