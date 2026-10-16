/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk @ ecb6215 (draft dcccrypto/percolator-sdk#406, sdk 9.0.0-candidate),
 * src/abi/v22-math.ts. Only the imports are retargeted (the installed @percolatorct/sdk 8.0.0 root, the v2.1 txv1 port, and the sibling v22 ports).
 * Delete when @percolatorct/sdk >= 9.0.0 ships and point ./index.ts at the package. Do not edit here; fix upstream in percolator-sdk.
 */
/**
 * Pure math of the v2.2 programs, ported 1:1 from the wrapper modules `bond_v20`, `p4_rescue_ins`,
 * `wave_a_v22` and the engine's `band_rent`, plus the quote helpers built on them (bond deposit /
 * withdraw, rescue, redemption floor and refresh selection, lot display).
 *
 * Everything is `bigint` and integer-only. `null` always means what `None` means in Rust: fail closed
 * (overflow, zero denominator, corrupt input), never "allow". Every function with a Rust twin is run
 * against the REAL crate by `test/v22-math.test.ts` over the rows in `test/fixtures/v22-parity.json`
 * (`scripts/v22-parity/sdk_v22_parity.rs`).
 *
 * @module v22-math
 */
import {
  BAND_GENESIS_FLOOR_MULTIPLE_V22,
  BOND_COUPON_MAX_LEG_BPS_V22,
  BOND_UTIL_BONUS_MAX_BPS_V22,
  EXIT_DIP_BPS_V22,
  INS_UNITS_GENESIS_MIN_ATOMS_V22,
  MAX_BAND_BPS_V22,
  MIN_BAND_WIDTH_TICKS_V22,
  REDEMPTION_REFRESH_BASE_WEIGHT_V22,
  REDEMPTION_REFRESH_MAX_V22,
  REDEMPTION_REFRESH_WEIGHT_BUDGET_V22,
  RESCUE_MAX_MULT_V22,
  RESCUE_MIN_ATOMS_V22,
  RESCUE_NAV_FLOOR_BPS_V22,
  SLOTS_PER_YEAR_V22,
  G9_DELAY_SLOTS_V22,
  G9_EXEC_WINDOW_SLOTS_V22,
  LOT_EXP_MAX_V22,
  LOT_PRICE_FLOOR_E6_V22,
} from "./v22-wire";

const BPS = 10_000n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
/** engine `MAX_ORACLE_PRICE` (1e12). */
export const MAX_ORACLE_PRICE_V22 = 1_000_000_000_000n;

/**
 * `a * b / d` rounded down (`vault_lp_v18::mul_div_floor`): `null` on `d == 0` or a u128 overflow of `a * b`.
 *
 * @param a  Multiplicand.
 * @param b  Multiplier.
 * @param d  Divisor.
 * @returns The floor, or `null` (fail closed).
 * @example
 * ```ts
 * mulDivFloorV22(7n, 3n, 2n); // 10n
 * ```
 */
export function mulDivFloorV22(a: bigint, b: bigint, d: bigint): bigint | null {
  if (d === 0n) return null;
  const p = a * b;
  if (p > U128_MAX) return null;
  return p / d;
}

/**
 * `ceil(a * b / d)` (`p4_rescue_ins::mul_div_ceil`).
 *
 * @param a  Multiplicand.
 * @param b  Multiplier.
 * @param d  Divisor.
 * @returns The ceiling, or `null`.
 * @example
 * ```ts
 * mulDivCeilV22(7n, 3n, 2n); // 11n
 * ```
 */
export function mulDivCeilV22(a: bigint, b: bigint, d: bigint): bigint | null {
  if (d === 0n) return null;
  const p = a * b;
  if (p > U128_MAX) return null;
  return p / d + (p % d !== 0n ? 1n : 0n);
}

/**
 * `floor(x * bps / 10_000)` for `bps <= 10_000` (`bps_floor`).
 *
 * @param x    Amount.
 * @param bps  Basis points.
 * @returns The floor, or `null` above 10,000 bps.
 * @example
 * ```ts
 * bpsFloorV22(1_000_000n, 25); // 2_500n
 * ```
 */
export function bpsFloorV22(x: bigint, bps: number): bigint | null {
  const b = BigInt(bps);
  if (b > BPS) return null;
  return (x / BPS) * b + ((x % BPS) * b) / BPS;
}

/**
 * `ceil(x * bps / 10_000)` for `bps <= 10_000` (`bps_ceil`).
 *
 * @param x    Amount.
 * @param bps  Basis points.
 * @returns The ceiling, or `null` above 10,000 bps.
 * @example
 * ```ts
 * bpsCeilV22(1_001n, 25); // 3n
 * ```
 */
export function bpsCeilV22(x: bigint, bps: number): bigint | null {
  const b = BigInt(bps);
  if (b > BPS) return null;
  const rem = (x % BPS) * b;
  return (x / BPS) * b + rem / BPS + (rem % BPS !== 0n ? 1n : 0n);
}

// ============================================================================
// Capacity bonds (bond_v20)
// ============================================================================

/** The vault value split senior / bond / junior (`TrancheSplit3`). `senior + bond + junior == V`. */
export interface TrancheSplit3V22 {
  senior: bigint;
  bond: bigint;
  junior: bigint;
}

/**
 * `tranche_split3`: `senior = min(V, C_s)`, `bond = min(V - senior, C_b)`, `junior = V - senior - bond`.
 *
 * @param vaultValue   `V`.
 * @param seniorClaim  `C_s`.
 * @param bondClaim    `C_b`.
 * @returns The split.
 * @example
 * ```ts
 * trancheSplit3V22(1_000n, 800n, 150n); // { senior: 800n, bond: 150n, junior: 50n }
 * ```
 */
export function trancheSplit3V22(vaultValue: bigint, seniorClaim: bigint, bondClaim: bigint): TrancheSplit3V22 {
  const senior = vaultValue < seniorClaim ? vaultValue : seniorClaim;
  const rest = vaultValue - senior;
  const bond = rest < bondClaim ? rest : bondClaim;
  return { senior, bond, junior: rest - bond };
}

/**
 * `bond_impaired`: the tranche is impaired iff its value is below its claim.
 *
 * @param vaultValue   `V`.
 * @param seniorClaim  `C_s`.
 * @param bondClaim    `C_b`.
 * @returns `true` when impaired (deposits are refused with 107).
 * @example
 * ```ts
 * bondImpairedV22(880n, 800n, 150n); // true
 * ```
 */
export function bondImpairedV22(vaultValue: bigint, seniorClaim: bigint, bondClaim: bigint): boolean {
  return trancheSplit3V22(vaultValue, seniorClaim, bondClaim).bond < bondClaim;
}

/**
 * `vault_value_worse`: the vault value at the price WORSE for the vault LP (the E-1 rule tag 77 / 108 / 110 use).
 *
 * @param navPlusH         Backing NAV plus the harvestable fee leg.
 * @param lpValueAtEff     The vault LP's value at the effective price.
 * @param lpEquityWorse    The vault LP's equity at the worse (lag) price, signed.
 * @returns `V`.
 * @example
 * ```ts
 * vaultValueWorseV22(1_000n, 200n, 150n); // 1_150n
 * ```
 */
export function vaultValueWorseV22(navPlusH: bigint, lpValueAtEff: bigint, lpEquityWorse: bigint): bigint {
  if (lpEquityWorse >= 0n) {
    const w = lpEquityWorse;
    return navPlusH + (lpValueAtEff < w ? lpValueAtEff : w);
  }
  const d = -lpEquityWorse;
  return navPlusH > d ? navPlusH - d : 0n;
}

/**
 * `bond_shares_for_deposit`: shares minted for `amount` (genesis 1:1, rounded down, `null` when the tranche
 * has shares but zero value).
 *
 * @param amount        Deposit atoms.
 * @param totalShares   `B`.
 * @param bondValue     The bonds' layer of `V`.
 * @returns Shares, or `null`.
 * @example
 * ```ts
 * bondSharesForDepositV22(1_000n, 0n, 0n); // 1_000n
 * ```
 */
export function bondSharesForDepositV22(amount: bigint, totalShares: bigint, bondValue: bigint): bigint | null {
  if (totalShares === 0n) return amount;
  if (bondValue === 0n) return null;
  return mulDivFloorV22(amount, totalShares, bondValue);
}

/**
 * `bond_atoms_for_redemption`: `floor(shares * bond_value / B)`.
 *
 * @param shares       Shares redeemed.
 * @param totalShares  `B`.
 * @param bondValue    The bonds' layer of `V`.
 * @returns Atoms, or `null` (`shares > B` or `B == 0`).
 * @example
 * ```ts
 * bondAtomsForRedemptionV22(100n, 1_000n, 900n); // 90n
 * ```
 */
export function bondAtomsForRedemptionV22(shares: bigint, totalShares: bigint, bondValue: bigint): bigint | null {
  if (totalShares === 0n || shares > totalShares) return null;
  return mulDivFloorV22(shares, bondValue, totalShares);
}

/**
 * `bond_claim_after_redemption`: `C_b - floor(shares * C_b / B)`.
 *
 * @param bondClaim    `C_b`.
 * @param shares       Shares redeemed.
 * @param totalShares  `B`.
 * @returns New claim, or `null`.
 * @example
 * ```ts
 * bondClaimAfterRedemptionV22(1_000n, 250n, 1_000n); // 750n
 * ```
 */
export function bondClaimAfterRedemptionV22(bondClaim: bigint, shares: bigint, totalShares: bigint): bigint | null {
  if (totalShares === 0n || shares > totalShares) return null;
  const slice = mulDivFloorV22(shares, bondClaim, totalShares);
  if (slice === null || slice > bondClaim) return null;
  return bondClaim - slice;
}

/**
 * `bond_cap_ok`: `C_b after <= floor(cap * (C_eff + junior))` (refused with 123 otherwise).
 *
 * @param bondClaimAfter  `C_b` after the deposit.
 * @param seniorClaimEff  `C_eff`.
 * @param junior          Junior value.
 * @param capBps          `bond_cap_bps_of_c`.
 * @returns `true` when the deposit fits.
 * @example
 * ```ts
 * bondCapOkV22(500n, 800n, 200n, 5000); // true
 * ```
 */
export function bondCapOkV22(bondClaimAfter: bigint, seniorClaimEff: bigint, junior: bigint, capBps: number): boolean {
  const cap = bpsFloorV22(seniorClaimEff + junior, capBps);
  return cap !== null && bondClaimAfter <= cap;
}

/**
 * `bond_withdraw_lock_ok` (the open-interest lock on a Live bond exit, refused with 108 otherwise):
 * `N_cap(C_m - x) >= max(OI_long, OI_short, |LP_eff|)`; `nCapAfter === null` (growth off) only passes with nothing open.
 *
 * @param nCapAfter     `N_cap` after the withdrawal, or `null`.
 * @param oiLongQ       Long OI.
 * @param oiShortQ      Short OI.
 * @param lpEffAbsQ     `|LP_eff|`.
 * @returns `true` when the lock holds.
 * @example
 * ```ts
 * bondWithdrawLockOkV22(100n, 40n, 60n, 10n); // true
 * ```
 */
export function bondWithdrawLockOkV22(nCapAfter: bigint | null, oiLongQ: bigint, oiShortQ: bigint, lpEffAbsQ: bigint): boolean {
  const side = oiLongQ > oiShortQ ? oiLongQ : oiShortQ;
  const need = side > lpEffAbsQ ? side : lpEffAbsQ;
  return nCapAfter === null ? need === 0n : nCapAfter >= need;
}

/**
 * `bond_cooldown_elapsed`: `now >= request_slot + cooldown` (saturating; refused with 109 before).
 *
 * @param nowSlot        Current slot.
 * @param requestSlot    Slot of tag 109.
 * @param cooldownSlots  The tranche's cooldown.
 * @returns `true` once executable.
 * @example
 * ```ts
 * bondCooldownElapsedV22(9_100n, 100n, 9_000); // true
 * ```
 */
export function bondCooldownElapsedV22(nowSlot: bigint, requestSlot: bigint, cooldownSlots: number): boolean {
  const sum = requestSlot + BigInt(cooldownSlots);
  return nowSlot >= (sum > U64_MAX ? U64_MAX : sum);
}

/**
 * `bond_util_bps`: `min(1, max side OI / N_cap)` in bps (0 with no OI, 10,000 with OI and no capacity).
 *
 * @param maxSideOiQ  Larger side OI.
 * @param nCapQ       `N_cap`.
 * @returns bps.
 * @example
 * ```ts
 * bondUtilBpsV22(50n, 100n); // 5000
 * ```
 */
export function bondUtilBpsV22(maxSideOiQ: bigint, nCapQ: bigint): number {
  if (maxSideOiQ === 0n) return 0;
  if (nCapQ === 0n) return 10_000;
  const p = maxSideOiQ * BPS;
  if (p > U128_MAX) return 10_000;
  const u = p / nCapQ;
  return u >= BPS ? 10_000 : Number(u);
}

/**
 * `bond_coupon_rate_bps`: `base + floor(bonus * u / 10_000)` (the bonus is forced 0 on chain today).
 *
 * @param baseBps       Base coupon.
 * @param utilBonusBps  Bonus (0).
 * @param utilBps       Utilisation.
 * @returns Annual rate in bps.
 * @example
 * ```ts
 * bondCouponRateBpsV22(800, 0, 5000); // 800
 * ```
 */
export function bondCouponRateBpsV22(baseBps: number, utilBonusBps: number, utilBps: number): number {
  const u = utilBps > 10_000 ? 10_000 : utilBps;
  return baseBps + Math.floor((utilBonusBps * u) / 10_000);
}

/**
 * `coupon_due`: `floor(C_b * rate * min(dslots, 1y) / (10_000 * SLOTS_PER_YEAR))`.
 *
 * @param bondClaim  `C_b` (or the coupon base).
 * @param rateBps    Annual rate in bps.
 * @param dslots     Slots since the checkpoint.
 * @returns Atoms, or `null` on overflow.
 * @example
 * ```ts
 * couponDueV22(1_000_000_000n, 800, 78_840_000n); // 80_000_000n
 * ```
 */
export function couponDueV22(bondClaim: bigint, rateBps: number, dslots: bigint): bigint | null {
  const dt = dslots > SLOTS_PER_YEAR_V22 ? SLOTS_PER_YEAR_V22 : dslots;
  const num = bondClaim * BigInt(rateBps);
  if (num > U128_MAX) return null;
  return mulDivFloorV22(num, dt, BPS * SLOTS_PER_YEAR_V22);
}

/**
 * `coupon_gate_open`: a coupon is paid only on a Live market, from a non-empty tranche, with no senior loss
 * outstanding and a whole (not impaired) tranche.
 *
 * @param live                    Market Live.
 * @param bondClaim               `C_b`.
 * @param seniorDrawOutstanding   Senior principal loss outstanding.
 * @param bondValue               The bonds' layer of `V` before the leg.
 * @returns `true` when open.
 * @example
 * ```ts
 * couponGateOpenV22(true, 100n, 0n, 100n); // true
 * ```
 */
export function couponGateOpenV22(live: boolean, bondClaim: bigint, seniorDrawOutstanding: bigint, bondValue: bigint): boolean {
  return live && bondClaim > 0n && seniorDrawOutstanding === 0n && bondValue >= bondClaim;
}

/**
 * `coupon_base`: `min(C_b, bond value)`.
 *
 * @param bondClaim  `C_b`.
 * @param bondValue  Bond value.
 * @returns The coupon base.
 * @example
 * ```ts
 * couponBaseV22(100n, 80n); // 80n
 * ```
 */
export function couponBaseV22(bondClaim: bigint, bondValue: bigint): bigint {
  return bondValue < bondClaim ? bondValue : bondClaim;
}

/**
 * `bond_coupon_split`: the coupon is the lesser of what is due and 50% of the harvested fee leg.
 *
 * @param available  Harvested LP fee leg.
 * @param due        Coupon due.
 * @returns `[coupon, rest]` with `coupon + rest == available`.
 * @example
 * ```ts
 * bondCouponSplitV22(1_000n, 900n); // [500n, 500n]
 * ```
 */
export function bondCouponSplitV22(available: bigint, due: bigint): [bigint, bigint] {
  const cap = bpsFloorV22(available, BOND_COUPON_MAX_LEG_BPS_V22) ?? 0n;
  const coupon = due < cap ? due : cap;
  return [coupon, available - coupon];
}

/** Inputs of {@link quoteBondDepositV22}. */
export interface BondDepositQuoteInput {
  /** Deposit atoms (u64 > 0). */
  amount: bigint;
  /** Tranche `B` and `C_b` (from {@link decodeBondTrancheV20}). */
  bSharesTotal: bigint;
  cBAtoms: bigint;
  /** `bond_cap_bps_of_c`. */
  capBps: number;
  /** Vault value `V` at the worse price, the senior claim `C_eff` and the junior value (from the vault LP state). */
  vaultValue: bigint;
  seniorClaimEff: bigint;
  /** Slippage allowance in bps applied to the minted shares for `minShares` (default 0). */
  slippageBps?: number;
}

/** Result of {@link quoteBondDepositV22}. */
export interface BondDepositQuote {
  /** `null` when the program would refuse; see `refusal`. */
  shares: bigint | null;
  /** `minShares` to put on the wire (`shares` less the slippage allowance). */
  minShares: bigint | null;
  /** The on-chain error the program would raise, by name and code, or `null`. */
  refusal: { code: 107 | 123 | 124; name: "BondTrancheImpaired" | "BondDepositAboveCap" | "BondSlippage" } | null;
}

/**
 * Quote a bond deposit with the program's own rules (tag 108): impaired -> 107, above the cap -> 123,
 * zero shares -> 124. The caller supplies the vault readings (the program reads the vault LP at `P_last`;
 * for an exact quote simulate the instruction).
 *
 * @param i  See {@link BondDepositQuoteInput}.
 * @returns Shares, the `minShares` to send, and the refusal (if any).
 * @example
 * ```ts
 * const q = quoteBondDepositV22({ amount: 1_000_000n, bSharesTotal: 0n, cBAtoms: 0n, capBps: 5000, vaultValue: 2_000_000n, seniorClaimEff: 1_000_000n });
 * ```
 */
export function quoteBondDepositV22(i: BondDepositQuoteInput): BondDepositQuote {
  const split = trancheSplit3V22(i.vaultValue, i.seniorClaimEff, i.cBAtoms);
  if (split.bond < i.cBAtoms) return { shares: null, minShares: null, refusal: { code: 107, name: "BondTrancheImpaired" } };
  if (!bondCapOkV22(i.cBAtoms + i.amount, i.seniorClaimEff, split.junior, i.capBps)) return { shares: null, minShares: null, refusal: { code: 123, name: "BondDepositAboveCap" } };
  const shares = bondSharesForDepositV22(i.amount, i.bSharesTotal, split.bond);
  if (shares === null) return { shares: null, minShares: null, refusal: { code: 107, name: "BondTrancheImpaired" } };
  if (shares === 0n) return { shares: 0n, minShares: null, refusal: { code: 124, name: "BondSlippage" } };
  const slip = BigInt(i.slippageBps ?? 0);
  return { shares, minShares: (shares * (BPS - slip)) / BPS, refusal: null };
}

/** Inputs of {@link quoteBondWithdrawV22}. */
export interface BondWithdrawQuoteInput {
  /** Pending shares of the position (tag 109). */
  shares: bigint;
  bSharesTotal: bigint;
  cBAtoms: bigint;
  vaultValue: bigint;
  seniorClaimEff: bigint;
  /** Live exits only: `N_cap` after the withdrawal and the open interest; omit for a Resolved exit. */
  live?: { nCapAfter: bigint | null; oiLongQ: bigint; oiShortQ: bigint; lpEffAbsQ: bigint };
  slippageBps?: number;
}

/** Result of {@link quoteBondWithdrawV22}. */
export interface BondWithdrawQuote {
  atoms: bigint | null;
  minOut: bigint | null;
  claimAfter: bigint | null;
  refusal: { code: 108 | 110; name: "BondCapacityLocked" | "BondConfigInvalid" } | null;
}

/**
 * Quote a bond withdrawal (tag 110): atoms at the bond value, the claim removed, `min_out`, and the
 * open-interest lock for a Live exit (108).
 *
 * @param i  See {@link BondWithdrawQuoteInput}.
 * @returns The quote.
 * @example
 * ```ts
 * const q = quoteBondWithdrawV22({ shares: 100n, bSharesTotal: 1_000n, cBAtoms: 1_000n, vaultValue: 3_000n, seniorClaimEff: 1_000n });
 * ```
 */
export function quoteBondWithdrawV22(i: BondWithdrawQuoteInput): BondWithdrawQuote {
  const bondValue = trancheSplit3V22(i.vaultValue, i.seniorClaimEff, i.cBAtoms).bond;
  const atoms = bondAtomsForRedemptionV22(i.shares, i.bSharesTotal, bondValue);
  const claimAfter = bondClaimAfterRedemptionV22(i.cBAtoms, i.shares, i.bSharesTotal);
  if (atoms === null || claimAfter === null || i.shares === 0n) return { atoms: null, minOut: null, claimAfter: null, refusal: { code: 110, name: "BondConfigInvalid" } };
  if (i.live && !bondWithdrawLockOkV22(i.live.nCapAfter, i.live.oiLongQ, i.live.oiShortQ, i.live.lpEffAbsQ)) {
    return { atoms, minOut: null, claimAfter, refusal: { code: 108, name: "BondCapacityLocked" } };
  }
  const slip = BigInt(i.slippageBps ?? 0);
  return { atoms, minOut: (atoms * (BPS - slip)) / BPS, claimAfter, refusal: null };
}

/**
 * Assert the utilisation bonus is the only value the program accepts (0) before building tag 107.
 *
 * @param utilBonusBps  Bonus.
 * @throws If non-zero.
 * @example
 * ```ts
 * assertUtilBonusZeroV22(0);
 * ```
 */
export function assertUtilBonusZeroV22(utilBonusBps: number): void {
  if (utilBonusBps > BOND_UTIL_BONUS_MAX_BPS_V22) throw new Error("the utilisation bonus must be 0 (review L-2)");
}

// ============================================================================
// Insurance units and the G9 backstop (p4_rescue_ins)
// ============================================================================

/**
 * `ins_units_for_topup`: `floor(x * U / I_mint)`, genesis 1:1.
 *
 * @param x                      Top-up atoms.
 * @param unitsTotal             `U`.
 * @param insuranceMintReading   The entry reading `I_mint`.
 * @returns Units, or `null`.
 * @example
 * ```ts
 * insUnitsForTopupV22(1_000n, 0n, 0n); // 1_000n
 * ```
 */
export function insUnitsForTopupV22(x: bigint, unitsTotal: bigint, insuranceMintReading: bigint): bigint | null {
  if (unitsTotal === 0n) return x;
  if (insuranceMintReading === 0n) return null;
  return mulDivFloorV22(x, unitsTotal, insuranceMintReading);
}

/**
 * `ins_units_to_burn`: `ceil(a * U / I_free)`; `null` when nothing can be withdrawn or `a > I_free`.
 *
 * @param a              Withdrawn atoms.
 * @param unitsTotal     `U`.
 * @param insuranceFree  The exit reading `I_free`.
 * @returns Units to burn, or `null`.
 * @example
 * ```ts
 * insUnitsToBurnV22(100n, 1_000n, 500n); // 200n
 * ```
 */
export function insUnitsToBurnV22(a: bigint, unitsTotal: bigint, insuranceFree: bigint): bigint | null {
  if (unitsTotal === 0n || insuranceFree === 0n || a > insuranceFree) return null;
  const b = mulDivCeilV22(a, unitsTotal, insuranceFree);
  if (b === null || b > unitsTotal) return null;
  return b;
}

/**
 * `ins_units_value`: `floor(units * I / U)` (0 when `U == 0`).
 *
 * @param units       Units held.
 * @param unitsTotal  `U`.
 * @param insurance   Insurance reading.
 * @returns Atoms, or `null`.
 * @example
 * ```ts
 * insUnitsValueV22(250n, 1_000n, 400n); // 100n
 * ```
 */
export function insUnitsValueV22(units: bigint, unitsTotal: bigint, insurance: bigint): bigint | null {
  if (unitsTotal === 0n) return 0n;
  if (units > unitsTotal) return null;
  return mulDivFloorV22(units, insurance, unitsTotal);
}

/**
 * `ins_mint_admissible` (W-1): a top-up must mint something and lose at most 1 bp (+1 atom) to rounding;
 * at genesis it must be at least 1,000,000 atoms.
 *
 * @param x                     Top-up atoms.
 * @param minted                Units minted.
 * @param unitsTotal            `U` before.
 * @param insuranceMintReading  `I_mint` before.
 * @returns `true` when admitted.
 * @example
 * ```ts
 * insMintAdmissibleV22(1_000_000n, 1_000_000n, 0n, 0n); // true
 * ```
 */
export function insMintAdmissibleV22(x: bigint, minted: bigint, unitsTotal: bigint, insuranceMintReading: bigint): boolean {
  if (x === 0n) return true;
  if (minted === 0n) return false;
  if (unitsTotal === 0n) return x >= INS_UNITS_GENESIS_MIN_ATOMS_V22;
  const p = minted * insuranceMintReading;
  if (p > U128_MAX) return false;
  const value = p / unitsTotal;
  const loss = x > value ? x - value : 0n;
  return loss <= x / BPS + 1n;
}

/**
 * `g9_delay_elapsed`: a G9 DRAW executes only in `[pending + 9,000, pending + 18,000)`.
 *
 * @param pendingSlot  `g9_pending_slot` (0 = none).
 * @param now          Current slot.
 * @returns `true` inside the execution window.
 * @example
 * ```ts
 * g9DelayElapsedV22(1_000n, 10_500n); // true
 * ```
 */
export function g9DelayElapsedV22(pendingSlot: bigint, now: bigint): boolean {
  const start = pendingSlot + G9_DELAY_SLOTS_V22;
  return pendingSlot !== 0n && now >= start && now < start + G9_EXEC_WINDOW_SLOTS_V22;
}

/**
 * `g9_proposal_open`: a proposal blocks a new PROPOSE until its execution window has passed.
 *
 * @param pendingSlot  `g9_pending_slot`.
 * @param now          Current slot.
 * @returns `true` while open.
 * @example
 * ```ts
 * g9ProposalOpenV22(1_000n, 5_000n); // true
 * ```
 */
export function g9ProposalOpenV22(pendingSlot: bigint, now: bigint): boolean {
  return pendingSlot !== 0n && now < pendingSlot + G9_DELAY_SLOTS_V22 + G9_EXEC_WINDOW_SLOTS_V22;
}

/**
 * Which tag-111 mode a keeper may send now, from the units ledger and the clock: `propose` when no proposal
 * is open, `wait` during the 9,000-slot delay, `draw` inside the execution window.
 *
 * @param pendingSlot  `g9_pending_slot`.
 * @param now          Current slot.
 * @returns `"propose" | "wait" | "draw"`.
 * @example
 * ```ts
 * g9PhaseV22(0n, 10n); // "propose"
 * ```
 */
export function g9PhaseV22(pendingSlot: bigint, now: bigint): "propose" | "wait" | "draw" {
  if (!g9ProposalOpenV22(pendingSlot, now)) return "propose";
  return g9DelayElapsedV22(pendingSlot, now) ? "draw" : "wait";
}

/**
 * `g9_epoch_room`: `floor(base * cap) - drawn_this_epoch` (saturating).
 *
 * @param base               `I + outstanding`.
 * @param drawnThisEpoch     Atoms G9 lent this epoch.
 * @param capBps             Epoch cap bps (2,000).
 * @returns Room in atoms.
 * @example
 * ```ts
 * g9EpochRoomV22(1_000n, 100n, 2000); // 100n
 * ```
 */
export function g9EpochRoomV22(base: bigint, drawnThisEpoch: bigint, capBps: number): bigint {
  const cap = bpsFloorV22(base, capBps) ?? 0n;
  return cap > drawnThisEpoch ? cap - drawnThisEpoch : 0n;
}

/**
 * `backstop_draw_amount`: `min(deficit, insurance_free, floor(cap * (gross + outstanding)) - outstanding)`.
 *
 * @param deficit           Certified deficit.
 * @param insuranceFree     Free insurance.
 * @param insuranceGross    Gross insurance.
 * @param outstanding       Backstop already outstanding.
 * @param capBps            Cap bps (5,000).
 * @returns Atoms.
 * @example
 * ```ts
 * backstopDrawAmountV22(500n, 400n, 1_000n, 0n, 5000); // 400n
 * ```
 */
export function backstopDrawAmountV22(deficit: bigint, insuranceFree: bigint, insuranceGross: bigint, outstanding: bigint, capBps: number): bigint {
  const base = insuranceGross + outstanding;
  const capTotal = bpsFloorV22(base, capBps) ?? 0n;
  const room = capTotal > outstanding ? capTotal - outstanding : 0n;
  let m = deficit < insuranceFree ? deficit : insuranceFree;
  m = m < room ? m : room;
  return m;
}

// ============================================================================
// Rescue (item 5)
// ============================================================================

/** Why a rescue is refused (`RescueRefusal`): 114 for everything but the NAV floor (115). */
export type RescueRefusalV22 = "NotImpaired" | "NavFloor" | "Amount" | "Shape";

/**
 * `rescue_admitted`: the rescue admission on the certified readings.
 *
 * @param x    Rescue atoms.
 * @param v    Impaired value the vault's shares can exit at now.
 * @param par  What those shares are owed at par.
 * @param s    Shares outstanding.
 * @returns `null` when admitted, else the refusal.
 * @example
 * ```ts
 * rescueAdmittedV22(100_000_000n, 800_000_000n, 1_000_000_000n, 1_000n); // null
 * ```
 */
export function rescueAdmittedV22(x: bigint, v: bigint, par: bigint, s: bigint): RescueRefusalV22 | null {
  if (s === 0n || par === 0n) return "Shape";
  if (v >= par) return "NotImpaired";
  const lhs = v * BPS;
  const rhs = par * BigInt(RESCUE_NAV_FLOOR_BPS_V22);
  if (lhs > U128_MAX || rhs > U128_MAX) return "Shape";
  if (lhs < rhs || v === 0n) return "NavFloor";
  const max = v * RESCUE_MAX_MULT_V22;
  if (x < RESCUE_MIN_ATOMS_V22 || x > max) return "Amount";
  return null;
}

/**
 * `rescue_shares`: `floor(x * S / v)`.
 *
 * @param x  Rescue atoms.
 * @param s  Shares outstanding.
 * @param v  Impaired value.
 * @returns Shares, or `null`.
 * @example
 * ```ts
 * rescueSharesV22(100n, 1_000n, 800n); // 125n
 * ```
 */
export function rescueSharesV22(x: bigint, s: bigint, v: bigint): bigint | null {
  if (s === 0n || v === 0n) return null;
  return mulDivFloorV22(x, s, v);
}

/**
 * `rescue_claim_delta`: the senior claim added with `m` new shares, `floor(m * C / S)` (bound vaults).
 *
 * @param m  Shares minted.
 * @param c  Senior claim `C`.
 * @param s  Shares outstanding.
 * @returns Claim delta, or `null`.
 * @example
 * ```ts
 * rescueClaimDeltaV22(125n, 1_000n, 1_000n); // 125n
 * ```
 */
export function rescueClaimDeltaV22(m: bigint, c: bigint, s: bigint): bigint | null {
  if (s === 0n) return null;
  return mulDivFloorV22(m, c, s);
}

/** Inputs of {@link quoteRescueV22}. */
export interface RescueQuoteInput {
  /** Rescue atoms (u64). */
  amount: bigint;
  /** Certified impaired value `v` and par at the current reading (bound: tag-77 live senior value and `C`). */
  v: bigint;
  par: bigint;
  /** Senior shares outstanding. */
  shares: bigint;
  /** Bound vaults: the senior claim `C` (to quote the claim delta). */
  seniorClaim?: bigint;
  slippageBps?: number;
}

/** Result of {@link quoteRescueV22}. */
export interface RescueQuote {
  admitted: boolean;
  /** On-chain error when refused: 114 `RescueRefused` or 115 `RescueNavFloor`. */
  refusal: { code: 114 | 115; name: "RescueRefused" | "RescueNavFloor"; reason: RescueRefusalV22 } | null;
  shares: bigint | null;
  minShares: bigint | null;
  claimDelta: bigint | null;
}

/**
 * Quote a rescue deposit (tag 112): admission, shares at the IMPAIRED value (never par), `min_shares`
 * and (bound) the claim delta. Dilution lemma L-RES holds by construction (`m = floor(x S / v)`).
 *
 * @param i  See {@link RescueQuoteInput}.
 * @returns The quote.
 * @example
 * ```ts
 * const q = quoteRescueV22({ amount: 100_000_000n, v: 800_000_000n, par: 1_000_000_000n, shares: 1_000_000n });
 * ```
 */
export function quoteRescueV22(i: RescueQuoteInput): RescueQuote {
  const reason = rescueAdmittedV22(i.amount, i.v, i.par, i.shares);
  if (reason) {
    return { admitted: false, refusal: { code: reason === "NavFloor" ? 115 : 114, name: reason === "NavFloor" ? "RescueNavFloor" : "RescueRefused", reason }, shares: null, minShares: null, claimDelta: null };
  }
  const shares = rescueSharesV22(i.amount, i.shares, i.v);
  const slip = BigInt(i.slippageBps ?? 0);
  return {
    admitted: true,
    refusal: null,
    shares,
    minShares: shares === null ? null : (shares * (BPS - slip)) / BPS,
    claimDelta: shares !== null && i.seniorClaim !== undefined ? rescueClaimDeltaV22(shares, i.seniorClaim, i.shares) : null,
  };
}

// ============================================================================
// Redemption (Wave A item 8)
// ============================================================================

/**
 * `refresh_weight`: a refreshed portfolio weighs `3 + active legs`.
 *
 * @param activeLegs  Active legs of the portfolio.
 * @returns Weight.
 * @example
 * ```ts
 * refreshWeightV22(14); // 17
 * ```
 */
export function refreshWeightV22(activeLegs: number): number {
  return REDEMPTION_REFRESH_BASE_WEIGHT_V22 + activeLegs;
}

/**
 * Pick the portfolios to pass as the inline refresh of a tag 77: every candidate in the order given
 * (callers sort liquidating / stalest first), up to {@link REDEMPTION_REFRESH_MAX_V22} (8) and the leg
 * budget `sum(3 + legs) <= 34`. Candidates that do not fit are returned in `deferred`; a book that needs
 * more than fits must wait for the keeper sweep or use `keeper_ok`.
 *
 * @param candidates  Stale positioned portfolios with their active leg counts.
 * @returns `{ selected, deferred, weight }`.
 * @example
 * ```ts
 * const { selected } = selectRefreshPortfoliosV22(stale.map((p) => ({ key: p.pubkey, legs: p.legs })));
 * ```
 */
export function selectRefreshPortfoliosV22<K>(candidates: readonly { key: K; legs: number }[]): { selected: K[]; deferred: K[]; weight: number } {
  const selected: K[] = [];
  const deferred: K[] = [];
  let weight = 0;
  for (const c of candidates) {
    const w = refreshWeightV22(c.legs);
    if (selected.length < REDEMPTION_REFRESH_MAX_V22 && weight + w <= REDEMPTION_REFRESH_WEIGHT_BUDGET_V22) {
      selected.push(c.key);
      weight += w;
    } else {
      deferred.push(c.key);
    }
  }
  return { selected, deferred, weight };
}

/**
 * The default payout floor: `floor(quote * (10_000 - slippageBps) / 10_000)`, slippage at most 5 bps
 * (wire doc, SDK note 3). Use it on BOTH the tag-76 trailer and the tag-77 wire.
 *
 * @param quotedPayout  The simulated payout, atoms.
 * @param slippageBps   Allowance, `0..=5` by default (a larger value is allowed only with `allowWider`).
 * @param allowWider    Permit more than 5 bps.
 * @returns The floor (at least 1 for a positive quote, because the wire floor must be non-zero).
 * @example
 * ```ts
 * defaultMinPayoutV22(1_000_000n); // 999_500n
 * ```
 */
export function defaultMinPayoutV22(quotedPayout: bigint, slippageBps = 5, allowWider = false): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000 || (!allowWider && slippageBps > 5)) {
    throw new Error("slippageBps must be 0..=5 (the SDK default); pass allowWider to go beyond it");
  }
  if (quotedPayout <= 0n) throw new Error("quotedPayout must be positive: simulate the redemption first");
  const f = (quotedPayout * (BPS - BigInt(slippageBps))) / BPS;
  return f === 0n ? 1n : f;
}

