/**
 * Calm one-line messages for the Devnet v2.2 wrapper codes 104..=119, 123, 124 and the stake v5 codes 33..=45.
 * Used by `lib/limits/user-message.ts` ONLY when `NEXT_PUBLIC_DEVNET_V22` is on (flag off the resolver never
 * calls this). Special handling:
 *  - 104 (band pinned) is NOT an error: variant "wait", "Price is catching up. Closing reopens when it has."
 *  - 117 (below min payout) and 124 (bond slippage): `requote` = re-quote and show the new minimum.
 *  - 118 (exit requires loss-current): `autoRetry`; the Earn exit adds inline refresh accounts and retries in
 *    the same user action (lib/v22/earn-exit-run.ts), never asking the user to do anything.
 *  - 121 keeps the existing v2.1 "Refreshing positions…" retry (not handled here).
 */
import type { MessageContext, StatusVariant, UserMessage } from "@/lib/limits/user-message";
import { STAKE_ERRORS_V5 } from "./sdk";
import { STAKE_ERR_DEPOSIT_BELOW_MIN_LIQUIDITY, STAKE_ERR_V5, WRAPPER_ERR_V22 } from "./wrapper-errors";
import { V22_COPY } from "./copy";

type Build = (kind: string, variant: StatusVariant, title: string, body: string, extra?: Partial<UserMessage>) => UserMessage;

export function v22WrapperMessage(code: number, ctx: MessageContext & { minPositionLabel?: string }, m: Build): UserMessage | null {
  const V = WRAPPER_ERR_V22;
  switch (code) {
    case V.PriceBandPinned:
      // No autoRetry: nothing consumes it for a close, and a pin can last about an hour (band_max_pin_slots), so the line stays
      // calm and short and the honest part sits in Details.
      return m("band-catching-up", "wait", "Price catching up", V22_COPY.band.catchingUp, { why: V22_COPY.band.catchingUpWhy });
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
    default:
      return null;
  }
}

/** Stake v5 codes 33..=45, plus 28 (first deposit too small). Only call for an error attributed to the stake program. */
export function v22StakeMessage(code: number, m: Build): UserMessage | null {
  const info = STAKE_ERRORS_V5[code];
  if (!info) return null;
  switch (code) {
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
