/**
 * User-facing copy for the limits UI (plan §2). Exported so tests pin it and
 * so the error map, the ticket and the E2E lane share one wording.
 * No dependency on the rest of the app (imported by lib/errorMessages.ts).
 */
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { P2_ERR, P3_ERR } from "./constants";

export const COPY = {
  bandTooltip: "Fills must execute within this distance of the oracle mark. Outside it the trade is refused.",
  bandOutOfRange: "The quote for this size is outside the market's price band. Reduce the size.",
  reason: {
    "lp-exposure": (k: string) => `Limited by the market's liquidity: it can take at most ${k}× its capital in open positions.`,
    "side-oi": (side: string) => `Limited by the protocol cap on total ${side} open interest.`,
    "matcher-fill": () => "Limited by the market's per-trade size.",
    "matcher-inventory": () => "Limited by how much room the market has for more positions on this side.",
    "lp-halt": () => "The market has no room for new positions on this side right now: only trades that reduce open positions can fill.",
    "same-owner": () => "You created this market, so this wallet can only reduce or close its position here.",
    "vault-lp-exposure": (lev: string) => `Limited by the market's cap: at most ${lev}× the creator's stake.`,
    none: () => "",
  },
  clamped: (max: string, sym: string, reason: string) => `Size reduced to ${max} ${sym}. ${reason}`.trim(),
  zeroFill: "The market had no room for this trade when it landed. Your position did not change and no trading fee was charged.",
  partialFill: (filled: string, requested: string, sym: string) => `Partially filled: ${filled} of ${requested} ${sym}.`,
  halted: (side: string) =>
    `Opening ${side} is paused: the market has no room for more ${side} right now. Closes and trades on the other side still work.`,
  // P1 99165722 (F-7): a close that would GROW a halted / capped LP is refused (69) or clipped.
  closeHalted:
    "Closing this side is paused briefly: the market has no room to take the other side of your close right now. It reopens as other positions close.",
  closeCapped: (max: string, sym: string) =>
    `The market can take ${max} ${sym} of this close right now; a larger close fills partially. Close in parts, or wait for other positions to close.`,
  sameOwner:
    "This wallet owns this market's liquidity or created the market, so it can only close positions here, not open or add to them. Use a different wallet to trade.",
  limitsUnavailable: "Limits unavailable. Showing no cap.",
  quoteSettlesAtMark:
    "On this program version fills settle at the mark price. The quote above only decides how much can fill and whether your slippage limit passes.",
  quoteCharged: "The quoted price is charged: the difference from the mark is paid to the market as a fee. Your signature caps it at the maximum shown.",
  feeCapTooltip:
    "The most this trade can charge you: base fee + the quote's fee + a small slippage margin, so a quote that moves slightly before landing still fills. You pay only what the market actually asks for, never more than this. If the request exceeds it, the trade is refused and nothing is charged.",
  feeOverProtocolMax: (pct: string) => `The quote's fee is above this market's maximum (${pct}), so the trade would be refused. Reduce the size.`,
  feeOverMarketMax: "The quote's fee plus the base fee is above this market's maximum trading fee, so the trade would be refused. Reduce the size.",
  quoteClipped: (fill: string) => `Quote caps this trade at ${fill}.`,
  quoteSlippage: (s: string) =>
    `Your slippage limit (${s}) is tighter than the quote; the trade would be refused. Raise slippage or reduce size.`,
  feeEstimate: "Fee estimate; the final fee is set when the trade lands.",
  legacyQuote: (bps: string) => `Quote: within ${bps} of mark.`,
  skew: (dir: "long" | "short" | "flat", size: string, sym: string) =>
    dir === "flat" ? "Book skew: balanced" : `Book skew: traders net ${dir} ${size} ${sym}`,
  /** UX WP-5 / audit §5.2: "How losses work" — the P3 §0.8 rule in plain words, shown ONCE (Earn card). */
  howLossesWork:
    "The market creator's stake takes losses first. Only a loss bigger than that stake reaches Earn, and then every Earn depositor loses the same percentage. Winning traders are paid in full unless Earn's money is used up too, or the losing side's backing falls short. Share value can go down; only deposit what you can afford to lose.",
  howLossesFinePrint:
    "The first deposit into a vault leaves a tiny permanent amount (0.001 USDC) behind, and each withdrawal rounds down by at most 0.000001 USDC.",
  withdrawReceive: (amt: string) => `You receive ≈ ${amt}.`,
  withdrawImpaired: (value: string) =>
    `This vault is covering a loss, so Earn deposits are worth ${value} in total right now, below what was put in.`,
  withdrawIlliquid: (max: string) =>
    `Part of this vault's money is in use by open trades right now. You can withdraw up to ${max} now, or the rest once those trades close.`,
  depositsPausedImpaired: "Deposits are paused while this vault is covering a loss. Withdrawals still work.",
  /** Never shown (audit §3.7); kept for the deposit-gate fallback only. */
  valuationStale: "Updating the vault's value; we'll retry automatically.",
  excludesUncrankedFees: "excludes uncranked fees",
  apyInsufficient: "Needs 24 h of fee history",
  resolvedSettled: "This market has settled. Earn deposits can be withdrawn once the market has closed out.",
  fundingPay: (amt: string) => `Skew funding: you pay ${amt}/h`,
  fundingReceive: (amt: string) => `Skew funding: you receive ${amt}/h`,
  liqDrift: (delta: string) =>
    `At the current skew rate your liquidation price moves ≈ ${delta} per day. Add margin or reduce to hold it.`,
  stepDown: (x: string, side: string, crowd: string, base: string) =>
    `Max leverage is ${x}× for new ${side} positions while the book is crowded (${crowd} of the cap). The other side keeps ${base}×.`,
  wizardRequirement: (floor: string) =>
    `Your creator stake is first-loss capital. The market creator's stake takes losses first. Only a loss bigger than that stake reaches Earn, and then every Earn depositor loses the same percentage. Winning traders are paid in full unless Earn's money is used up too, or the losing side's backing falls short. It can't be withdrawn while traders have open positions on your market, or below ${floor} of Earn deposits.`,
  wizardAfterLaunch: "Your creator stake is added after launch.",
  closeRebooked: "The market is finishing its last fee sweep. Close again in a minute.",
  closeZeroFill:
    "Market at capacity — no fill. Your close landed but the market had no room to take it, so your position did not change. Try a smaller percentage or again shortly.",
  rebalanceZeroFill:
    "Nothing could be closed yet: this market is reduce-only after a bankruptcy and the other side has no open interest left to match. Try again as positions on the other side close.",
  rebalancePartial: (filled: string, requested: string) =>
    `Partially closed: ${filled} of ${requested}. The market is reduce-only after a bankruptcy; the rest can close as the other side exits.`,
  adlReduceOnlyTitle: "Reduce-only — recovering from a bankruptcy",
  adlCloseRoute:
    "Your close goes through directly, without waiting for the market's liquidity. It may close only part of the position if the other side has little open interest left.",
  adlReduceOnly:
    "A bankrupt position was spread across this side of the market, so new positions are paused until one side has closed out. Closing works: your close goes through directly. New positions reopen once the positions on one side have closed, which depends on those traders and can take a while.",
  reclaimCleanup: {
    "progress-only": () =>
      "Your position on this market is still settling after resolution (its counterparty has not settled yet). Try the reclaim again in a moment.",
    refused: () => "One of your accounts on this market could not be closed yet, so the market cannot be reclaimed. Try again in a moment.",
    "others-remain": (n: string) =>
      `Your accounts are closed, but ${n} other account${n === "1" ? "" : "s"} still hold a position or balance on this market, so it cannot be reclaimed until they close.`,
  } as const,
  juniorResolvedExplain:
    "Earn depositors are paid first: each redeems up to their claim from the vault's backing. You can take what is left above their remaining claim once the market is fully closed out.",
  /** useClosePosition: Confirm pressed before this market's position loaded. Nothing was sent. */
  closeNotLoaded: "We couldn't load your position on this market yet. Nothing was sent. Try again in a moment.",
  adlExitTrapped:
    "The other side of this market has fully closed, and your position can settle once the market catches up. Nothing was sent. Try again in a moment.",
  closePartial: (filled: string, requested: string) => `Partially closed: ${filled} of ${requested}. The rest of your position is still open.`,
  /** useClosePosition success toast: a full close, and a partial close the user asked for (not a clipped fill). */
  closeDone: "Position closed.",
  /** The close tx confirmed but the resulting position could not be measured: no claim about what closed. */
  closeConfirmedUnmeasured: "Your close went through. Your position is updating.",
  closeDonePart: (closed: string, of: string) => `Closed ${closed} of ${of}. The rest of your position is still open.`,
  /** UX WP-8 (audit §3.9): keeper-first, a time not a slot, "Finish now" as a secondary link. */
  resolvedExit: {
    title: "Market settled",
    status: "This market has settled. Payouts are being finalised automatically.",
    /** P3 ordering: the viewer's resolved close ran before the vault LP settled (receipt partial). */
    partialReceipt: "Part of your payout is on its way — it completes automatically once the market finishes settling.",
    eta: (amount: string | null, at: string, rel: string) =>
      amount ? `Your ${amount} will be ready to withdraw by about ${at} (${rel}).` : `Earn withdrawals open by about ${at} (${rel}).`,
    ready: "Everything on this market is settled. Earn withdrawals pay out now: use Withdraw below.",
    finishNow: (n: number, sol: string) =>
      `Anyone can speed this up. Finish the remaining ${n} step${n === 1 ? "" : "s"} now (about ${sol} SOL in network fees).`,
    finishLink: "Finish now",
    finishAndWithdrawLink: "Finish now and request my withdrawal",
    escrowed: (n: number) =>
      n === 1
        ? "1 position is held as an NFT. Its owner needs to close it; nothing you can do speeds that up."
        : `${n} positions are held as NFTs. Their owners need to close them; nothing you can do speeds that up.`,
    locked: (n: number) => (n === 1 ? "1 position is mid-liquidation; it will finish on its own." : `${n} positions are mid-liquidation; they'll finish on their own.`),
    running: "Finishing…",
    result: (sent: number, leftToKeeper: boolean) =>
      `Sent ${sent} step${sent === 1 ? "" : "s"}.${leftToKeeper ? " The rest will finish automatically." : ""}`,
    /** The request (76) landed in the same approval: the pending card takes over (WP-4). */
    requested: "Your withdrawal is requested. You'll be asked to confirm the payout when it's ready.",
  } as const,
  earnAbsorbedLabel: "Earn absorbed",
  earnAbsorbedTooltip: (drawn: string, restored: string) =>
    `A loss bigger than the creator's stake, shared by Earn depositors (every share loses the same percentage). ` +
    `${drawn} absorbed in total, ${restored} of it restored so far: if the vault recovers, Earn is restored first.`,
  /** E2E B24: 77 refused (21) on a P3 bound vault. Cause pending P3 confirmation: assert none. */
  earnClaimRefusedP3:
    "The vault can't pay this withdrawal right now. Nothing moved and your withdrawal stays pending. Try again later.",
  /** Creator panel notice when the junior is exhausted (senior-impaired flag set on chain). */
  juniorExhausted:
    "Your creator stake has been used up covering trader profits, so further losses reach Earn: every Earn depositor loses the same percentage. Winning traders are paid in full unless Earn's money is used up too, or the losing side's backing falls short. New Earn deposits are paused.",
  /** Earn risk notice on P3 markets: who bears a loss (user decision 2026-09-30, reversed; wording = P3 doc §0.8). */
  earnRiskP3:
    "Earn deposits back each market's liquidity and can lose value. The market creator's stake takes losses first. Only a loss bigger than that stake reaches Earn, and then every Earn depositor loses the same percentage. Winning traders are paid in full unless Earn's money is used up too, or the losing side's backing falls short. Only deposit what you can afford to lose.",
  p3Wizard: {
    title: "Your creator stake",
    explain:
      "Your market's liquidity comes from the Earn vault. You fund its first-loss capital, your creator stake, and trading profit and loss against it is yours. The market creator's stake takes losses first. Only a loss bigger than that stake reaches Earn, and then every Earn depositor loses the same percentage. Winning traders are paid in full unless Earn's money is used up too, or the losing side's backing falls short.",
    floorLabel: "Keep at least",
    floorTooltip:
      "The share of Earn deposits your creator stake must cover. You cannot withdraw below it while Earn depositors are in the vault. 10% to 100%.",
    amountLabel: "Creator stake",
    minHint: (min: string, sym: string) => `At least ${min} ${sym} (the floor of the Earn seed).`,
    marketauthRotated:
      "This market's admin rights have already moved to its staking pool, so the Earn vault can no longer take over its liquidity. The market keeps its current liquidity.",
    pinned:
      "The protocol sets the market's pricing and limits at launch (up to $5,000 per trade and $25,000 total exposure at the launch price); you choose only your creator stake and its minimum. Trading opens as soon as the market is created.",
    issue: {
      "floor-out-of-range": "The minimum must be between 10% and 100%.",
      "junior-zero": "Enter a creator stake.",
      "junior-below-floor": "Your creator stake must at least cover the minimum of the first Earn deposit.",
      "junior-above-liquidity": "Your creator stake cannot exceed the market's liquidity amount.",
    },
  } as const,
  earnPlanBlocked: {
    "registry-invalid": "This Earn vault isn't set up correctly, so Earn deposits and withdrawals can't go through. Report this market.",
    "vault-lp-unreadable": "This Earn vault's details couldn't be read. Retry in a moment.",
  } as const,
} as const;

