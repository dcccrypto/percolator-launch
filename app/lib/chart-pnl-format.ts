/**
 * Pure presentation helpers for the ChartPnlBadge.
 *
 * The math (computeMarkPnl, computePnlPercent) lives in `@percolatorct/sdk`
 * and is already covered by `__tests__/lib/phantom-position-pnl.test.ts`.
 * This module owns ONLY the string formatting + sign classification so the
 * badge can be tested without mocking hooks.
 */

/** Sign classification for visual styling. `"zero"` exists so callers can
 *  render "$0.00 (0%)" without forcing a colour choice — green/red on a
 *  dead-flat position would imply movement that isn't there. */
export type PnlSign = "positive" | "negative" | "zero";

export interface FormattedPnl {
  /** "+$120.50 (+8.4%)" / "-$15.00 (-1.2%)" / "$0.00 (0.0%)" */
  display: string;
  sign: PnlSign;
}

/** Format a USD PnL + ROE percentage into a single human-readable string and
 *  classify the sign. Used by the chart's floating PnL badge.
 *
 *  Conventions:
 *  - Two decimal places for both USD and percent (matches existing
 *    PositionPanel formatting).
 *  - Explicit `+` sign on positive values (`+$120.50` reads as profit at a
 *    glance vs. an unsigned `$120.50` that could be either).
 *  - Negative values get the standard `-` from `toFixed`; we don't double-sign.
 *  - Sub-cent values round to "$0.00" but the sign still classifies based on
 *    the raw input — a near-zero loss should still render red. */
export function formatPnl(pnlUsd: number, roePercent: number): FormattedPnl {
  const sign: PnlSign = pnlUsd > 0 ? "positive" : pnlUsd < 0 ? "negative" : "zero";

  const usdAbs = Math.abs(pnlUsd).toFixed(2);
  const usdStr = sign === "positive" ? `+$${usdAbs}` : sign === "negative" ? `-$${usdAbs}` : `$${usdAbs}`;

  const pctAbs = Math.abs(roePercent).toFixed(2);
  const pctStr = sign === "positive" ? `+${pctAbs}%` : sign === "negative" ? `-${pctAbs}%` : `${pctAbs}%`;

  return { display: `${usdStr} (${pctStr})`, sign };
}
