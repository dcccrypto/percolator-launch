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
 * Engine 35ddd692 applies a trade or close to the EFFECTIVE quantity
 * (`ceil(|basis| * a_side / a_basis)`, plan_delta v16.rs:6075) and margins on it
 * (v16.rs:13896), so the close path sizes from lib/limits/effective-quantity.ts
 * (M-3, code-review-live-paths-2026-10-01), not raw basis. `Account.positionSize`
 * stays raw basis for the fill check and the wrapper caps view; this module's
 * floor-rounded `effectiveExposureQ` is a DISPLAY quantity only.
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
 * and `a_long` / `a_short` are the first two u128s that follow. `oi_eff_long_q`
 * sits 15 x 16 bytes after `a_long` (a x2, k x2, f x2, kf_epoch x2 u64, k/f epoch
 * start x4, b x2, b epoch start x2), i.e. at rel 289 = 49 + 15*16 - NOT 273 - which
 * is how these offsets are cross-checked (verified on a live slab with open interest).
 */

import {
  V17_ASSET_SLOT_WRAPPER_LEN,
} from "@percolatorct/sdk";
import { formatTokenAmount } from "@/lib/format";
import { marketGeometry, isUnsupportedLayout } from "@/lib/v22/layout";

/** `ADL_ONE` — the un-deleveraged side factor (percolator/src/lib.rs:16). */
export const ADL_ONE = 1_000_000_000_000_000n;

/**
 * Wrapper bytes preceding `EngineAssetSlotV16Account` inside each market slot.
 * Imported from the SDK (`V17_ASSET_SLOT_WRAPPER_LEN`) so it tracks the layout:
 * this grew 512 → 1024 in v18 (the AssetOracleProfileV16 region expanded 400 →
 * 512 and the new AssetControlSequencesV16 region was added). Reading a_long at
 * the stale 512 offset returned 0 on live v18 slabs — verified on-chain.
 */
const ASSET_SLOT_WRAPPER_SIZE = V17_ASSET_SLOT_WRAPPER_LEN;

/** Byte offsets of `a_long` / `a_short` within `AssetStateV16Account`. */
const A_LONG_REL = 49;
const A_SHORT_REL = 65;
/**
 * Epoch and side-mode fields at the tail of `AssetStateV16Account`, after
 * `oi_eff_long_q` (rel 289 = 49 + 15 x 16, verified against a live devnet slab
 * with open interest): epoch_long u64 @497, epoch_short u64 @505, mode_long u8
 * @513, mode_short u8 @514. The leg's `epoch_snap` is compared against these
 * (engine `effective_abs_quantity_for_leg`).
 */
const EPOCH_LONG_REL = 497;
const EPOCH_SHORT_REL = 505;
const MODE_LONG_REL = 513;
const MODE_SHORT_REL = 514;

/** Per-side ADL factors for one asset slot. `ADL_ONE` means "never deleveraged". */
export interface AssetAdlFactors {
  aLong: bigint;
  aShort: bigint;
  /** Current side epochs / modes (SideModeV16 encoding); absent only on hand-built values. */
  epochLong?: bigint;
  epochShort?: bigint;
  modeLong?: number;
  modeShort?: number;
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i]);
  return value;
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
 *          layout / the slot is in the retired 0-0 shape. `null` means "ADL state
 *          UNKNOWN": callers must NOT assume raw basis is right (see
 *          lib/position-pnl.ts, which refuses to show a PnL).
 */
export function parseAssetAdlFactors(
  slabData: Uint8Array,
  assetIndex: number,
): AssetAdlFactors | null {
  if (assetIndex < 0 || !Number.isInteger(assetIndex)) return null;
  let slotBase: number;
  try {
    slotBase = marketGeometry(slabData, "parseAssetAdlFactors").slotOff(assetIndex);
  } catch (e) {
    if (isUnsupportedLayout(e)) return null; // unknown VERSION: ADL state UNKNOWN, never guessed
    throw e;
  }
  const aLongOff = slotBase + ASSET_SLOT_WRAPPER_SIZE + A_LONG_REL;
  const aShortOff = slotBase + ASSET_SLOT_WRAPPER_SIZE + A_SHORT_REL;
  if (aShortOff + 16 > slabData.length) return null;
  const aLong = readU128LE(slabData, aLongOff);
  const aShort = readU128LE(slabData, aShortOff);
  // A valid factor is in (0, ADL_ONE]. The engine's MIN_A_SIDE (= ADL_ONE/10)
  // is a DRAIN threshold, not an invariant: when a bankruptcy ADL drives a
  // side's `a` below it the engine keeps the value and flips that side to
  // DrainOnly (v16.rs:17867-17878, `asset.a_long = opp_a_after; if ... <
  // MIN_A_SIDE { mode_long = DrainOnly }`) — it is the most-deleveraged state
  // there is. This guard used to reject anything below MIN_A_SIDE, and checked
  // BOTH sides, so one drained side made the whole slot "unreadable" (null) and
  // every consumer fell back to RAW basis — over-reporting exactly the
  // positions that were deleveraged hardest (issue #3077 cause 3). Zero and
  // > ADL_ONE stay refused: `0/0` is the retired/reset shape (v16.rs:7746),
  // which carries no factor to scale by, and anything above ADL_ONE means we
  // are not looking at an AssetStateV16Account at all.
  if (aLong <= 0n || aLong > ADL_ONE) return null;
  if (aShort <= 0n || aShort > ADL_ONE) return null;
  const epochBase = slotBase + ASSET_SLOT_WRAPPER_SIZE;
  if (epochBase + MODE_SHORT_REL + 1 > slabData.length) return { aLong, aShort };
  return {
    aLong,
    aShort,
    epochLong: readU64LE(slabData, epochBase + EPOCH_LONG_REL),
    epochShort: readU64LE(slabData, epochBase + EPOCH_SHORT_REL),
    modeLong: slabData[epochBase + MODE_LONG_REL],
    modeShort: slabData[epochBase + MODE_SHORT_REL],
  };
}

/** Pick the side factor a leg settles against. `side`: 0 = long, 1 = short. */
export function adlSideFactor(factors: AssetAdlFactors, side: number): bigint {
  return side === 0 ? factors.aLong : factors.aShort;
}

/**
 * Convert a leg's stored basis into the exposure it actually carries today.
 *
 * `effective = floor(|basis| * aSide / aBasis)`, computed on the magnitude and
 * re-signed (a DISPLAY quantity; the engine's own is the ceil in
 * lib/limits/effective-quantity.ts, which `computePositionPnl` uses). Equal factors (the overwhelmingly common "never deleveraged" case)
 * return `basis` exactly, so this is a no-op on a healthy market. Returns `null`
 * (never raw basis) when the factors cannot describe a valid leg.
 */
export function effectiveExposureQ(
  basisPosQ: bigint,
  aBasis: bigint,
  aSide: bigint,
): bigint | null {
  if (basisPosQ === 0n) return 0n;
  // The engine refuses a leg whose factors are not 1 <= a_side <= a_basis
  // (kernel_adl_effective_quantity_ceil, v16.rs:1677): there is NO raw-size
  // answer for such a leg. Report "unknown" instead of handing back raw basis,
  // which is exactly the number that over-reports a deleveraged position.
  if (aBasis <= 0n || aSide <= 0n || aSide > aBasis) return null;
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
