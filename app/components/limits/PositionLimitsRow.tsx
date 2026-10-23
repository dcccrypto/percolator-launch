"use client";

/**
 * P3 positions add-on (plan §2 P3-d): what skew funding this position pays or
 * receives per hour, and a liquidation-price drift warning when a day of the
 * current rate eats >= 10% of the margin above maintenance. Flag P3; renders
 * nothing when off, unbound, or the rate is 0.
 */
import { type FC } from "react";
import type { MarketLimits } from "@/hooks/useMarketLimits";
import { COPY } from "@/lib/limits/copy";
import { fundingPerHourAtoms, projectLiqDrift, vaultSkewRateE9 } from "@/lib/limits/vault-tranche";
import { formatTokenAmount } from "@/lib/format";
import { formatLotPriceE6 } from "@/lib/v22/lot";

export interface PositionLimitsRowProps {
  limits: MarketLimits;
  /** Effective signed position (base q). */
  positionQ: bigint;
  priceE6: bigint;
  /** Margin above the maintenance requirement, collateral atoms. */
  marginAboveMaintAtoms: bigint;
  decimals: number;
  collateralSymbol: string;
  /** v2.2 lot exponent: prices are per lot; the liquidation drift is shown per token. */
  lotExp?: number;
}

export const PositionLimitsRow: FC<PositionLimitsRowProps> = ({ limits, positionQ, priceE6, marginAboveMaintAtoms, decimals, collateralSymbol, lotExp = 0 }) => {
  if (!limits.flags.p3 || limits.state === "off" || !limits.engine || positionQ === 0n || priceE6 <= 0n) return null;
  const rate = vaultSkewRateE9(limits.vaultLp, limits.engine.oiEffLongQ, limits.engine.oiEffShortQ);
  if (rate === 0n) return null;
  const perHour = fundingPerHourAtoms(positionQ, priceE6, rate);
  const pays = perHour > 0n;
  const amt = `${formatTokenAmount(pays ? perHour : -perHour, decimals)} ${collateralSymbol}`;
  const drift = projectLiqDrift(positionQ, priceE6, rate, marginAboveMaintAtoms);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[10px]">
      <span
        data-testid="limits-position-funding"
        data-direction={pays ? "pay" : "receive"}
        className={pays ? "text-[var(--short)]" : "text-[var(--long)]"}
      >
        {pays ? COPY.fundingPay(amt) : COPY.fundingReceive(amt)}
      </span>
      {drift.warn && (
        <span data-testid="limits-liq-drift" className="text-[var(--warning)]">
          {COPY.liqDrift(formatLotPriceE6(drift.liqMoveE6, lotExp))}
        </span>
      )}
    </div>
  );
};
