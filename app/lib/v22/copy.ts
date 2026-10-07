/**
 * User-facing copy for the Devnet v2.2 surfaces. One place so the tests pin it. Founder rule: protocol
 * mechanics stay invisible (no "lot_exp", "band_bps", "tag 111", "h-lock", "kink"), copy is calm and one
 * line, and anything that touches money says honestly what can happen.
 *
 * Sources: wrapper docs `docs/v22-band-defaults-and-product-copy.md` and `docs/v22-wave-a-wire.md` on
 * percolator-prog `release/v22-wrapper-rem`; ledger `security-review-v22-wave-{a,b,c,d}-2026-10-05.md`
 * (their UI and copy notes); `v22-combination-2026-10-06.md`; percolator-stake `feat/v22-stake-v5`
 * `src/state.rs` (consent text v2, `CONSENT_VERSION_FIRST_LOSS = 2`).
 */

/** Format a whole-token count for a sentence: 100 -> "100", 1234.5 -> "1,234.5". */
export const fmtTokens = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * Consent text v2, VERBATIM from percolator-stake `feat/v22-stake-v5` @ 480fe29 `src/state.rs` (the doc comment on
 * `CONSENT_VERSION_FIRST_LOSS`), with only the Rust comment markers (`///`, leading `* `) and the markdown bold
 * markers removed. The program enforces this version byte; the app MUST show exactly this and pass version 2.
 */
export const STAKE_CONSENT_TEXT_V2: readonly string[] = Object.freeze([
  "Up to `deploy_target_bps` of the pool (the target signed in the consent, including a pending raise) is deployed into the market's insurance fund and absorbs trading losses pro rata with every other insurance unit (stake and creator class alike).",
  "The insurance backstop (wrapper tag 111, G9) can lend insurance to the market's vault LP once its Earn seniors are exhausted, up to the seniors' own loss that is still outstanding, and never more than 50% of the fund (at most 20% per ~day). It is announced on chain at least 9,000 slots (~1 hour) before it can execute. On mainnet builds it runs only on a market priced by an external oracle (an authenticated Hybrid whose legs are Chainlink or allowlisted Switchboard feeds); on devnet any market can use it for testing. The loan is repaid first from any vault-LP recovery, but repayment is not guaranteed.",
  "Withdrawals are paid only from the liquid part of the pool, first come first served; the deployed part returns over successive syncs while the market is healthy.",
]);

/**
 * Display layer ONLY (review F10): the verbatim text names a program field in backticks; the user sees "the deployment
 * target". `STAKE_CONSENT_TEXT_V2` stays the verbatim source of truth (and is what the tests compare to the Rust file);
 * this transform is the one and only difference, and it is tested.
 */
export const consentDisplay = (para: string): string => para.replace("`deploy_target_bps`", "the deployment target");

