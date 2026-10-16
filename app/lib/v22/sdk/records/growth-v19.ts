/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk-growth @ 501ba1a (growth round 2, D-L1/D-L2),
 * src/abi/growth-v19.ts. Only the imports are retargeted (the vendored v22 layout/slab ports, sibling records ports, and the installed @percolatorct/sdk 8.0.0 root).
 * TODO(repin): delete when @percolatorct/sdk >= 9.0.0 ships and point ../../records.ts at the package. Do not edit here; fix upstream in percolator-sdk.
 */
/**
 * growth-v19 (dynamic leverage + capital-derived capacity) client ABI. Additive to SDK 8.0.1.
 *
 * Source of truth (read, every offset verified):
 *  - wrapper `dcccrypto/percolator-prog#524` branch `feat/growth-v19-dynamic-leverage` @ `5993a5c1`:
 *    `src/growth_v19.rs` (pure math; mirrored here with bigint, exact integer semantics),
 *    `src/v16_program.rs` (`state::AssetGrowthV19`, `ASSET_GROWTH_OFF = 672`, decode arms for
 *    tag 0 / 93 / 94 growth trailers incl. `SetAssetRiskLimitsV19`, `PercolatorError` 92..=94).
 *  - matcher `dcccrypto/percolator-match#33` `src/v2.rs` (`CallExt::encode_v3`, `parse_v3`).
 *
 * Units: leverage is x100 (550 = 5.5x); IMR / utilisation / lambda / kink are bps out of 10_000;
 * positions are engine Q (`POS_SCALE` per unit); prices are e6.
 *
 * @module growth-v19
 */
import { LAYOUT_V21, resolveMarketGeometry } from "../layout";
import type { LayoutTable } from "../layout";
import { concatBytes, encU8, encU16, encU32, encU128 } from "@percolatorct/sdk";
import { encodeInitMarket } from "@percolatorct/sdk";
import type { InitMarketV17Args, InitMarketArgs } from "@percolatorct/sdk";
import {
  encodeMatcherCallExt,
  MATCHER_CALL_EXT_LEN,
} from "@percolatorct/sdk";
import type { MatcherCallExt } from "@percolatorct/sdk";
import { IX_TAG_P1 } from "./risk-limits-p1";
import { IX_TAG_P3 } from "@percolatorct/sdk";

// ============================================================================
// Constants
// ============================================================================

/** `growth_v19::BPS`. */
export const GROWTH_BPS = 10_000n;
/** `growth_v19::MAX_IMR_BPS` (100% initial margin = 1x). */
export const GROWTH_MAX_IMR_BPS = 10_000n;
/** `growth_v19::LEVERAGE_X100_ONE` (1x). */
export const GROWTH_LEVERAGE_X100_ONE = 100;
/** `growth_v19::MAX_LAMBDA_BPS` (10x of capital). */
export const GROWTH_MAX_LAMBDA_BPS = 100_000;
/**
 * Tag-93 growth trailer bounds WITHOUT the epoch clamp (`growth_dials_ok(false, ..)`, the only mode
 * enabled today): lambda in [1, 10_000], kink in [0, 5_000]. With the clamp (`EPOCH_CLAMP_ENFORCED`,
 * not yet enabled) the wrapper would allow lambda up to 100_000 and kink up to 10_000.
 */
export const GROWTH_DIALS_NO_CLAMP_MAX_LAMBDA_BPS = 10_000;
/** See {@link GROWTH_DIALS_NO_CLAMP_MAX_LAMBDA_BPS}. */
export const GROWTH_DIALS_NO_CLAMP_MAX_KINK_BPS = 5_000;
/** `DEPTH_MULT`: the ext-v3 liquidity depth multiple of `lambda * C_m / 1e4`. */
export const GROWTH_DEPTH_MULT = 4n;
/** Engine `MAX_POSITION_ABS_Q` (1e14): upper clamp of the ext-v3 `inventory_cap_q`. */
export const GROWTH_MAX_POSITION_ABS_Q = 100_000_000_000_000n;
/** Tag 94 on a growth asset pins `matcher_ext_mode = 1` (P2 call extension on). */
export const GROWTH_PIN_MATCHER_EXT_MODE = 1;
/**
 * Tag 94 on a growth asset pins a requested-fee cap of 100 bps: the taker's signed `fee_bps` must
 * cover the base fee plus up to this much (the matcher's spread is paid to the LP as a fee).
 */
export const GROWTH_PIN_MAX_REQUESTED_FEE_BPS = 100;
/** Tag 94 on a growth asset pins an LP floor of 1_000_000 atoms ($1 on a 6-decimal mint). */
export const GROWTH_PIN_LP_FLOOR_ATOMS = 1_000_000n;
/** Tag 94 on a growth asset binds a kind-2 (adaptive) matcher context. */
export const GROWTH_PIN_MATCHER_KIND = 2;
/** `AssetGrowthV19::version` of an enabled block (`GROWTH_VERSION`). */
export const GROWTH_VERSION = 1;
/** Engine `POS_SCALE` used by `n_cap_q` callers. */
export const GROWTH_POS_SCALE = 1_000_000n;

/** `ASSET_GROWTH_OFF`: record offset inside each asset's 1024-byte wrapper slot. */
export const ASSET_GROWTH_SLOT_OFF = 672;
/** `ASSET_GROWTH_LEN`. */
export const ASSET_GROWTH_LEN = 120;
/** `AssetGrowthV19::version` field offset (the one-byte OFF fast path reads only this). */
export const ASSET_GROWTH_VERSION_FIELD_OFF = 38;
/** Length of one wrapper asset slot (same stride base as `AssetRiskLimitsV17`). */
export const ASSET_WRAPPER_SLOT_LEN = 1024;

/** Field offsets inside the 120-byte `AssetGrowthV19` record (rustc `repr(C)`, no u128). */
export const ASSET_GROWTH_FIELD_OFF = Object.freeze({
  cLaunchAtoms: 0, ceilSlot: 8, lambdaBps: 16, lLaunchX100: 20, lTierX100: 22, ceilX100: 24,
  kinkBps: 26, rGapBps: 28, allocAlphaBps: 30, allocBufferBps: 32, cushionTargetBps: 34,
  cushionShareBps: 36, version: 38, flags: 39, utilFeeMaxBps: 40, reserved: 42,
} as const);

/**
 * v2.2 G8 depth fields, relative to the record start (inside the formerly reserved bytes; 42..44 = rent kink, 48..56 = rent
 * N_cap). Kept apart from {@link ASSET_GROWTH_FIELD_OFF}, which is pinned against the crate's `offset_of!` fixture.
 */
export const ASSET_GROWTH_DEPTH_FIELD_OFF = Object.freeze({
  depthSource: 44, attestedMaxTier: 45, collateralDecimalsP1: 46, depthE6: 56, depthSlot: 64, depthPrevE6: 72,
  depthLastGoodE6: 80, depthLastGoodSlot: 88, tierThresholdUsd: 96, tierLeverageX100: 108, depthRiseSlot64: 114,
} as const);

/** N-2: utilisation fee at `u = 1` when the per-asset dial is 0 (bps of the opening notional). */
export const GROWTH_UTIL_FEE_DEFAULT_BPS = 500;
/** N-2: hard ceiling of the per-asset utilisation-fee dial. */
export const GROWTH_UTIL_FEE_HARD_MAX_BPS = 2_000;

/** `R_GAP_MIN_LIQUIDATION_SLOTS` (L-2): liquidation latency, in slots, behind the `r_gap` floor. */
export const R_GAP_MIN_LIQUIDATION_SLOTS = 50n;
/** `GROWTH_BATCH_MAX_LEGS`: a BatchTradeCpi carrying ANY growth leg is refused above this many legs. */
export const GROWTH_BATCH_MAX_LEGS = 10;
/** Tag-0 byte offsets (v17 InitMarket body) of the fields the growth rule reads. */
const INIT_MARKET_MMR_OFF = 59;
const INIT_MARKET_LIQ_FEE_OFF = 91;
const INIT_MARKET_MAX_PRICE_MOVE_OFF = 131;
/** `EXT_FLAG_TAKER_REDUCING` (byte 1, bit 3). */
export const MATCHER_CALL_EXT_FLAG_TAKER_REDUCING = 0x08;
/** `CALL_EXT_V3_VERSION`. */
export const MATCHER_CALL_EXT_VERSION_V3 = 3;
/** v2 block length (24-byte v1 + i128 lp_position_q). */
export const MATCHER_CALL_EXT_V2_LEN = 40;
/** v3 block length (v2 + u128 inventory_cap_q + u128 liquidity_notional_e6). */
export const MATCHER_CALL_EXT_V3_LEN = 72;
/** `CALL_EXT_VERSION_V2`. */
export const MATCHER_CALL_EXT_VERSION_V2 = 2;

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const I128_MAX = (1n << 127n) - 1n;
const I128_MIN = -(1n << 127n);

