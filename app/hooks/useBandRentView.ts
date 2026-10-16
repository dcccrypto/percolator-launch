"use client";

import { useMemo } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { readBandRentView, type BandRentView } from "@/lib/v22/band-rent-state";

/**
 * The band + holding-fee view of the open market (asset 0), or null. Null whenever the v2.2 flag is off (nothing
 * is decoded), the market is not a v2.2 market, or it has neither a band nor a holding fee.
 */
export function useBandRentView(assetIndex = 0): BandRentView | null {
  const { raw } = useSlabState();
  const on = isDevnetV22Enabled();
  return useMemo(() => (on ? readBandRentView(raw, assetIndex) : null), [on, raw, assetIndex]);
}
