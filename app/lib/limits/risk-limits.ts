/**
 * P1 wrapper safety release: client ports of `risk_limits_v17` (percolator-prog
 * `feat/p1-safety-release@99165722`, `src/v16_program.rs` `mod risk_limits_v17`) plus the
 * processor's input gathering (`lp_floor_and_cap_q_view`,
 * `lp_trade_headroom_before_matcher`, `ensure_protocol_side_oi_cap_view`).
 *
 * Every function is integer-exact bigint and named after the Rust fn it
 * mirrors. `maxTradeSizePerSide` combines them with the matcher caps into the
 * order ticket's live "max long / max short".
 */
import {
  BPS,
  DEFAULT_EXEC_BAND_BPS,
  MAX_EXEC_BAND_BPS,
  MAX_LP_EXPOSURE_K_BPS,
  MAX_OI_SIDE_Q,
  POS_SCALE,
} from "./constants";
import { UNLIMITED_CAPACITY } from "@/lib/marketCapacity";
import { lpInventoryRoomQ } from "./lp-inventory-room";
import { conservativeEquity, vaultLpCapQ } from "./vault-tranche";

export type Side = "long" | "short";

/** `effective_exec_band_bps`. */
export function effectiveExecBandBps(stored: number): number {
  if (stored === 0) return DEFAULT_EXEC_BAND_BPS;
  if (stored > MAX_EXEC_BAND_BPS) return MAX_EXEC_BAND_BPS;
  return stored;
}

/**
 * `exec_price_within_band` (P1 71da9917): `|exec - ref| * 1e4 <= ref * band + (1e4 - 1)`,
 * i.e. `diff <= ceil(ref * band / 1e4)` — the band edge rounds OUT one atom so a matcher
 * pricing exactly at the edge with LP-favourable rounding is not refused. Band 0 admits
 * only the exact reference; a zero ref is never in band.
 */
export function execPriceWithinBand(execE6: bigint, refE6: bigint, bandBps: number): boolean {
  if (refE6 === 0n) return false;
  const diff = execE6 > refE6 ? execE6 - refE6 : refE6 - execE6;
  return diff * BPS <= refE6 * BigInt(bandBps) + (BPS - 1n);
}

/** Band edges `ref ± ceil(ref·band/1e4)` — exactly the widest in-band prices. */
export function bandEdgesE6(refE6: bigint, bandBps: number): { lo: bigint; hi: bigint } {
  const n = refE6 * BigInt(bandBps);
  const d = n / BPS + (n % BPS === 0n ? 0n : 1n);
  const lo = refE6 - d;
  return { lo: lo < 0n ? 0n : lo, hi: refE6 + d };
}

/** P1 `exposure_within_cap_fast`: division-free `abs <= lp_exposure_cap_q(...)`; null on overflow / zero price. */
export function exposureWithinCapFast(absQ: bigint, equityAtoms: bigint, kBps: number, priceE6: bigint, posScale = POS_SCALE): boolean | null {
  if (priceE6 === 0n) return null;
  const lhs = absQ * (BPS * priceE6);
  const rhs = equityAtoms * BigInt(kBps) * posScale;
  if (lhs > U128_MAX_ || rhs > U128_MAX_ || equityAtoms * BigInt(kBps) > U128_MAX_) return null;
  return lhs <= rhs;
}
const U128_MAX_ = (1n << 128n) - 1n;

/** `default_lp_exposure_k_bps`: `1e8 / imr_bps`, saturating at the setter max. */
export function defaultLpExposureKBps(initialMarginBps: bigint): number {
  if (initialMarginBps === 0n) return MAX_LP_EXPOSURE_K_BPS;
  const k = 100_000_000n / initialMarginBps;
  return k > BigInt(MAX_LP_EXPOSURE_K_BPS) ? MAX_LP_EXPOSURE_K_BPS : Number(k);
}

