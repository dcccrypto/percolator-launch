/**
 * Regression: a chart timeframe would get stuck showing EMPTY for the whole
 * session. Root cause — GeckoTerminal rate-limits (~30 req/min), so switching
 * timeframes quickly makes one or two requests come back empty; the client then
 * CACHED that empty and repainted it via stale-while-revalidate on every later
 * visit, so e.g. 1h/1d stayed blank even though the data was available.
 *
 * Fix (useTokenChart): never cache an empty batch, and keep last-good candles
 * when a fetch comes back empty — mirroring the existing keep-last-good error
 * branch. These tests pin: empty-not-cached (no stuck-empty), success-cached,
 * and keep-last-good-on-empty.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const MINT = "So11111111111111111111111111111111111111112";
const CANDLE = { timestamp: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 };

function resp(candles: unknown[], poolAddress: string | null = "Pool111") {
  return { ok: true, json: async () => ({ candles, poolAddress }) };
}

describe("useTokenChart — empty responses are not cached (stuck-empty fix)", () => {
  let useTokenChart: typeof import("@/hooks/useTokenChart").useTokenChart;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules(); // fresh module-level chartCache per test
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    ({ useTokenChart } = await import("@/hooks/useTokenChart"));
  });
  afterEach(() => vi.restoreAllMocks());

  it("does NOT get stuck empty: an empty response is not cached, so a later fetch shows data", async () => {
    fetchMock.mockResolvedValueOnce(resp([])); // first: rate-limited / empty
    const first = renderHook(() => useTokenChart(MINT, "1h"));
    await waitFor(() => expect(first.result.current.status).toBe("empty"));
    expect(first.result.current.candles).toEqual([]);
    first.unmount();

    // Later: data is available. If the empty had been cached, this key would be
    // painted "empty" from cache; either way it MUST resolve to the data.
    fetchMock.mockResolvedValue(resp([CANDLE]));
    const second = renderHook(() => useTokenChart(MINT, "1h"));
    await waitFor(() => expect(second.result.current.status).toBe("success"));
    expect(second.result.current.candles.length).toBe(1);
    second.unmount();
  });

  it("caches a SUCCESSFUL batch: a repeat mount paints it synchronously (no blank)", async () => {
    fetchMock.mockResolvedValue(resp([CANDLE]));
    const first = renderHook(() => useTokenChart(MINT, "4h"));
    await waitFor(() => expect(first.result.current.status).toBe("success"));
    first.unmount();

    // Same (mint,timeframe): stale-while-revalidate serves cached candles
    // immediately — success on first render, never a "loading"/"empty" flash.
    const second = renderHook(() => useTokenChart(MINT, "4h"));
    expect(second.result.current.status).toBe("success");
    expect(second.result.current.candles.length).toBe(1);
    second.unmount();
  });

  it("keeps last-good candles when a subsequent fetch of the same key returns empty", async () => {
    fetchMock.mockResolvedValueOnce(resp([CANDLE]));
    const { result } = renderHook(() => useTokenChart(MINT, "1d"));
    await waitFor(() => expect(result.current.status).toBe("success"));
    expect(result.current.candles.length).toBe(1);

    // A repoll of the SAME key comes back empty (transient GT 429). The chart
    // must NOT blank — last-good candles are retained, status stays success.
    fetchMock.mockResolvedValue(resp([]));
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(result.current.candles.length).toBe(1);
      expect(result.current.status).toBe("success");
    });
  });
});
