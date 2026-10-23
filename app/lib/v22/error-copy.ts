/**
 * Plain-string copy for the v2.2 wrapper codes and stake v5 codes, used by `lib/errorMessages.ts` ONLY when the
 * v2.2 flag is on. The structured twin (title, variant, retry flags) lives in `./error-message`. Calm, one line.
 */
import { WRAPPER_ERR_V22 } from "./wrapper-errors";
import { V22_COPY, V22_DEPTH_INPUT_COPY, V22_DEPTH_SOURCE_COPY, V22_TIER_CONFIG_COPY } from "./copy";
import { V22_COUNTERPARTY_CAP_COPY, V22_POSITION_CAP_REACHED_COPY, V22_SIDE_FULL_COPY } from "./trade-refusal-9-copy";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { WRAPPER_ERR_V21 } from "@/lib/v21/wrapper-errors";
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
  [WRAPPER_ERR_V22.G9AllowlistTimelock]: "This feed-allowlist change is still in its waiting period. Nothing was changed.",
  [WRAPPER_ERR_V22.PositionCapReached]: V22_POSITION_CAP_REACHED_COPY,
  [WRAPPER_ERR_V22.CounterpartyPositionCapReached]: V22_COUNTERPARTY_CAP_COPY,
  [WRAPPER_ERR_V22.DepthInputInvalid]: V22_DEPTH_INPUT_COPY,
  [WRAPPER_ERR_V22.DepthSourceInvalid]: V22_DEPTH_SOURCE_COPY,
  [WRAPPER_ERR_V22.GrowthTierConfigInvalid]: V22_TIER_CONFIG_COPY,
  // Plain lines for 28 / 29 (pre-v2.2 table speaks of confidence intervals and oracle accounts) and 93 (capacity full).
  [WRAPPER_ERR.OracleConfTooWide]: "The price feed is too uncertain right now, so the market is not accepting this action. Nothing was changed. Wait a moment and try again.",
  [WRAPPER_ERR.InvalidOracleKey]: "The price account sent with this transaction is not the one this market uses. Nothing was changed. Refresh the page and try again; if it keeps happening, the app is out of date.",
  [WRAPPER_ERR_V21.GrowthCapacityFull]: V22_SIDE_FULL_COPY,
};

export const V22_STAKE_ERROR_CODE_MAP: Record<number, string> = Object.fromEntries(
  Object.entries(STAKE_ERRORS_V5).map(([c, info]) => [Number(c), info.hint]),
);