type Num = bigint | number;
function big(name: string, v: Num): bigint {
  if (typeof v === "bigint") return v;
  if (!Number.isInteger(v)) throw new Error(`${name} must be an integer, got ${v}`);
  return BigInt(v);
}
/** `ceil(a / b)` for non-negative a and positive b. */
function divCeil(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

// ============================================================================
// AssetGrowthV19 decoder
// ============================================================================

/** Decoded `AssetGrowthV19` (version != 0). */
export interface AssetGrowthV19 {
  /** Junior risk capital at launch (atoms); 0 = not recorded. */
  cLaunchAtoms: bigint;
  /** Slot of the last ceiling change. */
  ceilSlot: bigint;
  /** `N_cap = lambda * C_m / P`; 10_000 = 1x of capital. */
  lambdaBps: number;
  /** Creator's starting leverage cap, x100. */
  lLaunchX100: number;
  /** Protocol tier maximum, x100 (floor(1e6 / engine IMR) at enable time). */
  lTierX100: number;
  /** Current graduated ceiling, x100 (== launch while graduation is off). */
  ceilX100: number;
  /** Utilisation kink u_k (bps). */
  kinkBps: number;
  /** Worst move between liquidation opportunities (bps). */
  rGapBps: number;
  allocAlphaBps: number;
  allocBufferBps: number;
  cushionTargetBps: number;
  cushionShareBps: number;
  version: number;
  flags: number;
  /** N-2: stored utilisation-fee dial at `u = 1` (bps); 0 = {@link GROWTH_UTIL_FEE_DEFAULT_BPS}. */
  utilFeeMaxBps: number;
  /** v2.2 G8: source of the stored depth (byte 44 bits 0-1): 0 = none, 1 = keeper-attested (PushAuthMark mode 1), 2 = on-chain DEX pool (mode 2). */
  depthSource: number;
  /** R2.1 (W-M1): byte 44 bit 7 `DEPTH_EVER`: a fresh effective depth was seen once; the depth cap then never switches off. */
  depthEver: boolean;
  /** Byte 44 bit 2 `DEPTH_PREV_REAL`: the sample before the stored one was a real reading (a 0 included), not an absent one. */
  depthPrevReal: boolean;
  /** R2.1: highest venue tier keeper-attested depth may earn (45; 0 = protocol default 1, max 3). */
  attestedMaxTier: number;
  /** v2.2 G8: last pushed +-2% depth, USD e6 (collateral 6 decimals). 0 when absent. */
  depthE6: bigint;
  /** v2.2 G8: slot of the last depth push. */
  depthSlot: bigint;
  /** v2.2 G8: the depth before the last push (effective depth is the min of the two). */
  depthPrevE6: bigint;
  /**
   * R2.1 (80) + R2-M1: the RATE-LIMITED last good depth (collateral atoms): rises at most 2x per 9,000-slot epoch, falls at once; the sticky
   * cap's input and, with the fresh reading, the usable depth every tier and cap reads ({@link usableDepthE6}).
   */
  depthLastGoodE6: bigint;
  /** R2.1 (88): slot of that sample. */
  depthLastGoodSlot: bigint;
  /** R2-L2 (46): the collateral mint's decimals + 1 as stored (0 = a pre-R2-L2 record, read as 6 decimals). */
  collateralDecimalsP1: number;
  /** R2-L2: the collateral mint's decimals (byte 46; 6 when unset). Tier thresholds are whole collateral tokens scaled by this. */
  collateralDecimals: number;
  /** R2-M1 / D-L2 (114, u32 LE): the slot of the last rise of {@link AssetGrowthV19.depthLastGoodE6} in 64-slot units (`slot / 64`, saturating). */
  depthRiseSlot64: number;
  /** R2.1 (96): per-market tier thresholds in WHOLE COLLATERAL TOKENS (T1, T2, T3; $ on 6-decimal USD collateral); 0 = default 25,000 / 100,000 / 500,000. */
  tierThresholdUsd: Triple<number>;
  /** R2.1 (108): per-tier max leverage x100 (L1, L2, L3); 0 = default `min(5x / 10x / 20x, L_tier)`. */
  tierLeverageX100: Triple<number>;
}

/**
 * Decode one 120-byte `AssetGrowthV19` record.
 *
 * @param rec  The 120 bytes (record only, not the slot).
 * @returns The decoded record, or `null` when `version == 0` (growth OFF; the wrapper reads only
 *          the version byte on this path and treats the whole record as inert).
 * @example
 * ```ts
 * const g = decodeAssetGrowthRecordV19(slot.subarray(672, 792));
 * if (g === null) { // growth off: engine leverage applies }
 * ```
 */
export function decodeAssetGrowthRecordV19(rec: Uint8Array): AssetGrowthV19 | null {
  if (rec.length !== ASSET_GROWTH_LEN) throw new Error(`AssetGrowthV19 record must be ${ASSET_GROWTH_LEN} bytes, got ${rec.length}`);
  const F = ASSET_GROWTH_FIELD_OFF;
  const D = ASSET_GROWTH_DEPTH_FIELD_OFF;
  const version = rec[F.version] as number;
  if (version === 0) return null;
  const v = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  return {
    cLaunchAtoms: v.getBigUint64(F.cLaunchAtoms, true),
    ceilSlot: v.getBigUint64(F.ceilSlot, true),
    lambdaBps: v.getUint32(F.lambdaBps, true),
    lLaunchX100: v.getUint16(F.lLaunchX100, true),
    lTierX100: v.getUint16(F.lTierX100, true),
    ceilX100: v.getUint16(F.ceilX100, true),
    kinkBps: v.getUint16(F.kinkBps, true),
    rGapBps: v.getUint16(F.rGapBps, true),
    allocAlphaBps: v.getUint16(F.allocAlphaBps, true),
    allocBufferBps: v.getUint16(F.allocBufferBps, true),
    cushionTargetBps: v.getUint16(F.cushionTargetBps, true),
    cushionShareBps: v.getUint16(F.cushionShareBps, true),
    version,
    flags: rec[F.flags] as number,
    utilFeeMaxBps: v.getUint16(F.utilFeeMaxBps, true),
    depthSource: (rec[D.depthSource] as number) & DEPTH_SOURCE_MASK,
    depthEver: ((rec[D.depthSource] as number) & DEPTH_EVER) !== 0,
    depthPrevReal: ((rec[D.depthSource] as number) & DEPTH_PREV_REAL) !== 0,
    attestedMaxTier: rec[D.attestedMaxTier] as number,
    collateralDecimalsP1: rec[D.collateralDecimalsP1] as number,
    collateralDecimals: collateralDecimalsOf(rec[D.collateralDecimalsP1] as number),
    depthRiseSlot64: v.getUint32(D.depthRiseSlot64, true),
    depthE6: v.getBigUint64(D.depthE6, true),
    depthSlot: v.getBigUint64(D.depthSlot, true),
    depthPrevE6: v.getBigUint64(D.depthPrevE6, true),
    depthLastGoodE6: v.getBigUint64(D.depthLastGoodE6, true),
    depthLastGoodSlot: v.getBigUint64(D.depthLastGoodSlot, true),
    tierThresholdUsd: [v.getUint32(D.tierThresholdUsd, true), v.getUint32(D.tierThresholdUsd + 4, true), v.getUint32(D.tierThresholdUsd + 8, true)],
    tierLeverageX100: [v.getUint16(D.tierLeverageX100, true), v.getUint16(D.tierLeverageX100 + 2, true), v.getUint16(D.tierLeverageX100 + 4, true)],
  };
}

/**
 * Decode the growth record from one 1024-byte asset wrapper slot (record at slot + 672).
 *
 * @param slot  The asset's wrapper slot (>= 792 bytes; normally 1024).
 * @returns Decoded record or `null` when growth is OFF.
 * @example
 * ```ts
 * decodeAssetGrowthFromSlotV19(marketData.subarray(slotStart, slotStart + 1024));
 * ```
 */
export function decodeAssetGrowthFromSlotV19(slot: Uint8Array): AssetGrowthV19 | null {
  const end = ASSET_GROWTH_SLOT_OFF + ASSET_GROWTH_LEN;
  if (slot.length < end) throw new Error(`asset slot too short for AssetGrowthV19: ${slot.length} < ${end}`);
  return decodeAssetGrowthRecordV19(slot.subarray(ASSET_GROWTH_SLOT_OFF, end));
}

/**
 * Absolute account offset of asset `i`'s `AssetGrowthV19`: 592 + 758 + 2325·i + 672 = 2022 + 2325·i
 * (the same slot base as `AssetRiskLimitsV17` at slot + 608, see `assetRiskLimitsAccountOffsetP1`).
 *
 * @param assetIndex  Asset slot index.
 * @param layout      Layout table of the account's VERSION (default LAYOUT_V21; LAYOUT_V22 for v2.2).
 * @returns Byte offset into the market account.
 * @example
 * ```ts
 * assetGrowthAccountOffsetV19(0); // 2022
 * ```
 */
export function assetGrowthAccountOffsetV19(assetIndex: number, layout: LayoutTable = LAYOUT_V21): number {
  if (!Number.isInteger(assetIndex) || assetIndex < 0) throw new Error(`bad assetIndex ${assetIndex}`);
  return layout.marketGroupOff + layout.marketGroupLen + layout.assetSlotStride * assetIndex + layout.wrapperSlot.growth;
}

/**
 * Decode asset `i`'s growth record from a raw market account (kind 1).
 *
 * @param marketData  Raw market account bytes.
 * @param assetIndex  Asset slot.
 * @returns Decoded record or `null` when growth is OFF.
 * @example
 * ```ts
 * const g = decodeAssetGrowthV19(info.data, 0);
 * ```
 */
export function decodeAssetGrowthV19(marketData: Uint8Array, assetIndex: number): AssetGrowthV19 | null {
  const g = resolveMarketGeometry(marketData, { parser: "decodeAssetGrowthV19", strictLength: false });
  const off = assetGrowthAccountOffsetV19(assetIndex, g.layout);
  if (marketData.length < off + ASSET_GROWTH_LEN) throw new Error(`market account too short for asset ${assetIndex}`);
  return decodeAssetGrowthRecordV19(marketData.subarray(off, off + ASSET_GROWTH_LEN));
}

// ============================================================================
// Pure math (mirror of src/growth_v19.rs, bigint)
// ============================================================================

/**
 * `ceil(1_000_000 / l_x100)`: the IMR (bps) of a leverage cap. Port of `imr_bps_for_leverage_x100`.
 *
 * @param lX100  Leverage x100 (550 = 5.5x).
 * @returns IMR in bps, or `null` below 1x.
 * @example
 * ```ts
 * imrBpsForLeverageX100(550); // 1819n (18.18% rounded UP)
 * ```
 */
export function imrBpsForLeverageX100(lX100: Num): bigint | null {
  const l = big("lX100", lX100);
  if (l < BigInt(GROWTH_LEVERAGE_X100_ONE) || l > 0xffffn) return null;
  return divCeil(1_000_000n, l);
}

/**
 * `floor(1_000_000 / imr)` saturated at `u16::MAX`: the tier leverage (x100) of an IMR. Port of
 * `leverage_x100_for_imr_bps`.
 *
 * @param imrBps  IMR in bps.
 * @returns Leverage x100, or `null` for an IMR of 0 or above 100%.
 * @example
 * ```ts
 * leverageX100ForImrBps(1000n); // 1000n (10x)
 * ```
 */
export function leverageX100ForImrBps(imrBps: Num): bigint | null {
  const imr = big("imrBps", imrBps);
  if (imr === 0n || imr < 0n || imr > GROWTH_MAX_IMR_BPS) return null;
  const l = 1_000_000n / imr;
  return l > 0xffffn ? 0xffffn : l;
}

/**
 * `base = max(engine IMR, IMR(L_ceil))`. Port of `ceiling_imr_bps`.
 *
 * @param engineImrBps  Engine initial margin (bps).
 * @param lCeilX100     Leverage ceiling x100.
 * @returns Base IMR in bps, or `null` (fail closed) on a corrupt engine IMR or ceiling below 1x.
 * @example
 * ```ts
 * ceilingImrBps(1000n, 550); // 1819n
 * ceilingImrBps(2000n, 1000); // 2000n (never looser than the engine)
 * ```
 */
export function ceilingImrBps(engineImrBps: Num, lCeilX100: Num): bigint | null {
  const e = big("engineImrBps", engineImrBps);
  if (e < 0n || e > GROWTH_MAX_IMR_BPS) return null;
  const c = imrBpsForLeverageX100(lCeilX100);
  if (c === null) return null;
  return c > e ? c : e;
}

/**
 * `N_cap_q = floor(c_m * lambda_bps * pos_scale / (10_000 * price_e6))`. Port of `n_cap_q`.
 * Overflow is checked at the Rust widths (u128 intermediates), failing closed.
 *
 * @param cM          Conservative LP equity (atoms).
 * @param lambdaBps   Lambda (bps, 10_000 = 1x).
 * @param priceE6     Price (e6).
 * @param posScale    Engine `POS_SCALE` (default 1_000_000n).
 * @returns Capacity in Q, or `null` on a zero price or u128 overflow.
 * @example
 * ```ts
 * nCapQ(1_746_000_000n, 10_000n, 1_000_000n); // 1_746_000_000n
 * ```
 */
export function nCapQ(cM: bigint, lambdaBps: Num, priceE6: bigint, posScale: bigint = GROWTH_POS_SCALE): bigint | null {
  if (priceE6 === 0n) return null;
  const a = cM * big("lambdaBps", lambdaBps);
  if (a > U128_MAX) return null;
  const num = a * posScale;
  if (num > U128_MAX) return null;
  const den = GROWTH_BPS * priceE6;
  if (den > U128_MAX) return null;
  return num / den;
}

/**
 * `liquidity_notional_e6` the wrapper hands the matcher (ext v3): `floor(c_m * lambda * DEPTH_MULT / 1e4)`
 * with `DEPTH_MULT = 4`. Port of `liquidity_notional_e6`.
 *
 * @param cM         Conservative LP equity (atoms).
 * @param lambdaBps  Lambda (bps).
 * @returns The depth, or `null` on u128 overflow.
 * @example
 * ```ts
 * liquidityNotionalE6(1_000_000_000n, 10_000n); // 4_000_000_000n
 * ```
 */
export function liquidityNotionalE6(cM: bigint, lambdaBps: Num): bigint | null {
  const a = cM * big("lambdaBps", lambdaBps);
  if (a > U128_MAX) return null;
  const p = a * GROWTH_DEPTH_MULT;
  if (p > U128_MAX) return null;
  return p / GROWTH_BPS;
}

/**
 * The `(inventory_cap_q, liquidity_notional_e6)` pair the wrapper puts in the matcher ext v3
 * (`growth_matcher_caps_view`): both 0 while the bankruptcy h-lock is latched; otherwise
 * `cap = min(N_cap, 1e14)` (0 on a zero price / overflow) and `liquidity = 0` when `cap == 0`, else
 * `4 * lambda * C_m / 1e4`.
 *
 * @param g            Decoded growth record (only `lambdaBps` is used).
 * @param cM           Conservative LP equity (atoms), see {@link conservativeEquity}.
 * @param priceE6      Effective price (e6).
 * @param hlockActive  Bankruptcy h-lock latched.
 * @param posScale     Engine `POS_SCALE` (default 1_000_000n).
 * @returns Caps ready for {@link encodeMatcherCallExtV3}.
 * @example
 * ```ts
 * growthMatcherCapsV3(g, 1_000_000_000n, 1_000_000n, false); // { inventoryCapQ: 1_000_000_000n, liquidityNotionalE6: 4_000_000_000n }
 * ```
 */
export function growthMatcherCapsV3(
  g: Pick<AssetGrowthV19, "lambdaBps">, cM: bigint, priceE6: bigint, hlockActive: boolean, posScale: bigint = GROWTH_POS_SCALE,
): MatcherCallExtCapsV3 {
  if (hlockActive) return { inventoryCapQ: 0n, liquidityNotionalE6: 0n };
  const n = nCapQ(cM, g.lambdaBps, priceE6, posScale) ?? 0n;
  const cap = n < GROWTH_MAX_POSITION_ABS_Q ? n : GROWTH_MAX_POSITION_ABS_Q;
  const liq = cap === 0n ? 0n : (liquidityNotionalE6(cM, g.lambdaBps) ?? 0n);
  return { inventoryCapQ: cap, liquidityNotionalE6: liq };
}

/**
 * Kinked dynamic IMR for a crowd-joining fill. Port of `dyn_imr_bps`. `null` == refused
 * (GrowthCapacityFull): `n_cap` is 0, `lp_abs_after > n_cap` (u > 1), a corrupt input or a u128
 * overflow. Q3 (wrapper 5993a5c1): `u == 1` exactly is ADMITTED, at 100% IMR (the headroom clip and
 * the matcher's `<= cap` inventory check agree, so no crowd fill leaves `|LP| > N_cap`).
 *
 * `lp*1e4 <= kink*n` -> base; else `base + ceil((1e4 - base) * (lp*1e4 - kink*n) / (n * (1e4 - kink)))`,
 * clamped to 10_000.
 *
 * @param lpAbsAfter  |LP| after the fill (Q).
 * @param nCap        Capacity `N_cap_q`.
 * @param baseImr     Base IMR (bps).
 * @param kinkBps     Kink u_k (bps).
 * @returns Dynamic IMR in bps or `null` (refused).
 * @example
 * ```ts
 * dynImrBps(720_000n, 1_000_000n, 1_000n, 5_000n); // 4960n
 * ```
 */
export function dynImrBps(lpAbsAfter: bigint, nCap: bigint, baseImr: Num, kinkBps: Num): bigint | null {
  const base = big("baseImr", baseImr);
  const kink = big("kinkBps", kinkBps);
  if (base < 0n || base > GROWTH_MAX_IMR_BPS || kink < 0n || kink > GROWTH_BPS) return null;
  if (nCap === 0n || lpAbsAfter > nCap) return null;
  const lhs = lpAbsAfter * GROWTH_BPS;
  const rhs = kink * nCap;
  if (lhs > U128_MAX || rhs > U128_MAX) return null;
  if (lhs <= rhs) return base;
  const span = GROWTH_MAX_IMR_BPS - base;
  const num = span * (lhs - rhs);
  const den = nCap * (GROWTH_BPS - kink);
  if (num > U128_MAX || den > U128_MAX) return null;
  const imr = base + divCeil(num, den);
  return imr > GROWTH_MAX_IMR_BPS ? GROWTH_MAX_IMR_BPS : imr;
}

/**
 * Capacity utilisation `u = |lp| / n_cap` in bps (floored, `lp*1e4 / n_cap`). Display only: the
 * gate itself compares exact integers (see {@link dynImrBps}).
 *
 * @param lpAbs  |LP| (Q).
 * @param nCap   Capacity (Q).
 * @returns bps (may exceed 10_000 when over capacity), or `null` when `nCap == 0`.
 * @example
 * ```ts
 * utilizationBps(720_000n, 1_000_000n); // 7200n
 * ```
 */
export function utilizationBps(lpAbs: bigint, nCap: bigint): bigint | null {
  if (nCap === 0n) return null;
  return (lpAbs * GROWTH_BPS) / nCap;
}

/**
 * Conservative equity `C_m = max(0, capital + min(pnl, 0) + min(feeCredits, 0))` (no credit for
 * positive PnL or positive fee credits).
 *
 * @param capital     LP capital (atoms).
 * @param pnl         LP PnL (signed).
 * @param feeCredits  LP fee credits (signed).
 * @returns Non-negative conservative equity.
 * @example
 * ```ts
 * conservativeEquity(1_000n, -200n, 0n); // 800n
 * ```
 */
export function conservativeEquity(capital: bigint, pnl: bigint, feeCredits: bigint): bigint {
  const c = capital + (pnl < 0n ? pnl : 0n) + (feeCredits < 0n ? feeCredits : 0n);
  return c > 0n ? c : 0n;
}

// ============================================================================
// v2.2 G8 + round 2 (R2.1): depth input, venue / book tiers, sticky cap, per-market tier table,
// epoch-clamp predicate, tier-driven ceiling.
// Mirrors percolator-prog `feat/v22-growth-tiers` @ 0607ef56 `src/growth_v19.rs` (exact integer
// semantics, bigint for u64 / u128) + engine `band_rent::band_worst_adverse_bps`.
// Plain-English model: ledger `v22-leverage-tiers-explainer-2026-10-14.md`.
// ============================================================================

/** G8: a depth reading older than this many slots counts as absent (`DEPTH_MAX_AGE_SLOTS`). */
export const DEPTH_MAX_AGE_SLOTS = 150n;
/** `AssetGrowthV19.depthSource` values (bits 0-1 of byte 44): 0 none, 1 keeper-attested (PushAuthMark mode 1), 2 on-chain DEX pool (mode 2). */
export const DEPTH_SOURCE = Object.freeze({ None: 0, Attested: 1, OnChainPool: 2 } as const);
/** `DEPTH_SOURCE_MASK`: the source bits of byte 44. */
export const DEPTH_SOURCE_MASK = 0x03;
/** `DEPTH_EVER` (byte 44 bit 7): a fresh effective depth was seen at least once (sticky; cleared only by the wrapper's restart reset). */
export const DEPTH_EVER = 0x80;
/**
 * `DEPTH_PREV_REAL` (byte 44 bit 2): the PREVIOUS sample (`depth_prev_e6`) was a REAL reading (source 1 or 2, a 0 included), not an absent one
 * (35 B push, mode 0, never). With the source bits (which say the same of the CURRENT sample) a real reading of 0 is told apart from "absent".
 */
export const DEPTH_PREV_REAL = 0x04;
/** PushAuthMark 44 B `depth_mode`: 0 none, 1 keeper-attested, 2 on-chain DEX pool (`depth_e6` must be 0, four trailing accounts). */
export const DEPTH_MODE = Object.freeze({ None: 0, Attested: 1, OnChainDex: 2 } as const);
/** One whole USD of 6-decimal collateral, in atoms. */
export const GROWTH_USD_ATOMS = 1_000_000n;
/** Protocol-default tier thresholds, whole USD of +-2% depth (T1, T2, T3): what a stored 0 means. */
export const TIER_THRESHOLD_DEFAULT_USD: readonly [number, number, number] = Object.freeze([25_000, 100_000, 500_000] as const);
/** Floors an explicit threshold may not go below (a creator cannot set $1 tiers), whole USD. */
export const TIER_THRESHOLD_FLOOR_USD: readonly [number, number, number] = Object.freeze([5_000, 20_000, 100_000] as const);
/** Protocol-default per-tier maximum leverage x100 (5x / 10x / 20x, before `min(.., L_tier)`): what a stored 0 means. */
export const TIER_LEVERAGE_DEFAULT_X100: readonly [number, number, number] = Object.freeze([500, 1_000, 2_000] as const);
/** `attested_max_tier` stored 0 = this default (1). */
export const ATTESTED_MAX_TIER_DEFAULT = 1;
/** Highest liquidity tier. */
export const GROWTH_MAX_TIER = 3;
/** The sticky cap halves once per this many slots of staleness (one ratchet epoch). */
export const DEPTH_STICKY_EPOCH_SLOTS = 9_000n;
/** Tier thresholds at the protocol defaults, USD e6 (round-1 name, kept). */
export const DEPTH_TIER_THRESHOLDS_E6: readonly [bigint, bigint, bigint] = Object.freeze([25_000_000_000n, 100_000_000_000n, 500_000_000_000n] as const);
/** Highest tier a keeper-attested depth can reach by default (`ATTESTED_MAX_TIER_DEFAULT`); the upgrade authority can raise it to 3 per market. */
export const DEPTH_ATTESTED_MAX_TIER = ATTESTED_MAX_TIER_DEFAULT;
/** `BOOK_DEPTH_BAND_BPS`: the band the book depth is measured in (+-2%). */
export const BOOK_DEPTH_BAND_BPS = 200;
/** `vault_lp_v18::PIN_TRADING_FEE_BPS` / `PIN_BASE_SPREAD_BPS` / `PIN_MAX_TOTAL_BPS` / `PIN_IMPACT_K_BPS`: the kind-2 matcher parameters tag 94 pins. */
export const GROWTH_PIN_TRADING_FEE_BPS = 10;
export const GROWTH_PIN_BASE_SPREAD_BPS = 10;
export const GROWTH_PIN_MAX_TOTAL_BPS = 100;
export const GROWTH_PIN_IMPACT_K_BPS = 50;
/** Engine `MAX_BAND_BPS`. */
export const BAND_MAX_BPS = 2_000n;
/** `RATCHET_STEP_X100` (+1x per ratchet epoch). */
export const GROWTH_RATCHET_STEP_X100 = 100;
/** `RATCHET_EPOCH_SLOTS` (~1 h). */
export const GROWTH_RATCHET_EPOCH_SLOTS = 9_000n;
/** Nominal slot time used only for "in ~N min" display (the chain targets 400 ms). */
export const GROWTH_SLOT_MS = 400;

/** A fixed-size triple (tier 1, 2, 3). */
export type Triple<T> = readonly [T, T, T];

/** Source bits (0 none, 1 attested, 2 DEX) of `depth_source`. */
export function depthSourceOf(depthSourceByte: number): number {
  return depthSourceByte & DEPTH_SOURCE_MASK;
}
/** Whether `DEPTH_EVER` is set. */
export function depthEver(depthSourceByte: number): boolean {
  return (depthSourceByte & DEPTH_EVER) !== 0;
}
/** Record validator: only bits 0-1 (source <= 2), bit 2 ({@link DEPTH_PREV_REAL}) and bit 7 may be set. */
export function depthSourceByteOk(depthSourceByte: number): boolean {
  return (depthSourceByte & ~(DEPTH_SOURCE_MASK | DEPTH_PREV_REAL | DEPTH_EVER) & 0xff) === 0 && depthSourceOf(depthSourceByte) <= DEPTH_SOURCE.OnChainPool;
}

/**
 * Effective depth: `min(depth, depthPrev)` (a one-push spike buys nothing), and 0 (absent) when either read is 0, the last push
 * is older than {@link DEPTH_MAX_AGE_SLOTS}, or `depthSlot` is after `now` (fail closed). Port of `effective_depth_e6`.
 *
 * @param depthE6      Stored depth (USD e6).
 * @param depthPrevE6  The depth before it.
 * @param depthSlot    Slot of the last push.
 * @param nowSlot      Current slot.
 * @returns Effective depth, 0n when absent.
 * @example
 * ```ts
 * effectiveDepthE6(30_000_000_000n, 28_000_000_000n, 1_000n, 1_100n); // 28_000_000_000n
 * ```
 */
export function effectiveDepthE6(depthE6: bigint, depthPrevE6: bigint, depthSlot: bigint, nowSlot: bigint): bigint {
  if (depthE6 === 0n || depthPrevE6 === 0n) return 0n;
  if (depthSlot > nowSlot || nowSlot - depthSlot > DEPTH_MAX_AGE_SLOTS) return 0n;
  return depthE6 < depthPrevE6 ? depthE6 : depthPrevE6;
}

/**
 * The FRESH reading the tiers and the capacity cap use (coordinator ruling "most conservative wins"). `null` = absent: stale (> 150 slots), a
 * future stamp, the current sample absent (35 B push / mode 0 / never: source bits none), or the first REAL sample of a pair (previous one
 * absent). Otherwise `min(current, previous)` where a REAL 0 counts as 0: a real reading of 0 (attested or DEX, depth 0) is `0n` AT ONCE;
 * a later positive reading restores a positive value only after its own min-of-two. Port of `fresh_depth_e6`.
 *
 * @param depthE6          Stored depth.
 * @param depthPrevE6      The depth before it.
 * @param depthSlot        Slot of the last push.
 * @param depthSourceByte  Byte 44 (source bits 0-1, {@link DEPTH_PREV_REAL} bit 2).
 * @param nowSlot          Current slot.
 * @returns The fresh reading (0n possible), or `null` when absent.
 * @example
 * ```ts
 * freshDepthE6(0n, 5n, 100n, 1 | DEPTH_PREV_REAL, 100n); // 0n: a real zero closes opens at once
 * freshDepthE6(0n, 5n, 100n, 0, 100n); // null: a 35 B push is absent, not zero
 * ```
 */
export function freshDepthE6(depthE6: bigint, depthPrevE6: bigint, depthSlot: bigint, depthSourceByte: number, nowSlot: bigint): bigint | null {
  if (depthSlot > nowSlot || nowSlot - depthSlot > DEPTH_MAX_AGE_SLOTS) return null;
  if (depthSourceOf(depthSourceByte) === DEPTH_SOURCE.None) return null;
  if (depthE6 === 0n) return 0n;
  if ((depthSourceByte & DEPTH_PREV_REAL) === 0) return null;
  return depthE6 < depthPrevE6 ? depthE6 : depthPrevE6;
}

/** The stored depth state of one asset (`AssetGrowthV19` bytes 44, 56..96). */
export interface DepthState {
  depthE6: bigint;
  depthSlot: bigint;
  depthPrevE6: bigint;
  /** Byte 44: bits 0-1 source of the stored depth (none = an absent sample), bit 2 {@link DEPTH_PREV_REAL}, bit 7 {@link DEPTH_EVER}. */
  depthSource: number;
  /** The RATE-LIMITED last good depth (R2-M1). */
  lastGoodE6: bigint;
  lastGoodSlot: bigint;
  /** R2-M1 / D-L2: stamp (`slot / 64`) of the last rise of `lastGoodE6` (bytes 114..118). */
  riseSlot64: number;
}

/**
 * The wrapper's depth writer (every PushAuthMark form). Port of `depth_push_update`. `source` none / unknown is an ABSENT sample; a REAL reading
 * (source 1 or 2) of 0 is a real zero depth. A later-slot push stores the new sample and the old one becomes `prev` (with {@link DEPTH_PREV_REAL}
 * = it was real); a same-slot (or earlier) push can only lower the stored depth, keeps `prev` (W-L2), and at a tie of zeros the real zero
 * beats an absent one. A fresh reading ({@link freshDepthE6}, a real 0 included) sets {@link DEPTH_EVER} and updates the last good depth to its
 * RATE-LIMITED value ({@link depthRateLimited}: down at once, up at most 2x per epoch, the first reading below T1), stamped with the sample's slot.
 *
 * @param st          Stored state.
 * @param source      The new reading's source (0 none, 1 attested, 2 DEX; others are absent).
 * @param newDepthE6  The new depth (ignored for an absent sample).
 * @param nowSlot     Authenticated slot of the push.
 * @param seedE6      The market's T1 in atoms minus 1 (`tierThresholdsE6(..)[0] - 1n`).
 * @returns The new state.
 * @example
 * ```ts
 * depthPushUpdate({ depthE6: 0n, depthSlot: 0n, depthPrevE6: 0n, depthSource: 0, lastGoodE6: 0n, lastGoodSlot: 0n, riseSlot64: 0 }, 1, 0n, 100n, 24_999_999_999n).lastGoodE6; // 0n, DEPTH_EVER set
 * ```
 */
export function depthPushUpdate(st: DepthState, source: number, newDepthE6: bigint, nowSlot: bigint, seedE6: bigint): DepthState {
  let src = source;
  let nd = newDepthE6;
  if (src === DEPTH_SOURCE.None || src > DEPTH_SOURCE.OnChainPool) { src = DEPTH_SOURCE.None; nd = 0n; }
  const oldSource = depthSourceOf(st.depthSource);
  const oldPrevReal = st.depthSource & DEPTH_PREV_REAL;
  let d: bigint, prev: bigint, slot: bigint, s: number, prevReal: number;
  if (st.depthSlot !== 0n && nowSlot <= st.depthSlot) {
    const takeNew = nd < st.depthE6 || (nd === 0n && st.depthE6 === 0n && src !== DEPTH_SOURCE.None && oldSource === DEPTH_SOURCE.None);
    if (takeNew) { d = nd; prev = st.depthPrevE6; slot = st.depthSlot; s = src; prevReal = oldPrevReal; }
    else { d = st.depthE6; prev = st.depthPrevE6; slot = st.depthSlot; s = oldSource; prevReal = oldPrevReal; }
  } else {
    d = nd; prev = st.depthE6; slot = nowSlot; s = src; prevReal = oldSource !== DEPTH_SOURCE.None ? DEPTH_PREV_REAL : 0;
  }
  const out: DepthState = { depthE6: d, depthSlot: slot, depthPrevE6: prev, depthSource: s | prevReal | (st.depthSource & DEPTH_EVER), lastGoodE6: st.lastGoodE6, lastGoodSlot: st.lastGoodSlot, riseSlot64: st.riseSlot64 };
  const f = freshDepthE6(d, prev, slot, out.depthSource, nowSlot);
  if (f !== null) {
    const lg = depthRateLimited(depthEver(st.depthSource), st.lastGoodE6, st.riseSlot64, f, slot, seedE6);
    out.depthSource |= DEPTH_EVER; out.lastGoodE6 = lg.lastGoodE6; out.lastGoodSlot = slot; out.riseSlot64 = lg.riseSlot64;
  }
  return out;
}

/**
 * Sticky depth (W-M1): `lastGood >> k`, `k = floor((now - lastGoodSlot) / 9000)`; 0 once `k >= 64`. A `lastGoodSlot` after `now`
 * reads as age 0. Port of `sticky_depth_e6`.
 *
 * @param lastGoodE6    `depth_last_good_e6`.
 * @param lastGoodSlot  `depth_last_good_slot`.
 * @param nowSlot       Current slot.
 * @returns The decayed depth (USD e6).
 * @example
 * ```ts
 * stickyDepthE6(150_000_000_000n, 0n, 18_000n); // 37_500_000_000n (two hours stale: a quarter)
 * ```
 */
export function stickyDepthE6(lastGoodE6: bigint, lastGoodSlot: bigint, nowSlot: bigint): bigint {
  const k = (nowSlot > lastGoodSlot ? nowSlot - lastGoodSlot : 0n) / DEPTH_STICKY_EPOCH_SLOTS;
  return k >= 64n ? 0n : lastGoodE6 >> k;
}

/**
 * The depth the capacity cap uses on a clamp-enforced market: a fresh reading ({@link freshDepthE6}; a real 0 caps at 0 at once); else, once
 * {@link DEPTH_EVER}, the sticky depth (the cap stays and decays towards 0, never "uncapped"); else `null` (never had a depth: no depth cap).
 * Port of `cap_depth_e6`.
 *
 * @param depthSourceByte  Byte 44.
 * @param fresh            {@link freshDepthE6} (`null` = absent).
 * @param lastGoodE6       `depth_last_good_e6`.
 * @param lastGoodSlot     `depth_last_good_slot`.
 * @param nowSlot          Current slot.
 * @returns Cap depth (USD e6) or `null` for no depth cap.
 * @example
 * ```ts
 * capDepthE6(0x81, null, 100_000_000_000n, 0n, 9_000n); // 50_000_000_000n
 * ```
 */
export function capDepthE6(depthSourceByte: number, fresh: bigint | null, lastGoodE6: bigint, lastGoodSlot: bigint, nowSlot: bigint): bigint | null {
  if (fresh !== null) return fresh;
  if (depthEver(depthSourceByte)) return stickyDepthE6(lastGoodE6, lastGoodSlot, nowSlot);
  return null;
}

/**
 * D-L1: the largest collateral decimals a GROWTH market accepts (`MAX_COLLATERAL_DECIMALS` = 12; InitMarket refuses more with 94
 * `GrowthInvalidConfig`; byte 46 holds decimals + 1 and the record validator bounds it at 13). Above it the tier thresholds and the depths they are
 * compared with saturate u64.
 */
export const GROWTH_MAX_COLLATERAL_DECIMALS = 12;

/**
 * D-L1: whether a collateral mint with `decimals` can carry a growth / band market.
 *
 * @param decimals  The collateral mint's decimals.
 * @returns `true` for 0..=12.
 * @example
 * ```ts
 * growthCollateralDecimalsOk(9); // true
 * growthCollateralDecimalsOk(13); // false: the wrapper answers 94
 * ```
 */
export function growthCollateralDecimalsOk(decimals: number): boolean {
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= GROWTH_MAX_COLLATERAL_DECIMALS;
}
/** `DEPTH_BOOTSTRAP_DIV`: the depth rate limiter's bootstrap floor is `T1 / 16` (the level a market climbs back to out of a real 0). */
export const DEPTH_BOOTSTRAP_DIV = 16n;

/** `collateral_decimals_of`: byte 46 is decimals + 1; 0 = a record written before R2-L2, read as 6. */
export function collateralDecimalsOf(storedP1: number): number {
  return storedP1 === 0 ? 6 : storedP1 - 1;
}

/** `whole_token_atoms`: `10^decimals` (decimals clamped to 18). */
export function wholeTokenAtoms(decimals: number): bigint {
  return 10n ** BigInt(Math.min(Math.max(decimals, 0), GROWTH_MAX_COLLATERAL_DECIMALS));
}

/** `DEPTH_RISE_STAMP_SLOTS`: the unit of the stored last-rise stamp (64 slots). */
export const DEPTH_RISE_STAMP_SLOTS = 64n;

/** `depth_rise_stamp`: the stored stamp of a rise at `slot`, `slot / 64`, saturating at u32::MAX. */
export function depthRiseStamp(slot: bigint): number {
  const e = slot / DEPTH_RISE_STAMP_SLOTS;
  return e > 0xffff_ffffn ? 0xffff_ffff : Number(e);
}

/**
 * D-L2: whether a new depth rise is allowed at `slot`: at least 9,000 slots after the LAST RISE, measured against the latest slot the stamp can stand
 * for (`stamp * 64 + 63`), so the window is never shorter than 9,000 slots whatever the rounding and independent of calendar-epoch boundaries. A
 * saturated stamp never opens the window (fails closed). Port of `depth_rise_window_open`.
 *
 * @param riseSlot64  Stored stamp ({@link AssetGrowthV19.depthRiseSlot64}).
 * @param slot        Slot of the new reading's sample.
 * @returns Whether a rise is allowed.
 * @example
 * ```ts
 * depthRiseWindowOpen(depthRiseStamp(8_999n), 9_000n); // false: a calendar boundary is not a window
 * ```
 */
export function depthRiseWindowOpen(riseSlot64: number, slot: bigint): boolean {
  const last = BigInt(riseSlot64) * DEPTH_RISE_STAMP_SLOTS + (DEPTH_RISE_STAMP_SLOTS - 1n);
  return riseSlot64 !== 0xffff_ffff && slot >= last + DEPTH_STICKY_EPOCH_SLOTS;
}

/**
 * R2-M1 + D-L2 ("up slowly, down at once" for the depth itself): the rate-limited last good depth after a FRESH reading `r` at `slot`. The market's FIRST
 * fresh reading (`ever` false) is `min(r, seed)` (tier 0 whatever the pool shows); `r <= lastGood` -> `r` at once (a real 0 included, the rise stamp is
 * kept); `r > lastGood` with the window open ({@link depthRiseWindowOpen}: >= 9,000 slots after the last rise) -> `min(r, max(2 * lastGood, seed / 16))`;
 * otherwise unchanged. `seed` = the market's T1 in atoms minus 1. Port of `depth_rate_limited`.
 *
 * @param ever        `DEPTH_EVER` already set.
 * @param lastGoodE6  Stored rate-limited depth.
 * @param riseSlot64  Stamp (`slot / 64`) of the last rise.
 * @param r           The fresh reading (collateral atoms).
 * @param slot        Slot of the reading's sample.
 * @param seedE6      T1 in atoms minus 1.
 * @returns `{ lastGoodE6, riseSlot64 }`.
 * @example
 * ```ts
 * depthRateLimited(true, 2_000_000_000n, 0, 500_000_000_000_000n, 9_063n, 24_999_999_999n); // { lastGoodE6: 4_000_000_000n, riseSlot64: 141 }
 * ```
 */
export function depthRateLimited(ever: boolean, lastGoodE6: bigint, riseSlot64: number, r: bigint, slot: bigint, seedE6: bigint): { lastGoodE6: bigint; riseSlot64: number } {
  const e = depthRiseStamp(slot);
  if (!ever) return { lastGoodE6: r < seedE6 ? r : seedE6, riseSlot64: e };
  if (r <= lastGoodE6) return { lastGoodE6: r, riseSlot64 };
  if (depthRiseWindowOpen(riseSlot64, slot)) {
    const doubled = (lastGoodE6 * 2n) > U64_MAX ? U64_MAX : lastGoodE6 * 2n;
    const floor = seedE6 / DEPTH_BOOTSTRAP_DIV;
    const up = doubled > floor ? doubled : floor;
    return { lastGoodE6: r < up ? r : up, riseSlot64: e };
  }
  return { lastGoodE6, riseSlot64 };
}

/**
 * The depth every reader uses (tiers and the capacity cap): `min(fresh reading, rate-limited last good)`; `null` while there is no fresh reading
 * (the sticky path then applies). Port of `usable_depth_e6`.
 *
 * @param fresh       {@link freshDepthE6}.
 * @param lastGoodE6  {@link AssetGrowthV19.depthLastGoodE6}.
 * @returns Usable depth or `null`.
 * @example
 * ```ts
 * usableDepthE6(500_000_000_000n, 25_000_000_000n); // 25_000_000_000n
 * ```
 */
export function usableDepthE6(fresh: bigint | null, lastGoodE6: bigint): bigint | null {
  return fresh === null ? null : fresh < lastGoodE6 ? fresh : lastGoodE6;
}

/**
 * R2-L1: the rent `N_cap` snapshot (0 means "not measured", rent 0). When the DEPTH cap is what makes N_cap 0 (a real 0 reading or a fully decayed
 * sticky cap) the snapshot is 1, so open interest pays the maximum rent, never 0. Otherwise `min(nCap, u64::MAX)`. Port of `rent_snapshot_n_cap_q`.
 *
 * @param nCapQ          N_cap in Q.
 * @param depthCapZero   The depth cap is 0.
 * @returns The snapshot.
 * @example
 * ```ts
 * rentSnapshotNCapQ(0n, true); // 1n (maximum rent)
 * ```
 */
export function rentSnapshotNCapQ(nCapQ: bigint, depthCapZero: boolean): bigint {
  if (nCapQ === 0n && depthCapZero) return 1n;
  return nCapQ > U64_MAX ? U64_MAX : nCapQ;
}

/**
 * Per-market thresholds in collateral ATOMS. The stored values are WHOLE COLLATERAL TOKENS (0 = default 25,000 / 100,000 / 500,000; $ on 6-decimal
 * USD collateral), scaled by `10^collateralDecimals` and saturating at u64::MAX. Port of `tier_thresholds` (R2-L2).
 *
 * @param storedTokens        `tier_threshold_usd` (T1, T2, T3), whole collateral tokens.
 * @param collateralDecimals  The collateral mint's decimals ({@link AssetGrowthV19.collateralDecimals}; default 6).
 * @returns Thresholds in collateral atoms.
 * @example
 * ```ts
 * tierThresholdsE6([0, 0, 0]); // [25_000_000_000n, 100_000_000_000n, 500_000_000_000n]
 * tierThresholdsE6([0, 0, 0], 9)[0]; // 25_000_000_000_000n
 * ```
 */
export function tierThresholdsE6(storedTokens: Triple<number | bigint>, collateralDecimals = 6): Triple<bigint> {
  const unit = wholeTokenAtoms(collateralDecimals);
  const t = (i: 0 | 1 | 2): bigint => {
    const s = BigInt(storedTokens[i]);
    const v = (s === 0n ? BigInt(TIER_THRESHOLD_DEFAULT_USD[i]) : s) * unit;
    return v > U64_MAX ? U64_MAX : v;
  };
  return [t(0), t(1), t(2)];
}

/**
 * Raw tier of a depth against thresholds: 0 below T1 (and always for 0), 1 from T1, 2 from T2, 3 from T3. Port of `depth_tier_for`.
 *
 * @param depthE6        Depth (USD e6).
 * @param thresholdsE6   {@link tierThresholdsE6}.
 * @returns 0..3.
 * @example
 * ```ts
 * depthTierFor(100_000_000_000n, tierThresholdsE6([0, 0, 0])); // 2
 * ```
 */
export function depthTierFor(depthE6: bigint, thresholdsE6: Triple<bigint>): number {
  if (depthE6 === 0n) return 0;
  const met = (t: bigint): boolean => t !== U64_MAX && depthE6 >= t; // D-L1: a saturated threshold is never met
  if (met(thresholdsE6[2])) return 3;
  if (met(thresholdsE6[1])) return 2;
  if (met(thresholdsE6[0])) return 1;
  return 0;
}

/** `attested_max_tier` in force: stored 0 = {@link ATTESTED_MAX_TIER_DEFAULT} (1), at most 3. Port of `attested_max_tier_eff`. */
export function attestedMaxTierEff(stored: number): number {
  return stored === 0 ? ATTESTED_MAX_TIER_DEFAULT : stored > GROWTH_MAX_TIER ? GROWTH_MAX_TIER : stored;
}

/**
 * Venue tier (how hard the price source is to move): from the EFFECTIVE depth and the stored depth's source. On-chain pool (2): no
 * cap. Keeper-attested (1): capped at `attested_max_tier` (default 1). None: 0. Port of `venue_tier`.
 *
 * @param effectiveDepth        {@link effectiveDepthE6}.
 * @param depthSourceByte       Byte 44 (the source is bits 0-1).
 * @param thresholdsE6          {@link tierThresholdsE6}.
 * @param attestedMaxTierStored `attested_max_tier` as stored (0 = default).
 * @returns 0..3.
 * @example
 * ```ts
 * venueTier(600_000_000_000n, 1, tierThresholdsE6([0, 0, 0]), 0); // 1 (attested depth is capped)
 * venueTier(600_000_000_000n, 2, tierThresholdsE6([0, 0, 0]), 0); // 3 (on-chain pool)
 * ```
 */
export function venueTier(effectiveDepth: bigint, depthSourceByte: number, thresholdsE6: Triple<bigint>, attestedMaxTierStored: number): number {
  const raw = depthTierFor(effectiveDepth, thresholdsE6);
  switch (depthSourceOf(depthSourceByte)) {
    case DEPTH_SOURCE.OnChainPool: return raw;
    case DEPTH_SOURCE.Attested: { const m = attestedMaxTierEff(attestedMaxTierStored); return raw > m ? m : raw; }
    default: return 0;
  }
}

/**
 * Book depth from the pinned matcher model (pure core of `book_depth_from_pins`): the notional the LP book fills within +-2% of the
 * oracle given its capacity notional. `maxTotal < 200` -> the whole capacity; else `fixed >= 200` -> 0; else
 * `min(cap, floor(D * (200 - fixed) / (k + 200 - fixed)))` with `D = 4 * cap` (saturating; a u128 product overflow reads 0).
 *
 * @param capE6         Capacity notional (atoms).
 * @param fixedBps      Base spread + trading fee (bps).
 * @param impactKBps    Matcher impact k (bps).
 * @param maxTotalBps   Matcher max total (bps).
 * @returns Book depth (atoms).
 * @example
 * ```ts
 * bookDepthFromPins(100_000_000_000n, 20, 50, 100); // 100_000_000_000n
 * ```
 */
export function bookDepthFromPins(capE6: bigint, fixedBps: number, impactKBps: number, maxTotalBps: number): bigint {
  if (maxTotalBps < BOOK_DEPTH_BAND_BPS) return capE6;
  if (fixedBps >= BOOK_DEPTH_BAND_BPS) return 0n;
  const room = BigInt(BOOK_DEPTH_BAND_BPS - fixedBps);
  const d4 = capE6 * GROWTH_DEPTH_MULT;
  const d = d4 > U128_MAX ? U128_MAX : d4;
  const prod = d * room;
  const n = prod > U128_MAX ? 0n : prod / (BigInt(impactKBps) + room);
  return n < capE6 ? n : capE6;
}

/**
 * The book's capacity notional for the book tier: `floor(C_m * min(storedLambda, 1x) / 1e4)`, computed overflow-free as the wrapper does
 * (monotone in `C_m`). Port of `book_capacity_e6`.
 *
 * @param cM                Conservative LP equity (atoms).
 * @param storedLambdaBps   `lambda_bps` as stored.
 * @returns Capacity notional (atoms).
 * @example
 * ```ts
 * bookCapacityE6(120_000_000_000n, 10_000); // 120_000_000_000n
 * ```
 */
export function bookCapacityE6(cM: bigint, storedLambdaBps: Num): bigint {
  const l = big("storedLambdaBps", storedLambdaBps);
  const lam = l < 10_000n ? l : 10_000n;
  return (cM / GROWTH_BPS) * lam + ((cM % GROWTH_BPS) * lam) / GROWTH_BPS;
}

/**
 * Book depth of the bound vault LP with conservative equity `cM`, from the pinned kind-2 parameters (fixed = 10 + 10 bps, k = 50, max
 * total 100): exactly {@link bookCapacityE6}. Saturates at u64::MAX. Port of `book_depth_e6`.
 *
 * @param cM               Conservative LP equity (atoms).
 * @param storedLambdaBps  `lambda_bps` as stored.
 * @returns Book depth (USD e6).
 * @example
 * ```ts
 * bookDepthE6(30_000_000_000n, 30_000); // 30_000_000_000n (lambda above 1x does not count)
 * ```
 */
export function bookDepthE6(cM: bigint, storedLambdaBps: Num): bigint {
  const b = bookDepthFromPins(bookCapacityE6(cM, storedLambdaBps), GROWTH_PIN_BASE_SPREAD_BPS + GROWTH_PIN_TRADING_FEE_BPS, GROWTH_PIN_IMPACT_K_BPS, GROWTH_PIN_MAX_TOTAL_BPS);
  return b > U64_MAX ? U64_MAX : b;
}

/** Book tier: {@link depthTierFor} of {@link bookDepthE6}. Port of `book_tier`. */
export function bookTier(cM: bigint, storedLambdaBps: Num, thresholdsE6: Triple<bigint>): number {
  return depthTierFor(bookDepthE6(cM, storedLambdaBps), thresholdsE6);
}

/** `tier = min(venue, book)`. Port of `combined_tier`. */
export function combinedTier(venue: number, book: number): number {
  return venue < book ? venue : book;
}

/**
 * Per-market leverage table x100 `[L0, L1, L2, L3]`. `L0 = min(L_launch, L_tier)`; `Li` is the stored value or `min(default_i, L_tier)`
 * when 0, clamped into `[L_{i-1}, L_tier]`, so it is monotone and never above `L_tier`. Port of `tier_leverage`.
 *
 * @param storedX100  `tier_leverage_x100` (L1, L2, L3; 0 = default).
 * @param lLaunchX100 Creator's launch leverage x100.
 * @param lTierX100   Protocol tier maximum x100 (from the engine IMR).
 * @returns The four-entry table.
 * @example
 * ```ts
 * tierLeverage([0, 0, 0], 500, 2000); // [500, 500, 1000, 2000]
 * ```
 */
export function tierLeverage(storedX100: Triple<number>, lLaunchX100: number, lTierX100: number): [number, number, number, number] {
  const launch = Math.min(lLaunchX100, lTierX100);
  const t: [number, number, number, number] = [launch, launch, launch, launch];
  let prev = launch;
  for (let i = 0; i < 3; i++) {
    let v = storedX100[i] === 0 ? (TIER_LEVERAGE_DEFAULT_X100[i] as number) : (storedX100[i] as number);
    if (v > lTierX100) v = lTierX100;
    if (v < prev) v = prev;
    t[i + 1] = v;
    prev = v;
  }
  return t;
}

/** `L_table(tier)` (tiers above 3 read as 3). Port of `l_table_x100`. */
export function lTableX100(tier: number, table: readonly [number, number, number, number]): number {
  return table[tier > GROWTH_MAX_TIER ? GROWTH_MAX_TIER : tier] as number;
}

/**
 * Tier-config bounds, exactly the wrapper's `tier_config_ok` (the setters refuse with 130 `GrowthTierConfigInvalid`). Each group is
 * all-zero (protocol defaults) or, with its zeros read as the defaults: thresholds `T1 < T2 < T3` and `>= $5k / $20k / $100k`; leverage
 * `L_launch <= L1 <= L2 <= L3 <= L_tier` (a 0 reads as `min(default, L_tier)`). Prefer {@link validateTierConfig} for messages.
 *
 * @param thresholdsUsd  T1, T2, T3 whole USD.
 * @param leverageX100   L1, L2, L3 x100.
 * @param lLaunchX100    Launch leverage x100.
 * @param lTierX100      Tier maximum x100.
 * @returns Whether the wrapper would accept the table.
 * @example
 * ```ts
 * tierConfigOk([5_000, 20_000, 100_000], [500, 1_000, 2_000], 500, 2_000); // true
 * tierConfigOk([1, 2, 3], [0, 0, 0], 500, 2_000); // false (below the floors)
 * ```
 */
export function tierConfigOk(thresholdsUsd: Triple<number>, leverageX100: Triple<number>, lLaunchX100: number, lTierX100: number): boolean {
  if (thresholdsUsd.some((v) => v !== 0)) {
    const w = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      w[i] = thresholdsUsd[i] === 0 ? (TIER_THRESHOLD_DEFAULT_USD[i] as number) : (thresholdsUsd[i] as number);
      if ((w[i] as number) < (TIER_THRESHOLD_FLOOR_USD[i] as number)) return false;
    }
    if (!((w[0] as number) < (w[1] as number) && (w[1] as number) < (w[2] as number))) return false;
  }
  if (leverageX100.some((v) => v !== 0)) {
    let prev = lLaunchX100;
    for (let i = 0; i < 3; i++) {
      const v = leverageX100[i] === 0 ? Math.min(TIER_LEVERAGE_DEFAULT_X100[i] as number, lTierX100) : (leverageX100[i] as number);
      if (v < prev || v > lTierX100) return false;
      prev = v;
    }
  }
  return true;
}

