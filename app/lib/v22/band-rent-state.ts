/**
 * Band + holding-fee read model for a v2.2 market (pure; never reads the network, never throws).
 *
 * The SDK candidate (percolator-sdk#406 @ ecb6215) ports the layout table and the wire, but has no decoder for the
 * band / rent STATE words, so this module reads them with offsets DERIVED FROM THE STRUCTS and self-checked
 * against the SDK's layout row (the checks run in `__tests__/lib/v22/band-rent-state.test.ts`, so a layout
 * change that moves a number fails a test instead of silently misreading):
 *
 *  - engine `V16ConfigAccount` (release/v22-engine-rem `src/v16.rs`, packed, no padding). The config starts at
 *    `groupOff + layout.group.config`. v2.1 ends at rel 249 (the 11 flag bytes), v2.2 appends six u64:
 *    `band_bps` @249, `band_max_epoch_slots` @257, `band_max_pin_slots` @265, `rent_max_e9_per_slot` @273,
 *    `band_max_positions_per_side` @281, `band_min_leg_notional` @289; the v2.2 config is 297 B, which is
 *    `layout.group.assetSlotCapacity - layout.group.config` (329 - 32).
 *  - engine `AssetStateV16Account` (relative to the engine slot): `raw_oracle_target_price` @17 and
 *    `effective_price` @25 (SDK `assetState`), then after the v2.1 end (515) `band_anchor_price` @515,
 *    `band_anchor_slot` @523, `band_epoch` @531, `band_uncertified_long/short` @539/@547,
 *    `band_liq_pending_long/short` @555/@563, `band_pin_since_slot` @571, `rent_index_long/short_num` @579/@595,
 *    `rent_unrouted_atoms` @611; ends at 627 = `layout.assetStateLen`.
 *  - wrapper `AssetGrowthV19` (slot + 672): `rent_kink_bps` u16 @42, `rent_n_cap_q` u64 @48.
 *  - wrapper `AssetVaultLpV18` (slot + 896): `lp_net_q` i128 @32, `flags` u8 @90 (bit 0 = bound).
 *  - `rent_rate_e9`: port of `growth_v19::rent_rate_e9` / `rent_rate_e9_fail_closed` (wrapper `rent_rates_view`).
 */
import {
  LAYOUT_V22,
  SLOTS_PER_YEAR_V22,
  UnknownLayoutError,
  forcedRecoveryMinutesV22,
  bandWidthOkV22,
  resolveMarketGeometry,
  type LayoutTable,
} from "./sdk";

/** Config-relative offsets of the v2.2 band / rent words (see the module header). */
export const CONFIG_V22_OFF = Object.freeze({
  /** v2.1 fields the floor-stuck test needs (packed offsets, unchanged since v2.1). */
  maxAccrualDtSlots: 118,
  maxPriceMoveBpsPerSlot: 142,
  bandBps: 249,
  bandMaxEpochSlots: 257,
  bandMaxPinSlots: 265,
  rentMaxE9PerSlot: 273,
  bandMaxPositionsPerSide: 281,
  bandMinLegNotional: 289,
  end: 297,
} as const);

/** Engine-slot-relative offsets of the v2.2 asset-state words. */
export const ASSET_STATE_V22_OFF = Object.freeze({
  bandAnchorPrice: 515,
  bandAnchorSlot: 523,
  bandEpoch: 531,
  bandUncertifiedLong: 539,
  bandUncertifiedShort: 547,
  bandLiqPendingLong: 555,
  bandLiqPendingShort: 563,
  bandPinSinceSlot: 571,
  rentIndexLongNum: 579,
  rentIndexShortNum: 595,
  rentUnroutedAtoms: 611,
  end: 627,
} as const);

const GROWTH_REL = Object.freeze({ slotOff: 672, rentKinkBps: 42, rentNCapQ: 48 } as const);
const VAULT_LP_REL = Object.freeze({ slotOff: 896, lpNetQ: 32, flags: 90 } as const);
const BPS = 10_000n;

/** Slots per day at the cluster's 400 ms slot (`SLOTS_PER_YEAR / 365`). */
export const SLOTS_PER_DAY_V22 = Number(SLOTS_PER_YEAR_V22 / 365n);

const dv = (d: Uint8Array): DataView => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u64 = (d: Uint8Array, o: number): bigint => dv(d).getBigUint64(o, true);
const u16 = (d: Uint8Array, o: number): number => dv(d).getUint16(o, true);
const i128 = (d: Uint8Array, o: number): bigint => {
  const lo = dv(d).getBigUint64(o, true);
  const hi = dv(d).getBigInt64(o + 8, true);
  return (hi << 64n) + lo;
};

