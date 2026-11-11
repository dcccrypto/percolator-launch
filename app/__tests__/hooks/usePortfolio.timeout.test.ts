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

type Snap = Awaited<ReturnType<typeof import("@/hooks/usePortfolio")["loadPortfolioShared"]>>;
const snap = (n: number) => ({ positions: [], totalPnl: BigInt(n) }) as unknown as Snap;

describe("usePortfolio retry after a hung scan", () => {
  it("Retry after the timeout starts a fresh read, the periodic refresh joins, and the stale scan cannot overwrite newer data", async () => {
    const { loadPortfolioShared, PORTFOLIO_HUNG_SCAN_MS } = await import("@/hooks/usePortfolio");
    vi.useFakeTimers();
    try {
      let resolveStale!: (s: Snap) => void;
      const stale = new Promise<Snap>((r) => { resolveStale = r; });
      const key = "devnet:retry-hang";
      const hung = loadPortfolioShared(key, false, () => stale);
      const fetcher = vi.fn(() => Promise.resolve(snap(2)));
      // Within the timeout, even an explicit refresh joins the running scan.
      vi.advanceTimersByTime(PORTFOLIO_LOAD_TIMEOUT_MS - 1_000);
      expect(loadPortfolioShared(key, true, fetcher)).toBe(hung);
      // The periodic refresh joins a slow scan rather than piling up another.
      vi.advanceTimersByTime(2_000);
      expect(loadPortfolioShared(key, false, fetcher)).toBe(hung);
      expect(fetcher).not.toHaveBeenCalled();
      // Retry (forced) after the timeout starts a fresh read.
      const fresh = await loadPortfolioShared(key, true, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fresh.totalPnl).toBe(2n);
      // The stale scan answers late: the cached snapshot stays the newer one.
      resolveStale(snap(1));
      await hung;
      const cached = await loadPortfolioShared(key, false, () => Promise.reject(new Error("should hit cache")));
      expect(cached.totalPnl).toBe(2n);
      // A scan that has run past the hung limit is no longer joined by the periodic refresh.
      vi.advanceTimersByTime(60_000);
      let never!: (s: Snap) => void;
      const key2 = "devnet:hung-bound";
      loadPortfolioShared(key2, false, () => new Promise<Snap>((r) => { never = r; }));
      vi.advanceTimersByTime(PORTFOLIO_HUNG_SCAN_MS + 1);
      const f2 = vi.fn(() => Promise.resolve(snap(3)));
      await loadPortfolioShared(key2, false, f2);
      expect(f2).toHaveBeenCalledTimes(1);
      never(snap(0));
    } finally {
      vi.useRealTimers();
    }
  });

  it("a superseded scan settling does not free the slot of the scan that replaced it", async () => {
    const { loadPortfolioShared, PORTFOLIO_HUNG_SCAN_MS } = await import("@/hooks/usePortfolio");
    vi.useFakeTimers();
    try {
      const key = "devnet:slot-guard";
      let resolveOld!: (s: Snap) => void;
      let resolveNew!: (s: Snap) => void;
      const old = loadPortfolioShared(key, false, () => new Promise<Snap>((r) => { resolveOld = r; }));
      vi.advanceTimersByTime(PORTFOLIO_HUNG_SCAN_MS + 1);
      const replacement = loadPortfolioShared(key, false, () => new Promise<Snap>((r) => { resolveNew = r; }));
      expect(replacement).not.toBe(old);
      resolveOld(snap(1));
      await old;
      // The old scan is done; the replacement is still running and must still be joinable (no third scan).
      const third = vi.fn(() => Promise.resolve(snap(9)));
      expect(loadPortfolioShared(key, true, third)).toBe(replacement);
      expect(third).not.toHaveBeenCalled();
      resolveNew(snap(2));
      expect((await replacement).totalPnl).toBe(2n);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the hook's Retry after a timeout re-reads", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => usePortfolio());
      await act(async () => { await vi.advanceTimersByTimeAsync(PORTFOLIO_LOAD_TIMEOUT_MS + 1_000); });
      expect(result.current.error).toBeTruthy();
      const calls = () => (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
      const before = calls();
      await act(async () => { result.current.refresh(); await vi.advanceTimersByTimeAsync(100); });
      expect(calls()).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