/** Matcher v2 error copy (Custom 8002..8005, matcher program only). */
export const P2_ERROR_COPY: Record<number, string> = {
  [P2_ERR.ERR_STALE_MARK]: "The price feed is stale, so new positions are paused. Closing still works. Try again shortly.",
  [P2_ERR.ERR_MARK_SLOT_IN_FUTURE]: "The price feed returned an invalid timestamp. Try again in a few seconds.",
  [P2_ERR.ERR_ASSET_MISMATCH]: "This market's pricing engine is misconfigured (bound to another asset). Report this market.",
  [P2_ERR.ERR_OWNER_PROOF_MISMATCH]: "Only the market's owner can change its pricing settings.",
};

/** P3 wrapper error copy, keyed by NAME (ordinals are provisional — see constants.ts). */
export const P3_ERROR_COPY_BY_NAME: Record<keyof typeof P3_ERR, string> = {
  VaultLpAlreadyBound: "This market's Earn vault already provides its liquidity.",
  VaultLpNotBound: "This market's Earn vault doesn't provide its liquidity yet.",
  VaultLpSeniorImpaired: COPY.depositsPausedImpaired,
  VaultLpJuniorWithdrawRefused:
    "Not withdrawable yet: it would take your creator stake below its minimum, or the vault doesn't cover Earn deposits right now.",
  VaultLpRecallRefused: "Nothing to move: the vault already covers Earn deposits.",
  // 77. Next P3 FINAL: also returned by TradeNoCpi / BatchTradeNoCpi that grow either side on a
  // P3 asset (the app never sends those; __tests__/lib/limits/no-nocpi-on-p3.test.ts).
  VaultLpExclusiveCounterparty:
    "This trade route isn't available on this market. Reducing or closing a position still works.",
  VaultLpLeverageStepDown:
    "Leverage too high for this side while the book is crowded. Lower leverage or trade the other side.",
  VaultLpBoundCannotClose: "This vault provides the market's liquidity and can't be closed.",
  VaultLpExposureCapExceeded:
    "This trade is larger than the market can take: its exposure is capped at a multiple of the creator's stake. Reduce the size.",
  VaultLpMatcherNotApproved: "The protocol hasn't approved this pricing for the market.",
  VaultLpUseSettleResolved: "This market has settled: its liquidity is paid out through the Earn vault (Earn deposits first), not closed directly.",
  VaultLpReleaseRefused: "Nothing to release: the vault's backing does not exceed what Earn depositors are owed.",
  VaultLpHarvestPending:
    "Collecting the vault's latest fees first, so the first depositor can't buy them at the old share value. Try again shortly.",
  VaultLpValuationStale:
    "Updating the vault's value; we'll retry automatically, usually within seconds.",
  VaultLpSeniorDrawRequired:
    "The vault is booking a recent market move. Nothing moved; we'll retry automatically.",
  VaultLpRedeemNeedsRecall:
    "Part of this withdrawal is in use by open trades right now. Nothing moved and your withdrawal stays pending: withdraw less, or try again once those trades close.",
  VaultLpPausedForSeniorDraw:
    "Paused while Earn covers a loss. The market took a loss bigger than the creator's stake, so new positions and creator-stake withdrawals are paused until the vault recovers. Closing positions and Earn deposits and withdrawals still work; nothing moved.",
  // 592286b4 (relaunch): tag 94 on an asset that already has open positions.
  VaultLpBindRequiresFlatAsset:
    "This market already has open positions, so the Earn vault can't take over its liquidity now. It can only do that when the market is created, before the first trade. Create a new market to use the Earn vault.",
  VaultLpMultiAssetMarket:
    "An Earn vault can only provide liquidity to a single-asset market, and this market holds more than one asset. Create a new market to use the Earn vault.",
};