/**
 * `par_atoms`: `floor(shares * principal_total / total_shares)`.
 *
 * @param shares          Shares redeemed.
 * @param principalTotal  Sum of both pots' ledger principal.
 * @param totalShares     Shares outstanding.
 * @returns Par, or `null`.
 * @example
 * ```ts
 * parAtomsV22(100n, 2_000n, 1_000n); // 200n
 * ```
 */
export function parAtomsV22(shares: bigint, principalTotal: bigint, totalShares: bigint): bigint | null {
  if (totalShares === 0n) return null;
  return mulDivFloorV22(shares, principalTotal, totalShares);
}

/**
 * `dip_floor_ok`: a signed exit on a not-loss-current book may pay at most 25 bps below par.
 *
 * @param payout  Payout atoms.
 * @param par     Par atoms.
 * @returns `true` when within the dip tolerance.
 * @example
 * ```ts
 * dipFloorOkV22(9_975n, 10_000n); // true
 * ```
 */
export function dipFloorOkV22(payout: bigint, par: bigint): boolean {
  const need = mulDivCeilV22(par, BPS - BigInt(EXIT_DIP_BPS_V22), BPS);
  return need !== null && payout >= need;
}

// ============================================================================
// Band (engine band_rent) and lot helpers
// ============================================================================

