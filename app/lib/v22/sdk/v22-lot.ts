/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk @ adf8fd0 (draft dcccrypto/percolator-sdk#406, sdk 9.0.0-candidate),
 * src/abi/v22-lot.ts. Only the imports are retargeted (the installed @percolatorct/sdk 8.0.0 root, the v2.1 txv1 port, and the sibling v22 ports).
 * Delete when @percolatorct/sdk >= 9.0.0 ships and point ./index.ts at the package. Do not edit here; fix upstream in percolator-sdk.
 */
/**
 * ONE lot conversion for every consumer (app, keeper, indexer). A v2.2 market's base unit is a LOT of `10^lot_exp`
 * tokens: every mark and `initial_price` is PER LOT and every position `q` is IN LOTS (`POS_SCALE` per lot). The engine,
 * matcher and wrapper convert nothing.
 *
 *   price per token  = mark_e6 / 1e6 / 10^lotExp
 *   size in tokens   = q / POS_SCALE * 10^lotExp
 *   size in lots (q) = trunc(tokens / 10^lotExp)        (the remainder is reported, NEVER rounded up into the size)
 *
 * No function here rounds a size UP: sizes truncate toward zero. (An earlier app helper accepted "within 2 Q of the
 * next lot" as that lot; that rounds a size up and is deliberately not part of the SDK. Quantise first, then show the
 * remainder.)
 *
 * @module v22-lot
 */
import { resolveMarketGeometry } from "./layout";
import { LOT_EXP_MAX_V22 } from "./v22-wire";

/** Engine position scale: Q units per lot (per token when `lotExp` is 0). */
export const POS_SCALE_V22 = 1_000_000n;

function assertLotExp(lotExp: number): void {
  if (!Number.isInteger(lotExp) || lotExp < 0 || lotExp > LOT_EXP_MAX_V22) throw new Error(`lotExp must be 0..=${LOT_EXP_MAX_V22}, got ${lotExp}`);
}
const pow10 = (k: number): bigint => 10n ** BigInt(k);

/**
 * Read a market's lot exponent (profile byte +19 of the asset's wrapper slot). 0 on a v2.1 market (the byte is zero
 * there) and on a market without lots.
 *
 * @param data        Raw market account bytes.
 * @param assetIndex  Asset slot (default 0).
 * @returns `lot_exp` 0..=15.
 * @throws {@link UnknownLayoutError} for an unknown VERSION / a malformed account; `RangeError` for a missing slot or a byte above 15.
 * @example
 * ```ts
 * const lotExp = lotExpOfMarketV22(info.data);
 * ```
 */
export function lotExpOfMarketV22(data: Uint8Array, assetIndex = 0): number {
  const g = resolveMarketGeometry(data, { parser: "lotExpOfMarketV22", strictLength: false });
  if (!Number.isInteger(assetIndex) || assetIndex < 0 || assetIndex >= g.slotCount) throw new RangeError(`asset ${assetIndex} is not present`);
  const v = data[g.slotOff(assetIndex) + g.layout.wrapperSlot.profileLotExp];
  if (v > LOT_EXP_MAX_V22) throw new RangeError(`lot_exp byte ${v} is above ${LOT_EXP_MAX_V22}`);
  return v;
}

/**
 * Per-lot e6 price to the per-TOKEN e6 price (integer, rounded DOWN). `lotExp` 0 returns the input.
 *
 * @param perLotE6  Per-lot price, e6.
 * @param lotExp    Market `lot_exp`.
 * @returns Per-token price, e6.
 * @example
 * ```ts
 * lotPriceToTokenE6V22(40_000_000n, 5); // 400n
 * ```
 */
export function lotPriceToTokenE6V22(perLotE6: bigint, lotExp: number): bigint {
  assertLotExp(lotExp);
  return perLotE6 / pow10(lotExp);
}

/**
 * Per-token e6 price to the per-lot e6 price (exact).
 *
 * @param perTokenE6  Per-token price, e6.
 * @param lotExp      Market `lot_exp`.
 * @returns Per-lot price, e6.
 * @example
 * ```ts
 * tokenPriceToLotE6V22(400n, 5); // 40_000_000n
 * ```
 */
export function tokenPriceToLotE6V22(perTokenE6: bigint, lotExp: number): bigint {
  assertLotExp(lotExp);
  return perTokenE6 * pow10(lotExp);
}

/**
 * Engine Q (in lots, signed or not) to token-scaled Q (`POS_SCALE` per TOKEN): `q * 10^lotExp`. Exact.
 *
 * @param q        Engine Q in lots.
 * @param lotExp   Market `lot_exp`.
 * @returns Q per token.
 * @example
 * ```ts
 * qToTokenQV22(3_000_000n, 2); // 300_000_000n
 * ```
 */
export function qToTokenQV22(q: bigint, lotExp: number): bigint {
  assertLotExp(lotExp);
  return q * pow10(lotExp);
}

/**
 * A size typed in tokens (Q per token, `POS_SCALE` = 1e6) to engine Q in lots, truncating TOWARD ZERO. The remainder
 * (same sign) is what cannot be expressed in lots: show it, never send it.
 *
 * @param tokenQ  Size in token-scaled Q.
 * @param lotExp  Market `lot_exp`.
 * @returns `{ q, remainderTokenQ }` with `|q * 10^lotExp| <= |tokenQ|` always.
 * @example
 * ```ts
 * tokenQToQV22(1_234_567n, 3); // { q: 1_234n, remainderTokenQ: 567n }
 * ```
 */
export function tokenQToQV22(tokenQ: bigint, lotExp: number): { q: bigint; remainderTokenQ: bigint } {
  assertLotExp(lotExp);
  const f = pow10(lotExp);
  return { q: tokenQ / f, remainderTokenQ: tokenQ % f };
}

/**
 * Quantise an engine Q to WHOLE lots, truncating toward zero (`POS_SCALE` Q per lot). No tolerance: a size one Q short
 * of a lot is NOT a lot.
 *
 * @param q  Engine Q.
 * @returns `{ q, remainderQ }` with `|q| <= |input|`.
 * @example
 * ```ts
 * quantizeQToLotsV22(2_999_999n); // { q: 2_000_000n, remainderQ: 999_999n }
 * ```
 */
export function quantizeQToLotsV22(q: bigint): { q: bigint; remainderQ: bigint } {
  const whole = (q / POS_SCALE_V22) * POS_SCALE_V22;
  return { q: whole, remainderQ: q - whole };
}

/**
 * Lots to tokens (exact): `lots * 10^lotExp`.
 *
 * @param lots    Whole lots.
 * @param lotExp  Market `lot_exp`.
 * @returns Whole tokens.
 * @example
 * ```ts
 * lotsToTokensV22(7n, 3); // 7000n
 * ```
 */
export function lotsToTokensV22(lots: bigint, lotExp: number): bigint {
  assertLotExp(lotExp);
  return lots * pow10(lotExp);
}
