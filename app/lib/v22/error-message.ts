/**
 * Calm one-line messages for the Devnet v2.2 wrapper codes 104..=119, 123, 124 and the stake v5 codes 33..=45.
 * Used by `lib/limits/user-message.ts` ONLY when `NEXT_PUBLIC_V22` is on (flag off the resolver never
 * calls this). Special handling:
 *  - 104 (band pinned) is NOT an error: variant "wait", "Close on hold while the price catches up. Try again once it has."
 *  - 117 (below min payout) and 124 (bond slippage): `requote` = re-quote and show the new minimum.
 *  - 118 (exit requires loss-current): `autoRetry`; the Earn exit adds inline refresh accounts and retries in
 *    the same user action (lib/v22/earn-exit-run.ts), never asking the user to do anything.
 *  - 121 keeps the existing v2.1 "Refreshing positions…" retry (not handled here).
 */
import type { MessageContext, StatusVariant, UserMessage } from "@/lib/limits/user-message";
import { STAKE_ERRORS_V5 } from "./sdk";
import { STAKE_ERR_DEPOSIT_BELOW_MIN_LIQUIDITY, STAKE_ERR_V5, WRAPPER_ERR_V22 } from "./wrapper-errors";
import { LEV_GUARD_COPY, LEV_GUARD_REFUSED_TITLE, levGuardRefusedCopy, parseLevGuardRefusal } from "./lev-guard-copy";
import { catchUpAvailableLine } from "@/lib/limits/catchup-estimate";
import { V22_COPY, V22_DEPTH_INPUT_COPY, V22_DEPTH_SOURCE_COPY, V22_TIER_CONFIG_COPY } from "./copy";
import { V22_COUNTERPARTY_CAP_COPY, V22_CUSTOM9_OFF_TICKET, V22_SIDE_FULL_COPY, positionCapCopy } from "./trade-refusal-9-copy";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { WRAPPER_ERR_V21 } from "@/lib/v21/wrapper-errors";

/** percolator-stake error.rs: TrancheNotEnabled = 19, WrongTranche = 21. */
export const STAKE_ERR_TRANCHE_NOT_ENABLED = 19;
export const STAKE_ERR_WRONG_TRANCHE = 21;
/**
 * Product review 2026-10-28 (S-5 / S-6 / S-12): three pre-v5 stake codes (percolator-stake src/error.rs) that the stake page can hit
 * and that fell through to "Something went wrong": the withdraw cooldown, a deposit into a pool whose market is resolved, and a deposit
 * over the pool's cap (devnet freezes a pool with `deposit_cap = 1` once a resolve is decided: stake #318 / L5 M-3).
 */
export const STAKE_ERR_COOLDOWN_NOT_ELAPSED = 3;
export const STAKE_ERR_MARKET_RESOLVED = 8;
export const STAKE_ERR_DEPOSIT_CAP_EXCEEDED = 9;
/** percolator-stake error.rs: 29 = AccrueFees refused because only the dead-share floor is staked (no real holders yet). */
export const STAKE_ERR_NO_REAL_HOLDERS = 29;

type Build = (kind: string, variant: StatusVariant, title: string, body: string, extra?: Partial<UserMessage>) => UserMessage;

