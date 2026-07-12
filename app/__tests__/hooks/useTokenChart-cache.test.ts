/**
 * Chart-cache regression tests.
 *
 * Two defects, both introduced by the stale-while-revalidate candle caches:
 *
 * 1. EMPTY BATCHES WERE CACHED. The /api/chart route maps an upstream
 *    GeckoTerminal 429 to an empty 200, so a transient rate-limit got stored
 *    as a legitimate "this timeframe has no candles" result and repainted
 *    blank on every revisit. (Reported by a contributor in PR #2390.)
 *
 * 2. KEEP-LAST-GOOD WAS CROSS-KEY — the worse of the two, and a WRONG-DATA
 *    bug rather than a missing-data one. `candlesRef` was never reset on a
 *    timeframe switch, so a failed/empty fetch on the NEW timeframe left the
 *    PREVIOUS timeframe's candles on screen, labelled with the new timeframe
 *    and a "success" status.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useTokenChart } from "@/hooks/useTokenChart";

// The candle cache is MODULE-level (that's the whole point — it survives
// timeframe switches within a page session), so each test uses a distinct mint
// to get a clean cache key rather than leaking a previous test's bars.
const MINT_A = "So11111111111111111111111111111111111111112";
const MINT_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MINT_C = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function candle(time: number) {
  return { time, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 };
}

describe("useTokenChart cache correctness", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does NOT show the previous timeframe's candles when the new one comes back empty", async () => {
    // 1h → 3 bars. Then 4h → empty (what a transient 429 looks like).
    const fetchMock = vi.fn(async (url: string) => {
      const isHour1 = url.includes("timeframe=hour&aggregate=1");
      return {
        ok: true,
        json: async () => ({
          candles: isHour1 ? [candle(1), candle(2), candle(3)] : [],
          poolAddress: "pool1",
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ tf }: { tf: "1h" | "4h" }) => useTokenChart(MINT_A, tf),
      { initialProps: { tf: "1h" as const } },
    );

    await waitFor(() => expect(result.current.status).toBe("success"));
    expect(result.current.candles).toHaveLength(3);

    rerender({ tf: "4h" as const });

    // The 4h fetch returns empty. The hook must NOT report success with the
    // retained 1h bars — that would render the wrong chart under the 4h label.
    await waitFor(() => expect(result.current.status).toBe("empty"));
    expect(result.current.candles).toHaveLength(0);
  });

  it("keeps last-good candles when a repoll of the SAME timeframe comes back empty", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return {
        ok: true,
        json: async () => ({
          // first call has data, a subsequent repoll of the same key is empty
          candles: call === 1 ? [candle(1), candle(2)] : [],
          poolAddress: "pool1",
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTokenChart(MINT_B, "1h"));
    await waitFor(() => expect(result.current.status).toBe("success"));
    expect(result.current.candles).toHaveLength(2);

    // Manual refresh → empty response for the SAME key: the bars we already
    // have for this key are still valid, so keep showing them.
    result.current.refresh();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.status).toBe("success");
    expect(result.current.candles).toHaveLength(2);
  });

  it("never caches an empty batch — a later fetch of the same key can succeed", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return {
        ok: true,
        json: async () => ({
          // first fetch is empty (transient 429), the retry has real data
          candles: call === 1 ? [] : [candle(1), candle(2), candle(3)],
          poolAddress: "pool1",
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTokenChart(MINT_C, "1h"));
    await waitFor(() => expect(result.current.status).toBe("empty"));

    // If the empty had been cached, this would repaint blank from cache.
    result.current.refresh();
    await waitFor(() => expect(result.current.status).toBe("success"));
    expect(result.current.candles).toHaveLength(3);
  });
});
