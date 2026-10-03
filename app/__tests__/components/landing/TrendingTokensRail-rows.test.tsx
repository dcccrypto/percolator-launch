/**
 * The landing "Tokens Trending" rail: renders screened trending tokens from
 * /api/trending-tokens, EXCLUDES any that already have a Percolator perp (matched
 * on the market's mainnet_ca), links the token to its pump.fun page, and links the
 * Create Market CTA to the prefilled wizard.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  trending: { tokens: [] as unknown[], generatedAt: "", sourceEmpty: false },
  statsMap: new Map<string, { mainnet_ca: string | null }>(),
}));

vi.mock("swr", () => ({ default: () => ({ data: h.trending, error: undefined, isLoading: false }) }));
vi.mock("@/hooks/useAllMarketStats", () => ({ useAllMarketStats: () => ({ statsMap: h.statsMap }) }));
vi.mock("@/components/market/MarketLogo", () => ({ MarketLogo: () => null }));

import { TrendingTokensRail } from "@/components/landing/TrendingTokensRail";

const tok = (mint: string, symbol: string) => ({
  mint, symbol, name: `${symbol} name`, logoUrl: null, launchpad: "pumpfun",
  priceUsd: 0.5, marketCapUsd: 1_000_000, volume24hUsd: 100_000, liquidityUsd: 50_000,
});
const hrefs = () => screen.queryAllByRole("link").map((a) => a.getAttribute("href"));

afterEach(() => {
  h.trending = { tokens: [], generatedAt: "", sourceEmpty: false };
  h.statsMap = new Map();
});

describe("TrendingTokensRail", () => {
  it("links each token to pump.fun and the Create CTA to the prefilled wizard", () => {
    h.trending = { tokens: [tok("MintAAA", "AAA")], generatedAt: "", sourceEmpty: false };
    render(<TrendingTokensRail />);
    expect(screen.getByText("AAA")).toBeTruthy();
    expect(hrefs()).toContain("https://pump.fun/coin/MintAAA");
    expect(hrefs()).toContain("/create?mint=MintAAA");
  });

  it("excludes tokens that already have a Percolator perp (matched on mainnet_ca)", () => {
    h.statsMap = new Map([["slab1", { mainnet_ca: "MintBBB" }]]);
    h.trending = { tokens: [tok("MintAAA", "AAA"), tok("MintBBB", "BBB")], generatedAt: "", sourceEmpty: false };
    render(<TrendingTokensRail />);
    expect(screen.getByText("AAA")).toBeTruthy();
    expect(screen.queryByText("BBB")).toBeNull();
    expect(hrefs()).not.toContain("/create?mint=MintBBB");
  });

  it("shows an empty-state message when nothing clears the screen", () => {
    render(<TrendingTokensRail />);
    expect(screen.getByText(/No trending tokens/i)).toBeTruthy();
  });
});
