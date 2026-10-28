/**
 * UX WP-9 (audit §3.14, ST-1): stake cooldown as a time, never slots ("Withdraw available in
 * 2 min" / "Ready"), and the stake's own sidebar line (not Earn's "Redeem LP tokens…").
 */
import { SLOT_MS } from "@/lib/limits/resolved-eta";
import { isDevnetV22Enabled } from "@/lib/v22/flag";

/** "40 s", "2 min", "3 h", "2 days" from a slot count (devnet slot time). */
export function cooldownDuration(slots: number): string {
  const s = Math.max(1, Math.round((Math.max(0, slots) * SLOT_MS) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

export const STAKE_COPY = {
  ready: "Ready",
  availableIn: (slots: number) => `Withdraw available in ${cooldownDuration(slots)}`,
  period: (slots: number) => `Cooldown: ${cooldownDuration(slots)} before you can withdraw.`,
  sidebar: "Stake pays you a share of every trading fee. Your stake covers the market's losses first, so its value can fall.",
  /** "Back the fund" step under How It Works. */
  backStep: "Your deposit backs the fund and covers losses first",
  /** Risk notice: plain words on screen, the precise terms in the tooltip (stake page). */
  risk: {
    lead: "Staked funds cover the market's losses first.",
    leadTip: "First-loss insurance capital: when the market's insurance is drawn on, staked funds are used before other backers' money.",
    flush: "If an admin moves them into the insurance fund, your share is permanently worth less.",
    flushTip: "An admin flush transfers staked funds into the market's insurance fund. It permanently reduces the redeemable value of your stake.",
    tail: "Fee income depends on trading volume. Only stake what you can afford to lose.",
  },
  /** Trade page, losses line. */
  waterfallStakeNote: "Staked funds only help if an admin moves them into the insurance fund.",
  waterfallStakeTip: "An admin flush transfers staked funds into the market's insurance fund, where they cover losses.",
} as const;

/**
 * v2.2 wording for the same keys (product review 2026-10-28, S-7 / S-8 / D-2 / D-3 / D-10). The lines above describe v2.1:
 * stake "covers losses first" and helps only after an admin flush. On v2.2 neither is true:
 *   - the P3 loss order puts the creator's stake and Earn deposits AHEAD of insurance (wrapper tag 111 draws insurance only for a
 *     deficit left after them; same rule as `V22_COPY.earnPage.insuranceOrder` and the staker consent summary);
 *   - stake v5 removed the admin flush (`DeprecatedV5`): first-loss pools deploy into insurance automatically up to their target,
 *     fee-only pools never deploy;
 *   - fee-only stakers earn nothing while the market runs (decision FC-B1, option A), so "a share of every trading fee" was false.
 * Shape is identical to STAKE_COPY so callers swap with `stakeCopy()`.
 */
/** The shape both builds share (string-typed, so the v2.2 lines can differ from the v2.1 literals). */
export interface StakeCopyShape {
  readonly ready: string;
  readonly availableIn: (slots: number) => string;
  readonly period: (slots: number) => string;
  readonly sidebar: string;
  readonly backStep: string;
  readonly risk: { readonly lead: string; readonly leadTip: string; readonly flush: string; readonly flushTip: string; readonly tail: string };
  readonly waterfallStakeNote: string;
  readonly waterfallStakeTip: string;
}

export const STAKE_COPY_V22: StakeCopyShape = {
  ...STAKE_COPY,
  sidebar:
    "What you earn depends on the pool: fee-only stakers earn nothing while the market runs and share what is left above the creator's seed when it closes; insurance-pool stakers share the insurance part of trading fees. Your stake can lose value.",
  backStep: "Your deposit backs the market's insurance, which steps in only after the creator's stake and Earn deposits are used up",
  risk: {
    lead: "Staked funds can be lost if a market's losses use up the creator's stake, bonds and Earn deposits.",
    leadTip:
      "First-loss insurance capital: first-loss pools move part of their funds into the market's insurance automatically, up to their deployment target. Insurance is drawn on only for a loss left after the creator's stake and Earn deposits. Fee-only pools never deploy.",
    flush: "Once part of a pool is in insurance and is used to cover a loss, every share in the pool is worth less.",
    flushTip: "Unlike the old admin flush, deployment is automatic. Deployed stake is paid back to the pool over time while the market is healthy; an amount used to cover a loss is not.",
    tail: "Only stake what you can afford to lose.",
  },
  waterfallStakeNote: "Insurance stake pools move part of their funds into insurance automatically; fee-only pools don't.",
  waterfallStakeTip: "First-loss insurance capital, with no admin flush in stake v5: a first-loss pool deploys up to its target on its own, and its deployed part is drawn on only after the creator's stake and Earn deposits.",
};

/** The stake copy for this build: v2.2 wording when the v2.2 flag is on, otherwise the v2.1 lines. */
export function stakeCopy(): StakeCopyShape {
  return isDevnetV22Enabled() ? STAKE_COPY_V22 : STAKE_COPY;
}

/** Trade page losses line, opening sentence (the part before the stake note). */
export function lossOrderLead(): string {
  return isDevnetV22Enabled()
    ? "A loss beyond a position's margin reaches the creator's stake and Earn deposits first; insurance can step in only once they're used up."
    : "Losses fall on the position margin first, then the insurance fund, then the market's liquidity and winning positions.";
}

/** The stake page's "what moved stake covers" panel: v2.1 describes the admin flush, v2.2 the automatic deployment. */
export function stakeCoverageCopy(): { title: string; items: { label: string; description: string }[] } {
  return isDevnetV22Enabled()
    ? {
        title: "What deployed stake does",
        items: [
          { label: "Automatic deployment", description: "First-loss pools move part of their funds into insurance up to their target; fee-only pools never do" },
          { label: "Last line of defence", description: "Covers a loss only after the creator's stake and Earn deposits are used up" },
          { label: "Paid back over time", description: "Deployed stake returns to the pool while the market is healthy" },
        ],
      }
    : {
        title: "If the pool admin moves stake into insurance",
        items: [
          { label: "Liquidation Shortfall", description: "Moved stake can cover losses when liquidations don't fully cover a position" },
          { label: "Socialized Loss Buffer", description: "Absorbs bad debt before it reaches the market's liquidity and Earn deposits" },
          { label: "Protocol Solvency", description: "Pre-funds the market's insurance fund via an admin flush" },
        ],
      };
}
