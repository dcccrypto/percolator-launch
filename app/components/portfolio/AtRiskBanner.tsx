"use client";

import { useState } from "react";
import { LIQ_WARNING_PCT, type PortfolioPosition } from "@/hooks/usePortfolio";
import {
  collectLiquidationRisks,
  LiquidationRiskItem,
  riskKey,
  RiskCloseFlow,
  type LiquidationRisk,
} from "@/components/portfolio/LiquidationRiskItem";

interface AtRiskBannerProps {
  /** Open positions only — flat/idle deposits are skipped, but the caller should filter
   *  to positions with a nonzero size for a cheaper pass. */
  positions: PortfolioPosition[];
  /** Live marks by slab (useLiveSlabPrices), so the strip shows the same figure as the cards.
   *  Without it the strip falls back to the poll's price. */
  livePrices?: ReadonlyMap<string, bigint>;
  /** Collateral decimals per position, for the close modal (default 6). */
  decimalsOf?: (pos: PortfolioPosition) => number;
  /** Called after a position is closed from here (e.g. to refresh the portfolio). */
  onClosed?: () => void;
}

/**
 * Every position within liquidation-warning distance (see `getLiquidationSeverity`:
 * "warning" <= LIQ_WARNING_PCT, "danger" <= LIQ_DANGER_PCT), closest first, each with
 * Go to market and Close. Renders `null` (zero height) when nothing is at risk.
 */
export function AtRiskBanner({ positions, livePrices, decimalsOf, onClosed }: AtRiskBannerProps) {
  const [closing, setClosing] = useState<LiquidationRisk | null>(null);
  const risks = collectLiquidationRisks(positions, livePrices, decimalsOf);
  const closeFlow = closing && (
    <RiskCloseFlow
      risk={closing}
      onDone={(closed) => {
        setClosing(null);
        if (closed) onClosed?.();
      }}
    />
  );
  const danger = risks.some((r) => r.severity === "danger");

  // The close flow keeps the same place in the tree whether or not the list renders: a
  // remount would reset useClosePosition's in-flight guard mid-close.
  return (
    <>
      {risks.length > 0 && (
        <section className="mb-6" aria-label="Positions near liquidation">
          <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span
              className="inline-block h-1.5 w-1.5 translate-y-[-1px] rounded-full"
              style={{ background: danger ? "var(--short)" : "var(--warning)" }}
              aria-hidden
            />
            <h2 className="whitespace-nowrap text-[12px] font-medium text-[var(--text)]">
              {danger ? "Liquidation risk" : "Approaching liquidation"}
            </h2>
            <span className="text-[11px] text-[var(--text-secondary)]">
              {risks.length === 1 ? "1 position" : `${risks.length} positions`} within {LIQ_WARNING_PCT}% of
              liquidation
            </span>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {risks.map((risk) => (
              <LiquidationRiskItem key={riskKey(risk.pos)} risk={risk} onClose={() => setClosing(risk)} />
            ))}
          </div>
        </section>
      )}
      {closeFlow}
    </>
  );
}