/** `attested_max_tier` bound: 0 (default) ..= 3. Port of `attested_max_tier_ok`. */
export function attestedMaxTierOk(v: number): boolean {
  return Number.isInteger(v) && v >= 0 && v <= GROWTH_MAX_TIER;
}

/** A tier block as on the wire (tag 94 bind block, tag 93 trailer). */
export interface TierConfig {
  /** T1, T2, T3 whole USD of +-2% depth (u32; 0 = protocol default $25k / $100k / $500k). */
  thresholdUsd: Triple<number>;
  /** L1, L2, L3 max leverage x100 (u16; 0 = default `min(5x / 10x / 20x, L_tier)`). */
  leverageX100: Triple<number>;
}

/**
 * Tag 94 merge rule: a stored (upgrade-authority preset) field that is non-zero is kept; a zero field takes the creator's value. The
 * merged table is then bounded by {@link tierConfigOk}. Port of `tier_config_merge_at_bind`.
 *
 * @param stored   The table already on the record.
 * @param creator  The creator's block.
 * @returns The merged table.
 * @example
 * ```ts
 * mergeTierConfigAtBind({ thresholdUsd: [0, 0, 0], leverageX100: [0, 0, 0] }, { thresholdUsd: [10_000, 0, 0], leverageX100: [0, 0, 0] }).thresholdUsd[0]; // 10000
 * ```
 */
