/**
 * UX WP-7 (audit §3.15 / §4.6): the create-market wizard's plain copy, one place (the banned-terms
 * guard covers it). No "slab", "vAMM", "matcher", "keeper", "Earn seed", "tranche".
 */
export const UNSUPPORTED_POOL_COPY = "This token trades on a pool type we can't price yet. Markets can use Meteora DLMM or PumpSwap pools.";

/** #3320: the wallet is at its per-creator live-price ceiling, so a new market would never be priced.
 *  Shown on the disabled launch button before anything is built or signed. */
export const LIVE_PRICE_LIMIT_COPY =
  "This wallet has reached its limit of live-priced markets, so a new one wouldn't get a live price. Ask the team to connect more.";

/** The money the launch sets aside on both sides so winning traders can be paid (was "counterparty backing" / "backing domains"). */
export const PAYOUT_RESERVE_COPY = {
  name: "trader payout reserve",
  readout: "Incl. trader payout reserve",
  tip: "Money set aside on both sides of the market so winning traders can be paid. Precisely: the counterparty backing seeded for each of the market's two sides.",
} as const;

/** The batch progress, in landing order (§3.15). */
export const WIZARD_STEP_COPY = {
  createMarket: "Creating the market",
  priceSource: "Setting the price source",
  liquidity: "Adding the market's liquidity",
  funding: "Funding the market",
  insurance: "Funding the market",
  earnVault: "Opening the Earn vault",
  creatorStake: "Adding your creator stake",
  stakePool: "Connecting to the staking pool",
  livePrice: "Connecting the live price",
  ready: "Ready to trade",
} as const;

export const WIZARD_PREFLIGHT = (sol: string) => `≈ ${sol} SOL · 1 approval · about a minute`;
export const WIZARD_FALLBACK_LABEL = (n: number) => `Your wallet signs each step separately (${n} approvals).`;
export const WIZARD_BLOCKHASH_REAPPROVAL = "Your wallet took a while, so one more approval finishes the launch.";

export const CREATOR_STAKE_COPY = {
  title: "Your creator stake",
  explain: "First-loss capital: trader profits are paid from it before Earn depositors are affected.",
  floorLabel: "Keep at least",
  floorSuffix: "of Earn deposits",
  floorHint: "You can withdraw anything above this while no trades are open.",
  limits: "Market limits at launch: up to $5,000 per trade, $25,000 total exposure.",
  limitsTooltip: "Set by the protocol.",
  issueMin: (min: string, floor: string) => `Your creator stake must be at least ${min} USDC for a ${floor}% minimum.`,
  issueEmpty: "Enter a creator stake.",
} as const;

import { NEVER_CONNECTED_COPY } from "@/lib/v22/never-connected";
import { FORCE_CLOSE_DELAY_SLOTS_V22, PERMISSIONLESS_RESOLVE_STALE_SLOTS_V22 } from "@/lib/v22/launch-wire";

/** Whole hours for a slot count at 400 ms per slot (the figure lib/v22/stale-resolve.ts uses). */
const hoursText = (slots: bigint): string => `about ${Math.round((Number(slots) * 0.4) / 3600)} hours`;

/**
 * Pre-flight "what you're committing / how this market ends" (council M12). Every line is derived from code or the lifecycle
 * plan (ledger v22-market-lifecycle-plan-2026-10-25, decided option C), nothing invented:
 *  - first-loss: CREATOR_STAKE_COPY.explain and V22_COPY.earnPage.insuranceOrder (creator stake, then Earn, then insurance);
 *  - withdraw: handle_withdraw_junior_tranche gates (Live, price not lagging, not stale-matured, accrued cushion held back,
 *    floor = share of Earn deposits) on top of CREATOR_STAKE_COPY.floorHint;
 *  - rent and refunds: NEVER_CONNECTED_COPY (decided 2026-10-25: mainnet refund for never-connected markets, devnet none);
 *  - ending: the stale window and force-close delay are the launch constants (launch-wire.ts), tag 39 settles at the last
 *    good price for anyone, tag 30 owner-only during the delay then permissionless; the admin path (option A) is kept by option C.
 * "Not yet decided" names only what the ledger leaves open.
 */
export const CREATOR_END_COPY = {
  title: "What you're committing / how this market ends",
  firstLoss: "Your creator stake is first-loss: trader profits are paid from it before Earn depositors are affected, and the insurance fund only steps in after both are used up. You can lose all of it.",
  withdraw: "You can withdraw anything above your minimum, but only while the market is live, its price is current, it is not past the stale window and no trades are open, and part of recent earnings is held back. The minimum moves with Earn deposits.",
  rent: `${NEVER_CONNECTED_COPY.rentEarn} The stake pool and vault account rent is not returned by any instruction either. ${NEVER_CONNECTED_COPY.rentFreed}`,
  refund: `${NEVER_CONNECTED_COPY.rentMainnet} ${NEVER_CONNECTED_COPY.rentDevnet}`,
  ends: `If the price feed stops for ${hoursText(PERMISSIONLESS_RESOLVE_STALE_SLOTS_V22)}, anyone can settle the market at its last good price. For ${hoursText(FORCE_CLOSE_DELAY_SLOTS_V22)} after that only each position's owner can close it; then anyone can settle a position to its owner.`,
  admin: "The market's admin can also retire it early; the plan keeps that alongside the stale-feed backstop. On markets launched here the stake pool's admin is the creator wallet, so that power may be yours on chain. This app has no button for it.",
  positions: "Open positions are settled at that price and traders are paid first. Your creator stake and the liquidity you seeded come back after that, minus any losses; nothing is guaranteed.",
  insurance: "Your insurance seed comes back through the stake pool when the market is settled, up to what you put in; anything above that goes to stakers.",
  undecided: "Not yet decided: whether creators should end their own market early.",
} as const;
