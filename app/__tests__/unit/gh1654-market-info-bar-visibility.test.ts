/**
 * GH#1654 — MarketInfoBar visibility regression
 * Verifies:
 * 1. data-testid="market-info-bar" attribute present
 * 2. sticky positioning class
 * 3. No `hidden` class on the wrapper (visible on all breakpoints)
 * 4. MarketLogo is imported and rendered
 */

import { readFileSync } from "fs";
import { join } from "path";

const barSource = readFileSync(
  join(__dirname, "../../components/trade/MarketInfoBar.tsx"),
  "utf-8"
);

const pageSource = readFileSync(
  join(__dirname, "../../app/trade/[slab]/page.tsx"),
  "utf-8"
);

describe("GH#1654 — MarketInfoBar visibility", () => {
  test("has data-testid attribute", () => {
    expect(barSource).toContain('data-testid="market-info-bar"');
  });

  test("is sticky positioned", () => {
    expect(barSource).toContain("sticky");
  });

  test("still renders a market logo (now via MarketSwitcher)", () => {
    // GH#1654 asked that the info bar show the market's logo. It no longer
    // imports MarketLogo DIRECTLY — the symbol + logo became a dropdown market
    // switcher — so assert the requirement through the indirection instead of
    // pinning the old import, which asserted the implementation rather than the
    // behaviour and started failing on a pure refactor.
    expect(barSource).toContain("MarketSwitcher");
    expect(barSource).toContain("@/components/trade/MarketSwitcher");

    const switcherSource = readFileSync(
      join(__dirname, "../../components/trade/MarketSwitcher.tsx"),
      "utf-8"
    );
    expect(switcherSource).toContain("@/components/market/MarketLogo");
    expect(switcherSource).toMatch(/<MarketLogo\b/);
  });

  test("page renders MarketInfoBar without hidden wrapper", () => {
    // Find the MarketInfoBar JSX usage line
    const lines = pageSource.split("\n");
    const barLine = lines.findIndex((l) => l.includes("<MarketInfoBar"));
    expect(barLine).toBeGreaterThan(-1);

    // The previous line should NOT contain "hidden" class
    const prevLine = lines[barLine - 1] ?? "";
    // Allow "hidden" only if it's part of lg:hidden (mobile header), not wrapping MarketInfoBar
    const wrapperLine = lines.slice(Math.max(0, barLine - 3), barLine).join(" ");
    expect(wrapperLine).not.toMatch(/className="[^"]*hidden[^"]*"/);
  });

  test("passes mintAddress prop", () => {
    expect(pageSource).toMatch(/MarketInfoBar[^>]*mintAddress/);
  });
});