export function mergeTierConfigAtBind(stored: TierConfig, creator: TierConfig): TierConfig {
  const m = (a: Triple<number>, b: Triple<number>): [number, number, number] => [a[0] === 0 ? b[0] : a[0], a[1] === 0 ? b[1] : a[1], a[2] === 0 ? b[2] : a[2]];
  return { thresholdUsd: m(stored.thresholdUsd, creator.thresholdUsd), leverageX100: m(stored.leverageX100, creator.leverageX100) };
}

/** One problem found by {@link validateTierConfig}. */
export interface TierConfigIssue {
  /** Which part is wrong. */
  field: "thresholds" | "leverage" | "attestedMaxTier" | "collateral";
  /** Machine code. */
  code: "not-an-integer" | "collateral-decimals" | "below-floor" | "not-rising" | "below-launch" | "above-market-maximum" | "out-of-range";
  /** Tier 1..3 the issue is about, when it is about one. */
  tier?: 1 | 2 | 3;
  /** Calm one-line message for the app (no bps, no x100). */
  message: string;
}

/** Input of {@link validateTierConfig}. */
export interface ValidateTierConfigInput {
  /** T1..T3 whole USD; omitted or all 0 = protocol defaults. */
  thresholdsUsd?: Triple<number>;
  /** L1..L3 x100; omitted or all 0 = defaults. */
  leverageX100?: Triple<number>;
  /** Creator's launch leverage x100. */
  lLaunchX100: number;
  /** The market's built-in maximum x100 (`floor(1e6 / engine IMR)`). */
  lTierX100: number;
  /** Optional `attested_max_tier` (upgrade authority only). */
  attestedMaxTier?: number;
  /**
   * R2-L2: the tier thresholds and floors are whole COLLATERAL TOKENS, scaled on chain by the collateral mint's decimals. Messages say "$" only when
   * the collateral is a 6-decimal USD-like token (`decimals === 6 && usdLike === true`); otherwise they say "tokens" (or `symbol`). The bounds
   * themselves do not depend on the decimals.
   */
  collateral?: { decimals?: number; usdLike?: boolean; symbol?: string };
}

/** Result of {@link validateTierConfig}. */
export interface TierConfigValidation {
  /** `true` iff the wrapper accepts the table (equals {@link tierConfigOk} and {@link attestedMaxTierOk}). */
  ok: boolean;
  issues: TierConfigIssue[];
}

const fmtAmount = (n: number, c: ValidateTierConfigInput["collateral"]): string =>
  c !== undefined && (c.decimals ?? 6) === 6 && c.usdLike === true ? `$${n.toLocaleString("en-US")}` : `${n.toLocaleString("en-US")} ${c?.symbol ?? "tokens"}`;
const lev = (x100: number): string => `${Number.isInteger(x100 / 100) ? x100 / 100 : (x100 / 100).toFixed(2).replace(/0+$/, "")}x`;

/**
 * Client-side check of a per-market tier table with the wrapper's exact bounds, so the app can show an error BEFORE signing (the chain
 * answers 130 `GrowthTierConfigInvalid`). Floors $5k / $20k / $100k, thresholds strictly rising, and `L_launch <= L1 <= L2 <= L3 <= L_tier`,
 * zeros read as the defaults, an all-zero group = defaults. `ok` is exactly the wrapper's verdict.
 *
 * @param i  See {@link ValidateTierConfigInput}.
 * @returns `{ ok, issues }`; each issue carries a calm one-line message.
 * @example
 * ```ts
 * validateTierConfig({ thresholdsUsd: [1_000, 20_000, 100_000], lLaunchX100: 500, lTierX100: 2_000 });
 * // { ok: false, issues: [{ field: "thresholds", code: "below-floor", tier: 1, message: "Tier 1 pool depth must be at least $5,000." }] }
 * ```
 */
export function validateTierConfig(i: ValidateTierConfigInput): TierConfigValidation {
  const issues: TierConfigIssue[] = [];
  if (i.collateral?.decimals !== undefined && !growthCollateralDecimalsOk(i.collateral.decimals)) {
    issues.push({ field: "collateral", code: "collateral-decimals", message: `This collateral has more than ${GROWTH_MAX_COLLATERAL_DECIMALS} decimals, so a leveraged market cannot use it.` });
  }
  const th = i.thresholdsUsd ?? [0, 0, 0];
  const lv = i.leverageX100 ?? [0, 0, 0];
  const isU = (v: number, max: number): boolean => Number.isInteger(v) && v >= 0 && v <= max;
  const tiers = [1, 2, 3] as const;
  let thOk = true;
  th.forEach((v, k) => { if (!isU(v, 0xffff_ffff)) { thOk = false; issues.push({ field: "thresholds", code: "not-an-integer", tier: tiers[k] as 1 | 2 | 3, message: `Tier ${k + 1} pool depth must be a whole number of ${i.collateral?.usdLike === true && (i.collateral.decimals ?? 6) === 6 ? "dollars" : (i.collateral?.symbol ?? "tokens")}.` }); } });
  let lvOk = true;
  lv.forEach((v, k) => { if (!isU(v, 0xffff)) { lvOk = false; issues.push({ field: "leverage", code: "not-an-integer", tier: tiers[k] as 1 | 2 | 3, message: `Tier ${k + 1} leverage must be a whole number of hundredths.` }); } });
  if (!isU(i.lLaunchX100, 0xffff) || !isU(i.lTierX100, 0xffff)) {
    lvOk = false;
    issues.push({ field: "leverage", code: "not-an-integer", message: "Launch leverage and the market maximum must be whole numbers." });
  }
  if (thOk && th.some((v) => v !== 0)) {
    const w = th.map((v, k) => (v === 0 ? (TIER_THRESHOLD_DEFAULT_USD[k] as number) : v));
    w.forEach((v, k) => {
      if (v < (TIER_THRESHOLD_FLOOR_USD[k] as number)) issues.push({ field: "thresholds", code: "below-floor", tier: tiers[k] as 1 | 2 | 3, message: `Tier ${k + 1} pool depth must be at least ${fmtAmount(TIER_THRESHOLD_FLOOR_USD[k] as number, i.collateral)}.` });
    });
    for (let k = 1; k < 3; k++) {
      if (!((w[k - 1] as number) < (w[k] as number))) issues.push({ field: "thresholds", code: "not-rising", tier: tiers[k] as 1 | 2 | 3, message: `Tier ${k + 1} pool depth must be higher than tier ${k}.` });
    }
  }
  if (lvOk && lv.some((v) => v !== 0)) {
    let prev = i.lLaunchX100;
    lv.forEach((raw, k) => {
      const v = raw === 0 ? Math.min(TIER_LEVERAGE_DEFAULT_X100[k] as number, i.lTierX100) : raw;
      if (v > i.lTierX100) issues.push({ field: "leverage", code: "above-market-maximum", tier: tiers[k] as 1 | 2 | 3, message: `Tier ${k + 1} leverage cannot exceed this market's maximum of ${lev(i.lTierX100)}.` });
      else if (v < prev) issues.push({ field: "leverage", code: k === 0 ? "below-launch" : "not-rising", tier: tiers[k] as 1 | 2 | 3, message: k === 0 ? `Tier 1 leverage cannot be below the launch leverage of ${lev(i.lLaunchX100)}.` : `Tier ${k + 1} leverage cannot be below tier ${k}'s ${lev(prev)}.` });
      prev = v;
    });
  }
  if (i.attestedMaxTier !== undefined && !attestedMaxTierOk(i.attestedMaxTier)) {
    issues.push({ field: "attestedMaxTier", code: "out-of-range", message: "The keeper-reported depth tier limit must be between 0 and 3." });
  }
  return { ok: issues.length === 0, issues };
}

