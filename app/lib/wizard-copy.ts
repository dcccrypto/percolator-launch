/**
 * UX WP-7 (audit §3.15 / §4.6): the create-market wizard's plain copy, one place (the banned-terms
 * guard covers it). No "slab", "vAMM", "matcher", "keeper", "Earn seed", "tranche".
 */
export const UNSUPPORTED_POOL_COPY = "This token trades on a pool type we can't price yet. Markets can use Meteora DLMM or PumpSwap pools.";

/** #3320: the wallet is at its per-creator live-price ceiling, so a new market would never be priced.
 *  Shown on the disabled launch button before anything is built or signed. */
export const LIVE_PRICE_LIMIT_COPY =
  "This wallet has reached its limit of live-priced markets, so a new one wouldn't get a live price. Ask the team to connect more.";

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
  issueMin: (min: string, floor: string) => `Your creator stake must be at least ${min} Sim-USDC for a ${floor}% minimum.`,
  issueEmpty: "Enter a creator stake.",
} as const;
