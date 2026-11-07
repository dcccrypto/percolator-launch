/**
 * Council 2026-11-06-go1106-ux (Trader, First-timer): the chart read "Offline" while the page price ticked: the TV
 * chart's strip counted only `tick` pushes, which the v2.2 price-WS does not publish. Council council-leftovers run 2
 * (#1): the strip, PerpChart and the page header badge now read ONE freshness clock (lib/price-freshness.ts), and the
 * strip price falls back to the display price (same store as the header) instead of "—".
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tv/data", () => ({
  getLiveClient: () => ({ subscribe: () => () => {} }), // a tick channel that never speaks
}));

import { usePerpLiveStrip } from "@/hooks/usePerpLiveStrip";
import { __resetPriceFreshnessForTests, markPriceFresh } from "@/lib/price-freshness";
import { applyOnChainPoll } from "@/lib/priceStore/priceStore";

beforeEach(() => __resetPriceFreshnessForTests());

describe("usePerpLiveStrip reads the shared freshness clock", () => {
  it("offline before anything, live after a fresh display price with no ticks", () => {
    const { result } = renderHook(() => usePerpLiveStrip("A", "mark"));
    expect(result.current.live).toBe("offline");
    act(() => markPriceFresh("A"));
    expect(result.current.live).toBe("live");
  });

  it("a market switch reads the other market's clock", () => {
    const { result, rerender } = renderHook(({ slab }: { slab: string }) => usePerpLiveStrip(slab, "mark"), { initialProps: { slab: "A" } });
    act(() => markPriceFresh("A"));
    expect(result.current.live).toBe("live");
    rerender({ slab: "B" });
    expect(result.current.live).toBe("offline");
  });

  it("with no tick price the strip shows the display price (Mark/Oracle), never for Last", () => {
    const slab = "StripSlab111111111111111111111111111111111";
    const { result, rerender } = renderHook(({ series }: { series: "mark" | "last" }) => usePerpLiveStrip(slab, series), { initialProps: { series: "mark" as "mark" | "last" } });
    expect(result.current.price).toBeNull();
    act(() => { applyOnChainPoll(slab, 2_500_000n); });
    expect(result.current.price).toBe(2.5);
    expect(result.current.live).toBe("live");
    rerender({ series: "last" });
    expect(result.current.price).toBeNull();
  });
});