/** `lambda_depth` (bps): 1x at tiers 0 and 1, 2x at tier 2, 3x at tier 3. */
export function lambdaDepthBps(tier: number): number {
  return tier >= 3 ? 30_000 : tier === 2 ? 20_000 : 10_000;
}

/** `kappa_depth` (bps of the depth): 0.5 at tier 0, 1 at tiers 1 and 2, 2 at tier 3. */
export function kappaDepthBps(tier: number): number {
  return tier >= 3 ? 20_000 : tier >= 1 ? 10_000 : 5_000;
}
/** Alias of {@link kappaDepthBps} (round-1 name). */
export const kappaDepth = kappaDepthBps;

/** `lambda_eff = min(stored lambda, lambda_depth(tier))`. Port of `lambda_eff_bps`. */
export function lambdaEffBps(storedLambdaBps: number, tier: number): number {
  return Math.min(storedLambdaBps, lambdaDepthBps(tier));
}

/**
 * Depth capacity notional `floor(kappa * depth / 1e4)` (atoms) of the cap depth; `null` = no depth cap. Port of `depth_notional_cap_e6`.
 *
 * @param tier      Combined tier.
 * @param capDepth  {@link capDepthE6}.
 * @returns Notional or `null`.
 * @example
 * ```ts
 * depthNotionalCapE6(2, 150_000_000_000n); // 150_000_000_000n
 * ```
 */
export function depthNotionalCapE6(tier: number, capDepth: bigint | null): bigint | null {
  return capDepth === null ? null : (capDepth * BigInt(kappaDepthBps(tier))) / GROWTH_BPS;
}

/** Depth cap on `N_cap` in engine Q (rounds down; `U128_MAX` only when there is no cap depth; 0 on a zero price). Port of `depth_cap_q`. */
export function depthCapQ(tier: number, capDepth: bigint | null, priceE6: bigint, posScale: bigint = GROWTH_POS_SCALE): bigint {
  const nd = depthNotionalCapE6(tier, capDepth);
  if (nd === null) return U128_MAX;
  return nCapQ(nd, 10_000, priceE6, posScale) ?? 0n;
}

/** Inputs of {@link nCapG8Q}. */
export interface NCapG8Input {
  /** Epoch clamp enforced on this market ({@link clampEnforced}). */
  clamp: boolean;
  /** Conservative LP equity (atoms). */
  cM: bigint;
  /** Stored lambda (bps). */
  lambdaBps: number;
  /** Combined tier (0 off the clamp). */
  tier: number;
  /** {@link capDepthE6} (fresh or sticky); `null` = no depth cap. */
  capDepth: bigint | null;
  priceE6: bigint;
  posScale?: bigint;
}

/**
 * G8 `N_cap`. Off a clamp-enforced market: exactly growth-1 `nCapQ(cM, stored lambda)`. On one: `min(nCapQ(cM, lambda_eff), depth cap)` with
 * the cap depth fresh or sticky (so a missing reading never lifts the cap). `null` where `nCapQ` is. Port of `n_cap_g8_q`.
 *
 * @param i  See {@link NCapG8Input}.
 * @returns Capacity in Q, or `null` (zero price / overflow).
 * @example
 * ```ts
 * nCapG8Q({ clamp: true, cM: 120_000_000_000n, lambdaBps: 20_000, tier: 2, capDepth: 150_000_000_000n, priceE6: 1_000_000n }); // 150_000_000_000n
 * ```
 */
export function nCapG8Q(i: NCapG8Input): bigint | null {
  const posScale = i.posScale ?? GROWTH_POS_SCALE;
  if (!i.clamp) return nCapQ(i.cM, i.lambdaBps, i.priceE6, posScale);
  const n = nCapQ(i.cM, lambdaEffBps(i.lambdaBps, i.tier), i.priceE6, posScale);
  if (n === null) return null;
  const d = depthCapQ(i.tier, i.capDepth, i.priceE6, posScale);
  return n < d ? n : d;
}

/**
 * G8 ext-v3 `(inventoryCapQ, liquidityNotionalE6)`. Off the clamp or with no cap depth: the growth-1 caps at the lambda {@link nCapG8Q}
 * uses. With a cap depth (fresh or sticky): `cap = min(N_cap(lambda_eff), depth cap, engine limit)` and the liquidity is
 * `DEPTH_MULT` times the SMALLER capacity notional. Port of `growth_matcher_caps_g8`.
 *
 * @param i  {@link NCapG8Input} plus `hlockActive` and the engine position limit (default {@link GROWTH_MAX_POSITION_ABS_Q}).
 * @returns Caps for {@link encodeMatcherCallExtV3}.
 * @example
 * ```ts
 * growthMatcherCapsG8({ clamp: true, hlockActive: false, cM: 1_000_000_000n, lambdaBps: 10_000, tier: 0, capDepth: null, priceE6: 1_000_000n });
 * ```
 */
export function growthMatcherCapsG8(i: NCapG8Input & { hlockActive: boolean; maxPositionAbsQ?: bigint }): MatcherCallExtCapsV3 {
  const posScale = i.posScale ?? GROWTH_POS_SCALE;
  const maxPos = i.maxPositionAbsQ ?? GROWTH_MAX_POSITION_ABS_Q;
  const g1 = (lam: number): MatcherCallExtCapsV3 => {
    if (i.hlockActive) return { inventoryCapQ: 0n, liquidityNotionalE6: 0n };
    const n = nCapQ(i.cM, lam, i.priceE6, posScale) ?? 0n;
    const cap = n > maxPos ? maxPos : n;
    if (cap === 0n) return { inventoryCapQ: 0n, liquidityNotionalE6: 0n };
    return { inventoryCapQ: cap, liquidityNotionalE6: liquidityNotionalE6(i.cM, lam) ?? 0n };
  };
  if (!i.clamp) return g1(i.lambdaBps);
  const lam = lambdaEffBps(i.lambdaBps, i.tier);
  const nd = depthNotionalCapE6(i.tier, i.capDepth);
  if (nd === null) return g1(lam);
  if (i.hlockActive) return { inventoryCapQ: 0n, liquidityNotionalE6: 0n };
  let cap = nCapG8Q(i) ?? 0n;
  if (cap > maxPos) cap = maxPos;
  if (cap === 0n) return { inventoryCapQ: 0n, liquidityNotionalE6: 0n };
  const liqCapital = liquidityNotionalE6(i.cM, lam) ?? 0n;
  const ld = nd * GROWTH_DEPTH_MULT;
  const liqDepth = ld > U128_MAX ? U128_MAX : ld;
  return { inventoryCapQ: cap, liquidityNotionalE6: liqCapital < liqDepth ? liqCapital : liqDepth };
}

/**
 * The engine's worst two-epoch adverse move for a band: `G(d) = ceil((1e4 + d)^2 / (1e4 - d)) - 1e4` bps
 * (engine `band_rent::band_worst_adverse_bps`; wrapper `band_r_gap_bps`).
 *
 * @param bandBps  Engine `band_bps` (1..=2000).
 * @returns `G(d)`, or `null` when `d` is out of range or `G` does not fit u16 (as the wrapper).
 * @example
 * ```ts
 * bandRGapBps(1_000n); // 3445n
 * ```
 */
export function bandRGapBps(bandBps: Num): bigint | null {
  const d = big("bandBps", bandBps);
  if (d <= 0n || d > BAND_MAX_BPS) return null;
  const num = (GROWTH_BPS + d) * (GROWTH_BPS + d);
  const g = divCeil(num, GROWTH_BPS - d) - GROWTH_BPS;
  return g > 0xffffn ? null : g;
}

/**
 * Is the epoch clamp program-enforced for this market? True iff the engine `band_bps != 0` and the stored growth
 * `r_gap_bps` equals `G(band_bps)` (a mismatch fails closed to "not enforced").
 *
 * @param bandBps  Engine `config.band_bps` (0 = no band).
 * @param rGapBps  `AssetGrowthV19.rGapBps`.
 * @returns Whether graduation, the loosening dials and the depth tiers are allowed on this market.
 * @example
 * ```ts
 * clampEnforced(1_000, 3445); // true
 * clampEnforced(0, 400); // false
 * ```
 */
export function clampEnforced(bandBps: Num, rGapBps: Num): boolean {
  const b = big("bandBps", bandBps);
  if (b === 0n) return false;
  const g = bandRGapBps(b);
  return g !== null && g === big("rGapBps", rGapBps);
}

/** Graduation in force: the clamp predicate, a band, and a tier >= 1 (`graduation_on`). */
export function graduationOn(clamp: boolean, bandBps: Num, tier: number): boolean {
  return clamp && big("bandBps", bandBps) !== 0n && tier >= 1;
}

/**
 * Live ceiling target (x100), R2.1 amendment: graduation on and no force-down: `min(L_tier, max(L_launch, L_table(tier)))`; otherwise
 * `min(L_launch, L_tier)`. The capital-doublings term is gone: the book tier is the capital term. Port of `target_ceiling_x100`.
 *
 * @param graduation     {@link graduationOn}.
 * @param forceDown      A draw outstanding, the h-lock latched, or ADL on either side.
 * @param lLaunchX100    Launch leverage x100.
 * @param lTierX100      Tier maximum x100.
 * @param lTableTierX100 `L_table(tier)` ({@link lTableX100}).
 * @returns Target x100.
 * @example
 * ```ts
 * targetCeilingX100(true, false, 500, 2_000, 1_000); // 1000
 * ```
 */
export function targetCeilingX100(graduation: boolean, forceDown: boolean, lLaunchX100: number, lTierX100: number, lTableTierX100: number): number {
  const launch = Math.min(lLaunchX100, lTierX100);
  if (!graduation || forceDown) return launch;
  return Math.min(Math.max(lTableTierX100, launch), lTierX100);
}

/**
 * Ceiling the gate applies (x100). Off the clamp: `min(L_launch, L_tier)` (growth-1). On it: `min(stored ratcheted ceiling, live target)`.
 * Port of `ceiling_in_force_x100`.
 *
 * @param clamp        {@link clampEnforced}.
 * @param storedCeilX100 `ceil_x100`.
 * @param targetX100   {@link targetCeilingX100}.
 * @param lLaunchX100  Launch leverage x100.
 * @param lTierX100    Tier maximum x100.
 * @returns Ceiling x100.
 * @example
 * ```ts
 * ceilingInForceX100(true, 700, 1_000, 500, 2_000); // 700
 * ```
 */
export function ceilingInForceX100(clamp: boolean, storedCeilX100: number, targetX100: number, lLaunchX100: number, lTierX100: number): number {
  if (!clamp) return Math.min(lLaunchX100, lTierX100);
  return Math.min(storedCeilX100, targetX100);
}

/**
 * Ratchet the stored ceiling toward a target: falls at once (stamped `now`), rises at most +1x per 9,000 slots, an unchanged ceiling keeps
 * its stamp; `forceDown` clamps the target to the floor. Port of `ratchet_ceiling_x100`.
 *
 * @param prevCeilX100 Stored ceiling x100.
 * @param prevSlot     Stored stamp.
 * @param targetX100   Target x100.
 * @param floorX100    Floor (launch) x100.
 * @param forceDown    Force the target down to the floor.
 * @param nowSlot      Current slot.
 * @returns `{ ceilX100, ceilSlot }`.
 * @example
 * ```ts
 * ratchetCeilingX100(500, 0n, 1_000, 500, false, 9_000n); // { ceilX100: 600, ceilSlot: 9000n }
 * ```
 */
export function ratchetCeilingX100(prevCeilX100: number, prevSlot: bigint, targetX100: number, floorX100: number, forceDown: boolean, nowSlot: bigint): { ceilX100: number; ceilSlot: bigint } {
  const target = forceDown && floorX100 < targetX100 ? floorX100 : targetX100;
  if (target === prevCeilX100) return { ceilX100: prevCeilX100, ceilSlot: prevSlot };
  if (target < prevCeilX100) return { ceilX100: target, ceilSlot: nowSlot };
  if (nowSlot >= (prevSlot + GROWTH_RATCHET_EPOCH_SLOTS > U64_MAX ? U64_MAX : prevSlot + GROWTH_RATCHET_EPOCH_SLOTS)) {
    const stepped = Math.min(prevCeilX100 + GROWTH_RATCHET_STEP_X100, 0xffff);
    return { ceilX100: stepped < target ? stepped : target, ceilSlot: nowSlot };
  }
  return { ceilX100: prevCeilX100, ceilSlot: prevSlot };
}

/** `MIN_C_LAUNCH_ATOMS`: the recorded launch capital is never below $1,000 of 6-decimal collateral. */
export const GROWTH_MIN_C_LAUNCH_ATOMS = 1_000_000_000n;
/** `c_launch_atoms_for(C_m)`: `max(C_m, $1,000)`. Recorded for the ledger; the R2.1 target no longer reads it. */
export function cLaunchAtomsFor(cM: bigint): bigint {
  return cM > GROWTH_MIN_C_LAUNCH_ATOMS ? cM : GROWTH_MIN_C_LAUNCH_ATOMS;
}

/**
 * The ratchet writer at a site with the bound LP's `C_m` in hand (clamp-enforced markets): `c_launch == 0` snapshots `c_launch` and
 * does not climb in that call (it can only fall to launch); otherwise ratchets toward {@link targetCeilingX100}. Port of `graduation_ratchet`.
 *
 * @returns `{ ceilX100, ceilSlot, cLaunchAtoms }`.
 * @example
 * ```ts
 * graduationRatchet({ prevCeilX100: 500, prevSlot: 0n, cLaunchAtoms: 1_000_000_000n, cM: 1n, graduation: true, forceDown: false, lLaunchX100: 500, lTierX100: 2_000, lTableTierX100: 1_000, nowSlot: 9_000n });
 * // { ceilX100: 600, ceilSlot: 9000n, cLaunchAtoms: 1000000000n }
 * ```
 */
export function graduationRatchet(i: {
  prevCeilX100: number; prevSlot: bigint; cLaunchAtoms: bigint; cM: bigint; graduation: boolean; forceDown: boolean;
  lLaunchX100: number; lTierX100: number; lTableTierX100: number; nowSlot: bigint;
}): { ceilX100: number; ceilSlot: bigint; cLaunchAtoms: bigint } {
  const launch = Math.min(i.lLaunchX100, i.lTierX100);
  if (i.cLaunchAtoms === 0n) {
    const cl = i.cM > 0n ? cLaunchAtomsFor(i.cM) : 0n;
    const c64 = cl > U64_MAX ? U64_MAX : cl;
    const hold = Math.min(launch, i.prevCeilX100);
    const r = ratchetCeilingX100(i.prevCeilX100, i.prevSlot, hold, launch, i.forceDown, i.nowSlot);
    return { ...r, cLaunchAtoms: c64 };
  }
  const target = targetCeilingX100(i.graduation, i.forceDown, i.lLaunchX100, i.lTierX100, i.lTableTierX100);
  return { ...ratchetCeilingX100(i.prevCeilX100, i.prevSlot, target, launch, i.forceDown, i.nowSlot), cLaunchAtoms: i.cLaunchAtoms };
}

/**
 * The fall-only ratchet (PushAuthMark: the depth changed, no `C_m` in hand). The caller passes the VENUE tier's graduation and
 * `L_table(venue tier)`, an upper bound of the real target, so the stored ceiling only ever falls here (stamped `now`). Port of `graduation_fall_only`.
 *
 * @returns `{ ceilX100, ceilSlot }`.
 */
export function graduationFallOnly(i: {
  prevCeilX100: number; prevSlot: bigint; graduation: boolean; forceDown: boolean; lLaunchX100: number; lTierX100: number; lTableTierX100: number; nowSlot: bigint;
}): { ceilX100: number; ceilSlot: bigint } {
  const upper = targetCeilingX100(i.graduation, i.forceDown, i.lLaunchX100, i.lTierX100, i.lTableTierX100);
  return upper < i.prevCeilX100 ? { ceilX100: upper, ceilSlot: i.nowSlot } : { ceilX100: i.prevCeilX100, ceilSlot: i.prevSlot };
}

/** Whole minutes (rounded up) for a slot count at the nominal 400 ms slot. */
function slotsToMinutes(slots: bigint): number {
  return Number(divCeil(slots * BigInt(GROWTH_SLOT_MS), 60_000n));
}

/**
 * R2-M1 + D-L2: slots until the rate-limited usable depth reaches `threshold` if the fresh readings stay at `fresh`: one doubling (floored at `seed / 16`) per
 * 9,000-slot window after the last rise (a rise lands on the first slot the window is open), capped at `fresh`; a market's first reading starts at `min(fresh, seed)`. `0n` = already there; `null` = never (fresh below
 * the threshold).
 */
