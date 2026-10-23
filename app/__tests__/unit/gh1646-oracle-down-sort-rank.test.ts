/**
 * GH#1646: 3 SOL markets (EkQty/DD9Ym/8Wxmx) floated to top of health sort
 * despite showing "No Oracle" badge.
 *
 * Root cause: `computeIsOracleDown` for on-chain markets used ONLY
 * `resolveMarketPriceE6 === 0n`. These SOL markets had a stale non-zero
 * `authorityPriceE6` (last pushed price before oracle stopped), so
 * resolveMarketPriceE6 returned non-zero → oracle-down check returned false →
 * sort rank became "healthy" → markets floated to position #1-3.
 *
 * Fix: When on-chain market has Supabase data with both mark_price AND
 * index_price null/zero (oracle keeper hasn't indexed any crank), treat
 * as oracle-down regardless of stale authorityPriceE6.
 *
 * Verified against PR #1645 preview deployment by QA agent.
 */

import * as fs from "fs";
import * as path from "path";

describe("GH#1646: oracle-down sort rank cross-check (stale authorityPriceE6)", () => {
  const marketsPageSource = fs.readFileSync(
    path.resolve(__dirname, "../../app/markets/page.tsx"),
    "utf-8"
  );

  it("computeIsOracleDown checks mark_price+index_price even when m.onChain is present", () => {
    // The fix adds a secondary check inside the `if (m.onChain)` branch that
    // reads m.supabase.mark_price and m.supabase.index_price.
    // Verify the source contains this secondary check pattern.
    const onChainBranchMatch = marketsPageSource.match(
      /if\s*\(m\.onChain\)[\s\S]*?mark_price[\s\S]*?index_price[\s\S]*?return true/
    );
    expect(onChainBranchMatch).not.toBeNull();
  });

  it("GH#1646 fix comment is present in source", () => {
    expect(marketsPageSource).toContain("GH#1646");
    // Verify the secondary Supabase cross-check is documented
    expect(marketsPageSource).toMatch(/stale.*authorityPriceE6|authorityPriceE6.*stale/i);
  });

  it("computeIsOracleDown still uses resolveMarketPriceE6 as primary check", () => {
    // The primary check (priceE6 === 0n) must still be present before the secondary check
    const primary = marketsPageSource.indexOf("priceE6 === 0n) return true");
    const secondary = marketsPageSource.indexOf("GH#1646: Secondary");
    expect(primary).toBeGreaterThan(-1);
    expect(secondary).toBeGreaterThan(-1);
    // Primary check appears before secondary in source
    expect(primary).toBeLessThan(secondary);
  });

  it("sort order constants: healthy=0 < caution=1 < warning=2 < needs-liquidity=3 < empty-oracle-up=4 < close-only=5 < oracle-down=6 < empty=7 (N18 added the live grades)", () => {
    expect(marketsPageSource).toMatch(
      /\{ healthy: 0, caution: 1, warning: 2, "needs-liquidity": 3, "empty-oracle-up": 4, "close-only": 5, "oracle-down": 6, empty: 7 \}/
    );
  });
});
