/**
 * Exact allocation math, ported from the local PERC allocation checker
 * (src/decimal.js roundRational, src/alloc.js allocateAll). BigInt only.
 *
 * NOT wired to any live route: allocations are not published. Totals and
 * decimals are parameters supplied by a future approved export manifest; no
 * figures are baked in here.
 *
 *   value_i = total * raw_i / total_raw, rounded per column.
 *   largest_remainder: floor in units of 10^-d, then hand the leftover units to
 *   the largest remainders (ties by row order or owner_address code-point order),
 *   so rounded values sum exactly to `total`.
 */
export type RoundingMode = "floor" | "half_up" | "half_even" | "largest_remainder";
export type TieBreak = "row_order" | "owner_address_asc";
export interface Rounding {
  mode: RoundingMode;
  tie_break?: TieBreak;
}
export interface Quantity {
  key: string;
  decimals: number;
  total: bigint;
}

const ROUND_MODES = new Set(["floor", "half_up", "half_even"]);
const ALL_MODES = new Set([...ROUND_MODES, "largest_remainder"]);
const TIE_BREAKS = new Set(["row_order", "owner_address_asc"]);

function fmtUnits(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, "0");
  return decimals === 0 ? s : s.slice(0, -decimals) + "." + s.slice(-decimals);
}

/** Round non-negative num/den to `decimals` places; returns a fixed-point string. */
export function roundRational(num: bigint, den: bigint, decimals: number, mode: "floor" | "half_up" | "half_even"): string {
  if (typeof num !== "bigint" || typeof den !== "bigint") throw new TypeError("bigint required");
  if (den <= 0n || num < 0n) throw new RangeError("num must be >= 0 and den > 0");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 60) throw new RangeError("bad decimals");
  if (!ROUND_MODES.has(mode)) throw new RangeError("unknown rounding mode");
  const scaled = num * 10n ** BigInt(decimals);
  let q = scaled / den;
  const r = scaled % den;
  if (mode === "half_up" && 2n * r >= den) q += 1n;
  if (mode === "half_even" && (2n * r > den || (2n * r === den && q % 2n === 1n))) q += 1n;
  return fmtUnits(q, decimals);
}

/** One record of fixed-point strings per row, keyed by quantity key. */
export function allocateAll(
  raws: bigint[],
  totalRaw: bigint,
  rounding: Rounding,
  quantities: Quantity[],
  owners?: string[],
): Record<string, string>[] {
  const tie = rounding.tie_break ?? "row_order";
  if (!ALL_MODES.has(rounding.mode)) throw new RangeError("unknown rounding mode");
  if (!TIE_BREAKS.has(tie)) throw new RangeError("unknown tie_break");
  if (tie === "owner_address_asc" && (!owners || owners.length !== raws.length)) throw new RangeError("owners required");
  const tieCmp =
    tie === "row_order"
      ? (a: number, b: number) => a - b
      : (a: number, b: number) => (owners![a]! < owners![b]! ? -1 : owners![a]! > owners![b]! ? 1 : 0);
  if (raws.length === 0) return [];
  if (totalRaw <= 0n) throw new RangeError("total must be positive");
  const out: Record<string, string>[] = raws.map(() => ({}));
  for (const q of quantities) {
    const d = q.decimals;
    if (rounding.mode !== "largest_remainder") {
      const mode = rounding.mode;
      raws.forEach((raw, i) => {
        out[i]![q.key] = roundRational(q.total * raw, totalRaw, d, mode);
      });
      continue;
    }
    if (!Number.isInteger(d) || d < 0 || d > 60) throw new RangeError("bad decimals");
    const scaledTotal = q.total * 10n ** BigInt(d);
    const units: bigint[] = [];
    const rems: bigint[] = [];
    let floorSum = 0n;
    raws.forEach((raw, i) => {
      const n = scaledTotal * raw;
      units[i] = n / totalRaw;
      rems[i] = n % totalRaw;
      floorSum += units[i]!;
    });
    let leftover = scaledTotal - floorSum; // < rows, given sum(raw) == totalRaw
    if (leftover < 0n || leftover >= BigInt(raws.length)) throw new RangeError("raws do not sum to total");
    const idx = raws
      .map((_, i) => i)
      .sort((a, b) => (rems[a] === rems[b] ? tieCmp(a, b) : rems[a]! > rems[b]! ? -1 : 1));
    for (let k = 0; leftover > 0n; k++, leftover--) units[idx[k]!]! += 1n;
    raws.forEach((_, i) => {
      out[i]![q.key] = fmtUnits(units[i]!, d);
    });
  }
  return out;
}
