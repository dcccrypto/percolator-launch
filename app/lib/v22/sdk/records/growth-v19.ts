/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk @ ecb6215 (draft dcccrypto/percolator-sdk#406, sdk 9.0.0-candidate),
 * src/abi/growth-v19.ts. Only the imports are retargeted (the vendored v22 layout/slab ports, sibling records ports, and the installed @percolatorct/sdk 8.0.0 root).
 * Delete when @percolatorct/sdk >= 9.0.0 ships and point ../../records.ts at the package. Do not edit here; fix upstream in percolator-sdk.
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
}

/**
 * Quote the maximum leverage a taker can open on `side` right now.
 *
 * Crowd detection: taker long => the LP goes shorter. A side is "crowd" iff the taker's fill on it
 * grows |LP|: LP short or flat => longs crowd; LP long or flat => shorts crowd (a flat LP: both).
 * Ceiling `L_ceil = min(l_launch, l_tier)` (graduation is compiled off in the wrapper).
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
  const out = (p: Partial<MaxLeverageQuote>): MaxLeverageQuote => ({
    side, crowd, closed: false, closedReason: null, maxLeverageX100: 0, imrBps: null,
    utilizationBps: null, nCapQ: null, growthOn: g !== null, headroomQ: null, reduceOnlyCapacityExempt: true, utilisationFeeBps: null, ...p,
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
  const lCeil = Math.min(g.lLaunchX100, g.lTierX100);
  const base = ceilingImrBps(e, lCeil);
  if (base === null) return closed("invalid-config");
  // N-1: growth opens only against the asset's BOUND vault LP (wrapper 97 / 95 otherwise).
  if (!input.assetBound) return closed("not-bound", { headroomQ: 0n });
  const cM = conservativeEquity(input.lpCapital, input.lpPnl, input.lpFeeCredits);
  const nCap = nCapQ(cM, g.lambdaBps, input.priceE6, input.posScale ?? GROWTH_POS_SCALE);
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
 * @returns Legacy bytes + 4 trailer bytes.
 * @example
 * ```ts
 * const data = encodeInitMarketV19(args, 500, 550);
 * ```
 */
export function encodeInitMarketV19(args: InitMarketV17Args | InitMarketArgs, rGapBps: number, lLaunchX100: number): Uint8Array {
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