/** `effective_lp_exposure_k_bps`. */
export function effectiveLpExposureKBps(stored: number, initialMarginBps: bigint): number {
  if (stored === 0) return defaultLpExposureKBps(initialMarginBps);
  if (stored > MAX_LP_EXPOSURE_K_BPS) return MAX_LP_EXPOSURE_K_BPS;
  return stored;
}

/** `account_equity_init_raw`: `capital + min(pnl, 0) - |fee_credits|` (engine v16.rs:23774). */
export function lpEquityInitRaw(capital: bigint, pnl: bigint, feeCredits: bigint): bigint {
  const feeDebt = feeCredits < 0n ? -feeCredits : feeCredits;
  return capital + (pnl < 0n ? pnl : 0n) - feeDebt;
}

/** `nonneg_equity`. */
export const nonnegEquity = (e: bigint): bigint => (e <= 0n ? 0n : e);

const U128_MAX = (1n << 128n) - 1n;

/**
 * `lp_exposure_cap_q`: `floor(equity * k * POS_SCALE / (1e4 * price))`; zero
 * price => 0 (fail closed); a u128 overflow saturates to u128::MAX like Rust.
 */
export function lpExposureCapQ(equityAtoms: bigint, kBps: number, priceE6: bigint, posScale = POS_SCALE): bigint {
  if (priceE6 === 0n) return 0n;
  const num = equityAtoms * BigInt(kBps) * posScale;
  if (num > U128_MAX) return U128_MAX;
  return num / (BPS * priceE6);
}

/** `lp_risk_increasing`: |after| > |before|. */
export function lpRiskIncreasing(before: bigint, after: bigint): boolean {
  return abs(after) > abs(before);
}

/** `lp_fill_headroom_q`. `lpDeltaSign` is the sign of the LP's position change. */
export function lpFillHeadroomQ(beforeQ: bigint, lpDeltaSign: 1 | -1, capQ: bigint): bigint {
  const a = abs(beforeQ);
  const m = capQ > a ? capQ : a;
  const same = beforeQ === 0n || (beforeQ > 0n && lpDeltaSign > 0) || (beforeQ < 0n && lpDeltaSign < 0);
  if (same) return m - a;
  const s = m + a;
  return s > U128_MAX ? U128_MAX : s;
}

/** `lp_floor_halts`. */
export function lpFloorHalts(equityInit: bigint, floorAtoms: bigint, riskIncreasing: boolean): boolean {
  return riskIncreasing && nonnegEquity(equityInit) <= floorAtoms;
}

/** `effective_side_oi_cap_q`. */
export function effectiveSideOiCapQ(stored: bigint, engineMax = MAX_OI_SIDE_Q): bigint {
  return stored === 0n || stored > engineMax ? engineMax : stored;
}

/** `side_oi_growth_allowed`: a side may end above the cap only if it did not grow. */
export function sideOiGrowthAllowed(before: bigint, after: bigint, cap: bigint): boolean {
  return after <= cap || after <= before;
}

/** The taker's side moves the LP the opposite way (taker long => LP delta negative). */
export const lpDeltaSignFor = (side: Side): 1 | -1 => (side === "long" ? -1 : 1);

/**
 * `floored_lp_reducing_room_q` (P1 6066399f, P1-K1): a FLOORED LP's room is
 * `|before|` when the move reduces it (opposite sign), else 0 = halted.
 */
export function flooredLpReducingRoomQ(beforeQ: bigint, lpDeltaSign: 1 | -1): bigint {
  const reduces = (beforeQ > 0n && lpDeltaSign < 0) || (beforeQ < 0n && lpDeltaSign > 0);
  return reduces ? abs(beforeQ) : 0n;
}

/**
 * Port of `lp_trade_headroom_before_matcher` (P1 6066399f): the size the
 * wrapper hands the matcher in `side`. A floored LP only takes the reducing
 * part, clipped to flatten; with 0 room the wrapper REFUSES (LpFloorHalt, not
 * a zero fill), which is why the ticket disables that side.
 */