/** `growth_v19::rent_rate_e9` (ceil, fail-closed to `rentMax` on bad input). Per-slot rate in e9 of notional. */
export function rentRateE9(usersOiSideQ: bigint, nCapQ: bigint, kinkBps: number, rentMaxE9: bigint): bigint {
  if (nCapQ === 0n || BigInt(kinkBps) > BPS) return rentMaxE9; // fail_closed: None -> rent_max
  const lhs = usersOiSideQ * BPS;
  const rhs = BigInt(kinkBps) * nCapQ;
  if (lhs <= rhs || rentMaxE9 === 0n) return 0n;
  if (usersOiSideQ >= nCapQ) return rentMaxE9;
  const den = nCapQ * (BPS - BigInt(kinkBps));
  const num = rentMaxE9 * (lhs - rhs);
  const r = num / den + (num % den !== 0n ? 1n : 0n);
  return r > rentMaxE9 ? rentMaxE9 : r;
}

/** `users_side_oi_q`: the side's open interest without the vault LP's own leg. */
export function usersSideOi(oiSideQ: bigint, vaultLpNetQ: bigint, longSide: boolean): bigint {
  const onSide = longSide ? vaultLpNetQ > 0n : vaultLpNetQ < 0n;
  if (!onSide) return oiSideQ;
  const abs = vaultLpNetQ < 0n ? -vaultLpNetQ : vaultLpNetQ;
  return oiSideQ > abs ? oiSideQ - abs : 0n;
}

/** Fraction of notional charged per day for a per-slot e9 rate, as a percent number (0.04 = 0.04%). */
export function rentPercentPerDay(rateE9PerSlot: bigint): number {
  return (Number(rateE9PerSlot) / 1e9) * SLOTS_PER_DAY_V22 * 100;
}

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
    /** Per-lot e6. */
    markE6: bigint;
    targetE6: bigint;
    /** Mark and oracle target differ: the band is stepping the mark toward the target. */
    lagging: boolean;
    /**
     * Mirror of the wrapper's `band_floor_stuck_view` (review F7): the cap law's dead zone (max step 0), or the pin clock
     * is running and the band at the mark is too narrow. While stuck the wrapper does NOT refuse the favourable close,
     * so the UI must not either. `true` also when the inputs cannot be evaluated (let the chain decide).
     */
    floorStuck: boolean;
    /**
     * The side whose CLOSE is refused while lagging (104): the side that would exit at a stale price that favours
     * it. Mark above target (price fell): longs; mark below target (price rose): shorts. null when not lagging.
     */
    favourableCloseSide: "long" | "short" | null;
  };
  rent: {
    enabled: boolean;
    maxE9PerSlot: bigint;
    kinkBps: number;
    /** Current per-slot rate per side, e9 of notional (0 while the market has no bound vault / measured N_cap). */
    rateLongE9: bigint;
    rateShortE9: bigint;
  };
}

/**
 * Read the band / rent view of asset `assetIndex`. Returns null for anything that is not a v2.2 (VERSION 19)
 * market account, or a market with neither a band nor a holding fee, so callers render nothing for v2.1 markets.
 */
