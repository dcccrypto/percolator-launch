/**
 * Where a trading fee actually goes, stated once for every audience.
 *
 * Four groups care about this and each was told something different, or
 * nothing:
 *
 *   - a TRADER sees the rate they pay and nothing about where it goes
 *   - a MARKET CREATOR is never told they earn a share at all
 *   - an LP sees "earn trading fees" with no number on the Earn page; the
 *     48% appears only in passing, inside a comment on the Stake page
 *   - a STAKER is correctly told they earn 0%, which reads as an oversight
 *     unless the rest of the split is visible next to it
 *
 * `FeeSplitControl.tsx` would have shown this and is never rendered anywhere,
 * so none of the numbers reach a user today.
 *
 * SHARES ARE FIXED IN PRACTICE. `CreateMarketWizard` never passes a
 * `feeSplit`, so `updateFeeSplitIx` is always null in `useCreateMarket` and
 * every market is created with the on-chain defaults. The instruction to
 * change them exists (UpdateFeeSplit, wrapper tag 86) and is bounded, but
 * nothing in the UI sends it. That is worth saying plainly rather than
 * hedging every figure with "by default".
 *
 * Note what is NOT uniform: the fee RATE. That is derived from the token's
 * liquidity tier (20 / 10 / 5 bps, useQuickLaunch) — see #2563. The split
 * below is the same everywhere; the number it divides is not.
 *
 * Every value is derived from the SDK's FEE_SPLIT rather than restated, so a
 * protocol change breaks the tests instead of silently making this UI lie.
 */

import { FEE_SPLIT } from "@percolatorct/sdk";

export interface FeeLeg {
  /** Stable key for React lists and tests. */
  id: "protocol" | "lp" | "creator" | "insurance";
  /** Who receives it, in the words that audience uses for themselves. */
  label: string;
  /** Share of the total fee, in bps of T. */
  bps: number;
  /** One line on what this share is for. */
  note: string;
  /** True when no user action can change it. */
  fixed: boolean;
}

/**
 * The four destinations of every trading fee, largest first.
 *
 * `bps` are "of T" — the whole fee — and sum to 10_000. The SDK's stored
 * shares sum to FEE_SHARE_TOTAL_BPS (8_000) because the protocol's 2_000 is
 * taken first and is not one of the stored three.
 */
export const FEE_LEGS: readonly FeeLeg[] = [
  {
    id: "lp",
    label: "Earn deposits",
    bps: FEE_SPLIT.DEFAULT_LP_SHARE_BPS,
    note: "Paid into the market's Earn vault: this is the yield behind Earn.",
    fixed: true,
  },
  {
    id: "protocol",
    label: "Protocol",
    bps: FEE_SPLIT.PROTOCOL_FEE_BPS,
    note: "Taken before anything else, and fixed: nobody can change it.",
    fixed: true,
  },
  {
    id: "creator",
    label: "Market creator",
    bps: FEE_SPLIT.DEFAULT_CREATOR_SHARE_BPS,
    note: "Goes to the market's creator, who claims it from My Markets.",
    fixed: true,
  },
  {
    id: "insurance",
    label: "Insurance fund",
    bps: FEE_SPLIT.DEFAULT_INSURANCE_SHARE_BPS,
    note: "Backs losses a liquidation cannot cover. Stakers provide this fund and receive this share, moved into the stake pool automatically.",
    fixed: true,
  },
];

/** A fee leg's user-facing name, the same on every surface (fee breakdown, fee card, fee split). */
export function legLabel(id: FeeLeg["id"]): string {
  return FEE_LEGS.find((l) => l.id === id)!.label;
}

/** Share of the whole fee, as a percentage. */
export function legPercent(leg: FeeLeg): number {
  return leg.bps / 100;
}

/**
 * What stakers receive of a trade fee: the INSURANCE leg. It accrues to the wrapper's
 * insurance reserve (`insurance_reserve_accrued_atoms`) and the keeper pushes it to the market's
 * bound stake pool (wrapper tag 87 WithdrawInsuranceReserveToStake -> stake tag 12 AccrueFees;
 * keeper b004a0c, lib/pre-resolve.ts). E2E 2026-09-30: stakers C3 +5.86 USDC and U3 +7.01 USDC.
 * (The old 0 assumed AccrueFees rejected insurance pools; that is no longer the program's rule.)
 */
export const STAKER_FEE_SHARE_BPS = FEE_SPLIT.DEFAULT_INSURANCE_SHARE_BPS;

/**
 * The fee a trade pays, in collateral atoms.
 *
 * `notionalAtoms` is size x price in collateral units; `feeBps` is the
 * market's own rate, which varies by liquidity tier and is NOT part of the
 * split above.
 */
export function tradeFeeAtoms(notionalAtoms: bigint, feeBps: bigint): bigint {
  if (notionalAtoms <= 0n || feeBps <= 0n) return 0n;
  return (notionalAtoms * feeBps) / 10_000n;
}

/** How much of a given fee each leg receives, in the same units. */
export function splitFeeAtoms(feeAtoms: bigint): Record<FeeLeg["id"], bigint> {
  const out = {} as Record<FeeLeg["id"], bigint>;
  for (const leg of FEE_LEGS) {
    out[leg.id] = feeAtoms <= 0n ? 0n : (feeAtoms * BigInt(leg.bps)) / 10_000n;
  }
  return out;
}

/** Sanity: the four legs account for the entire fee. */
export function totalLegBps(): number {
  return FEE_LEGS.reduce((sum, leg) => sum + leg.bps, 0);
}
