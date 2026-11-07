"use client";

import { useEffect, useState } from "react";
import { getLiveClient } from "@/lib/tv/data";
import type { PerpSeries } from "@/lib/chart/perp-types";
import type { LiveState } from "@/components/trade/perp/PerpChartHeader";
import { useDisplayPriceTokenUsd, usePriceFreshness } from "@/hooks/usePriceFreshness";

/**
 * Live price of the chosen series from the pushed ticks, plus a live/delayed/offline marker (1 Hz age readout).
 * The marker is the market's ONE freshness clock (lib/price-freshness.ts), the one the page header badge reads too:
 * a chart tick, a live display price or a moved on-chain price advances it. With no tick price of its own (the v2.2
 * price-WS publishes the display price only) the strip shows the page header's display price, not "—".
 */
export function usePerpLiveStrip(slab: string, series: PerpSeries): { price: number | null; live: LiveState; ageSec: number | null } {
  const [price, setPrice] = useState<number | null>(null);

  useEffect(() => {
    // A series switch clears the price alone (the Mark price under an "Oracle" label would be wrong).
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
      },
      onTrade: (t) => {
        if (series !== "last") return;
        traded = true;
        setPrice(t.price);
      },
    });
  }, [slab, series]);

  const { state: live, ageMs } = usePriceFreshness(slab);
  const displayPrice = useDisplayPriceTokenUsd(slab);
  const shown = price ?? (series === "last" ? null : displayPrice);
  return { price: shown, live, ageSec: ageMs === null ? null : ageMs / 1000 };
}
