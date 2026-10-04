/**
 * The devnet faucet-cap reason named the LISTED token ("caps a launch at 10,000 BONK"), but the
 * cap is on the collateral, which is always Sim-USDC on devnet. It now names collateralSymbol.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("create wizard faucet-cap reason", () => {
  const src = readFileSync(resolve(process.cwd(), "components/create/CreateMarketWizard.tsx"), "utf8");

  it("names the collateral, not the listed token", () => {
    expect(src).toContain(".toLocaleString()} ${collateralSymbol} — reduce LP collateral");
    expect(src).not.toContain(".toLocaleString()} ${symbol} — reduce LP collateral");
  });

  it("collateralSymbol is Sim-USDC on devnet", () => {
    expect(src).toContain('const collateralSymbol = isDevnet ? "Sim-USDC" : symbol;');
  });
});
