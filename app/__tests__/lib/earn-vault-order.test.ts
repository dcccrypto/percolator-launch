// @vitest-environment node
import { describe, it, expect } from "vitest";
import { orderEarnVaults, type EarnOrderable, type EarnOrderOptions } from "../../lib/earn-vault-order";

const V = (
  slabAddress: string,
  symbol: string,
  o: Partial<EarnOrderable> = {},
): EarnOrderable => ({
  slabAddress,
  symbol,
  name: o.name ?? symbol,
  vaultBalance: o.vaultBalance ?? 0,
  volume24h: o.volume24h ?? 0,
  oiUtilPct: o.oiUtilPct ?? 0,
  hasVault: o.hasVault,
});

// Incoming order = TVL-ish from the API.
const MARKETS: EarnOrderable[] = [
  V("sol", "SOL", { name: "Solana", vaultBalance: 100, volume24h: 5, oiUtilPct: 10, hasVault: true }),
  V("jup", "JUP", { name: "Jupiter", vaultBalance: 80, volume24h: 9, oiUtilPct: 20, hasVault: true }),
  V("pengu", "PENGU", { vaultBalance: 60, volume24h: 1, oiUtilPct: 5, hasVault: true }),
  V("trump", "TRUMP", { vaultBalance: 40, volume24h: 2, oiUtilPct: 30, hasVault: false }), // no vault
  V("solcat", "SOLCAT", { vaultBalance: 20, volume24h: 3, oiUtilPct: 15 }), // hasVault undefined = shown
];

const opts = (o: Partial<EarnOrderOptions> = {}): EarnOrderOptions => ({
  query: o.query ?? "",
  sortBy: o.sortBy ?? "tvl",
  mineOnly: o.mineOnly ?? false,
  depositOf: o.depositOf ?? (() => 0),
});
const ids = (a: EarnOrderable[]) => a.map((m) => m.slabAddress);

describe("orderEarnVaults", () => {
  it("hides markets with no usable vault (hasVault === false), keeps undefined", () => {
    // TRUMP (false) is dropped; SOLCAT (undefined) stays.
    expect(ids(orderEarnVaults(MARKETS, opts()))).toEqual(["sol", "jup", "pengu", "solcat"]);
  });

  it("sorts by TVL by default", () => {
    expect(ids(orderEarnVaults(MARKETS, opts({ sortBy: "tvl" })))).toEqual([
      "sol", "jup", "pengu", "solcat",
    ]);
  });

  it("sorts by volume / utilization when chosen", () => {
    expect(ids(orderEarnVaults(MARKETS, opts({ sortBy: "volume" })))).toEqual([
      "jup", "sol", "solcat", "pengu",
    ]);
    // util: jup 20, solcat 15, sol 10, pengu 5
    expect(ids(orderEarnVaults(MARKETS, opts({ sortBy: "utilization" })))).toEqual([
      "jup", "solcat", "sol", "pengu",
    ]);
  });

  it("floats the wallet's deposits to the top by amount, then the chosen sort", () => {
    const depositOf = (s: string) => (s === "pengu" ? 200 : s === "solcat" ? 50 : 0);
    // pengu ($200) + solcat ($50) lead; then sol/jup by TVL.
    expect(ids(orderEarnVaults(MARKETS, opts({ depositOf })))).toEqual([
      "pengu", "solcat", "sol", "jup",
    ]);
  });

  it("mineOnly shows only deposited markets", () => {
    const depositOf = (s: string) => (s === "sol" ? 10 : 0);
    expect(ids(orderEarnVaults(MARKETS, opts({ mineOnly: true, depositOf })))).toEqual(["sol"]);
  });

  it("mineOnly with no deposits yields empty", () => {
    expect(orderEarnVaults(MARKETS, opts({ mineOnly: true }))).toEqual([]);
  });

  it("search filters by symbol OR name, case-insensitive", () => {
    expect(ids(orderEarnVaults(MARKETS, opts({ query: "sol" })))).toEqual(["sol", "solcat"]);
    expect(ids(orderEarnVaults(MARKETS, opts({ query: "jupiter" })))).toEqual(["jup"]);
  });

  it("does not mutate the input", () => {
    const before = ids(MARKETS);
    orderEarnVaults(MARKETS, opts({ depositOf: (s) => (s === "jup" ? 1 : 0) }));
    expect(ids(MARKETS)).toEqual(before);
  });
});