export function lpTradeHeadroomQ(
  lpPosQ: bigint,
  side: Side,
  capQ: bigint,
  floorBreached: boolean,
): bigint {
  const sign = lpDeltaSignFor(side);
  if (floorBreached) return flooredLpReducingRoomQ(lpPosQ, sign);
  return lpFillHeadroomQ(lpPosQ, sign, capQ);
}

/** Position contribution to a side's OI (basis; effective OI is A-scaled <= basis). */
const pos = (x: bigint): bigint => (x > 0n ? x : 0n);
const neg = (x: bigint): bigint => (x < 0n ? -x : 0n);

/**
 * Side-OI after a taker fill of signed `sizeQ` against the LP, both sides.
 * Only the two traded portfolios' legs change (the fill is bilateral).
 */
export function sideOiAfterFill(
  oiLong: bigint,
  oiShort: bigint,
  takerPosQ: bigint,
  lpPosQ: bigint,
  sizeQ: bigint,
): { long: bigint; short: bigint } {
  const t1 = takerPosQ + sizeQ;
  const l1 = lpPosQ - sizeQ;
  const long = oiLong - pos(takerPosQ) - pos(lpPosQ) + pos(t1) + pos(l1);
  const short = oiShort - neg(takerPosQ) - neg(lpPosQ) + neg(t1) + neg(l1);
  return { long: long < 0n ? 0n : long, short: short < 0n ? 0n : short };
}

/**
 * Largest |size| in `side` that `ensure_protocol_side_oi_cap_view` accepts.
 * The allowed set is a prefix in |size| (once a side exceeds both its cap and
 * its before-value it only grows), so a binary search is exact.
 */
