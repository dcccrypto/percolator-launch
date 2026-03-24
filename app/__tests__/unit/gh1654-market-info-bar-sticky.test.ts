/**
 * GH#1654: MarketInfoBar — sticky positioning + data-testid
 *
 * Verifies that:
 * 1. MarketInfoBar component has data-testid="market-info-bar" in its root element
 * 2. Desktop wrapper in trade page uses sticky top-0 z-30 for correct scroll behavior
 * 3. MarketInfoBar is only visible on lg+ (hidden on mobile — mobile uses its own sticky header)
 */

import { readFileSync } from "fs";
import { join } from "path";

const MARKET_INFO_BAR = join(__dirname, "../../components/trade/MarketInfoBar.tsx");
const TRADE_PAGE = join(__dirname, "../../app/trade/[slab]/page.tsx");

describe("GH#1654 — MarketInfoBar sticky + data-testid", () => {
  let barSource: string;
  let pageSource: string;

  beforeAll(() => {
    barSource = readFileSync(MARKET_INFO_BAR, "utf-8");
    pageSource = readFileSync(TRADE_PAGE, "utf-8");
  });

  it('MarketInfoBar root element has data-testid="market-info-bar"', () => {
    expect(barSource).toContain('data-testid="market-info-bar"');
  });

  it("Desktop wrapper has sticky top-0 z-30 classes", () => {
    // The wrapper div around MarketInfoBar on desktop must be sticky
    expect(pageSource).toMatch(/sticky\s+top-0\s+z-30[^>]*hidden\s+lg:block|hidden\s+lg:block[^>]*sticky\s+top-0\s+z-30/);
  });

  it("MarketInfoBar is hidden on mobile (hidden lg:block wrapper)", () => {
    expect(pageSource).toMatch(/hidden\s+lg:block/);
    // Confirm MarketInfoBar is inside the hidden lg:block section
    const wrapperIdx = pageSource.indexOf("sticky top-0 z-30 hidden lg:block");
    const barIdx = pageSource.indexOf("<MarketInfoBar", wrapperIdx);
    expect(barIdx).toBeGreaterThan(wrapperIdx);
    expect(barIdx - wrapperIdx).toBeLessThan(200); // MarketInfoBar is immediately inside the wrapper
  });

  it("MarketInfoBar has backdrop-blur-sm for glass effect", () => {
    expect(barSource).toContain("backdrop-blur-sm");
  });
});
