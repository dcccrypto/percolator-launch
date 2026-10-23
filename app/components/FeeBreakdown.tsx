"use client";

/**
 * Where a trading fee goes, rendered the same way for every audience.
 *
 * One component rather than four copies: the rate and its label already drifted
 * apart once (#2563), and the split is the part with four separate groups
 * reading it. `highlight` marks the row that audience cares about; everything
 * else stays visible, because the whole point is that a share only makes sense
 * against the others.
 *
 * All figures come from lib/fee-breakdown.ts, which derives them from the
 * SDK's FEE_SPLIT — nothing here restates a number.
 */

import { bpsPct } from "@/lib/format";
import { V22_COPY } from "@/lib/v22/copy";
import type { FC } from "react";
import {
  FEE_LEGS,
  STAKER_FEE_SHARE_BPS,
  legPercent,
  type FeeLeg,
} from "@/lib/fee-breakdown";

interface FeeBreakdownProps {
  /** Which row to emphasise for the reader. */
  highlight?: FeeLeg["id"] | "staker";
  /**
   * The market's own fee rate, if known. Shown above the split, because the
   * split divides it — and unlike the split it VARIES by market (#2563).
   */
  feeBps?: number | null;
  /** Render the staker row, which is 0% and easy to mistake for the insurance share. */
  showStaker?: boolean;
  /**
   * v2.2 fee-only stake pools: stakers are paid nothing while the market runs (V22_COPY.stake.closeOut.feeOnly), so
   * the Stakers row says that at 0% and the insurance leg doesn't promise them its share.
   */
  stakersFeeOnly?: boolean;
  className?: string;
}

export const FeeBreakdown: FC<FeeBreakdownProps> = ({
  highlight,
  feeBps,
  showStaker = false,
  stakersFeeOnly = false,
  className = "",
}) => {
  return (
    <div className={`text-[11px] ${className}`}>
      {feeBps != null && feeBps > 0 && (
        <p className="mb-2 text-[var(--text-secondary)]">
          This market charges{" "}
          <span className="font-mono tabular-nums text-[var(--text)]">{bpsPct(feeBps)}</span>{" "}
          per trade — set by the token&apos;s liquidity, so it
          differs between markets. Every market splits it the same way:
        </p>
      )}

      <ul className="space-y-1">
        {FEE_LEGS.map((leg) => {
          const on = highlight === leg.id;
          return (
            <li
              key={leg.id}
              className={`flex items-baseline justify-between gap-3 border-l-2 pl-2 ${
                on ? "border-[var(--accent)]" : "border-transparent"
              }`}
            >
              <span className={on ? "text-[var(--text)]" : "text-[var(--text-secondary)]"}>
                {leg.label}
                <span className="ml-1 text-[var(--text-muted)]">— {stakersFeeOnly && leg.id === "insurance" ? V22_COPY.stake.feeOnlyInsuranceLeg : leg.note}</span>
              </span>
              <span
                className={`shrink-0 font-mono tabular-nums ${
                  on ? "text-[var(--accent)]" : "text-[var(--text-secondary)]"
                }`}
              >
                {legPercent(leg)}%
              </span>
            </li>
          );
        })}

        {showStaker && (
          <li
            className={`flex items-baseline justify-between gap-3 border-l-2 pl-2 ${
              highlight === "staker" ? "border-[var(--accent)]" : "border-transparent"
            }`}
          >
            <span
              className={
                highlight === "staker" ? "text-[var(--text)]" : "text-[var(--text-secondary)]"
              }
            >
              Stakers
              <span className="ml-1 text-[var(--text-muted)]">
                {stakersFeeOnly ? (
                  <>— {V22_COPY.stake.feeOnlyStakersRow}</>
                ) : (
                  <>
                    — the insurance share above, paid into the stake pool automatically. Stakers
                    back that fund and take first loss.
                  </>
                )}
              </span>
            </span>
            <span className="shrink-0 font-mono tabular-nums text-[var(--text-secondary)]">
              {stakersFeeOnly ? 0 : STAKER_FEE_SHARE_BPS / 100}%
            </span>
          </li>
        )}
      </ul>
    </div>
  );
};
