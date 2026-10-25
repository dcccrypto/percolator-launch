/**
 * useMarketLifecycles `ready`: a hung first read stops blocking the list after LIFECYCLE_READY_TIMEOUT_MS, and a new slab set after
 * the first answer never puts the list back into loading.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const h = vi.hoisted(() => ({ getMultipleAccountsInfo: vi.fn() }));

vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: () => ({ connection: { getMultipleAccountsInfo: h.getMultipleAccountsInfo } }) }));
vi.mock("@/hooks/useClusterSlot", () => ({ useClusterSlot: () => 1_000n }));

import { LIFECYCLE_READY_TIMEOUT_MS, useMarketLifecycles } from "@/hooks/useMarketLifecycles";

const A = "AAAA1111111111111111111111111111111111111111";
const B = "BBBB1111111111111111111111111111111111111111";

const wrapper = ({ children }: { children: ReactNode }) => <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>;

beforeEach(() => {
  cleanup();
  vi.useFakeTimers();
  __setDevnetV22ForTest(true);
  h.getMultipleAccountsInfo.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  __setDevnetV22ForTest(null);
});

describe("useMarketLifecycles ready", () => {
  it("a read that never answers stops blocking the list after the timeout", async () => {
    h.getMultipleAccountsInfo.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useMarketLifecycles([A]), { wrapper });
    expect(result.current.ready).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(LIFECYCLE_READY_TIMEOUT_MS - 1);
    });
    expect(result.current.ready).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.ready).toBe(true);
    expect(result.current.lifecycles.size).toBe(0);
  });

  it("after the first answer a new slab set keeps the list ready while it is read", async () => {
    let calls = 0;
    h.getMultipleAccountsInfo.mockImplementation(async (keys: unknown[]) => {
      calls++;
      if (calls === 1) return keys.map(() => null);
      return new Promise(() => {});
    });
    const { result, rerender } = renderHook(({ slabs }) => useMarketLifecycles(slabs), { wrapper, initialProps: { slabs: [A] } });
    // Flush promises only (no timers), so `ready` here can only come from the answered read, not from the timeout.
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(result.current.ready).toBe(true);
    rerender({ slabs: [A, B] });
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toBe(2);
    expect(result.current.ready).toBe(true);
  });
});
