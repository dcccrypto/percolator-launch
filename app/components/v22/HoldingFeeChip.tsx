"use client";

/**
 * The current holding fee on a position in a rent market ("Holding fee 0.04% per day"). On a band market whose side is
 * more than 85% full it adds the flat per-position part (prog#572): "Holding fee 0.04% + 0.86 USDC per day". Nothing otherwise.
 */
import type { FC } from "react";
import { V22_COPY } from "@/lib/v22/copy";
import { occupancyAtomsPerDay, rentPercentPerDay, type BandRentView } from "@/lib/v22/band-rent-state";

/** Collateral used to show the flat part; without it the flat part is not shown (the percent part is unchanged). */
export interface HoldingFeeCollateral {
  decimals: number;
  symbol: string;
}

/** A per-day atom amount in whole collateral units, rounded UP to the cent ("<0.01" below a cent). */
export const flatFeeText = (atoms: bigint, c: HoldingFeeCollateral): string => {
  const unit = 10n ** BigInt(c.decimals);
  const cents = (atoms * 100n + unit - 1n) / unit;
  return atoms * 100n < unit ? `<0.01 ${c.symbol}` : `${(Number(cents) / 100).toFixed(2)} ${c.symbol}`;
};

export const holdingFeeLabel = (view: BandRentView | null, side: "long" | "short", collateral?: HoldingFeeCollateral): string | null => {
  if (!view || !view.rent.enabled) return null;
  const rate = side === "long" ? view.rent.rateLongE9 : view.rent.rateShortE9;
  const flatAtoms = collateral ? occupancyAtomsPerDay(view, side) : 0n;
  const flat = flatAtoms > 0n && collateral ? flatFeeText(flatAtoms, collateral) : null;
  if (rate === 0n) return flat ? V22_COPY.rent.flat(flat) : V22_COPY.rent.none;
  const pct = rentPercentPerDay(rate);
  const pctText = `${pct < 0.01 ? "<0.01" : pct.toFixed(2)}%`;
  return flat ? V22_COPY.rent.rateAndFlat(pctText, flat) : V22_COPY.rent.rate(pctText);
};

export const HoldingFeeChip: FC<{ view: BandRentView | null; side: "long" | "short"; collateral?: HoldingFeeCollateral }> = ({ view, side, collateral }) => {
  const label = holdingFeeLabel(view, side, collateral);
  if (!label) return null;
  return (
    <span data-testid="holding-fee" title={V22_COPY.rent.hint} className="ml-1.5 inline-block text-[9px] text-[var(--text-dim)]">
      {label}
    </span>
  );
};
