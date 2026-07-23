/**
 * v17 auto-deleveraging (ADL) state reader + effective-exposure math.
 *
 * WHY THIS EXISTS
 * ---------------
 * When the engine auto-deleverages a side it does NOT rewrite any leg's
 * `basis_pos_q`. Touching every open leg would be O(n) inside one instruction,
 * so instead it scales a single shared per-side factor on the asset —
 * `asset.a_long` / `asset.a_short` — and leaves each leg's stored basis alone
 * (percolator/src/v16.rs:12520-12556,
 * `reduce_matching_open_interest_for_unilateral_close`). Each leg separately
 * remembers the factor that was live when it was opened, in `leg.a_basis`
 * (v16.rs:11600-11616, set from the side's current `a` at attach time), and
 * settlement never re-snaps it — `settle_leg_kf_effects_at_slot_with_asset`
 * rewrites only `k_snap`/`f_snap` (v16.rs:9657-9658).
 *
 * A leg's ECONOMIC exposure is therefore NOT `basis_pos_q`. Settlement realizes
 *
 *     basis_pos_q * (k_now - k_snap) / (a_basis * POS_SCALE)      [v16.rs:9547-9576]
 *
 * and `k` accrues per side scaled by that side's live `a`
 * (`k_delta_long = price_delta * a_long`, v16.rs:10497-10502), so the `a` in the
 * numerator cancels the frozen `a_basis` in the denominator and the leg moves
 * with
 *
 *     effective_exposure = basis_pos_q * a_side / a_basis
 *
 * per unit of price. Displaying raw `basis_pos_q` as the position size
 * OVER-REPORTS a deleveraged position by `a_basis / a_side` — up to 10x, since
 * `a` is floored at `MIN_A_SIDE = ADL_ONE / 10` (percolator/src/lib.rs:16-17).
 *
 * VERIFIED ON THE DEPLOYED DEVNET PLAYGROUND (2026-07-22; the math is
 * engine-level and unchanged on the current fee-split wrapper).
 * Four live markets carry `a_short < ADL_ONE`, and the effective exposures this
 * module computes sum EXACTLY to the engine's own `oi_eff_short_q` aggregate —
 * an independent cross-check of the formula against on-chain state:
 *
 *   market    a_short   legs (basis -> effective)          oi_eff_short_q
 *   F1LHGasi  0.50      -1_000_000 -> -500_000                    500_000  ✓
 *   FysUBWXp  0.50      -1_000_000 -> -500_000                    500_000  ✓
 *   GsBBecjF  0.75      -4_000_000 -> -3_000_000               3_000_000  ✓
 *   D4QsJSG9  0.606…    -330_000   -> -199_999                    200_000  ✓ (1-unit floor)
 *
 * WHAT THIS IS *NOT* FOR
 * ----------------------
 * `basis_pos_q` remains the correct quantity for CLOSING and for MARGIN:
 * `close_q` is clamped to `leg.basis_pos_q.unsigned_abs()` (v16.rs:12640) and
 * margin uses `risk_notional_ceil(leg.basis_pos_q.unsigned_abs(), price)`
 * (v16.rs:9707). So `Account.positionSize` deliberately stays raw basis and the
 * close path (which is percent-based and re-reads basis from a fresh scan,
 * hooks/useClosePosition.ts:256) is untouched. Effective exposure is a DISPLAY
 * and PnL-sensitivity quantity only.
 *
 * The SDK does not expose `a_long`/`a_short` (it parses `oi_eff_*` from the same
 * struct but skips the `a` fields, and its `solana/adl` module is forward-looking
 * ADL *targeting*, not applied-ADL state), so this is an app-local reader in the
 * same spirit as lib/v17-engine-config.ts. It is NOT a program or SDK change.
 *
 * OFFSETS
 * -------
 * Derived from the SDK's own layout constants rather than hardcoded, so a pin
 * bump moves them together. Within `AssetStateV16Account` (repr(C), no padding,
 * v16.rs:4562-4604) the header is
 *   market_id(8) + retired_slot(8) + lifecycle(1) + raw_oracle_target_price(8)
 *   + effective_price(8) + fund_px_last(8) + slot_last(8) = 49 bytes
 * and `a_long` / `a_short` are the first two u128s that follow. The same 14
 * u128s the SDK counts to reach `oi_eff_long_q` at rel 273 start here, which is
 * how these two offsets are cross-checked (49 + 14*16 = 273).
 */

import {
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_ASSET_SLOT_LEN,
} from "@percolatorct/sdk";
import { formatTokenAmount } from "@/lib/format";

/** `ADL_ONE` — the un-deleveraged side factor (percolator/src/lib.rs:16). */
export const ADL_ONE = 1_000_000_000_000_000n;

/**
 * Wrapper `T` bytes preceding `EngineAssetSlotV16Account` inside each market
 * slot (AssetOracleProfileV16Account=400 + 112 more). Mirrors the SDK's own
 * `V17_ASSET_SLOT_WRAPPER_SIZE`, which it does not export.
 */
const ASSET_SLOT_WRAPPER_SIZE = 512;

