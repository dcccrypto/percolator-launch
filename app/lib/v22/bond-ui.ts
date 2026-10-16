/**
 * Pure view logic of the capacity-bond card (Earn page, markets that have a bond tranche).
 * Everything is bigint; the vault readings come from the Earn rail's tranche view (the same numbers the
 * deposit gate uses). With no readings the card says nothing it cannot back up.
 */
import {
  BOND_COUPON_MAX_BPS_V22,
  bondCooldownElapsedV22,
  bondImpairedV22,
  quoteBondDepositV22,
  quoteBondWithdrawV22,
  type BondDepositQuote,
  type BondPositionV20,
  type BondTrancheV20,
  type BondWithdrawQuote,
} from "./sdk";

/** Slot time on devnet, for rendering waits. */
export const SLOT_SECONDS = 0.4;

export interface BondReadings {
  /** Vault value at the worse price (`vaultValue` of the Earn tranche view); null while unknown / stale. */
  vaultValue: bigint | null;
  /** `C_eff`. */
  seniorClaimEff: bigint;
  /** Market open interest and the vault LP's absolute inventory, engine Q. */
  oiLongQ: bigint;
  oiShortQ: bigint;
  lpEffAbsQ: bigint;
}

export interface BondCardState {
  /** Deposits are refused while the bond is below par (107). */
  impaired: boolean;
  /** `capped coupon` upper bound, percent per year (the tranche's own dial, never above the protocol max). */
  couponCapPctYear: number;
  cooldown: "none" | "pending" | "ready";
  /** Slots until a pending withdrawal can be completed (0 when none / ready). */
  slotsLeft: bigint;
  canDeposit: boolean;
  canRequestWithdraw: boolean;
  /** The request has matured: tag 110 may be sent (the program still checks the open-interest lock). */
  canExecuteWithdraw: boolean;
  /** Market liquidity is flat: nothing the bond backs is open (a Live exit is possible). null = unknown. */
  flat: boolean | null;
}

export function bondCardState(i: {
  tranche: BondTrancheV20;
  position: BondPositionV20 | null;
  nowSlot: bigint;
  readings: BondReadings | null;
}): BondCardState {
  const { tranche: t, position: p, nowSlot, readings } = i;
  const impaired =
    readings && readings.vaultValue !== null
      ? bondImpairedV22(readings.vaultValue, readings.seniorClaimEff, t.cBAtoms)
      : t.bondDrawnOutstandingAtoms > 0n;
  const pending = p !== null && p.pendingWithdrawShares > 0n;
  let cooldown: BondCardState["cooldown"] = "none";
  let slotsLeft = 0n;
  if (pending && p) {
    if (bondCooldownElapsedV22(nowSlot, p.requestSlot, t.bondCooldownSlots)) cooldown = "ready";
    else {
      cooldown = "pending";
      slotsLeft = p.requestSlot + BigInt(t.bondCooldownSlots) - nowSlot;
    }
  }
  const flat = readings ? readings.oiLongQ === 0n && readings.oiShortQ === 0n && readings.lpEffAbsQ === 0n : null;
  return {
    impaired,
    couponCapPctYear: Math.min(t.couponBpsPerYear, BOND_COUPON_MAX_BPS_V22) / 100,
    cooldown,
    slotsLeft,
    canDeposit: !impaired,
    canRequestWithdraw: p !== null && p.shares - p.pendingWithdrawShares > 0n,
    canExecuteWithdraw: cooldown === "ready",
    flat,
  };
}

/** Wait rendered calmly: "about 4 minutes". */
export function slotsToWait(slots: bigint): string {
  const s = Math.max(0, Math.round(Number(slots) * SLOT_SECONDS));
  if (s < 90) return "in under a minute";
  if (s < 5400) return `in about ${Math.round(s / 60)} minutes`;
  return `in about ${Math.round(s / 3600)} hours`;
}

export function bondDepositQuote(t: BondTrancheV20, amount: bigint, r: BondReadings, slippageBps = 50): BondDepositQuote | null {
  if (r.vaultValue === null || amount <= 0n) return null;
  return quoteBondDepositV22({ amount, bSharesTotal: t.bSharesTotal, cBAtoms: t.cBAtoms, capBps: t.bondCapBpsOfC, vaultValue: r.vaultValue, seniorClaimEff: r.seniorClaimEff, slippageBps });
}

/**
 * Withdraw quote for the position's pending shares. A Live exit passes `nCapAfter: null`, which the program's
 * lock accepts only with nothing open: "live exit only when the market's liquidity is flat".
 */
export function bondWithdrawQuote(t: BondTrancheV20, p: BondPositionV20, r: BondReadings, slippageBps = 50): BondWithdrawQuote | null {
  if (r.vaultValue === null || p.pendingWithdrawShares === 0n) return null;
  return quoteBondWithdrawV22({
    shares: p.pendingWithdrawShares,
    bSharesTotal: t.bSharesTotal,
    cBAtoms: t.cBAtoms,
    vaultValue: r.vaultValue,
    seniorClaimEff: r.seniorClaimEff,
    live: { nCapAfter: null, oiLongQ: r.oiLongQ, oiShortQ: r.oiShortQ, lpEffAbsQ: r.lpEffAbsQ },
    slippageBps,
  });
}
