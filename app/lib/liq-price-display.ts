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
import {
  computeMarginHealthPct,
  unliquidatableHealthThresholdPct,
} from "@/lib/margin-health";

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
  /** capital / nominal notional, or null when not computable. */
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
  const marginHealthPct = hasPosition
    ? computeMarginHealthPct(input.capital, input.positionSize, input.markPriceE6)
    : null;

  const unknown: LiqPriceDisplay = {
    kind: "unknown",
    text: unknownText,
    // Health needs neither an entry nor a liq price, so it can still be said
    // even when the price cannot. Tooltip only: the cell stays "unknown" and
    // must never read as safe (#2412).
    title:
      marginHealthPct != null
        ? `Liquidation price unavailable. Margin health ${marginHealthPct.toFixed(1)}% (collateral over position notional).`
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
    title: `No liquidation price: collateral is ${marginHealthPct.toFixed(1)}% of this position's notional, past the ${healthThresholdPct}% at which it cannot be liquidated by price. Withdrawing collateral below that brings a liquidation price back.`,
    marginHealthPct,
    healthThresholdPct,
  };
}