function depthRateEtaSlots(ever: boolean, lastGood: bigint, riseSlot64: number, fresh: bigint, threshold: bigint, nowSlot: bigint, seed: bigint): bigint | null {
  if (fresh < threshold) return null;
  let cur = lastGood;
  let stamp = riseSlot64;
  if (!ever) { cur = fresh < seed ? fresh : seed; stamp = depthRiseStamp(nowSlot); }
  if (cur >= threshold) return 0n;
  let slot = nowSlot;
  for (let n = 0; n < 80; n++) {
    // the next rise happens at the first slot the window is open
    const open = BigInt(stamp) * DEPTH_RISE_STAMP_SLOTS + (DEPTH_RISE_STAMP_SLOTS - 1n) + DEPTH_STICKY_EPOCH_SLOTS;
    if (stamp === 0xffff_ffff) return null;
    if (open > slot) slot = open;
    const floor = seed / DEPTH_BOOTSTRAP_DIV;
    const doubled = cur * 2n;
    const up = doubled > floor ? doubled : floor;
    cur = fresh < up ? fresh : up;
    stamp = depthRiseStamp(slot);
    if (cur >= threshold) return slot - nowSlot;
  }
  return null;
}

/** What raises the ceiling next. */
export interface NextUnlock {
  /**
   * `depth`: only the pool depth is short. `backing`: only the market backing is short. `both`: both are short ("10x unlocks at $100k pool
   * depth and $100k market backing"). `ratchet`: the target is already higher; the ceiling climbs +1x per hour ("next step in ~N min").
   * `none`: nothing more to unlock (or graduation is off for this market).
   */
  kind: "depth" | "backing" | "both" | "ratchet" | "none";
  /** The liquidity tier whose requirements are named (`depth` / `backing` / `both`). */
  tier?: number;
  /** Pool depth the tier needs, in whole COLLATERAL TOKENS (the market's own threshold; $ on 6-decimal USD collateral). */
  depthUsd?: number;
  /** Market backing (LP equity) the tier needs, whole collateral tokens, rounded up; accounts for the market's lambda below 1x. */
  backingUsd?: number;
  /** Alias of the tier's pool-depth threshold (round-1 field), whole collateral tokens. */
  thresholdUsd?: number;
  /**
   * R2-M1: the pool depth is already there (the fresh reading reaches the threshold) but the rate limit still holds the usable depth below it (it
   * rises at most 2x per hour). `depthEtaSlots` / `depthEtaMinutes` then say when the usable depth reaches the threshold if the readings stay up.
   */
  depthRateLimited?: boolean;
  depthEtaSlots?: bigint;
  depthEtaMinutes?: number;
  /** The ceiling (x100) reached: at the tier unlock, or the next ratchet step. */
  leverageX100?: number;
  /**
   * True when keeper-reported depth can never reach this tier on this market (`attested_max_tier` is below it): the tier needs an
   * on-chain pool reading (SetDepthSource + PushAuthMark mode 2).
   */
  needsOnChainDepth?: boolean;
  /** `ratchet`: slots until the next step is allowed (0 = on the next write). */
  etaSlots?: bigint;
  /** `ratchet`: the same in whole minutes, rounded up (display "next step in about N min"). */
  etaMinutes?: number;
}

/** Everything derived from the growth record + band + depth + LP equity for the app. */
export interface GrowthCeilingView {
  /** Combined tier `min(venue, book)`; 0 off the clamp. */
  tier: number;
  venueTier: number;
  bookTier: number;
  /** Book depth of the bound LP ({@link bookDepthE6}); 0 when `cM` is unknown. */
  bookDepthE6: bigint;
  /** The USABLE depth ({@link usableDepthE6} = min(fresh reading, rate-limited last good); 0n when absent or a real zero). */
  effectiveDepthE6: bigint;
  /** The fresh min-of-two reading before the rate limit ({@link freshDepthE6}); `null` when absent. */
  freshDepthE6: bigint | null;
  /** The collateral mint's decimals the thresholds are scaled by. */
  collateralDecimals: number;
  /** The depth the capacity cap uses (fresh, sticky, or `null` for none). */
  capDepthE6: bigint | null;
  /** This market's thresholds in collateral atoms. */
  thresholdsE6: Triple<bigint>;
  /** This market's leverage table x100 `[L0, L1, L2, L3]`. */
  table: readonly [number, number, number, number];
  clampEnforced: boolean;
  /** Graduation above `L_launch` is allowed (clamp enforced and tier >= 1). */
  graduationOn: boolean;
  /** Live target before the stored-ratchet minimum. */
  targetX100: number;
  /** What the gate reads. */
  ceilingX100: number;
  /** The next thing that raises the ceiling: the ratchet step when the target is already higher, else the tier requirements. */
  nextUnlock: NextUnlock;
  /** The next tier's requirements regardless of the ratchet. */
  nextTierUnlock: NextUnlock;
}

/**
 * Derive tier, ceiling and next unlock for one asset, exactly as the wrapper's gate does: `tier = min(venue, book)` with the book tier
 * from `cM` and the stored lambda, the per-market thresholds and leverage table, and `ceiling = min(stored, target)` on a clamp-enforced market.
 *
 * @param g          Decoded growth record.
 * @param bandBps    Engine `band_bps`.
 * @param nowSlot    Current slot.
 * @param cM         Conservative LP equity (atoms), or `null` when the LP is not in hand (the book tier reads 0: never looser).
 * @param forceDown  Draw outstanding / h-lock / ADL.
 * @returns {@link GrowthCeilingView}.
 * @example
 * ```ts
 * const v = growthCeilingView(g, 1000, slot, cM, false);
 * if (v.nextUnlock.kind === "both") console.log(`${v.nextUnlock.leverageX100! / 100}x unlocks at $${v.nextUnlock.depthUsd} pool depth and $${v.nextUnlock.backingUsd} market backing`);
 * ```
 */
export function growthCeilingView(g: AssetGrowthV19, bandBps: number, nowSlot: bigint, cM: bigint | null, forceDown: boolean): GrowthCeilingView {
  const clamp = clampEnforced(bandBps, g.rGapBps);
  const unit = wholeTokenAtoms(g.collateralDecimals);
  const thresholds = tierThresholdsE6(g.tierThresholdUsd, g.collateralDecimals);
  const table = tierLeverage(g.tierLeverageX100, g.lLaunchX100, g.lTierX100);
  const dsByte = g.depthSource | (g.depthEver ? DEPTH_EVER : 0) | (g.depthPrevReal ? DEPTH_PREV_REAL : 0);
  const freshRaw = freshDepthE6(g.depthE6, g.depthPrevE6, g.depthSlot, dsByte, nowSlot);
  const fresh = usableDepthE6(freshRaw, g.depthLastGoodE6);
  const eff = fresh ?? 0n;
  const capDepth = clamp ? capDepthE6(dsByte, fresh, g.depthLastGoodE6, g.depthLastGoodSlot, nowSlot) : null;
  const venue = clamp ? venueTier(eff, dsByte, thresholds, g.attestedMaxTier) : 0;
  const bookD = cM === null ? 0n : bookDepthE6(cM, g.lambdaBps);
  const book = clamp && cM !== null ? depthTierFor(bookD, thresholds) : 0;
  const tier = clamp ? combinedTier(venue, book) : 0;
  const grad = graduationOn(clamp, bandBps, tier);
  const target = targetCeilingX100(grad, forceDown, g.lLaunchX100, g.lTierX100, lTableX100(tier, table));
  const launch = Math.min(g.lLaunchX100, g.lTierX100);
  const stored = g.ceilX100 === 0 ? launch : g.ceilX100;
  const ceiling = ceilingInForceX100(clamp, stored, target, g.lLaunchX100, g.lTierX100);

  let nextTierUnlock: NextUnlock = { kind: "none" };
  if (clamp && !forceDown) {
    for (let t = tier + 1; t <= GROWTH_MAX_TIER; t++) {
      const lev2 = targetCeilingX100(true, false, g.lLaunchX100, g.lTierX100, lTableX100(t, table));
      if (lev2 <= target) continue;
      const needDepth = venue < t;
      const needBacking = book < t;
      const depthAtoms = thresholds[t - 1] as bigint;
      const lam = BigInt(Math.min(g.lambdaBps, 10_000));
      const out: NextUnlock = { kind: needDepth && needBacking ? "both" : needDepth ? "depth" : "backing", tier: t, thresholdUsd: Number(depthAtoms / unit), leverageX100: lev2 };
      if (needDepth) out.depthUsd = Number(depthAtoms / unit);
      if (needBacking && lam > 0n) out.backingUsd = Number(divCeil(divCeil(depthAtoms * GROWTH_BPS, lam), unit));
      if (needDepth && t > attestedMaxTierEff(g.attestedMaxTier) && g.depthSource !== DEPTH_SOURCE.OnChainPool) out.needsOnChainDepth = true;
      // R2-M1: the pool depth is there but the rate limit holds the usable depth back: say when it gets there.
      const venueCanReach = depthSourceOf(dsByte) === DEPTH_SOURCE.OnChainPool || (depthSourceOf(dsByte) === DEPTH_SOURCE.Attested && t <= attestedMaxTierEff(g.attestedMaxTier));
      if (needDepth && venueCanReach && freshRaw !== null && freshRaw >= depthAtoms) {
        const eta = depthRateEtaSlots(g.depthEver, g.depthLastGoodE6, g.depthRiseSlot64, freshRaw, depthAtoms, nowSlot, thresholds[0] - 1n);
        if (eta !== null) { out.depthRateLimited = true; out.depthEtaSlots = eta; out.depthEtaMinutes = slotsToMinutes(eta); }
      }
      nextTierUnlock = out;
      break;
    }
  }
  let nextUnlock = nextTierUnlock;
  if (clamp && !forceDown && stored < target) {
    const step = Math.min(stored + GROWTH_RATCHET_STEP_X100, target);
    const due = g.ceilSlot + GROWTH_RATCHET_EPOCH_SLOTS;
    const eta = due > nowSlot ? due - nowSlot : 0n;
    nextUnlock = { kind: "ratchet", leverageX100: step, etaSlots: eta, etaMinutes: slotsToMinutes(eta) };
  }
  return { tier, freshDepthE6: freshRaw, collateralDecimals: g.collateralDecimals, venueTier: venue, bookTier: book, bookDepthE6: bookD, effectiveDepthE6: eff, capDepthE6: capDepth, thresholdsE6: thresholds, table, clampEnforced: clamp, graduationOn: grad, targetX100: target, ceilingX100: ceiling, nextUnlock, nextTierUnlock };
}

// ============================================================================
// quoteMaxLeverage
// ============================================================================

/** Inputs of {@link quoteMaxLeverage}. */
export interface QuoteMaxLeverageInput {
  /** Engine initial margin (bps) of the asset. */
  engineImrBps: bigint;
  /** Decoded growth record, or `null` when growth is OFF. */
  growth: AssetGrowthV19 | null;
  /** LP capital (atoms). */
  lpCapital: bigint;
  /** LP PnL (signed). */
  lpPnl: bigint;
  /** LP fee credits (signed). */
  lpFeeCredits: bigint;
  /** LP's ADL-effective signed position (Q). */
  lpEffectivePositionQ: bigint;
  /**
   * N-1 (wrapper re-verification fix): the asset has a BOUND P3 vault LP and the LP above IS it.
   * Growth opens are admitted only then (otherwise error 97 / 95); `false` => both sides closed.
   */
  assetBound: boolean;
  /** Asset `oi_eff_long_q` (engine, ADL-effective, includes the vault LP's own leg). */
  oiEffLongQ: bigint;
  /** Asset `oi_eff_short_q`. */
  oiEffShortQ: bigint;
  /** Oracle price (e6). */
  priceE6: bigint;
  /** The market's bankruptcy h-lock is latched: crowd side is closed (the thin side stays open). */
  bankruptcyHlockActive: boolean;
  /** Engine `POS_SCALE` (default 1_000_000n). */
  posScale?: bigint;
  /**
   * v2.2 growth: engine `band_bps` and the current slot. When present the quote applies the combined tier (lambda_eff, the fresh or sticky
   * kappa depth cap), graduation and the stored ratchet; when absent it is the growth-1 quote (`min(L_launch, L_tier)`, no depth).
   */
  v22?: { bandBps: number; nowSlot: bigint };
}

/** Why a side is closed. */
export type GrowthClosedReason = "hlock" | "capacity-zero" | "capacity-full" | "invalid-config" | "not-bound";

/** Result of {@link quoteMaxLeverage}. */
export interface MaxLeverageQuote {
  side: "long" | "short";
  /** The taker's fill on this side grows |LP| (LP short/flat for longs; LP long/flat for shorts). */
  crowd: boolean;
  /** `true` -> new risk on this side is refused (GrowthCapacityFull). */
  closed: boolean;
  closedReason: GrowthClosedReason | null;
  /** Max leverage x100 (550 = 5.5x); 0 when closed. */
  maxLeverageX100: number;
  /** The IMR (bps) the quote is based on: ceiling IMR (thin side) or the marginal dynamic IMR (crowd side). */
  imrBps: bigint | null;
  /**
   * `u = OI_users(this side) / N_cap` in bps (N-1: the users' open interest on this side, NOT the
   * LP's net); `null` when growth is off or capacity is 0.
   */
  utilizationBps: bigint | null;
  /** `N_cap_q`; `null` when growth is off or the price is 0. */
  nCapQ: bigint | null;
  /** Whether growth-v19 is on for this asset. */
  growthOn: boolean;
  /**
   * Marginal capacity on this side, `N_cap - OI_users(side)` (Q): the TradeCpi clip. 0 when this
   * side is closed, INCLUDING `OI_users == N_cap` (a fill landing exactly on N_cap is admitted at
   * u == 1, but no NEW room is left). Both sides have one since N-1. `null` when growth is off.
   */
  headroomQ: bigint | null;
  /**
   * M-1: always `true`. On a growth asset a strict reduce or close is never clipped or refused for
   * growth CAPACITY: not for N_cap, the LP floor, closed mode or the h-lock (the wrapper marks such
   * legs TAKER_REDUCING from the ADL-effective position). On a single TradeCpi a FLIP is clipped to
   * its closing part; the opening part needs a new order, which faces the gate. Every `closed`
   * above applies to NEW risk only. NOT a promise that every close fills: (a) the ENGINE's own
   * initial margin on the LP still applies (an LP that cannot carry the position refuses, Custom 49:
   * "the market maker can't take this close right now"), and (b) a NoCpi close into a counterparty
   * that OPENS is refused as a whole (95): close against the book (TradeCpi) instead.
   */
  reduceOnlyCapacityExempt: true;
  /**
   * N-2: the utilisation-fee rate (bps of the opening notional) at this side's CURRENT utilisation
   * (0 at or below the kink; `null` when growth is off or the side is closed). Any open pushes u up, so it
   * pays at least this: use {@link previewGrowthOpenFee} for the exact charge and the fee to sign.
   */
  utilisationFeeBps: number | null;
  /** v2.2: the ceiling in force (x100): `min(stored, live target)`; the growth-1 `min(L_launch, L_tier)` without `v22` input; 0 when growth is off. */
  ceilingX100: number;
  /** v2.2: liquidity tier 0..3 = `min(venue, book)` (0 without `v22` input). */
  tier: number;
  /** v2.2: the pool-depth (venue) tier and the market-backing (book) tier behind {@link MaxLeverageQuote.tier}. */
  venueTier: number;
  bookTier: number;
  /** v2.2: the depth the capacity cap used (fresh reading, or the decayed last good one after the readings stopped); `null` = none ever. */
  capDepthE6: bigint | null;
  /**
   * v2.2: what raises the ceiling next: the ratchet step when the target is already higher (`{ kind: "ratchet", leverageX100: 700, etaMinutes: 41 }`),
   * else the tier requirements, naming BOTH when both bind (`{ kind: "both", depthUsd: 100000, backingUsd: 100000, leverageX100: 1000 }`).
   */
  nextUnlock: NextUnlock;
  /** v2.2: the next tier's requirements regardless of any climb in progress. */
  nextTierUnlock: NextUnlock;
  /** v2.2: graduation above `L_launch` is allowed (clamp enforced and tier >= 1). */
  graduationOn: boolean;
}

