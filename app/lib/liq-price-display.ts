/**
 * The ONE way a liquidation price reaches a trader's screen.
 *
 * #2558 found that a per-position liquidation price is not the whole story on
 * a cross-margin engine: all collateral in the slab account backs every
 * position in it, so the price is either absent (collateral covers the
 * position at any mark) or only the account's real liquidation price when that
 * position is the only one. Where it is absent, the surface must show the risk
 * number that still exists — margin health (lib/margin-health.ts) — never a
 * bare "—", "N/A" or "∞".
 *
 * #2558 fixed four surfaces by inlining the same ternary four times, and its
 * test enumerated those four by hand, so a fifth surface was invisible to it
 * (#2634). This module is the structural fix: every component that renders a
 * liquidation price derives its text from `describeLiqPrice`, and
 * `__tests__/components/margin-health-surfaces.test.ts` DISCOVERS such
 * components by scanning the tree rather than trusting a list.
 */

import { formatLiqPrice, LIQ_PRICE_UNLIQUIDATABLE } from "@/lib/format";
import { computeLiquidationDistancePct } from "@/lib/liquidation-distance";
import {
  computeMarginHealthPct,
  unliquidatableHealthThresholdPct,
} from "@/lib/margin-health";
import { computeMarkPnlLinear } from "@/lib/trading";

export type LiqPriceDisplayKind =
  /** A real liquidation price exists and is shown. */
  | "price"
  /** No price liquidates the position at its collateral; health is shown. */
  | "covered"
  /** Not computable (no position / entry / mark) — never presented as safe. */
  | "unknown";

export interface LiqPriceDisplay {
  kind: LiqPriceDisplayKind;
  /** What to render in the value cell. */
  text: string;
  /** Explanatory tooltip, when there is something to explain. */
  title: string | undefined;
  /** equity (capital + unrealized PnL) / nominal notional, or null when not computable. */
  marginHealthPct: number | null;
  /** Health at/above which a long has no liquidation price (100: engine model, any mm). */
  healthThresholdPct: number;
}

export interface LiqPriceDisplayInput {
  /** From computeLiqPrice / the portfolio hook. 0n = none, u64::MAX = none (short). */
  liqPriceE6: bigint | null | undefined;
  /** NOMINAL signed position size (not ADL-reduced exposure). 0/null = no position. */
  positionSize: bigint | number | null | undefined;
  /** Collateral backing the position (the slab account's capital). */
  capital: bigint | number | null | undefined;
  /**
   * The entry and ADL-effective signed size the liquidation price was computed
   * with; margin health adds their PnL at the mark to capital. Required so no
   * surface can fall back to capital alone by omission (S7). null = unknown.
   */
  entryPriceE6: bigint | null;
  effectiveSize: bigint | null;
  /** Equity PnL already on-chain, used only when there is no entry (AccountsCard on v17). */
  onChainPnl?: bigint | null;
  /** Live mark, e6. Without it health is undefined and nothing is claimed. */
  markPriceE6: bigint | number | null | undefined;
  maintenanceMarginBps: bigint | number;
  /**
   * Whether an entry price resolved. `computeLiqPrice` returns 0n both for
   * "collateral covers it" and for "no entry known"; only a resolved entry
   * makes the zero a statement about the position (see lib/liquidation-state).
   */
  hasResolvedEntry: boolean;
  /** Price formatter; defaults to formatLiqPrice's USD formatting. */
  formatPrice?: (priceE6: bigint) => string;
  /** Text for the unknown case. Default "N/A" (formatLiqPrice's). */
  unknownText?: string;
}

const isNonZero = (v: bigint | number | null | undefined): boolean =>
  v != null && v !== 0 && v !== 0n;

