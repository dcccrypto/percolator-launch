"use client";

/**
 * v2.2 QA M-1: what an OPEN order on this market is subject to, shown in OPEN mode (it was only visible in CLOSE mode,
 * and the holding fee only once a position was held): why the ticket is disabled when it is, the price protection
 * (band), the minimum position size and the holding fee for the selected side. One calm line each; renders nothing
 * on a market with none of them (the caller gates on the v2.2 flag through the view / guard it passes).
 */
import type { FC } from "react";
import { BandMarketNotice } from "./BandMarketNotice";
import { holdingFeeLabel } from "./HoldingFeeChip";
import { V22_COPY } from "@/lib/v22/copy";
import type { BandRentView } from "@/lib/v22/band-rent-state";

export interface OpenModeMarketNotesProps {
  /** useLotTradingGuard: why OPEN is disabled on this market, or null. */
  lotGuard: string | null;
  view: BandRentView | null;
  side: "long" | "short";
  collateralDecimals: number;
  collateralSymbol: string;
}

/** "Price protection ±1.3%". */
export const bandLabel = (view: BandRentView | null): string | null =>
  view && view.band.enabled && view.band.bandBps > 0 ? `Price protection ±${(view.band.bandBps / 100).toFixed(view.band.bandBps % 100 === 0 ? 0 : 1)}%` : null;

export const OpenModeMarketNotes: FC<OpenModeMarketNotesProps> = ({ lotGuard: guard, view, side, collateralDecimals, collateralSymbol }) => {
  // The "exponent not read yet" guard is a brief loading state, not a reason: only a definitive refusal is shown here.
  const lotGuard = guard === V22_COPY.lot.unitsUnknown ? null : guard;
  const band = bandLabel(view);
  const fee = holdingFeeLabel(view, side);
  if (!lotGuard && !band && !fee && !(view && view.band.enabled)) return null;
  return (
    <div data-testid="open-mode-market-notes" className="mb-3">
      {lotGuard && (
        <p data-testid="lot-trading-guard-open" role="status" className="mb-1 text-[11px] text-[var(--text)]">
          {lotGuard}
        </p>
      )}
      {band && (
        <p data-testid="band-open" title={V22_COPY.wizard.protectionHint} className="text-[10px] text-[var(--text-secondary)]">
          {band}
        </p>
      )}
      <BandMarketNotice view={view} collateralDecimals={collateralDecimals} collateralSymbol={collateralSymbol} />
      {fee && (
        <p data-testid="holding-fee-open" title={V22_COPY.rent.hint} className="text-[10px] text-[var(--text-secondary)]">
          {fee}
        </p>
      )}
    </div>
  );
};
