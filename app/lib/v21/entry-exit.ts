/**
 * Devnet v2.1, security review R3-L1: an entrant into a genuinely impaired NON-BOUND vault now gives
 * up part of the deposit to incumbents (entry is at par, exit is at the lower, claim-aware E3 read).
 * The app quotes "entry price vs current exit value" so nobody is surprised.
 *
 * Pure. Exact only when the indexer's cost basis is exact for the shares the wallet holds
 * (lib/lp-earned.ts decides that); otherwise null and nothing is shown, never a guess.
 */
import type { LpEarned } from "@/lib/lp-earned";
import { bigintRatio } from "@/lib/formatters";

export interface EntryVsExit {
  /** What the position cost (atoms) and what withdrawing it would pay now (atoms). */
  entryAtoms: bigint;
  exitAtoms: bigint;
  /** Per share, in collateral units; null when the ratio cannot be formed. */
  entryPerShare: number | null;
  exitPerShare: number | null;
  /** Exit is below entry. */
  below: boolean;
  /** How far below entry, in percent (0 when not below). */
  belowPct: number;
}

export function computeEntryVsExit(p: {
  earned: LpEarned | null;
  /** The program's exit quote for the whole claim (atoms): previewWithdrawAtoms(...). */
  exitAtoms: bigint | null;
  claimShares: bigint;
  decimals: number;
  lpDecimals: number;
}): EntryVsExit | null {
  if (!p.earned || p.earned.kind !== "exact") return null;
  if (p.exitAtoms === null || p.claimShares <= 0n) return null;
  const entry = p.earned.costBasisAtoms;
  if (entry <= 0n) return null;
  const perShare = (atoms: bigint): number | null => {
    const v = bigintRatio(atoms, 10n ** BigInt(p.decimals));
    const s = bigintRatio(p.claimShares, 10n ** BigInt(p.lpDecimals));
    return v === null || s === null || s === 0 ? null : v / s;
  };
  const below = p.exitAtoms < entry;
  return {
    entryAtoms: entry,
    exitAtoms: p.exitAtoms,
    entryPerShare: perShare(entry),
    exitPerShare: perShare(p.exitAtoms),
    below,
    belowPct: below ? Number(((entry - p.exitAtoms) * 10_000n) / entry) / 100 : 0,
  };
}