export function describeLiqPrice(input: LiqPriceDisplayInput): LiqPriceDisplay {
  const healthThresholdPct = unliquidatableHealthThresholdPct(input.maintenanceMarginBps);
  const unknownText = input.unknownText ?? "N/A";
  const hasPosition = isNonZero(input.positionSize);
  // PnL from the entry and effective size the liquidation price was solved with, so
  // health and the price agree on whether the position is covered. On the "unknown"
  // path callers pass the anchor mark as entry, so this is the move since then (#2673
  // below). No entry or no effective size: the caller's on-chain pnl if it has one,
  // else capital alone.
  const m = input.markPriceE6;
  const mark = typeof m === "bigint" ? m : typeof m === "number" && Number.isFinite(m) ? BigInt(Math.trunc(m)) : null;
  const pnlAtoms =
    input.entryPriceE6 != null && input.entryPriceE6 > 0n && input.effectiveSize != null && mark != null
      ? computeMarkPnlLinear(input.effectiveSize, input.entryPriceE6, mark)
      : (input.onChainPnl ?? 0n);
  const marginHealthPct = hasPosition
    ? computeMarginHealthPct(input.capital, input.positionSize, input.markPriceE6, pnlAtoms)
    : null;

  const unknown: LiqPriceDisplay = {
    kind: "unknown",
    text: unknownText,
    // Health needs no liq price (and falls back to capital without an entry), so it can still be said
    // even when the price cannot. Tooltip only: the cell stays "unknown" and
    // must never read as safe (#2412).
    title:
      marginHealthPct != null
        ? `Liquidation price unavailable. Margin health ${marginHealthPct.toFixed(1)}% (equity over position notional).`
        : undefined,
    marginHealthPct,
    healthThresholdPct,
  };
  if (!hasPosition || input.liqPriceE6 == null) return unknown;

  const liq = input.liqPriceE6;
  // A real price is shown even when `hasResolvedEntry` is false — deliberately
  // (#2673 item 3). A liquidation price is an EQUITY statement (capital + pnl
  // vs maintenance), not an entry-attribution one: on the "unknown" path the
  // on-chain pnl is 0 because the loss was crystallized OUT of capital, so
  // (entry = mark, capital) is the same equity reference a derived entry gives
  // (derived E = mark − pnl/size with the pre-crystallization capital) — see
  // __tests__/lib/liq-price-unknown-entry.test.ts. Hiding it would drop the
  // one risk number that is still right from exactly the positions that have
  // been losing. Only the ZERO/sentinel claim below needs a resolved entry.
  if (liq > 0n && liq < LIQ_PRICE_UNLIQUIDATABLE) {
    const format = input.formatPrice ?? ((e6: bigint) => formatLiqPrice(e6));
    return {
      kind: "price",
      text: format(liq),
      title:
        marginHealthPct != null
          ? `Margin health ${marginHealthPct.toFixed(1)}%. All collateral in this account backs every position in it, so this price is only exact when this is your only position.`
          : undefined,
      marginHealthPct,
      healthThresholdPct,
    };
  }

  // liq <= 0n (long clamp) or the u64::MAX short sentinel: no price exists —
  // but only a resolved entry AND a mark make that a claim about safety.
  const sentinel = liq >= LIQ_PRICE_UNLIQUIDATABLE;
  if ((!sentinel && !input.hasResolvedEntry) || marginHealthPct == null) return unknown;

  return {
    kind: "covered",
    text: `${marginHealthPct.toFixed(0)}% mgn`,
    // Under ADL the price is solved on the reduced size while health divides by the
    // nominal one, so a covered leg can read under the line: do not claim it is past it.
    title:
      marginHealthPct >= healthThresholdPct
        ? `No liquidation price: equity (collateral plus unrealized PnL) is ${marginHealthPct.toFixed(1)}% of this position's notional, past the ${healthThresholdPct}% at which it cannot be liquidated by price. Withdrawing collateral below that brings a liquidation price back.`
        : `No liquidation price at this position's ADL-reduced size. Equity (collateral plus unrealized PnL) is ${marginHealthPct.toFixed(1)}% of its full notional.`,
    marginHealthPct,
    healthThresholdPct,
  };
}

/**
 * The small "5.3% to liq" line under a liquidation price: how far the mark is
 * from it, with the same directional distance (and denominators) as the
 * portfolio card's "Liquidation Distance" (computeLiquidationDistancePct).
 *
 * Only under a REAL price (`kind: "price"`) with a live mark. The covered
 * ("% mgn") and unknown cells get nothing: computeLiquidationDistancePct's
 * finite fallback must never be printed as a distance, because a missing risk
 * number is not evidence of safety (#2412). A crossed price reads 0.0%.
 */
export function describeLiqDistance(
  display: LiqPriceDisplay,
  positionSize: bigint,
  markPriceE6: bigint | null | undefined,
  liqPriceE6: bigint | null | undefined,
): string | null {
  if (display.kind !== "price" || markPriceE6 == null || liqPriceE6 == null) return null;
  const pct = computeLiquidationDistancePct(positionSize, markPriceE6, liqPriceE6, Number.NaN);
  return Number.isFinite(pct) ? `${pct.toFixed(1)}% to liq` : null;
}
