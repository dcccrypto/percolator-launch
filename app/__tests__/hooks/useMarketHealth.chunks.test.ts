/**
 * N18: /markets now reads live health for every listed market. The route takes at most
 * MAX_HEALTH_SLABS (50) per request, and fetchMarketHealth used to cut a longer list to 50, so
 * markets past 50 never got a read. The hook sends the list in chunks and merges the results.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useMarketHealth, __resetMarketHealthCache } from "@/hooks/useMarketHealth";
import { MAX_HEALTH_SLABS } from "@/lib/market-health";

const slab = (i: number) => `S${String(i).padStart(3, "0")}`;
const SLABS = Array.from({ length: 120 }, (_, i) => slab(i));
const row = (s: string) => ({ badges: [], lockReasons: [], lpDepleted: false, lpCapital: s });

const fetchMock = vi.fn();
const asked = (url: string) => decodeURIComponent(url.split("slabs=")[1]).split(",");

beforeEach(() => {
  __resetMarketHealthCache();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => ({ markets: Object.fromEntries(asked(url).map((s) => [s, row(s)])) }),
  }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("useMarketHealth: lists longer than one request", () => {
  it("120 slabs go out as 3 requests of at most 50, and every slab gets its row", async () => {
    const { result } = renderHook(() => useMarketHealth(SLABS));
    await waitFor(() => expect(Object.keys(result.current.health)).toHaveLength(120));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url] of fetchMock.mock.calls) expect(asked(url as string).length).toBeLessThanOrEqual(MAX_HEALTH_SLABS);
    expect(result.current.health[slab(119)]).toEqual(row(slab(119)));
  });

  it("a failed chunk keeps its last good rows; the others update", async () => {
    const { result } = renderHook(() => useMarketHealth(SLABS));
    await waitFor(() => expect(Object.keys(result.current.health)).toHaveLength(120));

    // Next poll: the chunk holding S050..S099 fails, the rest answer with new rows.
    fetchMock.mockImplementation(async (url: string) => {
      const s = asked(url);
      if (s.includes(slab(50))) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ markets: Object.fromEntries(s.map((x) => [x, { ...row(x), lpDepleted: true }])) }) };
    });
    result.current.refresh();
    await waitFor(() => expect((result.current.health[slab(0)] as { lpDepleted: boolean }).lpDepleted).toBe(true));
    expect(result.current.health[slab(50)]).toEqual(row(slab(50)));
    expect((result.current.health[slab(119)] as { lpDepleted: boolean }).lpDepleted).toBe(true);
  });

  it("CONTROL: one slab is still one request", async () => {
    const { result } = renderHook(() => useMarketHealth([slab(1)]));
    await waitFor(() => expect(result.current.health[slab(1)]).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
