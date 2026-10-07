"use client";

/**
 * Band ("price protection") markets: shows the mark versus the oracle target ONLY while they differ, and the minimum
 * position size. Calm, one line each. Renders nothing when there is no band (the caller gates on the v2.2 flag).
 */
import type { FC } from "react";
import { displayPriceV22 } from "@/lib/v22/sdk";
import { V22_COPY, fmtTokens } from "@/lib/v22/copy";
import type { BandRentView } from "@/lib/v22/band-rent-state";

export interface BandMarketNoticeProps {
  view: BandRentView | null;
  /** Collateral decimals, to show the minimum position in whole collateral units. */
  collateralDecimals: number;
  /** Collateral symbol ("USDC"). */
  collateralSymbol: string;
}

export const BandMarketNotice: FC<BandMarketNoticeProps> = ({ view, collateralDecimals, collateralSymbol }) => {
  if (!view || !view.band.enabled) return null;
  const min = Number(view.band.minLegNotionalAtoms) / 10 ** collateralDecimals;
  return (
    <div data-testid="band-market-notice" className="mb-2 space-y-0.5 text-[10px] text-[var(--text-secondary)]">
      {view.price.lagging && (
        <p data-testid="band-mark-vs-target" className="text-[var(--text)]">
          {V22_COPY.band.markVsTarget(displayPriceV22(view.price.markE6, view.lotExp), displayPriceV22(view.price.targetE6, view.lotExp))}
        </p>
      )}
      {min > 0 && <p data-testid="band-min-position">{V22_COPY.band.minPosition(fmtTokens(min), collateralSymbol)}</p>}
    </div>
  );
};
