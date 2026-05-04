/**
 * Regression guard: /markets must display the perp market/base symbol, not the
 * collateral mint symbol. Hyperp markets are commonly collateralized in USDC;
 * using collateral metadata for identity renders every such market as USDC/USD.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(__dirname, "../../app/markets/page.tsx"),
  "utf8",
);

describe("/markets market identity display", () => {
  it("uses market metadata for pair labels and logo fallback", () => {
    expect(source).toContain("const displaySymbol = resolveMarketDisplaySymbol(m);");
    expect(source).toContain("mintAddress={logoMintAddress}");
    expect(source).toContain("symbol={displaySymbol ?? undefined}");
    expect(source).toContain("displaySymbol ? `${displaySymbol}/USD`");
  });

  it("does not prefer collateral token metadata for market identity", () => {
    expect(source).not.toContain("const onChainSym = tokenMetaMap.get(m.mintAddress)?.symbol");
    expect(source).not.toContain("const onChainName = tokenMetaMap.get(m.mintAddress)?.name");
    expect(source).not.toContain("tokenMetaMap.get(m.mintAddress)?.symbol ||");
  });
});
