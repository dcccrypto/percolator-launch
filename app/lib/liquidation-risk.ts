/**
 * Liquidation price and liquidation risk on the ENGINE's maintenance model.
 *
 * The engine (percolator v16.rs compute_account_health_cert_with_price_override,
 * health_requirements_from_notional_and_target_lag) liquidates when
 *
 *     equity < maintenance_req,   equity = capital + q * (P - E),
 *                                 maintenance_req = |q| * P * mm
 *
 * with P the asset's price (not the entry). Solving at the boundary gives
 *
 *     long  (q > 0):  P_liq = (E - C/q) / (1 - mm)
 *     short (q < 0):  P_liq = (E + C/|q|) / (1 + mm)
 *
 * The SDK's computeLiqPrice divides the capital term instead
 * (E - C/(q(1+mm)) and E + C/(|q|(1-mm))), which puts the price too far away:
 * at mm = 5% a 10x long reads 9.5% from liquidation when the engine has it at
 * 5.3%, and a position the engine can liquidate now still reads ~4-5% away.
 *
 * Not modelled (all of them only bring liquidation closer, so these figures
 * are a best case): the per-leg min_nonzero_mm_req floor, the target-lag
 * penalty added to maintenance_req, accrued fees/funding not yet in capital,
 * and the haircut on positive PnL.
 */

const BPS = 10_000n;
const E6 = 1_000_000n;

const abs = (v: bigint) => (v < 0n ? -v : v);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * Engine-consistent liquidation price, e6. Drop-in for the SDK's computeLiqPrice
 * (same arguments and return conventions): 0n for no position / no entry, and 0n for
 * a long whose collateral covers it at any price (capital >= notional at entry). A
 * short always has one. Rounded toward the mark, so the shown price is never on the
 * far side of the engine's.
 */
export function computeEngineLiqPrice(
  entryPriceE6: bigint,
  capital: bigint,
  positionSize: bigint,
  maintenanceMarginBps: bigint,
): bigint {
  if (positionSize === 0n || entryPriceE6 <= 0n) return 0n;
  const mm = maintenanceMarginBps < 0n ? 0n : maintenanceMarginBps;
  const absQ = abs(positionSize);
  if (positionSize > 0n) {
    // mm >= 100% never occurs on a real market; clamp so the division stays defined.
    const mmL = mm >= BPS ? BPS - 1n : mm;
    const numerator = entryPriceE6 * absQ - capital * E6; // (E - C/q) * q, e6
    if (numerator <= 0n) return 0n;
    return ceilDiv(numerator * BPS, absQ * (BPS - mmL));
  }
  const numerator = entryPriceE6 * absQ + capital * E6; // (E + C/|q|) * |q|, e6
  return (numerator * BPS) / (absQ * (BPS + mm));
}

/**
 * How far, in percent of the entry price, the price can move against a position opened at the
 * market's full leverage (capital = initial margin) before the engine can liquidate it. The nearer
 * side is returned: at the same margins a short is liquidated sooner than a long (10x, mm 5%: long
 * 5.26%, short 4.76%). It is not 1 / leverage, which ignores the maintenance requirement and
 * shows twice the room at mm = im / 2. Fees and the per-leg floor are not modelled (they only
 * bring liquidation closer). null when the margins do not describe a liquidatable position.
 */
export function liqMovePctAtFullLeverage(initialMarginBps: number, maintenanceMarginBps: number): number | null {
  if (!Number.isFinite(initialMarginBps) || !Number.isFinite(maintenanceMarginBps)) return null;
  const im = BigInt(Math.round(initialMarginBps));
  const mm = BigInt(Math.round(maintenanceMarginBps));
  if (im <= 0n || mm < 0n || im <= mm || im >= BPS) return null;
  const entry = E6; // $1, so the position's notional in atoms equals its size
  const q = 1_000_000_000_000n;
  const capital = (q * im) / BPS;
  const longLiq = computeEngineLiqPrice(entry, capital, q, mm);
  const shortLiq = computeEngineLiqPrice(entry, capital, -q, mm);
  if (longLiq <= 0n || shortLiq <= entry) return null;
  const nearer = entry - longLiq < shortLiq - entry ? entry - longLiq : shortLiq - entry;
  return Number((nearer * 1_000_000n) / entry) / 10_000;
}

