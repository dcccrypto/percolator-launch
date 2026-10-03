/**
 * A fetch cycle slower than the 15s poll (429 backoff on devnet) was superseded by every tick:
 * nothing ever published, `loading` never cleared, and each tick stacked another cycle.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));

import { useEarnStats } from "@/hooks/useEarnStats";

const CYCLE_MS = 20_000; // slower than the 15s poll

describe("useEarnStats: a cycle slower than the poll interval", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    // Both list endpoints answer after CYCLE_MS with no markets, so the cycle makes no RPC calls.
    fetchMock = vi.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(new Response(JSON.stringify({ markets: [] }), { status: 200 })), CYCLE_MS),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("lets the running cycle finish and publish instead of starting another", async () => {
    const { result } = renderHook(() => useEarnStats());
    expect(fetchMock).toHaveBeenCalledTimes(2); // one cycle: live + registered lists

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000); // poll tick while the cycle is still running
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CYCLE_MS - 15_000);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();

    // The next tick after it finished starts a new cycle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("a StrictMode remount still loads", async () => {
    const { result } = renderHook(() => useEarnStats(), { reactStrictMode: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CYCLE_MS);
    });
    expect(result.current.loading).toBe(false);
  });

  it("supersedes a cycle that has hung for 60s", async () => {
    fetchMock.mockImplementationOnce(() => new Promise(() => {})); // never settles
    const { result } = renderHook(() => useEarnStats());
    const first = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(fetchMock.mock.calls.length).toBe(first);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(first);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CYCLE_MS);
    });
    expect(result.current.loading).toBe(false);
  });

  it("refresh() during a running poll cycle supersedes it and publishes", async () => {
    const { result } = renderHook(() => useEarnStats());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      void result.current.refresh();
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CYCLE_MS);
    });
    expect(result.current.loading).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4); // the 15s tick was skipped while refresh ran
  });
});
