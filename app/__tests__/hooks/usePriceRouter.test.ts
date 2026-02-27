import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { usePriceRouter } from "../../hooks/usePriceRouter";

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("usePriceRouter", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns idle state when mintAddress is null", () => {
    const { result } = renderHook(() => usePriceRouter(null));
    expect(result.current.loading).toBe(false);
    expect(result.current.bestSource).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("returns idle state when mintAddress is too short", () => {
    const { result } = renderHook(() => usePriceRouter("abc"));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("sets error immediately on 404 without retrying (PERC-233)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({}),
    });

    const mint = "CRBD4exMmHEXSnQY6VayXETMgJtqZCSURwQQZF3xXyNE";
    const { result } = renderHook(() => usePriceRouter(mint));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Should only call fetch ONCE — no retries on 404
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.current.error).toContain("Unknown oracle");
    expect(result.current.bestSource).toBeNull();
  });

  it("does not retry on 4xx client errors", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({}),
    });

    const mint = "SomeValidMintAddressThatIsLongEnoughToPass32Chars";
    const { result } = renderHook(() => usePriceRouter(mint));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.current.error).toContain("HTTP 400");
  });

  it("returns bestSource on successful resolve", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        bestSource: {
          type: "pyth",
          address: "0xabc123",
          pairLabel: "SOL/USD",
          liquidity: 1000000,
          price: 150.5,
          confidence: 0.99,
        },
        allSources: [],
      }),
    });

    const mint = "SomeValidMintAddressThatIsLongEnoughToPass32Chars";
    const { result } = renderHook(() => usePriceRouter(mint));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.bestSource).not.toBeNull();
    expect(result.current.bestSource?.type).toBe("pyth");
    expect(result.current.error).toBeNull();
  });
});
