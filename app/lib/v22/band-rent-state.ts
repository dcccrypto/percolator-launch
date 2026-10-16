/**
 * Band + holding-fee read model for a v2.2 market: a thin adapter over the SDK candidate's `abi/v22-band`
 * (percolator-sdk#406 @ adf8fd0; real-crate vectors live there). No offset or predicate is derived here any more:
 *  - state words:       `layout.bandRent` offsets via `readBandRentViewV22`;
 *  - lag predicate:     `assetPriceLaggedV22` (requires open interest on at least one side AND mark != target);
 *  - floor-stuck rule:  `bandFloorStuckV22`; favourable side as in `favourableCloseRefusedV22`;
 *  - rent rate:         `rentRateE9FailClosedV22`.
 * The app-facing names (`readBandRentView`, `closeBlockedByBand`, ...) are kept so the surfaces do not change.
 */
import { catchUpEstimate } from "@/lib/limits/catchup-estimate";
import {
  rentPercentPerDayV22,
  rentRateE9FailClosedV22,
  SLOTS_PER_DAY_V22,
  tryReadBandRentViewV22,
  usersSideOiQV22,
} from "./sdk";
import { lotExpOfMarketV22 } from "./sdk";

export { SLOTS_PER_DAY_V22 };

/** `growth_v19::rent_rate_e9_fail_closed`: per-slot rent rate, e9 of notional. */
export const rentRateE9 = rentRateE9FailClosedV22;
/** `users_side_oi_q`: a side's open interest without the vault LP's own leg. */
export const usersSideOi = usersSideOiQV22;
/** Percent of notional charged per day for a per-slot e9 rate (0.04 = 0.04%). */
export const rentPercentPerDay = rentPercentPerDayV22;

export interface BandRentView {
  assetIndex: number;
  /** Per-lot to per-token exponent (0 on a market without lots). */
  lotExp: number;
  band: {
    enabled: boolean;
    bandBps: number;
    epochSlots: bigint;
    pinSlots: bigint;
    maxPositionsPerSide: bigint;
    /** Minimum position size, collateral atoms (0 when the market has no band). */
    minLegNotionalAtoms: bigint;
    /** "Forced recovery after N minutes of keeper absence". */
    recoveryMinutes: number;
  };
  price: {
    /** `max_price_move_bps_per_slot`: how fast the effective price may walk toward the target (round i wait estimate). */
    capBpsPerSlot: bigint;
    /** Per-lot e6. */
    markE6: bigint;
    targetE6: bigint;
    /** The wrapper's lag predicate: the asset is EXPOSED (open interest on a side) and mark != target. */
    lagging: boolean;
    /** Mirror of `band_floor_stuck_view`: while stuck the wrapper does NOT refuse the favourable close. */
    floorStuck: boolean;
    /** The side whose CLOSE is refused (104) right now; null when none (not lagging, or floor-stuck). */
    favourableCloseSide: "long" | "short" | null;
  };
  rent: {
    enabled: boolean;
    maxE9PerSlot: bigint;
    kinkBps: number;
    /** Current per-slot rate per side, e9 of notional (0 while there is no bound vault / measured N_cap). */
    rateLongE9: bigint;
    rateShortE9: bigint;
  };
}

/** Band / rent view of asset `assetIndex`; null for anything that is not a v2.2 band / rent market (never throws). */
export function readBandRentView(data: Uint8Array | null | undefined, assetIndex = 0): BandRentView | null {
  const v = tryReadBandRentViewV22(data, assetIndex);
  if (!v || !data) return null;
  return {
    assetIndex,
    lotExp: lotExpOfMarketV22(data, assetIndex),
    band: {
      enabled: v.band.enabled,
      bandBps: v.config.bandBps,
      epochSlots: v.config.bandMaxEpochSlots,
      pinSlots: v.config.bandMaxPinSlots,
      maxPositionsPerSide: v.config.bandMaxPositionsPerSide,
      minLegNotionalAtoms: v.config.bandMinLegNotional,
      recoveryMinutes: v.band.recoveryMinutes,
    },
    price: { capBpsPerSlot: v.config.maxPriceMoveBpsPerSlot, markE6: v.price.markE6, targetE6: v.price.targetE6, lagging: v.price.lagging, floorStuck: v.price.floorStuck, favourableCloseSide: v.price.favourableCloseSide },
    rent: { enabled: v.rentRates.enabled, maxE9PerSlot: v.config.rentMaxE9PerSlot, kinkBps: v.rent.rentKinkBps, rateLongE9: v.rentRates.long, rateShortE9: v.rentRates.short },
  };
}

