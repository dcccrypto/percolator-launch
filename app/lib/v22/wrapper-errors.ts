/**
 * The Devnet v2.2 wrapper error codes 104..=119, 123, 124 (percolator-prog release/v22-wrapper, waves A to D),
 * kept OUT of `WRAPPER_ERR` and `WRAPPER_ERR_V21` for the same reason: those are pinned to the deployed wrapper.
 * Names are the Rust variant names (as in the SDK table `PERCOLATOR_ERRORS_V22`); codes 120..=122 stay in
 * `WRAPPER_ERR_V21`. Only interpreted when `NEXT_PUBLIC_DEVNET_V22` is on.
 */
export const WRAPPER_ERR_V22 = {
  PriceBandPinned: 104,
  PriceBandConfigInvalid: 105,
  HoldingRentConfigInvalid: 106,
  BondTrancheImpaired: 107,
  BondCapacityLocked: 108,
  BondWithdrawCooldown: 109,
  BondConfigInvalid: 110,
  PriceBandPositionCap: 111,
  PriceBandTooNarrow: 112,
  PriceBandLegBelowMinNotional: 113,
  RescueRefused: 114,
  RescueNavFloor: 115,
  InsuranceBackstopRefused: 116,
  RedemptionBelowMinPayout: 117,
  ExitRequiresLossCurrent: 118,
  LotConfigInvalid: 119,
  BondDepositAboveCap: 123,
  BondSlippage: 124,
} as const;

export type WrapperErrorV22Name = keyof typeof WRAPPER_ERR_V22;

export const V22_NAME_BY_CODE: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(Object.entries(WRAPPER_ERR_V22).map(([k, v]) => [v, k])),
);

/** Stake program v5 error codes 33..=45 (percolator-stake src/error.rs), stable Rust names. */
export const STAKE_ERR_V5 = {
  ConsentRequired: 33,
  DeprecatedV5: 34,
  InsuranceUnitsInvalid: 35,
  LiquidityBufferExhausted: 36,
  SyncCooldownActive: 37,
  InvalidDeployConfig: 38,
  NotProtocolAuthority: 39,
  NoPendingDeployTarget: 40,
  NotSupportedOnFirstLoss: 41,
  AssetAdminNotBurned: 42,
  NothingToSync: 43,
  InsuranceReadingsDiverged: 44,
  InsuranceUnitsMismatch: 45,
} as const;

/** Codes the app treats as "the exit/trade can be retried automatically in the same action". */
export const V22_AUTO_RETRY_CODES: readonly number[] = [WRAPPER_ERR_V22.ExitRequiresLossCurrent];
/** Codes that mean "re-quote and show the new minimum". */
export const V22_REQUOTE_CODES: readonly number[] = [WRAPPER_ERR_V22.RedemptionBelowMinPayout, WRAPPER_ERR_V22.BondSlippage];
/** Codes that are the band lag: not an error, closing reopens by itself. */
export const V22_BAND_LAG_CODE = WRAPPER_ERR_V22.PriceBandPinned;

/** v2.2 codes that behave like engine locks (wait and retry): 104 band catching up, 118 exit refreshing. */
export const V22_ENGINE_LOCK_CODES: readonly number[] = [WRAPPER_ERR_V22.PriceBandPinned, WRAPPER_ERR_V22.ExitRequiresLossCurrent];
