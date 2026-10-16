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
import { createPerpProvider } from "./perpProvider";
import { createLiveClient, wsToHttpBase, type LiveClient, type WsLike } from "@/lib/chart/live-client";
import { getSeriesStore } from "@/lib/chart/perp-series";
import { getWsManager } from "@/lib/priceStore/wsManager";

let provider: ChartDataProvider | null = null;
let liveClient: LiveClient | null = null;

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

/** NEXT_PUBLIC_PERP_CHART=0 is the rollback switch back to the trade-built candles-api provider alone. */
export function perpChartEnabled(): boolean {
  return process.env.NEXT_PUBLIC_PERP_CHART !== "0" && !!process.env.NEXT_PUBLIC_WS_URL;
}

/** The shared push client (null when no WS URL is configured). Same socket the price store uses. */
export function getLiveClient(): LiveClient | null {
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "";
  if (!wsUrl) return null;
  if (!liveClient) {
    // Resolve the shared manager per call, never capture its handle: the manager is torn down after
    // 20 s with no subscribers (e.g. a page without prices), and a captured handle stays bound to the
    // dead one, so the chart sat at "Offline" until a reload while the header price kept ticking.
    const ws: WsLike = {
      subscribeChannel: (channel) => getWsManager(wsUrl).subscribeChannel(channel),
      onMessageForChannel: (channel, listener) => getWsManager(wsUrl).onMessageForChannel(channel, listener),
      onStatusChange: (listener) => getWsManager(wsUrl).onStatusChange(listener),
      getStatus: () => getWsManager(wsUrl).getStatus(),
    };
    liveClient = createLiveClient({ ws, httpBase: wsToHttpBase(wsUrl), fetchJson: (url) => fetch(url, { cache: "no-store" }) });
  }
  return liveClient;
}

export function getChartDataProvider(): ChartDataProvider {
  if (!provider) {
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "";
    const base = createCandlesApiProvider({
      fetchImpl: (input, init) => fetch(input, init),
      trades: createTradeStream(wsUrl || null),
      marks: priceStoreMarks,
    });
    provider = perpChartEnabled()
      ? createPerpProvider({
          base,
          live: getLiveClient() as LiveClient,
          fetchImpl: (input, init) => fetch(input, init),
          series: getSeriesStore(),
        })
      : base;
  }
  return provider;
}

export type { ChartDataProvider } from "./provider";
