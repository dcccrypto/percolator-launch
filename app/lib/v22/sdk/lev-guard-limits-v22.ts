/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk fix/v22-sdk-rc23-open-limits @ e4d99ac (rc23 open limits; parity with
 * percolator-prog 02524b05's own functions in the SDK suite), src/abi/lev-guard-limits-v22.ts. Only the imports are retargeted. Delete when
 * @percolatorct/sdk >= 9.0.0 ships it. Do not edit here; fix upstream in percolator-sdk.
 */
/**
 * v2.2 leverage guard (tag 124): the OPEN rules a client needs to quote what the program allows, ported bit-exact from
 * percolator-prog `feat/v22-rc23-2026-10-22` @ `02524b05`: `src/lev_guard_v22.rs` (pure rules) and `lev_trade_post` in
 * `src/v16_program.rs` (how a risk-increasing TradeCpi fill is judged). Refusals there are error 133 (`LevGuardRefused`, log
 * `lev_guard_refused <why>`), or 132 (`LevGuardRequired`) when the market needs a guard and none is appended / valid.
 *
 * Order of the program's checks after a fill that increases the taker's risk (taker != LP):
 *  1. guard required (growth flag bit 2, or a mainnet build on a clamp-enforced market) and missing / invalid -> 132;
 *  2. `age < 6 h` -> `age_under_6h`;
 *  3. a live W1 round and `|LP after| > |LP before|` -> `lp_stop_round`;
 *  4. the price band observes the target price (may start a freeze / m_oracle IN this transaction);
 *  5. leverage: `equity >= ceil(floor(|taker after|·P/1e6) · IMR / 1e4)`, `IMR = max(engine IMR, ceil(1e6 / L_eff))`,
 *     `L_eff = min(L_now, max(L_floor, min(L_trader, l_cap)·[3/4 m_oracle] ∧ [frozen L]))` -> `leverage`;
 *  6. size: `|LP after| > |LP before|` and `|LP after| > n_eff` -> `size`;
 *  7. short (taker after < 0): users' short notional `> longs·min(1, MMR/m) + β·C_m/m` -> `short_dump_cap`.
 * Each is a separate refusal, so the limit in force is the tightest of all of them.
 */
import type { LevAgeBandV22 } from "./lev-guard-v22";
import { levAgeBandIsYoungV22, levAgeBandV22, LEV_AGE_NO_OPEN_SLOTS_V22 } from "./lev-guard-v22";
import type { LevGuardV22, LevReportAgeV22 } from "./lev-guard-decode-v22";
import { levReportAgeV22, levW1RoundLiveV22 } from "./lev-guard-decode-v22";
import { ceilingImrBps, GROWTH_POS_SCALE, isqrtCeil, nCapQ, sigmaHBps, usersSideOiQ, wholeTokenAtoms } from "./records/growth-v19";

const BPS = 10_000n;
const U16_MAX = 0xffff;

/** `growth_v19::GROWTH_FLAG_LEV_GUARD`: growth `flags` bit 2, set by tag 124 op 0 INIT. */
export const GROWTH_FLAG_LEV_GUARD_V22 = 0x04;

// ── constants (lev_guard_v22.rs) ────────────────────────────────────────────────────────────
export const LEV_SLOTS_PER_HOUR = 9_000n;
export const LEV_SLOTS_PER_DAY = 216_000n;
export const LEV_J_DUMP_DEFAULT_DAY_BPS = 3_500;
export const LEV_J_DUMP_DEFAULT_WEEK_BPS = 2_000;
export const LEV_M_IND_DEFAULT_YOUNG_BPS = 5_000;
export const LEV_J_DUMP_STALE_OLD_BPS = 1_000;
export const LEV_M_IND_STALE_OLD_BPS = 2_500;
export const LEV_HOLDER_PROOF_SLOTS = LEV_SLOTS_PER_DAY;
export const LEV_L_FLOOR_X100 = 200;
export const LEV_Z_NUM = 233n;
export const LEV_Z_DEN = 100n;
export const LEV_PHI_OPEN_BPS = 30n;
export const LEV_M_ORACLE_NUM = 3;
export const LEV_M_ORACLE_DEN = 4;
export const LEV_N_FLOOR_USD = 200n;
export const LEV_BETA_YOUNG_BPS = 1_000;
export const LEV_BETA_BPS = 5_000;
export const LEV_BURST_VAR_FLOOR_DIV = 4;
export const LEV_BURST_HALF_LIFE_SLOTS = 7n * LEV_SLOTS_PER_DAY;
export const LEV_BREAKER_SAMPLE_BPS = 1_000n;
export const LEV_BREAKER_HOUR_BPS = 3_000n;
export const LEV_ABNORMAL_SIGMA_MULT = 4n;
export const LEV_FREEZE_SLOTS = LEV_SLOTS_PER_HOUR;
export const LEV_M_ORACLE_SLOTS = LEV_SLOTS_PER_DAY;
/** `lev_profile_v22::VOL_PROFILE_LIVE` (false at 02524b05): the vol-profile open floor is wired but changes nothing. */
export const LEV_VOL_PROFILE_LIVE = false;

const AGE_ORDER: Record<LevAgeBandV22, number> = { NoOpen: 0, Day: 1, Week: 2, Month: 3, Mature: 4 };
const min16 = (a: number, b: number): number => (a < b ? a : b);
const max16 = (a: number, b: number): number => (a > b ? a : b);
const capBps = (x: number): number => min16(x, 10_000);
const minB = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const maxB = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const absB = (a: bigint): bigint => (a < 0n ? -a : a);

// ── overlay (default ⊓ report ⊓ permissionless facts) ──────────────────────────────────────

/** `Overlay`: `lCapX100` 0xFFFF = none. */
export interface LevOverlayV22 {
  jDumpBps: number;
  mIndBps: number;
  lCapX100: number;
  nMultBps: number;
}

/** `default_overlay(band, rep)`. */
export function levDefaultOverlayV22(band: LevAgeBandV22, rep: LevReportAgeV22): LevOverlayV22 {
  let j = 0;
  let m = 0;
  if (band === "NoOpen" || band === "Day") [j, m] = [LEV_J_DUMP_DEFAULT_DAY_BPS, LEV_M_IND_DEFAULT_YOUNG_BPS];
  else if (band === "Week") [j, m] = [LEV_J_DUMP_DEFAULT_WEEK_BPS, LEV_M_IND_DEFAULT_YOUNG_BPS];
  else if (rep === "Stale") [j, m] = [LEV_J_DUMP_STALE_OLD_BPS, LEV_M_IND_STALE_OLD_BPS];
  return { jDumpBps: j, mIndBps: m, lCapX100: U16_MAX, nMultBps: 10_000 };
}

/** The guard fields {@link levMergeOverlayV22} reads. */
export type LevOverlayFieldsV22 = Pick<
  LevGuardV22,
  "repJDumpBps" | "repMIndBps" | "repLCapX100" | "repNMultBps" | "repSlot" | "holderDumpBps" | "holderDumpSlot" | "mintAuthLive" | "freezeAuthLive"
> & { permProven?: boolean };

/**
 * `merge_overlay(band, report, perm, now)`: tighten-only (j, m max; l_cap, n_mult min).
 *
 * @example
 * ```ts
 * levMergeOverlayV22("Week", guard, slot).jDumpBps; // >= 2000
 * ```
 */
export function levMergeOverlayV22(band: LevAgeBandV22, g: LevOverlayFieldsV22, nowSlot: bigint, permProofRequired = false): LevOverlayV22 {
  const rep = levReportAgeV22(g.repSlot, nowSlot);
  const o = levDefaultOverlayV22(band, rep);
  if (rep === "Fresh" || rep === "Held") {
    o.jDumpBps = max16(o.jDumpBps, capBps(g.repJDumpBps));
    o.mIndBps = max16(o.mIndBps, capBps(g.repMIndBps));
    if (g.repLCapX100 !== 0) o.lCapX100 = min16(o.lCapX100, g.repLCapX100);
    o.nMultBps = min16(o.nMultBps, capBps(g.repNMultBps));
  }
  if (g.holderDumpSlot !== 0n && nowSlot >= g.holderDumpSlot && nowSlot - g.holderDumpSlot <= LEV_HOLDER_PROOF_SLOTS) {
    const d = capBps(g.holderDumpBps);
    o.jDumpBps = max16(o.jDumpBps, d);
    o.mIndBps = max16(o.mIndBps, d);
  }
  // rc23 `perm_for_gate`: where the proof is required (a mainnet build) a guard no TIGHTEN has proven reads as "mint and freeze live".
  if (g.mintAuthLive || g.freezeAuthLive || (permProofRequired && g.permProven !== true)) {
    o.lCapX100 = 1;
    o.nMultBps = 0;
  }
  return o;
}

// ── leverage ────────────────────────────────────────────────────────────────────────────────

/** `l_floor_x100`: `min(2x, L_eng)`. */
export const levLFloorX100V22 = (lEngX100: number): number => min16(LEV_L_FLOOR_X100, lEngX100);

/**
 * `l_trader_x100`: `floor(1e6 / (MMR + 30 + isqrt_ceil(ceil(σ·233/100)² + J²)))`, saturating at u16; σ `null` reads 0.
 *
 * @example
 * ```ts
 * levLTraderX100V22(500n, null, 3500); // 248 (2.48x: Day band, no vol data)
 * ```
 */
export function levLTraderX100V22(mmrBps: bigint, sigma1hBps: bigint | null, jumpBps: number): number {
  const s = sigma1hBps ?? 0n;
  const zs = (s * LEV_Z_NUM + LEV_Z_DEN - 1n) / LEV_Z_DEN;
  const j = BigInt(jumpBps);
  const cushion = isqrtCeil(zs * zs + j * j);
  const den = mmrBps + LEV_PHI_OPEN_BPS + cushion;
  if (den === 0n) return U16_MAX;
  const l = 1_000_000n / den;
  return l > BigInt(U16_MAX) ? U16_MAX : Number(l);
}

/** `l_overlay_x100`: `min(existing, max(L_floor, min(L_trader, l_cap)·[3/4], [frozen]))`; never above `existing`. */
export function levLOverlayX100V22(
  existingX100: number,
  lTraderX100: number,
  lCapX100: number,
  mOracle: boolean,
  frozenX100: number | null,
  lEngX100: number,
): number {
  let t = min16(lTraderX100, lCapX100);
  if (mOracle) t = Math.floor((t * LEV_M_ORACLE_NUM) / LEV_M_ORACLE_DEN);
  if (frozenX100 !== null) t = min16(t, frozenX100);
  t = max16(levLFloorX100V22(lEngX100), t);
  return min16(existingX100, t);
}

// ── size ────────────────────────────────────────────────────────────────────────────────────

/** `n_overlay_q`: 0 under 6 h, else `min(n_cap, max(n_cap·n_mult, min(n_cap, n_floor)), [frozen])`. */
export function levNOverlayQV22(nCapQ_: bigint, band: LevAgeBandV22, nMultBps: number, nFloorQ: bigint, frozenQ: bigint | null): bigint {
  if (band === "NoOpen") return 0n;
  const m = BigInt(capBps(nMultBps));
  const scaled = (nCapQ_ / BPS) * m + ((nCapQ_ % BPS) * m) / BPS;
  const floor = nFloorQ < nCapQ_ ? nFloorQ : nCapQ_;
  let v = scaled > floor ? scaled : floor;
  if (frozenQ !== null && frozenQ < v) v = frozenQ;
  return v > nCapQ_ ? nCapQ_ : v;
}

// ── short side ──────────────────────────────────────────────────────────────────────────────

export const levBetaBpsV22 = (band: LevAgeBandV22): number => (levAgeBandIsYoungV22(band) ? LEV_BETA_YOUNG_BPS : LEV_BETA_BPS);
export const levMTailBpsV22 = (band: LevAgeBandV22): number => (AGE_ORDER[band] < AGE_ORDER.Mature ? 10_000 : 5_000);
/** `m_dump_bps`: `max(m_ind_rug (100 % under 7 d), 1 %, m_tail)`. */
export function levMDumpBpsV22(band: LevAgeBandV22, mIndBps: number): number {
  const rug = levAgeBandIsYoungV22(band) ? 10_000 : capBps(mIndBps);
  return max16(max16(rug, 100), levMTailBpsV22(band));
}

/** `short_users_cap_notional`: `long_users · min(1, MMR/m) + β·C_m/m` (collateral atoms, floors). */
export function levShortUsersCapNotionalV22(longUsersNotional: bigint, cM: bigint, mmrBps: bigint, band: LevAgeBandV22, mIndBps: number): bigint {
  const m = BigInt(levMDumpBpsV22(band, mIndBps));
  const offBps = minB(BPS, (mmrBps * BPS) / m);
  return (longUsersNotional * offBps) / BPS + (cM * BigInt(levBetaBpsV22(band))) / m;
}

// ── burst memory ────────────────────────────────────────────────────────────────────────────

/** `burst_decay`: halved per whole 7-day half-life, linear inside it. */
export function levBurstDecayV22(peak: number, elapsed: bigint): number {
  const halvings = elapsed / LEV_BURST_HALF_LIFE_SLOTS;
  if (halvings >= 32n) return 0;
  const p = BigInt(peak >>> Number(halvings));
  const rem = elapsed % LEV_BURST_HALF_LIFE_SLOTS;
  const cut = (p * rem) / (2n * LEV_BURST_HALF_LIFE_SLOTS);
  return Number(p - cut);
}

/** `burst_update`: a new high (>= the decayed peak) restarts the clock. */
export function levBurstUpdateV22(peak: number, peakSlot: bigint, varNow: number, nowSlot: bigint): [number, bigint] {
  const eff = levBurstDecayV22(peak, nowSlot > peakSlot ? nowSlot - peakSlot : 0n);
  return varNow >= eff ? [varNow, nowSlot] : [peak, peakSlot];
}

/** `burst_var_eff`: `max(var_now, decayed_peak / 4)`. */
export function levBurstVarEffV22(peak: number, peakSlot: bigint, varNow: number, nowSlot: bigint): number {
  const floor = Math.floor(levBurstDecayV22(peak, nowSlot > peakSlot ? nowSlot - peakSlot : 0n) / LEV_BURST_VAR_FLOOR_DIV);
  return floor > varNow ? floor : varNow;
}

// ── price band ──────────────────────────────────────────────────────────────────────────────

/** `PriceBand` (the guard's `pb_*` fields). */
export interface LevPriceBandV22 {
  lastPx: bigint;
  lastSlot: bigint;
  refPx: bigint;
  refSlot: bigint;
  freezeUntil: bigint;
  oracleUntil: bigint;
}
export type LevTripV22 = "None" | "Freeze" | "Breaker";

export const levPriceBandOfV22 = (g: Pick<LevGuardV22, "pbLastPx" | "pbLastSlot" | "pbRefPx" | "pbRefSlot" | "pbFreezeUntil" | "pbOracleUntil">): LevPriceBandV22 => ({
  lastPx: g.pbLastPx,
  lastSlot: g.pbLastSlot,
  refPx: g.pbRefPx,
  refSlot: g.pbRefSlot,
  freezeUntil: g.pbFreezeUntil,
  oracleUntil: g.pbOracleUntil,
});

/** `move_bps`: `ceil(|a − b|·1e4 / b)`; `b == 0` = a full move. */
export function levMoveBpsV22(a: bigint, b: bigint): bigint {
  if (b === 0n) return (1n << 64n) - 1n;
  const d = absB(a - b);
  return (d * BPS + b - 1n) / b;
}

/** `observe_price`: fold one mark sample; a trip extends the freeze (and m_oracle on a breaker). */
export function levObservePriceV22(b: LevPriceBandV22, px: bigint, nowSlot: bigint, sigma1hBps: bigint | null): { band: LevPriceBandV22; trip: LevTripV22 } {
  const n = { ...b };
  if (px === 0n) return { band: n, trip: "None" };
  if (n.lastPx === 0n || n.refPx === 0n) {
    return { band: { ...n, lastPx: px, lastSlot: nowSlot, refPx: px, refSlot: nowSlot }, trip: "None" };
  }
  const sample = levMoveBpsV22(px, n.lastPx);
  const hour = levMoveBpsV22(px, n.refPx);
  let trip: LevTripV22 = "None";
  if (sample > LEV_BREAKER_SAMPLE_BPS || hour > LEV_BREAKER_HOUR_BPS) trip = "Breaker";
  else if (sigma1hBps !== null && sigma1hBps > 0n && hour > sigma1hBps * LEV_ABNORMAL_SIGMA_MULT) trip = "Freeze";
  if (trip !== "None") n.freezeUntil = maxB(n.freezeUntil, nowSlot + LEV_FREEZE_SLOTS);
  if (trip === "Breaker") n.oracleUntil = maxB(n.oracleUntil, nowSlot + LEV_M_ORACLE_SLOTS);
  n.lastPx = px;
  n.lastSlot = nowSlot;
  if ((nowSlot > n.refSlot ? nowSlot - n.refSlot : 0n) >= LEV_SLOTS_PER_HOUR) {
    n.refPx = px;
    n.refSlot = nowSlot;
  }
  return { band: n, trip };
}
export const levFrozenV22 = (b: LevPriceBandV22, nowSlot: bigint): boolean => nowSlot < b.freezeUntil;
export const levMOracleOnV22 = (b: LevPriceBandV22, nowSlot: bigint): boolean => nowSlot < b.oracleUntil;

// ── the open rules as one view (lev_trade_post) ─────────────────────────────────────────────

/** The market numbers `lev_trade_post` reads (all from the market account + the bound LP). */
export interface LevGuardOpenInputV22 {
  /** The decoded guard, or `null` when the account is absent / undecodable / for another market or asset. */
  guard: LevGuardV22 | null;
  /** The program requires a guard on this asset: growth `flags & 0x04`, or a mainnet build on a clamp-enforced market. */
  guardRequired: boolean;
  nowSlot: bigint;
  /** `l_now`: the growth ceiling in force (x100), the same number the growth gate uses (with the rc23 caps). */
  lNowX100: number;
  /** `n_now`: G8 `N_cap` (Q) with the rc23 κ / λ caps. */
  nCapQ: bigint;
  /** Engine `effective_price` (the notional price). */
  priceE6: bigint;
  /** `lev_target_price`: the oracle target (raw target, else effective) the price band samples. */
  targetPriceE6: bigint;
  /** Growth record: `vol_has_data()` and `vol_var_x100()`. */
  volHasData: boolean;
  volVarX100: number;
  mmrBps: bigint;
  engineImrBps: bigint;
  /** Growth `l_tier_x100` (`L_eng` of the floor). */
  lTierX100: number;
  collateralDecimals: number;
  /** The bound LP's conservative equity `C_m` (atoms). */
  cM: bigint;
  oiEffLongQ: bigint;
  oiEffShortQ: bigint;
  /** The LP's effective signed position BEFORE the fill (Q). */
  lpEffQ: bigint;
  posScale?: bigint;
  /** A mainnet build (`LEV_GUARD_PERM_PROOF_REQUIRED`): an unproven guard is quoted with the authority-live clamp (2x / $200). */
  permProofRequired?: boolean;
}

export type LevGuardBlockV22 = "guard-missing" | "age-under-6h";

/** What the guard allows for a risk-increasing open right now (`applies` false = no guard rules on this market). */
export interface LevGuardOpenLimitsV22 {
  applies: boolean;
  /** Every risk-increasing open is refused: 132 (guard missing) or 133 `age_under_6h`. */
  blocked: LevGuardBlockV22 | null;
  /** First slot opens are allowed when `blocked === "age-under-6h"` (`t0 + 54 000`). */
  opensAtSlot: bigint | null;
  band: LevAgeBandV22 | null;
  roundLive: boolean;
  overlay: LevOverlayV22 | null;
  /** `L_eff` x100 (after the in-transaction price-band sample). */
  lEffX100: number;
  /** The leverage check's IMR (bps). */
  imrBps: bigint | null;
  /** `n_eff` (Q). */
  nEffQ: bigint;
  /** The largest `|LP after|` a fill that grows the LP may reach: `|LP before|` during a W1 round, else `max(|LP before|, n_eff)`. */
  lpAbsMaxQ: bigint;
  /** A freeze / breaker is in force for this fill (incl. one the fill's own sample would start). */
  frozen: boolean;
  mOracle: boolean;
}

const NONE: LevGuardOpenLimitsV22 = {
  applies: false, blocked: null, opensAtSlot: null, band: null, roundLive: false, overlay: null, lEffX100: U16_MAX, imrBps: null,
  nEffQ: 0n, lpAbsMaxQ: 0n, frozen: false, mOracle: false,
};

/**
 * The guard's open limits for the market right now (the taker-independent part of `lev_trade_post`).
 *
 * @example
 * ```ts
 * const lim = levGuardOpenLimitsV22({ guard, guardRequired: true, nowSlot, lNowX100: 500, nCapQ, ... });
 * if (lim.blocked === "age-under-6h") console.log(`opens at slot ${lim.opensAtSlot}`);
 * ```
 */
export function levGuardOpenLimitsV22(i: LevGuardOpenInputV22): LevGuardOpenLimitsV22 {
  if (!i.guardRequired) return NONE;
  const g = i.guard;
  if (!g) return { ...NONE, applies: true, blocked: "guard-missing", lEffX100: 0 };
  const now = i.nowSlot;
  const band = levAgeBandV22(g.t0Slot, now);
  const roundLive = levW1RoundLiveV22(g, now);
  const lpAbs = absB(i.lpEffQ);
  if (band === "NoOpen") {
    return { ...NONE, applies: true, blocked: "age-under-6h", opensAtSlot: g.t0Slot + LEV_AGE_NO_OPEN_SLOTS_V22, band, roundLive, lEffX100: 0, lpAbsMaxQ: lpAbs };
  }
  // lev_market_numbers σ_1h (raw variance) for the band sample; lev_burst_sigma for the leverage term.
  const sigma1h = i.volHasData ? sigmaHBps(i.volVarX100, LEV_SLOTS_PER_HOUR) : null;
  const before = levPriceBandOfV22(g);
  const { band: pb, trip } = levObservePriceV22(before, i.targetPriceE6, now, sigma1h);
  // A trip outside an existing freeze snapshots the CURRENT ceiling and N_cap (lev_observe).
  const tripNow = trip !== "None" && !levFrozenV22(before, now);
  const frozenL = tripNow ? i.lNowX100 : g.frozenLX100;
  const frozenN = tripNow ? i.nCapQ : g.frozenNQ;
  const frozen = levFrozenV22(pb, now);
  const mOracle = levMOracleOnV22(pb, now);
  const ov = levMergeOverlayV22(band, g, now, i.permProofRequired === true);
  let sigmaLev: bigint | null = null;
  if (i.volHasData) {
    const [p, t] = levBurstUpdateV22(g.burstVarPeakX100, g.burstPeakSlot, i.volVarX100, now);
    sigmaLev = sigmaHBps(levBurstVarEffV22(p, t, i.volVarX100, now), LEV_SLOTS_PER_HOUR);
  }
  const lTr = levLTraderX100V22(i.mmrBps, sigmaLev, ov.jDumpBps);
  const lEff = levLOverlayX100V22(i.lNowX100, lTr, ov.lCapX100, mOracle, frozen ? frozenL : null, i.lTierX100);
  const imr = ceilingImrBps(i.engineImrBps, lEff);
  const unit = wholeTokenAtoms(i.collateralDecimals);
  const floorQ = nCapQ(LEV_N_FLOOR_USD * unit, 10_000, i.priceE6, i.posScale ?? GROWTH_POS_SCALE) ?? 0n;
  const nEff = levNOverlayQV22(i.nCapQ, band, ov.nMultBps, floorQ, frozen ? frozenN : null);
  return {
    applies: true, blocked: null, opensAtSlot: null, band, roundLive, overlay: ov, lEffX100: lEff, imrBps: imr, nEffQ: nEff,
    lpAbsMaxQ: roundLive ? lpAbs : maxB(lpAbs, nEff), frozen, mOracle,
  };
}

/** `notional_atoms`: `floor(q · P / POS_SCALE)`. */
const notional = (q: bigint, priceE6: bigint, posScale: bigint): bigint => (q * priceE6) / posScale;

/**
 * The guard's leverage check (`leverage_gate_ok`): `equity >= ceil(floor(|after|·P/1e6) · IMR / 1e4)`; an IMR above 100% fails.
 */
export function levGuardLeverageOkV22(lim: LevGuardOpenLimitsV22, takerEquity: bigint, takerAfterAbsQ: bigint, priceE6: bigint, posScale: bigint = GROWTH_POS_SCALE): boolean {
  if (!lim.applies) return true;
  if (lim.imrBps === null || lim.imrBps > BPS) return false;
  const req = (notional(takerAfterAbsQ, priceE6, posScale) * lim.imrBps + BPS - 1n) / BPS;
  return takerEquity >= req;
}

/** The largest `|taker after|` (Q) the leverage check admits at `takerEquity` (atoms). */
export function levGuardMaxPositionQV22(lim: LevGuardOpenLimitsV22, takerEquity: bigint, priceE6: bigint, posScale: bigint = GROWTH_POS_SCALE): bigint | null {
  if (!lim.applies) return null;
  if (lim.blocked !== null || lim.imrBps === null || lim.imrBps > BPS || priceE6 <= 0n || takerEquity < 0n) return 0n;
  // req(q) is monotone in q: the largest q with req(q) <= equity.
  let lo = 0n;
  let hi = ((takerEquity + 1n) * BPS * posScale) / (lim.imrBps === 0n ? 1n : lim.imrBps) / priceE6 + posScale + 1n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (levGuardLeverageOkV22(lim, takerEquity, mid, priceE6, posScale)) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/** The taker's side change from a fill of `fillQ` in `direction` (users' OI excludes the LP; the LP takes the other side). */
function usersAfter(i: LevGuardOpenInputV22, takerEffQ: bigint, signedFill: bigint): { long: bigint; short: bigint } {
  const pos = (x: bigint) => (x > 0n ? x : 0n);
  const neg = (x: bigint) => (x < 0n ? -x : 0n);
  const after = takerEffQ + signedFill;
  const long0 = usersSideOiQ(i.oiEffLongQ, i.lpEffQ, true);
  const short0 = usersSideOiQ(i.oiEffShortQ, i.lpEffQ, false);
  const l = long0 - pos(takerEffQ) + pos(after);
  const s = short0 - neg(takerEffQ) + neg(after);
  return { long: l > 0n ? l : 0n, short: s > 0n ? s : 0n };
}

/** The short-cap check for a fill that leaves the taker short (`short_dump_cap`); true when it passes or does not apply. */
export function levGuardShortCapOkV22(lim: LevGuardOpenLimitsV22, i: LevGuardOpenInputV22, takerEffQ: bigint, signedFill: bigint): boolean {
  if (!lim.applies || lim.band === null || lim.overlay === null) return true;
  if (takerEffQ + signedFill >= 0n) return true;
  const ps = i.posScale ?? GROWTH_POS_SCALE;
  const u = usersAfter(i, takerEffQ, signedFill);
  const cap = levShortUsersCapNotionalV22(notional(u.long, i.priceE6, ps), i.cM, i.mmrBps, lim.band, lim.overlay.mIndBps);
  return notional(u.short, i.priceE6, ps) <= cap;
}

/**
 * The largest fill (Q, unsigned) in `direction` the guard's SIZE rule (LP net, W1 round) and SHORT cap admit, for a taker at
 * `takerEffQ`. Leverage is separate ({@link levGuardMaxPositionQV22}): it depends on the taker's equity. `null` = no guard rules.
 */
export function levGuardMaxFillQV22(lim: LevGuardOpenLimitsV22, i: LevGuardOpenInputV22, direction: "long" | "short", takerEffQ: bigint): bigint | null {
  if (!lim.applies) return null;
  if (lim.blocked !== null) return 0n;
  // LP is the counterparty: a taker long of Δ moves the LP by −Δ. Allowed iff |LP after| <= lpAbsMaxQ.
  const b = i.lpEffQ;
  let size = direction === "long" ? b + lim.lpAbsMaxQ : lim.lpAbsMaxQ - b;
  if (size < 0n) size = 0n;
  if (direction === "long") return size;
  // Short cap: monotone in the fill (users' shorts rise, users' longs fall), so the largest passing fill by bisection.
  if (levGuardShortCapOkV22(lim, i, takerEffQ, -size)) return size;
  let lo = 0n;
  let hi = size;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (levGuardShortCapOkV22(lim, i, takerEffQ, -mid)) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

export type LevGuardRefusalV22 = "guard_required" | "age_under_6h" | "lp_stop_round" | "leverage" | "size" | "short_dump_cap";

/**
 * Mirror of `lev_trade_post` for one fill: which check refuses it (in the program's order), or `null` when it passes / the fill does
 * not increase the taker's risk (closes are never checked).
 */
export function levGuardRefusalV22(
  lim: LevGuardOpenLimitsV22,
  i: LevGuardOpenInputV22,
  takerEffQ: bigint,
  signedFill: bigint,
  takerEquityAfter: bigint,
): LevGuardRefusalV22 | null {
  if (!lim.applies) return null;
  const after = takerEffQ + signedFill;
  const riskUp = after !== 0n && (takerEffQ === 0n || (takerEffQ > 0n) !== (after > 0n) || absB(after) > absB(takerEffQ));
  if (!riskUp) return null;
  if (lim.blocked === "guard-missing") return "guard_required";
  if (lim.blocked === "age-under-6h") return "age_under_6h";
  const lpBefore = absB(i.lpEffQ);
  const lpAfter = absB(i.lpEffQ - signedFill);
  if (lim.roundLive && lpAfter > lpBefore) return "lp_stop_round";
  if (!levGuardLeverageOkV22(lim, takerEquityAfter, absB(after), i.priceE6, i.posScale ?? GROWTH_POS_SCALE)) return "leverage";
  if (lpAfter > lpBefore && lpAfter > lim.nEffQ) return "size";
  if (!levGuardShortCapOkV22(lim, i, takerEffQ, signedFill)) return "short_dump_cap";
  return null;
}
