// @vitest-environment node
/**
 * The trending-tokens safety screen + ranking (pure core). A token is surfaced
 * only if it is graduated, flag-clean, and has a liquid DexScreener pair above the
 * market-cap floor — fail-closed on anything missing — and the list is ranked by
 * 24h volume (the "trending" signal).
 */
import { describe, it, expect } from "vitest";
import {
  passesCoinGate,
  passesMarketGate,
  toTrendingToken,
  screenAndRank,
  MIN_MARKET_CAP_USD,
  MIN_LIQUIDITY_USD,
  type PumpFunCoin,
  type DexMarket,
} from "@/lib/trending-tokens";

/** A valid 43-char base58 mint from a short seed (the gate now rejects non-base58). */
const M = (seed: string): string => (seed + "1".repeat(43)).slice(0, 43);

const coin = (over: Partial<PumpFunCoin> = {}): PumpFunCoin => ({
  mint: M("Mint"),
  name: "Hokkaido",
  symbol: "HOKK",
  image_uri: "https://img/h.png",
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
  priceUsd: 0.0005,
  marketCapUsd: 500_000,
  liquidityUsd: 50_000,
  volume24hUsd: 120_000,
  pairAddress: "Pair11111111111111111111111111111111111111",
  dexId: "pumpswap", // a createable pool type
  ...over,
});

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
});

describe("toTrendingToken", () => {
  it("maps fields and prefers the DexScreener price", () => {
    const t = toTrendingToken(coin(), market());
    expect(t.mint).toBe(coin().mint);
    expect(t.symbol).toBe("HOKK");
    expect(t.name).toBe("Hokkaido");
    expect(t.logoUrl).toBe("https://img/h.png");
    expect(t.launchpad).toBe("pumpfun");
    expect(t.priceUsd).toBe(0.0005);
    expect(t.marketCapUsd).toBe(500_000);
    expect(t.volume24hUsd).toBe(120_000);
  });
  it("derives price from market cap / supply when DexScreener has no price", () => {
    const t = toTrendingToken(coin({ usd_market_cap: 1_000_000, total_supply: 2_000_000 }), market({ priceUsd: null }));
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
    const out = screenAndRank(coins, dex, 2);
    expect(out.map((t) => t.symbol)).toEqual(["B", "E"]); // top-2 by volume, C and D excluded
  });

  it("returns empty when nothing passes", () => {
    const coins = [coin({ complete: false })];
    expect(screenAndRank(coins, new Map())).toEqual([]);
  });
});