/**
 * `band_bounds`: `(lo, hi)` around `anchor`; `lo = ceil(anchor (10000 - d) / 10000)`, `hi = min(floor(anchor (10000 + d) / 10000), MAX_ORACLE_PRICE)`.
 *
 * @param anchor   Anchor price (1..=1e12).
 * @param bandBps  `d` (1..=2000).
 * @returns `[lo, hi]`, or `null` on invalid input.
 * @example
 * ```ts
 * bandBoundsV22(1_000_000n, 130); // [987_000n, 1_013_000n]
 * ```
 */
export function bandBoundsV22(anchor: bigint, bandBps: number): [bigint, bigint] | null {
  if (anchor <= 0n || anchor > MAX_ORACLE_PRICE_V22 || bandBps <= 0 || bandBps > MAX_BAND_BPS_V22) return null;
  const d = BigInt(bandBps);
  const loNum = anchor * (BPS - d);
  const lo = loNum / BPS + (loNum % BPS !== 0n ? 1n : 0n);
  let hi = (anchor * (BPS + d)) / BPS;
  if (hi > MAX_ORACLE_PRICE_V22) hi = MAX_ORACLE_PRICE_V22;
  return [lo, hi];
}

/**
 * `band_width_ok`: the band around `anchor` is at least 32 ticks wide.
 *
 * @param anchor   Anchor price.
 * @param bandBps  `d`.
 * @returns `true` when wide enough; `null` on invalid input.
 * @example
 * ```ts
 * bandWidthOkV22(1_000_000n, 130); // true
 * ```
 */
