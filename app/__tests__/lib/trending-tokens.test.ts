// @vitest-environment node
/**
 * The trending-tokens listing filters + ranking (pure core). A pump.fun token must
 * be graduated and flag-clean; every candidate needs a supported, USD-quoted pool
 * above the liquidity / keeper-floor / market-cap thresholds — fail-closed on
 * anything missing — and the list is ranked by 24h volume.
 */
import { describe, it, expect } from "vitest";
import {
  passesCoinGate,
  passesMarketGate,
  toTrendingToken,
  screenAndRank,
  candidateFromPumpFun,
  MIN_MARKET_CAP_USD,
  MIN_LIQUIDITY_USD,
  type PumpFunCoin,
  type DexMarket,
} from "@/lib/trending-tokens";

const WSOL = "So11111111111111111111111111111111111111112";

/** A valid 43-char base58 mint from a short seed (the gate now rejects non-base58). */
const M = (seed: string): string => (seed + "1".repeat(43)).slice(0, 43);

const coin = (over: Partial<PumpFunCoin> = {}): PumpFunCoin => ({
  mint: M("Mint"),
  name: "Hokkaido",
  symbol: "HOKK",
  image_uri: "https://img.example/h.png",
  usd_market_cap: 500_000,
  total_supply: 1_000_000_000,
  complete: true,
  is_banned: false,
  nsfw: false,
  transfer_fee_bps: 0,
  transfer_hook_program: null,
  ...over,
});

const market = (over: Partial<DexMarket> = {}): DexMarket => ({
  priceUsd: 0.005,
  marketCapUsd: 500_000,
  liquidityUsd: 50_000,
  volume24hUsd: 120_000,
  quoteDepthUsd: 25_000,
  pairAddress: "Pair11111111111111111111111111111111111111",
  dexId: "pumpswap", // a createable pool type
  quoteMint: WSOL,
  dataSource: "dexscreener",
  ...over,
});
const cand = (c: PumpFunCoin) => candidateFromPumpFun(c)!;

describe("passesCoinGate", () => {
  it("accepts a graduated, flag-clean coin", () => {
    expect(passesCoinGate(coin())).toBe(true);
  });
  it("rejects a coin that has not graduated", () => {
    expect(passesCoinGate(coin({ complete: false }))).toBe(false);
    expect(passesCoinGate(coin({ complete: null }))).toBe(false);
  });
  it("rejects banned / nsfw / transfer-fee / transfer-hook coins", () => {
    expect(passesCoinGate(coin({ is_banned: true }))).toBe(false);
    expect(passesCoinGate(coin({ nsfw: true }))).toBe(false);
    expect(passesCoinGate(coin({ transfer_fee_bps: 100 }))).toBe(false);
    expect(passesCoinGate(coin({ transfer_hook_program: "Hook1111111111111111111111111111111111111111" }))).toBe(false);
  });
  it("rejects a coin with no mint", () => {
    expect(passesCoinGate(coin({ mint: "" }))).toBe(false);
  });
});

describe("passesMarketGate (fail-closed)", () => {
  it("accepts a liquid pair above the floors", () => {
    expect(passesMarketGate(market(), 500_000)).toBe(true);
  });
  it("rejects when there is no pair at all", () => {
    expect(passesMarketGate(undefined, 500_000)).toBe(false);
    expect(passesMarketGate(market({ pairAddress: null }), 500_000)).toBe(false);
  });
  it("rejects a pool type the create wizard can't launch against", () => {
    expect(passesMarketGate(market({ dexId: "pumpfun" }), 500_000)).toBe(false); // bonding curve (pre-grad)
    expect(passesMarketGate(market({ dexId: "raydium" }), 500_000)).toBe(false); // blocked DEX
    expect(passesMarketGate(market({ dexId: null }), 500_000)).toBe(false);
  });
  it("rejects thin liquidity and sub-floor market cap", () => {
    expect(passesMarketGate(market({ liquidityUsd: MIN_LIQUIDITY_USD - 1 }), 500_000)).toBe(false);
    expect(passesMarketGate(market({ marketCapUsd: MIN_MARKET_CAP_USD - 1 }), MIN_MARKET_CAP_USD - 1)).toBe(false);
  });
  it("falls back to the pump.fun market cap when DexScreener has none", () => {
    expect(passesMarketGate(market({ marketCapUsd: null }), 500_000)).toBe(true);
    expect(passesMarketGate(market({ marketCapUsd: null }), null)).toBe(false); // unknown → excluded
  });
  it("rejects a pool the keeper can't price in USD (non-SOL/USDC/USDT quote)", () => {
    expect(passesMarketGate(market({ quoteMint: M("Doge") }), 500_000)).toBe(false);
    expect(passesMarketGate(market({ quoteMint: null }), 500_000)).toBe(false);
    expect(passesMarketGate(market({ quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }), 500_000)).toBe(true);
  });
  it("rejects a PumpSwap pool under the keeper's quote-depth floor (and unknown depth)", () => {
    expect(passesMarketGate(market({ quoteDepthUsd: 999 }), 500_000, 1000)).toBe(false);
    expect(passesMarketGate(market({ quoteDepthUsd: null }), 500_000, 1000)).toBe(false);
    expect(passesMarketGate(market({ quoteDepthUsd: 1000 }), 500_000, 1000)).toBe(true);
    // Meteora DLMM is not floored by the keeper — mirror that.
    expect(passesMarketGate(market({ dexId: "meteora", quoteDepthUsd: null }), 500_000, 1000)).toBe(true);
  });
  it("rejects a non-base58 pool address (it is interpolated into the chart URL)", () => {
    expect(passesMarketGate(market({ pairAddress: "../../evil" }), 500_000)).toBe(false);
  });
});