export function readBandRentView(data: Uint8Array | null | undefined, assetIndex = 0, layout: LayoutTable = LAYOUT_V22): BandRentView | null {
  if (!data) return null;
  try {
    const g = resolveMarketGeometry(data, { parser: "readBandRentView", strictLength: false, versions: [layout.version], registry: new Map([[layout.version, layout]]) });
    if (assetIndex < 0 || assetIndex >= g.slotCount) return null;
    const L = g.layout;
    if (L.group.assetSlotCapacity - L.group.config !== CONFIG_V22_OFF.end || L.assetStateLen !== ASSET_STATE_V22_OFF.end) return null; // not the geometry these offsets were derived for
    const cfg = g.groupOff + L.group.config;
    if (data.length < cfg + CONFIG_V22_OFF.end) return null;
    const eng = g.engineOff(assetIndex);
    const slot = g.slotOff(assetIndex);
    if (data.length < eng + L.assetStateLen || data.length < slot + VAULT_LP_REL.slotOff + 128) return null;

    const bandBps = Number(u64(data, cfg + CONFIG_V22_OFF.bandBps));
    const epochSlots = u64(data, cfg + CONFIG_V22_OFF.bandMaxEpochSlots);
    const pinSlots = u64(data, cfg + CONFIG_V22_OFF.bandMaxPinSlots);
    const rentMax = u64(data, cfg + CONFIG_V22_OFF.rentMaxE9PerSlot);
    const bandEnabled = bandBps !== 0;
    const rentEnabled = rentMax !== 0n;
    if (!bandEnabled && !rentEnabled) return null;

    const markE6 = u64(data, eng + L.assetState.effectivePrice);
    const targetE6 = u64(data, eng + L.assetState.rawOracleTargetPrice);
    // Wrapper `asset_price_lagged_view`: any difference between the mark and the target on a band market.
    const lagging = bandEnabled && markE6 !== targetE6;
    const maxStep = (markE6 * u64(data, cfg + CONFIG_V22_OFF.maxPriceMoveBpsPerSlot) * u64(data, cfg + CONFIG_V22_OFF.maxAccrualDtSlots)) / 10_000n;
    const pinSince = u64(data, eng + ASSET_STATE_V22_OFF.bandPinSinceSlot);
    const widthOk = bandEnabled ? bandWidthOkV22(markE6, bandBps) : true;
    const floorStuck = bandEnabled && (maxStep === 0n || (pinSince !== 0n && (widthOk === null || widthOk === false)));

    const kinkBps = u16(data, slot + GROWTH_REL.slotOff + GROWTH_REL.rentKinkBps);
    const nCap = u64(data, slot + GROWTH_REL.slotOff + GROWTH_REL.rentNCapQ);
    const bound = (data[slot + VAULT_LP_REL.slotOff + VAULT_LP_REL.flags] & 1) === 1;
    let rateLong = 0n;
    let rateShort = 0n;
    if (rentEnabled && bound && nCap !== 0n) {
      const lpNet = i128(data, slot + VAULT_LP_REL.slotOff + VAULT_LP_REL.lpNetQ);
      const oiLong = i128(data, eng + L.assetState.oiEffLongQ);
      const oiShort = i128(data, eng + L.assetState.oiEffShortQ);
      rateLong = rentRateE9(usersSideOi(oiLong, lpNet, true), nCap, kinkBps, rentMax);
      rateShort = rentRateE9(usersSideOi(oiShort, lpNet, false), nCap, kinkBps, rentMax);
    }

    return {
      assetIndex,
      lotExp: data[slot + L.wrapperSlot.profileLotExp] ?? 0,
      band: {
        enabled: bandEnabled,
        bandBps,
        epochSlots,
        pinSlots,
        maxPositionsPerSide: u64(data, cfg + CONFIG_V22_OFF.bandMaxPositionsPerSide),
        minLegNotionalAtoms: u64(data, cfg + CONFIG_V22_OFF.bandMinLegNotional),
        recoveryMinutes: bandEnabled ? forcedRecoveryMinutesV22({ bandMaxEpochSlots: Number(epochSlots), bandMaxPinSlots: Number(pinSlots) }) : 0,
      },
      price: {
        markE6,
        targetE6,
        lagging,
        floorStuck,
        favourableCloseSide: !lagging ? null : markE6 > targetE6 ? "long" : "short",
      },
      rent: { enabled: rentEnabled, maxE9PerSlot: rentMax, kinkBps, rateLongE9: rateLong, rateShortE9: rateShort },
    };
  } catch (e) {
    if (e instanceof UnknownLayoutError) return null;
    return null;
  }
}

/** Is this side's close refused right now by the band (104)? */
export function closeBlockedByBand(view: BandRentView | null, positionSide: "long" | "short"): boolean {
  return !!view && view.price.lagging && !view.price.floorStuck && view.price.favourableCloseSide === positionSide;
}

/**
 * A leg whose notional is below HALF the market minimum can be closed by anyone (tag 118 sweep). `absQ` is the
 * position in engine Q (POS_SCALE per lot), `markE6` the per-lot mark; the engine compares q*price/POS_SCALE raw.
 */
export function legBelowHalfMin(absQ: bigint, markE6: bigint, minLegNotionalAtoms: bigint): boolean {
  if (minLegNotionalAtoms === 0n) return false;
  // Engine `band_leg_is_dust`: notional = q * effective_price / POS_SCALE, compared RAW to band_min_leg_notional (atoms).
  // No decimals scaling (review F8).
  const notional = (absQ * markE6) / 1_000_000n;
  return notional * 2n < minLegNotionalAtoms;
}