export function v22WrapperMessage(code: number, ctx: MessageContext & { minPositionLabel?: string; levGuardLogs?: readonly string[] }, m: Build): UserMessage | null {
  const V = WRAPPER_ERR_V22;
  // A bare 9 off the trade ticket. ON the ticket it stays unmapped on purpose: the ticket then reads chain state to name the cause.
  if (code === WRAPPER_ERR.InvalidInstruction && ctx.surface !== "trade") {
    return m("request-refused", "error", "Not done", V22_CUSTOM9_OFF_TICKET);
  }
  switch (code) {
    case V.PriceBandPinned:
      // No autoRetry: nothing consumes it for a close, and a pin can last about an hour (band_max_pin_slots), so the line stays
      // calm and short and the honest part sits in Details.
      // QA P-4: 104 refuses only the close the stale pinned price would favour (the other direction is allowed).
      return m("band-catching-up", "wait", "Close on hold", catchUpAvailableLine(ctx.catchUpMs, "close"), { why: V22_COPY.band.catchingUpWhy });
    case V.PriceBandConfigInvalid:
      return m("band-config", "error", "Price protection not valid", "These price-protection settings aren't valid for this market. Adjust them and try again. Nothing was sent.");
    case V.HoldingRentConfigInvalid:
      return m("rent-config", "error", "Holding fee not valid", "This holding-fee setting isn't valid. Adjust it and try again. Nothing was sent.");
    case V.BondTrancheImpaired:
      return m("bond-impaired", "paused", "Deposits paused", V22_COPY.bond.impaired);
    case V.BondCapacityLocked:
      return m("bond-locked", "paused", "Still backing positions", V22_COPY.bond.locked);
    case V.BondWithdrawCooldown:
      return m("bond-cooldown", "wait", "Still cooling down", "Your withdrawal is still cooling down. Try again after it ends. Nothing moved.");
    case V.BondConfigInvalid:
      return m("bond-config", "error", "Bond settings not valid", "These bond details don't fit this market or your position. Nothing was sent.");
    case V.PriceBandPositionCap:
      return m("band-side-full", "paused", "Side is full", V22_COPY.band.fullSide);
    case V.PriceBandTooNarrow:
      return m("band-close-only", "paused", "Close-only at this price", V22_COPY.band.closeOnlyAtPrice);
    case V.PriceBandLegBelowMinNotional:
      return m(
        "band-below-min",
        "error",
        "Below the minimum size",
        ctx.minPositionLabel
          ? `Below the minimum position size: trade at least ${ctx.minPositionLabel}, or close fully.`
          : "Below the minimum position size: trade at least the market minimum, or close fully.",
      );
    case V.RescueRefused:
      return m("rescue-refused", "paused", "Not right now", "This market can't take new capital right now. Nothing moved.");
    case V.RescueNavFloor:
      return m("rescue-floor", "info", "Winding down", V22_COPY.rescue.wound);
    case V.InsuranceBackstopRefused:
      return m("backstop-refused", "info", "Not available", "That insurance move didn't go through. Nothing moved.");
    case V.RedemptionBelowMinPayout:
      return m("exit-requote", "wait", "Price moved", "The exit price moved below your minimum. Getting a new quote.", { requote: true, autoRetry: true });
    case V.ExitRequiresLossCurrent:
      return m("exit-refreshing", "wait", "Refreshing positions", V22_COPY.earnExit.refreshing, { autoRetry: true });
    case V.LotConfigInvalid:
      return m("lot-config", "error", "Launch price not valid", "Pick a launch price between $10 and $10,000 per lot. Nothing was sent.");
    case V.BondDepositAboveCap:
      return m("bond-full", "paused", "Bond is full", V22_COPY.bond.full);
    case V.BondSlippage:
      return m("bond-requote", "wait", "Price moved", "The bond price moved past your minimum. Getting a new quote.", { requote: true });
    case V.G9AllowlistTimelock:
      return m("g9-timelock", "info", "Still waiting", "This feed-allowlist change is still in its waiting period. Nothing was changed.");
    case V.PositionCapReached:
      // Same line the ticket's own pre-check and the classified Custom(9) show (positionCapCopy); the number is the market's own cap.
      return m("position-cap", "error", "Position limit reached", positionCapCopy(ctx.maxPositions));
    case V.CounterpartyPositionCapReached:
      return m("counterparty-cap", "paused", "Market is at its limit", V22_COUNTERPARTY_CAP_COPY);
    case V.DepthInputInvalid:
      return m("depth-input", "info", "Try again", V22_DEPTH_INPUT_COPY);
    case V.DepthSourceInvalid:
      return m("depth-source", "info", "Try again", V22_DEPTH_SOURCE_COPY);
    case V.GrowthTierConfigInvalid:
      return m("tier-config", "error", "Check the leverage tiers", V22_TIER_CONFIG_COPY);
    // Leverage guard (tag 124). 133 names its cause from the `lev_guard_refused <why>` log line when the error carries logs.
    case V.CreatorStakeBelowMinimum:
      return m("lev-guard-creator-stake", "error", "Creator stake too low", LEV_GUARD_COPY.creatorStake);
    case V.LevGuardRequired:
      return m("lev-guard-required", "error", "Page out of date", LEV_GUARD_COPY.required, { action: { id: "refresh", label: "Refresh" } });
    case V.LevGuardRefused: {
      const reason = parseLevGuardRefusal(ctx.levGuardLogs);
      // A young token and an LP round are waits, not mistakes; the others ask the trader to change the order.
      const variant = reason === "age_under_6h" || reason === "lp_stop_round" ? "wait" : reason === null ? "paused" : "error";
      return m(`lev-guard-${reason ?? "refused"}`, variant, LEV_GUARD_REFUSED_TITLE[reason ?? "unknown"], levGuardRefusedCopy(reason));
    }
    case V.LevGuardInvalid:
      return m("lev-guard-invalid", "error", "Page out of date", LEV_GUARD_COPY.invalid, { action: { id: "refresh", label: "Refresh" } });
    case V.LpStopNotTriggered:
      return m("lp-stop-not-triggered", "info", "Nothing to do", LEV_GUARD_COPY.lpStopNotTriggered);
    // Plain lines for three wrapper codes that used to fall to "Something went wrong" (28, 29) or the engine-speak of the
    // pre-v2.2 table (93).
    case WRAPPER_ERR.OracleConfTooWide:
      return m("price-unsteady", "wait", "Price unsteady", "The price feed is too uncertain right now, so the market is not accepting this action. Nothing was changed. Wait a moment and try again.");
    case WRAPPER_ERR.InvalidOracleKey:
      return m("feed-mismatch", "error", "Page out of date", "The price account sent with this transaction is not the one this market uses. Nothing was changed. Refresh the page and try again; if it keeps happening, the app is out of date.", { action: { id: "refresh", label: "Refresh" } });
    case WRAPPER_ERR_V21.GrowthCapacityFull:
      return m("growth-capacity-full", "paused", "This side is full", V22_SIDE_FULL_COPY);
    default:
      return null;
  }
}

