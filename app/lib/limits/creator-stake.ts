/**
 * UX WP-9 (audit §3.10, JR-1): "Your creator stake" (the P3 junior tranche) as the creator sees it.
 * One pure state: the four rows, what can be withdrawn now, and the ONE reason line when that is 0.
 * The Withdraw button is enabled exactly when `withdrawable > 0`; the input is capped at it. The
 * wallet never opens on a refused 75 either way (sendTx simulates first, SH-1), and the refusal
 * maps to the same reason line (`stakeReasonFromRefusal`).
 * Program rule (97 `handle_withdraw_junior_tranche`): the vault LP must be flat, no senior draw
 * outstanding, the backing must cover C, and only the junior above `floor · C` leaves.
 */
import { juniorFloorAtoms, juniorWithdrawableAtoms, trancheSplit } from "./vault-tranche";

export type StakeReason = "lp-open" | "at-floor" | "backing-short" | "draw-pending";

export interface CreatorStakeState {
  /** Junior value (vault value minus the Earn claim, floored at 0); null while unknown. */
  stakeValue: bigint | null;
  /** "Protects Earn deposits of" = the Earn claim C. */
  protects: bigint;
  /** "Must keep at least": floor · C. */
  mustKeep: bigint | null;
  floorPct: string;
  /** null while unknown. */
  withdrawable: bigint | null;
  /** Set exactly when withdrawable is 0 (and known). */
  reason: StakeReason | null;
  exhausted: boolean;
}

export function creatorStakeState(i: {
  vaultValue: bigint | null;
  seniorClaimEff: bigint;
  backingCover: bigint;
  floorBps: number;
  lpFlat: boolean;
  drawOutstandingAtoms: bigint;
  impaired: boolean;
}): CreatorStakeState {
  const mustKeep = juniorFloorAtoms(i.seniorClaimEff, i.floorBps);
  const floorPct = `${(i.floorBps / 100).toFixed(i.floorBps % 100 === 0 ? 0 : 1)}%`;
  const base = { protects: i.seniorClaimEff, mustKeep, floorPct, exhausted: i.impaired };
  if (i.vaultValue === null) return { ...base, stakeValue: null, withdrawable: null, reason: null };
  const stakeValue = trancheSplit(i.vaultValue, i.seniorClaimEff).junior;
  let reason: StakeReason | null = null;
  let withdrawable = 0n;
  if (i.drawOutstandingAtoms > 0n) reason = "draw-pending";
  else if (!i.lpFlat) reason = "lp-open";
  else if (i.backingCover < i.seniorClaimEff) reason = "backing-short";
  else {
    withdrawable = juniorWithdrawableAtoms(i.vaultValue, i.seniorClaimEff, i.backingCover, i.floorBps);
    if (withdrawable === 0n) reason = "at-floor";
  }
  return { ...base, stakeValue, withdrawable, reason };
}

/** A 75 (VaultLpJuniorWithdrawRefused) refusal: the reason the current state explains, else the floor. */
export function stakeReasonFromRefusal(s: CreatorStakeState): StakeReason {
  return s.reason ?? "at-floor";
}

/** Clamp a typed amount to what can be withdrawn now. */
export const clampStakeWithdraw = (atoms: bigint, withdrawable: bigint | null): bigint =>
  withdrawable === null || atoms <= 0n ? 0n : atoms > withdrawable ? withdrawable : atoms;

export const CREATOR_STAKE_PANEL_COPY = {
  title: "Your creator stake",
  subtitle: "First-loss capital backing this market",
  stakeValue: "Stake value",
  protects: "Protects Earn deposits of",
  mustKeep: "Must keep at least",
  mustKeepValue: (amount: string, pct: string) => `${amount} (${pct} of Earn deposits)`,
  withdrawable: "Withdrawable now",
  max: (amount: string) => `Max ${amount}`,
  topUp: "Top up",
  withdraw: "Withdraw",
  reasons: {
    "lp-open": "Locked while traders have open positions on your market. It unlocks as they close.",
    "at-floor": "This is the minimum you must keep while Earn deposits are in the vault.",
    "backing-short": "Locked until the market's backing covers Earn deposits again.",
    "draw-pending": "Paused while the market settles a loss. It reopens when that is done.",
  } satisfies Record<StakeReason, string>,
  resolvedAvailable: (amount: string) => `Your creator stake: ${amount} available after Earn depositors are paid.`,
  resolvedWithdraw: (amount: string) => `Withdraw ${amount}`,
  resolvedWaiting: (at: string) => `Available once the market's final payouts finish (about ${at}).`,
} as const;
