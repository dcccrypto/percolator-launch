/**
 * PERC-372: Verify auto-fund faucet amount is 1,000 USDC
 *
 * Reads the route source directly to confirm the constant was updated.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("/api/auto-fund USDC amount", () => {
  it("should have USDC_MINT_AMOUNT set to 1,000 USDC (1_000_000_000 units)", () => {
    const routePath = path.resolve(
      __dirname,
      "../../app/api/auto-fund/route.ts",
    );
    const source = fs.readFileSync(routePath, "utf8");

    // Should contain the new amount
    expect(source).toContain("1_000_000_000");
    // Should NOT contain old amount as the sole definition
    expect(source).not.toMatch(
      /USDC_MINT_AMOUNT\s*=\s*100_000_000\s*;/,
    );
  });

  it("should mention PERC-372 in the updated constant", () => {
    const routePath = path.resolve(
      __dirname,
      "../../app/api/auto-fund/route.ts",
    );
    const source = fs.readFileSync(routePath, "utf8");
    expect(source).toContain("PERC-372");
  });
});