/** Stake v5 codes 33..=48, plus 28 (first deposit too small). Only call for an error attributed to the stake program. */
export function v22StakeMessage(code: number, m: Build): UserMessage | null {
  // v2.2 QA copy round: two pre-v5 stake codes (percolator-stake src/error.rs) that showed "Something went wrong".
  if (code === STAKE_ERR_TRANCHE_NOT_ENABLED) {
    return m("stake-no-tiers", "info", "Not available", "This pool has a single tier, so there is no senior or junior side to choose. Nothing was sent.");
  }
  if (code === STAKE_ERR_WRONG_TRANCHE) {
    return m("stake-wrong-tier", "info", "Other tier in use", "This wallet already has a deposit in the other tier of this pool. Use that tier, or another wallet. Nothing was sent.");
  }
  if (code === STAKE_ERR_COOLDOWN_NOT_ELAPSED) {
    return m("stake-cooldown", "wait", "Still cooling down", "This stake's cooldown hasn't ended yet. Each new deposit restarts it for the whole position. Try again after it ends. Nothing was sent.");
  }
  if (code === STAKE_ERR_MARKET_RESOLVED) {
    return m("stake-market-settled", "info", "Market settled", "This market has settled, so its pool takes no new deposits. You can still withdraw. Nothing was sent.");
  }
  if (code === STAKE_ERR_DEPOSIT_CAP_EXCEEDED) {
    return m("stake-cap", "info", "Deposits closed", "This pool isn't taking that much right now: it's at its deposit limit, or deposits are closed while the market is being settled. Try a smaller amount, or another pool. Nothing was sent.");
  }
  const info = STAKE_ERRORS_V5[code];
  if (!info) return null;
  switch (code) {
    case STAKE_ERR_NO_REAL_HOLDERS:
      return m("stake-no-holders", "info", "Nothing to book yet", info.hint);
    case STAKE_ERR_DEPOSIT_BELOW_MIN_LIQUIDITY:
      return m("stake-min-first-deposit", "info", "Deposit a little more", info.hint);
    case STAKE_ERR_V5.ConsentRequired:
      return m("stake-consent", "wait", "Review the risk text", info.hint, { action: { id: "refresh", label: "Review" } });
    case STAKE_ERR_V5.LiquidityBufferExhausted:
      return m("stake-liquidity", "paused", "Only the liquid part", info.hint);
    case STAKE_ERR_V5.SyncCooldownActive:
    case STAKE_ERR_V5.NothingToSync:
      return m("stake-sync", "info", "Nothing to do yet", info.hint);
    case STAKE_ERR_V5.InsuranceReadingsDiverged:
      return m("stake-lent", "paused", "Waiting for repayment", info.hint);
    default:
      return m(`stake-${info.name}`, "info", "Not available", info.hint);
  }
}
