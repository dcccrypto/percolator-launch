"use client";

import { useMarketLotExp } from "@/hooks/useMarketLotExp";
import { lotTradingRefusal } from "@/lib/v22/lot-coverage";

/** The calm line to show instead of a trade/close control for this market, or null when trading is allowed (always null flag off). */
export function useLotTradingGuard(slab: string | null | undefined): string | null {
  const lotExp = useMarketLotExp(slab);
  return lotTradingRefusal(lotExp);
}
