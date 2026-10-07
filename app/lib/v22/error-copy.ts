/**
 * Plain-string copy for the v2.2 wrapper codes and stake v5 codes, used by `lib/errorMessages.ts` ONLY when the
 * v2.2 flag is on. The structured twin (title, variant, retry flags) lives in `./error-message`. Calm, one line.
 */
import { WRAPPER_ERR_V22 } from "./wrapper-errors";
import { V22_COPY } from "./copy";
import { STAKE_ERRORS_V5 } from "./sdk";

export const V22_ERROR_CODE_MAP: Record<number, string> = {
  [WRAPPER_ERR_V22.PriceBandPinned]: V22_COPY.band.catchingUp,
  [WRAPPER_ERR_V22.PriceBandConfigInvalid]: "These price-protection settings aren't valid for this market. Adjust them and try again.",
  [WRAPPER_ERR_V22.HoldingRentConfigInvalid]: "This holding-fee setting isn't valid. Adjust it and try again.",
  [WRAPPER_ERR_V22.BondTrancheImpaired]: V22_COPY.bond.impaired,
  [WRAPPER_ERR_V22.BondCapacityLocked]: V22_COPY.bond.locked,
  [WRAPPER_ERR_V22.BondWithdrawCooldown]: "Your withdrawal is still cooling down. Try again after it ends.",
  [WRAPPER_ERR_V22.BondConfigInvalid]: "These bond details don't fit this market or your position.",
  [WRAPPER_ERR_V22.PriceBandPositionCap]: V22_COPY.band.fullSide,
  [WRAPPER_ERR_V22.PriceBandTooNarrow]: V22_COPY.band.closeOnlyAtPrice,
  [WRAPPER_ERR_V22.PriceBandLegBelowMinNotional]: "Below the minimum position size: trade at least the market minimum, or close fully.",
  [WRAPPER_ERR_V22.RescueRefused]: "This market can't take new capital right now.",
  [WRAPPER_ERR_V22.RescueNavFloor]: V22_COPY.rescue.wound,
  [WRAPPER_ERR_V22.InsuranceBackstopRefused]: "That insurance move didn't go through. Nothing moved.",
  [WRAPPER_ERR_V22.RedemptionBelowMinPayout]: "The exit price moved below your minimum. Getting a new quote.",
  [WRAPPER_ERR_V22.ExitRequiresLossCurrent]: V22_COPY.earnExit.refreshing,
  [WRAPPER_ERR_V22.LotConfigInvalid]: "Pick a launch price between $10 and $10,000 per lot.",
  [WRAPPER_ERR_V22.BondDepositAboveCap]: V22_COPY.bond.full,
  [WRAPPER_ERR_V22.BondSlippage]: "The bond price moved past your minimum. Getting a new quote.",
};

export const V22_STAKE_ERROR_CODE_MAP: Record<number, string> = Object.fromEntries(
  Object.entries(STAKE_ERRORS_V5).map(([c, info]) => [Number(c), info.hint]),
);
