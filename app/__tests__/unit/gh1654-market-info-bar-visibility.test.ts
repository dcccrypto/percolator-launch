/**
 * GH#1654 — MarketInfoBar visibility regression
 * Verifies:
 * 1. data-testid="market-info-bar" attribute present
 * 2. sticky positioning class
 * 3. No `hidden` class on the wrapper (visible on all breakpoints)
 * 4. A market logo still reaches the bar (now via MarketSwitcher)
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

const switcherSource = readFileSync(
  join(__dirname, "../../components/trade/MarketSwitcher.tsx"),
  "utf-8"
);

describe("GH#1654 — MarketInfoBar visibility", () => {
  test("has data-testid attribute", () => {
    expect(barSource).toContain('data-testid="market-info-bar"');
  });

  test("is sticky positioned", () => {
    expect(barSource).toContain("sticky");
  });

  // MarketInfoBar no longer imports MarketLogo directly — the logo moved into
  // MarketSwitcher, which the bar renders. The GH#1654 guarantee ("the info bar
  // shows a market logo") is unchanged, so follow the composition rather than
  // asserting on an import that legitimately moved one level down.
  test("renders MarketSwitcher with the logo props", () => {
    expect(barSource).toContain("@/components/trade/MarketSwitcher");
    const usage = barSource.match(/<MarketSwitcher[^>]*>/)?.[0] ?? "";
    expect(usage).toContain("logoUrl");
    expect(usage).toContain("mintAddress");
    expect(usage).toContain("symbol");
  });

  test("MarketSwitcher renders MarketLogo", () => {
    expect(switcherSource).toContain("@/components/market/MarketLogo");
    expect(switcherSource).toMatch(/<MarketLogo[^>]*mintAddress/);
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
