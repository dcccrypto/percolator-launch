/**
 * #3301: every PortfolioPosition names the portfolio ACCOUNT it was read from, so Close on a row can
 * act on that account. A wallet can own two portfolios on one market; the slab alone can't say which.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { parsePortfolioV17 } from "@percolatorct/sdk";
import { buildV17Position } from "@/hooks/usePortfolio";

const f = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/DAC2a44p.portfolio.json"), "utf8")) as {
  market: string;
  dataBase64: string;
};
const portfolio = parsePortfolioV17(Buffer.from(f.dataBase64, "base64"));
const discovered = {
  slabAddress: new PublicKey(f.market),
  programId: new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ"),
  config: {},
  configV17: { collateralMint: new PublicKey("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC") },
} as never;
const A = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const B = new PublicKey("SysvarRent111111111111111111111111111111111");
const build = (pk: PublicKey | undefined) =>
  buildV17Position(portfolio, 1_000_000n, 500n, f.market, discovered, false, 1000n, "T", "11111111111111111111111111111111", null, pk);

describe("PortfolioPosition.portfolioPk (#3301)", () => {
  it("carries the account the row was built from; two rows on one market stay distinguishable", () => {
    const a = build(A);
    const b = build(B);
    expect(a.slabAddress).toBe(b.slabAddress);
    expect(a.portfolioPk?.equals(A)).toBe(true);
    expect(b.portfolioPk?.equals(B)).toBe(true);
  });

  it("is null only when no account was given", () => {
    expect(build(undefined).portfolioPk).toBeNull();
  });

  it("the owner scan AND the wrapped recovery pass hand each position its own account", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../hooks/usePortfolio.ts"), "utf8");
    const scan = src.slice(src.indexOf("export async function fetchPortfolioSnapshot"));
    const calls = [...scan.matchAll(/buildV17Position\(([\s\S]*?)\n\s*\);/g)].map((m) => m[1]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/\n\s*pubkey,\s*$/); // owner scan: the scanned account's pubkey
    expect(calls[1]).toMatch(/\n\s*portfolioPks\[i\],\s*$/); // wrapped pass: the escrowed account's pubkey
  });
});
