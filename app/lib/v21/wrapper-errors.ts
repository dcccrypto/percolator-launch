/**
 * The Devnet v2.1 wrapper error codes, kept OUT of `WRAPPER_ERR` (lib/wrapper-errors.ts), which is
 * pinned name-for-name to the DEPLOYED wrapper's `PercolatorError` (wrapper-errors-parity.test.ts).
 * The v2.1 programs are approved, not deployed: the live wrapper never raises these, and the app
 * only interprets them when `NEXT_PUBLIC_DEVNET_V21` is on (lib/v21/flag.ts).
 *
 * Sources: growth-v19 92..=99 (percolator-prog #524 @ 9cc6d281), P2b Earn allocation 100..=103
 * (#526 @ d9e3e2d7, explicit discriminants), P2b lock exits 120..=122 (#525, explicit block).
 * Regenerate/replace with the generated table once the v2.1 wrapper ships.
 */
export const WRAPPER_ERR_V21 = {
  GrowthLeverageExceeded: 92,
  GrowthCapacityFull: 93,
  GrowthInvalidConfig: 94,
  GrowthNeedsLpCounterparty: 95,
  GrowthBatchTooManyLegs: 96,
  GrowthRequiresBoundVaultLp: 97,
  GrowthUtilisationFeeNotCovered: 98,
  GrowthUtilisationFeeRequiresTradeCpi: 99,
  VaultLpAllocateRefused: 100,
  VaultLpCapacityLocked: 101,
  VaultLpCreatorFeeVesting: 102,
  VaultLpSeniorCapitalHalt: 103,
  EngineAdlReduceOnly: 120,
  EngineLossStale: 121,
  EarnExitWouldUnderBackClaims: 122,
} as const;

export type WrapperErrorV21Name = keyof typeof WRAPPER_ERR_V21;

/** The three codes that split out of Custom(21): engine locks. */
export const V21_ENGINE_LOCK_CODES: readonly number[] = [
  WRAPPER_ERR_V21.EngineAdlReduceOnly,
  WRAPPER_ERR_V21.EngineLossStale,
  WRAPPER_ERR_V21.EarnExitWouldUnderBackClaims,
];