/** computePreTradeLiqPrice (SDK signature) on the engine model. */
export function computeEnginePreTradeLiqPrice(
  oracleE6: bigint,
  margin: bigint,
  posSize: bigint,
  maintBps: bigint,
  feeBps: bigint,
  direction: "long" | "short",
): bigint {
  if (oracleE6 === 0n || margin === 0n || posSize === 0n) return 0n;
  const absPos = abs(posSize);
  const feeAdjust = (oracleE6 * feeBps) / BPS;
  const entry = direction === "long" ? oracleE6 + feeAdjust : oracleE6 - feeAdjust > 0n ? oracleE6 - feeAdjust : 1n;
  return computeEngineLiqPrice(entry, margin, direction === "long" ? absPos : -absPos, maintBps);
}

/**
 * Risk tiers, as the share of the position's margin cushion still left at the mark.
 * The cushion is what equity holds above the engine's maintenance requirement; it is
 * measured against what the position had at its entry price (1 / entry leverage), or
 * against the market's initial margin when that is larger:
 *
 *     left = (equity/notional - mm) / (max(capital/entry_notional, im) - mm)
 *
 * 1 at entry (or at the initial-margin line), 0 where the engine can liquidate.
 *
 *   warning: half of the cushion is gone (the price has come half way to liquidation)
 *   danger:  three quarters of it is gone
 *
 * The old fixed 20%/10% price distance fired the moment an ordinary 5x position opened.
 * These tiers scale with the position's own leverage and the market's own margins, so a
 * position never opens into an alert, a 2x position is warned while it still has a wide
 * price margin, and a 10x one only once it has actually lost half its room. The im floor
 * keeps a position whose entry is unknown (entry = mark) measurable: it is judged
 * against the market's initial-margin line instead.
 */
export const LIQ_WARNING_CUSHION = 0.5;
export const LIQ_DANGER_CUSHION = 0.25;
/** A hidden warning is forgotten once the cushion recovers past this (hysteresis). */
export const LIQ_FORGET_HIDE_CUSHION = 0.75;

export interface MarginCushionInput {
  /** Signed NOMINAL size, as computeLiqPrice takes it. */
  positionSize: bigint;
  entryPriceE6: bigint;
  capital: bigint;
  markPriceE6: bigint | null | undefined;
  maintenanceMarginBps: bigint;
  /** Falls back to 2 x MM (every live market) when missing or not above MM. */
  initialMarginBps?: bigint | null;
}

/** equity / notional in bps, at `priceE6`. */
function equityRatioBps(positionSize: bigint, entryE6: bigint, capital: bigint, priceE6: bigint): number {
  const notional = abs(positionSize) * priceE6; // e12
  const equity = capital * E6 + positionSize * (priceE6 - entryE6); // e12
  return Number((equity * BPS * 100n) / notional) / 100;
}

/**
 * Share of the position's margin cushion left at the mark (see the tiers above).
 * Below 0 once the engine can liquidate it. null when there is no position, entry or
 * mark to measure with (not a claim of safety).
 */
export function computeMarginCushion(i: MarginCushionInput): number | null {
  const mark = i.markPriceE6;
  if (i.positionSize === 0n || mark == null || mark <= 0n || i.entryPriceE6 <= 0n) return null;
  const mm = Number(i.maintenanceMarginBps);
  if (!Number.isFinite(mm) || mm < 0) return null;
  let im = i.initialMarginBps != null ? Number(i.initialMarginBps) : NaN;
  if (!Number.isFinite(im) || im <= mm) im = 2 * mm;
  if (im <= mm) return null; // mm = 0: no maintenance line to measure against
  const atEntry = equityRatioBps(i.positionSize, i.entryPriceE6, i.capital, i.entryPriceE6);
  const now = equityRatioBps(i.positionSize, i.entryPriceE6, i.capital, mark);
  const reference = Math.max(atEntry, im);
  return (now - mm) / (reference - mm);
}

export type CushionSeverity = "safe" | "warning" | "danger";

export function severityFromCushion(cushion: number): CushionSeverity {
  if (!Number.isFinite(cushion)) return "danger"; // #2412: no signal is not safety
  if (cushion <= LIQ_DANGER_CUSHION) return "danger";
  if (cushion <= LIQ_WARNING_CUSHION) return "warning";
  return "safe";
}
