/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk @ adf8fd0 (draft dcccrypto/percolator-sdk#406, sdk 9.0.0-candidate),
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

/** `rent_rates_view`: per-side rent rates, e9 of notional per slot (0 without a rent ceiling, a bound vault or a measured `N_cap`). */
export function rentRatesFromStateV22(cfg: BandConfigV22, asset: AssetBandStateV22, rent: AssetRentStateV22): { long: bigint; short: bigint } {
  if (cfg.rentMaxE9PerSlot === 0n || !rent.vaultLpBound || rent.rentNCapQ === 0n) return { long: 0n, short: 0n };
  return {
    long: rentRateE9FailClosedV22(usersSideOiQV22(asset.oiEffLongQ, rent.vaultLpNetQ, true), rent.rentNCapQ, rent.rentKinkBps, cfg.rentMaxE9PerSlot),
    short: rentRateE9FailClosedV22(usersSideOiQV22(asset.oiEffShortQ, rent.vaultLpNetQ, false), rent.rentNCapQ, rent.rentKinkBps, cfg.rentMaxE9PerSlot),
  };
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
  };
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
