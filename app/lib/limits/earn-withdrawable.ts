/**
 * Earn vault honesty: what a vault is worth if every open winner claim were paid, and what it can actually
 * pay out right now (audit 2026-10-04, lp-earn.md §2 and §8: platform Earn NAV is -10.1%; OTC, Jimothy and
 * STONK refuse every real-size withdrawal with Custom 21 at the stay-fully-backed gate; backpack and USELESS
 * are worth 0 so every 77 prices to nothing, Custom 34).
 *
 * Everything here is derived from the pot ledgers and source credit on chain through the SAME functions the
 * withdraw path uses (planSplitPotRedemption, combinedVault), so a vault is flagged when the program would
 * refuse it, not because its name is on a list. Two-pot (non-bound) vaults only; a bound P3 vault is priced
 * by the tranche model and gets no view here (null).
 */
import { availablePrincipal, cappedShares, planSplitPotRedemption, syncedLedger, vaultValue } from "@/lib/limits/earn-split-pot";
import type { DomainState, SplitPotState } from "@/lib/limits/earn-split-pot";
import { BOUND_SCALE } from "@/lib/limits/constants";

/**
 * - open:      the whole vault can be withdrawn now
 * - limited:   under 95% of it can be withdrawn now (the rest is backing open winner claims or open trades)
 * - blocked:   nothing can be withdrawn now (every real-size 77 reverts Custom 21)
 * - worthless: the vault is worth ~0, so a withdrawal pays nothing
 */
export type WithdrawStatus = "open" | "limited" | "blocked" | "worthless";

export interface VaultWithdrawView {
  /** The combined NAV 77 pays at, collateral atoms. */
  nav: bigint;
  /** What is left for depositors if every open winner claim were paid now, collateral atoms. */
  claimAdjustedNav: bigint;
  /** The most the WHOLE vault can pay out right now (all holders together), collateral atoms. */
  maxWithdrawableNow: bigint;
  /** Share of the vault's shares payable now, in bps (10000 = all). */
  payableBps: number;
  status: WithdrawStatus;
}

const pos = (x: bigint): bigint => (x > 0n ? x : 0n);

/** Per pot: min(available principal, fresh backing - winners' positive-claim bound), never negative. */
function potClaimAdjusted(d: DomainState, floored: boolean): bigint {
  const avail = availablePrincipal(syncedLedger(d), floored);
  if (avail === null) return 0n;
  const free = pos(d.source.freshReserved - d.source.positiveClaimBound) / BOUND_SCALE;
  return avail < free ? avail : free;
}

/**
 * Below this share of the vault payable now the vault reads "limited". Nearly every live vault pays 98-99.9%
 * (the 0.1% safety margin plus a sliver held for claims); calling those "partly withdrawable" would be noise.
 */
export const LIMITED_BELOW_BPS = 9_500;

/** The program's price collapse floor (tag 75): nav * 1000 < shares. Below it a share is worth ~nothing. */
const COLLAPSE_FACTOR = 1_000n;

export function vaultWithdrawView(sp: SplitPotState): VaultWithdrawView | null {
  if (sp.totalShares <= 0n) return null;
  const floored = sp.navFloor === true;
  const v = vaultValue(sp);
  if (!v) return null;
  const plan = planSplitPotRedemption({
    own: sp.own,
    sib: sp.sib,
    totalShares: sp.totalShares,
    shares: sp.totalShares,
    feeShareBps: sp.feeShareBps,
    navFloor: sp.navFloor,
  });
  if (!plan) return null;
  const claimAdjustedNav = potClaimAdjusted(sp.own, floored) + potClaimAdjusted(sp.sib, floored);
  const payableShares = plan.payable ? sp.totalShares : cappedShares(plan.maxShares, sp.totalShares);
  const maxWithdrawableNow = (payableShares * v.nav) / sp.totalShares;
  const payableBps = Number((payableShares * 10_000n) / sp.totalShares);

  let status: WithdrawStatus;
  if (v.nav === 0n || v.nav * COLLAPSE_FACTOR < sp.totalShares) status = "worthless";
  else if (maxWithdrawableNow === 0n) status = "blocked";
  else if (payableBps >= LIMITED_BELOW_BPS) status = "open";
  else status = "limited";
  return { nav: v.nav, claimAdjustedNav, maxWithdrawableNow, payableBps, status };
}

/** Calm one-liners for the card. null = nothing to say (open). */
export function withdrawFlagLine(status: WithdrawStatus): string | null {
  switch (status) {
    case "worthless":
      return "Worth about nothing now. A withdrawal would pay nothing.";
    case "blocked":
      return "Withdrawals unavailable now: the vault's money is backing open winners.";
    case "limited":
      return "Only part can be withdrawn now. The rest frees up as winners close.";
    default:
      return null;
  }
}

/** Short chip text for a list row. null = no chip. */
export function withdrawChip(status: WithdrawStatus): string | null {
  switch (status) {
    case "worthless":
      return "Worth ~0";
    case "blocked":
      return "Can't withdraw now";
    case "limited":
      return "Partly withdrawable";
    default:
      return null;
  }
}

/** Atoms -> USD number for a 6-dp (or `decimals`) collateral, for display. */
export function atomsToUsd(atoms: bigint, decimals: number): number {
  return Number(atoms) / 10 ** decimals;
}