describe("toTrendingToken", () => {
  it("maps fields and prefers the DexScreener price", () => {
    const t = toTrendingToken(cand(coin()), market());
    expect(t.mint).toBe(coin().mint);
    expect(t.symbol).toBe("HOKK");
    expect(t.name).toBe("Hokkaido");
    expect(t.logoUrl).toBe("https://img.example/h.png");
    expect(t.source).toBe("pumpfun");
    expect(t.dexId).toBe("pumpswap");
    expect(t.chartUrl).toBe("https://dexscreener.com/solana/Pair11111111111111111111111111111111111111");
    expect(t.priceUsd).toBe(0.005);
    expect(t.marketCapUsd).toBe(500_000);
    expect(t.volume24hUsd).toBe(120_000);
  });
  it("derives price from market cap / supply when DexScreener has no price", () => {
    const t = toTrendingToken(cand(coin({ usd_market_cap: 1_000_000, total_supply: 2_000_000 })), market({ priceUsd: null }));
    expect(t.priceUsd).toBe(0.5);
  });
});

describe("screenAndRank", () => {
  it("keeps only passers, ranks by 24h volume desc, and caps the list", () => {
    const coins: PumpFunCoin[] = [
      coin({ mint: M("a"), symbol: "A" }), // vol 10k
      coin({ mint: M("b"), symbol: "B" }), // vol 90k → first
      coin({ mint: M("c"), symbol: "C", complete: false }), // excluded: not graduated
      coin({ mint: M("d"), symbol: "D" }), // excluded: no pair
      coin({ mint: M("e"), symbol: "E" }), // vol 50k → second
    ];
    const dex = new Map<string, DexMarket>([
      [M("a"), market({ volume24hUsd: 10_000 })],
      [M("b"), market({ volume24hUsd: 90_000 })],
      [M("c"), market({ volume24hUsd: 999_000 })], // ranks high but coin gate drops it
      [M("e"), market({ volume24hUsd: 50_000 })],
      // M("d") intentionally absent → fails the market gate
    ]);
    // candidateFromPumpFun keeps the raw coin, so screenAndRank re-applies its flag gate.
    const out = screenAndRank(coins.map(cand), dex, 2);
    expect(out.map((t) => t.symbol)).toEqual(["B", "E"]); // top-2 by volume, C and D excluded
  });

  it("returns empty when nothing passes", () => {
    const coins = [coin({ complete: false })];
    expect(screenAndRank(coins.map(cand), new Map())).toEqual([]);
  });

  // The wizard refuses a launch under the trackable floor at EVERY leverage; the lowest leverage
  // it offers (2x) has the lowest floor, $0.000667 (lib/launch-price-floor). Such a token must not
  // be listed with a "Create market" button that goes nowhere.
  it("drops a token priced under the wizard's 2x launch floor; keeps one at or above it", () => {
    const coins = [
      coin({ mint: M("a"), symbol: "TINY" }),
      coin({ mint: M("b"), symbol: "EDGE" }),
      coin({ mint: M("c"), symbol: "OK" }),
      coin({ mint: M("e"), symbol: "NOPRICE", usd_market_cap: null as unknown as number, total_supply: 0 }),
    ];
    const dex = new Map<string, DexMarket>([
      [M("a"), market({ priceUsd: 0.000666, volume24hUsd: 90_000 })], // one E6 tick under 667
      [M("b"), market({ priceUsd: 0.000667, volume24hUsd: 80_000 })], // exactly the floor
      [M("c"), market({ priceUsd: 0.0123, volume24hUsd: 70_000 })],
      [M("e"), market({ priceUsd: null, volume24hUsd: 60_000 })], // unknown price: fail closed
    ]);
    const out = screenAndRank(coins.map(cand), dex);
    expect(out.map((t) => t.symbol)).toEqual(["EDGE", "OK"]);
  });
});