/**
 * Quote the maximum leverage a taker can open on `side` right now.
 *
 * Crowd detection: taker long => the LP goes shorter. A side is "crowd" iff the taker's fill on it
 * grows |LP|: LP short or flat => longs crowd; LP long or flat => shorts crowd (a flat LP: both).
 * Ceiling `L_ceil = min(l_launch, l_tier)` growth-1; with `v22` input (clamp-enforced band market) `min(stored ratcheted ceiling, target)` where
 * `target = min(L_tier, max(L_launch, L_table(tier)))` and `tier = min(venue tier, book tier)` (R2.1; see {@link growthCeilingView}).
 * N-1 (wrapper re-verification fix): opens need the asset's BOUND vault LP (`assetBound`, else
 * closed "not-bound"), and capacity is the USERS' open interest on each side
 * (`usersSideOiQ`), capped at `N_cap` on BOTH sides, so `|LP| <= N_cap` after any sequence.
 * Thin side: `1e6 / ceilingImr`, closed when its users OI is at `N_cap`. Crowd side: closed if the
 * h-lock is active, `N_cap == 0` (also a zero price) or users OI `>= N_cap`; otherwise the MARGINAL
 * leverage at the current utilisation, `floor(1e6 / dynImr(OI_users, N_cap, base, kink))`.
 * Growth OFF => `floor(1e6 / engineImr)`.
 *
 * IMPORTANT: on-chain the check runs on the POST-TRADE users OI (`OI_users + fill`), and the
 * requirement is evaluated at that larger utilisation. This quote uses the current OI, so it is
 * an UPPER BOUND for any order that grows the crowd; a large order can be refused (92/93) even
 * when quoted. Reductions and closes are never checked, clipped or refused for capacity
 * (`reduceOnlyCapacityExempt`, with the two stated exceptions): `closed` means NEW risk on that
 * side only (a flip is clipped to its closing part on a single TradeCpi). Every risk-increasing
 * fill must face the bound vault LP (error 95), so NoCpi trades between two non-LPs can only reduce.
 *
 * @param input  Market/LP state (see {@link QuoteMaxLeverageInput}).
 * @param side   Taker side.
 * @returns {@link MaxLeverageQuote}.
 * @example
 * ```ts
 * const q = quoteMaxLeverage({ engineImrBps: 1000n, growth, lpCapital: 1_746_000_000n, lpPnl: 0n,
 *   lpFeeCredits: 0n, lpEffectivePositionQ: -720_000_000n, priceE6: 1_000_000n, bankruptcyHlockActive: false,
 *   assetBound: true, oiEffLongQ: 720_000_000n, oiEffShortQ: 720_000_000n }, "long");
 * q.maxLeverageX100; // marginal leverage x100
 * ```
 */
export function quoteMaxLeverage(input: QuoteMaxLeverageInput, side: "long" | "short"): MaxLeverageQuote {
  const lp = input.lpEffectivePositionQ;
  const crowd = side === "long" ? lp <= 0n : lp >= 0n;
  const g = input.growth;
  const e = input.engineImrBps;
  let meta: Partial<MaxLeverageQuote> = {};
  const out = (p: Partial<MaxLeverageQuote>): MaxLeverageQuote => ({
    side, crowd, closed: false, closedReason: null, maxLeverageX100: 0, imrBps: null,
    utilizationBps: null, nCapQ: null, growthOn: g !== null, headroomQ: null, reduceOnlyCapacityExempt: true, utilisationFeeBps: null,
    ceilingX100: 0, tier: 0, venueTier: 0, bookTier: 0, capDepthE6: null, nextUnlock: { kind: "none" }, nextTierUnlock: { kind: "none" }, graduationOn: false, ...meta, ...p,
  });
  const lev = (imr: bigint): number => {
    const l = leverageX100ForImrBps(imr);
    return l === null ? 0 : Number(l);
  };
  const closed = (reason: GrowthClosedReason, extra: Partial<MaxLeverageQuote> = {}): MaxLeverageQuote =>
    out({ closed: true, closedReason: reason, maxLeverageX100: 0, ...extra });

  if (g === null) {
    if (e === 0n || e > GROWTH_MAX_IMR_BPS) return closed("invalid-config");
    return out({ imrBps: e, maxLeverageX100: lev(e) });
  }
  const cM = conservativeEquity(input.lpCapital, input.lpPnl, input.lpFeeCredits);
  const view = input.v22 ? growthCeilingView(g, input.v22.bandBps, input.v22.nowSlot, cM, input.bankruptcyHlockActive) : null;
  const lCeil = view ? view.ceilingX100 : Math.min(g.lLaunchX100, g.lTierX100);
  meta = {
    ceilingX100: lCeil, tier: view?.tier ?? 0, venueTier: view?.venueTier ?? 0, bookTier: view?.bookTier ?? 0, capDepthE6: view?.capDepthE6 ?? null,
    nextUnlock: view?.nextUnlock ?? { kind: "none" }, nextTierUnlock: view?.nextTierUnlock ?? { kind: "none" }, graduationOn: view?.graduationOn ?? false,
  };
  const base = ceilingImrBps(e, lCeil);
  if (base === null) return closed("invalid-config");
  // N-1: growth opens only against the asset's BOUND vault LP (wrapper 97 / 95 otherwise).
  if (!input.assetBound) return closed("not-bound", { headroomQ: 0n });
  const nCap = view
    ? nCapG8Q({ clamp: view.clampEnforced, cM, lambdaBps: g.lambdaBps, tier: view.tier, capDepth: view.capDepthE6, priceE6: input.priceE6, posScale: input.posScale })
    : nCapQ(cM, g.lambdaBps, input.priceE6, input.posScale ?? GROWTH_POS_SCALE);
  // N-1: utilisation is the USERS' open interest on this side (the engine OI minus the vault
  // LP's own leg on it), the same number the wrapper gates on (`users_side_oi_q`).
  const usersOi = usersSideOiQ(side === "long" ? input.oiEffLongQ : input.oiEffShortQ, lp, side === "long");
  const util = nCap === null ? null : utilizationBps(usersOi, nCap);
  const info = { nCapQ: nCap, utilizationBps: util };

  if (crowd && input.bankruptcyHlockActive) return closed("hlock", { ...info, headroomQ: 0n });
  if (nCap === null || nCap === 0n) return closed("capacity-zero", { ...info, headroomQ: 0n });
  // OI_users == N_cap: the gate would still admit a fill landing exactly on N_cap, but there is
  // no marginal capacity left for NEW risk on this side (thin or crowd): report closed.
  if (usersOi >= nCap) return closed("capacity-full", { ...info, headroomQ: 0n });
  const utilisationFeeBps = utilisationFeeBps_(usersOi, nCap, g.kinkBps, utilFeeMaxEffectiveBps(g.utilFeeMaxBps));
  if (!crowd) return out({ ...info, imrBps: base, maxLeverageX100: lev(base), headroomQ: nCap - usersOi, utilisationFeeBps });
  const dyn = dynImrBps(usersOi, nCap, base, g.kinkBps);
  if (dyn === null) return closed("capacity-full", { ...info, headroomQ: 0n });
  return out({ ...info, imrBps: dyn, maxLeverageX100: lev(dyn), headroomQ: nCap - usersOi, utilisationFeeBps });
}

/**
 * N-1: the users' (everyone but the vault LP) ADL-effective open interest on one side. Port of
 * the wrapper's `users_side_oi_q` (saturating).
 *
 * @param oiEffSideQ     The asset's `oi_eff_long_q` (long) or `oi_eff_short_q` (short).
 * @param vaultLpEffQ    The vault LP's ADL-effective signed position.
 * @param longSide       Which side.
 * @returns Users OI on that side (Q).
 * @example
 * ```ts
 * usersSideOiQ(1_000n, 400n, true); // 600n (the LP's own long leg removed)
 * ```
 */
export function usersSideOiQ(oiEffSideQ: bigint, vaultLpEffQ: bigint, longSide: boolean): bigint {
  const onSide = longSide ? vaultLpEffQ > 0n : vaultLpEffQ < 0n;
  if (!onSide) return oiEffSideQ;
  const abs = vaultLpEffQ < 0n ? -vaultLpEffQ : vaultLpEffQ;
  return oiEffSideQ > abs ? oiEffSideQ - abs : 0n;
}

/**
 * N-2: the utilisation fee (bps) an open pays when it leaves its side's users OI at
 * `usersOiAfterQ`: 0 at or below the kink, `ceil(max * (u - u_k) / (1 - u_k))` above, capped at
 * `max`. Port of `growth_v19::utilisation_fee_bps`; `null` when `nCap == 0`.
 *
 * @param usersOiAfterQ  Users OI on the taker's side after the open (Q).
 * @param nCapQ          `N_cap` (Q).
 * @param kinkBps        The growth kink (bps).
 * @param maxFeeBps      The utilisation fee at u = 1 (`utilFeeMaxEffectiveBps(record)`).
 * @returns The fee in bps, or `null`.
 * @example
 * ```ts
 * utilisationFeeBps(700n, 1_000n, 5_000, 500); // 200
 * ```
 */
export function utilisationFeeBps(usersOiAfterQ: bigint, nCapQ: bigint, kinkBps: number, maxFeeBps: number): number | null {
  if (nCapQ === 0n || kinkBps > 10_000) return null;
  const lhs = usersOiAfterQ * 10_000n;
  const rhs = BigInt(kinkBps) * nCapQ;
  if (lhs <= rhs || maxFeeBps === 0) return 0;
  const fee = divCeil(BigInt(maxFeeBps) * (lhs - rhs), nCapQ * BigInt(10_000 - kinkBps));
  return fee > BigInt(maxFeeBps) ? maxFeeBps : Number(fee);
}

const utilisationFeeBps_ = (a: bigint, n: bigint, k: number, m: number): number | null => utilisationFeeBps(a, n, k, m);

/**
 * N-2: the utilisation-fee dial in force (a stored 0 means the protocol default).
 *
 * @param stored  `AssetGrowthV19.utilFeeMaxBps`.
 * @returns bps at u = 1.
 * @example
 * ```ts
 * utilFeeMaxEffectiveBps(0); // 500
 * ```
 */
export function utilFeeMaxEffectiveBps(stored: number): number {
  return stored === 0 ? GROWTH_UTIL_FEE_DEFAULT_BPS : stored;
}

/**
 * N-2: the OPENING part of a taker fill (`|after|` for a flip, `|after - before|` for an open or
 * grow, 0 for a reduce / close). Port of `growth_v19::opening_part_q`.
 *
 * @param beforeQ  Taker's ADL-effective position before (Q).
 * @param afterQ   After (Q).
 * @returns Opening part (Q).
 * @example
 * ```ts
 * openingPartQ(-100n, 50n); // 50n
 * ```
 */
export function openingPartQ(beforeQ: bigint, afterQ: bigint): bigint {
  const abs = (x: bigint) => (x < 0n ? -x : x);
  const reduces = afterQ === 0n || (beforeQ !== 0n && (beforeQ > 0n) === (afterQ > 0n) && abs(afterQ) <= abs(beforeQ));
  if (reduces) return 0n;
  if (beforeQ !== 0n && (beforeQ > 0n) !== (afterQ > 0n)) return abs(afterQ);
  return abs(afterQ - beforeQ);
}

/** Result of {@link previewGrowthOpenFee}. */
export interface GrowthOpenFeePreview {
  /** The opening part of the order (Q); 0 for a close / reduce. */
  openingQ: bigint;
  /** Users OI on the order's side after it fills (Q). */
  usersOiAfterQ: bigint;
  /** Utilisation fee as a rate on the WHOLE fill (bps), exactly what the wrapper charges. */
  utilFeeBps: number;
  /**
   * Minimum `fee_bps` the taker must sign on TradeCpi for this order, excluding the matcher's own
   * requested fee (add up to {@link GROWTH_PIN_MAX_REQUESTED_FEE_BPS} for the kind-2 quote).
   */
  minSignedFeeBpsExMatcher: bigint;
  /** A BatchTradeCpi leg with `utilFeeBps > 0` is refused (99): use TradeCpi. */
  batchAllowed: boolean;
}

/**
 * N-2 fee preview for a growth open on a BOUND asset (the vault LP is the counterparty): the
 * utilisation fee the wrapper will charge and the fee the taker must sign. Closes / reduces never
 * pay it. Evaluated at the CURRENT N_cap and users OI (the wrapper uses the same pre-fill numbers).
 *
 * @param input        The quote inputs (see {@link QuoteMaxLeverageInput}).
 * @param takerEffQ    Taker's ADL-effective signed position on the asset (Q).
 * @param sizeQ        Signed order size (Q).
 * @param tradeFeeBaseBps  The market's `trade_fee_base_bps`.
 * @returns {@link GrowthOpenFeePreview}.
 * @example
 * ```ts
 * const p = previewGrowthOpenFee(input, 0n, 100_000_000n, 30n);
 * p.minSignedFeeBpsExMatcher; // 30 + utilisation fee
 * ```
 */
export function previewGrowthOpenFee(input: QuoteMaxLeverageInput, takerEffQ: bigint, sizeQ: bigint, tradeFeeBaseBps: bigint): GrowthOpenFeePreview {
  const g = input.growth;
  const afterQ = takerEffQ + sizeQ;
  const openingQ = openingPartQ(takerEffQ, afterQ);
  const long = afterQ > 0n;
  const usersBefore = usersSideOiQ(long ? input.oiEffLongQ : input.oiEffShortQ, input.lpEffectivePositionQ, long);
  const usersOiAfterQ = usersBefore + openingQ;
  let utilFeeBps = 0;
  if (g !== null && input.assetBound && openingQ > 0n) {
    const cM = conservativeEquity(input.lpCapital, input.lpPnl, input.lpFeeCredits);
    const nCap = nCapQ(cM, g.lambdaBps, input.priceE6, input.posScale ?? GROWTH_POS_SCALE);
    const f = nCap === null ? 0 : (utilisationFeeBps(usersOiAfterQ, nCap, g.kinkBps, utilFeeMaxEffectiveBps(g.utilFeeMaxBps)) ?? 0);
    const fill = sizeQ < 0n ? -sizeQ : sizeQ;
    const o = openingQ > fill ? fill : openingQ;
    utilFeeBps = fill === 0n ? 0 : Number((BigInt(f) * o) / fill);
  }
  return {
    openingQ,
    usersOiAfterQ,
    utilFeeBps,
    minSignedFeeBpsExMatcher: tradeFeeBaseBps + BigInt(utilFeeBps),
    batchAllowed: utilFeeBps === 0,
  };
}

/**
 * L-2 floor on the creator-declared `r_gap`: `max_price_move_bps_per_slot * 50`. Port of
 * `r_gap_floor_bps` (the wrapper fails closed on u64 overflow; so does this).
 *
 * @param maxPriceMoveBpsPerSlot  Engine per-slot price limit (bps).
 * @returns The minimum `r_gap_bps`.
 * @example
 * ```ts
 * rGapFloorBps(4n); // 200n
 * ```
 */
export function rGapFloorBps(maxPriceMoveBpsPerSlot: bigint): bigint {
  const f = maxPriceMoveBpsPerSlot * R_GAP_MIN_LIQUIDATION_SLOTS;
  if (maxPriceMoveBpsPerSlot < 0n || f > U64_MAX) throw new Error("r_gap floor overflows u64 (wrapper fails closed)");
  return f;
}

/**
 * Client guard for the batch cap: a BatchTradeCpi carrying any growth leg is refused above
 * {@link GROWTH_BATCH_MAX_LEGS} legs (every leg then sends the 72-byte ext v3; CU headroom).
 *
 * @param legCount        Number of legs in the batch.
 * @param anyGrowthLeg    Whether at least one leg's asset has growth ON.
 * @returns void; throws when the wrapper would refuse (96 GrowthBatchTooManyLegs).
 * @example
 * ```ts
 * assertGrowthBatchLegs(11, true); // throws
 * ```
 */
export function assertGrowthBatchLegs(legCount: number, anyGrowthLeg: boolean): void {
  if (anyGrowthLeg && legCount > GROWTH_BATCH_MAX_LEGS) throw new Error(`a batch with a growth leg is limited to ${GROWTH_BATCH_MAX_LEGS} legs, got ${legCount} (wrapper error 96 GrowthBatchTooManyLegs)`);
}

// ============================================================================
// Instruction encoders
// ============================================================================

function u16nz(name: string, v: number): void {
  if (!Number.isInteger(v) || v <= 0 || v > 0xffff) throw new Error(`${name} must be a non-zero u16, got ${v}`);
}

/**
 * Tag 0 InitMarket with the growth trailer: the existing {@link encodeInitMarket} bytes followed by
 * `u16 r_gap_bps` and `u16 l_launch_x100` (both must be non-zero, else the wrapper returns
 * InvalidInstructionData). Without the trailer tag 0 is byte-for-byte legacy.
 *
 * @param args           InitMarket arguments (same as {@link encodeInitMarket}).
 * @param rGapBps        Worst move between liquidation opportunities (bps), > 0.
 * @param lLaunchX100    Creator's starting leverage cap x100, > 0 (program also bounds it to the tier).
 * @param collateralDecimals  Optional: the collateral mint's decimals; more than 12 throws (D-L1, the wrapper answers 94).
 * @returns Legacy bytes + 4 trailer bytes.
 * @example
 * ```ts
 * const data = encodeInitMarketV19(args, 500, 550);
 * ```
 */
export function encodeInitMarketV19(args: InitMarketV17Args | InitMarketArgs, rGapBps: number, lLaunchX100: number, collateralDecimals?: number): Uint8Array {
  if (collateralDecimals !== undefined && !growthCollateralDecimalsOk(collateralDecimals)) throw new Error(`collateral with ${collateralDecimals} decimals cannot carry a growth market (max ${GROWTH_MAX_COLLATERAL_DECIMALS}); the wrapper answers 94 GrowthInvalidConfig`);
  u16nz("rGapBps", rGapBps);
  u16nz("lLaunchX100", lLaunchX100);
  const legacy = encodeInitMarket(args);
  // Wrapper rule (`init_margin_rule_ok`, L-2): r_gap >= max_price_move_bps_per_slot * 50 and
  // MMR >= r_gap + liquidation_fee_bps. Read both inputs back from the encoded bytes so every args
  // shape (v17 and the v12 compat shim) is checked identically.
  const dv = new DataView(legacy.buffer, legacy.byteOffset, legacy.byteLength);
  const mmr = dv.getBigUint64(INIT_MARKET_MMR_OFF, true);
  const liqFee = dv.getBigUint64(INIT_MARKET_LIQ_FEE_OFF, true);
  const move = dv.getBigUint64(INIT_MARKET_MAX_PRICE_MOVE_OFF, true);
  const floor = rGapFloorBps(move);
  if (BigInt(rGapBps) < floor) throw new Error(`rGapBps ${rGapBps} is below the floor ${floor} (= maxPriceMoveBpsPerSlot ${move} * ${R_GAP_MIN_LIQUIDATION_SLOTS}); the wrapper refuses with GrowthInvalidConfig (94)`);
  if (mmr < BigInt(rGapBps) + liqFee) throw new Error(`maintenanceMarginBps ${mmr} must be >= rGapBps ${rGapBps} + liquidationFeeBps ${liqFee}; the wrapper refuses with GrowthInvalidConfig (94)`);
  return concatBytes(legacy, encU16(rGapBps), encU16(lLaunchX100));
}