export function sideOiHeadroomQ(
  oiLong: bigint,
  oiShort: bigint,
  takerPosQ: bigint,
  lpPosQ: bigint,
  side: Side,
  capQ: bigint,
  searchMaxQ: bigint = MAX_OI_SIDE_Q * 2n,
): bigint {
  const ok = (m: bigint): boolean => {
    const s = side === "long" ? m : -m;
    const a = sideOiAfterFill(oiLong, oiShort, takerPosQ, lpPosQ, s);
    return sideOiGrowthAllowed(oiLong, a.long, capQ) && sideOiGrowthAllowed(oiShort, a.short, capQ);
  };
  if (ok(searchMaxQ)) return searchMaxQ;
  let lo = 0n;
  let hi = searchMaxQ;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export type SizeLimitReason =
  | "lp-halt"
  | "lp-exposure"
  | "side-oi"
  | "matcher-fill"
  | "matcher-inventory"
  | "vault-lp-exposure"
  | "same-owner"
  | "none";

export interface SideLimit {
  /** Largest |size| (base q) that fills in full. UNLIMITED_CAPACITY = no binding limit. */
  maxQ: bigint;
  reason: SizeLimitReason;
  /** Opening in this side is halted (LP at its floor and this side grows LP risk). */
  halted: boolean;
}

export interface SizeLimitInputs {
  priceE6: bigint;
  initialMarginBps: bigint;
  oiEffLongQ: bigint;
  oiEffShortQ: bigint;
  limits: { sideOiCapQ: bigint; lpFloorAtoms: bigint; lpExposureKBps: number };
  /** LP portfolio; null = unknown (then the P1 LP rules are not applied). */
  lp: { posQ: bigint; capital: bigint; pnl: bigint; feeCredits: bigint } | null;
  /** The taker's own signed position on the asset (0 if none / unknown). */
  takerPosQ: bigint;
  /**
   * Matcher caps; null = unknown. `maxFillAbs == 0` = no per-fill cap. `inventoryBase` is the ctx
   * counter; `lpRealQ` the LP's real ADL-effective position and `syncLive` whether the upgraded
   * matcher prices from it (lib/limits/lp-inventory-room.ts: min of both until live). Both
   * optional so a caller without them keeps the counter-only behaviour.
   */
  matcher: { maxFillAbs: bigint; maxInventoryAbs: bigint; inventoryBase: bigint | null; lpRealQ?: bigint | null; syncLive?: boolean } | null;
  /**
   * P3-H2: the LP IS the asset's bound vault LP => its protocol exposure cap
   * (`|pos|·mark <= conservative_equity · lev / 1e4`, default 1x) also applies.
   * Checked post-fill by the program (refusal Custom(80), not a clip).
   */
  vaultLp?: { levBps: number } | null;
}

export interface LpRiskState {
  equity: bigint;
  kBps: number;
  capQ: bigint;
  floorBreached: boolean;
}

/** `lp_floor_and_cap_q_view`. */
export function lpRiskState(i: SizeLimitInputs): LpRiskState | null {
  if (!i.lp) return null;
  const equity = lpEquityInitRaw(i.lp.capital, i.lp.pnl, i.lp.feeCredits);
  const kBps = effectiveLpExposureKBps(i.limits.lpExposureKBps, i.initialMarginBps);
  return {
    equity,
    kBps,
    capQ: lpExposureCapQ(nonnegEquity(equity), kBps, i.priceE6),
    floorBreached: lpFloorHalts(equity, i.limits.lpFloorAtoms, true),
  };
}

/**
 * The ticket's live max size per side: the tightest of P1 LP headroom, P1
 * side-OI headroom, the matcher's per-fill cap and its inventory headroom.
 * Ties resolve in the order listed (the most explainable reason first).
 */
export function maxTradeSizePerSide(i: SizeLimitInputs): Record<Side, SideLimit> {
  const risk = lpRiskState(i);
  const oiCap = effectiveSideOiCapQ(i.limits.sideOiCapQ);
  const one = (side: Side): SideLimit => {
    const cands: { q: bigint; r: SizeLimitReason }[] = [];
    let halted = false;
    if (risk && i.lp) {
      // P1 99165722 (F-7): the LP's halt / cap applies to EVERY fill that grows the LP,
      // including a taker's close; only the direction that REDUCES the LP is free. So the
      // room is the LP headroom alone (the e74809b1 taker-close exemption is gone).
      const room = lpTradeHeadroomQ(i.lp.posQ, side, risk.capQ, risk.floorBreached);
      if (risk.floorBreached) {
        halted = room === 0n;
        cands.push({ q: room, r: "lp-halt" });
      } else {
        cands.push({ q: room, r: "lp-exposure" });
      }
      cands.push({ q: sideOiHeadroomQ(i.oiEffLongQ, i.oiEffShortQ, i.takerPosQ, i.lp.posQ, side, oiCap), r: "side-oi" });
      if (i.vaultLp) {
        const eq = conservativeEquity(i.lp.capital, i.lp.pnl, i.lp.feeCredits) ?? 0n;
        const vcap = vaultLpCapQ(eq, i.vaultLp.levBps, i.priceE6);
        cands.push({ q: lpFillHeadroomQ(i.lp.posQ, lpDeltaSignFor(side), vcap), r: "vault-lp-exposure" });
      }
    }
    if (i.matcher) {
      if (i.matcher.maxFillAbs > 0n) cands.push({ q: i.matcher.maxFillAbs, r: "matcher-fill" });
      const inv = lpInventoryRoomQ(
        { counterQ: i.matcher.inventoryBase, realQ: i.matcher.lpRealQ ?? null, maxInventoryAbs: i.matcher.maxInventoryAbs, syncLive: i.matcher.syncLive === true },
        side,
      );
      if (inv !== null && inv !== UNLIMITED_CAPACITY) cands.push({ q: inv, r: "matcher-inventory" });
    }
    let best: SideLimit = { maxQ: UNLIMITED_CAPACITY, reason: "none", halted };
    for (const c of cands) if (c.q < best.maxQ) best = { maxQ: c.q, reason: c.r, halted };
    return best;
  };
  return { long: one("long"), short: one("short") };
}

/**
 * Clamp a requested |size| to the side's max. Returns the clamped size and
 * whether a clamp happened (the ticket must say so — never clamp silently).
 */
export function clampSizeQ(requestedQ: bigint, limit: SideLimit): { sizeQ: bigint; clamped: boolean } {
  if (requestedQ <= limit.maxQ) return { sizeQ: requestedQ, clamped: false };
  return { sizeQ: limit.maxQ, clamped: true };
}

/**
 * `position_change_reduce_only` (P1 2e7f87de): a change is reduce-only iff it ends flat,
 * or keeps the same side with no larger magnitude (no flip, no growth).
 */
export function positionChangeReduceOnly(beforeQ: bigint, afterQ: bigint): boolean {
  if (afterQ === 0n) return true;
  return beforeQ !== 0n && beforeQ > 0n === afterQ > 0n && abs(afterQ) <= abs(beforeQ);
}

export type LpGate = "allow" | "floor-halt" | "cap-exceeded";

/**
 * `lp_fill_gate` (P1 99165722, F-7 HIGH), the post-fill LP rule on every route:
 * 1. a fill that does not grow the LP's magnitude => allowed (so every close that REDUCES the
 *    LP always passes);
 * 2. else a floored LP halts; an LP past its cap is refused.
 * The counterparty's own direction is NOT an exemption any more: e74809b1 exempted taker
 * closes, which let two non-LP wallets open bilaterally and then "close" one side INTO a
 * capped or halted LP (F-7). The counterparty positions stay in the signature, as in Rust.
 */
export function lpFillGate(
  _counterpartyBeforeQ: bigint,
  _counterpartyAfterQ: bigint,
  lpBeforeQ: bigint,
  lpAfterQ: bigint,
  capQ: bigint,
  floorBreached: boolean,
): LpGate {
  if (!lpRiskIncreasing(lpBeforeQ, lpAfterQ)) return "allow";
  if (floorBreached) return "floor-halt";
  if (abs(lpAfterQ) > capQ) return "cap-exceeded";
  return "allow";
}

/** `floored_lp_move_allowed`: on the non-clipping routes a floored LP may not grow. */
export const flooredLpMoveAllowed = (beforeQ: bigint, afterQ: bigint): boolean => !lpRiskIncreasing(beforeQ, afterQ);

/**
 * Item 2 with the reduce-only exemption (P1 2e7f87de): a same-owner / creator taker may
 * only CLOSE. Largest |size| such a taker can send in `side`: |position| when the side
 * reduces it (clipped so it cannot flip), else 0.
 */
export function sameOwnerRoomQ(takerPosQ: bigint, side: Side): bigint {
  const reduces = (takerPosQ > 0n && side === "short") || (takerPosQ < 0n && side === "long");
  return reduces ? abs(takerPosQ) : 0n;
}

/** Same-owner rule (P1 item 2): taker owner == LP owner, or == a non-zero asset_admin. */
export function sameOwnerBlocked(
  takerOwner: Uint8Array | null,
  lpOwner: Uint8Array | null,
  assetAdmin: Uint8Array | null,
): boolean {
  if (!takerOwner) return false;
  const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, k) => x === b[k]);
  if (lpOwner && eq(takerOwner, lpOwner)) return true;
  if (assetAdmin && assetAdmin.some((x) => x !== 0) && eq(takerOwner, assetAdmin)) return true;
  return false;
}

/** OI utilisation vs the effective cap, bps (0..10000+). */
export function oiUtilisationBps(oiQ: bigint, capQ: bigint): number {
  if (capQ === 0n) return 0;
  return Number((oiQ * BPS) / capQ);
}

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}
