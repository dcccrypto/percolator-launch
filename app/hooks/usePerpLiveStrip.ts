"use client";

import { useEffect, useState } from "react";
import { getLiveClient } from "@/lib/tv/data";
import type { PerpSeries } from "@/lib/chart/perp-types";
import type { LiveState } from "@/components/trade/perp/PerpChartHeader";

const DELAYED_AFTER_MS = 10_000;
const OFFLINE_AFTER_MS = 60_000;

/** Live price of the chosen series from the pushed ticks, plus a live/delayed/offline marker (1 Hz age readout). */
export function usePerpLiveStrip(slab: string, series: PerpSeries): { price: number | null; live: LiveState; ageSec: number | null } {
  const [price, setPrice] = useState<number | null>(null);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [, setBeat] = useState(0);

  // Live/offline is the market's feed, not the series: only a market switch clears it. A series switch
  // clears the price alone (the Mark price under an "Oracle" label would be wrong; "—" until a tick is not).
  useEffect(() => setLastAt(null), [slab]);

  useEffect(() => {
    setPrice(null);
    const client = getLiveClient();
    if (!client) return;
    return client.subscribe(slab, {
      onTick: (m) => {
        const p = series === "oracle" ? m.oracle : m.mark; // Last has no tick price: the mark stands in until a trade prints
        if (p != null) setPrice(p);
        setLastAt(Date.now());
      },
      onTrade: (t) => { if (series === "last") setPrice(t.price); },
    });
  }, [slab, series]);

  useEffect(() => {
    const id = setInterval(() => setBeat((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const age = lastAt === null ? null : Date.now() - lastAt;
  const live: LiveState = age === null || age > OFFLINE_AFTER_MS ? "offline" : age > DELAYED_AFTER_MS ? "delayed" : "live";
  return { price, live, ageSec: age === null ? null : age / 1000 };
}