export function bandWidthOkV22(anchor: bigint, bandBps: number): boolean | null {
  const b = bandBoundsV22(anchor, bandBps);
  return b === null ? null : b[1] - b[0] >= BigInt(MIN_BAND_WIDTH_TICKS_V22);
}

/**
 * `band_min_wide_anchor`: the smallest anchor from which every anchor in `a..=a+8` has a 32-tick band.
 *
 * @param bandBps  `d`.
 * @returns The anchor, or `null` (none below `MAX_ORACLE_PRICE`, or invalid `d`).
 * @example
 * ```ts
 * bandMinWideAnchorV22(130); // 1231n
 * ```
 */
export function bandMinWideAnchorV22(bandBps: number): bigint | null {
  if (bandBps <= 0 || bandBps > MAX_BAND_BPS_V22) return null;
  const start = (BigInt(MIN_BAND_WIDTH_TICKS_V22) * BPS) / (2n * BigInt(bandBps));
  let a = start > 4n ? start - 4n : 0n;
  if (a < 1n) a = 1n;
  let run = 0;
  let first = a;
  for (let n = 0; n < 256; n++) {
    if (a > MAX_ORACLE_PRICE_V22) return null;
    if (bandWidthOkV22(a, bandBps)) {
      if (run === 0) first = a;
      run++;
      if (run > 8) return first;
    } else {
      run = 0;
    }
    a++;
  }
  return null;
}

