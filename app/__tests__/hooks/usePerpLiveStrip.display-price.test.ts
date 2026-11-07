/**
 * Council 2026-11-06-go1106-ux (Trader, First-timer): the chart read "Offline" while the page price ticked. The TV
 * chart's strip had the same blind spot as PerpChart: it counted only `tick` pushes, which the v2.2 price-WS does not
 * publish. A display-price update (the shared price store) now keeps it live.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const feeds = vi.hoisted(() => ({ display: null as null | (() => void), unsubscribed: 0 }));
vi.mock("@/lib/tv/data", () => ({
  getLiveClient: () => ({ subscribe: () => () => {} }), // a tick channel that never speaks
  subscribeDisplayPrice: (_slab: string, onUpdate: () => void) => {
    feeds.display = onUpdate;
    return () => {
      feeds.unsubscribed++;
      feeds.display = null;
    };
  },
}));

import { usePerpLiveStrip } from "@/hooks/usePerpLiveStrip";

describe("usePerpLiveStrip: the display price counts as live", () => {
  it("offline before anything, live after a display-price update with no ticks", () => {
    const { result } = renderHook(() => usePerpLiveStrip("A", "mark"));
    expect(result.current.live).toBe("offline");
    act(() => feeds.display?.());
    expect(result.current.live).toBe("live");
  });

  it("a market switch resubscribes and starts offline again", () => {
    const { result, rerender } = renderHook(({ slab }: { slab: string }) => usePerpLiveStrip(slab, "mark"), { initialProps: { slab: "A" } });
    act(() => feeds.display?.());
    expect(result.current.live).toBe("live");
    const before = feeds.unsubscribed;
    rerender({ slab: "B" });
    expect(feeds.unsubscribed).toBe(before + 1);
    expect(result.current.live).toBe("offline");
  });
});