/**
 * Tag 94 InitVaultLp with the growth trailer: `[94, u16 junior_floor_bps, u16 l_launch_x100]`
 * (5 bytes; `l_launch_x100` non-zero). Writes the creator's launch cap at bind on a growth asset.
 *
 * @param juniorFloorBps  Junior floor bps (the wrapper enforces its own range).
 * @param lLaunchX100     Starting leverage cap x100, > 0.
 * @returns 5 bytes.
 * @example
 * ```ts
 * encodeInitVaultLpV19(2000, 550); // [94, 0xd0, 0x07, 0x26, 0x02]
 * ```
 */
export function encodeInitVaultLpV19(juniorFloorBps: number, lLaunchX100: number): Uint8Array {
  if (!Number.isInteger(juniorFloorBps) || juniorFloorBps < 0 || juniorFloorBps > 0xffff) {
    throw new Error(`juniorFloorBps must be a u16, got ${juniorFloorBps}`);
  }
  u16nz("lLaunchX100", lLaunchX100);
  return concatBytes(encU8(IX_TAG_P3.InitVaultLp), encU16(juniorFloorBps), encU16(lLaunchX100));
}

/**
 * Tag 93 SetAssetRiskLimitsV19 (growth dials only, upgrade-authority). Wire: `[93, asset_index u16]`,
 * then the rest of the 44-byte legacy body (incl. tag) ALL ZERO (it exists only for wire disambiguation: the wrapper refuses
 * a non-zero body with Custom(9), never applies it, and a dial change leaves the asset's risk limits
 * untouched), then `u32 growth_lambda_bps` + `u16 growth_kink_bps`: 50 bytes including the tag.
 *
 * Bounds enforced client-side (= wrapper `growth_dials_ok(false, ..)`, no epoch clamp):
 * lambda in [1, 10_000], kink in [0, 5_000].
 *
 * @param assetIndex  Asset slot (must be a growth-enabled asset on-chain).
 * @param lambdaBps   `lambda_bps`, 1..=10_000.
 * @param kinkBps     Kink u_k, 0..=5_000.
 * @returns 50 bytes.
 * @example
 * ```ts
 * encodeSetAssetRiskLimitsV19(0, 10_000, 5_000);
 * ```
 */
export function encodeSetAssetRiskLimitsV19(assetIndex: number, lambdaBps: number, kinkBps: number, utilFeeMaxBps = 0): Uint8Array {
  if (!Number.isInteger(assetIndex) || assetIndex < 0 || assetIndex > 0xffff) throw new Error(`assetIndex must be a u16, got ${assetIndex}`);
  if (!Number.isInteger(lambdaBps) || lambdaBps < 1 || lambdaBps > GROWTH_DIALS_NO_CLAMP_MAX_LAMBDA_BPS) throw new Error(`lambdaBps must be in 1..=${GROWTH_DIALS_NO_CLAMP_MAX_LAMBDA_BPS}, got ${lambdaBps}`);
  if (!Number.isInteger(kinkBps) || kinkBps < 0 || kinkBps > GROWTH_DIALS_NO_CLAMP_MAX_KINK_BPS) throw new Error(`kinkBps must be in 0..=${GROWTH_DIALS_NO_CLAMP_MAX_KINK_BPS}, got ${kinkBps}`);
  if (!Number.isInteger(utilFeeMaxBps) || (utilFeeMaxBps !== 0 && (utilFeeMaxBps < GROWTH_UTIL_FEE_DEFAULT_BPS || utilFeeMaxBps > GROWTH_UTIL_FEE_HARD_MAX_BPS))) {
    throw new Error(`utilFeeMaxBps must be 0 (unchanged) or in ${GROWTH_UTIL_FEE_DEFAULT_BPS}..=${GROWTH_UTIL_FEE_HARD_MAX_BPS} (tighten-only), got ${utilFeeMaxBps}`);
  }
  const out = concatBytes(
    encU8(IX_TAG_P1.SetAssetRiskLimits), encU16(assetIndex), new Uint8Array(41),
    encU32(lambdaBps), encU16(kinkBps),
    ...(utilFeeMaxBps === 0 ? [] : [encU16(utilFeeMaxBps)]),
  );
  if (out.length !== (utilFeeMaxBps === 0 ? 50 : 52)) throw new Error(`encodeSetAssetRiskLimitsV19: internal length ${out.length}`);
  return out;
}

/** Wire length of a tier block: `[T1 u32][T2 u32][T3 u32][L1 u16][L2 u16][L3 u16]` (`TIER_CONFIG_WIRE_LEN`). */
export const TIER_CONFIG_WIRE_LEN = 18;
/** Length of the tag 93 growth trailer with the tier block: `[lambda u32][kink u16][util_fee u16]` + tier block + `attested_max_tier u8`. */
export const SET_ASSET_RISK_LIMITS_TIERS_TRAILER_LEN = 27;

function encTierBlock(t: TierConfig): Uint8Array {
  const wrongU32 = t.thresholdUsd.find((v) => !Number.isInteger(v) || v < 0 || v > 0xffff_ffff);
  if (wrongU32 !== undefined) throw new Error(`tier thresholds must be u32 whole USD, got ${wrongU32}`);
  const wrongU16 = t.leverageX100.find((v) => !Number.isInteger(v) || v < 0 || v > 0xffff);
  if (wrongU16 !== undefined) throw new Error(`tier leverage must be u16 x100, got ${wrongU16}`);
  return concatBytes(...t.thresholdUsd.map((v) => encU32(v)), ...t.leverageX100.map((v) => encU16(v)));
}

/**
 * Tag 94 InitVaultLp with the growth trailer AND the creator's tier block: `[94, junior_floor u16, l_launch_x100 u16, T1 u32, T2 u32,
 * T3 u32, L1 u16, L2 u16, L3 u16]` (23 bytes). Merged field by field under any upgrade-authority preset (a non-zero preset field is kept) and
 * bounded by the wrapper's `tier_config_ok`, else 130 `GrowthTierConfigInvalid` (the bind reverts). The creator can never set `attested_max_tier`.
 * Throws client-side on a table {@link validateTierConfig} refuses (given `lTierX100`, pass it to check before signing).
 *
 * @param juniorFloorBps  Junior floor bps (u16).
 * @param lLaunchX100     Starting leverage cap x100, > 0.
 * @param tiers           T1..T3 whole USD and L1..L3 x100 (0 = protocol default).
 * @param lTierX100       Optional: the market's built-in maximum x100; when given the table is validated before it is encoded.
 * @returns 23 bytes.
 * @example
 * ```ts
 * encodeInitVaultLpV22Tiers(2000, 500, { thresholdUsd: [25_000, 100_000, 500_000], leverageX100: [500, 1_000, 2_000] }, 2_000);
 * ```
 */
export function encodeInitVaultLpV22Tiers(juniorFloorBps: number, lLaunchX100: number, tiers: TierConfig, lTierX100?: number): Uint8Array {
  if (!Number.isInteger(juniorFloorBps) || juniorFloorBps < 0 || juniorFloorBps > 0xffff) throw new Error(`juniorFloorBps must be a u16, got ${juniorFloorBps}`);
  u16nz("lLaunchX100", lLaunchX100);
  const block = encTierBlock(tiers);
  if (lTierX100 !== undefined) {
    const v = validateTierConfig({ thresholdsUsd: tiers.thresholdUsd, leverageX100: tiers.leverageX100, lLaunchX100, lTierX100 });
    if (!v.ok) throw new Error(`tier table refused (the wrapper answers 130 GrowthTierConfigInvalid): ${v.issues.map((x) => x.message).join(" ")}`);
  }
  return concatBytes(encU8(IX_TAG_P3.InitVaultLp), encU16(juniorFloorBps), encU16(lLaunchX100), block);
}

/**
 * Tag 93 SetAssetRiskLimitsV22Tiers (upgrade authority): the dials AND the per-market tier table AND `attested_max_tier`. Wire: `[93,
 * asset_index u16]`, 41 zero bytes (the legacy body, never applied), then the 27-byte trailer `[lambda u32][kink u16][util_fee_max u16 (0 =
 * unchanged)][T1 u32][T2 u32][T3 u32][L1 u16][L2 u16][L3 u16][attested_max_tier u8]`: 71 bytes. The table is REPLACED as given (0 = default);
 * a change never jumps the ceiling (it moves the target, the ratchet climbs +1x per hour, down is at once). The wrapper bounds the dials
 * with its band-aware box (this encoder only checks the u32 / u16 ranges and `lambda >= 1`); the table with `tier_config_ok` and
 * `attested_max_tier <= 3`, else 130. Pass `lTierX100` to check the table before signing.
 *
 * @param assetIndex       Asset slot.
 * @param lambdaBps        `lambda_bps` (u32, >= 1; the wrapper's box is band-dependent).
 * @param kinkBps          Kink u_k (u16).
 * @param tiers            Tier table (T1..T3 whole USD, L1..L3 x100; 0 = default).
 * @param attestedMaxTier  0 (default 1) ..= 3: the highest venue tier keeper-attested depth may earn.
 * @param utilFeeMaxBps    0 = unchanged.
 * @param lTierX100        Optional: the market's built-in maximum x100 and `lLaunchX100`, to validate the table first.
 * @returns 71 bytes.
 * @example
 * ```ts
 * encodeSetAssetRiskLimitsV22Tiers(0, 10_000, 5_000, { thresholdUsd: [0, 0, 0], leverageX100: [0, 0, 0] }, 1);
 * ```
 */
export function encodeSetAssetRiskLimitsV22Tiers(
  assetIndex: number, lambdaBps: number, kinkBps: number, tiers: TierConfig, attestedMaxTier: number, utilFeeMaxBps = 0,
  check?: { lLaunchX100: number; lTierX100: number },
): Uint8Array {
  if (!Number.isInteger(assetIndex) || assetIndex < 0 || assetIndex > 0xffff) throw new Error(`assetIndex must be a u16, got ${assetIndex}`);
  if (!Number.isInteger(lambdaBps) || lambdaBps < 1 || lambdaBps > 0xffff_ffff) throw new Error(`lambdaBps must be a u32 >= 1, got ${lambdaBps}`);
  if (!Number.isInteger(kinkBps) || kinkBps < 0 || kinkBps > 0xffff) throw new Error(`kinkBps must be a u16, got ${kinkBps}`);
  if (!Number.isInteger(utilFeeMaxBps) || utilFeeMaxBps < 0 || utilFeeMaxBps > 0xffff) throw new Error(`utilFeeMaxBps must be a u16 (0 = unchanged), got ${utilFeeMaxBps}`);
  if (!attestedMaxTierOk(attestedMaxTier)) throw new Error(`attestedMaxTier must be 0..=3 (the wrapper answers 130 GrowthTierConfigInvalid), got ${attestedMaxTier}`);
  const block = encTierBlock(tiers);
  if (check !== undefined) {
    const v = validateTierConfig({ thresholdsUsd: tiers.thresholdUsd, leverageX100: tiers.leverageX100, lLaunchX100: check.lLaunchX100, lTierX100: check.lTierX100, attestedMaxTier });
    if (!v.ok) throw new Error(`tier table refused (the wrapper answers 130 GrowthTierConfigInvalid): ${v.issues.map((x) => x.message).join(" ")}`);
  }
  const out = concatBytes(
    encU8(IX_TAG_P1.SetAssetRiskLimits), encU16(assetIndex), new Uint8Array(41),
    encU32(lambdaBps), encU16(kinkBps), encU16(utilFeeMaxBps), block, encU8(attestedMaxTier),
  );
  if (out.length !== 44 + SET_ASSET_RISK_LIMITS_TIERS_TRAILER_LEN) throw new Error(`encodeSetAssetRiskLimitsV22Tiers: internal length ${out.length}`);
  return out;
}

// ============================================================================
// Matcher call extension v2 / v3
// ============================================================================

/** v2 call-extension fields: the v1 block plus the LP's signed position. */
export interface MatcherCallExtV2 extends MatcherCallExt {
  /** i128 `lp_position_q` (the LP's engine position; `i128::MIN` is refused by the matcher). */
  lpPositionQ: bigint;
}

/**
 * Encode the 40-byte v2 block (`CallExt::encode_v2`): the v1 24-byte block with byte 0 = 2, then the
 * i128 `lp_position_q` at 24..40.
 *
 * @param ext  v1 fields + `lpPositionQ`.
 * @returns 40 bytes.
 * @example
 * ```ts
 * encodeMatcherCallExtV2({ ...v1, lpPositionQ: -1_234_567n });
 * ```
 */
export function encodeMatcherCallExtV2(ext: MatcherCallExtV2): Uint8Array {
  const p = ext.lpPositionQ;
  if (p < I128_MIN + 1n || p > I128_MAX) throw new Error("lpPositionQ must be a non-MIN i128");
  const v1 = encodeMatcherCallExt(ext);
  if (v1.length !== MATCHER_CALL_EXT_LEN) throw new Error("internal v1 length");
  const out = new Uint8Array(MATCHER_CALL_EXT_V2_LEN);
  out.set(v1, 0);
  out[0] = MATCHER_CALL_EXT_VERSION_V2;
  const u = BigInt.asUintN(128, p);
  out.set(encU128(u), 24);
  return out;
}

/** v3 caps. */
export interface MatcherCallExtCapsV3 {
  /** `inventory_cap_q` (Q): 0 means CLOSED to LP growth (NOT unlimited). Must fit i128. */
  inventoryCapQ: bigint;
  /** `liquidity_notional_e6`: the depth `min(ctx, ext)` (0 = keep the context value). */
  liquidityNotionalE6: bigint;
}

/**
 * Encode the 72-byte v3 block (`CallExt::encode_v3` / `growth_v19::encode_ext_v3_from_v2`): the
 * 40-byte v2 block with byte 0 = 3, then `u128 inventory_cap_q` @40 and `u128 liquidity_notional_e6`
 * @56. `inventory_cap_q == 0` means the LP-growth side is CLOSED, not unlimited.
 *
 * @param ext   v2 fields (v1 block + `lpPositionQ`).
 * @param caps  Capital-derived caps.
 * @returns 72 bytes.
 * @example
 * ```ts
 * const b = encodeMatcherCallExtV3({ headroomQ, markSlot, execBandBps: 500, takerReducing: true, acceptsFeeRequest: true, lpPositionQ },
 *   { inventoryCapQ: nCap, liquidityNotionalE6: depth });
 * ```
 */
export function encodeMatcherCallExtV3(ext: MatcherCallExtV2, caps: MatcherCallExtCapsV3): Uint8Array {
  return encodeMatcherCallExtV3FromV2(encodeMatcherCallExtV2(ext), caps);
}

/**
 * Wrap an existing 40-byte v2 block into v3 (port of `encode_ext_v3_from_v2`).
 *
 * @param v2    A 40-byte v2 block (byte 0 is overwritten with 3).
 * @param caps  Capital-derived caps.
 * @returns 72 bytes.
 * @example
 * ```ts
 * encodeMatcherCallExtV3FromV2(v2Block, { inventoryCapQ: 25_000_000_000n, liquidityNotionalE6: 1_746_000_000n });
 * ```
 */
export function encodeMatcherCallExtV3FromV2(v2: Uint8Array, caps: MatcherCallExtCapsV3): Uint8Array {
  if (v2.length !== MATCHER_CALL_EXT_V2_LEN) throw new Error(`v2 block must be ${MATCHER_CALL_EXT_V2_LEN} bytes, got ${v2.length}`);
  if (caps.inventoryCapQ < 0n || caps.inventoryCapQ > I128_MAX) throw new Error("inventoryCapQ must fit i128 (matcher fails closed otherwise)");
  if (caps.liquidityNotionalE6 < 0n || caps.liquidityNotionalE6 > U128_MAX) throw new Error("liquidityNotionalE6 out of u128 range");
  const out = new Uint8Array(MATCHER_CALL_EXT_V3_LEN);
  out.set(v2, 0);
  out[0] = MATCHER_CALL_EXT_VERSION_V3;
  out.set(encU128(caps.inventoryCapQ), 40);
  out.set(encU128(caps.liquidityNotionalE6), 56);
  return out;
}

/**
 * Port of `ext_v3_mark_taker_reducing` (M-1): the wrapper sets TAKER_REDUCING (byte 1 bit 3) on a
 * growth leg's v3 block, in any ext mode, whenever the leg only reduces the taker (strictly, or a
 * flip already clipped to its close). The matcher then never clips it for LP capacity.
 *
 * @param v3            72-byte v3 block.
 * @param takerReducing Whether the leg only reduces the taker.
 * @returns A copy with the flag set when `takerReducing`.
 * @example
 * ```ts
 * markExtV3TakerReducing(block, true)[1] & 0x08; // 8
 * ```
 */
export function markExtV3TakerReducing(v3: Uint8Array, takerReducing: boolean): Uint8Array {
  if (v3.length !== MATCHER_CALL_EXT_V3_LEN) throw new Error(`v3 block must be ${MATCHER_CALL_EXT_V3_LEN} bytes, got ${v3.length}`);
  const out = Uint8Array.from(v3);
  if (takerReducing) out[1] = (out[1] as number) | MATCHER_CALL_EXT_FLAG_TAKER_REDUCING;
  return out;
}

/** Re-exported for convenience: u64 max (headroom saturation). */
export const GROWTH_U64_MAX = U64_MAX;
