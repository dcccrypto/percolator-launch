/**
 * S22: on the TradingView chart's "Last" series the strip price is the last trade, with the mark
 * standing in only until a trade prints. Every tick overwrote it with the mark, so "Last" read Mark.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PerpSeries } from "@/lib/chart/perp-types";

type Tick = { mark: number; oracle: number };
const live = vi.hoisted(() => ({
  onTick: null as null | ((m: Tick) => void),
  onTrade: null as null | ((t: { price: number }) => void),
}));
vi.mock("@/lib/tv/data", () => ({
  getLiveClient: () => ({
    subscribe: (_slab: string, h: { onTick: (m: Tick) => void; onTrade: (t: { price: number }) => void }) => {
      live.onTick = h.onTick;
      live.onTrade = h.onTrade;
      return () => {};
    },
  }),
}));

import { usePerpLiveStrip } from "@/hooks/usePerpLiveStrip";

const render = (series: PerpSeries) => renderHook(() => usePerpLiveStrip("A", series));

describe("usePerpLiveStrip on the Last series", () => {
  it("the mark stands in before any trade; after a trade, ticks don't overwrite it", () => {
    const { result } = render("last");
    act(() => live.onTick?.({ mark: 1.5, oracle: 1.4 }));
    expect(result.current.price).toBe(1.5);
    act(() => live.onTrade?.({ price: 1.62 }));
    expect(result.current.price).toBe(1.62);
    act(() => live.onTick?.({ mark: 1.51, oracle: 1.41 }));
    expect(result.current.price).toBe(1.62);
    act(() => live.onTrade?.({ price: 1.6 }));
    expect(result.current.price).toBe(1.6);
  });

  it("CONTROL: Mark and Oracle follow the ticks and ignore trades", () => {
    const mark = render("mark");
    act(() => live.onTrade?.({ price: 9 }));
    act(() => live.onTick?.({ mark: 1.5, oracle: 1.4 }));
    expect(mark.result.current.price).toBe(1.5);
    const oracle = render("oracle");
    act(() => live.onTick?.({ mark: 1.5, oracle: 1.4 }));
    act(() => live.onTrade?.({ price: 9 }));
    expect(oracle.result.current.price).toBe(1.4);
  });
});
