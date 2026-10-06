/**
 * User-facing copy for the Devnet v2.1 surfaces (growth-v19, P2b lock exits, P2b Earn). One
 * place so the tests pin it. Calm, plain, one idea per line; every refusal of NEW risk says that
 * closing still works. No jargon (no "h-lock", "ADL", "N_cap", "kink").
 */
import type { GrowthClosedReason } from "./sdk";

const x = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""));

export const V21_COPY = {
  // ── Launch wizard ────────────────────────────────────────────────────────
  wizard: {
    title: "Dynamic leverage",
    adjusts: "Leverage adjusts with market backing.",
    explain:
      "Traders get up to the starting leverage you pick while the market is lightly used. As one side fills up, the leverage on it steps down; as more liquidity backs the market, capacity and leverage grow. Closing is never blocked.",
    launchLeverage: "Starting leverage",
    launchLeverageHint: (min: string, max: string) => `Between ${min}x and ${max}x. Traders see less on a busy side.`,
    riskGap: "Price-gap allowance",
    riskGapHint: (min: string, max: string) =>
      `How far the price can jump between liquidations. Between ${min}% and ${max}%. The default is the lowest safe value for this market.`,
    funding: "Funding limit",
    fundingHint: (perHour: string) => `Caps the funding rate at about ${perHour} per hour, so skew is paid for but never runaway.`,
    fee: (cap: string) => `The market's maximum trading fee is set to ${cap} so a busy side can add its small extra fee.`,
    junior: (min: string) => `Your first-loss stake must be at least ${min}.`,
    singleAsset: "Dynamic-leverage markets trade a single asset.",
    issue: {
      "leverage-out-of-range": "Pick a starting leverage within the allowed range.",
      "r-gap-out-of-range": "The price-gap allowance is outside the safe range for this market.",
      "funding-zero": "The funding limit must be above zero.",
      "fee-cap-too-low": "The maximum trading fee leaves no room for the busy-side fee.",
      "junior-below-minimum": "The first-loss stake is below the minimum.",
      "not-single-asset": "Dynamic-leverage markets trade a single asset.",
    },
  },
  // ── Trade ticket ─────────────────────────────────────────────────────────
  ticket: {
    adjusts: "Leverage adjusts with market backing.",
    maxLeverage: (side: string, lev: number) => `Up to ${x(lev)}x ${side} right now`,
    capacity: "Side capacity",
    capacityUsed: (pct: string) => `${pct} full`,
    fee: (pct: string) => `This side is busy: a small extra fee of ${pct} applies to the part that opens.`,
    feeNone: "No busy-side fee at this size.",
    closeAlways: "Reducing or closing is never limited by this.",
  },
  growthClosed: (side: string, reason: GrowthClosedReason | null): string => {
    switch (reason) {
      case "hlock":
        return `Opening ${side} is paused while the market recovers from a loss. You can still reduce or close.`;
      case "not-bound":
        return "This market isn't ready for new positions yet: its liquidity vault isn't set up. You can still reduce or close.";
      case "invalid-config":
        return "This market's leverage settings can't be read, so opening is paused. You can still reduce or close.";
      default:
        return `This side of the market is full for now. Capacity grows as more liquidity backs the market. You can still reduce or close; try the other side or come back later.`;
    }
  },
  growthLeverage: (max: string, side: string): string =>
    `Max leverage for ${side} is ${max}x right now. It adjusts with market backing.`,
  // ── Earn ─────────────────────────────────────────────────────────────────
  earn: {
    capitalLocked: "That capital stays in the market while it has open positions. It frees up once they have closed.",
    reserve: "Withdrawals above the reserve wait for capital to be recalled from the market.",
    reserveLong:
      "Earn withdrawals are paid from a liquid reserve (at least 30% of the vault). Withdrawals above the reserve wait for capital to be recalled from the market, which happens once the market's open positions are closed.",
    entryVsExit: (entry: string, exit: string, sym: string) =>
      `You put in at ${entry} ${sym} per share. Withdrawing now is worth ${exit} ${sym} per share.`,
    entryVsExitBelow: "Withdrawing now is worth less than you put in because the vault is covering a loss. It recovers if the market does.",
    entryVsExitTitle: "Entry price vs current exit value",
    exitRefresh: "Refreshing open positions first, so your payout uses up-to-date values.",
    exitRefreshWhy: "We refresh the market's open positions in the same transaction, so nobody can time your withdrawal against a stale price.",
  },
  // ── Lock exits ───────────────────────────────────────────────────────────
  lock: {
    closeOnly: "This market is close-only while it rebalances.",
    closeOnlySub: "You can reduce or close your position. New positions reopen once it resets.",
    countdown: (t: string) => `Open positions can be wound down automatically in ${t}.`,
    countdownNotStarted: "A wind-down timer starts the first time anyone checks the market.",
    countdownReady: "The wait is over: open positions can be wound down now.",
    windDown: "Wind down",
    windDownTitle: "Close this position at the market price",
    windDownExplain:
      "Anyone can trigger this once the wait is over. Your position closes at the current market price with no fee, and your collateral stays in your account.",
    windDownDust: "This market is nearly empty, so open positions can be wound down now.",
    windDownBusy: "Winding down…",
    windDownDone: "Position wound down.",
    reduceHint: "Reducing or closing yourself works at any time.",
  },
} as const;
