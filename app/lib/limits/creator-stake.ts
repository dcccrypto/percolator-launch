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

export type StakeReason = "lp-open" | "at-floor" | "backing-short" | "draw-pending" | "net-minimum" | "locked";

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
  /**
   * D1 interim: the deployed net-deposit rule, or null when it does not apply. `net` = deposited - withdrawn (saturating);
   * `partialMax` = the most a withdrawal can take and still leave net 0 or >= the minimum; `fullExit` = the whole net when
   * the value rule lets all of it leave (net after 0), else null.
   */
  netRule: { partialMax: bigint; fullExit: bigint | null } | null;
}

/** Deployed rule (tag 97, `lev_guard_v22::junior_stake_ok`): net deposits after a withdrawal are 0 or >= min (500 collateral units). */
export interface NetDepositRule {
  deposited: bigint;
  withdrawn: bigint;
  minAtoms: bigint;
}

export function creatorStakeState(i: {
  vaultValue: bigint | null;
  seniorClaimEff: bigint;
  backingCover: bigint;
  floorBps: number;
  lpFlat: boolean;
  drawOutstandingAtoms: bigint;
  impaired: boolean;
  /** D1 interim: set on a v2.2 market; null = no net rule (v2.1 and earlier). */
  netRule?: NetDepositRule | null;
}): CreatorStakeState {
  const mustKeep = juniorFloorAtoms(i.seniorClaimEff, i.floorBps);
  const floorPct = `${(i.floorBps / 100).toFixed(i.floorBps % 100 === 0 ? 0 : 1)}%`;
  const base = { protects: i.seniorClaimEff, mustKeep, floorPct, exhausted: i.impaired, netRule: null as CreatorStakeState["netRule"] };
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
  let netRule: CreatorStakeState["netRule"] = null;
  if (i.netRule) {
    const net = i.netRule.deposited > i.netRule.withdrawn ? i.netRule.deposited - i.netRule.withdrawn : 0n;
    const room = net > i.netRule.minAtoms ? net - i.netRule.minAtoms : 0n;
    const partialMax = withdrawable < room ? withdrawable : room;
    const fullExit = net > 0n && net <= withdrawable ? net : null;
    netRule = { partialMax, fullExit };
    const offered = fullExit ?? partialMax;
    if (withdrawable > 0n && offered === 0n) reason = "net-minimum";
    withdrawable = offered;
  }
  return { ...base, stakeValue, withdrawable, reason, netRule };
}

/**
 * A 75 (VaultLpJuniorWithdrawRefused) refusal: the reason the current state explains, else a
 * NEUTRAL line.
 *
 * GH#3680: this used to fall back to "at-floor", which asserts something specific and often
 * false -- "This is the minimum you must keep while Earn deposits are in the vault" -- for a
 * refusal the state did not explain. Tag 97 has more refusal causes than this module models,
 * and RC2 adds another (AUD-S1-15: the junior is held to the market's OPEN-INTEREST lock, which
 * fires when the vault LP is FLAT -- precisely when `lp-open` is not selected). A creator in
 * that state was told the floor was the reason when it was not.
 *
 * The four modelled reasons are unchanged. Only the fallback moves, from a specific claim to one
 * that is true whatever refused: the withdrawal is locked right now, and that can change.
 */
export function stakeReasonFromRefusal(s: CreatorStakeState): StakeReason {
  return s.reason ?? "locked";
}

/** Clamp a typed amount to what can be withdrawn now. */
export const clampStakeWithdraw = (atoms: bigint, withdrawable: bigint | null): bigint =>
  withdrawable === null || atoms <= 0n ? 0n : atoms > withdrawable ? withdrawable : atoms;

/**
 * The most the deployed program accepts, given the typed amount: a full exit (net after 0) passes as typed; anything else
 * is held to `partialMax` so it never leaves a net in (0, minimum). Without the net rule it is `clampStakeWithdraw`.
 */
export const clampStakeWithdrawFor = (atoms: bigint, s: CreatorStakeState | null): bigint => {
  if (!s || s.withdrawable === null || atoms <= 0n) return 0n;
  if (!s.netRule) return clampStakeWithdraw(atoms, s.withdrawable);
  if (s.netRule.fullExit !== null && atoms === s.netRule.fullExit) return atoms;
  return atoms > s.netRule.partialMax ? s.netRule.partialMax : atoms;
};

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
    // GH#3680: the fallback for a refusal this module does not model. Says only what is true
    // of every cause, and never names one that may not apply.
    // D1 interim (deep memo 2026-10-29): the deployed rule counts deposits, not value. Replaced when the program measures value.
    "net-minimum": "Locked until the market settles after a loss; withdrawals must leave at least $500 in deposits.",
    locked: "Locked right now. This can change as positions close and the market settles — try again shortly.",
  } satisfies Record<StakeReason, string>,
  /** Shown while a withdrawal is possible and the deployed deposit rule applies. */
  netRuleNote: "Withdrawals must leave at least $500 in deposits, or take everything out.",
  resolvedAvailable: (amount: string) => `Your creator stake: ${amount} available after Earn depositors are paid.`,
  resolvedWithdraw: (amount: string) => `Withdraw ${amount}`,
  resolvedWaiting: (at: string) => `Available once the market's final payouts finish (about ${at}).`,
} as const;
