/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk @ adf8fd0 (draft dcccrypto/percolator-sdk#406, sdk 9.0.0-candidate) + prog#572 occupancy from percolator-sdk#441 @ 667cbb1,
 * src/abi/v22-band.ts. Only the imports are retargeted (the installed @percolatorct/sdk 8.0.0 root, the v2.1 txv1 port, and the sibling v22 ports).
 * Delete when @percolatorct/sdk >= 9.0.0 ships and point ./index.ts at the package. Do not edit here; fix upstream in percolator-sdk.
 */
/**
 * Band and holding-rent STATE: decoders for the config band / rent words, the asset band words, the growth record's
 * rent fields and the vault LP record, the rent-rate math, and the wrapper's favourable-close rule (with the
 * floor-stuck exemption).
 *
 * Offsets come from {@link LayoutTable.bandRent} (one table) and are pinned against the real crate (rustc
 * `offset_of!` on `V16ConfigAccount`, `AssetStateV16Account`, `AssetGrowthV19`, `AssetVaultLpV18`) by
 * `test/fixtures/v22-band-parity.json`. The pure rules (`rent_rate_e9`, `rent_rate_e9_fail_closed`, `users_side_oi_q`,
 * `band_width_ok`) are run against the same crate. The two predicate compositions, `asset_price_lagged_view` and
 * `reject_band_favourable_close_view`, are views over the group, so they are ported from the wrapper source
 * (`v16_program.rs` `asset_price_lagged_view`, `band_floor_stuck_view`, `reject_band_favourable_close_view`) and
 * covered by truth-table tests citing it.
 *
 * prog#572 (#647, rc23 34996503): band markets also charge a flat per-SLOT occupancy fee per leg past 85% of
 * `band_max_positions_per_side` (`growth_v19::occ_*`, ported below and pinned row-for-row by the same fixture), on top of
 * the per-notional utilisation rent ({@link rentRatesFromStateV22} stays utilisation-only, as `rent_rates_view` is).
 *
 * Note vs. earlier app code: the wrapper's lag predicate is "EXPOSED (open interest on either side) AND mark != target";
 * an unexposed asset is never lagged.
 *
 * @module v22-band
 */
import { LAYOUTS_BY_VERSION, resolveMarketGeometry, UnknownLayoutError } from "./layout";
import type { BandRentOffsets, LayoutTable } from "./layout";
import { SLOTS_PER_YEAR_V22, forcedRecoveryMinutesV22 } from "./v22-wire";
import { bandWidthOkV22 } from "./v22-math";

const BPS = 10_000n;
const dv = (d: Uint8Array): DataView => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u64 = (d: Uint8Array, o: number): bigint => dv(d).getBigUint64(o, true);
const u16 = (d: Uint8Array, o: number): number => dv(d).getUint16(o, true);
const u128 = (d: Uint8Array, o: number): bigint => (dv(d).getBigUint64(o + 8, true) << 64n) | dv(d).getBigUint64(o, true);
const i128 = (d: Uint8Array, o: number): bigint => (dv(d).getBigInt64(o + 8, true) << 64n) + dv(d).getBigUint64(o, true);

/** Slots per day at 400 ms slots (`SLOTS_PER_YEAR / 365`). */
export const SLOTS_PER_DAY_V22 = Number(SLOTS_PER_YEAR_V22 / 365n);

// ---------------------------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------------------------

/**
 * `growth_v19::rent_rate_e9`: per-slot rent rate in e9 of notional. `null` on `n_cap == 0`, a kink above 100% or overflow.
 *
 * @param usersOiSideQ  Users' open interest on the side.
 * @param nCapQ         `rent_n_cap_q`.
 * @param kinkBps       `rent_kink_bps`.
 * @param maxE9PerSlot  `rent_max_e9_per_slot`.
 * @returns Rate, or `null`.
 * @example
 * ```ts
 * rentRateE9V22(900n, 1000n, 5000, 100n); // ceil(100 * (9000 - 5000) / 5000) = 80n
 * ```
 */
export function rentRateE9V22(usersOiSideQ: bigint, nCapQ: bigint, kinkBps: number, maxE9PerSlot: bigint): bigint | null {
  if (nCapQ === 0n || BigInt(kinkBps) > BPS) return null;
  const lhs = usersOiSideQ * BPS;
  const rhs = BigInt(kinkBps) * nCapQ;
  const U128 = (1n << 128n) - 1n;
  if (lhs > U128 || rhs > U128) return null;
  if (lhs <= rhs || maxE9PerSlot === 0n) return 0n;
  if (usersOiSideQ >= nCapQ) return maxE9PerSlot;
  const den = nCapQ * (BPS - BigInt(kinkBps));
  const num = maxE9PerSlot * (lhs - rhs);
  if (den > U128 || num > U128) return null;
  const r = num / den + (num % den !== 0n ? 1n : 0n);
  return r > maxE9PerSlot ? maxE9PerSlot : r;
}

/**
 * `rent_rate_e9_fail_closed`: `rentRateE9V22` or the ceiling when it is `null` (overflow must not switch rent off).
 *
 * @param usersOiSideQ  Users' open interest on the side.
 * @param nCapQ         `rent_n_cap_q`.
 * @param kinkBps       `rent_kink_bps`.
 * @param maxE9PerSlot  `rent_max_e9_per_slot`.
 * @returns Rate.
 * @example
 * ```ts
 * rentRateE9FailClosedV22(1n, 0n, 0, 77n); // 77n
 * ```
 */
export function rentRateE9FailClosedV22(usersOiSideQ: bigint, nCapQ: bigint, kinkBps: number, maxE9PerSlot: bigint): bigint {
  return rentRateE9V22(usersOiSideQ, nCapQ, kinkBps, maxE9PerSlot) ?? maxE9PerSlot;
}

/**
 * `growth_v19::users_side_oi_q`: the side's open interest without the vault LP's own leg.
 *
 * @param oiSideQ     Side open interest.
 * @param vaultLpEffQ Vault LP net position (signed).
 * @param longSide    `true` for the long side.
 * @returns Users' open interest.
 * @example
 * ```ts
 * usersSideOiQV22(100n, 30n, true); // 70n
 * ```
 */
export function usersSideOiQV22(oiSideQ: bigint, vaultLpEffQ: bigint, longSide: boolean): bigint {
  const onSide = longSide ? vaultLpEffQ > 0n : vaultLpEffQ < 0n;
  if (!onSide) return oiSideQ;
  const abs = vaultLpEffQ < 0n ? -vaultLpEffQ : vaultLpEffQ;
  return oiSideQ > abs ? oiSideQ - abs : 0n;
}

/**
 * Rent as a percent of notional per day for a per-slot e9 rate (0.04 = 0.04%).
 *
 * @param rateE9PerSlot  Rate.
 * @returns Percent per day.
 * @example
 * ```ts
 * rentPercentPerDayV22(100n);
 * ```
 */
export function rentPercentPerDayV22(rateE9PerSlot: bigint): number {
  return (Number(rateE9PerSlot) / 1e9) * SLOTS_PER_DAY_V22 * 100;
}

// ---------------------------------------------------------------------------------------------
// prog#572: per-slot occupancy charge (growth_v19.rs @ 34996503)
// ---------------------------------------------------------------------------------------------

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const OCC_E9 = 1_000_000_000n;

/** `RENT_OCC_KNEE_BPS`: at or below 85% of the side cap a side pays no occupancy charge. */
export const RENT_OCC_KNEE_BPS_V22 = 8_500;
/** `RENT_OCC_CAP_DOMAIN`: past the knee a cap above 2^16 fails closed to the full charge. */
export const RENT_OCC_CAP_DOMAIN_V22 = 1n << 16n;
/** `OCC_RAMP_ONE`: the Q32 ramp of a full side. */
export const OCC_RAMP_ONE_V22 = 1n << 32n;
/** `OCC_REF_MIN_LEG_MULTIPLE`: the reference leg of `F_full`, in multiples of `band_min_leg_notional` (the tag-119 bound). */
export const OCC_REF_MIN_LEG_MULTIPLE_V22 = 4n;
/** `OCC_BSL_RENT_MULTIPLE`: InitMarket validates the Band Safety Law at `rent_max * 5` on band markets (else 106). */
export const OCC_BSL_RENT_MULTIPLE_V22 = 5n;
/** `OCC_CK_TAG`: bit 63 of a portfolio's `last_fee_slot` marks an occupancy checkpoint (band markets, while Live). */
export const OCC_CK_TAG_V22 = 1n << 63n;

/**
 * `growth_v19::occ_ramp`: the occupancy ramp scaled to `max`. 0 when `cap == 0` or `max == 0` or at / below the knee;
 * past it `ceil(max * x^2)` with `x = (o - k) / (1 - k)`, clamped to `1..=max`; `max` at a full side or a cap above
 * {@link RENT_OCC_CAP_DOMAIN_V22}. Inputs are u64 (`count`, `cap`, `max`).
 *
 * @param count  Stored positions on the side (`stored_pos_count_*`).
 * @param cap    `band_max_positions_per_side` (0 = band off).
 * @param max    Scale (`OCC_RAMP_ONE` for the Q32 ramp).
 * @returns The ramp, `0..=max`.
 * @example
 * ```ts
 * occRampV22(256n, 256n, 100n); // 100n (full side)
 * occRampV22(217n, 256n, 100n); // 0n (217 / 256 < 85%)
 * ```
 */
export function occRampV22(count: bigint, cap: bigint, max: bigint): bigint {
  if (cap === 0n || max === 0n) return 0n;
  const c = count < cap ? count : cap;
  const lhs = c * BPS;
  const knee = cap * BigInt(RENT_OCC_KNEE_BPS_V22);
  if (lhs <= knee) return 0n;
  if (c >= cap || cap > RENT_OCC_CAP_DOMAIN_V22) return max;
  const ex = lhs - knee;
  const span = cap * (BPS - BigInt(RENT_OCC_KNEE_BPS_V22));
  const ex2 = ex * ex;
  const span2 = span * span;
  if (ex2 > U128_MAX || span2 > U128_MAX) return max;
  const num = max * ex2;
  if (num > U128_MAX) return max; // mul_div_ceil_u128 -> None -> fail closed
  const r = num / span2 + (num % span2 !== 0n ? 1n : 0n);
  if (r < max) return r > 1n ? r : 1n;
  return max;
}

/**
 * `growth_v19::occ_ramp_q32`: `occRampV22(count, cap, 2^32)`.
 *
 * @param count  Stored positions on the side.
 * @param cap    `band_max_positions_per_side`.
 * @returns Q32 ramp (`2^32` = a full side).
 * @example
 * ```ts
 * occRampQ32V22(256n, 256n); // 4294967296n
 * ```
 */
export function occRampQ32V22(count: bigint, cap: bigint): bigint {
  return occRampV22(count, cap, OCC_RAMP_ONE_V22);
}

/**
 * `growth_v19::occ_full_num`: `F_full * 1e9` = `rent_max * 4 * band_min_leg_notional` (saturating u128): atoms x 1e9 one leg pays
 * per slot at a full side.
 *
 * @param rentMaxE9PerSlot     `rent_max_e9_per_slot`.
 * @param bandMinLegNotional   `band_min_leg_notional` (collateral atoms).
 * @returns `F_full * 1e9`.
 * @example
 * ```ts
 * occFullNumV22(100n, 10_000_000n); // 4_000_000_000n = 4 atoms per slot at a full side
 * ```
 */
export function occFullNumV22(rentMaxE9PerSlot: bigint, bandMinLegNotional: bigint): bigint {
  const a = rentMaxE9PerSlot * OCC_REF_MIN_LEG_MULTIPLE_V22;
  const sa = a > U128_MAX ? U128_MAX : a;
  const b = sa * bandMinLegNotional;
  return b > U128_MAX ? U128_MAX : b;
}

/**
 * `growth_v19::occ_clock_advance`: `C + min(ramp, 2^32) * dt` (Q32.32 full-occupancy slots), saturating at u64::MAX.
 *
 * @param cQ32     Side clock.
 * @param rampQ32  Side ramp ({@link occRampQ32V22}).
 * @param dt       Slots.
 * @returns The advanced clock.
 * @example
 * ```ts
 * occClockAdvanceV22(0n, 1n << 32n, 10n); // 10n << 32n
 * ```
 */
export function occClockAdvanceV22(cQ32: bigint, rampQ32: bigint, dt: bigint): bigint {
  const r = rampQ32 < OCC_RAMP_ONE_V22 ? rampQ32 : OCC_RAMP_ONE_V22;
  const next = cQ32 + r * dt;
  return next > U64_MAX ? U64_MAX : next;
}

/**
 * `growth_v19::occ_ck_encode`: the checkpoint word `TAG | (cInt & u32::MAX) << 1 | short`.
 *
 * @param cInt   Clock integer part (`C >> 32`).
 * @param short  Leg side.
 * @returns The `last_fee_slot` word.
 * @example
 * ```ts
 * occCkEncodeV22(5n, true); // (1n << 63n) | 11n
 * ```
 */
export function occCkEncodeV22(cInt: bigint, short: boolean): bigint {
  return OCC_CK_TAG_V22 | ((cInt & 0xffff_ffffn) << 1n) | (short ? 1n : 0n);
}

/**
 * `growth_v19::occ_ck_decode`: the clock integer a checkpoint holds when it is a checkpoint of THIS side not ahead of the clock.
 *
 * @param ck        `last_fee_slot`.
 * @param short     Leg side.
 * @param cIntNow   Current clock integer part.
 * @returns The clock integer, or `null` (untagged, other side, or ahead).
 * @example
 * ```ts
 * occCkDecodeV22(occCkEncodeV22(5n, false), false, 9n); // 5n
 * ```
 */
export function occCkDecodeV22(ck: bigint, short: boolean, cIntNow: bigint): bigint | null {
  if ((ck & OCC_CK_TAG_V22) === 0n || ((ck & 1n) === 1n) !== short) return null;
  const c = (ck & ~OCC_CK_TAG_V22) >> 1n;
  return c > cIntNow ? null : c;
}

/**
 * `growth_v19::occ_charge_step`: one charge of a leg, `{ checkpoint, due }`. A word that is not this leg's checkpoint
 * re-anchors at the clock and charges 0; otherwise `due = floor(fullNum * (C_now - C_ck) / 1e9)` (a zero due keeps the
 * old checkpoint so the fraction carries).
 *
 * @param ck        `last_fee_slot`.
 * @param short     Leg side.
 * @param cQ32Now   The side clock now (Q32.32).
 * @param fullNum   {@link occFullNumV22}.
 * @returns New checkpoint and atoms due (before the engine's capital clamp).
 * @example
 * ```ts
 * occChargeStepV22(occCkEncodeV22(0n, false), false, 10n << 32n, 4_000_000_000n); // { checkpoint: occCkEncodeV22(10n, false), due: 40n }
 * ```
 */
export function occChargeStepV22(ck: bigint, short: boolean, cQ32Now: bigint, fullNum: bigint): { checkpoint: bigint; due: bigint } {
  const cNow = cQ32Now >> 32n;
  const fresh = occCkEncodeV22(cNow, short);
  const c0 = occCkDecodeV22(ck, short, cNow);
  if (c0 === null) return { checkpoint: fresh, due: 0n };
  const p = fullNum * (cNow - c0);
  const due = (p > U128_MAX ? U128_MAX : p) / OCC_E9;
  return due === 0n ? { checkpoint: ck, due: 0n } : { checkpoint: fresh, due };
}

/**
 * Read a portfolio's `last_fee_slot` as a prog#572 occupancy checkpoint. On band markets, while Live, the word is
 * `TAG(bit 63) | clockInt << 1 | short` once the account holds a leg; anywhere else it is a real slot (or 0) and this
 * returns `null`. A tagged value is NOT a slot: never compare it with a clock slot.
 *
 * @param lastFeeSlot  The portfolio's `last_fee_slot` (`PortfolioV17.lastFeeSlot`).
 * @returns `{ short, clockInt }`, or `null` for an untagged word.
 * @example
 * ```ts
 * decodeOccupancyCheckpointV22(pf.lastFeeSlot); // { short: false, clockInt: 12n } on a band market leg
 * ```
 */
export function decodeOccupancyCheckpointV22(lastFeeSlot: bigint): { short: boolean; clockInt: bigint } | null {
  if ((lastFeeSlot & OCC_CK_TAG_V22) === 0n) return null;
  return { short: (lastFeeSlot & 1n) === 1n, clockInt: (lastFeeSlot & ~OCC_CK_TAG_V22 & U64_MAX) >> 1n };
}

/** A band market's per-side occupancy clocks (asset-0 profile +408..+432). */
export interface OccupancyClocksV22 {
  /** Slot of the last accrual (`maintenance_fee_checkpoint_slot` bytes). 0 = never accrued. */
  lastSlot: bigint;
  /** `C_long`, Q32.32 full-occupancy slots (low 8 B of `maintenance_fee_previous_rate`). */
  longQ32: bigint;
  /** `C_short` (high 8 B). */
  shortQ32: bigint;
}

/**
 * Reinterpret an asset-0 oracle profile's GH#444 fields on a band market: there `maintenanceFeeCheckpointSlot` is the
 * occupancy clocks' last slot and `maintenanceFeePreviousRate` packs `C_long | C_short << 64`. Only meaningful when the
 * market's `band_bps != 0` (a band market's maintenance fee is always 0, so the bytes are never a fee checkpoint there).
 *
 * @param p  `{ maintenanceFeeCheckpointSlot, maintenanceFeePreviousRate }` from `parseAssetOracleProfileV17` (asset 0).
 * @returns The clocks.
 * @example
 * ```ts
 * if (cfg.bandBps !== 0) occupancyClocksFromProfileV22(parseAssetOracleProfileV17(data, off));
 * ```
 */
export function occupancyClocksFromProfileV22(p: { maintenanceFeeCheckpointSlot: bigint; maintenanceFeePreviousRate: bigint }): OccupancyClocksV22 {
  return { lastSlot: p.maintenanceFeeCheckpointSlot, longQ32: p.maintenanceFeePreviousRate & U64_MAX, shortQ32: (p.maintenanceFeePreviousRate >> 64n) & U64_MAX };
}

/** Inputs of the occupancy clock / charge mirror. */
export interface OccupancyParamsV22 {
  /** `band_max_positions_per_side` (0 when the band is off). */
  cap: bigint;
  /** {@link occFullNumV22} of the config. */
  fullNum: bigint;
  /** A vault LP is bound on asset 0 (the charge's destination; without one the clocks are frozen). */
  lpBound: boolean;
  /** `stored_pos_count_long` / `_short` (the counts in force since `lastSlot`). */
  countLong: bigint;
  countShort: bigint;
}

/**
 * Mirror of `occ_clock_accrue_view`: the clocks brought to `nowSlot` with the counts as they stand. Only the slot moves
 * when rent is off, no vault LP is bound, or the clocks were never stamped (`lastSlot == 0`); nothing moves when
 * `nowSlot <= lastSlot`. (The program accrues only on a Live band market.)
 *
 * @param clocks   Stored clocks.
 * @param p        Params.
 * @param nowSlot  Slot of the touch.
 * @returns The clocks the next touch would write.
 * @example
 * ```ts
 * occupancyClocksAtV22(clocks, params, currentSlot);
 * ```
 */
export function occupancyClocksAtV22(clocks: OccupancyClocksV22, p: OccupancyParamsV22, nowSlot: bigint): OccupancyClocksV22 {
  if (nowSlot <= clocks.lastSlot) return clocks;
  let { longQ32, shortQ32 } = clocks;
  if (clocks.lastSlot !== 0n && p.fullNum !== 0n && p.lpBound) {
    const dt = nowSlot - clocks.lastSlot;
    longQ32 = occClockAdvanceV22(longQ32, occRampQ32V22(p.countLong, p.cap), dt);
    shortQ32 = occClockAdvanceV22(shortQ32, occRampQ32V22(p.countShort, p.cap), dt);
  }
  return { lastSlot: nowSlot, longQ32, shortQ32 };
}

/**
 * Mirror of `occ_charge_view` for one portfolio: what the next touch at `nowSlot` would request (atoms, before the engine
 * takes `min(due, capital)`, and 0 while the account's PnL is negative) and the checkpoint it would leave. The vault LP
 * never pays (`isVaultLp`), nor does anything while rent is off / no LP is bound (both re-anchor). A flat portfolio drops
 * a tagged checkpoint.
 *
 * @param lastFeeSlot  The portfolio's `last_fee_slot`.
 * @param side         The leg's side on asset 0, `null` when flat.
 * @param clocks       Stored clocks ({@link decodeOccupancyStateV22}).
 * @param p            Params.
 * @param nowSlot      Slot of the touch.
 * @param isVaultLp    The portfolio is the bound vault LP.
 * @returns `{ checkpoint, due }`.
 * @example
 * ```ts
 * const { due } = occupancyDueV22(pf.lastFeeSlot, "long", occ.clocks, occ.params, slot);
 * ```
 */
export function occupancyDueV22(
  lastFeeSlot: bigint, side: "long" | "short" | null, clocks: OccupancyClocksV22, p: OccupancyParamsV22, nowSlot: bigint, isVaultLp = false,
): { checkpoint: bigint; due: bigint } {
  const c = occupancyClocksAtV22(clocks, p, nowSlot);
  if (side === null) return { checkpoint: (lastFeeSlot & OCC_CK_TAG_V22) !== 0n ? 0n : lastFeeSlot, due: 0n };
  const short = side === "short";
  const cNow = short ? c.shortQ32 : c.longQ32;
  if (p.fullNum === 0n || !p.lpBound || isVaultLp) return { checkpoint: occCkEncodeV22(cNow >> 32n, short), due: 0n };
  return occChargeStepV22(lastFeeSlot, short, cNow, p.fullNum);
}

/**
 * The occupancy QUOTE per side: what one leg pays per slot right now, `ramp_q32(count, cap) * fullNum / 2^32` in atoms x 1e9
 * (divide by 1e9 for atoms). Every leg on a side pays the same, whatever its notional. 0 on a side at or below 85% of the
 * cap, when rent is off, or with no bound vault LP.
 *
 * @param p  Params.
 * @returns `{ long, short }` atoms x 1e9 per slot per leg (floored), `rampQ32Long/Short`, and `fullE9` (the full-side figure).
 * @example
 * ```ts
 * const q = occupancyRatesV22(occ.params); const atomsPerDay = (q.long * BigInt(SLOTS_PER_DAY_V22)) / 1_000_000_000n;
 * ```
 */
export function occupancyRatesV22(p: OccupancyParamsV22): { long: bigint; short: bigint; rampQ32Long: bigint; rampQ32Short: bigint; fullE9: bigint } {
  if (p.fullNum === 0n || !p.lpBound || p.cap === 0n) return { long: 0n, short: 0n, rampQ32Long: 0n, rampQ32Short: 0n, fullE9: p.lpBound && p.cap !== 0n ? p.fullNum : 0n };
  const rl = occRampQ32V22(p.countLong, p.cap);
  const rs = occRampQ32V22(p.countShort, p.cap);
  return { long: (rl * p.fullNum) >> 32n, short: (rs * p.fullNum) >> 32n, rampQ32Long: rl, rampQ32Short: rs, fullE9: p.fullNum };
}

// ---------------------------------------------------------------------------------------------
// Wrapper predicates (ported from v16_program.rs)
// ---------------------------------------------------------------------------------------------

/** Inputs for {@link assetPriceLaggedV22} and the rules built on it. */
export interface BandAssetInputs {
  bandBps: number;
  /** `effective_price` (the mark, per lot e6). */
  effectivePrice: bigint;
  /** `raw_oracle_target_price`. */
  targetPrice: bigint;
  oiEffLongQ: bigint;
  oiEffShortQ: bigint;
  maxPriceMoveBpsPerSlot: bigint;
  maxAccrualDtSlots: bigint;
  /** `band_pin_since_slot` (0 = not pinned). */
  pinSinceSlot: bigint;
}

/**
 * `asset_price_lagged_view`: the asset is EXPOSED (open interest on either side) and its mark differs from its target.
 * An unexposed asset is never lagged. (The wrapper applies this gate on band markets only, `band_bps != 0`.)
 *
 * @param a  Asset inputs.
 * @returns `true` when lagged.
 * @example
 * ```ts
 * assetPriceLaggedV22({ ...inputs, oiEffLongQ: 0n, oiEffShortQ: 0n }); // false
 * ```
 */
export function assetPriceLaggedV22(a: BandAssetInputs): boolean {
  return a.bandBps !== 0 && (a.oiEffLongQ !== 0n || a.oiEffShortQ !== 0n) && a.targetPrice !== a.effectivePrice;
}

/**
 * `band_floor_stuck_view`: the price can no longer move toward its target: the cap law's per-accrual step at `P_last`
 * is 0 ticks, OR the pin clock is running and the band at `P_last` is narrower than 32 ticks. Band markets only.
 * Returns `true` when the width cannot be evaluated (the wrapper errors there; the SDK says "let the chain decide").
 *
 * @param a  Asset inputs.
 * @returns `true` when stuck.
 * @example
 * ```ts
 * bandFloorStuckV22({ ...inputs, maxPriceMoveBpsPerSlot: 0n });
 * ```
 */
export function bandFloorStuckV22(a: BandAssetInputs): boolean {
  if (a.bandBps === 0) return false;
  const maxStep = (a.effectivePrice * a.maxPriceMoveBpsPerSlot * a.maxAccrualDtSlots) / BPS;
  if (maxStep === 0n) return true;
  if (a.pinSinceSlot === 0n) return false;
  const w = bandWidthOkV22(a.effectivePrice, a.bandBps);
  return w === null ? true : !w;
}

/**
 * `reject_band_favourable_close_view`: would the wrapper refuse this fill with 104 (`PriceBandPinned`)? Only the
 * REDUCING part of a fill matters (a reduce, a close, or the closing part of a flip). While the mark lags its target a
 * close may land at `P_last` only on the WORSE side for the closer: a long sells at `P_last`, favourable iff the target is
 * below it; a short buys, favourable iff the target is above it. The floor-stuck exemption lifts the refusal.
 *
 * @param a               Asset inputs.
 * @param positionBefore  The account's signed position before the fill.
 * @param delta           Signed change.
 * @returns `true` when refused (104).
 * @example
 * ```ts
 * favourableCloseRefusedV22(asset, 5n, -5n);
 * ```
 */
export function favourableCloseRefusedV22(a: BandAssetInputs, positionBefore: bigint, delta: bigint): boolean {
  if (a.bandBps === 0) return false;
  const after = positionBefore + delta;
  const abs = (x: bigint) => (x < 0n ? -x : x);
  const reduces = positionBefore !== 0n && (after === 0n || after > 0n !== positionBefore > 0n || abs(after) < abs(positionBefore));
  if (!reduces || !assetPriceLaggedV22(a)) return false;
  if (bandFloorStuckV22(a)) return false;
  const favourable = positionBefore > 0n ? a.targetPrice < a.effectivePrice : a.targetPrice > a.effectivePrice;
  return favourable;
}

// ---------------------------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------------------------

/** Decoded band / rent config words. */
export interface BandConfigV22 {
  maxAccrualDtSlots: bigint;
  maxPriceMoveBpsPerSlot: bigint;
  /** 0 = no band. */
  bandBps: number;
  bandMaxEpochSlots: bigint;
  bandMaxPinSlots: bigint;
  /** 0 = no rent. */
  rentMaxE9PerSlot: bigint;
  bandMaxPositionsPerSide: bigint;
  bandMinLegNotional: bigint;
}

/** Decoded asset band / rent words. */
export interface AssetBandStateV22 {
  effectivePrice: bigint;
  rawOracleTargetPrice: bigint;
  bandAnchorPrice: bigint;
  bandAnchorSlot: bigint;
  bandEpoch: bigint;
  bandUncertifiedLong: bigint;
  bandUncertifiedShort: bigint;
  bandLiqPendingLong: bigint;
  bandLiqPendingShort: bigint;
  /** 0 = not pinned. */
  bandPinSinceSlot: bigint;
  rentIndexLongNum: bigint;
  rentIndexShortNum: bigint;
  rentUnroutedAtoms: bigint;
  oiEffLongQ: bigint;
  oiEffShortQ: bigint;
}

/** Decoded rent fields of the growth record and the vault LP record. */
export interface AssetRentStateV22 {
  rentKinkBps: number;
  rentNCapQ: bigint;
  vaultLpNetQ: bigint;
  vaultLpBound: boolean;
}

function bandLayout(data: Uint8Array, parser: string): { g: ReturnType<typeof resolveMarketGeometry>; B: BandRentOffsets } {
  const g = resolveMarketGeometry(data, { parser, strictLength: false });
  const B = g.layout.bandRent;
  if (!B) throw new UnknownLayoutError("UNKNOWN_VERSION", parser, `VERSION ${g.layout.version} has no band / rent words (v2.2 only)`, { version: g.layout.version });
  return { g, B };
}

/**
 * Decode the config's band / rent words.
 *
 * @param data  Raw market account bytes.
 * @returns The words.
 * @throws {@link UnknownLayoutError} for an unknown VERSION or a v2.1 market.
 * @example
 * ```ts
 * const c = decodeBandConfigV22(info.data); if (c.bandBps !== 0) { }
 * ```
 */
export function decodeBandConfigV22(data: Uint8Array): BandConfigV22 {
  const { g, B } = bandLayout(data, "decodeBandConfigV22");
  const base = g.groupOff + g.layout.group.config;
  if (data.length < base + B.configLen) throw new UnknownLayoutError("TOO_SHORT", "decodeBandConfigV22", "market too short for the config");
  const C = B.config;
  return {
    maxAccrualDtSlots: u64(data, base + C.maxAccrualDtSlots), maxPriceMoveBpsPerSlot: u64(data, base + C.maxPriceMoveBpsPerSlot),
    bandBps: Number(u64(data, base + C.bandBps)), bandMaxEpochSlots: u64(data, base + C.bandMaxEpochSlots), bandMaxPinSlots: u64(data, base + C.bandMaxPinSlots),
    rentMaxE9PerSlot: u64(data, base + C.rentMaxE9PerSlot), bandMaxPositionsPerSide: u64(data, base + C.bandMaxPositionsPerSide), bandMinLegNotional: u64(data, base + C.bandMinLegNotional),
  };
}

/**
 * Decode asset `assetIndex`'s band / rent words from the engine slot (plus the mark, target and open interest).
 *
 * @param data        Raw market account bytes.
 * @param assetIndex  Asset slot.
 * @returns The words.
 * @throws {@link UnknownLayoutError} / `RangeError` for a bad layout or slot.
 * @example
 * ```ts
 * const s = decodeAssetBandStateV22(info.data, 0);
 * ```
 */
export function decodeAssetBandStateV22(data: Uint8Array, assetIndex = 0): AssetBandStateV22 {
  const { g, B } = bandLayout(data, "decodeAssetBandStateV22");
  if (!Number.isInteger(assetIndex) || assetIndex < 0 || assetIndex >= g.slotCount) throw new RangeError(`asset ${assetIndex} is not present`);
  const e = g.engineOff(assetIndex);
  const S = B.assetState;
  const A = g.layout.assetState;
  return {
    effectivePrice: u64(data, e + A.effectivePrice), rawOracleTargetPrice: u64(data, e + A.rawOracleTargetPrice),
    bandAnchorPrice: u64(data, e + S.bandAnchorPrice), bandAnchorSlot: u64(data, e + S.bandAnchorSlot), bandEpoch: u64(data, e + S.bandEpoch),
    bandUncertifiedLong: u64(data, e + S.bandUncertifiedLong), bandUncertifiedShort: u64(data, e + S.bandUncertifiedShort),
    bandLiqPendingLong: u64(data, e + S.bandLiqPendingLong), bandLiqPendingShort: u64(data, e + S.bandLiqPendingShort),
    bandPinSinceSlot: u64(data, e + S.bandPinSinceSlot), rentIndexLongNum: u128(data, e + S.rentIndexLongNum), rentIndexShortNum: u128(data, e + S.rentIndexShortNum),
    rentUnroutedAtoms: u128(data, e + S.rentUnroutedAtoms), oiEffLongQ: u128(data, e + A.oiEffLongQ), oiEffShortQ: u128(data, e + A.oiEffShortQ),
  };
}

/**
 * Decode the rent fields of the growth record (`rent_kink_bps`, `rent_n_cap_q`) and the vault LP record (`lp_net_q`, bound flag).
 *
 * @param data        Raw market account bytes.
 * @param assetIndex  Asset slot.
 * @returns The fields.
 * @throws {@link UnknownLayoutError} / `RangeError` for a bad layout or slot.
 * @example
 * ```ts
 * const r = decodeAssetRentStateV22(info.data, 0);
 * ```
 */
export function decodeAssetRentStateV22(data: Uint8Array, assetIndex = 0): AssetRentStateV22 {
  const { g, B } = bandLayout(data, "decodeAssetRentStateV22");
  if (!Number.isInteger(assetIndex) || assetIndex < 0 || assetIndex >= g.slotCount) throw new RangeError(`asset ${assetIndex} is not present`);
  const s = g.slotOff(assetIndex);
  const W = g.layout.wrapperSlot;
  return {
    rentKinkBps: u16(data, s + W.growth + B.growth.rentKinkBps),
    rentNCapQ: u64(data, s + W.growth + B.growth.rentNCapQ),
    vaultLpNetQ: i128(data, s + W.vaultLp + B.vaultLp.lpNetQ),
    vaultLpBound: (data[s + W.vaultLp + B.vaultLp.flags] & 1) === 1,
  };
}

/**
 * `rent_rates_view`: per-side UTILISATION rent rates, e9 of notional per slot (0 without a rent ceiling, a bound vault or a
 * measured `N_cap`). Since prog#572 a band market's legs also pay a flat per-slot occupancy charge past 85% of the side cap:
 * see {@link occupancyRatesFromStateV22} (not included here, as in the program).
 */
export function rentRatesFromStateV22(cfg: BandConfigV22, asset: AssetBandStateV22, rent: AssetRentStateV22): { long: bigint; short: bigint } {
  if (cfg.rentMaxE9PerSlot === 0n || !rent.vaultLpBound || rent.rentNCapQ === 0n) return { long: 0n, short: 0n };
  return {
    long: rentRateE9FailClosedV22(usersSideOiQV22(asset.oiEffLongQ, rent.vaultLpNetQ, true), rent.rentNCapQ, rent.rentKinkBps, cfg.rentMaxE9PerSlot),
    short: rentRateE9FailClosedV22(usersSideOiQV22(asset.oiEffShortQ, rent.vaultLpNetQ, false), rent.rentNCapQ, rent.rentKinkBps, cfg.rentMaxE9PerSlot),
  };
}

/** prog#572 occupancy state of a band market (asset 0). */
export interface OccupancyStateV22 {
  /** Band on, market Live, rent on, vault LP bound: legs past the knee are being charged. */
  enabled: boolean;
  /** `group.mode == 0` (the program accrues / charges only while Live). */
  live: boolean;
  params: OccupancyParamsV22;
  clocks: OccupancyClocksV22;
  /** The bound vault LP portfolio (32 bytes; all zero when none). It never pays. */
  vaultLpPortfolio: Uint8Array;
  /** `slot_last` of asset 0 (the program skips a charge while it is 0). */
  assetSlotLast: bigint;
}

/**
 * Decode a band market's occupancy state: the side counts, the clocks in asset 0's profile (+408..+432), the vault LP
 * binding and the `F_full` numerator. Returns `null` on a market without a band (`band_bps == 0`): there the profile
 * bytes are GH#444's maintenance-fee checkpoint, not clocks.
 *
 * @param data  Raw market account bytes.
 * @returns The state, or `null` on a non-band market.
 * @throws {@link UnknownLayoutError} for unknown / v2.1 layouts.
 * @example
 * ```ts
 * const occ = decodeOccupancyStateV22(info.data); if (occ?.enabled) occupancyRatesV22(occ.params);
 * ```
 */
export function decodeOccupancyStateV22(data: Uint8Array): OccupancyStateV22 | null {
  const cfg = decodeBandConfigV22(data);
  if (cfg.bandBps === 0) return null;
  const { g, B } = bandLayout(data, "decodeOccupancyStateV22");
  if (g.slotCount < 1) throw new RangeError("asset 0 is not present");
  const O = B.occupancy;
  const e = g.engineOff(0);
  const s = g.slotOff(0);
  const prof = s + g.layout.wrapperSlot.oracleProfile;
  const vl = s + g.layout.wrapperSlot.vaultLp;
  const rent = decodeAssetRentStateV22(data, 0);
  const live = data[g.groupOff + g.layout.group.mode] === 0;
  const params: OccupancyParamsV22 = {
    cap: cfg.bandMaxPositionsPerSide, fullNum: occFullNumV22(cfg.rentMaxE9PerSlot, cfg.bandMinLegNotional), lpBound: rent.vaultLpBound,
    countLong: u64(data, e + O.storedPosCountLong), countShort: u64(data, e + O.storedPosCountShort),
  };
  return {
    enabled: live && params.cap !== 0n && params.fullNum !== 0n && params.lpBound,
    live, params,
    clocks: { lastSlot: u64(data, prof + O.profileClockSlot), longQ32: u64(data, prof + O.profileClockLong), shortQ32: u64(data, prof + O.profileClockShort) },
    vaultLpPortfolio: data.slice(vl + O.vaultLpPortfolio, vl + O.vaultLpPortfolio + 32),
    assetSlotLast: u64(data, e + O.slotLast),
  };
}

/**
 * prog#572 occupancy QUOTE next to {@link rentRatesFromStateV22}: per side, the flat amount ONE leg pays per slot right now,
 * `ramp_q32(count, cap) * rent_max * 4 * band_min_leg_notional / 2^32`, in atoms x 1e9 per slot (floored). All zero when
 * the charge is off (not Live, rent off, no bound vault LP, at / below the knee); the vault LP itself never pays.
 *
 * @param occ  {@link decodeOccupancyStateV22} (`null` = no band: all zero).
 * @returns `{ long, short }` atoms x 1e9 per slot per leg, the Q32 ramps and `fullE9` (a full side's figure).
 * @example
 * ```ts
 * const q = occupancyRatesFromStateV22(decodeOccupancyStateV22(info.data));
 * const atomsPerDayLong = (q.long * BigInt(SLOTS_PER_DAY_V22)) / 1_000_000_000n;
 * ```
 */
export function occupancyRatesFromStateV22(occ: OccupancyStateV22 | null): ReturnType<typeof occupancyRatesV22> {
  if (!occ || !occ.enabled) return { long: 0n, short: 0n, rampQ32Long: 0n, rampQ32Short: 0n, fullE9: 0n };
  return occupancyRatesV22(occ.params);
}

/** The band + rent view of one asset. */
export interface BandRentViewV22 {
  assetIndex: number;
  config: BandConfigV22;
  asset: AssetBandStateV22;
  rent: AssetRentStateV22;
  band: { enabled: boolean; recoveryMinutes: number };
  price: {
    markE6: bigint;
    targetE6: bigint;
    /** The wrapper's lag predicate: exposed AND mark != target, band markets only. */
    lagging: boolean;
    /** Mirror of `band_floor_stuck_view`: while stuck the wrapper does NOT refuse the favourable close. */
    floorStuck: boolean;
    /** The side whose close is refused (104) right now; `null` when nothing is refused. */
    favourableCloseSide: "long" | "short" | null;
  };
  rentRates: { enabled: boolean; long: bigint; short: bigint };
  /**
   * prog#572: the flat per-slot occupancy charge per leg (band markets past 85% of the side cap), atoms x 1e9 per slot,
   * on top of `rentRates` (per notional). `null` on a market without a band (asset 0 only: band markets are single-asset).
   */
  occupancy: (ReturnType<typeof occupancyRatesV22> & { enabled: boolean; cap: bigint; countLong: bigint; countShort: bigint }) | null;
}

/**
 * Compose the band / rent view of an asset. Returns `null` for a market with neither a band nor a holding fee.
 *
 * @param data        Raw market account bytes.
 * @param assetIndex  Asset slot.
 * @returns The view, or `null`.
 * @throws {@link UnknownLayoutError} for unknown / v2.1 layouts (use {@link tryReadBandRentViewV22} to never throw).
 * @example
 * ```ts
 * const v = readBandRentViewV22(info.data); if (v?.price.favourableCloseSide === "long") warn();
 * ```
 */
export function readBandRentViewV22(data: Uint8Array, assetIndex = 0): BandRentViewV22 | null {
  const config = decodeBandConfigV22(data);
  const bandOn = config.bandBps !== 0;
  const rentOn = config.rentMaxE9PerSlot !== 0n;
  if (!bandOn && !rentOn) return null;
  const asset = decodeAssetBandStateV22(data, assetIndex);
  const rent = decodeAssetRentStateV22(data, assetIndex);
  const inputs: BandAssetInputs = {
    bandBps: config.bandBps, effectivePrice: asset.effectivePrice, targetPrice: asset.rawOracleTargetPrice, oiEffLongQ: asset.oiEffLongQ, oiEffShortQ: asset.oiEffShortQ,
    maxPriceMoveBpsPerSlot: config.maxPriceMoveBpsPerSlot, maxAccrualDtSlots: config.maxAccrualDtSlots, pinSinceSlot: asset.bandPinSinceSlot,
  };
  const lagging = assetPriceLaggedV22(inputs);
  const floorStuck = bandFloorStuckV22(inputs);
  const rates = rentRatesFromStateV22(config, asset, rent);
  return {
    assetIndex, config, asset, rent,
    band: { enabled: bandOn, recoveryMinutes: bandOn ? forcedRecoveryMinutesV22({ bandMaxEpochSlots: Number(config.bandMaxEpochSlots), bandMaxPinSlots: Number(config.bandMaxPinSlots) }) : 0 },
    price: {
      markE6: asset.effectivePrice, targetE6: asset.rawOracleTargetPrice, lagging, floorStuck,
      favourableCloseSide: !lagging || floorStuck ? null : asset.effectivePrice > asset.rawOracleTargetPrice ? "long" : "short",
    },
    rentRates: { enabled: rentOn, long: rates.long, short: rates.short },
    occupancy: occupancyViewV22(data, assetIndex),
  };
}

function occupancyViewV22(data: Uint8Array, assetIndex: number): BandRentViewV22["occupancy"] {
  if (assetIndex !== 0) return null;
  const occ = decodeOccupancyStateV22(data);
  if (!occ) return null;
  const q = occupancyRatesFromStateV22(occ);
  return { ...q, enabled: occ.enabled, cap: occ.params.cap, countLong: occ.params.countLong, countShort: occ.params.countShort };
}

/**
 * {@link readBandRentViewV22} that never throws: `null` for anything that is not a readable v2.2 band / rent market.
 *
 * @param data        Raw market account bytes (or null).
 * @param assetIndex  Asset slot.
 * @returns The view or `null`.
 * @example
 * ```ts
 * const v = tryReadBandRentViewV22(info?.data);
 * ```
 */
export function tryReadBandRentViewV22(data: Uint8Array | null | undefined, assetIndex = 0): BandRentViewV22 | null {
  if (!data) return null;
  try {
    return readBandRentViewV22(data, assetIndex);
  } catch {
    return null;
  }
}

/** Layout rows that carry band words (for callers that branch on version). */
export function layoutHasBandRentV22(layout: LayoutTable | undefined = LAYOUTS_BY_VERSION.get(19)): boolean {
  return !!layout?.bandRent;
}
