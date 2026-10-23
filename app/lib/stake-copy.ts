/**
 * UX WP-9 (audit §3.14, ST-1): stake cooldown as a time, never slots ("Withdraw available in
 * 2 min" / "Ready"), and the stake's own sidebar line (not Earn's "Redeem LP tokens…").
 */
import { SLOT_MS } from "@/lib/limits/resolved-eta";

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
