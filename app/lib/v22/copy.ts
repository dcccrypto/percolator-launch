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

/** Wrapper 128 `DepthInputInvalid`: only a keeper's price push can hit it, so a trader should essentially never see this. */
export const V22_DEPTH_INPUT_COPY = "The market's depth reading was not accepted, so nothing changed. Try again in a moment.";

/** Wrapper 129 `DepthSourceInvalid`: a keeper's pool reading, not a trader action. */
export const V22_DEPTH_SOURCE_COPY = "The market's pool reading was not accepted, so nothing changed. Try again in a moment.";
/** Wrapper 130 `GrowthTierConfigInvalid`: the launch's tier table; the wizard's own check normally catches it first. */
export const V22_TIER_CONFIG_COPY = "These leverage tiers are outside the safe limits, so nothing was created. Open Advanced: leverage tiers and adjust the amounts or leverage.";

export const V22_COPY = {
  // ── Band markets ("price protection") ────────────────────────────────────
  band: {
    /** Error 104 on a close, the ONE line everywhere (round i: "Close on hold"). QA P-4: it refuses only the close the stale pinned price would favour. */
    /** No estimate available: honest and calm, never a seconds promise. With an estimate see catchUpAvailableLine. */
    catchingUp: "The price is still catching up after a big move. Closing reopens when it has; this usually takes a few minutes.",
    catchingUpWhy: "After a sharp move the market price walks toward the new price in small steps. That usually takes a few minutes and can take up to about an hour. Closing opens again as soon as it has caught up.",
    /**
     * Error 120 (close-only after a partial band liquidation, L7 D1): a liquidation scales the other side's factor, and the market
     * refuses new risk until that side resets; positions still open after about an hour are closed at the market price.
     */
    closeOnlyAfterLiquidation:
      "This market is close-only after a liquidation. You can still reduce or close your position. New positions reopen within about an hour; any still open then may be closed at the market price.",
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
    unitsUnknown: "Checking this market's price. Try again in a moment.",
    tradingUnavailable: "Trading this market isn't available in the app yet.",
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
    quoteExpired: "Your quote expired. See the exit price again.",
    requote: "The exit price moved. Here is the new minimum.",
    refreshing: "Refreshing positions…",
    estimateNote: "Set 10% under today's value and fixed when you request, so normal price moves during the wait don't block collecting it.",
    floorStuck: "The minimum set when you requested this withdrawal can't be lowered, and the pool is worth less now. Your shares are still held. You can wait for it to recover and collect then, or cancel and request again at today's price.",
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
  // ── Dynamic leverage on a band market: tier, what unlocks next (lib/v22/growth-unlock.ts) ─────────────
  // Never a raw bps / x100 number; only on a market whose ceiling can graduate.
  growth: {
    maxNow: "Max leverage now",
    tier: (n: number) => `Liquidity tier ${n}`,
    tierTip: "Liquidity tier is the lower of two things, how much trading depth the token's pool has near the price and how much money backs this market; higher tiers allow more leverage.",
    unlockBoth: (x: string, depth: string, backing: string) => `${x} unlocks at ${depth} pool depth and ${backing} market backing`,
    unlockDepth: (x: string, depth: string) => `${x} unlocks when pool depth reaches ${depth}`,
    /** The pool is already deep enough; the hourly limit on how fast the usable reading may rise is the only wait. */
    unlockCatchUp: (x: string, when: string) => `${x} unlocks in ${when} as the pool reading catches up`,
    unlockCatchUpNow: (x: string) => `${x} unlocks at the next update`,
    unlockBacking: (x: string, backing: string) => `${x} unlocks when market backing reaches ${backing}`,
    nextStepAfter: (x: string, when: string) => `Next step: ${x} in ${when}`,
    nextStepNow: (x: string) => `Next step: ${x} at the next update`,
    /** The depth reading was seen before and has stopped: the program keeps limiting new positions. Closes stay open. */
    stickyCap: "Liquidity reading is out of date — new positions are limited until it updates. Closes are open.",
    creatorSeed: "If this market closes, you get back your insurance seed (or what's left of it after losses). Anything above it goes to stakers.",
    /** A full side: new risk on it is paused, the other side and every close stay open. */
    sidePaused: (side: "long" | "short") =>
      side === "long"
        ? "New longs paused: this side is full. Closes and shorts are open."
        : "New shorts paused: this side is full. Closes and longs are open.",
    bothPaused: "New positions paused: this market is full. Closes are open.",
    /** The capacity row of a closed side: a word, never "0% full". */
    capacityPaused: "paused",
    capacityPausedFull: "paused (full)",
    /** Remaining room on the selected side (tokens, with the lot size when the market has lots, and USD). */
    room: (size: string, usd: string) => `Room on this side: ${size}, about ${usd}`,
    /** The account's collateral is below what the program requires after the fill (Custom 92): say how much fits and what it would take. */
    backingTrim: (fits: string, add: string, wanted: string) => `Your collateral covers ${fits} on this side right now. Order up to ${fits}, or add about ${add} to fill ${wanted}.`,
    backingAdd: (add: string) => `Your collateral is too low for any new size on this side right now. Add about ${add} and try again.`,
    /** The order is bigger than the room: the program fills the room and lands it. */
    trimNotice: (room: string, fill: string) => `Only ${room} of room left on this side; your order will fill ${fill}.`,
  },
  // ── Launch wizard: Advanced leverage tiers ───────────────────────────────
  tiers: {
    title: "Advanced: leverage tiers",
    /** `table` = "5x at $25k · 10x at $100k · 20x at $500k". */
    defaults: (table: string) => `${table} pool depth and market backing`,
    /** `floors` = "$5k, $20k, $100k" (or "5k USDC, 20k USDC, 100k USDC" on other collateral). */
    explain: (floors: string) => `A tier unlocks only when both the pool's depth and the market's backing reach its amount. Each depth amount has a floor (${floors}) so a market can't call itself deep with a tiny number.`,
    thresholdLabel: (tier: number, unit: string) => `Tier ${tier} amount (${unit})`,
    leverageLabel: (tier: number) => `Tier ${tier} max leverage`,
    defaultOption: (x: string) => `Default (${x})`,
    thresholdPlaceholder: (amount: string) => `Default ${amount}`,
    collateralDecimals: (max: number) => `This collateral has more than ${max} decimals, so a leveraged market cannot use it.`,
    atLeast: (amount: string) => `At least ${amount}`,
  },
  // ── First-loss staking (stake v5) ────────────────────────────────────────
  stake: {
    title: "First-loss staking",
    target: (pct: string) => `Deployment target ${pct}`,
    buffer: (pct: string) => `Liquid buffer ${pct}`,
    hysteresis: (pct: string) => `Rebalance band ${pct}`,
    /** The close-out rule, one plain line per audience. */
    closeOut: {
      feeOnly: "Fee-only stakers earn nothing while the market runs. When it closes, you share everything above the creator's seed, in proportion to your stake.",
      firstLoss: "At close, you share everything above the creator's seed in proportion to your stake.",
    },
    /**
     * Creator share disclosure (D5, 2026-10-29). Every market the wizard launches gets a fee-only stake pool (InitPoolV5, FEE_ONLY), so
     * there is no choice to offer: the creator keeps the 16% creator share and the pool never deploys into insurance.
     */
    creatorShare: {
      feeOnly: "Your market's stake pool is fee-only: the creator share (16% of fees) is yours.",
    },
    /**
     * The fee split's Stakers row on a fee-only page (agrees with closeOut.feeOnly): a FEE_ONLY pool is paid nothing
     * while the market runs and never deploys into insurance.
     */
    feeOnlyStakersRow: "nothing while the market runs. At close, fee-only stakers share what is above the creator's seed.",
    /** The insurance fee leg on a fee-only page: it does not go to fee-only stakers. */
    feeOnlyInsuranceLeg: "Backs losses a liquidation cannot cover.",
    /** A closed pool that holds surplus no staker owns (nobody staked): shown, never paid to the creator. */
    unclaimed: (usd: string) => `${usd} left in the closed pool, not claimable`,
    /** Page naming: only first-loss pools are insurance staking; fee-only and legacy pools stay "Fee staking". */
    insuranceStaking: "Insurance staking",
    insuranceIntro: "Stake into a market's pool to share its trading fees. Part of the pool backs the market's insurance, so your stake can lose value.",
    deployed: (usd: string) => `Deployed to insurance: ${usd}`,
    deployedUnknown: "Deployed to insurance: —",
    /** One plain paragraph above the program's own consent text (phase4 §6.1 item 5 wording). */
    consentSummary: "Staking insures this market's backstop: you can lose part of your stake if losses exceed the creator's tranche, bonds and Earn.",
    consentUnavailable: "First-loss deposits aren't available for this pool right now.",
    /** #3607: a first-loss pool whose own account is still being read; the deposit form waits for it. */
    poolReading: "Reading this pool…",
    /** #3607: that read failed (or came back empty); nothing was sent, and Retry reads it again. */
    poolReadFailed: "Couldn't read this pool just now. Nothing was sent.",
    retry: "Retry",
    consentLabel: "I have read and accept this risk text.",
    consentVersion: (v: number) => `Risk text version ${v}`,
    withdraw: "Withdrawals are paid only from the liquid part of the pool. The rest returns over time while the market is healthy.",
    deposit: "Deposit",
    /** Shown only when the liquid cap binds (after an insurance loss): one calm line, no error. */
    withdrawCap: (usd: string) => `Part of this pool is deployed as insurance; up to ${usd} can be withdrawn now, the rest returns if and when it's recovered.`,
    withdrawOverCap: "That is more than can be withdrawn now.",
  },
  // ── Earn page (v2.2) ─────────────────────────────────────────────────────
  earnPage: {
    /** v2.2 vaults can hold other collateral than USDC; each vault's own token is named in its deposit rail. */
    depositLead: "Deposit into a market's vault.",
    howDeposit: "Provide the market's deposit token as trading backing",
    /**
     * The P3 loss order (decision 2026-09-30; wrapper tag 111 InsuranceBackstopDraw draws insurance only for a deficit
     * left after the creator's stake and every Earn pot): insurance is NOT ahead of Earn for a trading loss.
     */
    insuranceOrder: "A trading loss reaches the creator's stake and Earn deposits first; insurance can step in only once they're used up",
  },
  // ── Unsupported layout ───────────────────────────────────────────────────
  layout: {
    title: "This market uses a newer version",
    body: "This page can't read it yet. Nothing was changed. Try again after the app updates.",
    /** /create?resume= on a launch made with an OLDER wrapper version: no retry or app update will make it continuable. */
    olderResume: "This launch was made with an older version of Percolator, so it can't be continued here. Nothing was changed.",
  },
} as const;
