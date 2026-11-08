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

/**
 * Pre-flight "what you're committing / how this market ends" (council M12). Every line is derived from code or the lifecycle
 * plan (ledger v22-market-lifecycle-plan-2026-10-25, decided option C), nothing invented:
 *  - first-loss: CREATOR_STAKE_COPY.explain and V22_COPY.earnPage.insuranceOrder (creator stake, then Earn, then insurance);
 *  - withdraw: CREATOR_STAKE_COPY.floorHint (anything above the floor while no trades are open);
 *  - rent: StepControlRoom's rent note (marketauth rotates to a keyless PDA, FC-B5: no refund on Earn markets);
 *  - ending: ConfigurePermissionlessResolve 18,000 / 216,000 slots on every wizard launch (launch-single-tx/shape.ts),
 *    tag 39 settles at the last good price for anyone, tag 30 owner-only during the delay then permissionless.
 * "Not yet decided" lines are facts the ledger leaves open; they are stated, not guessed.
 */
export const CREATOR_END_COPY = {
  title: "What you're committing / how this market ends",
  firstLoss: "Your creator stake is first-loss: trader profits are paid from it before Earn depositors are affected, and the insurance fund only steps in after both are used up. You can lose all of it.",
  withdraw: "While the market runs you can withdraw anything above your minimum while no trades are open. The minimum stays in until the market ends.",
  rent: "Rent is permanent: it is not returned when the market ends.",
  ends: "If the price feed stops for about 2 hours, anyone can settle the market at its last good price. For about 24 hours after that only each position's owner can close it; then anyone can settle a position to its owner.",
  positions: "Open positions are settled at that price and traders are paid first. Your stake and Earn seed come back after that, minus any losses; nothing is guaranteed.",
  undecided: "Not yet decided: whether you can end your own market early, and whether any launch costs are refunded.",
} as const;