/** How long the price catch-up is estimated to last on a band market (ms; the gap between target and effective price over the per-slot cap); null = no estimate. */
export function bandCatchUpMs(view: BandRentView | null, slotMs?: number): number | null {
  if (!view || !view.band.enabled || !view.price.lagging) return null;
  const e = catchUpEstimate({ effectiveE6: view.price.markE6, targetE6: view.price.targetE6, capBpsPerSlot: view.price.capBpsPerSlot, slotMs });
  return e && e.ms > 0 ? e.ms : null;
}

/** Is this side's close refused right now by the band (104)? SDK rule: lagging, not floor-stuck, favourable side. */
export function closeBlockedByBand(view: BandRentView | null, positionSide: "long" | "short"): boolean {
  return !!view && view.price.lagging && !view.price.floorStuck && view.price.favourableCloseSide === positionSide;
}

/**
 * A leg whose notional is below HALF the market minimum can be closed by anyone (tag 118 sweep). `absQ` is the
 * position in engine Q (POS_SCALE per lot), `markE6` the per-lot mark; the engine compares q*price/POS_SCALE raw.
 */
export function legBelowHalfMin(absQ: bigint, markE6: bigint, minLegNotionalAtoms: bigint): boolean {
  if (minLegNotionalAtoms === 0n) return false;
  const notional = (absQ * markE6) / 1_000_000n;
  return notional * 2n < minLegNotionalAtoms;
}

/**
 * MIN-1: the REAL smallest order on a band market. The program checks the leg's notional (q * mark / POS_SCALE, in
 * collateral atoms) against `minLegNotionalAtoms`, and an order is whole lots (POS_SCALE_V22 = 1e6 Q per lot), so the
 * smallest valid leg is ceil(min / mark-per-lot) whole lots, which is more than the bare minimum whenever one lot is
 * worth more than a fraction of it (swordcat: min 100 USDC, one lot = 32.12 USDC -> 4 lots = 128.47 USDC; a 120 USDC
 * order rounds down to 3 lots = 96.35 and is refused 113). The copy, the notice and the pre-sign check all use this.
 */
export function bandMinLeg(view: BandRentView | null): { lots: bigint; minQ: bigint; notionalAtoms: bigint } | null {
  if (!view || !view.band.enabled || view.band.minLegNotionalAtoms <= 0n || view.price.markE6 <= 0n) return null;
  const lots = (view.band.minLegNotionalAtoms + view.price.markE6 - 1n) / view.price.markE6; // mark is per lot, atoms
  return { lots, minQ: lots * 1_000_000n, notionalAtoms: lots * view.price.markE6 };
}

/**
 * The program's exact minimum leg in Q: the smallest q with `floor(q * mark / POS_SCALE) >= band_min_leg_notional`, i.e.
 * `ceil(min * POS_SCALE / mark)` (fractional lots). This is what a CLIPPED fill is held to: the clip lands on any size, so a room of 2.82 lots
 * at 35.39 per lot (99.8 USDC) is refused 113 while 2.83 lots (100.2 USDC) lands; `bandMinLeg` above (whole lots) is the smallest ORDER the
 * user can type. Null when there is no band minimum or no price.
 */
export function bandMinLegExactQ(view: BandRentView | null): bigint | null {
  if (!view || !view.band.enabled || view.band.minLegNotionalAtoms <= 0n || view.price.markE6 <= 0n) return null;
  return (view.band.minLegNotionalAtoms * 1_000_000n + view.price.markE6 - 1n) / view.price.markE6;
}

/** Would an order of signed size `orderQ` on top of `existingQ` leave a non-zero leg under the minimum? (A full close to zero is fine.) */
export function legBelowBandMin(view: BandRentView | null, existingQ: bigint, orderQ: bigint): boolean {
  const min = bandMinLeg(view);
  if (!min) return false;
  const after = existingQ + orderQ;
  const abs = after < 0n ? -after : after;
  return abs !== 0n && abs < min.minQ;
}
