/**
 * A fetch cycle slower than the 15s poll (429 backoff on devnet) was superseded by every tick:
 * nothing ever published, `loading` never cleared, and each tick stacked another cycle.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));

import { useEarnStats } from "@/hooks/useEarnStats";

const CYCLE_MS = 20_000;

describe("useEarnStats: wall-clock step backwards during a cycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("a backwards clock step does not freeze polling until the old start + 60s", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {})) // first cycle hangs
      .mockImplementation(
        () => Promise.resolve(new Response(JSON.stringify({ markets: [] }), { status: 200 })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useEarnStats());
    const first = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    vi.setSystemTime(Date.now() - 3_600_000); // NTP / manual step back one hour
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000); // next poll tick
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(first);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(result.current.loading).toBe(false);
  });
});