/**
 * Non-bound Earn (wrapper 7a3ac04c+ NAV floor): 75 refused while a pot is over-impaired or the
 * share price has collapsed (`LpVaultTargetPotImpaired`, Custom 91). Not a P3 (bound-vault) code,
 * so it is keyed here and merged into the code table by `p3ErrorCopyByCode`.
 */
export const EARN_FLOOR_ERROR_COPY_BY_NAME = {
  LpVaultTargetPotImpaired: "Earn deposits are paused while this vault settles. Nothing was sent.",
} as const;

/** P3 copy re-keyed by the CURRENT provisional ordinals. */
export function p3ErrorCopyByCode(): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [name, code] of Object.entries(P3_ERR) as [keyof typeof P3_ERR, number][]) {
    out[code] = P3_ERROR_COPY_BY_NAME[name];
  }
  out[WRAPPER_ERR.LpVaultTargetPotImpaired] = EARN_FLOOR_ERROR_COPY_BY_NAME.LpVaultTargetPotImpaired;
  return out;
}

/**
 * The market can't take the other side of new trades (LP capital below its IM floor). Where the funds
 * come back from depends on the market: a P3 vault-LP market is funded from its Earn vault, any other
 * market only by a deposit into its own counterparty, which Earn and staking deposits never reach.
 */
