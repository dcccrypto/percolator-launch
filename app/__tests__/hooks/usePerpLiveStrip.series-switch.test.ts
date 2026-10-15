/**
 * The stats strip read "Offline" for a moment on every Mark/Oracle/Last switch: the live marker belongs
 * to the market's feed, not the series, but the switch cleared it. Only a market switch clears it now;
 * a series switch still clears the price (the Mark price under an "Oracle" label would be wrong).
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PerpSeries } from "@/lib/chart/perp-types";

const live = vi.hoisted(() => ({ onTick: null as null | ((m: { mark: number; oracle: number }) => void) }));
vi.mock("@/lib/tv/data", () => ({
  getLiveClient: () => ({
    subscribe: (_slab: string, h: { onTick: (m: { mark: number; oracle: number }) => void }) => {
      live.onTick = h.onTick;
      return () => {};
    },
  }),
}));

import { usePerpLiveStrip } from "@/hooks/usePerpLiveStrip";

describe("usePerpLiveStrip across a switch", () => {
  it("stays live on a series switch, clears the price; a market switch clears both", () => {
    const { result, rerender } = renderHook(({ slab, series }: { slab: string; series: PerpSeries }) => usePerpLiveStrip(slab, series), {
      initialProps: { slab: "A", series: "mark" as PerpSeries },
    });
    act(() => live.onTick?.({ mark: 1.5, oracle: 1.4 }));
    expect(result.current.live).toBe("live");
    expect(result.current.price).toBe(1.5);

    rerender({ slab: "A", series: "oracle" });
    expect(result.current.live).toBe("live");
    expect(result.current.price).toBeNull();

    rerender({ slab: "B", series: "oracle" });
    expect(result.current.live).not.toBe("live");
  });
});