/**
 * `band_genesis_price_ok`: a band market's genesis price must be at least 100 x `band_min_wide_anchor(d)`
 * (else InitMarket is refused with 105).
 *
 * @param price    Genesis price (per lot, e6).
 * @param bandBps  `d`.
 * @returns `true` when admitted.
 * @example
 * ```ts
 * bandGenesisPriceOkV22(200_000n, 130); // true
 * ```
 */
export function bandGenesisPriceOkV22(price: bigint, bandBps: number): boolean {
  const min = bandMinWideAnchorV22(bandBps);
  return min !== null && price >= min * BigInt(BAND_GENESIS_FLOOR_MULTIPLE_V22);
}

/**
 * The smallest `lot_exp` (0..=15) that puts the per-lot price at or above 10 (the 1e7 e6 floor):
 * `clamp(ceil(log10(10 / P)), 0, 15)`, computed exactly in integers from the token price in e6.
 *
 * @param tokenPriceE6  Price of one token in quote units, e6 (for example 0.0004 -> 400n).
 * @returns `lot_exp`; 0 means the 4-byte (no-lot) form; `null` when even 10^15 does not reach the floor.
 * @example
 * ```ts
 * lotExpForTokenPriceV22(400n); // 5  (0.0004 x 10^5 = 40 >= 10)
 * ```
 */
