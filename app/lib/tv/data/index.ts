"use client";
/**
 * The ONE place that decides which market-data provider feeds the chart.
 * To switch providers, implement `ChartDataProvider` (./provider.ts) and
 * return it here — the widget, datafeed adapter and overlays are unchanged.
 */
import { getSnapshot, subscribeSlab } from "@/lib/priceStore/priceStore";
import { createCandlesApiProvider, type MarkStream } from "./candlesApiProvider";
import type { ChartDataProvider } from "./provider";
import { createTradeStream } from "./tradeStream";

let provider: ChartDataProvider | null = null;

const priceStoreMarks: MarkStream = {
  subscribe(slab, onTick) {
    return subscribeSlab(slab, () => {
      const p = getSnapshot(slab).priceUsd;
      if (p != null && Number.isFinite(p) && p > 0) onTick(p, Math.floor(Date.now() / 1000));
    });
  },
  latest(slab) {
    const p = getSnapshot(slab).priceUsd;
    return p != null && Number.isFinite(p) && p > 0 ? p : null;
  },
};

export function getChartDataProvider(): ChartDataProvider {
  if (!provider) {
    provider = createCandlesApiProvider({
      fetchImpl: (input, init) => fetch(input, init),
      trades: createTradeStream(process.env.NEXT_PUBLIC_WS_URL || null),
      marks: priceStoreMarks,
    });
  }
  return provider;
}

export type { ChartDataProvider } from "./provider";
