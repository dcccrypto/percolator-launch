/**
 * Sizing helpers: turn a USD amount into the engine units the API takes. Exact BigInt math, no floats on the money.
 *
 * Units (see the README): `size` is engine q, 1,000,000 q = ONE LOT of the base asset (a lot is 10^lotExp tokens); a market's
 * `effectivePriceE6` is the price of one lot times 1e6; collateral amounts are atoms = tokens x 10^collateralDecimals.
 *   notionalAtoms = |q| x effectivePriceE6 / 1e6
 *   q for a USD amount = usdAtoms x 1e6 / effectivePriceE6
 */
export interface SizingMarket {
  /** Market.effectivePriceE6 (a decimal string, or a bigint). */
  effectivePriceE6: string | bigint;
  /** Market.collateralDecimals. null = a collateral the API cannot value in USD: nothing can be sized in USD. */
  collateralDecimals: number | null;
  /** Market.lotExp, only used to report the size in base tokens. */
  lotExp?: number;
}

const DEC = /^(\d{1,30})(?:\.(\d{1,30}))?$/;

/** Collateral atoms for `usd` USD of a USD-stable collateral with `decimals` decimals. A number is converted through its decimal text; extra fractional digits are cut, never rounded up. */
export function usdToAtoms(usd: number | string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) throw new RangeError("collateral decimals must be an integer 0..30");
  const text = typeof usd === "number" ? (Number.isFinite(usd) && usd >= 0 ? usd.toFixed(Math.min(decimals, 20)) : "") : usd.trim();
  const m = DEC.exec(text);
  if (!m) throw new RangeError(`usd must be a non-negative decimal amount, got ${String(usd)}`);
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(m[1]) * 10n ** BigInt(decimals) + (frac === "" ? 0n : BigInt(frac));
}

export interface SizedOrder {
  /** Engine q to put in `size` (as a string: `String(sizeQ)`). */
  sizeQ: bigint;
  /** What that size is worth at the effective price, collateral atoms (<= the USD you asked for). */
  notionalAtoms: bigint;
  /** sizeQ / 1e6, in lots, as a decimal string. */
  lots: string;
  /** Base tokens (lots x 10^lotExp), as a decimal string; null when lotExp was not given. */
  baseTokens: string | null;
}

/** Position size worth `usd` of notional on `market`, rounded DOWN (never more than asked). Throws when the market cannot be valued in USD or the amount rounds to 0. */
export function sizeFromUsd(market: SizingMarket, usd: number | string): SizedOrder {
  if (market.collateralDecimals === null) throw new RangeError("this market's collateral cannot be valued in USD; size it in q yourself");
  const price = BigInt(market.effectivePriceE6);
  if (price <= 0n) throw new RangeError("the market has no price right now");
  const atoms = usdToAtoms(usd, market.collateralDecimals);
  const sizeQ = (atoms * 1_000_000n) / price;
  if (sizeQ <= 0n) throw new RangeError("that amount is too small to buy one unit of engine size");
  const whole = sizeQ / 1_000_000n;
  const frac = (sizeQ % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  const lots = frac === "" ? whole.toString() : `${whole}.${frac}`;
  return { sizeQ, notionalAtoms: (sizeQ * price) / 1_000_000n, lots, baseTokens: market.lotExp === undefined ? null : shiftDecimal(lots, market.lotExp) };
}

/** `lots` x 10^k as a decimal string (k >= 0). */
function shiftDecimal(dec: string, k: number): string {
  const [w, f = ""] = dec.split(".");
  const digits = w + f.padEnd(k, "0").slice(0, Math.max(k, 0)) + f.slice(Math.max(k, 0));
  const point = w.length + k;
  const intPart = digits.slice(0, point).replace(/^0+(?=\d)/, "") || "0";
  const rest = digits.slice(point).replace(/0+$/, "");
  return rest === "" ? intPart : `${intPart}.${rest}`;
}
