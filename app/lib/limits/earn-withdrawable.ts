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

/** Why a vault pays nothing now (tag 77 refuses Custom 21 / 37 / 34), most specific first. */
export type BlockedBy = "market" | "pot-not-fresh" | "pot-lapsed" | "vault-balance" | "oi-reservation" | "claims" | null;

export interface VaultWithdrawView {
  /** The combined NAV 77 pays at, collateral atoms. */
  nav: bigint;
  /**
   * What is left for depositors if every open winner claim were paid now, collateral atoms: per pot
   * min(available principal, fresh backing - claims), PLUS the LP earnings share nav includes.
   */
  claimAdjustedNav: bigint;
  /**
   * The most the WHOLE vault can pay out once the redemption cooldown has elapsed (all holders together),
   * collateral atoms. Redemption is two steps (request, then collect after the cooldown), so "now" means
   * "if collected now".
   */
  maxWithdrawableNow: bigint;
  /** Share of the vault's shares payable now, in bps (10000 = all). */
  payableBps: number;
  status: WithdrawStatus;
  blockedBy: BlockedBy;
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

const BUCKET_FRESH = 1;

/** `backing_principal_withdrawal_is_fresh`: authenticated_slot < expiry_slot. Unknown expiry or clock = not lapsed. */
function lapsed(d: DomainState, currentSlot: bigint | undefined): boolean {
  return d.bucket.expirySlot !== undefined && currentSlot !== undefined && !(currentSlot < d.bucket.expirySlot);
}

export function vaultWithdrawView(sp: SplitPotState): VaultWithdrawView | null {
  if (sp.totalShares <= 0n) return null;
  // Without the market facts 77 gates on (mode, vault balance, clock) we cannot say "open": say nothing.
  if (!sp.market) return null;
  const floored = sp.navFloor === true;
  const v = vaultValue(sp);
  if (!v) return null;
  const m = sp.market;

  // Sibling top-up is skipped by the program when the sibling pot lapsed or is not Fresh.
  const sibUsable = sp.sib.bucket.status === BUCKET_FRESH && !lapsed(sp.sib, m.currentSlot);
  const sibForPlan: DomainState = sibUsable ? sp.sib : { ...sp.sib, bucket: { ...sp.sib.bucket, status: 0 } };
  const plan = planSplitPotRedemption({
    own: sp.own,
    sib: sibForPlan,
    totalShares: sp.totalShares,
    shares: sp.totalShares,
    feeShareBps: sp.feeShareBps,
    navFloor: sp.navFloor,
  });
  if (!plan) return null;
  const earningsShare = pos(v.nav - v.available);
  const claimAdjustedNav = potClaimAdjusted(sp.own, floored) + potClaimAdjusted(sp.sib, floored) + earningsShare;

  let payableShares = plan.payable ? sp.totalShares : cappedShares(plan.maxShares, sp.totalShares);
  let blockedBy: BlockedBy = null;
  const atomsFor = (s: bigint) => (s * v.nav) / sp.totalShares;

  // Whole-redemption gates of 7c906e45 handle_execute_redemption (any failure = Custom 21 for every size).
  const marketOk = m.mode === 0 || (m.mode === 1 && m.terminalFlat);
  if (!marketOk) blockedBy = "market";
  else if (sp.own.bucket.status !== BUCKET_FRESH) blockedBy = "pot-not-fresh";
  else if (lapsed(sp.own, m.currentSlot)) blockedBy = "pot-lapsed";
  if (blockedBy) payableShares = 0n;

  if (!blockedBy) {
    // atoms > header.vault is refused: cap the shares so the payout fits the vault.
    if (v.nav > 0n && atomsFor(payableShares) > m.vaultAtoms) {
      payableShares = (m.vaultAtoms * sp.totalShares) / v.nav;
      if (payableShares === 0n) blockedBy = "vault-balance";
    }
    // OI reservation guard (only bites on a real valid lien; 0 on every vault so far): the NAV left after the
    // payout must cover threshold% of the pot's valid-liened backing.
    const thr = BigInt(sp.oiReservationThresholdBps ?? 0);
    const liened = sp.own.bucket.validLiened;
    if (!blockedBy && thr !== 0n && liened > 0n) {
      const needNav = (liened * 10_000n + thr * BOUND_SCALE - 1n) / (thr * BOUND_SCALE); // ceil(liened*10000 / (thr*BS))
      const ownNav = v.nav; // conservative: the guard reads the payout pot's own ledger; the whole vault bounds it
      const room = pos(ownNav - needNav);
      if (atomsFor(payableShares) > room) {
        payableShares = ownNav > 0n ? (room * sp.totalShares) / ownNav : 0n;
        if (payableShares === 0n) blockedBy = "oi-reservation";
      }
    }
  }
  const maxWithdrawableNow = atomsFor(payableShares);
  const payableBps = Number((payableShares * 10_000n) / sp.totalShares);

  let status: WithdrawStatus;
  if (v.nav === 0n || v.nav * COLLAPSE_FACTOR < sp.totalShares) status = "worthless";
  else if (maxWithdrawableNow === 0n) {
    status = "blocked";
    blockedBy = blockedBy ?? "claims";
  } else if (payableBps >= LIMITED_BELOW_BPS) status = "open";
  else status = "limited";
  return { nav: v.nav, claimAdjustedNav, maxWithdrawableNow, payableBps, status, blockedBy: status === "blocked" ? blockedBy : null };
}

/** Calm one-liners for the card. null = nothing to say (open). */
export function withdrawFlagLine(status: WithdrawStatus, blockedBy: BlockedBy = null): string | null {
  switch (status) {
    case "worthless":
      return "Worth about nothing now. A withdrawal would pay nothing.";
    case "blocked":
      if (blockedBy === "market") return "Withdrawals unavailable now: this market is not open for withdrawals.";
      if (blockedBy === "pot-not-fresh" || blockedBy === "pot-lapsed") return "Withdrawals unavailable now: the vault's backing is being refreshed.";
      if (blockedBy === "vault-balance") return "Withdrawals unavailable now: the market vault cannot cover a payout yet.";
      if (blockedBy === "oi-reservation") return "Withdrawals unavailable now: the vault must keep backing for open trades.";
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
