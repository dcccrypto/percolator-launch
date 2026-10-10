"use client";

/** The current holding fee on a position in a rent market ("Holding fee 0.04% per day"). Nothing otherwise. */
import type { FC } from "react";
import { V22_COPY } from "@/lib/v22/copy";
import { rentPercentPerDay, type BandRentView } from "@/lib/v22/band-rent-state";

export const holdingFeeLabel = (view: BandRentView | null, side: "long" | "short"): string | null => {
  if (!view || !view.rent.enabled) return null;
  const rate = side === "long" ? view.rent.rateLongE9 : view.rent.rateShortE9;
  if (rate === 0n) return V22_COPY.rent.none;
  const pct = rentPercentPerDay(rate);
  return V22_COPY.rent.rate(`${pct < 0.01 ? "<0.01" : pct.toFixed(2)}%`);
};

export const HoldingFeeChip: FC<{ view: BandRentView | null; side: "long" | "short" }> = ({ view, side }) => {
  const label = holdingFeeLabel(view, side);
  if (!label) return null;
  return (
    <span data-testid="holding-fee" title={V22_COPY.rent.hint} className="ml-1.5 inline-block text-[9px] text-[var(--text-dim)]">
      {label}
    </span>
  );
};
