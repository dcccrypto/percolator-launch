// @vitest-environment node
/**
 * /markets labelled the engine vault "liquidity". /api/markets fills vault_balance from the engine
 * vault (LP capital + trader margin + insurance), while the trade page's "Market LP" is the LP
 * portfolio's capital alone, so the same market read 5-17x larger on /markets (devnet,
 * 2026-10-01: SI $8.87K vs $508.94). The list route deliberately skips the LP scan, so the column
 * is labelled for what it is.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const src = fs.readFileSync(path.resolve(__dirname, "../../app/markets/page.tsx"), "utf8");

describe("/markets vault column", () => {
  it("is headed 'vault', with a tooltip saying what it holds", () => {
    expect(src).not.toMatch(/>liquidity</);
    // §5.1: no "LP" in rendered copy (banned-terms-jsx-guard) — the tooltip says "liquidity".
    expect(src).toMatch(/title="All collateral this market holds: liquidity, trader margin and insurance\.">vault</);
  });

  it("the cell renders the vault value with the same tooltip", () => {
    expect(src).toMatch(/title="All collateral this market holds: liquidity, trader margin and insurance\.">\{vaultDisplay\}</);
    // The cell's title sits inside the rows' .map callback, which the JSX banned-terms sweep
    // does not descend into — pin it here instead.
    expect(src).not.toMatch(/title="[^"]*\bLPs?\b[^"]*">(vault|\{vaultDisplay\})</);
    expect(src).not.toMatch(/marketLp(Display|Val|TokensRaw)/);
  });
});