/** Byte offsets of `a_long` / `a_short` within `AssetStateV16Account`. */
const A_LONG_REL = 49;
const A_SHORT_REL = 65;

/** Per-side ADL factors for one asset slot. `ADL_ONE` means "never deleveraged". */
export interface AssetAdlFactors {
  aLong: bigint;
  aShort: bigint;
}

function readU128LE(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 15; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i]);
  return value;
}

/**
 * Read the live per-side ADL factors for one asset slot of a v17 market account.
 *
 * @param slabData   Raw v17 market ("slab") account bytes.
 * @param assetIndex Asset slot index (0 for every single-asset playground market).
 * @returns The factors, or `null` when the buffer is too short / not a v17 market
 *          layout. Callers treat `null` as "no ADL information" and fall back to
 *          raw basis, which is the pre-existing behaviour.
 */
export function parseAssetAdlFactors(
  slabData: Uint8Array,
  assetIndex: number,
): AssetAdlFactors | null {
  if (assetIndex < 0 || !Number.isInteger(assetIndex)) return null;
  const slotsBase = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN;
  const slotBase = slotsBase + assetIndex * V17_MARKET_ASSET_SLOT_LEN;
  const aLongOff = slotBase + ASSET_SLOT_WRAPPER_SIZE + A_LONG_REL;
  const aShortOff = slotBase + ASSET_SLOT_WRAPPER_SIZE + A_SHORT_REL;
  if (aShortOff + 16 > slabData.length) return null;
  const aLong = readU128LE(slabData, aLongOff);
  const aShort = readU128LE(slabData, aShortOff);
  // A valid factor is in [MIN_A_SIDE, ADL_ONE] = [ADL_ONE/10, ADL_ONE]
  // (v16.rs:11616). Anything outside that means we are not looking at an
  // AssetStateV16Account — refuse rather than scale a position by garbage.
  const MIN_A_SIDE = ADL_ONE / 10n;
  if (aLong < MIN_A_SIDE || aLong > ADL_ONE) return null;
  if (aShort < MIN_A_SIDE || aShort > ADL_ONE) return null;
  return { aLong, aShort };
}

/** Pick the side factor a leg settles against. `side`: 0 = long, 1 = short. */
export function adlSideFactor(factors: AssetAdlFactors, side: number): bigint {
  return side === 0 ? factors.aLong : factors.aShort;
}

/**
 * Convert a leg's stored basis into the exposure it actually carries today.
 *
 * `effective = basis * aSide / aBasis`, computed on the magnitude so the floor
 * rounding is symmetric for longs and shorts, then re-signed. Returns `basis`
 * unchanged when the factors are missing or equal (the overwhelmingly common
 * "never deleveraged" case), so this is a no-op on a healthy market.
 */
export function effectiveExposureQ(
  basisPosQ: bigint,
  aBasis: bigint,
  aSide: bigint,
): bigint {
  if (basisPosQ === 0n) return 0n;
  if (aBasis <= 0n || aSide <= 0n) return basisPosQ;
  if (aBasis === aSide) return basisPosQ;
  const magnitude = (basisPosQ < 0n ? -basisPosQ : basisPosQ) * aSide / aBasis;
  return basisPosQ < 0n ? -magnitude : magnitude;
}

/** How much of a leg survives ADL, in basis points (10000 = untouched). */
export function adlRemainingBps(aBasis: bigint, aSide: bigint): number {
  if (aBasis <= 0n || aSide <= 0n || aBasis === aSide) return 10000;
  return Number((aSide * 10000n) / aBasis);
}

/**
 * True when this leg has actually been deleveraged, i.e. the side factor has
 * fallen below the value frozen into the leg at open time.
 *
 * Compares against `a_basis`, NOT against `ADL_ONE`: a leg opened AFTER a
 * partial ADL inherits the already-reduced factor as its `a_basis`, and such a
 * leg carries its full nominal exposure. Flagging it would tell a trader their
 * position was cut when it never was.
 */
export function isDeleveraged(aBasis: bigint, aSide: bigint): boolean {
  return aBasis > 0n && aSide > 0n && aSide < aBasis;
}

/**
 * Shared explanation shown wherever a deleveraged position is displayed.
 *
 * Silently halving someone's position is its own bug, so every surface that
 * applies the ADL factor also has to say that it did, and why the number moved
 * without them trading. Kept next to the math so the copy and the computation
 * can't drift apart.
 */
export function adlReductionTooltip(
  nominalQ: bigint,
  effectiveQ: bigint,
  remainingBps: number,
  decimals: number,
  symbol: string,
): string {
  const pct = (remainingBps / 100).toFixed(remainingBps % 100 === 0 ? 0 : 2);
  return (
    `Auto-deleveraged: this position was reduced to ${pct}% of its original size ` +
    `(${formatTokenAmount(nominalQ, decimals)} → ${formatTokenAmount(effectiveQ, decimals)} ${symbol}) ` +
    `when the other side of the market closed and left it without a counterparty. ` +
    `Size and PnL shown are the reduced figures. Your collateral was not taken — ` +
    `margin is still held against the original size until you close.`
  );
}
