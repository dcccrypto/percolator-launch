/**
 * The landing "Trending on Solana DEXs" rail: renders filtered trending tokens
 * from /api/trending-tokens, EXCLUDES any that already have a Percolator market
 * (matched on mainnet_ca), links the token to its pool chart and the Create Market
 * CTA to the prefilled wizard, and shows distinct copy for loading / data
 * unavailable / nothing matched. Its copy must never imply Percolator vetted the
 * tokens.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  swr: {
    data: { tokens: [] as unknown[], generatedAt: "", sourceEmpty: false } as unknown,
    error: undefined as unknown,
    isLoading: false,
  },
  stats: {
    statsMap: new Map<string, { mainnet_ca: string | null }>(),
    loading: false,
    error: null as string | null,
  },
}));

vi.mock("swr", () => ({ default: () => h.swr }));
vi.mock("@/hooks/useAllMarketStats", () => ({ useAllMarketStats: () => h.stats }));
vi.mock("@/components/market/MarketLogo", () => ({ MarketLogo: () => null }));

import { TrendingTokensRail, TRENDING_COPY } from "@/components/landing/TrendingTokensRail";

const tok = (mint: string, symbol: string, over: Record<string, unknown> = {}) => ({
  mint, symbol, name: `${symbol} name`, logoUrl: null, dexId: "pumpswap", source: "geckoterminal",
  chartUrl: `https://dexscreener.com/solana/Pool${mint}`,
  priceUsd: 0.5, marketCapUsd: 1_000_000,
  volume24hUsd: 100_000, volume1hUsd: 5_000, liquidityUsd: 50_000,
  priceChange1hPct: 12.5, priceChange24hPct: -3.2,
  trend: [1, 2, 3, 4], score1h: 5_000, score24h: 100_000,
  ...over,
});
const ok = (tokens: unknown[]) => ({ tokens, generatedAt: "", sourceEmpty: false });
const hrefs = () => screen.queryAllByRole("link").map((a) => a.getAttribute("href"));
const state = () => screen.queryByRole("status")?.getAttribute("data-state") ?? null;

afterEach(() => {
  h.swr = { data: ok([]), error: undefined, isLoading: false };
  h.stats = { statsMap: new Map(), loading: false, error: null };
});

describe("TrendingTokensRail rows", () => {
  it("links each token to its pool chart and the Create CTA to the prefilled wizard (mint only)", () => {
    h.swr.data = ok([tok("MintAAA", "AAA")]);
    render(<TrendingTokensRail />);
    expect(screen.getByText("AAA")).toBeTruthy();
    expect(screen.getByText("PumpSwap")).toBeTruthy();
    expect(hrefs()).toContain("https://dexscreener.com/solana/PoolMintAAA");
    expect(hrefs()).toContain("/create?mint=MintAAA");
    // No pool / oracle is pre-selected — the wizard runs its own pool + floor gates.
    expect(hrefs().filter((u) => u?.startsWith("/create")).every((u) => u === "/create?mint=MintAAA")).toBe(true);
    expect(state()).toBeNull();
  });

  it("excludes tokens that already have a Percolator market (matched on mainnet_ca)", () => {
    h.stats.statsMap = new Map([["slab1", { mainnet_ca: "MintBBB" }]]);
    h.swr.data = ok([tok("MintAAA", "AAA"), tok("MintBBB", "BBB")]);
    render(<TrendingTokensRail />);
    expect(screen.getByText("AAA")).toBeTruthy();
    expect(screen.queryByText("BBB")).toBeNull();
    expect(hrefs()).not.toContain("/create?mint=MintBBB");
  });

  it("holds rows while the market list is still loading (no Create CTA for a listed token)", () => {
    h.stats = { statsMap: new Map(), loading: true, error: null };
    h.swr.data = ok([tok("MintAAA", "AAA")]);
    render(<TrendingTokensRail />);
    expect(screen.queryByText("AAA")).toBeNull();
    expect(hrefs().some((u) => u?.startsWith("/create"))).toBe(false);
    expect(state()).toBe("loading");
  });

  it("never links to a Percolator trade page", () => {
    h.swr.data = ok([tok("MintAAA", "AAA")]);
    render(<TrendingTokensRail />);
    expect(hrefs().some((u) => u?.startsWith("/trade"))).toBe(false);
  });
});

describe("TrendingTokensRail states", () => {
  it("loading: no data yet", () => {
    h.swr = { data: undefined, error: undefined, isLoading: true };
    render(<TrendingTokensRail />);
    expect(screen.getByText(TRENDING_COPY.loading)).toBeTruthy();
    expect(state()).toBe("loading");
  });

  it("unavailable: upstream sources down (sourceEmpty) — NOT the 'nothing matched' copy", () => {
    h.swr.data = { tokens: [], generatedAt: "", sourceEmpty: true };
    render(<TrendingTokensRail />);
    expect(screen.getByText("Trending data is unavailable right now.")).toBeTruthy();
    expect(screen.queryByText(TRENDING_COPY.empty)).toBeNull();
    expect(state()).toBe("unavailable");
  });

  it("unavailable: our API request failed", () => {
    h.swr = { data: undefined, error: new Error("trending 502"), isLoading: false };
    render(<TrendingTokensRail />);
    expect(state()).toBe("unavailable");
  });

  it("empty: sources answered, nothing matched the filters", () => {
    h.swr.data = ok([]);
    render(<TrendingTokensRail />);
    expect(screen.getByText(TRENDING_COPY.empty)).toBeTruthy();
    expect(state()).toBe("empty");
  });

  it("empty: every trending token already has a Percolator market", () => {
    h.stats.statsMap = new Map([["slab1", { mainnet_ca: "MintAAA" }]]);
    h.swr.data = ok([tok("MintAAA", "AAA")]);
    render(<TrendingTokensRail />);
    expect(state()).toBe("empty");
  });
});

describe("TrendingTokensRail copy", () => {
  it("shows the third-party disclaimer and factual filters", () => {
    h.swr.data = ok([tok("MintAAA", "AAA")]);
    const { container } = render(<TrendingTokensRail />);
    const text = container.textContent ?? "";
    expect(text).toContain("Third-party tokens, not reviewed by Percolator. Do your own research.");
    expect(text).toContain("liquidity ≥ $5K");
  });

  it("never implies vetting or endorsement", () => {
    for (const s of Object.values(TRENDING_COPY)) {
      expect(s).not.toMatch(/\bsafe|\bsafety\b|\bscreen(ed)?\b|vetted|verified|audited|trusted|recommended|approved|endorse/i);
    }
    h.swr.data = { tokens: [], generatedAt: "", sourceEmpty: true };
    const { container } = render(<TrendingTokensRail />);
    expect(container.textContent).not.toMatch(/safety screen|vetted|verified/i);
  });
});

describe("TrendingTokensRail filters", () => {
  it("defaults to the 1H window and swaps the Vol / Change column when 24H is chosen", () => {
    h.swr.data = ok([tok("MintAAA", "AAA")]);
    render(<TrendingTokensRail />);
    // Default 1h: 1h column label + the 1h change value.
    expect(screen.getByText("1h Vol")).toBeTruthy();
    expect(screen.getByText("+12.5%")).toBeTruthy();
    // Switch to 24H: the column header + value follow the window.
    fireEvent.click(screen.getByRole("radio", { name: "24H" }));
    expect(screen.getByText("24h Vol")).toBeTruthy();
    expect(screen.getByText("-3.2%")).toBeTruthy();
    expect(screen.queryByText("1h Vol")).toBeNull();
  });

  it("re-ranks by the selected window's momentum score", () => {
    // AAA leads on 24h; BBB leads on 1h. The order must follow the active window.
    h.swr.data = ok([
      tok("MintAAA", "AAA", { score24h: 999, score1h: 1 }),
      tok("MintBBB", "BBB", { score24h: 1, score1h: 999 }),
    ]);
    render(<TrendingTokensRail />);
    const order = () => screen.queryAllByText(/^(AAA|BBB)$/).map((n) => n.textContent);
    expect(order()).toEqual(["BBB", "AAA"]); // 1h default
    fireEvent.click(screen.getByRole("radio", { name: "24H" }));
    expect(order()).toEqual(["AAA", "BBB"]); // 24h re-rank
  });

  it("the Show control caps how many rows render (Show 5)", () => {
    h.swr.data = ok(Array.from({ length: 8 }, (_, i) => tok(`Mint${i}`, `T${i}`, { score24h: 100 - i })));
    render(<TrendingTokensRail />);
    const createLinks = () => hrefs().filter((u) => u?.startsWith("/create")).length;
    expect(createLinks()).toBe(8); // default 20 → all 8
    fireEvent.click(screen.getByRole("radio", { name: "5" }));
    expect(createLinks()).toBe(5);
  });
});
