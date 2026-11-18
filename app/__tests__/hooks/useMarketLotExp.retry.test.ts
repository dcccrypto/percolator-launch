import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __resetLotRegistryForTest, setLotExpLoader, LOT_LOAD_RETRY_MS } from "@/lib/v22/lot-registry";
import { useMarketLotExp, useMarketLotExps } from "@/hooks/useMarketLotExp";
import { useLotTradingGuard } from "@/hooks/useLotTradingGuard";

const SLAB = "SlabRetry1111111111111111111111111111111111";

describe("lot exponent retry after a failed load", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __setDevnetV22ForTest(true);
    __resetLotRegistryForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    __setDevnetV22ForTest(null);
    __resetLotRegistryForTest();
  });

  it("guard clears after one failed read, without changing slab", async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error("rpc")).mockResolvedValue(6);
    setLotExpLoader(loader);
    const { result } = renderHook(() => ({ exp: useMarketLotExp(SLAB), guard: useLotTradingGuard(SLAB) }));
    await act(async () => {});
    expect(loader).toHaveBeenCalledTimes(1);
    expect(result.current.exp).toBeNull();
    expect(result.current.guard).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOT_LOAD_RETRY_MS + 1000);
    });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(result.current.exp).toBe(6);
    expect(result.current.guard).toBeNull();
  });

  it("is bounded (one attempt per window), stops once known and on unmount", async () => {
    const loader = vi.fn().mockRejectedValue(new Error("rpc"));
    setLotExpLoader(loader);
    const { unmount } = renderHook(() => useMarketLotExp(SLAB));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOT_LOAD_RETRY_MS * 3 + 500);
    });
    expect(loader.mock.calls.length).toBeLessThanOrEqual(4);
    expect(loader.mock.calls.length).toBeGreaterThanOrEqual(3);
    unmount();
    const n = loader.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOT_LOAD_RETRY_MS * 5);
    });
    expect(loader).toHaveBeenCalledTimes(n);
  });

  it("list hook retries too", async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error("rpc")).mockResolvedValue(3);
    setLotExpLoader(loader);
    const { result } = renderHook(() => useMarketLotExps([SLAB]));
    await act(async () => {});
    expect(result.current.get(SLAB)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOT_LOAD_RETRY_MS + 1000);
    });
    expect(result.current.get(SLAB)).toBe(3);
  });
});