export function TICKET_FUNDS_LINE(vault: boolean): string {
  return vault
    ? "The market doesn't have enough funds to take the other side of new trades. Opening resumes when the Earn vault has funds to back them."
    : "The market doesn't have enough funds to take the other side of new trades. Opening resumes once it is funded again; deposits to Earn or staking don't reopen it.";
}

/**
 * UX WP-3 (audit §3.3 / §3.4 / §4.2): the order ticket's one status slot, its state-labelled
 * button and its result lines. Plain words only (§5.1): no LP, crank, engine, keeper or codes.
 */
export const TICKET_COPY = {
  settled: { title: "Market settled", body: "This market has settled. Close any position and withdraw; there's nothing else to do.", button: "Market settled" },
  retired: { title: "Market closed", body: "This market no longer takes new positions. Close any position and withdraw.", button: "Market closed" },
  adminPaused: { title: "Trading paused", body: "Trading on this market is paused for now. Your funds stay where they are.", button: "Trading paused" },
  closeOnly: {
    title: "Close-only for now",
    body: "Close-only for now after a liquidation. Closing works normally. New positions reopen once the positions on one side have closed, which depends on those traders and can take a while.",
    button: "Close-only for now",
  },
  catchingUp: { title: "Catching up", body: "Prices are catching up. Trading resumes once the market has caught up.", button: "Waiting for prices…" },
  waitingPrice: { title: "Waiting for price", body: "Waiting for a fresh price. This usually takes a few seconds.", button: "Waiting for price…" },
  sidePaused: {
    title: (sides: string) => `New ${sides} paused`,
    body: (sides: string, side: string, others: string) =>
      `New ${sides} are paused: the market has no room for more ${side} exposure right now. ${others} and closes work. This reopens as positions close.`,
    button: (sides: string) => `New ${sides} paused`,
  },
  bothPaused: { title: "Opening paused", body: "New positions are paused right now. Closing works normally.", button: "Opening paused" },
  /** Not enough funds to take the other side of new trades. What refills it depends on the market type. */
  lpDepleted: {
    title: "Opening paused",
    body: (vault: boolean) => `${TICKET_FUNDS_LINE(vault)} Closing works normally.`,
    button: "Opening paused",
  },
  sameOwner: {
    title: "Close-only for this wallet",
    body: "You created this market, so this wallet can only close positions here. Use another wallet to trade it.",
    button: "Close-only for this wallet",
  },
  feeOverMax: {
    title: "Fee too high for this size",
    body: (suggested: string | null) =>
      `This size costs more than the market's maximum fee.${suggested ? ` Try ${suggested}.` : " Try a smaller size."}`,
    button: "Reduce size",
  },
  depositToTrade: (amount: string, side: string) => `Deposit ${amount} & ${side}`,
  /** The order button while there is no size to trade (it is disabled until there is). */
  enterSize: "Enter a size",
  stepDownInline: (x: string, sides: string, y: string, others: string) =>
    `Up to ${x}× for new ${sides} right now (busy side). ${others}: up to ${y}×.`,
  clamped: (max: string, sym: string) => `Reduced to the most available now: ${max} ${sym}`,
  waitingLong: {
    title: "Still waiting",
    body: "Prices are taking longer than usual. We'll keep trying. You can leave this open.",
    stop: "Stop",
  },
  confirmInWallet: "Confirm in wallet…",
  waitingLatest: "Waiting for the latest price…",
  /** GH#2804 follow-up: a trade whose confirmation timed out is watched until it resolves. */
  pending: {
    button: "Confirming…",
    watching: { title: "Still confirming", body: "Checking the network…" },
    // The fill isn't measured on this path, and a split order's later transactions were never
    // sent, so never state a size or a full fill.
    landed: { title: "Confirmed", body: "It went through, possibly only in part. Check your position before trading again." },
    dropped: { title: "Order not placed", body: "This trade didn't go through. Nothing changed. You can try again." },
    undetermined: { title: "Couldn't confirm yet", body: "Check your position or the explorer before trying again." },
  },
  sidePausedSublabel: "Paused",
  result: {
    full: (size: string, sym: string, side: string, price: string) => `Opened ${size} ${sym} ${side} at ${price}`,
    /** An Open-tab order against the open position (lib/trading.ts orderEffect). `held` = the side it cut. */
    reduced: (size: string, sym: string, held: string, price: string) => `Reduced your ${held} by ${size} ${sym} at ${price}`,
    closed: (size: string, sym: string, held: string, price: string) => `Closed your ${size} ${sym} ${held} at ${price}`,
    flipped: (closed: string, opened: string, sym: string, held: string, side: string, price: string) =>
      `Closed your ${closed} ${sym} ${held} and opened ${opened} ${sym} ${side} at ${price}`,
    /** The post-trade read could not measure the fill: the trade landed, its size is not known yet. */
    unmeasured: "Order went through. Your position updates in a moment.",
    partial: (filled: string, requested: string, sym: string) =>
      `Opened ${filled} of ${requested} ${sym}. The market had room for part of your order.`,
    zero: "Not filled: the market had no room for this trade when it landed. Nothing changed and no fee was charged.",
    tryChip: (size: string) => `Try ${size}`,
  },
  close: {
    adl: "Close-only market: your close goes through directly and may fill in parts if the other side is thin.",
    capped: (max: string, sym: string) => `The market can take ${max} ${sym} of this close right now.`,
    cappedAction: (max: string) => `Close ${max}`,
    halted: "Closing this side is paused for a moment while the market rebalances. It reopens as other positions close.",
  },
} as const;
