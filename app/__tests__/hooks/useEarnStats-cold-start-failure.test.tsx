/**
 * A failed FIRST load has no "last known values": its figures are partly unread (a failed batch
 * reads as $0, or as shares + fees). The hook says so (COLD_START_ERROR, hasData false) and the
 * Earn hub keeps its loading state instead of showing them. After a good read, a failed refresh
 * keeps the last good snapshot as before.
 */
import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));

import { COLD_START_ERROR, useEarnStats } from "@/hooks/useEarnStats";

describe("useEarnStats: a failed first load", () => {
  let marketsOk = false;
  beforeEach(() => {
    marketsOk = false;
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    // No markets on success, so a cycle makes no RPC calls; the market list failing is the failure.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/api/markets") && !marketsOk
          ? new Response("down", { status: 503 })
          : new Response(JSON.stringify({ markets: [] }), { status: 200 }),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("says nothing is known yet, then recovers on the next poll; a later failure keeps the last good data", async () => {
    const { result } = renderHook(() => useEarnStats());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.hasData).toBe(false);
    expect(result.current.error).toBe(COLD_START_ERROR);

    marketsOk = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(result.current.hasData).toBe(true);
    expect(result.current.error).toBeNull();

    marketsOk = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(result.current.hasData).toBe(true);
    expect(result.current.error).toBe("Failed to refresh on-chain data — showing last known values");
  });
});
