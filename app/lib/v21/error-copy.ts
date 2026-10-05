/**
 * Plain copy for the Devnet v2.1 wrapper codes (lib/v21/wrapper-errors.ts), used by
 * lib/errorMessages.ts ONLY when the v2.1 flag is on. Calm, one idea each; every refusal of NEW
 * risk says that closing still works. P2b lock codes 120..122 are the copy from percolator-launch
 * #3118, rebased here behind the flag.
 */
import { WRAPPER_ERR_V21 } from "./wrapper-errors";

export const V21_ERROR_CODE_MAP: Record<number, string> = {
  [WRAPPER_ERR_V21.EngineAdlReduceOnly]: "This market is close-only while it rebalances. You can reduce or close your position; new positions reopen once it resets.",
  [WRAPPER_ERR_V21.EngineLossStale]: "Positions are being refreshed after a price move. Opening is paused for a moment; closing still works. Try again shortly.",
  [WRAPPER_ERR_V21.EarnExitWouldUnderBackClaims]: "This withdrawal would leave open winning positions under-backed. Try a smaller amount, or try again after they settle.",
  [WRAPPER_ERR_V21.GrowthLeverageExceeded]: "That much leverage isn't available at this size right now. Lower the leverage or the size and try again. Closing is never blocked.",
  [WRAPPER_ERR_V21.GrowthCapacityFull]: "This side of the market is full for now. Capacity grows as more liquidity backs the market; try the other side, a smaller size, or come back later. Closing still works.",
  [WRAPPER_ERR_V21.GrowthInvalidConfig]: "This market's growth settings aren't valid, so it can't be set up this way. Check the leverage, risk gap and funding limit and try again.",
  [WRAPPER_ERR_V21.GrowthNeedsLpCounterparty]: "New positions on this market trade against its liquidity vault. Place a market order instead; closing still works.",
  [WRAPPER_ERR_V21.GrowthBatchTooManyLegs]: "That's too many positions for one transaction. Send fewer at a time.",
  [WRAPPER_ERR_V21.GrowthRequiresBoundVaultLp]: "This market isn't ready for new positions yet: its liquidity vault isn't set up. Closing still works.",
  [WRAPPER_ERR_V21.GrowthUtilisationFeeNotCovered]: "This side is busy, so a small extra fee applies and the price moved a little. Refresh and try again; the new fee is included automatically.",
  [WRAPPER_ERR_V21.GrowthUtilisationFeeRequiresTradeCpi]: "A busy side can't be traded as part of a batch. Place this one as a single order.",
  [WRAPPER_ERR_V21.VaultLpAllocateRefused]: "Earn capital can't be moved into the market right now. Your trade doesn't need it; try again in a moment.",
  [WRAPPER_ERR_V21.VaultLpCapacityLocked]: "That capital stays in the market while it has open positions. It frees up once they have closed.",
  [WRAPPER_ERR_V21.VaultLpCreatorFeeVesting]: "Creator fees are still vesting: they unlock once the market's first-loss cushion reaches its target. Try again later.",
  [WRAPPER_ERR_V21.VaultLpSeniorCapitalHalt]: "This side is paused while the market's first-loss capital is rebuilt. Closing is always allowed.",
};
