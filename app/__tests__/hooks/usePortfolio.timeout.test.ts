/**
 * Council r4 N5 (R3-7): a portfolio scan that never answers (RPC 503s / hangs behind retries) left usePortfolio on
 * loading forever. After PORTFOLIO_LOAD_TIMEOUT_MS with nothing loaded it reports a load error (Retry) instead.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const pk = new PublicKey(new Uint8Array(32).fill(91));
// Never settles: the hung RPC.
const connection = { getProgramAccounts: vi.fn(() => new Promise(() => {})), getMultipleAccountsInfo: vi.fn(() => new Promise(() => {})) };
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection }),
  useWalletCompat: () => ({ publicKey: pk, connected: true }),
}));
vi.mock("@/lib/config", async (orig) => ({
  ...(await orig<any>()),
  getAllProgramIds: () => [],
  getMarketDiscoveryProgramIds: () => [],
  getNetwork: () => "devnet",
}));
vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

import { PORTFOLIO_LOAD_TIMEOUT_MS, usePortfolio } from "@/hooks/usePortfolio";

describe("usePortfolio on a hung scan", () => {
  it("stops loading and reports an error after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => usePortfolio());
      expect(result.current.loading).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(PORTFOLIO_LOAD_TIMEOUT_MS - 1_000); });
      expect(result.current.loading).toBe(true);
      expect(result.current.error).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("usePortfolio retry after a hung scan", () => {
  it("starts a fresh read on Retry, and the stale scan cannot overwrite newer data", async () => {
    const { loadPortfolioShared, abandonPortfolioScan } = await import("@/hooks/usePortfolio");
    const snap = (n: number) => ({ positions: [], totalPnl: BigInt(n) }) as unknown as Parameters<typeof abandonPortfolioScan>[1] extends Promise<infer S> ? S : never;
    let resolveStale!: (s: ReturnType<typeof snap>) => void;
    const stale = new Promise<ReturnType<typeof snap>>((r) => { resolveStale = r; });
    const key = "devnet:retry-hang";
    const hung = loadPortfolioShared(key, false, () => stale);
    // Without abandoning, a forced refresh joins the dead scan.
    const fetcher = vi.fn(() => Promise.resolve(snap(2)));
    expect(loadPortfolioShared(key, true, fetcher)).toBe(hung);
    expect(fetcher).not.toHaveBeenCalled();
    abandonPortfolioScan(key, hung);
    const fresh = await loadPortfolioShared(key, true, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fresh.totalPnl).toBe(2n);
    resolveStale(snap(1));
    await hung;
    // The stale answer arrived late: the cached snapshot is still the fresh one.
    const cached = await loadPortfolioShared(key, false, () => Promise.reject(new Error("should hit cache")));
    expect(cached.totalPnl).toBe(2n);
  });

  it("the hook's timeout abandons the stuck scan so the next refresh re-reads", async () => {
    vi.useFakeTimers();
    try {
      connection.getProgramAccounts.mockClear();
      const { result } = renderHook(() => usePortfolio());
      await act(async () => { await vi.advanceTimersByTimeAsync(PORTFOLIO_LOAD_TIMEOUT_MS + 1_000); });
      expect(result.current.error).toBeTruthy();
      const callsBefore = connection.getProgramAccounts.mock.calls.length + (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
      await act(async () => { result.current.refresh(); await vi.advanceTimersByTimeAsync(100); });
      const callsAfter = connection.getProgramAccounts.mock.calls.length + (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});
