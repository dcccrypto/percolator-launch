import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PYTH_SOLANA_FEEDS,
  resolvePrice,
  type PriceSource,
} from "../src/oracle/price-router.js";

// ============================================================================
// PYTH_SOLANA_FEEDS table
// ============================================================================

describe("PYTH_SOLANA_FEEDS", () => {
  it("contains known major tokens", () => {
    const symbols = Object.values(PYTH_SOLANA_FEEDS).map((f) => f.symbol);
    expect(symbols).toContain("SOL");
    expect(symbols).toContain("BTC");
    expect(symbols).toContain("ETH");
    expect(symbols).toContain("USDC");
    expect(symbols).toContain("USDT");
    expect(symbols).toContain("BONK");
    expect(symbols).toContain("JUP");
    expect(symbols).toContain("JTO");
    expect(symbols).toContain("WIF");
    expect(symbols).toContain("RAY");
  });

  it("all feed IDs are 64-char hex strings", () => {
    for (const feedId of Object.keys(PYTH_SOLANA_FEEDS)) {
      expect(feedId).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("all mints are valid Solana base58 addresses (32-44 chars)", () => {
    for (const { mint } of Object.values(PYTH_SOLANA_FEEDS)) {
      expect(mint.length).toBeGreaterThanOrEqual(32);
      expect(mint.length).toBeLessThanOrEqual(44);
      expect(mint).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    }
  });

  it("all feed IDs are unique", () => {
    const ids = Object.keys(PYTH_SOLANA_FEEDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all mints are unique", () => {
    const mints = Object.values(PYTH_SOLANA_FEEDS).map((f) => f.mint);
    expect(new Set(mints).size).toBe(mints.length);
  });

  it("all symbols are unique", () => {
    const symbols = Object.values(PYTH_SOLANA_FEEDS).map((f) => f.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it("SOL mint is correct", () => {
    const sol = Object.values(PYTH_SOLANA_FEEDS).find(
      (f) => f.symbol === "SOL"
    );
    expect(sol).toBeDefined();
    expect(sol!.mint).toBe("So11111111111111111111111111111111111111112");
  });

  it("USDC mint is correct", () => {
    const usdc = Object.values(PYTH_SOLANA_FEEDS).find(
      (f) => f.symbol === "USDC"
    );
    expect(usdc).toBeDefined();
    expect(usdc!.mint).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });
});

// ============================================================================
// resolvePrice
// ============================================================================

describe("resolvePrice", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper: mock DexScreener + Jupiter responses
  function mockApis(opts?: {
    dexPairs?: Array<{
      chainId?: string;
      dexId?: string;
      pairAddress?: string;
      liquidity?: { usd: number };
      priceUsd?: string;
      baseToken?: { symbol: string };
      quoteToken?: { symbol: string };
    }>;
    jupiterPrice?: number | null;
    dexFail?: boolean;
    jupFail?: boolean;
  }) {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.includes("dexscreener.com")) {
        if (opts?.dexFail) throw new Error("Network error");
        return {
          json: async () => ({
            pairs: opts?.dexPairs ?? [],
          }),
        };
      }
      if (url.includes("jup.ag")) {
        if (opts?.jupFail) throw new Error("Network error");
        const mint = new URL(url).searchParams.get("ids") || "";
        const price = opts?.jupiterPrice;
        return {
          json: async () => ({
            data:
              price != null
                ? {
                    [mint]: {
                      price: String(price),
                      mintSymbol: "TEST",
                    },
                  }
                : {},
          }),
        };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
  }

  it("returns Pyth as best source for SOL (known token)", async () => {
    const solMint = "So11111111111111111111111111111111111111112";
    mockApis({
      dexPairs: [
        {
          chainId: "solana",
          dexId: "raydium",
          pairAddress: "pair1",
          liquidity: { usd: 5_000_000 },
          priceUsd: "150.5",
          baseToken: { symbol: "SOL" },
          quoteToken: { symbol: "USDC" },
        },
      ],
      jupiterPrice: 150.5,
    });

    const result = await resolvePrice(solMint);

    expect(result.mint).toBe(solMint);
    expect(result.bestSource).not.toBeNull();
    expect(result.bestSource!.type).toBe("pyth");
    expect(result.bestSource!.confidence).toBe(95);
    expect(result.allSources.length).toBeGreaterThanOrEqual(1);
    expect(result.resolvedAt).toBeTruthy();
  });

  it("returns DEX source for unknown token (no Pyth)", async () => {
    const unknownMint = "UnknownMint111111111111111111111111111111111";
    mockApis({
      dexPairs: [
        {
          chainId: "solana",
          dexId: "raydium",
          pairAddress: "pair-unknown",
          liquidity: { usd: 200_000 },
          priceUsd: "0.001",
          baseToken: { symbol: "UNK" },
          quoteToken: { symbol: "SOL" },
        },
      ],
    });

    const result = await resolvePrice(unknownMint);

    expect(result.bestSource).not.toBeNull();
    expect(result.bestSource!.type).toBe("dex");
    expect(result.bestSource!.dexId).toBe("raydium");
    expect(result.bestSource!.confidence).toBe(75); // 200K liquidity
  });

  it("falls back to Jupiter when no DEX data", async () => {
    const unknownMint = "NoPoolMint1111111111111111111111111111111111";
    mockApis({
      dexPairs: [],
      jupiterPrice: 0.05,
    });

    const result = await resolvePrice(unknownMint);

    expect(result.bestSource).not.toBeNull();
    expect(result.bestSource!.type).toBe("jupiter");
    expect(result.bestSource!.price).toBe(0.05);
    expect(result.bestSource!.confidence).toBe(40);
  });

  it("returns null bestSource when no data from any source", async () => {
    const unknownMint = "NoDataMint11111111111111111111111111111111111";
    mockApis({
      dexPairs: [],
      jupiterPrice: null,
    });

    const result = await resolvePrice(unknownMint);

    expect(result.bestSource).toBeNull();
    expect(result.allSources).toHaveLength(0);
  });

  it("handles API failures gracefully (empty sources)", async () => {
    const unknownMint = "FailMint11111111111111111111111111111111111111";
    mockApis({ dexFail: true, jupFail: true });

    const result = await resolvePrice(unknownMint);

    expect(result.bestSource).toBeNull();
    expect(result.allSources).toHaveLength(0);
    expect(result.mint).toBe(unknownMint);
  });

  it("filters out non-Solana chain pairs", async () => {
    const mint = "TestMint1111111111111111111111111111111111111";
    mockApis({
      dexPairs: [
        {
          chainId: "ethereum",
          dexId: "raydium",
          pairAddress: "eth-pair",
          liquidity: { usd: 1_000_000 },
          priceUsd: "1.0",
          baseToken: { symbol: "TEST" },
          quoteToken: { symbol: "ETH" },
        },
      ],
    });

    const result = await resolvePrice(mint);

    // Ethereum pairs should be filtered out
    const dexSources = result.allSources.filter((s) => s.type === "dex");
    expect(dexSources).toHaveLength(0);
  });

  it("filters out unsupported DEXes", async () => {
    const mint = "TestMint1111111111111111111111111111111111111";
    mockApis({
      dexPairs: [
        {
          chainId: "solana",
          dexId: "unsupported-dex",
          pairAddress: "pair-x",
          liquidity: { usd: 500_000 },
          priceUsd: "1.0",
          baseToken: { symbol: "TEST" },
          quoteToken: { symbol: "USDC" },
        },
      ],
    });

    const result = await resolvePrice(mint);

    const dexSources = result.allSources.filter((s) => s.type === "dex");
    expect(dexSources).toHaveLength(0);
  });

  it("filters out pairs with < $100 liquidity", async () => {
    const mint = "LowLiqMint111111111111111111111111111111111111";
    mockApis({
      dexPairs: [
        {
          chainId: "solana",
          dexId: "raydium",
          pairAddress: "low-liq",
          liquidity: { usd: 50 },
          priceUsd: "0.001",
          baseToken: { symbol: "LOW" },
          quoteToken: { symbol: "SOL" },
        },
      ],
    });

    const result = await resolvePrice(mint);

    const dexSources = result.allSources.filter((s) => s.type === "dex");
    expect(dexSources).toHaveLength(0);
  });

  it("confidence tiers map correctly for DEX sources", async () => {
    const mint = "TierTestMint11111111111111111111111111111111111";
    mockApis({
      dexPairs: [
        {
          chainId: "solana",
          dexId: "raydium",
          pairAddress: "p1",
          liquidity: { usd: 2_000_000 },
          priceUsd: "1.0",
          baseToken: { symbol: "A" },
          quoteToken: { symbol: "B" },
        },
        {
          chainId: "solana",
          dexId: "meteora",
          pairAddress: "p2",
          liquidity: { usd: 50_000 },
          priceUsd: "1.0",
          baseToken: { symbol: "A" },
          quoteToken: { symbol: "C" },
        },
        {
          chainId: "solana",
          dexId: "pumpswap",
          pairAddress: "p3",
          liquidity: { usd: 5_000 },
          priceUsd: "1.0",
          baseToken: { symbol: "A" },
          quoteToken: { symbol: "D" },
        },
        {
          chainId: "solana",
          dexId: "raydium",
          pairAddress: "p4",
          liquidity: { usd: 500 },
          priceUsd: "1.0",
          baseToken: { symbol: "A" },
          quoteToken: { symbol: "E" },
        },
      ],
    });

    const result = await resolvePrice(mint);

    const dexSources = result.allSources.filter((s) => s.type === "dex");
    // >$1M → 90, >$10K → 60, >$1K → 45
    const byAddress = Object.fromEntries(
      dexSources.map((s) => [s.address, s.confidence])
    );
    expect(byAddress["p1"]).toBe(90);
    expect(byAddress["p2"]).toBe(60);
    expect(byAddress["p3"]).toBe(45);
    expect(byAddress["p4"]).toBe(30); // $500 is between $100 and $1000 → default confidence 30
  });

  it("resolvedAt is a valid ISO timestamp", async () => {
    mockApis({});
    const result = await resolvePrice("SomeMint1111111111111111111111111111111111111");
    expect(() => new Date(result.resolvedAt).toISOString()).not.toThrow();
  });

  it("sources are sorted by confidence descending", async () => {
    const solMint = "So11111111111111111111111111111111111111112";
    mockApis({
      dexPairs: [
        {
          chainId: "solana",
          dexId: "raydium",
          pairAddress: "pair1",
          liquidity: { usd: 5_000_000 },
          priceUsd: "150",
          baseToken: { symbol: "SOL" },
          quoteToken: { symbol: "USDC" },
        },
      ],
      jupiterPrice: 150,
    });

    const result = await resolvePrice(solMint);

    for (let i = 1; i < result.allSources.length; i++) {
      expect(result.allSources[i - 1].confidence).toBeGreaterThanOrEqual(
        result.allSources[i].confidence
      );
    }
  });

  it("supports AbortSignal (no crash)", async () => {
    mockApis({ dexPairs: [], jupiterPrice: 1.0 });
    const controller = new AbortController();
    const result = await resolvePrice("TestMint", controller.signal);
    expect(result.mint).toBe("TestMint");
  });

  it("accepts pumpswap and meteora as valid DEX IDs", async () => {
    const mint = "DexIdTestMint111111111111111111111111111111111";
    mockApis({
      dexPairs: [
        {
          chainId: "solana",
          dexId: "pumpswap",
          pairAddress: "pump1",
          liquidity: { usd: 1_000 },
          priceUsd: "0.01",
          baseToken: { symbol: "X" },
          quoteToken: { symbol: "Y" },
        },
        {
          chainId: "solana",
          dexId: "meteora",
          pairAddress: "met1",
          liquidity: { usd: 2_000 },
          priceUsd: "0.02",
          baseToken: { symbol: "X" },
          quoteToken: { symbol: "Z" },
        },
      ],
    });

    const result = await resolvePrice(mint);
    const dexIds = result.allSources
      .filter((s) => s.type === "dex")
      .map((s) => s.dexId);
    expect(dexIds).toContain("pumpswap");
    expect(dexIds).toContain("meteora");
  });
});
