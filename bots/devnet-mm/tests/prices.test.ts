/**
 * Tests for multi-source price feeds (Binance → CoinGecko → Pyth Hermes).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchPrice, fetchPrices, clearCacheForTesting } from "../src/prices.js";

// ── Helpers ─────────────────────────────────────────────

function makeFetchResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

// Pyth response shape for BTC
const PYTH_BTC_RESPONSE = {
  parsed: [
    {
      price: {
        price: "6800000000000", // 68000 * 10^8
        expo: -8,
      },
    },
  ],
};

// Binance response shape
const BINANCE_BTC_RESPONSE = { price: "68000.12" };

// CoinGecko response shape
const CG_BTC_RESPONSE = { bitcoin: { usd: 68001.5 } };

describe("fetchPrice", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    clearCacheForTesting();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    clearCacheForTesting();
  });

  it("returns Binance price when available", async () => {
    fetchMock.mockResolvedValueOnce(makeFetchResponse(BINANCE_BTC_RESPONSE));

    const result = await fetchPrice("BTC");
    expect(result).not.toBeNull();
    expect(result!.source).toBe("binance");
    expect(result!.priceUsd).toBeCloseTo(68000.12, 1);
  });

  it("falls back to CoinGecko when Binance fails", async () => {
    // Binance fails
    fetchMock.mockResolvedValueOnce(makeFetchResponse(null, false, 429));
    // CoinGecko succeeds
    fetchMock.mockResolvedValueOnce(makeFetchResponse(CG_BTC_RESPONSE));

    const result = await fetchPrice("BTC");
    expect(result).not.toBeNull();
    expect(result!.source).toBe("coingecko");
    expect(result!.priceUsd).toBeCloseTo(68001.5, 1);
  });

  it("falls back to Pyth Hermes when Binance and CoinGecko both fail", async () => {
    // Binance 429
    fetchMock.mockResolvedValueOnce(makeFetchResponse(null, false, 429));
    // CoinGecko 429
    fetchMock.mockResolvedValueOnce(makeFetchResponse(null, false, 429));
    // Pyth succeeds
    fetchMock.mockResolvedValueOnce(makeFetchResponse(PYTH_BTC_RESPONSE));

    const result = await fetchPrice("BTC");
    expect(result).not.toBeNull();
    expect(result!.source).toBe("pyth-hermes");
    // 6800000000000 * 10^-8 = 68000
    expect(result!.priceUsd).toBeCloseTo(68000, 0);
  });

  it("falls back to Pyth when Binance throws and CoinGecko returns non-ok", async () => {
    // Binance network error
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    // CoinGecko 503
    fetchMock.mockResolvedValueOnce(makeFetchResponse(null, false, 503));
    // Pyth
    fetchMock.mockResolvedValueOnce(makeFetchResponse(PYTH_BTC_RESPONSE));

    const result = await fetchPrice("BTC");
    expect(result).not.toBeNull();
    expect(result!.source).toBe("pyth-hermes");
  });

  it("returns null when all three sources fail", async () => {
    fetchMock.mockResolvedValueOnce(makeFetchResponse(null, false, 429));
    fetchMock.mockResolvedValueOnce(makeFetchResponse(null, false, 429));
    fetchMock.mockResolvedValueOnce(makeFetchResponse(null, false, 503));

    const result = await fetchPrice("BTC");
    expect(result).toBeNull();
  });

  it("returns null for unknown symbols (no mapping in any source)", async () => {
    // Binance: no mapping (returns null early), CoinGecko: no mapping, Pyth: no mapping
    const result = await fetchPrice("UNKNOWN_TOKEN");
    expect(result).toBeNull();
    // fetch should not have been called since all maps return early
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles Pyth response with invalid expo gracefully", async () => {
    fetchMock.mockResolvedValueOnce(makeFetchResponse(null, false, 429));
    fetchMock.mockResolvedValueOnce(makeFetchResponse(null, false, 429));
    fetchMock.mockResolvedValueOnce(
      makeFetchResponse({ parsed: [{ price: { price: "abc", expo: -8 } }] }),
    );

    // NaN price — should return null
    const result = await fetchPrice("SOL");
    expect(result).toBeNull();
  });

  it("handles Pyth empty parsed array gracefully", async () => {
    fetchMock.mockResolvedValueOnce(makeFetchResponse(null, false, 429));
    fetchMock.mockResolvedValueOnce(makeFetchResponse(null, false, 429));
    fetchMock.mockResolvedValueOnce(makeFetchResponse({ parsed: [] }));

    const result = await fetchPrice("SOL");
    expect(result).toBeNull();
  });
});

describe("fetchPrices (batch)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    clearCacheForTesting();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    clearCacheForTesting();
  });

  it("returns prices for all successfully fetched symbols", async () => {
    // SOL: Binance ok
    fetchMock.mockResolvedValueOnce(makeFetchResponse({ price: "150.00" }));
    // BTC: Binance ok
    fetchMock.mockResolvedValueOnce(makeFetchResponse({ price: "68000.00" }));

    const results = await fetchPrices(["SOL", "BTC"]);
    expect(results.size).toBe(2);
    expect(results.get("SOL")!.priceUsd).toBeCloseTo(150, 1);
    expect(results.get("BTC")!.priceUsd).toBeCloseTo(68000, 1);
  });

  it("returns partial results when one symbol fails all sources", async () => {
    // SOL: Binance ok
    fetchMock.mockResolvedValueOnce(makeFetchResponse({ price: "150.00" }));
    // ETH: all fail
    fetchMock.mockResolvedValueOnce(makeFetchResponse(null, false, 429));
    fetchMock.mockResolvedValueOnce(makeFetchResponse(null, false, 429));
    fetchMock.mockResolvedValueOnce(makeFetchResponse(null, false, 503));

    const results = await fetchPrices(["SOL", "ETH"]);
    expect(results.has("SOL")).toBe(true);
    expect(results.has("ETH")).toBe(false);
  });
});
