// @vitest-environment node
/**
 * The trending-tokens listing filters + ranking (pure core). A pump.fun token must
 * be graduated and flag-clean; every candidate needs a supported, USD-quoted pool
 * above the liquidity / keeper-floor / market-cap thresholds — fail-closed on
 * anything missing — and the list is ranked by 24h volume.
 */
import { isLaunchablePriceUsd } from "@/lib/launch-price-floor";
import { describe, it, expect } from "vitest";
import {
  passesCoinGate,
  passesMarketGate,
  toTrendingToken,
  screenAndRank,
  candidateFromPumpFun,
  liqDampener,
  accelMultiplier,
  momentumScores,
  trendSeries,
  volumeForTimeframe,
  changeForTimeframe,
  rankForTimeframe,
  LIQ_REF_USD,
  MIN_MARKET_CAP_USD,
  MIN_LIQUIDITY_USD,
  type PumpFunCoin,
  type DexMarket,
  type TrendingToken,
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

  it("carries the momentum fields: 1h volume, per-window change, trend series and scores", () => {
    const t = toTrendingToken(
      cand(coin()),
      market({
        volume24hUsd: 120_000,
        volume6hUsd: 40_000,
        volume1hUsd: 10_000,
        volume5mUsd: 1_000,
        priceChange1hPct: 5,
        priceChange24hPct: -2,
        txns1h: 120,
        txns6h: 360,
        liquidityUsd: LIQ_REF_USD, // dampener = 1
      }),
    );
    expect(t.volume1hUsd).toBe(10_000);
    expect(t.priceChange1hPct).toBe(5);
    expect(t.priceChange24hPct).toBe(-2);
    // trend = avg $/h over [24h, 6h, 1h, 5m].
    expect(t.trend[0]).toBeCloseTo(5_000, 5);
    expect(t.trend[2]).toBeCloseTo(10_000, 5);
    expect(t.trend[3]).toBeCloseTo(12_000, 5);
    // accel = 120 / (360/6) = 2; score1h = 10k × 2 × 1; score24h = 120k × 1.
    expect(t.score1h).toBeCloseTo(20_000, 5);
    expect(t.score24h).toBeCloseTo(120_000, 5);
  });
});

describe("momentum helpers", () => {
  it("liqDampener: 1 at/above the reference, floored at 0.3, penalises thin pools", () => {
    expect(liqDampener(LIQ_REF_USD)).toBe(1);
    expect(liqDampener(LIQ_REF_USD * 4)).toBe(1); // capped, never a boost
    expect(liqDampener(0)).toBe(0.3); // floor
    expect(liqDampener(null)).toBe(0.3);
    expect(liqDampener(LIQ_REF_USD / 4)).toBeCloseTo(0.5, 5); // sqrt(0.25)
  });

  it("accelMultiplier: this hour vs the 6h hourly average, clamped [0.5, 2.5]", () => {
    expect(accelMultiplier(120, 360)).toBe(2); // 120 / (360/6=60)
    expect(accelMultiplier(1000, 60)).toBe(2.5); // clamped up
    expect(accelMultiplier(5, 600)).toBe(0.5); // clamped down
    expect(accelMultiplier(null, 360)).toBe(1); // no data → neutral
    expect(accelMultiplier(10, 0)).toBe(1); // no baseline → neutral
  });

  it("momentumScores: 1h = vol1h × accel × liq; 24h = vol24h × liq", () => {
    expect(momentumScores({ volume1hUsd: 10_000, volume24hUsd: 120_000, liquidityUsd: LIQ_REF_USD, txns1h: 120, txns6h: 360 }))
      .toEqual({ score1h: 20_000, score24h: 120_000 });
    // thin liquidity dampens both equally.
    const thin = momentumScores({ volume1hUsd: 10_000, volume24hUsd: 120_000, liquidityUsd: LIQ_REF_USD / 4, txns1h: null, txns6h: null });
    expect(thin.score1h).toBeCloseTo(5_000, 5); // 10k × 1 × 0.5
    expect(thin.score24h).toBeCloseTo(60_000, 5); // 120k × 0.5
  });

  it("trendSeries: avg $/h over [24h, 6h, 1h, 5m]; missing windows read 0", () => {
    expect(trendSeries({ volume24hUsd: 120_000, volume6hUsd: 60_000, volume1hUsd: 10_000, volume5mUsd: 1_000 }))
      .toEqual([5_000, 10_000, 10_000, 12_000]);
    expect(trendSeries({ volume24hUsd: null, volume6hUsd: undefined, volume1hUsd: null, volume5mUsd: null }))
      .toEqual([0, 0, 0, 0]);
  });

  it("volumeForTimeframe / changeForTimeframe pick the selected window", () => {
    const t = { volume1hUsd: 7, volume24hUsd: 70, priceChange1hPct: 1.5, priceChange24hPct: null };
    expect(volumeForTimeframe(t, "1h")).toBe(7);
    expect(volumeForTimeframe(t, "24h")).toBe(70);
    expect(changeForTimeframe(t, "1h")).toBe(1.5);
    expect(changeForTimeframe(t, "24h")).toBeNull();
  });

  it("rankForTimeframe sorts by the window's score, without mutating the input", () => {
    const mk = (symbol: string, s1: number, s24: number) => ({ symbol, score1h: s1, score24h: s24 } as unknown as TrendingToken);
    const input = [mk("A", 1, 999), mk("B", 999, 1)];
    expect(rankForTimeframe(input, "24h").map((t) => t.symbol)).toEqual(["A", "B"]);
    expect(rankForTimeframe(input, "1h").map((t) => t.symbol)).toEqual(["B", "A"]);
    expect(input.map((t) => t.symbol)).toEqual(["A", "B"]); // input untouched
  });
});