export function lotExpForTokenPriceV22(tokenPriceE6: bigint): number | null {
  if (tokenPriceE6 <= 0n) return null;
  for (let k = 0; k <= LOT_EXP_MAX_V22; k++) {
    if (tokenPriceE6 * 10n ** BigInt(k) >= LOT_PRICE_FLOOR_E6_V22) return k;
  }
  return null;
}

/**
 * Per-token display price from a per-lot mark: `mark_e6 / 1e6 / 10^lotExp`, as an exact decimal string.
 * All price formatting must go through one helper.
 *
 * @param markE6  Per-lot mark, e6.
 * @param lotExp  Market `lot_exp`.
 * @returns Decimal string.
 * @example
 * ```ts
 * displayPriceV22(40_000_000n, 5); // "0.0004"
 * ```
 */
export function displayPriceV22(markE6: bigint, lotExp: number): string {
  if (!Number.isInteger(lotExp) || lotExp < 0 || lotExp > LOT_EXP_MAX_V22) throw new Error(`lotExp must be 0..=${LOT_EXP_MAX_V22}`);
  const scale = 6 + lotExp;
  const s = markE6.toString().padStart(scale + 1, "0");
  const int = s.slice(0, s.length - scale);
  const frac = s.slice(s.length - scale).replace(/0+$/, "");
  return frac === "" ? int : `${int}.${frac}`;
}

/**
 * Tokens to lots, rounding toward zero, with the remainder (in tokens) so the UI can show it:
 * `lots = trunc(tokens / 10^lotExp)`.
 *
 * @param tokens  Whole tokens (bigint, may be negative for shorts).
 * @param lotExp  Market `lot_exp`.
 * @returns `{ lots, remainderTokens }`.
 * @example
 * ```ts
 * tokensToLotsV22(123_456n, 3); // { lots: 123n, remainderTokens: 456n }
 * ```
 */
export function tokensToLotsV22(tokens: bigint, lotExp: number): { lots: bigint; remainderTokens: bigint } {
  if (!Number.isInteger(lotExp) || lotExp < 0 || lotExp > LOT_EXP_MAX_V22) throw new Error(`lotExp must be 0..=${LOT_EXP_MAX_V22}`);
  const f = 10n ** BigInt(lotExp);
  return { lots: tokens / f, remainderTokens: tokens % f };
}
