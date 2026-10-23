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
    // UX WP-10 (§4.2 unit rule): the base symbol ("SOL", never "SOL-PERP") before "/USD".
    expect(source).toContain("displaySymbol ? `${baseSymbol(displaySymbol)}/USD`");
  });

  it("labels withdraw-only markets in both row layouts, and takes the placeholder rule from symbol-utils", () => {
    expect(source.match(/isWithdrawOnlyMarket\(m\.supabase\) && <WithdrawOnlyBadge \/>/g)?.length).toBe(2);
    expect(source).not.toContain("function isPlaceholderMarketSymbol");
  });

  it("does not prefer collateral token metadata for market identity", () => {
    expect(source).not.toContain("const onChainSym = tokenMetaMap.get(m.mintAddress)?.symbol");
    expect(source).not.toContain("const onChainName = tokenMetaMap.get(m.mintAddress)?.name");
    expect(source).not.toContain("tokenMetaMap.get(m.mintAddress)?.symbol ||");
  });
});

describe("baseSymbol (UX WP-10 unit rule)", () => {
  it("strips -PERP / /USDC suffixes", async () => {
    const { baseSymbol } = await import("@/lib/symbol-utils");
    expect(baseSymbol("SOL-PERP")).toBe("SOL");
    expect(baseSymbol("PENGU-PERP")).toBe("PENGU");
    expect(baseSymbol("TRUMP")).toBe("TRUMP");
    expect(baseSymbol("JUP/USDC")).toBe("JUP");
    expect(baseSymbol("")).toBe("");
  });
});