describe("screenAndRank", () => {
  it("keeps only passers and ranks by 24h momentum (equal liquidity → by 24h volume)", () => {
    const coins: PumpFunCoin[] = [
      coin({ mint: M("a"), symbol: "A" }), // vol 10k
      coin({ mint: M("b"), symbol: "B" }), // vol 90k → first
      coin({ mint: M("c"), symbol: "C", complete: false }), // excluded: not graduated
      coin({ mint: M("d"), symbol: "D" }), // excluded: no pair
      coin({ mint: M("e"), symbol: "E" }), // vol 50k → second
    ];
    // all markets use the default liquidity (= LIQ_REF) so the dampener is 1 and the
    // 24h score tracks 24h volume. No 1h volume → score1h ties at 0, so the 1h-union
    // adds nothing new here.
    const dex = new Map<string, DexMarket>([
      [M("a"), market({ volume24hUsd: 10_000 })],
      [M("b"), market({ volume24hUsd: 90_000 })],
      [M("c"), market({ volume24hUsd: 999_000 })], // ranks high but coin gate drops it
      [M("e"), market({ volume24hUsd: 50_000 })],
      // M("d") intentionally absent → fails the market gate
    ]);
    // candidateFromPumpFun keeps the raw coin, so screenAndRank re-applies its flag gate.
    const out = screenAndRank(coins.map(cand), dex, 5);
    expect(out.map((t) => t.symbol)).toEqual(["B", "E", "A"]); // B>E>A by 24h; C and D excluded
  });

  it("unions in the top 1h movers so a fresh surge isn't sliced off a 24h-only cut", () => {
    // X: tiny 24h volume but a big 1h surge (accel = 600/(600/6)=6, clamped to 2.5).
    // With limit=1 a pure 24h cut returns only B; the union must also surface X.
    const coins: PumpFunCoin[] = [
      coin({ mint: M("b"), symbol: "B" }),
      coin({ mint: M("x"), symbol: "X" }),
    ];
    const dex = new Map<string, DexMarket>([
      [M("b"), market({ volume24hUsd: 90_000 })], // top by 24h, no 1h volume
      [M("x"), market({ volume24hUsd: 5_000, volume1hUsd: 5_000, volume6hUsd: 5_000, txns1h: 600, txns6h: 600 })],
    ]);
    const syms = screenAndRank(coins.map(cand), dex, 1).map((t) => t.symbol);
    expect(syms).toContain("B"); // top by 24h momentum
    expect(syms).toContain("X"); // top by 1h momentum, unioned in despite tiny 24h
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

// The union of the 1H and 24H cuts is what the rail ranks from, so the launch-price floor
// (#3243) has to hold for every token in it, whichever window put it there.
describe("screenAndRank: the 1H/24H union never contains a token under the launch floor", () => {
  it("below-floor tokens that top BOTH scores are absent from the union and from either re-ranked window", () => {
    const FLOOR_OK = 0.0123;
    const BELOW = 0.000666; // one E6 tick under the 2x floor ($0.000667)
    const coins: PumpFunCoin[] = [];
    const dex = new Map<string, DexMarket>();
    // Eight below-floor tokens with the biggest 24h AND 1h numbers on the board.
    for (let i = 0; i < 8; i++) {
      const mint = M(`x${String.fromCharCode(97 + i)}`);
      coins.push(coin({ mint, symbol: `LOW${i}` }));
      dex.set(mint, market({ priceUsd: BELOW, volume24hUsd: 900_000 - i, volume1hUsd: 90_000 - i, volume6hUsd: 60_000, txns1h: 600, txns6h: 600 }));
    }
    // Launchable tokens with modest numbers.
    for (let i = 0; i < 6; i++) {
      const mint = M(`y${String.fromCharCode(97 + i)}`);
      coins.push(coin({ mint, symbol: `OK${i}` }));
      dex.set(mint, market({ priceUsd: FLOOR_OK, volume24hUsd: 10_000 + i, volume1hUsd: 1_000 + i, volume6hUsd: 6_000, txns1h: 60, txns6h: 300 }));
    }
    const union = screenAndRank(coins.map(cand), dex, 3);
    expect(union.length).toBeGreaterThan(0);
    expect(union.every((t) => t.symbol.startsWith("OK"))).toBe(true);
    for (const tf of ["1h", "24h"] as const) {
      const ranked = rankForTimeframe(union, tf);
      expect(ranked.every((t) => isLaunchablePriceUsd(t.priceUsd))).toBe(true);
    }
  });
});

