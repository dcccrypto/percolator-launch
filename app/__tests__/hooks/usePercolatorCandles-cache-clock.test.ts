/**
 * usePercolatorCandles cache freshness under a backwards clock step.
 *
 * `Date.now() - stamp < TTL` is true for ANY negative age, so after the clock
 * steps back (NTP correction, manual change, sleeping VM) a cached empty answer
 * (15s TTL) kept a market's chart empty, and a cached bar set (10 min) kept
 * painting, until the clock caught up with the stamp. A stamp from the future
 * is not fresh. Caches are in-memory only; a transient fetch error never sets
 * the empty cache, so this needs a clock step to bite.
 *
 * Each test uses its own slab so the module-level caches cannot leak.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { usePercolatorCandles } from "@/hooks/usePercolatorCandles";

const T0 = Date.parse("2026-11-18T12:00:00Z");
const HOUR = 3_600_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usePercolatorCandles cache vs. backwards clock", () => {
  it("empty cache: a stamp from the future does not suppress the refetch", async () => {
    const fetchMock = vi.fn(async () => json({ s: "no_data" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const first = renderHook(() => usePercolatorCandles("SlabClockEmpty1", "1h"));
    await waitFor(() => expect(first.result.current.status).toBe("empty"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    first.unmount();

    // Sanity: within the TTL the cached empty answer still short-circuits.
    vi.setSystemTime(T0 + 5_000);
    const second = renderHook(() => usePercolatorCandles("SlabClockEmpty1", "1h"));
    await waitFor(() => expect(second.result.current.status).toBe("empty"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    second.unmount();

    // Clock steps back an hour: the stamp is now "in the future".
    vi.setSystemTime(T0 - HOUR);
    const third = renderHook(() => usePercolatorCandles("SlabClockEmpty1", "1h"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    third.unmount();
  });

  it("paint cache: bars stamped in the future are not painted as fresh", async () => {
    const bars = { s: "ok", t: [1], o: [1], h: [2], l: [0.5], c: [1.5], v: [10] };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(bars))
      .mockResolvedValue(json({}, 500));
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = renderHook(() => usePercolatorCandles("SlabClockPaint1", "1h"));
    await waitFor(() => expect(first.result.current.status).toBe("success"));
    first.unmount();

    // Clock steps back an hour; refetch fails, so only the paint cache could
    // supply candles. A future-stamped entry must not count as fresh.
    vi.setSystemTime(T0 - HOUR);
    const second = renderHook(() => usePercolatorCandles("SlabClockPaint1", "1h"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(second.result.current.status).not.toBe("success");
    expect(second.result.current.candles).toEqual([]);
    second.unmount();
  });

  it("a transient fetch error does not populate the empty cache", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValue(json({ s: "no_data" }));
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = renderHook(() => usePercolatorCandles("SlabClockErr1", "1h"));
    await waitFor(() => expect(first.result.current.status).toBe("error"));
    first.unmount();

    const second = renderHook(() => usePercolatorCandles("SlabClockErr1", "1h"));
    await waitFor(() => expect(second.result.current.status).toBe("empty"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    second.unmount();
  });
});
