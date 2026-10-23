/**
 * #41: after a close, the portfolio's trade history and stats kept the pre-close numbers until a
 * wallet switch or reload. Neither hook listened to portfolio invalidation, and the page's Refresh
 * button only refreshed positions and LP. Both now re-fetch on invalidatePortfolio(), once right
 * away and again on the INDEXER_RECONCILE_MS tail, with a cache-busted URL (both routes are
 * CDN-cached, so the same URL would return the pre-close body).
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTradeHistory } from "@/hooks/useTradeHistory";
import { useTraderStats } from "@/hooks/useTraderStats";
import {
  INDEXER_RECONCILE_MS,
  __resetPortfolioInvalidationForTests,
  invalidatePortfolio,
} from "@/lib/portfolio-invalidation";

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
  ok: true,
  status: 200,
  json: async () => ({ trades: [], total: 0 }),
}));
const urls = (part: string) => fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes(part));
const flush = () => act(async () => { await Promise.resolve(); });

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  __resetPortfolioInvalidationForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each([
  ["trade history", "/trades", () => useTradeHistory({ wallet: "wallet-a" })],
  ["trader stats", "/stats", () => useTraderStats("wallet-a")],
])("%s after a portfolio invalidation", (_name, path, hook) => {
  it("re-fetches right away and on each offset, past the CDN cache", async () => {
    renderHook(hook);
    await flush();
    expect(urls(path)).toHaveLength(1);

    act(() => invalidatePortfolio());
    await flush();
    expect(urls(path)).toHaveLength(2);

    let prev = 0;
    for (const [i, ms] of INDEXER_RECONCILE_MS.entries()) {
      await act(async () => { vi.advanceTimersByTime(ms - prev); });
      prev = ms;
      expect(urls(path)).toHaveLength(3 + i);
    }
    // Every reload carries a unique cache-buster and skips the browser cache.
    expect(urls(path).slice(1).every((u) => /[?&]_cb=\d+/.test(u))).toBe(true);
    const inits = fetchMock.mock.calls.filter(([u]) => String(u).includes(path)).slice(1).map(([, init]) => init);
    expect(inits.every((init) => init?.cache === "no-store")).toBe(true);
  });

  it("a second invalidation restarts the schedule instead of stacking one", async () => {
    renderHook(hook);
    await flush();
    act(() => invalidatePortfolio());
    act(() => invalidatePortfolio());
    await flush();
    const afterTwo = urls(path).length; // initial + 2 immediate
    await act(async () => { vi.advanceTimersByTime(INDEXER_RECONCILE_MS[INDEXER_RECONCILE_MS.length - 1]); });
    expect(urls(path).length - afterTwo).toBe(INDEXER_RECONCILE_MS.length);
  });

  it("stops after unmount, pending follow-ups included", async () => {
    const { unmount } = renderHook(hook);
    await flush();
    act(() => invalidatePortfolio());
    unmount();
    const before = urls(path).length;
    await act(async () => { vi.advanceTimersByTime(30_000); });
    invalidatePortfolio();
    expect(urls(path)).toHaveLength(before);
  });
});
