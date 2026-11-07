"use client";

import { useEffect, useState } from "react";
import { getLiveClient, subscribeDisplayPrice } from "@/lib/tv/data";
import type { PerpSeries } from "@/lib/chart/perp-types";
import type { LiveState } from "@/components/trade/perp/PerpChartHeader";
import { chartLiveState } from "@/lib/chart/live-state";

/**
 * Live price of the chosen series from the pushed ticks, plus a live/delayed/offline marker (1 Hz age readout).
 * The marker also counts display-price updates (lib/chart/live-state.ts): the v2.2 price-WS publishes no ticks.
 */
export function usePerpLiveStrip(slab: string, series: PerpSeries): { price: number | null; live: LiveState; ageSec: number | null } {
  const [price, setPrice] = useState<number | null>(null);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [displayAt, setDisplayAt] = useState<number | null>(null);
  const [, setBeat] = useState(0);

  // Live/offline is the market's feed, not the series: only a market switch clears it. A series switch
  // clears the price alone (the Mark price under an "Oracle" label would be wrong; "—" until a tick is not).
  useEffect(() => setLastAt(null), [slab]);

  useEffect(() => {
    setDisplayAt(null);
    return subscribeDisplayPrice(slab, () => setDisplayAt(Date.now()));
  }, [slab]);

  useEffect(() => {
    setPrice(null);
    const client = getLiveClient();
    if (!client) return;
    // Last has no tick price: the mark stands in only until a trade prints in this subscription. After
    // that a tick must not overwrite the trade price, or "Last" reads the mark. (PerpChart seeds Last
    // from its last history candle instead; this strip has no history, so a thin market shows the mark
    // until a trade.)
    let traded = false;
    return client.subscribe(slab, {
      onTick: (m) => {
        const p = series === "oracle" ? m.oracle : m.mark;
        if (p != null && !(series === "last" && traded)) setPrice(p);
        setLastAt(Date.now());
      },
      onTrade: (t) => {
        if (series !== "last") return;
        traded = true;
        setPrice(t.price);
      },
    });
  }, [slab, series]);

  useEffect(() => {
    const id = setInterval(() => setBeat((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const { state: live, ageMs } = chartLiveState({ tickAt: lastAt, displayAt, now: Date.now() });
  return { price, live, ageSec: ageMs === null ? null : ageMs / 1000 };
}