export const V22_COPY = {
  // ── Band markets ("price protection") ────────────────────────────────────
  band: {
    catchingUp: "Price is catching up; closing reopens shortly.",
    catchingUpWhy: "After a sharp move the market price walks toward the new price in small steps. That usually takes a few minutes and can take up to about an hour. Closing opens again as soon as it has caught up.",
    /** Mark versus the oracle target, shown only when they differ. */
    markVsTarget: (mark: string, target: string) => `Mark ${mark} · catching up to ${target}`,
    minPosition: (min: string, sym: string) => `Minimum position ${min} ${sym}`,
    belowMin: (min: string, sym: string) => `Below the minimum position size: trade at least ${min} ${sym}, or close fully.`,
    smallPositionWarn: (min: string, sym: string) =>
      `Positions under half the minimum (${min} ${sym}) can be closed by anyone at the market price.`,
    fullSide: "This market is full on this side; try again shortly.",
    closeOnlyAtPrice: "This market is close-only at this price.",
  },
  // ── Lot markets (sizes are whole lots; the box is in tokens) ───────────────
  lot: {
    remainder: (tokens: string, sym: string) => `Sizes are rounded down to whole lots here: ${tokens} ${sym} of what you typed is not included.`,
  },
  // ── Holding fee ──────────────────────────────────────────────────────────
  rent: {
    rate: (pctPerDay: string) => `Holding fee ${pctPerDay} per day`,
    none: "No holding fee",
    hint: "A small fee while a position is open, charged from the position's margin.",
  },
  // ── Launch wizard ────────────────────────────────────────────────────────
  wizard: {
    protectionTitle: "Price protection",
    protectionHint: "Keeps the market price from jumping on thin trading. Closing can pause for a few minutes while the price catches up.",
    holdingFeeTitle: "Holding fee",
    holdingFeeHint: "A small fee on open positions. It keeps tiny positions from clogging the market.",
    bondTitle: "Capacity bond",
    bondHint: "Add liquidity at launch that absorbs losses after the first-loss stake and before Earn, and earns a capped share of fees.",
    bondAtomic: "Created in the same transaction as the market.",
    priceFloor: (floor: string) => `Launch price must be at least ${floor} per lot. Pick a higher launch price.`,
    priceCeiling: (ceil: string) => `Launch price can be at most ${ceil} per lot.`,
    lotsNotReady: "Tokens priced under $10 can't be launched here yet. Pick a token worth $10 or more, or check back soon.",
    priceFloorNoLot: "A token priced under $10 needs a keeper-priced market to use dynamic leverage.",
    priceUnknown: "Enter the token's price to continue.",
    recovery: (minutes: number) => `If the price feed stops, the market recovers on its own after about ${minutes} minutes.`,
    minPosition: (min: string) => `Minimum position size ${min}.`,
  },
  // ── Earn exit ────────────────────────────────────────────────────────────
  earnExit: {
    atLeast: (usd: string) => `You'll receive at least ${usd}`,
    quoting: "Getting your exit price…",
    requote: "The exit price moved. Here is the new minimum.",
    refreshing: "Refreshing positions…",
    estimateNote: "Based on today's price. This minimum is fixed when you request the withdrawal.",
    floorStuck: "The minimum set when you requested this withdrawal can't be lowered, and the pool is worth a little less now. Your shares are still held. You can wait for it to recover, or start a new withdrawal at today's price.",
    dipTolerance: "May pay up to 0.25% below par while positions refresh.",
    wait: "Positions are refreshing. Try again in a moment.",
  },
  // ── Bonds ────────────────────────────────────────────────────────────────
  bond: {
    title: "Capacity bond",
    absorbs: "Losses come after the creator's first-loss stake and before Earn.",
    coupon: "The coupon is paid from trading fees and is capped. It is not guaranteed.",
    exit: "Withdraw is live only while the market's liquidity is flat (no open positions it backs).",
    deposit: "Deposit",
    requestWithdraw: "Request withdrawal",
    executeWithdraw: "Withdraw",
    cooldown: (when: string) => `Your withdrawal can be completed ${when}.`,
    cooldownReady: "Your withdrawal is ready.",
    impaired: "Deposits are paused while the bond is below par.",
    full: "This bond is full.",
    locked: "Withdrawable when the market's open interest is below the capacity your bond backs.",
  },
  // ── Rescue ───────────────────────────────────────────────────────────────
  rescue: {
    title: "Add capital at a discount",
    explain: "This vault has taken losses. New capital buys shares below their original price, and the rest of the vault shares in recovery.",
    price: (px: string) => `Price ${px} per share`,
    floor: (min: string) => `You'll receive at least ${min} shares`,
    wound: "This market can no longer be recapitalised; it will be wound down.",
  },
  // ── First-loss staking (stake v5) ────────────────────────────────────────
  stake: {
    title: "First-loss staking",
    target: (pct: string) => `Deployment target ${pct}`,
    buffer: (pct: string) => `Liquid buffer ${pct}`,
    hysteresis: (pct: string) => `Rebalance band ${pct}`,
    consentUnavailable: "First-loss deposits aren't available for this pool right now.",
    consentLabel: "I have read and accept this risk text.",
    consentVersion: (v: number) => `Risk text version ${v}`,
    withdraw: "Withdrawals are paid only from the liquid part of the pool. The rest returns over time while the market is healthy.",
    deposit: "Deposit",
  },
  // ── Unsupported layout ───────────────────────────────────────────────────
  layout: {
    title: "This market uses a newer version",
    body: "This page can't read it yet. Nothing was changed. Try again after the app updates.",
  },
} as const;
