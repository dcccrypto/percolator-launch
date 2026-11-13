// @vitest-environment node
/**
 * Tests for oracle-keeper last-known-price fallback logic.
 *
 * When an oracle market has no live price from any external source
 * (e.g. devnet token with no DEX pool — market AWbcen87), the keeper
 * should hold the last successfully pushed price rather than skipping the
 * push entirely.  Without this fallback the on-chain oracle stays at 0,
 * the UI marks the market "unavailable", and trading is blocked.
 *
 * The logic under test mirrors the decision tree in
 * bots/oracle-keeper/index.ts :: pushAndCrank().
 */

import { describe, it, expect } from "vitest";

// ── Pure mirror of the oracle-keeper price resolution decision tree ─────────

interface PriceResult {
  price: number;
  source: string;
}

interface MarketStats {
  lastPrice: number;
  consecutiveErrors: number;
  totalErrors: number;
}

/**
 * Pure function that mirrors the price resolution logic in pushAndCrank().
 * Returns { price, source } to push, or null to skip this cycle.
 */
function resolvePushPrice(
  liveResult: PriceResult | null,
  stats: MarketStats,
): { price: number; source: string } | null {
  const isPriceValid = (p: number) => typeof p === "number" && isFinite(p) && p > 0;

  if (liveResult && isPriceValid(liveResult.price)) {
    return { price: liveResult.price, source: liveResult.source };
  }

  if (stats.lastPrice > 0) {
    return { price: stats.lastPrice, source: "last-known" };
  }

  return null; // skip — nothing safe to push
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("oracle-keeper: price resolution with last-known fallback", () => {
  it("uses live price when available", () => {
    const stats: MarketStats = { lastPrice: 100, consecutiveErrors: 0, totalErrors: 0 };
    const result = resolvePushPrice({ price: 120, source: "pyth" }, stats);
    expect(result).toEqual({ price: 120, source: "pyth" });
  });

  it("falls back to lastPrice when getPrice() returns null and lastPrice > 0", () => {
    const stats: MarketStats = { lastPrice: 99.5, consecutiveErrors: 0, totalErrors: 0 };
    const result = resolvePushPrice(null, stats);
    expect(result).toEqual({ price: 99.5, source: "last-known" });
  });

  it("falls back to lastPrice when live price is 0 (no DEX pool — devnet scenario)", () => {
    const stats: MarketStats = { lastPrice: 55.25, consecutiveErrors: 0, totalErrors: 0 };
    const result = resolvePushPrice({ price: 0, source: "dexscreener" }, stats);
    expect(result).toEqual({ price: 55.25, source: "last-known" });
  });

  it("falls back to lastPrice when live price is negative", () => {
    const stats: MarketStats = { lastPrice: 10, consecutiveErrors: 0, totalErrors: 0 };
    const result = resolvePushPrice({ price: -1, source: "jupiter" }, stats);
    expect(result).toEqual({ price: 10, source: "last-known" });
  });

  it("returns null when no live price and lastPrice is 0 (never pushed)", () => {
    const stats: MarketStats = { lastPrice: 0, consecutiveErrors: 0, totalErrors: 0 };
    const result = resolvePushPrice(null, stats);
    expect(result).toBeNull();
  });

  it("returns null when live price is 0 and lastPrice is also 0", () => {
    const stats: MarketStats = { lastPrice: 0, consecutiveErrors: 3, totalErrors: 10 };
    const result = resolvePushPrice({ price: 0, source: "dexscreener" }, stats);
    expect(result).toBeNull();
  });

  it("prefers live price over last-known even when last-known is higher", () => {
    const stats: MarketStats = { lastPrice: 200, consecutiveErrors: 0, totalErrors: 0 };
    const result = resolvePushPrice({ price: 195, source: "pyth" }, stats);
    expect(result).toEqual({ price: 195, source: "pyth" });
  });

  it("fallback source is 'last-known' so ops can identify cached-price cycles in logs", () => {
    const stats: MarketStats = { lastPrice: 42.0, consecutiveErrors: 5, totalErrors: 20 };
    const result = resolvePushPrice(null, stats);
    expect(result?.source).toBe("last-known");
  });
});
