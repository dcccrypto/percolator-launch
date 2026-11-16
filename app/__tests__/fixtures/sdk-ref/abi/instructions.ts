import { PublicKey } from "@solana/web3.js";
import {
  encU8,
  encU16,
  encU32,
  encU64,
  encI64,
  encU128,
  encI128,
  encPubkey,
  concatBytes,
} from "./encode.js";

/**
 * Instruction tags — exact match to Rust ix::Instruction::decode arm in the
 * v2.2 wrapper (percolator-prog @feat/v22-rc23-2026-10-22, source
 * src/v16_program.rs). Tags are gappy; every absent tag rejects with
 * InvalidInstructionData.
 *
 * v17 breaking changes vs v12.x:
 *   - Tags 37-73 are COMPLETELY different (toly renumbered 37-64, fork LP-vault
 *     moved 65-71→74-80, fork NFT-B3 kept 72/73, toly claimed 65-69).
 *   - Tag 32 UpdateAuthority: v17 has NO kind byte — just new_pubkey[32].
 *   - Tag 57 is now WithdrawInsuranceAsset{asset_index:u16, amount:u128}.
 *   - Tag 5 PermissionlessCrank: now_slot(u64) + n(u8) + n x {asset_index(u16),
 *     oracle_accounts(u8)}; n is capped at CRANK_OBSERVATION_DECODE_MAX.
 *   - Domain fields: u8→u16 everywhere.
 */
export const IX_TAG = {
  // ── Core (tags 0-13) — byte-identical to v17 ─────────────────────────────
  InitMarket: 0,
  InitPortfolio: 1,
  /** @alias InitUser @since v12.x alias, canonical name is InitPortfolio in v17 */
  InitUser: 1,
  /** @deprecated v17 has no LP role in the wrapper; matchers run as third-party programs. */
  InitLP: 2,
  Deposit: 3,
  /** @alias DepositCollateral @since v12.x alias */
  DepositCollateral: 3,
  Withdraw: 4,
  /** @alias WithdrawCollateral @since v12.x alias */
  WithdrawCollateral: 4,
  /**
   * PermissionlessCrank (tag 5).
   *
   * Wire: tag(1) + now_slot(u64) + n(u8) + n x {asset_index(u16),
   * oracle_accounts(u8)}. The decoder rejects n > CRANK_OBSERVATION_DECODE_MAX
   * with InvalidInstructionData. There is no funding_rate_e9 field in v2.2.
   * Use encodePermissionlessCrank().
   */
  PermissionlessCrank: 5,
  /** @alias KeeperCrank @since v12.x alias */
  KeeperCrank: 5,
  TradeNoCpi: 6,
  LiquidateAtOracle: 7,
  ClosePortfolio: 8,
  /** @alias CloseAccount @since v12.x alias */
  CloseAccount: 8,
  TopUpInsurance: 9,
  TradeCpi: 10,
  /** @deprecated tag 11 has no decode arm in v17 wrapper */
  SetRiskThreshold: 11,
  /** @deprecated tag 12 has no decode arm in v17 wrapper */
  UpdateAdmin: 12,
  CloseSlab: 13,
  ResolveMarket: 19,
  // ── Backing/insurance domain ops (24, 28, 30, 41, 50, 52, 53, 54, 56, 57) ──
  TopUpBackingBucket: 24,
  ConvertReleasedPnl: 28,
  CloseResolved: 30,
  /**
   * UpdateAuthority (tag 32) — v17 wire: tag(1) + new_pubkey[32].
   *
   * BREAKING vs v12.18.x: NO kind byte in v17. The kind byte was removed;
   * tag 32 now ONLY rotates the single marketauth key. Per-asset authority
   * rotation uses tag 65 (UpdateAssetAuthority).
   */
  UpdateAuthority: 32,
  ConfigureHybridOracle: 34,
  ConfigureEwmaMark: 35,
  PushEwmaMark: 36,
  UpdateLiquidationFeePolicy: 37,
  ConfigurePermissionlessResolve: 38,
  ResolveStalePermissionless: 39,
  UpdateAssetLifecycle: 40,
  WithdrawInsurance: 41,
  CureAndCancelClose: 42,
  ForfeitRecoveryLeg: 43,
  RebalanceReduce: 44,
  FinalizeResetSide: 45,
  ClaimResolvedPayoutTopup: 46,
  RefineResolvedUnreceiptedBound: 47,
  SyncMaintenanceFee: 48,
  UpdateMaintenanceFeePolicy: 49,
  WithdrawBackingBucket: 50,
  UpdateBackingFeePolicy: 51,
  WithdrawBackingBucketEarnings: 52,
  SyncBackingDomainLedger: 53,
  SyncInsuranceLedger: 54,
  UpdateTradeFeePolicy: 55,
  TopUpInsuranceDomain: 56,
  /**
   * WithdrawInsuranceAsset (tag 57) — v17 wire: tag(1) + asset_index(u16) + amount(u128).
   *
   * Replaces the v12.x gap at tag 57. Withdraws from a specific asset's
   * insurance fund. asset_index is u16 (domain u8→u16 migration).
   */
  WithdrawInsuranceAsset: 57,
  UpdateFeeRedirectPolicy: 58,
  UpdateMarketInitFeePolicy: 59,
  UpdateBaseUnitMints: 60,
  SwapSecondaryForPrimary: 61,
  ConfigureAuthMark: 62,
  PushAuthMark: 63,
  ForceCloseAbandonedAsset: 64,
  // ── v17 auth-overhaul toly tags (65-69) — FREE range in v12.x ────────────
  /**
   * UpdateAssetAuthority (tag 65) — per-asset authority rotation.
   *
   * Wire: tag(1) + asset_index(u16) + kind(u8) + new_pubkey[32] = 36 bytes.
   *
   * kind values (matches v16_program.rs ASSET_AUTH_* constants, lines 5246-5250):
   *   0 = ASSET_ADMIN       — asset_admin (burnable when asset_index != 0)
   *   1 = INSURANCE         — insurance_authority
   *   2 = INSURANCE_OPERATOR — insurance_operator
   *   3 = BACKING_BUCKET    — backing_bucket_authority
   *   4 = ORACLE            — oracle_authority
   *
   * NOTE: The stake program uses kind=0 (ASSET_AUTH_ADMIN) targeting asset_index=0.
   * See stake-program docs.
   */
  UpdateAssetAuthority: 65,
  /**
   * BatchTradeNoCpi (tag 66) — multi-leg NoCpi trade in one instruction.
   *
   * Wire: tag(1) + n_legs(u8) + [asset_index(u16)+size_q(i128)+exec_price(u64)+fee_bps(u64)]×n
   */
  BatchTradeNoCpi: 66,
  /**
   * BatchTradeCpi (tag 67) — multi-leg CPI trade in one instruction.
   *
   * Wire: tag(1) + n_legs(u8) + [asset_index(u16)+size_q(i128)+fee_bps(u64)+limit_price(u64)]×n
   */
  BatchTradeCpi: 67,
  /**
   * SetMatcherConfig (tag 68) — enable/disable the matcher for this portfolio.
   *
   * Wire: tag(1) + enabled(u8) = 2 bytes.
   */
  SetMatcherConfig: 68,
  /**
   * RestartAssetOracle (tag 69) — permissionless oracle restart after stale/stuck state.
   *
   * Wire: tag(1) + asset_index(u16) + now_slot(u64) + initial_price(u64) = 19 bytes.
   */
  RestartAssetOracle: 69,
  // ── Fork NFT / B-3 (tags 72/73) — kept from v16 ─────────────────────────
  /**
   * TransferPortfolioOwnership (tag 72) — B-3 position ownership transfer.
   *
   * Wire: tag(1) + new_owner[32] + asset_index(u16) = 35 bytes.
   */
  TransferPortfolioOwnership: 72,
  /**
   * SetNftProgramId (tag 73) — register the percolator-nft program in the NftRegistry.
   *
   * Wire: tag(1) + nft_program_id[32] = 33 bytes.
   */
  SetNftProgramId: 73,
  // ── Fork LP-vault (tags 74-80; moved from 65-71 to avoid toly collision) ──
  /**
   * CreateLpVault (tag 74).
   * Wire: tag(1) + fee_share_bps(u16) + redemption_cooldown_slots(u64) +
   *       oi_reservation_threshold_bps(u16) + domain(u16) = 15 bytes.
   */
  CreateLpVault: 74,
  /**
   * DepositToLpVault (tag 75).
   * Wire: tag(1) + amount(u128) + domain(u16) = 19 bytes.  // GH#381: was 17; `domain` was missing
   */
  DepositToLpVault: 75,
  /**
   * RequestRedeemLpShares (tag 76).
   * Wire: tag(1) + shares(u128) = 17 bytes.
   */
  RequestRedeemLpShares: 76,
  /**
   * ExecuteRedemption (tag 77).
   * Wire: tag(1) + domain(u16) = 3 bytes.  // GH#381: was 1 byte; `domain` was missing
   */
  ExecuteRedemption: 77,
  /**
   * LpVaultCrankFees (tag 78).
   * Wire: tag(1) + domain(u16) = 3 bytes.  // GH#381: was 1 byte; `domain` was missing
   */
  LpVaultCrankFees: 78,
  /**
   * SetLpVaultPaused (tag 79).
   * Wire: tag(1) + paused(u8) = 2 bytes.
   */
  SetLpVaultPaused: 79,
  /**
   * CloseLpVault (tag 80).
   * Wire: tag(1) = 1 byte.
   */
  CloseLpVault: 80,
  /**
   * CancelRedemption (tag 81) — withdraw a pending LP redemption request before it
   * is executed, returning the shares to the holder.
   * Wire: tag(1) = 1 byte.
   *
   * GH#375: this and UnwrapEscrowedPortfolio(82) were the only two v17 wrapper
   * instructions with NO entry here. Tags 81 and 82 were represented solely by the
   * deprecated v12 names below, both annotated "Not in v17" — which is false. The
   * Parity Gate exists to catch exactly this and could not: its percolator-prog
   * target had never once run.
   */
  CancelRedemption: 81,
  /**
   * UnwrapEscrowedPortfolio (tag 82) — burn a Position NFT and return the escrowed
   * portfolio to `new_owner`.
   * Wire: tag(1) + new_owner(32) = 33 bytes.
   */
  UnwrapEscrowedPortfolio: 82,
  // ── Legacy aliases retained for source-compat (do NOT assign new tags) ────
  /** @deprecated v12.x alias. Use DepositToLpVault(75) in v17. */
  LpVaultDeposit: 75,
  /** @deprecated v12.x alias. Use RequestRedeemLpShares(76) in v17 — NOTE: wire format changed. */
  LpVaultWithdraw: 76,
  // ── v12.x-only tags — NOT in v17 decoder. Encoders that use these throw removedInstruction(). ──
  /** @deprecated v12.x tag 14. Removed in v17. */
  UpdateConfig: 14,
  /** @deprecated v12.x tag 15. Removed in v17. */
  SetMaintenanceFee: 15,
  /** @deprecated v12.x tag 16. Removed in v17. */
  SetOraclePriceCap: 16,
  /** @deprecated v12.x tag 17. Removed in v17. */
  AdminForceClose: 17,
  /** @deprecated v12.x tag 18. Removed in v17. */
  UpdateRiskParams: 18,
  /** @deprecated v12.x tag 20. Removed in v17. */
  SetPythOracle: 20,
  /** @deprecated v12.x tag 21. Removed in v17. */
  RenounceAdmin: 21,
  /** @deprecated v12.x tag 22. Removed in v17. */
  SetInsuranceWithdrawPolicy: 22,
  /** @deprecated v12.x tag 23. Removed in v17 — v17 uses WithdrawInsuranceLimited=23 from toly. */
  WithdrawInsuranceLimited: 23,
  /** @deprecated v12.x tag 25. Removed in v17. */
  FundMarketInsurance: 25,
  /** @deprecated v12.x tag 26. Removed in v17. */
  SetInsuranceIsolation: 26,
  /** @deprecated v12.x tag 27. Removed in v17. */
  DepositFeeCredits: 27,
  /** @deprecated v12.x tag 29. Removed in v17 — v17 uses ResolveStalePermissionless=39. */
  ResolvePermissionless: 29,
  /** @deprecated v12.x tag 30. Removed in v17 — v17 reuses 30 for CloseResolved (different wire). */
  ForceCloseResolved: 30,
  /** @deprecated v12.x tag 33. Removed in v17. */
  UpdateInsurancePolicy: 33,
  /** @deprecated v12.x tag 36. Removed in v12.17. */
  UnresolveMarket: 36,
  /** @deprecated v12.x tag 43. Removed in v17 — v17 uses 43 for ChallengeSettlement (different wire). */
  ChallengeSettlement: 43,
  /** @deprecated v12.x tag 44. Removed in v17 — v17 uses 44 for RebalanceReduce (different wire). */
  ResolveDispute: 44,
  /** @deprecated v12.x tag 45. Removed in v17 — v17 uses 45 for FinalizeResetSide. */
  DepositLpCollateral: 45,
  /** @deprecated v12.x tag 46. Removed in v17 — v17 uses 46 for ClaimResolvedPayoutTopup. */
  WithdrawLpCollateral: 46,
  /** @deprecated v12.x tag 54. Removed in v17 — v17 uses 54 for SyncInsuranceLedger. */
  SetOffsetPair: 54,
  /** @deprecated v12.x tag 55. Removed in v17 — v17 uses 55 for UpdateTradeFeePolicy. */
  AttestCrossMargin: 55,
  /** @deprecated v12.x tag 56. Removed in v17 — v17 uses 56 for TopUpInsuranceDomain. */
  PauseMarket: 56,
  /** @deprecated v12.x tag 58. Removed in v17 — v17 uses 58 for UpdateFeeRedirectPolicy. */
  UnpauseMarket: 58,
  /** @deprecated v12.x tag 64. Removed in v17 — v17 uses 64 for ForceCloseAbandonedAsset. */
  MintPositionNft: 64,
  /** @deprecated v12.x tag 65. COLLIDES with v17 UpdateAssetAuthority(65). Do NOT use. */
  TransferPositionOwnership: 65,
  /** @deprecated v12.x tag 66. COLLIDES with v17 BatchTradeNoCpi(66). Do NOT use. */
  BurnPositionNft: 66,
  /** @deprecated v12.x tag 67. COLLIDES with v17 BatchTradeCpi(67). Do NOT use. */
  SetPendingSettlement: 67,
  /** @deprecated v12.x tag 68. COLLIDES with v17 SetMatcherConfig(68). Do NOT use. */
  ClearPendingSettlement: 68,
  /** @deprecated v12.x tag 69. COLLIDES with v17 RestartAssetOracle(69). Do NOT use. */
  TransferOwnershipCpi: 69,
  /** @deprecated v12.x tag 70. Not in v17. */
  SetWalletCap: 70,
  /** @deprecated v12.x tag 71. Not in v17. */
  SetOiImbalanceHardBlock: 71,
  /** @deprecated v12.x tag 72. COLLIDES with v17 TransferPortfolioOwnership(72). Do NOT use. */
  RescueOrphanVault: 72,
  /** @deprecated v12.x tag 73. COLLIDES with v17 SetNftProgramId(73). Do NOT use. */
  CloseOrphanSlab: 73,
  /** @deprecated v12.x tag 74. COLLIDES with v17 CreateLpVault(74). Do NOT use. */
  SetDexPool: 74,
  /** @deprecated v12.x tag 75. COLLIDES with v17 DepositToLpVault(75) AND v17 InitMatcherCtx(83). Do NOT use. */
  InitMatcherCtxV12: 75,
  /** @deprecated v12.x tag 78. COLLIDES with v17 LpVaultCrankFees(78). Do NOT use. */
  SetMaxPnlCap: 78,
  /** @deprecated v12.x tag 79. COLLIDES with v17 SetLpVaultPaused(79). Do NOT use. */
  SetOiCapMultiplier: 79,
  /** @deprecated v12.x tag 80. COLLIDES with v17 CloseLpVault(80). Do NOT use. */
  SetDisputeParams: 80,
  /** @deprecated v12.x tag 81. COLLIDES with v17 CancelRedemption(81). Do NOT use. */
  SetLpCollateralParams: 81,
  /** @deprecated v12.x tag 82. COLLIDES with v17 UnwrapEscrowedPortfolio(82). Do NOT use. */
  AcceptAdmin: 82,
  /**
   * InitMatcherCtx (tag 83) — bootstrap a matcher context by CPIing to the matcher program.
   *
   * v17 wire: tag(1) + kind(u8) + trading_fee_bps(u32) + base_spread_bps(u32) +
   *   max_total_bps(u32) + impact_k_bps(u32) + liquidity_notional_e6(u128) +
   *   max_fill_abs(u128) + max_inventory_abs(u128) + fee_to_insurance_bps(u16) +
   *   skew_spread_mult_bps(u16) = 70 bytes total.
   *
   * The wrapper's handle_init_matcher_ctx signs the CPI as the matcher_delegate PDA
   * (via invoke_signed), satisfying the matcher program's lp_pda.is_signer check.
   *
   * PREREQUISITE: SetMatcherConfig (tag 68, enabled=1) must be called first to store
   * (matcherProg, matcherCtx, matcherDelegate) in the LP portfolio's matcher config tail.
   * InitMatcherCtx verifies the stored triple matches the accounts supplied here.
   *
   * CONFIRMED (forensic rebuild + live simulateTransaction, 2026-07-15, see
   * ~/v17/DECISIONS-LEDGER.md "Pinned deployed revisions" section): the DEPLOYED
   * wrapper (69VUZ7… = percolator-prog@e26c97a4) HAS InitMatcherCtx at tag 83 — this
   * is a real, live instruction, not a defunct/other-lineage one. The protocol-fee
   * change was renumbered (WithdrawProtocolFee→84, SetProtocolFeeAuthority→85) to
   * free tag 83 for this instruction rather than the reverse.
   */
  InitMatcherCtx: 83,
  /**
   * WithdrawProtocolFee (tag 84) — v17 protocol-fee wrapper (VERSION 17,
   * percolator-prog@626fb617, feat/protocol-fee-taker-only).
   *
   * Renumbered 83→84 (2026-07-15) to free tag 83 for InitMatcherCtx, which the
   * deployed wrapper (percolator-prog@e26c97a4) has live at tag 83 — see the
   * note on IX_TAG.InitMatcherCtx above and ~/v17/DECISIONS-LEDGER.md.
   *
   * Wire: tag(1) + amount(u128) = 17 bytes. `amount == 0` withdraws all
   * currently-available capacity. Accounts: see ACCOUNTS_WITHDRAW_PROTOCOL_FEE
   * in abi/accounts.ts. Signer-gated on cfg.protocol_fee_authority.
   */
  WithdrawProtocolFee: 84,
  /**
   * SetProtocolFeeAuthority (tag 85) — v17 protocol-fee wrapper (VERSION 17,
   * percolator-prog@626fb617, feat/protocol-fee-taker-only). Rotates
   * cfg.protocol_fee_authority.
   *
   * Renumbered 84→85 (2026-07-15) as part of the same InitMatcherCtx(83) tag
   * reservation — see the note on IX_TAG.InitMatcherCtx above and
   * ~/v17/DECISIONS-LEDGER.md. Also frees this value from colliding with the
   * deprecated v12.x ReclaimEmptyAccount(85) below, which is not present in v17.
   *
   * Wire: tag(1) + new_authority(32) = 33 bytes. Accounts: see
   * ACCOUNTS_SET_PROTOCOL_FEE_AUTHORITY in abi/accounts.ts. Gated on the
   * program's BPF upgrade authority — NOT marketauth, NOT any creator-facing gate.
   */
  SetProtocolFeeAuthority: 85,
  /**
   * UpdateFeeSplit (tag 86) — v17 fee-collection split (percolator-prog
   * feat/protocol-fee-taker-only@2b3a6a65). Sets the three stored fee shares.
   *
   * Wire: tag(1) + creator_share_bps(u16) + lp_share_bps(u16) +
   * insurance_share_bps(u16) = 7 bytes. Accounts: see ACCOUNTS_UPDATE_FEE_SPLIT
   * in abi/accounts.ts. Gated on `cfg.marketauth`.
   *
   * The three shares are bps *of T* (`trade_fee_base_bps`) and must sum to
   * exactly FEE_SHARE_TOTAL_BPS (8000 = 10_000 - PROTOCOL_FEE_BPS), else
   * Custom(52) FeeSplitSumInvalid. They must also satisfy the floors
   * (creator <= 3600, LP >= 3200, insurance >= 1200), else Custom(51)
   * FeeSplitFloorViolation.
   *
   * REACHABILITY: `StakeInitPool` irreversibly rotates `cfg.marketauth` to the
   * stake-pool PDA, after which this tag is reachable ONLY via the stake
   * program's CPI proxy (stake tag 25). Call it before StakeInitPool or use
   * `encodeStakeAdminUpdateFeeSplit`.
   */
  UpdateFeeSplit: 86,
  /**
   * WithdrawInsuranceReserveToStake (tag 87) — v17 fee-collection split.
   * Permissionless. Pushes the accrued insurance/staker leg out of the market
   * vault and into the bound stake pool's vault, where percolator-stake's
   * AccrueFees measures it as surplus and distributes it to stakers.
   *
   * Wire: tag(1) = 1 byte, no arguments. Accounts: see
   * ACCOUNTS_WITHDRAW_INSURANCE_RESERVE_TO_STAKE in abi/accounts.ts.
   *
   * The destination is NOT caller-chosen: it is `pool.vault`, read out of the
   * pool at `["stake_pool", market]` under the wrapper's PINNED stake program
   * id. The only thing a caller decides is *when* the push happens.
   *
   * ⚠ Live-only (mode 0), and stricter than tag 84: rejects Recovery, Resolved
   * and matured-Live. ResolveMarket is one-way and tag 41 cannot reach this
   * unbudgeted leg, so any accrued-but-unpushed reserve is PERMANENTLY
   * FORFEITED once a market resolves. Keepers should crank tag 87 *before*
   * ResolveMarket, not after.
   */
  WithdrawInsuranceReserveToStake: 87,
  /**
   * UpdateMaintenanceFeePerSlot (tag 88) — v17 fee-collection split. Sets
   * `cfg.maintenance_fee_per_slot`, which was an InitMarket constructor
   * argument with no setter anywhere in the dispatch table and was therefore
   * frozen for the life of the market.
   *
   * Wire: tag(1) + maintenance_fee_per_slot(u128) = 17 bytes. Accounts: see
   * ACCOUNTS_UPDATE_MAINTENANCE_FEE_PER_SLOT. Gated on `cfg.marketauth`.
   *
   * ⚠ THE PAYLOAD IS u128, NOT u64. The wrapper decodes this with `read_u128`
   * (v16_program.rs tag-88 arm), matching both the storage type
   * (`WrapperConfigV16::maintenance_fee_per_slot: u128`) and InitMarket's own
   * wire encoding. A u64 payload leaves 8 bytes unconsumed and the wrapper
   * rejects the whole instruction with InvalidInstructionData.
   *
   * Same StakeInitPool reachability caveat as tag 86 — proxy is stake tag 26.
   */
  UpdateMaintenanceFeePerSlot: 88,
  /**
   * ExpireBackingBucket (tag 89) — PERMISSIONLESS backing-bucket liveness
   * repair. Advances a `Fresh`-but-LAPSED source-domain counterparty backing
   * bucket to `Expired`/`Impaired` so settlement against that domain can
   * proceed again.
   *
   * Wire: tag(1) + domain(u16 LE) = 3 bytes. Accounts: see
   * ACCOUNTS_EXPIRE_BACKING_BUCKET — ONE account, the market, and NO signer.
   *
   * ⚠ ROUTINE KEEPER MAINTENANCE, NOT AN EDGE CASE. Every backed market
   * reaches the lapse eventually: the bucket's `expiry_slot` is fixed when the
   * bucket opens and is NEVER extended while it stays `Fresh`, so a longer
   * horizon defers the lapse, it does not avoid it. See
   * {@link encodeExpireBackingBucket} for the full keeper contract.
   */
  ExpireBackingBucket: 89,
  /**
   * WithdrawCreatorFee (tag 90) — v17 creator fee claim (percolator-prog
   * feat/protocol-fee-taker-only, 2026-07-23 creator-fee-claim design §3).
   * Pays the market creator's accrued trade-fee share out of the vault and
   * decrements `creator_fee_claimable_atoms` (WrapperConfigV17, byte 568) by
   * EXACTLY `amount`.
   *
   * Wire: tag(1) + amount(u128 LE) = 17 bytes. Accounts: see
   * ACCOUNTS_WITHDRAW_CREATOR_FEE in abi/accounts.ts (same 6-account shape as
   * tag 84).
   *
   * ⚠ `amount == 0` is REJECTED (InvalidInstruction), which is the OPPOSITE of
   * tag 84's "0 means withdraw-all" sentinel. This instruction is an exact
   * debit of the counter, so read `creatorFeeClaimableAtoms` off the parsed
   * config and pass that to drain it.
   *
   * ⚠ Authority is asset 0's `insurance_operator` and ONLY that — NOT
   * `cfg.marketauth`. On a staked market `StakeInitPool` has irreversibly
   * rotated `marketauth` to the stake-pool PDA but leaves `insurance_operator`
   * alone, so this deliberate divergence is what lets the creator still claim
   * after staking (and stops the pool PDA claiming creator revenue).
   *
   * ⚠ Over-claim (`amount > creatorFeeClaimableAtoms`) is rejected, never
   * saturated — there is no partial fill. Nothing is debited on failure.
   */
  WithdrawCreatorFee: 90,
  /**
   * RebalanceLpVaultBacking (v17 tag 91) — move IDLE (fresh, unliened) backing
   * between the two domains of the LP vault's asset, carrying ledger principal
   * in lockstep. No tokens move: `header.vault` is untouched.
   *
   * The vault is welded to ONE domain at CreateLpVault, but the house draws its
   * gains from the OPPOSITE domain, so without this the pot the house actually
   * needs can never be refilled (spec.md L410 requires refill be source-domain
   * local).
   */
  RebalanceLpVaultBacking: 91,
  /**
   * UpdateInsuranceWithdrawPolicy (tag 92) — sets the insurance-withdrawal rate limit
   * (percolator-prog#427). Deployed devnet 2026-09-01 in wrapper `cc193dde`.
   *
   * Before this instruction existed, `insurance_withdraw_deposits_only` and
   * `insurance_withdraw_cooldown_slots` were written in exactly one place each — `: 0,` in
   * the market's init literal — and both enforcement helpers short-circuit on zero, so the
   * F-1 cooldown and F-2 deposits-only ceiling could not fire in any market ever created.
   *
   * NOTE the deprecated v12.x `AdvanceOraclePhase(92)` below shares this number, the same
   * way v17 `SetProtocolFeeAuthority(85)` and `WithdrawCreatorFee(90)` do. The v12 tag is
   * not in v17; this is the live meaning of 92.
   */
  UpdateInsuranceWithdrawPolicy: 92,
  /** @deprecated v12.x tag 85. COLLIDES with v17 SetProtocolFeeAuthority(85). Do NOT use. */
  ReclaimEmptyAccount: 85,
  /** @deprecated v12.x tag 86. Not in v17. */
  SettleAccount: 86,
  /** @deprecated v12.x tag 90. COLLIDES with v17 WithdrawCreatorFee(90). Do NOT use. */
  UpdateMarkPrice: 90,
  /** @deprecated v12.x tag 91. COLLIDES with v17 RebalanceLpVaultBacking(91). Do NOT use. */
  AuditCrank: 91,
  /** @deprecated v12.x tag 92. Not in v17. */
  AdvanceOraclePhase: 92,
  /** @deprecated v12.x tag 93. Not in v17. COLLIDES with P1 SetAssetRiskLimits(93). Do NOT use. */
  SlashCreationDeposit: 93,
  /** @deprecated v12.x tag 94. Not in v17. COLLIDES with P3 InitVaultLp(94) — see IX_TAG_P3. Do NOT use. */
  InitSharedVault: 94,
  /** @deprecated v12.x tag 95. Not in v17. COLLIDES with P3 VaultLpSetMatcher(95) — see IX_TAG_P3. Do NOT use. */
  AllocateMarket: 95,
  /** @deprecated v12.x tag 96. Not in v17. COLLIDES with P3 DepositJuniorTranche(96) — see IX_TAG_P3. Do NOT use. */
  QueueWithdrawalSV: 96,
  /** @deprecated v12.x tag 97. Not in v17. COLLIDES with P3 WithdrawJuniorTranche(97) — see IX_TAG_P3. Do NOT use. */
  ClaimEpochWithdrawal: 97,
  /** @deprecated v12.x tag 98. Not in v17. COLLIDES with P3 VaultLpRecall(98) — see IX_TAG_P3. Do NOT use. */
  AdvanceEpoch: 98,
  /** @deprecated v12.x tag 99. Not in v17. COLLIDES with P3 SetVaultLpRisk(99) — see IX_TAG_P3. Do NOT use. */
  ReclaimSlabRent: 99,
  /** @deprecated v12.x tag 100. Not in v17. COLLIDES with P3 VaultLpConvertPnl(100) — see IX_TAG_P3. Do NOT use. */
  CloseStaleSlabs: 100,
  /** @deprecated v12.x tag 101. Not in v17. COLLIDES with P3 VaultLpSettleResolved(101) — see IX_TAG_P3. Do NOT use. */
  ExecuteAdl: 101,
  /** @deprecated v12.x tag 102. Not in v17. COLLIDES with P3 VaultLpReleaseSurplus(102) — see IX_TAG_P3. Do NOT use. */
  QueueWithdrawal: 102,
  /** @deprecated v12.x tag 103. Not in v17. */
  ClaimQueuedWithdrawal: 103,
  /** @deprecated v12.x tag 104. Not in v17. */
  CancelQueuedWithdrawal: 104,
  /** @deprecated v12.x tag 105. Not in v17. */
  TradeCpiV: 105,
} as const;
Object.freeze(IX_TAG);

/**
 * v18 slab version discriminator. Stored as u16 LE at byte offset 8 of every
 * percolator-owned account (market-group, portfolio, insurance-ledger, etc.).
 *
 * Bumped 17 -> 18 by the v16-migration integration (percolator-prog
 * `sync/integration-v16`@a9318945, `v16_program.rs:72` `pub const VERSION: u16
 * = 18`): the identity-binding overhaul (market_id/intent_id/authority_epoch
 * CAS binding across ~41 instruction tags), the PortfolioAccountV16 +24B
 * identity trailer (9539 -> 9563), and the AssetOracleProfileV16/
 * AssetControlSequencesV16 per-asset slot growth (512 -> 1024) are all
 * account-layout/wire-breaking, so VERSION fails closed on any pre-migration
 * (VERSION=17) account — those must be re-seeded (F-01), not read with this
 * parser.
 *
 * The v18 MAGIC is unchanged: 0x5045_5243_5631_3600n ("PERCV16\0" as u64 LE).
 * When reading an account header, verify both MAGIC at [0..8] and VERSION at
 * [8..10].
 */
export const EXPECTED_SLAB_VERSION = 18;

/**
 * v17 account header magic — "PERCV16\0" stored as little-endian u64.
 * bytes[0..8] = [0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]
 */
export const V17_SLAB_MAGIC = 0x5045_5243_5631_3600n;

function removedInstruction(name: string, tag: number, replacement?: string): never {
  const suffix = replacement ? ` Use ${replacement} instead.` : "";
  throw new Error(
    `${name} (tag ${tag}) is not accepted by the deployed wrapper program.${suffix}`,
  );
}

/**
 * InitMarket instruction data — v17 wire format.
 *
 * v17 wire: tag(1) + market_params(218 bytes) = 219 bytes total.
 *
 * BREAKING vs v12.x: admin, collateralMint, feedId, staleness, conf, invert,
 * and unitScale are NO LONGER encoded in instruction data. In v17 these are
 * provided as account metas or configured separately via ConfigureHybridOracle /
 * ConfigureEwmaMark. The v17 decoder reads only the market risk parameters.
 *
 * The old v12.x encodeInitMarket with admin[32]+mint[32]+feedId[32]+... inline
 * is completely rejected by the v17 program — the first field read is now
 * max_portfolio_assets(u16), which would parse the first 2 bytes of admin as
 * a u16 portfolio count, producing invalid config or rejection at every call.
 *
 * Use `InitMarketArgs` (v12 legacy, now deprecated) or the new
 * `InitMarketV17Args` with encodeInitMarket(). The v12-era fields that are
 * absent from v17 (feedId, staleness, conf, invert, unitScale, maxMaintFee,
 * warmupPeriodSlots) are silently ignored when present in InitMarketV17Args.
 */
/**
 * Optional 66-byte extended tail for InitMarket (S-4).
 *
 * When present and any field is non-zero the encoder appends a 66-byte block
 * in the exact order that the program reads it (percolator.rs:1516-1545):
 *   insurance_withdraw_max_bps          u16  (2 bytes)
 *   insurance_withdraw_cooldown_slots   u64  (8 bytes)
 *   permissionless_resolve_stale_slots  u64  (8 bytes)
 *   funding_horizon_slots               u64  (8 bytes)
 *   funding_k_bps                       u64  (8 bytes)
 *   funding_max_premium_bps             i64  (8 bytes)
 *   funding_max_bps_per_slot            i64  (8 bytes)
 *   mark_min_fee                        u64  (8 bytes)
 *   force_close_delay_slots             u64  (8 bytes)
 *   total = 2 + 8*8 = 66 bytes
 *
 * When absent (or all fields are zero) the encoder omits the tail and the
 * program treats all extended fields as their default zero values. This
 * preserves full backward compatibility with existing 344-byte payloads.
 */
export interface InitMarketExtendedTail {
  /** Maximum percentage of insurance fund withdrawable per cooldown window (0–10 000 bps). */
  insuranceWithdrawMaxBps: number;
  /** Slots that must elapse between insurance withdrawals. Required when insuranceWithdrawMaxBps > 0. */
  insuranceWithdrawCooldownSlots: bigint | string;
  /** Slots after which an unresolved market may be permissionlessly resolved. */
  permissionlessResolveStaleSlots: bigint | string;
  /** Funding rate horizon in slots (custom_funding_k denominator). */
  fundingHorizonSlots: bigint | string;
  /** Funding rate K parameter in bps (0 = disabled). */
  fundingKBps: bigint | string;
  /** Maximum funding premium in bps (i64 — may be negative to flip direction). */
  fundingMaxPremiumBps: bigint | string;
  /** Maximum funding rate change per slot in bps (i64). */
  fundingMaxBpsPerSlot: bigint | string;
  /** Minimum fee charged per mark-price update (u64, in collateral base units). */
  markMinFee: bigint | string;
  /** Slots to delay forced close after trigger condition is met (0 = immediate). */
  forceCloseDelaySlots: bigint | string;
  /**
   * Wave 9 (v2 tail): per-market `max_price_move_bps_per_slot` override.
   *
   * When omitted (or `undefined`), the encoder emits a 66-byte v1 tail and
   * the wrapper applies its deployment default
   * (`DEFAULT_MAX_PRICE_MOVE_BPS_PER_SLOT = 4`). When provided, the encoder
   * emits a 74-byte v2 tail with this value appended after
   * `forceCloseDelaySlots`. The wrapper rejects a zero v2 value with
   * `InvalidConfigParam`; the engine then re-validates the solvency
   * envelope at `init_in_place`.
   *
   * @since SDK 2.2.0 (Wave 9 InitMarket v2 wire-format)
   */
  maxPriceMoveBpsPerSlot?: bigint | string;
}

export interface InitMarketArgs {
  admin: PublicKey | string;
  collateralMint: PublicKey | string;
  indexFeedId: string;           // Pyth feed ID (hex string, 64 chars without 0x prefix). All zeros = Hyperp mode.
  maxStalenessSecs: bigint | string;
  confFilterBps: number;
  invert: number;
  unitScale: number;
  initialMarkPriceE6: bigint | string;
  // Fields between header and RiskParams (immutable after init, default 0 if omitted)
  maxMaintenanceFeePerSlot?: bigint | string;  // u128 — max maintenance fee per slot
  /** @deprecated v12.17-only field. v12.19 wrapper does not read it. Kept for source-compat, value ignored. */
  maxInsuranceFloor?: bigint | string;
  /** @deprecated v12.17-only field. v12.19 wrapper does not read it. Kept for source-compat, value ignored. */
  minOraclePriceCap?: bigint | string;
  // RiskParams block (16 fields, read by read_risk_params on-chain)
  /**
   * @deprecated Use hMin and hMax instead (v12.15+). Accepted as fallback for both hMin and hMax
   * when hMin/hMax are not provided.
   */
  warmupPeriodSlots?: bigint | string;
  /** Minimum horizon slots (v12.15+). Falls back to warmupPeriodSlots if not provided. */
  hMin?: bigint | string;
  /** Maximum horizon slots (v12.15+). Falls back to warmupPeriodSlots if not provided. */
  hMax?: bigint | string;
  maintenanceMarginBps: bigint | string;
  initialMarginBps: bigint | string;
  tradingFeeBps: bigint | string;
  maxAccounts: bigint | string;
  newAccountFee: bigint | string;
  insuranceFloor?: bigint | string;           // u128 — wire slot: old riskReductionThreshold → insurance_floor
  maintenanceFeePerSlot: bigint | string;
  maxCrankStalenessSlots: bigint | string;
  liquidationFeeBps: bigint | string;
  liquidationFeeCap: bigint | string;
  liquidationBufferBps?: bigint | string;     // u64 — wire compat: read and discarded by program
  minLiquidationAbs: bigint | string;
  /** @deprecated v12.17-only top-level field. v12.19 wrapper does not read a separate min_initial_deposit. Kept for source-compat, value ignored. */
  minInitialDeposit?: bigint | string;
  minNonzeroMmReq: bigint | string;           // u128 — must be > 0, < minNonzeroImReq
  minNonzeroImReq: bigint | string;           // u128 — must be > minNonzeroMmReq, <= minInitialDeposit
  /**
   * Optional 66-byte extended tail (S-4).
   * When present and any field is non-zero, appended after the 344-byte base payload.
   * When absent (or all zeros), the base 344-byte payload is sent and the program
   * uses default zero values for all extended fields.
   * @see InitMarketExtendedTail
   */
  extendedTail?: InitMarketExtendedTail;
}

/**
 * Encode a Pyth feed ID (hex string) to 32-byte Uint8Array.
 *
 * @deprecated feedId is no longer encoded in InitMarket instruction data in v17.
 * Oracle configuration is set separately via ConfigureHybridOracle (tag 34).
 * Retained as a utility for off-chain feed ID validation.
 */
export const HEX_RE = /^[0-9a-fA-F]{64}$/;

export function encodeFeedId(feedId: string): Uint8Array {
  const hex = feedId.startsWith("0x") ? feedId.slice(2) : feedId;
  if (!HEX_RE.test(hex)) {
    throw new Error(
      `Invalid feed ID: expected 64 hex chars, got "${hex.length === 64 ? "non-hex characters" : hex.length + " chars"}"`,
    );
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 64; i += 2) {
    const byte = parseInt(hex.substring(i, i + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(
        `Failed to parse hex byte at position ${i}: "${hex.substring(i, i + 2)}"`,
      );
    }
    bytes[i / 2] = byte;
  }
  return bytes;
}

/**
 * Default value for `publicBChunkAtoms` matching the engine's `MAX_VAULT_TVL`
 * (10_000_000_000_000_000 — effectively unlimited).
 *
 * WARNING: Using a small value (e.g. 1_000_000) stalls deep liquidations.
 * When a bankrupt position's liability exceeds `public_b_chunk_atoms`, the
 * engine returns `RecoveryRequired` and refuses further liquidation until
 * the insurance fund covers the residual. Production markets MUST use this
 * constant (or the engine's own `MAX_VAULT_TVL`) unless a deliberate chunk
 * limit is intended AND the insurance fund is sized accordingly.
 *
 * @example
 * ```ts
 * import { PUBLIC_B_CHUNK_ATOMS_UNLIMITED, encodeInitMarket } from "@percolator/sdk";
 * const data = encodeInitMarket({
 *   ...otherParams,
 *   publicBChunkAtoms: PUBLIC_B_CHUNK_ATOMS_UNLIMITED,
 *   maintenanceFeePerSlot: 0n,
 * });
 * ```
 */
export const PUBLIC_B_CHUNK_ATOMS_UNLIMITED = 10_000_000_000_000_000n;

// v17 wire layout (v16_program.rs decode arm at tag 0):
//   tag(1) +
//   max_portfolio_assets(u16=2) +
//   h_min(u64=8) + h_max(u64=8) + initial_price(u64=8) +
//   min_nonzero_mm_req(u128=16) + min_nonzero_im_req(u128=16) +
//   maintenance_margin_bps(u64=8) + initial_margin_bps(u64=8) +
//   max_trading_fee_bps(u64=8) + trade_fee_base_bps(u64=8) +
//   liquidation_fee_bps(u64=8) +
//   liquidation_fee_cap(u128=16) + min_liquidation_abs(u128=16) +
//   max_price_move_bps_per_slot(u64=8) + max_accrual_dt_slots(u64=8) +
//   max_abs_funding_e9_per_slot(u64=8) + min_funding_lifetime_slots(u64=8) +
//   max_account_b_settlement_chunks(u64=8) + max_bankrupt_close_chunks(u64=8) +
//   max_bankrupt_close_lifetime_slots(u64=8) +
//   public_b_chunk_atoms(u128=16) + maintenance_fee_per_slot(u128=16)
// Sizes: u16(2) + u64×15(120) + u128×6(96) = 218 bytes payload + 1 byte tag = 219 total
const INIT_MARKET_V17_LEN = 219;

// Note: v12.x extended-tail constants and encodeExtendedTail helper have been
// removed in v17. The v17 encodeInitMarket encodes a fixed 227-byte payload
// with no optional tail — all parameters are required fields in the main body.

/**
 * InitMarket v17 argument interface.
 *
 * admin and collateralMint are passed as account metas (accounts[0] and
 * accounts[2] respectively), NOT in instruction data.
 *
 * Oracle configuration (feedId, staleness, confFilter, invert, unitScale) is
 * set separately via ConfigureHybridOracle (tag 34) or ConfigureEwmaMark (tag 35)
 * after the market is created.
 *
 * Field order in wire format matches v16_program.rs InitMarket decoder exactly:
 *   max_portfolio_assets, h_min, h_max, initial_price,
 *   min_nonzero_mm_req, min_nonzero_im_req,
 *   maintenance_margin_bps, initial_margin_bps,
 *   max_trading_fee_bps, trade_fee_base_bps,
 *   liquidation_fee_bps, liquidation_fee_cap, min_liquidation_abs,
 *   max_price_move_bps_per_slot, max_accrual_dt_slots,
 *   max_abs_funding_e9_per_slot, min_funding_lifetime_slots,
 *   max_account_b_settlement_chunks, max_bankrupt_close_chunks,
 *   max_bankrupt_close_lifetime_slots,
 *   public_b_chunk_atoms, maintenance_fee_per_slot.
 */
export interface InitMarketV17Args {
  /** Max number of portfolios (u16). Must be > 0 and <= WRAPPER_MAX_PORTFOLIO_ASSETS. */
  maxPortfolioAssets: number;
  /** Minimum funding horizon in slots (u64). */
  hMin: bigint | string;
  /** Maximum funding horizon in slots (u64). */
  hMax: bigint | string;
  /** Initial mark price in e6 units (u64). Must be > 0 and <= MAX_ORACLE_PRICE. */
  initialPrice: bigint | string;
  /** Minimum non-zero maintenance margin requirement (u128). */
  minNonzeroMmReq: bigint | string;
  /** Minimum non-zero initial margin requirement (u128). */
  minNonzeroImReq: bigint | string;
  /** Maintenance margin ratio in bps (u64). */
  maintenanceMarginBps: bigint | string;
  /** Initial margin ratio in bps (u64). */
  initialMarginBps: bigint | string;
  /** Maximum trading fee in bps (u64). Must be >= trade_fee_base_bps. */
  maxTradingFeeBps: bigint | string;
  /** Base trade fee in bps (u64). Must be <= max_trading_fee_bps. */
  tradeFeeBaseBps: bigint | string;
  /** Liquidation fee in bps (u64). */
  liquidationFeeBps: bigint | string;
  /** Liquidation fee cap in absolute units (u128). */
  liquidationFeeCap: bigint | string;
  /** Minimum liquidation size in absolute units (u128). */
  minLiquidationAbs: bigint | string;
  /** Maximum price movement per slot in bps (u64). */
  maxPriceMoveBpsPerSlot: bigint | string;
  /** Maximum accrual delta-time in slots (u64). */
  maxAccrualDtSlots: bigint | string;
  /** Maximum absolute funding rate in e9 per slot (u64). */
  maxAbsFundingE9PerSlot: bigint | string;
  /** Minimum funding lifetime in slots (u64). */
  minFundingLifetimeSlots: bigint | string;
  /** Maximum account-B settlement chunks per crank (u64). */
  maxAccountBSettlementChunks: bigint | string;
  /** Maximum bankrupt-close chunks per crank (u64). */
  maxBankruptCloseChunks: bigint | string;
  /** Maximum bankrupt-close lifetime in slots (u64). */
  maxBankruptCloseLifetimeSlots: bigint | string;
  /**
   * Public-B chunk size in atoms (u128).
   *
   * WARNING: A small value (e.g. 1_000_000) can stall deep liquidations —
   * the engine returns `RecoveryRequired` when the bankrupt position's
   * liability exceeds this limit and insurance is insufficient to cover it.
   * Use `PUBLIC_B_CHUNK_ATOMS_UNLIMITED` (= engine's `MAX_VAULT_TVL` =
   * 10_000_000_000_000_000) unless you have a specific chunk-limit requirement
   * and a funded insurance pool.
   */
  publicBChunkAtoms: bigint | string;
  /** Maintenance fee per slot in absolute units (u128). Must be <= MAX_PROTOCOL_FEE_ABS. */
  maintenanceFeePerSlot: bigint | string;
}

/**
 * Encode InitMarket instruction data (v17 wire format).
 *
 * Produces a 219-byte payload: tag(1) + market parameter fields (218 bytes).
 * admin and collateralMint go into account metas (accounts[0] and accounts[2]).
 *
 * The old v12.x `InitMarketArgs` interface is accepted for source-compat via
 * overload but the v12 fields (admin, collateralMint, feedId, staleness, conf,
 * invert, unitScale, maxMaintenanceFeePerSlot, extendedTail, warmupPeriodSlots,
 * newAccountFee, insuranceFloor, maxCrankStalenessSlots, liquidationBufferBps,
 * minInitialDeposit) are silently ignored — provide `InitMarketV17Args` instead.
 *
 * @param args  v17 market parameters (InitMarketV17Args)
 * @returns 227-byte Uint8Array
 *
 * @example
 * ```ts
 * const data = encodeInitMarket({
 *   maxPortfolioAssets: 256,
 *   hMin: 1000n,
 *   hMax: 100000n,
 *   initialPrice: 50_000_000_000n,
 *   minNonzeroMmReq: 1_000_000n,
 *   minNonzeroImReq: 2_000_000n,
 *   maintenanceMarginBps: 500n,
 *   initialMarginBps: 1000n,
 *   maxTradingFeeBps: 100n,
 *   tradeFeeBaseBps: 30n,
 *   liquidationFeeBps: 100n,
 *   liquidationFeeCap: 10_000_000n,
 *   minLiquidationAbs: 1_000_000n,
 *   maxPriceMoveBpsPerSlot: 4n,
 *   maxAccrualDtSlots: 600n,
 *   maxAbsFundingE9PerSlot: 1000n,
 *   minFundingLifetimeSlots: 50n,
 *   maxAccountBSettlementChunks: 10n,
 *   maxBankruptCloseChunks: 10n,
 *   maxBankruptCloseLifetimeSlots: 500n,
 *   publicBChunkAtoms: PUBLIC_B_CHUNK_ATOMS_UNLIMITED,  // use engine's MAX_VAULT_TVL; small values stall deep liquidations
 *   maintenanceFeePerSlot: 0n,
 * });
 * ```
 */
export function encodeInitMarket(args: InitMarketV17Args | InitMarketArgs): Uint8Array {
  // Detect v17 args by presence of maxPortfolioAssets (v17) vs admin (v12)
  const isV17Args = 'maxPortfolioAssets' in args;

  let maxPortfolioAssets: number;
  let hMin: bigint | string;
  let hMax: bigint | string;
  let initialPrice: bigint | string;
  let minNonzeroMmReq: bigint | string;
  let minNonzeroImReq: bigint | string;
  let maintenanceMarginBps: bigint | string;
  let initialMarginBps: bigint | string;
  let maxTradingFeeBps: bigint | string;
  let tradeFeeBaseBps: bigint | string;
  let liquidationFeeBps: bigint | string;
  let liquidationFeeCap: bigint | string;
  let minLiquidationAbs: bigint | string;
  let maxPriceMoveBpsPerSlot: bigint | string;
  let maxAccrualDtSlots: bigint | string;
  let maxAbsFundingE9PerSlot: bigint | string;
  let minFundingLifetimeSlots: bigint | string;
  let maxAccountBSettlementChunks: bigint | string;
  let maxBankruptCloseChunks: bigint | string;
  let maxBankruptCloseLifetimeSlots: bigint | string;
  let publicBChunkAtoms: bigint | string;
  let maintenanceFeePerSlot: bigint | string;

  if (isV17Args) {
    const v = args as InitMarketV17Args;
    maxPortfolioAssets = v.maxPortfolioAssets;
    hMin = v.hMin;
    hMax = v.hMax;
    initialPrice = v.initialPrice;
    minNonzeroMmReq = v.minNonzeroMmReq;
    minNonzeroImReq = v.minNonzeroImReq;
    maintenanceMarginBps = v.maintenanceMarginBps;
    initialMarginBps = v.initialMarginBps;
    maxTradingFeeBps = v.maxTradingFeeBps;
    tradeFeeBaseBps = v.tradeFeeBaseBps;
    liquidationFeeBps = v.liquidationFeeBps;
    liquidationFeeCap = v.liquidationFeeCap;
    minLiquidationAbs = v.minLiquidationAbs;
    maxPriceMoveBpsPerSlot = v.maxPriceMoveBpsPerSlot;
    maxAccrualDtSlots = v.maxAccrualDtSlots;
    maxAbsFundingE9PerSlot = v.maxAbsFundingE9PerSlot;
    minFundingLifetimeSlots = v.minFundingLifetimeSlots;
    maxAccountBSettlementChunks = v.maxAccountBSettlementChunks;
    maxBankruptCloseChunks = v.maxBankruptCloseChunks;
    maxBankruptCloseLifetimeSlots = v.maxBankruptCloseLifetimeSlots;
    publicBChunkAtoms = v.publicBChunkAtoms;
    maintenanceFeePerSlot = v.maintenanceFeePerSlot;
  } else {
    // v12.x InitMarketArgs compat shim — map old fields to v17 layout.
    // Fields removed in v17 (admin, collateralMint, feedId, staleness, conf,
    // invert, unitScale, extendedTail) are silently ignored.
    const v = args as InitMarketArgs;
    const resolvedHMin = v.hMin ?? v.warmupPeriodSlots ?? 0n;
    const resolvedHMax = v.hMax ?? v.warmupPeriodSlots ?? 0n;
    maxPortfolioAssets = typeof v.maxAccounts === 'string' ? parseInt(v.maxAccounts, 10) : Number(v.maxAccounts);
    hMin = resolvedHMin;
    hMax = resolvedHMax;
    initialPrice = v.initialMarkPriceE6;
    minNonzeroMmReq = v.minNonzeroMmReq;
    minNonzeroImReq = v.minNonzeroImReq;
    maintenanceMarginBps = v.maintenanceMarginBps;
    initialMarginBps = v.initialMarginBps;
    // v12 tradingFeeBps maps to max_trading_fee_bps and trade_fee_base_bps
    maxTradingFeeBps = v.tradingFeeBps;
    tradeFeeBaseBps = v.tradingFeeBps;
    liquidationFeeBps = v.liquidationFeeBps;
    liquidationFeeCap = v.liquidationFeeCap;
    minLiquidationAbs = v.minLiquidationAbs;
    // v12 ExtendedTail fields mapped to v17 equivalents (default safe values)
    maxPriceMoveBpsPerSlot = v.extendedTail?.maxPriceMoveBpsPerSlot ?? 4n;
    maxAccrualDtSlots = v.maxCrankStalenessSlots ?? 0n;
    maxAbsFundingE9PerSlot = v.extendedTail?.fundingMaxBpsPerSlot ?? 1000n;
    minFundingLifetimeSlots = 0n;
    // #310: the v12 InitMarketArgs interface has no equivalent for the four fields below,
    // which control the permissionless B-settlement path — the ONLY mechanism for closing
    // bankrupt accounts and releasing insurance. Defaulting them to 0 (the old behavior)
    // PERMANENTLY DISABLED bankruptcy recovery for any market created via the shim. Default
    // them to functional values instead so v12-initialized markets stay recoverable; callers
    // wanting explicit control should migrate to InitMarketV17Args.
    maxAccountBSettlementChunks = 10n;
    maxBankruptCloseChunks = 10n;
    maxBankruptCloseLifetimeSlots = 500n;
    publicBChunkAtoms = 1_000_000n;
    maintenanceFeePerSlot = v.maintenanceFeePerSlot;
  }

  const data = concatBytes(
    encU8(IX_TAG.InitMarket),
    encU16(maxPortfolioAssets),
    encU64(hMin),
    encU64(hMax),
    encU64(initialPrice),
    encU128(minNonzeroMmReq),
    encU128(minNonzeroImReq),
    encU64(maintenanceMarginBps),
    encU64(initialMarginBps),
    encU64(maxTradingFeeBps),
    encU64(tradeFeeBaseBps),
    encU64(liquidationFeeBps),
    encU128(liquidationFeeCap),
    encU128(minLiquidationAbs),
    encU64(maxPriceMoveBpsPerSlot),
    encU64(maxAccrualDtSlots),
    encU64(maxAbsFundingE9PerSlot),
    encU64(minFundingLifetimeSlots),
    encU64(maxAccountBSettlementChunks),
    encU64(maxBankruptCloseChunks),
    encU64(maxBankruptCloseLifetimeSlots),
    encU128(publicBChunkAtoms),
    encU128(maintenanceFeePerSlot),
  );

  if (data.length !== INIT_MARKET_V17_LEN) {
    throw new Error(
      `encodeInitMarket: expected ${INIT_MARKET_V17_LEN} bytes, got ${data.length}`,
    );
  }

  return data;
}

/**
 * InitPortfolio / InitUser instruction data.
 *
 * v17 wire: tag(1) only — 1 byte total.
 *
 * BREAKING vs v12.x: the feePayment(u64) arg was removed. The program
 * decoder at `1 => Self::InitPortfolio` reads no bytes after the tag byte.
 * Sending extra bytes causes garbage reads in downstream decoder arms.
 *
 * @example
 * ```ts
 * const data = encodeInitUser();
 * ```
 */
export interface InitUserArgs {
  /** @deprecated feePayment is ignored in v17 — kept for source compatibility only. */
  feePayment?: bigint | string;
}

export function encodeInitUser(_args?: InitUserArgs): Uint8Array {
  return new Uint8Array([IX_TAG.InitPortfolio]);
}

/**
 * InitLP (tag 2) — REMOVED in v17.
 *
 * Tag 2 has no decode arm in the v17 wrapper program. Calling this instruction
 * results in ProgramError::InvalidInstructionData on-chain.
 *
 * @deprecated Use the LP Vault flow (CreateLpVault tag 74) instead.
 */
export interface InitLPArgs {
  matcherProgram: PublicKey | string;
  matcherContext: PublicKey | string;
  feePayment: bigint | string;
}

export function encodeInitLP(_args: InitLPArgs): Uint8Array {
  return removedInstruction("InitLP", IX_TAG.InitLP, "CreateLpVault (tag 74)");
}

/**
 * DepositCollateral instruction data.
 *
 * v18 wire (integration `a9318945`, tag 3): tag(1) + portfolio_id(u64) +
 * expected_sequence(u64) + amount(u128 LE) = 33 bytes.
 *
 * BREAKING vs v17: `portfolio_id` and `expected_sequence` were added
 * BEFORE `amount` as part of the v16-migration identity-binding overhaul —
 * Deposit is now CAS-bound to the portfolio's identity/sequence the same way
 * ClosePortfolio and ConvertReleasedPnl are. `expected_sequence` is the
 * portfolio's CURRENT `PortfolioMatcherConfigV16` sequence watermark
 * (`expected_sequence`/`matcher_sequence`), read live before signing — NOT
 * incremented client-side.
 *
 * @param portfolioId       The portfolio's program-assigned identity (`PORTFOLIO_ID_OFF`).
 * @param expectedSequence  The portfolio's current matcher-sequence watermark, read live.
 * @param amount            Collateral to deposit (u128; supports sub-cent precision).
 *
 * @example
 * ```ts
 * const data = encodeDepositCollateral({
 *   portfolioId: portfolio.portfolioId,
 *   expectedSequence: portfolio.matcherSequence,
 *   amount: 1_000_000n,
 * });
 * ```
 */
export interface DepositCollateralArgs {
  /** @deprecated userIdx is no longer needed — portfolios are identified by account key in v17+. */
  userIdx?: number;
  portfolioId: bigint | string;
  expectedSequence: bigint | string;
  amount: bigint | string;
}

export function encodeDepositCollateral(args: DepositCollateralArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.DepositCollateral),
    encU64(args.portfolioId),
    encU64(args.expectedSequence),
    encU128(args.amount),
  );
}

/**
 * WithdrawCollateral instruction data.
 *
 * v18 wire (integration `a9318945`, tag 4): tag(1) + portfolio_id(u64) +
 * expected_sequence(u64) + amount(u128 LE) = 33 bytes.
 *
 * BREAKING vs v17: `portfolio_id` and `expected_sequence` were added
 * BEFORE `amount` as part of the v16-migration identity-binding overhaul —
 * same CAS binding as {@link encodeDepositCollateral}.
 *
 * @param portfolioId       The portfolio's program-assigned identity.
 * @param expectedSequence  The portfolio's current matcher-sequence watermark, read live.
 * @param amount            Collateral to withdraw (u128).
 *
 * @example
 * ```ts
 * const data = encodeWithdrawCollateral({
 *   portfolioId: portfolio.portfolioId,
 *   expectedSequence: portfolio.matcherSequence,
 *   amount: 500_000n,
 * });
 * ```
 */
export interface WithdrawCollateralArgs {
  /** @deprecated userIdx is no longer needed — portfolios are identified by account key in v17+. */
  userIdx?: number;
  portfolioId: bigint | string;
  expectedSequence: bigint | string;
  amount: bigint | string;
}

export function encodeWithdrawCollateral(args: WithdrawCollateralArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.WithdrawCollateral),
    encU64(args.portfolioId),
    encU64(args.expectedSequence),
    encU128(args.amount),
  );
}

/**
 * PermissionlessCrank (tag 5) action byte values.
 *
 * @deprecated REMOVED from the wire in the v16-migration (VERSION 18,
 * integration `a9318945`). The v18 decoder for tag 5 no longer reads an
 * `action` byte at all — see {@link encodePermissionlessCrank}. Kept only so
 * source referencing `CrankAction.*` for other purposes does not break at
 * compile time.
 */
export const CrankAction = {
  /**
   * #381: action 0 is `Refresh` in the program, not `FeeSweep`.
   *
   * `v16_program.rs` decodes `0 => PermissionlessCrankActionV16::Refresh`. The
   * name is kept as an alias below so existing callers do not break, but
   * `Refresh` is what the program calls it and what a reader should match
   * against when comparing this file to the wrapper.
   */
  Refresh: 0,
  /** @deprecated Alias for {@link CrankAction.Refresh} — the program's name. */
  FeeSweep: 0,
  Liquidate: 1,
  /**
   * #381: action 2 was MISSING from this enum entirely.
   *
   * `2 => PermissionlessCrankActionV16::SettleB` is the permissionless
   * bankrupt-settlement path. Omitting it did not merely mislabel something — it
   * hid the action's existence from every SDK consumer, so a keeper reading this
   * file would conclude the crank had two modes and never call the third.
   */
  SettleB: 2,
} as const;

/**
 * Maximum number of {@link CrankObservationHint} entries `encodePermissionlessCrank`
 * will encode in one instruction. Matches the wrapper's
 * `CRANK_OBSERVATION_DECODE_MAX = 16` (`v16_program.rs:5602`) — the decoder
 * hard-rejects `n > 16` with `InvalidInstructionData` before reading any hint
 * bytes, so exceeding this client-side is always a wasted transaction, never
 * a partial success.
 */
export const CRANK_OBSERVATION_DECODE_MAX = 16;

/**
 * One asset/oracle-account hint for {@link PermissionlessCrankArgs.observations}.
 * Mirrors the wrapper's `CrankObservationHint { asset_index: u16, oracle_accounts: u8 }`
 * (`v16_program.rs:5593`).
 *
 * @param assetIndex      Asset/domain index this hint targets.
 * @param oracleAccounts  Count of oracle accounts supplied in the instruction's
 *                        account list for this asset (consumed by the wrapper's
 *                        variable-length account-list walk).
 */
export interface CrankObservationHint {
  assetIndex: number;
  oracleAccounts: number;
}

/**
 * PermissionlessCrank (tag 5) instruction args.
 *
 * BREAKING WIRE CHANGE in the v16-migration (VERSION 18, integration
 * `a9318945`): the entire v17 payload (`action`/`asset_index`/`now_slot`/
 * `funding_rate_e9`/`recovery_reason`, 29 bytes) is GONE. The v18 decoder
 * reads:
 *
 * ```
 * 5 => {
 *     let now_slot = read_u64(&mut rest)?;
 *     let n = read_u8(&mut rest)? as usize;   // observations.len(), <= CRANK_OBSERVATION_DECODE_MAX
 *     // n × { asset_index: u16, oracle_accounts: u8 }
 *     Self::PermissionlessCrank { now_slot, observations }
 * }
 * ```
 *
 * v18 wire: tag(1) + now_slot(u64) + n(u8) + n×(asset_index(u16) +
 *   oracle_accounts(u8)) = 10 + 3n bytes (variable length; n=0 is legal and
 *   encodes a bare liveness/no-op crank).
 *
 * There is no `action` byte, no `funding_rate_e9`, and no `recovery_reason`
 * on this wire anymore — liquidation/settlement dispatch and the crank's
 * per-asset work are now driven entirely by on-chain state plus which assets
 * the caller hints via `observations`, not by a caller-chosen mode byte.
 * Encoding the old 29-byte v17 payload against a v18 wrapper misparses:
 * `now_slot` would read the old `action`+`asset_index`+3 bytes of `now_slot`
 * as its own 8-byte `now_slot`, and `n` would read whatever byte happened to
 * land at offset 9 — silently wrong, not a decode error, unless `n` happens
 * to exceed 16 or overrun the buffer.
 *
 * @param nowSlot       Current slot (for crank freshness checks).
 * @param observations  Per-asset oracle-account hints (0..=16 entries).
 *
 * @example
 * ```ts
 * const data = encodePermissionlessCrank({
 *   nowSlot: currentSlot,
 *   observations: [{ assetIndex: 0, oracleAccounts: 1 }],
 * });
 * ```
 */
export interface PermissionlessCrankArgs {
  nowSlot: bigint | string;
  observations: CrankObservationHint[];
  /** @deprecated Removed from the v18 wire — no longer encoded. */
  action?: number;
  /** @deprecated Removed from the v18 wire — no longer encoded. */
  assetIndex?: number;
  /** @deprecated Removed from the v18 wire — no longer encoded. */
  recoveryReason?: number;
}

export function encodePermissionlessCrank(args: PermissionlessCrankArgs): Uint8Array {
  const observations = args.observations ?? [];
  if (observations.length > CRANK_OBSERVATION_DECODE_MAX) {
    throw new Error(
      `encodePermissionlessCrank: ${observations.length} observations exceeds ` +
      `CRANK_OBSERVATION_DECODE_MAX (${CRANK_OBSERVATION_DECODE_MAX}) — the wrapper ` +
      `rejects this with InvalidInstructionData before reading any hint bytes.`,
    );
  }
  const parts: Uint8Array[] = [
    encU8(IX_TAG.PermissionlessCrank),
    encU64(args.nowSlot),
    encU8(observations.length),
  ];
  for (const obs of observations) {
    parts.push(encU16(obs.assetIndex), encU8(obs.oracleAccounts));
  }
  return concatBytes(...parts);
}

/**
 * @deprecated v12.17 KeeperCrank wire format is not accepted by v17.
 * Use encodePermissionlessCrank() instead.
 *
 * Retained for source-compat only. Will throw to prevent silent misuse.
 */
export interface KeeperCrankArgs {
  callerIdx: number;
  candidates?: unknown[];
}

export function encodeKeeperCrank(_args: KeeperCrankArgs): Uint8Array {
  throw new Error(
    "encodeKeeperCrank: v12.17 wire format is not accepted by the v17 wrapper. " +
    "Use encodePermissionlessCrank() instead."
  );
}

/**
 * TradeNoCpi instruction data (v18 wire format, integration `a9318945`).
 *
 * v18 wire: tag(1) + account_a_portfolio_id(u64) + account_a_position_epoch(u64) +
 *   account_b_portfolio_id(u64) + account_b_position_epoch(u64) + asset_index(u16) +
 *   market_id(u64) + size_q(i128) + exec_price(u64) + fee_bps(u64) +
 *   backing_fee_cap_bps(u16) = 77 bytes.
 *
 * BREAKING vs v17 (35-byte payload): the v16-migration identity-binding
 * overhaul CAS-binds BOTH legs' portfolio identity/position-epoch, adds
 * `market_id` (TB-4's market-id-bearing cluster) right after `asset_index`,
 * and appends `backing_fee_cap_bps` — the caller-supplied ceiling on the
 * matcher-authorized backing fee for this fill (0 fails closed against any
 * nonzero backing-domain fee; see the matcher-return `backing_fee_cap_bps`
 * bits 8..21 this value is checked against on the CPI-trade path).
 * `accountAPositionEpoch`/`accountBPositionEpoch` must be each side's LIVE
 * current `position_epoch`, read immediately before signing — NOT
 * incremented client-side (CAS, not a monotonic nonce).
 *
 * @param accountAPortfolioId    Account A's portfolio identity.
 * @param accountAPositionEpoch  Account A's current position epoch (CAS, live-read).
 * @param accountBPortfolioId    Account B's portfolio identity.
 * @param accountBPositionEpoch  Account B's current position epoch (CAS, live-read).
 * @param assetIndex Asset/domain index.
 * @param marketId   The traded asset's market_id.
 * @param sizeQ      Trade quantity (signed; positive=long, negative=short).
 * @param execPrice  Execution price in e6 units.
 * @param feeBps     Fee in basis points.
 * @param backingFeeCapBps  Caller's ceiling on the backing-domain fee (0..=10000).
 *
 * @example
 * ```ts
 * const data = encodeTradeNoCpi({
 *   accountAPortfolioId: a.portfolioId,
 *   accountAPositionEpoch: a.legs[0].epochSnap,
 *   accountBPortfolioId: b.portfolioId,
 *   accountBPositionEpoch: b.legs[0].epochSnap,
 *   assetIndex: 0,
 *   marketId: 1n,
 *   sizeQ: 1_000_000n,
 *   execPrice: 50_000_000_000n,
 *   feeBps: 30n,
 *   backingFeeCapBps: 0,
 * });
 * ```
 */
export interface TradeNoCpiArgs {
  accountAPortfolioId: bigint | string;
  accountAPositionEpoch: bigint | string;
  accountBPortfolioId: bigint | string;
  accountBPositionEpoch: bigint | string;
  assetIndex: number;
  marketId: bigint | string;
  sizeQ: bigint | string;
  execPrice: bigint | string;
  feeBps: bigint | string;
  backingFeeCapBps: number;
}

export function encodeTradeNoCpi(args: TradeNoCpiArgs): Uint8Array {
  const data = concatBytes(
    encU8(IX_TAG.TradeNoCpi),
    encU64(args.accountAPortfolioId),
    encU64(args.accountAPositionEpoch),
    encU64(args.accountBPortfolioId),
    encU64(args.accountBPositionEpoch),
    encU16(args.assetIndex),
    encU64(args.marketId),
    encI128(args.sizeQ),
    encU64(args.execPrice),
    encU64(args.feeBps),
    encU16(args.backingFeeCapBps),
  );
  if (data.length !== 77) {
    throw new Error(
      `encodeTradeNoCpi: expected 77 bytes, got ${data.length}`,
    );
  }
  return data;
}

/**
 * LiquidateAtOracle (tag 7) — REMOVED in v17.
 *
 * Tag 7 has no decode arm in the v17 wrapper program. Sending this instruction
 * results in ProgramError::InvalidInstructionData on-chain.
 *
 * @deprecated Liquidations are handled via PermissionlessCrank (tag 5) in v17.
 */
export interface LiquidateAtOracleArgs {
  targetIdx: number;
}

export function encodeLiquidateAtOracle(_args: LiquidateAtOracleArgs): Uint8Array {
  return removedInstruction(
    "LiquidateAtOracle",
    IX_TAG.LiquidateAtOracle,
    "PermissionlessCrank (tag 5)",
  );
}

/**
 * ClosePortfolio / CloseAccount instruction data (v18 wire, integration `a9318945`).
 *
 * v18 wire: tag(1) + portfolio_id(u64) + expected_sequence(u64) +
 *   position_epoch(u64) = 25 bytes.
 *
 * BREAKING vs v17 (bare 1-byte tag): the v16-migration identity-binding
 * overhaul CAS-binds ClosePortfolio to the portfolio's identity, matcher
 * sequence AND position epoch. All three must be the LIVE current values,
 * read immediately before signing.
 *
 * @param portfolioId       The portfolio's program-assigned identity.
 * @param expectedSequence  The portfolio's current matcher-sequence watermark, read live.
 * @param positionEpoch     The portfolio's current position epoch, read live.
 *
 * @example
 * ```ts
 * const data = encodeCloseAccount({
 *   portfolioId: portfolio.portfolioId,
 *   expectedSequence: portfolio.matcherSequence,
 *   positionEpoch: portfolio.legs[0].epochSnap,
 * });
 * ```
 */
export interface CloseAccountArgs {
  /** @deprecated userIdx is not read in v17+; portfolios are identified by account key. */
  userIdx?: number;
  portfolioId: bigint | string;
  expectedSequence: bigint | string;
  positionEpoch: bigint | string;
}

export function encodeCloseAccount(args: CloseAccountArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.ClosePortfolio),
    encU64(args.portfolioId),
    encU64(args.expectedSequence),
    encU64(args.positionEpoch),
  );
}

/**
 * TopUpInsurance instruction data (v18 wire, integration `a9318945`).
 *
 * v18 wire: tag(1) + market_id(u64) + intent_id(u64) + authority_epoch(u64) +
 *   amount(u128 LE) = 41 bytes.
 *
 * BREAKING vs v17 (17-byte payload): the v16-migration identity-binding
 * overhaul (§4-locked common cluster order `market_id, intent_id,
 * authority_epoch, amount`) adds all three fields before `amount`.
 * `intent_id` is a one-shot, strictly-increasing replay nonce (per-asset-0
 * `insurance_top_up` lane, shared with {@link encodeTopUpInsuranceDomain}) —
 * a value that is not strictly greater than the stored lane is rejected.
 * `authority_epoch` here is NOT a CAS/current-epoch value the way the
 * UpdateAssetAuthority-family tags are — read the field from the live asset
 * control-sequences state before signing regardless.
 *
 * @param marketId        The asset's market_id.
 * @param intentId        Strictly-increasing one-shot replay nonce (asset-0 `insurance_top_up` lane).
 * @param authorityEpoch  Live authority-epoch value for this top-up.
 * @param amount          Amount to top up the insurance fund (u128).
 *
 * @example
 * ```ts
 * const data = encodeTopUpInsurance({
 *   marketId: 1n,
 *   intentId: nextIntentId,
 *   authorityEpoch: 0n,
 *   amount: 10_000_000n,
 * });
 * ```
 */
export interface TopUpInsuranceArgs {
  marketId: bigint | string;
  intentId: bigint | string;
  authorityEpoch: bigint | string;
  amount: bigint | string;
}

export function encodeTopUpInsurance(args: TopUpInsuranceArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.TopUpInsurance),
    encU64(args.marketId),
    encU64(args.intentId),
    encU64(args.authorityEpoch),
    encU128(args.amount),
  );
}

/**
 * TopUpInsuranceDomain instruction data (tag 56, v18 wire, integration `a9318945`).
 *
 * v18 wire: tag(1) + domain(u16 LE) + market_id(u64) + intent_id(u64) +
 *   authority_epoch(u64) + amount(u128 LE) = 43 bytes.
 *
 * Domain-scoped sibling of {@link encodeTopUpInsurance} — same §4-locked
 * common cluster order (`market_id, intent_id, authority_epoch, amount`)
 * plus the leading `domain`. `intent_id` is the SAME asset-0 `insurance_top_up`
 * one-shot replay lane TopUpInsurance(9) uses — "Both insurance top-up
 * entrypoints share `insurance_top_up` so an intent cannot be replayed
 * through the alternate route" (wrapper source comment).
 *
 * No encoder existed for this tag prior to the v16-migration SDK update —
 * added here for the first time, matching a9318945 exactly.
 *
 * @param domain          Domain index (2*assetIndex long, 2*assetIndex+1 short).
 * @param marketId        The asset's market_id.
 * @param intentId        Strictly-increasing one-shot replay nonce (asset-0 `insurance_top_up` lane, shared with {@link encodeTopUpInsurance}).
 * @param authorityEpoch  Live authority-epoch value for this top-up.
 * @param amount          Amount to top up the insurance fund (u128).
 *
 * @example
 * ```ts
 * const data = encodeTopUpInsuranceDomain({
 *   domain: 0,
 *   marketId: 1n,
 *   intentId: nextIntentId,
 *   authorityEpoch: 0n,
 *   amount: 10_000_000n,
 * });
 * ```
 */
export interface TopUpInsuranceDomainArgs {
  domain: number;
  marketId: bigint | string;
  intentId: bigint | string;
  authorityEpoch: bigint | string;
  amount: bigint | string;
}

export function encodeTopUpInsuranceDomain(args: TopUpInsuranceDomainArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.TopUpInsuranceDomain),
    encU16(args.domain),
    encU64(args.marketId),
    encU64(args.intentId),
    encU64(args.authorityEpoch),
    encU128(args.amount),
  );
}

/**
 * TopUpBackingBucket instruction data (tag 24, v18 wire, integration `a9318945`).
 *
 * v18 wire: tag(1) + domain(u16 LE) + market_id(u64) + intent_id(u64) +
 *   authority_epoch(u64) + amount(u128 LE) + expiry_slot(u64 LE) = 51 bytes.
 *
 * BREAKING vs v17 (27-byte payload): the v16-migration identity-binding
 * overhaul adds `market_id`/`intent_id`/`authority_epoch` between `domain`
 * and `amount` (the §4-locked common cluster order). `intent_id` is a
 * strictly-increasing one-shot replay nonce, PER-ASSET (keyed by
 * `domain / 2`), distinct from TopUpInsurance/TopUpInsuranceDomain's shared
 * asset-0 `insurance_top_up` lane.
 *
 * Deposits `amount` quote atoms of external collateral into a source domain's
 * counterparty backing bucket, requesting `expirySlot` as the bucket's fresh
 * expiry. Gated by the asset's `backing_bucket_authority` (v16_program.rs
 * handle_top_up_backing_bucket, ~line 8439/8516; engine
 * deposit_fresh_counterparty_backing_not_atomic, percolator/src/v16.rs:6118).
 *
 * Domain numbering: for asset index `i`, the LONG domain is `2*i` and the
 * SHORT domain is `2*i + 1`.
 *
 * ENGINE MECHANICS (percolator/src/v16.rs prepare_counterparty_backing_add_delta,
 * ~line 755): if the bucket is Empty/Expired, it adopts `expirySlot` and
 * transitions to Fresh. If it is already Fresh with the SAME expiry, this is a
 * no-op (safe to call again). If it is Fresh with a DIFFERENT expiry — in
 * particular a LAPSED one (`current_slot >= expiry_slot`) — this call reverts
 * with Custom(21) LockActive. Seeding a bucket once while it is still Empty,
 * with `expirySlot = MAX_BACKING_BUCKET_EXPIRY_SLOT` (9223372036854775807 =
 * u64::MAX / 2, effectively never-lapsing), makes that domain immune to the
 * "backing-bucket-freshness deadlock" for the market's practical lifetime —
 * every later automatic loss-reserve requests the SAME existing expiry and
 * hits the harmless no-op arm instead of the LockActive trap.
 *
 * @param domain         Backing-bucket domain index (2*assetIndex for long,
 *                       2*assetIndex+1 for short).
 * @param marketId       The asset's market_id.
 * @param intentId       Strictly-increasing one-shot replay nonce, per-asset (`domain / 2`).
 * @param authorityEpoch Live authority-epoch value for this top-up.
 * @param amount     Quote atoms to deposit (u128; must be > 0). A small
 *                   nonzero "dust" amount is sufficient — there is no
 *                   minimum floor enforced by the engine.
 * @param expirySlot Requested fresh-expiry slot (u64). Use
 *                   MAX_BACKING_BUCKET_EXPIRY_SLOT to seed an immortal bucket.
 *
 * @example
 * ```ts
 * // Seed the long domain (asset 0) immortal, while the bucket is still Empty.
 * const data = encodeTopUpBackingBucket({
 *   domain: 0,
 *   marketId: 1n,
 *   intentId: nextIntentId,
 *   authorityEpoch: 0n,
 *   amount: 10_000n, // 0.01 Sim-USDC dust
 *   expirySlot: MAX_BACKING_BUCKET_EXPIRY_SLOT,
 * });
 * ```
 */
export const MAX_BACKING_BUCKET_EXPIRY_SLOT: bigint = 9_223_372_036_854_775_807n; // u64::MAX / 2

export interface TopUpBackingBucketArgs {
  domain: number;
  marketId: bigint | string;
  intentId: bigint | string;
  authorityEpoch: bigint | string;
  amount: bigint | string;
  expirySlot: bigint | string;
}

export function encodeTopUpBackingBucket(args: TopUpBackingBucketArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.TopUpBackingBucket),
    encU16(args.domain),
    encU64(args.marketId),
    encU64(args.intentId),
    encU64(args.authorityEpoch),
    encU128(args.amount),
    encU64(args.expirySlot),
  );
}

/**
 * WithdrawBackingBucket instruction data (tag 50, v18 wire, integration `a9318945`).
 *
 * v18 wire: tag(1) + domain(u16 LE) + market_id(u64) + amount(u128 LE) +
 *   authority_epoch(u64) = 35 bytes.
 *
 * BREAKING vs v17 (19-byte payload): adds `market_id` after `domain` and
 * appends `authority_epoch` — a CAS check against the asset's OWN
 * `AssetControlSequencesV16.authority_epoch` lane (W3A-1 direct-withdrawal
 * binding). Pass the LIVE current epoch, NOT current+1 — the program itself
 * decides and stores the next value; the caller only proves it read the
 * current one.
 *
 * Withdraws `amount` quote atoms of backing-bucket PRINCIPAL from a domain
 * back to the authority's token account. Gated by the asset's
 * `backing_bucket_authority` (or marketauth) — v16_program.rs
 * `handle_withdraw_backing_bucket` → `verify_domain_withdrawal_preflight`
 * with DOMAIN_WITHDRAW_AUTH_BACKING. The destination token account must be
 * OWNED by the signing authority (verify_withdrawable_token_accounts).
 *
 * Together with TopUpBackingBucket (24, deposit) and
 * WithdrawBackingBucketEarnings (52, fee earnings) this completes the
 * LP-provider backing-bucket loop.
 *
 * @param domain Backing-bucket domain index (2*assetIndex for long,
 *               2*assetIndex+1 for short).
 * @param marketId       The asset's market_id.
 * @param amount Quote atoms to withdraw (u128; must be > 0).
 * @param authorityEpoch Live-read current `authority_epoch` for this asset (CAS, expected-current).
 */
export interface WithdrawBackingBucketArgs {
  domain: number;
  marketId: bigint | string;
  amount: bigint | string;
  authorityEpoch: bigint | string;
}

export function encodeWithdrawBackingBucket(args: WithdrawBackingBucketArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.WithdrawBackingBucket),
    encU16(args.domain),
    encU64(args.marketId),
    encU128(args.amount),
    encU64(args.authorityEpoch),
  );
}

/**
 * UpdateBackingFeePolicy instruction data (tag 51, v18 wire, integration `a9318945`).
 *
 * v18 wire: tag(1) + domain(u16 LE) + market_id(u64) + fee_bps(u16 LE) +
 *   insurance_share_bps(u16 LE) + policy_sequence(u64) = 23 bytes.
 *
 * BREAKING vs v17 (7-byte payload): adds `market_id` after `domain` and
 * appends `policy_sequence` — a strictly-increasing replay nonce (this
 * asset's control-sequences lane), NOT a CAS/current-epoch value.
 *
 * THE switch that turns on LP-vault yield for a domain: sets the
 * backing-trade fee charged on that domain's fills, of which
 * `insurance_share_bps` is diverted to the insurance budget and the
 * remainder accrues to the domain's backing-bucket providers as
 * `utilization_fee_earnings` (withdrawable via tag 52). Every live market
 * currently has this at 0 — which is why LP APY is 0%.
 *
 * Gated by the asset's `insurance_authority` (v16_program.rs
 * `handle_update_backing_fee_policy`, gate at ~10492) — NOT marketauth, so
 * the market creator can call it even after the launch flow rotates
 * marketauth to the stake-pool PDA. Market must be Live.
 *
 * Handler-side validation (reverts InvalidInstruction otherwise):
 * fee_bps ≤ 10_000, insurance_share_bps ≤ 10_000, fee_bps == 0 implies
 * insurance_share_bps == 0, fee_bps ≤ the market's max_trading_fee_bps and
 * ≤ MAX_DYNAMIC_TRADE_FEE_BPS.
 *
 * @param domain            Domain index (2*assetIndex long, 2*assetIndex+1 short).
 * @param marketId          The asset's market_id.
 * @param feeBps            Backing-trade fee in bps (0 turns the fee off).
 * @param insuranceShareBps Share of that fee diverted to insurance, in bps
 *                          of the fee (the rest goes to backing providers).
 * @param policySequence    Strictly-increasing replay nonce (this asset's control-sequences lane).
 */
export interface UpdateBackingFeePolicyArgs {
  domain: number;
  marketId: bigint | string;
  feeBps: number;
  insuranceShareBps: number;
  policySequence: bigint | string;
}

export function encodeUpdateBackingFeePolicy(args: UpdateBackingFeePolicyArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.UpdateBackingFeePolicy),
    encU16(args.domain),
    encU64(args.marketId),
    encU16(args.feeBps),
    encU16(args.insuranceShareBps),
    encU64(args.policySequence),
  );
}

/**
 * WithdrawBackingBucketEarnings instruction data (tag 52, v18 wire, integration `a9318945`).
 *
 * v18 wire: tag(1) + domain(u16 LE) + market_id(u64) + amount(u128 LE) +
 *   authority_epoch(u64) = 35 bytes.
 *
 * BREAKING vs v17 (19-byte payload): adds `market_id` after `domain` and
 * appends `authority_epoch` (same CAS binding as {@link encodeWithdrawBackingBucket} —
 * pass the LIVE current epoch, not current+1).
 *
 * Withdraws accrued `utilization_fee_earnings` (the LP-provider share of the
 * backing-trade fee enabled via tag 51) from a domain's backing bucket to
 * the authority's token account. Gated by the asset's
 * `backing_bucket_authority` (or marketauth) — v16_program.rs
 * `handle_withdraw_backing_bucket_earnings` → same
 * DOMAIN_WITHDRAW_AUTH_BACKING preflight as tag 50. Unlike tag 50, the
 * per-domain ledger account is REQUIRED (account [2]).
 *
 * @param domain Domain index (2*assetIndex long, 2*assetIndex+1 short).
 * @param marketId       The asset's market_id.
 * @param amount Earnings quote atoms to withdraw (u128; must be > 0).
 * @param authorityEpoch Live-read current `authority_epoch` for this asset (CAS, expected-current).
 */
export interface WithdrawBackingBucketEarningsArgs {
  domain: number;
  marketId: bigint | string;
  amount: bigint | string;
  authorityEpoch: bigint | string;
}

export function encodeWithdrawBackingBucketEarnings(
  args: WithdrawBackingBucketEarningsArgs,
): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.WithdrawBackingBucketEarnings),
    encU16(args.domain),
    encU64(args.marketId),
    encU128(args.amount),
    encU64(args.authorityEpoch),
  );
}

/**
 * TradeCpi instruction data (v18 wire format, integration `a9318945`).
 *
 * v18 wire: tag(1) + account_a_portfolio_id(u64) + account_a_position_epoch(u64) +
 *   account_b_portfolio_id(u64) + account_b_position_epoch(u64) +
 *   account_b_matcher_sequence(u64) + asset_index(u16) + market_id(u64) +
 *   size_q(i128) + fee_bps(u64) + limit_price(u64) + backing_fee_cap_bps(u16)
 *   = 85 bytes.
 *
 * BREAKING vs v17 (35-byte payload): same identity-binding additions as
 * {@link encodeTradeNoCpi} (both legs' portfolio id/position epoch,
 * `market_id`, `backing_fee_cap_bps`), PLUS `account_b_matcher_sequence` —
 * account B is the CPI-matched side, and this binds the matcher-authorized
 * fill to B's LIVE current matcher-sequence watermark (CAS).
 *
 * @param accountAPortfolioId       Account A's portfolio identity.
 * @param accountAPositionEpoch     Account A's current position epoch (CAS, live-read).
 * @param accountBPortfolioId       Account B's portfolio identity.
 * @param accountBPositionEpoch     Account B's current position epoch (CAS, live-read).
 * @param accountBMatcherSequence   Account B's current matcher-sequence watermark (CAS, live-read).
 * @param assetIndex Asset/domain index.
 * @param marketId   The traded asset's market_id.
 * @param sizeQ      Trade quantity (signed).
 * @param feeBps     Fee in basis points.
 * @param limitPrice Limit price in e6 units. 0 = no limit (accept any price).
 *                   Buys: reject if exec_price > limit_price.
 *                   Sells: reject if exec_price < limit_price.
 * @param backingFeeCapBps  Caller's ceiling on the backing-domain fee (0..=10000).
 *
 * @example
 * ```ts
 * const data = encodeTradeCpi({
 *   accountAPortfolioId: a.portfolioId,
 *   accountAPositionEpoch: a.legs[0].epochSnap,
 *   accountBPortfolioId: b.portfolioId,
 *   accountBPositionEpoch: b.legs[0].epochSnap,
 *   accountBMatcherSequence: b.matcherSequence,
 *   assetIndex: 0,
 *   marketId: 1n,
 *   sizeQ: 1_000_000n,
 *   feeBps: 30n,
 *   limitPrice: 51_000_000_000n,  // max price for a buy
 *   backingFeeCapBps: 0,
 * });
 * ```
 */
export interface TradeCpiArgs {
  accountAPortfolioId: bigint | string;
  accountAPositionEpoch: bigint | string;
  accountBPortfolioId: bigint | string;
  accountBPositionEpoch: bigint | string;
  accountBMatcherSequence: bigint | string;
  assetIndex: number;
  marketId: bigint | string;
  sizeQ: bigint | string;
  feeBps: bigint | string;
  /** Limit price in e6 units. 0 = no limit. */
  limitPrice: bigint | string;
  backingFeeCapBps: number;
}

export function encodeTradeCpi(args: TradeCpiArgs): Uint8Array {
  const data = concatBytes(
    encU8(IX_TAG.TradeCpi),
    encU64(args.accountAPortfolioId),
    encU64(args.accountAPositionEpoch),
    encU64(args.accountBPortfolioId),
    encU64(args.accountBPositionEpoch),
    encU64(args.accountBMatcherSequence),
    encU16(args.assetIndex),
    encU64(args.marketId),
    encI128(args.sizeQ),
    encU64(args.feeBps),
    encU64(args.limitPrice),
    encU16(args.backingFeeCapBps),
  );
  if (data.length !== 85) {
    throw new Error(
      `encodeTradeCpi: expected 85 bytes, got ${data.length}`,
    );
  }
  return data;
}

/**
 * @deprecated Tag 35 removed in v12.17. Use TradeCpi (tag 10) with limitPriceE6 instead.
 * TradeCpi now handles PDA bump internally. Sending tag 35 will fail with InvalidInstructionData.
 */
export interface TradeCpiV2Args {
  lpIdx: number;
  userIdx: number;
  size: bigint | string;
  bump: number;
}

/** @deprecated Tag 35 removed in v12.17. Use encodeTradeCpi with limitPriceE6 instead. */
export function encodeTradeCpiV2(_args: TradeCpiV2Args): Uint8Array {
  return removedInstruction("TradeCpiV2", IX_TAG.TradeCpiV, "encodeTradeCpi()");
}

/**
 * @deprecated Tag 36 removed in v12.17. Will fail on-chain with InvalidInstructionData.
 */
export interface UnresolveMarketArgs {
  confirmation: bigint | string;
}

/** @deprecated Tag 36 removed in v12.17. Will fail on-chain. */
export function encodeUnresolveMarket(_args: UnresolveMarketArgs): Uint8Array {
  return removedInstruction("UnresolveMarket", IX_TAG.UnresolveMarket, "encodeResolveMarket()");
}

/**
 * @deprecated Tag 11 removed in v12.17. Insurance floor is now set at InitMarket.
 * Sending this instruction will fail with InvalidInstructionData.
 */
export interface SetRiskThresholdArgs {
  newThreshold: bigint | string;
}

/** @deprecated Tag 11 removed in v12.17. Will fail on-chain. */
export function encodeSetRiskThreshold(_args: SetRiskThresholdArgs): Uint8Array {
  return removedInstruction("SetRiskThreshold", IX_TAG.SetRiskThreshold, "encodeInitMarket()");
}

/**
 * UpdateAdmin (tag 12) — REMOVED in v17.
 *
 * Tag 12 has no decode arm in the v17 wrapper program. Calling this instruction
 * results in ProgramError::InvalidInstructionData on-chain.
 *
 * @deprecated Use UpdateAuthority (tag 32) or UpdateAssetAuthority (tag 65) in v17.
 */
export interface UpdateAdminArgs {
  newAdmin: PublicKey | string;
}

/** @deprecated Tag 12 removed in v17. Will fail on-chain. */
export function encodeUpdateAdmin(_args: UpdateAdminArgs): Uint8Array {
  return removedInstruction(
    "UpdateAdmin",
    IX_TAG.UpdateAdmin,
    "UpdateAuthority (tag 32) or UpdateAssetAuthority (tag 65)",
  );
}

/**
 * CloseSlab instruction data (tag 13, v18 wire, integration `a9318945`).
 *
 * v18 wire: tag(1) + authority_epoch(u64) = 9 bytes.
 *
 * BREAKING vs v17 (bare 1-byte tag): appends `authority_epoch` — a CAS check
 * (strict `current == expected`). Pass the LIVE current epoch, NOT current+1.
 *
 * @param authorityEpoch Live-read current authority_epoch (CAS, expected-current).
 */
export function encodeCloseSlab(authorityEpoch: bigint | string): Uint8Array {
  return concatBytes(encU8(IX_TAG.CloseSlab), encU64(authorityEpoch));
}

/**
 * UpdateConfig instruction data.
 *
 * 35 bytes: tag(1) + funding_horizon_slots(8) + funding_k_bps(8) +
 * funding_max_premium_bps(8) + funding_max_e9_per_slot(8) +
 * tvl_insurance_cap_mult(2). Wire layout matches v12.19 wrapper at
 * src/percolator.rs:2027-2041 (handle_update_config decode).
 */
export interface UpdateConfigArgs {
  fundingHorizonSlots: bigint | string;
  fundingKBps: bigint | string;
  fundingMaxPremiumBps: bigint | string;
  fundingMaxBpsPerSlot: bigint | string;
  /**
   * u16 deposit cap multiplier. 0 disables the protocol-enforced cap.
   * Wrapper field added at src/percolator.rs:2031.
   */
  tvlInsuranceCapMult?: number;
}

/** @deprecated v12.x UpdateConfig (old tag 14). Not in v17. */
export function encodeUpdateConfig(_args: UpdateConfigArgs): Uint8Array {
  return removedInstruction("UpdateConfig (v12 tag 14 — not in v17)", IX_TAG.UpdateConfig, undefined);
}

/**
 * @deprecated Tag 15 removed in v12.17. Maintenance fee is set at InitMarket only.
 * Sending this instruction will fail with InvalidInstructionData.
 */
export interface SetMaintenanceFeeArgs {
  newFee: bigint | string;
}

/** @deprecated Tag 15 removed in v12.17. Will fail on-chain. */
export function encodeSetMaintenanceFee(_args: SetMaintenanceFeeArgs): Uint8Array {
  return removedInstruction("SetMaintenanceFee", IX_TAG.SetMaintenanceFee, "encodeInitMarket()");
}

/**
 * SetOraclePriceCap instruction data (9 bytes)
 * Set oracle price circuit breaker cap (admin only).
 *
 * max_change_e2bps: maximum oracle price movement per slot in 0.01 bps units.
 *   1_000_000 = 100% max move per slot.
 *
 * ⚠️ PERC-8191 (PR#150): cap=0 is NO LONGER accepted for admin-oracle markets.
 *   - Hyperp markets: rejected if cap < DEFAULT_HYPERP_PRICE_CAP_E2BPS (1000).
 *   - Admin-oracle markets: rejected if cap == 0 (circuit breaker bypass prevention).
 *   - Pyth-pinned markets: immune (oracle_authority zeroed), any value accepted.
 *
 * Use a non-zero cap for all admin-oracle and Hyperp markets.
 */
export interface SetOraclePriceCapArgs {
  maxChangeE2bps: bigint | string;
}

/** @deprecated v12.x SetOraclePriceCap (old tag 16). Not in v17. */
export function encodeSetOraclePriceCap(_args: SetOraclePriceCapArgs): Uint8Array {
  return removedInstruction("SetOraclePriceCap (v12 tag 16 — not in v17)", IX_TAG.SetOraclePriceCap, undefined);
}

/**
 * ResolveMode constants — retained for source compatibility with v12.x callers.
 *
 * @deprecated v17 ResolveMarket (tag 19) has no mode byte. These constants are
 * no longer encoded into the instruction data. They may be used in logging or
 * off-chain logic but must not be passed to encodeResolveMarket.
 */
export const RESOLVE_MODE_ORDINARY = 0 as const;
export const RESOLVE_MODE_DEGENERATE = 1 as const;
export type ResolveMode = typeof RESOLVE_MODE_ORDINARY | typeof RESOLVE_MODE_DEGENERATE;

/**
 * ResolveMarket instruction data (v18 wire, integration `a9318945`).
 *
 * v18 wire: tag(1) + asset_generation_frontier(u64) + authority_epoch(u64) = 17 bytes.
 *
 * BREAKING vs v17 (bare 1-byte tag): the v16-migration identity-binding
 * overhaul adds `asset_generation_frontier` (the caller's live-read view of
 * the market's asset-set generation, guarding against resolving mid asset
 * activation/retirement) and `authority_epoch` (CAS — the live current
 * epoch, not current+1).
 *
 * The `mode` argument remains accepted for v12.x source compatibility but is
 * silently ignored — v18 ResolveMarket has no mode byte either.
 *
 * @param assetGenerationFrontier  Live-read current asset-set generation.
 * @param authorityEpoch           Live-read current authority_epoch (CAS, expected-current).
 *
 * @example
 * ```ts
 * const data = encodeResolveMarket({
 *   assetGenerationFrontier: cfg.assetSetEpoch,
 *   authorityEpoch: 0n,
 * });
 * ```
 */
export function encodeResolveMarket(
  args: { mode?: ResolveMode; assetGenerationFrontier: bigint | string; authorityEpoch: bigint | string },
): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.ResolveMarket),
    encU64(args.assetGenerationFrontier),
    encU64(args.authorityEpoch),
  );
}

/**
 * WithdrawInsurance instruction data.
 *
 * v17 wire: tag(1) + amount(u128 LE) = 17 bytes.
 *
 * BREAKING vs v12.x: amount(u128) is now REQUIRED. The v17 decoder at
 * tag 41 reads `amount: read_u128(&mut rest)?` — without 16 bytes of amount,
 * read_u128 returns Err(InvalidInstructionData). Every call with the old
 * 1-byte payload fails on devnet/mainnet.
 *
 * Withdraw insurance fund to admin (requires RESOLVED and all positions closed).
 *
 * @param amount  Amount to withdraw from the insurance fund (u128).
 *
 * @example
 * ```ts
 * const data = encodeWithdrawInsurance({ amount: 5_000_000n });
 * ```
 */
export interface WithdrawInsuranceArgs {
  amount: bigint | string;
}

export function encodeWithdrawInsurance(args: WithdrawInsuranceArgs): Uint8Array {
  return concatBytes(encU8(IX_TAG.WithdrawInsurance), encU128(args.amount));
}

/**
 * AdminForceClose instruction data (3 bytes)
 * Force-close any position at oracle price (admin only, skips margin checks).
 */
export interface AdminForceCloseArgs {
  targetIdx: number;
}

/** @deprecated v12.x AdminForceClose (old tag 17). Not in v17. */
export function encodeAdminForceClose(_args: AdminForceCloseArgs): Uint8Array {
  return removedInstruction("AdminForceClose (v12 tag 17 — not in v17)", IX_TAG.AdminForceClose, "encodeForceCloseAbandonedAsset() if applicable");
}

/**
 * @deprecated Tag 22 is now SetInsuranceWithdrawPolicy in v12.17.
 * This encoder sends the WRONG wire format (u64+u64 instead of pubkey+u64+u16+u64).
 * Use encodeSetInsuranceWithdrawPolicy instead.
 */
export interface UpdateRiskParamsArgs {
  initialMarginBps: bigint | string;
  maintenanceMarginBps: bigint | string;
  tradingFeeBps?: bigint | string;
}

/** @deprecated Use encodeSetInsuranceWithdrawPolicy (tag 22). This sends wrong wire format. */
export function encodeUpdateRiskParams(_args: UpdateRiskParamsArgs): Uint8Array {
  return removedInstruction(
    "UpdateRiskParams",
    IX_TAG.UpdateRiskParams,
    "encodeSetInsuranceWithdrawPolicy()",
  );
}

/**
 * On-chain confirmation code for RenounceAdmin (must match program constant).
 * ASCII "RENOUNCE" as u64 LE = 0x52454E4F554E4345.
 */
export const RENOUNCE_ADMIN_CONFIRMATION = 0x52454E4F554E4345n;

/**
 * On-chain confirmation code for UnresolveMarket (must match program constant).
 */
export const UNRESOLVE_CONFIRMATION = 0xDEAD_BEEF_CAFE_1234n;

/**
 * @deprecated Tag 23 is now WithdrawInsuranceLimited in v12.17.
 * This encoder sends the confirmation code as a withdrawal amount — DANGEROUS.
 * Use encodeWithdrawInsuranceLimited instead.
 */
export function encodeRenounceAdmin(): Uint8Array {
  return removedInstruction(
    "RenounceAdmin",
    IX_TAG.RenounceAdmin,
    "encodeWithdrawInsuranceLimited()",
  );
}

// ============================================================================
// PERC-627 / GH#1926: LpVaultWithdraw (tag 39)
// ============================================================================

/**
 * LpVaultWithdraw (Tag 39, PERC-627 / GH#1926 / PERC-8287) — burn LP vault tokens and
 * withdraw proportional collateral.
 *
 * **BREAKING (PR#170):** accounts[9] = creatorLockPda is now REQUIRED.
 * Always include `deriveCreatorLockPda(programId, slab)` at position 9.
 * Non-creator withdrawers pass the derived PDA; if no lock exists on-chain
 * the check is a no-op. Omitting this account causes `ExpectLenFailed` on-chain.
 *
 * Instruction data: tag(1) + lp_amount(8) = 9 bytes
 *
 * Accounts (use ACCOUNTS_LP_VAULT_WITHDRAW):
 *  [0] withdrawer        signer
 *  [1] slab              writable
 *  [2] withdrawerAta     writable
 *  [3] vault             writable
 *  [4] tokenProgram
 *  [5] lpVaultMint       writable
 *  [6] withdrawerLpAta   writable
 *  [7] vaultAuthority
 *  [8] lpVaultState      writable
 *  [9] creatorLockPda    writable  ← derive with deriveCreatorLockPda(programId, slab)
 *
 * @param lpAmount - Amount of LP vault tokens to burn.
 *
 * @example
 * ```ts
 * import { encodeLpVaultWithdraw, ACCOUNTS_LP_VAULT_WITHDRAW, buildAccountMetas } from "@percolator/sdk";
 * import { deriveCreatorLockPda, deriveVaultAuthority } from "@percolator/sdk";
 *
 * const [creatorLockPda] = deriveCreatorLockPda(PROGRAM_ID, slabKey);
 * const [vaultAuthority] = deriveVaultAuthority(PROGRAM_ID, slabKey);
 *
 * const data = encodeLpVaultWithdraw({ lpAmount: 1_000_000_000n });
 * const keys = buildAccountMetas(ACCOUNTS_LP_VAULT_WITHDRAW, {
 *   withdrawer, slab: slabKey, withdrawerAta, vault, tokenProgram: TOKEN_PROGRAM_ID,
 *   lpVaultMint, withdrawerLpAta, vaultAuthority, lpVaultState, creatorLockPda,
 * });
 * ```
 */
export interface LpVaultWithdrawArgs {
  /** Amount of LP vault tokens to burn. */
  lpAmount: bigint | string;
}

/**
 * @deprecated v12.x LpVaultWithdraw (tag 39 in v12, now alias 76=RequestRedeemLpShares in v17).
 * v17 uses a 2-step request/execute redemption flow — see encodeRequestRedeemLpSharesV22.
 */
export function encodeLpVaultWithdraw(_args: LpVaultWithdrawArgs): Uint8Array {
  return removedInstruction(
    "LpVaultWithdraw (v12 wire, tag 39→76 alias — wire format changed)",
    IX_TAG.LpVaultWithdraw,
    "encodeRequestRedeemLpSharesV22() + encodeExecuteRedemption()",
  );
}

/**
 * @deprecated v12.x PauseMarket (old tag 56). v17 reuses tag 56 for TopUpInsuranceDomain.
 */
export function encodePauseMarket(): Uint8Array {
  return removedInstruction("PauseMarket (v12 tag 56 — now TopUpInsuranceDomain in v17)", IX_TAG.PauseMarket, undefined);
}

/**
 * @deprecated v12.x UnpauseMarket (old tag 58). v17 reuses tag 58 for UpdateFeeRedirectPolicy.
 */
export function encodeUnpauseMarket(): Uint8Array {
  return removedInstruction("UnpauseMarket (v12 tag 58 — now UpdateFeeRedirectPolicy in v17)", IX_TAG.UnpauseMarket, undefined);
}

// ============================================================================
// PERC-117: Pyth Oracle CPI Instructions
// ============================================================================

/**
 * @deprecated Tag 32 removed in v12.17. Pyth oracle is configured at InitMarket via indexFeedId.
 * Sending this instruction will fail with InvalidInstructionData.
 */
export interface SetPythOracleArgs {
  feedId: Uint8Array;
  maxStalenessSecs: bigint;
  confFilterBps: number;
}

/** @deprecated Tag 32 removed in v12.17. Pyth is configured at InitMarket. */
export function encodeSetPythOracle(args: SetPythOracleArgs): Uint8Array {
  void args;
  return removedInstruction("SetPythOracle", IX_TAG.SetPythOracle, "encodeInitMarket()");
}

/**
 * Derive the expected Pyth PriceUpdateV2 account address for a given feed ID.
 * Uses PDA seeds: [shard_id(2), feed_id(32)] under the Pyth Receiver program.
 *
 * @param feedId  32-byte Pyth feed ID
 * @param shardId Shard index (default 0 for mainnet/devnet)
 */
export const PYTH_RECEIVER_PROGRAM_ID = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ';

export async function derivePythPriceUpdateAccount(
  feedId: Uint8Array,
  shardId = 0,
): Promise<string> {
  if (!(feedId instanceof Uint8Array) || feedId.length !== 32) {
    throw new Error(`derivePythPriceUpdateAccount: feedId must be 32 bytes, got ${feedId?.length ?? "invalid"}`);
  }
  if (!Number.isInteger(shardId) || shardId < 0 || shardId > 0xffff) {
    throw new Error(`derivePythPriceUpdateAccount: shardId must be a u16, got ${shardId}`);
  }
  const { PublicKey } = await import('@solana/web3.js');
  const shardBuf = new Uint8Array(2);
  new DataView(shardBuf.buffer).setUint16(0, shardId, true);
  const [pda] = PublicKey.findProgramAddressSync(
    [shardBuf, feedId],
    new PublicKey(PYTH_RECEIVER_PROGRAM_ID),
  );
  return pda.toBase58();
}

// SetPythOracle tag (32) is already defined in IX_TAG above.

// PERC-118: Mark Price EMA Instructions
// ============================================================================

// Tag 33 — permissionless mark price EMA crank (defined in IX_TAG above).

/**
 * @deprecated Tag 33 removed in v12.17. Use UpdateHyperpMark (tag 34) for DEX-oracle markets.
 * Sending this instruction will fail with InvalidInstructionData.
 */
export function encodeUpdateMarkPrice(): Uint8Array {
  return removedInstruction("UpdateMarkPrice", IX_TAG.UpdateMarkPrice, "encodeUpdateHyperpMark()");
}

/**
 * Mark price EMA parameters (must match program/src/percolator.rs constants).
 */
export const MARK_PRICE_EMA_WINDOW_SLOTS = 72_000n;
export const MARK_PRICE_EMA_ALPHA_E6 = 2_000_000n / (MARK_PRICE_EMA_WINDOW_SLOTS + 1n);

/**
 * Compute the next EMA mark price step (TypeScript mirror of the on-chain function).
 */
export function computeEmaMarkPrice(
  markPrevE6: bigint,
  oracleE6: bigint,
  dtSlots: bigint,
  alphaE6 = MARK_PRICE_EMA_ALPHA_E6,
  capE2bps = 0n,
): bigint {
  if (oracleE6 === 0n) return markPrevE6;
  if (markPrevE6 === 0n || dtSlots === 0n) return oracleE6;

  let oracleClamped = oracleE6;
  if (capE2bps > 0n) {
    // Avoid overflow: divide early to reduce intermediate product
    const maxDelta = (markPrevE6 * capE2bps / 1_000_000n) * dtSlots;
    const lo = markPrevE6 > maxDelta ? markPrevE6 - maxDelta : 0n;
    const hi = markPrevE6 + maxDelta;
    if (oracleClamped < lo) oracleClamped = lo;
    if (oracleClamped > hi) oracleClamped = hi;
  }

  const effectiveAlpha = alphaE6 * dtSlots > 1_000_000n ? 1_000_000n : alphaE6 * dtSlots;
  const oneMinusAlpha = 1_000_000n - effectiveAlpha;

  return (oracleClamped * effectiveAlpha + markPrevE6 * oneMinusAlpha) / 1_000_000n;
}

// PERC-119: Hyperp EMA Oracle for Permissionless Tokens
// ============================================================================

// Tag 34 — permissionless Hyperp mark price oracle (defined in IX_TAG above).

/**
 * UpdateHyperpMark (Tag 34) — permissionless Hyperp EMA oracle crank.
 *
 * Reads the spot price from a PumpSwap, Raydium CLMM, or Meteora DLMM pool,
 * applies 8-hour EMA smoothing with circuit breaker, and writes the new mark
 * to authority_price_e6 on the slab.
 *
 * This is the core mechanism for permissionless token markets — no Pyth or
 * Chainlink feed is needed. The DEX AMM IS the oracle.
 *
 * Instruction data: 1 byte (tag only)
 *
 * Accounts:
 *   0. [writable] Slab
 *   1. []         DEX pool account (PumpSwap / Raydium CLMM / Meteora DLMM)
 *   2. []         Clock sysvar (SysvarC1ock11111111111111111111111111111111)
 *   3..N []       Remaining accounts (e.g. PumpSwap vault0 + vault1)
 */
export function encodeUpdateHyperpMark(): Uint8Array {
  // v17: tag 34 is ConfigureHybridOracle (a large payload), NOT a 1-byte DEX-pool mark crank.
  // Emitting [34] would be decoded as ConfigureHybridOracle with an empty body → InvalidInstructionData.
  // The v12 hyperp DEX-pool mark mode was removed; fail loud instead of building a rejected tx.
  return removedInstruction(
    "UpdateHyperpMark (v12 DEX-pool mark crank — tag 34 is ConfigureHybridOracle in v17)",
    34,
    "ConfigureHybridOracle (tag 34) / ConfigureEwmaMark (tag 35), or PermissionlessCrank (tag 5) for mark refresh",
  );
}

// ============================================================================
// PERC-306: Per-Market Insurance Isolation
// ============================================================================

/**
 * @deprecated v12.x FundMarketInsurance (old tag 25). Not in v17.
 */
export function encodeFundMarketInsurance(_args: { amount: bigint }): Uint8Array {
  return removedInstruction("FundMarketInsurance (v12 tag 25 — not in v17)", IX_TAG.FundMarketInsurance, undefined);
}

/**
 * Set insurance isolation BPS for a market.
 * Accounts: [admin(signer), slab(writable)]
 */
export function encodeSetInsuranceIsolation(args: { bps: number }): Uint8Array {
  void args;
  return removedInstruction(
    "SetInsuranceIsolation",
    IX_TAG.SetInsuranceIsolation,
    "encodeFundMarketInsurance()",
  );
}

// ============================================================================
// NOTE: encodeExecuteAdl() was historically removed when it was discovered
// that PERC-305 was NOT implemented on-chain and tag 43 was ChallengeSettlement.
// PERC-305 (ExecuteAdl) is now live at tag 50. Encoder added below.
// ============================================================================

// ============================================================================
// PERC-309: QueueWithdrawal / ClaimQueuedWithdrawal / CancelQueuedWithdrawal
// ============================================================================

/**
 * QueueWithdrawal (Tag 47, PERC-309) — queue a large LP withdrawal.
 *
 * Creates a withdraw_queue PDA. The LP tokens are claimed in epoch tranches
 * via ClaimQueuedWithdrawal. Call CancelQueuedWithdrawal to abort.
 *
 * Accounts: [user(signer,writable), slab(writable), lpVaultState, withdrawQueue(writable), systemProgram]
 *
 * @param lpAmount - Amount of LP tokens to queue for withdrawal.
 *
 * @example
 * ```ts
 * const data = encodeQueueWithdrawal({ lpAmount: 1_000_000_000n });
 * ```
 */
/** @deprecated v12.x QueueWithdrawal (old tag 102). Not in v17. */
export function encodeQueueWithdrawal(_args: { lpAmount: bigint | string }): Uint8Array {
  return removedInstruction("QueueWithdrawal (v12 tag 102 — not in v17)", IX_TAG.QueueWithdrawal, "encodeRequestRedeemLpSharesV22()");
}

/**
 * ClaimQueuedWithdrawal (Tag 48, PERC-309) — claim one epoch tranche from a queued withdrawal.
 *
 * Burns LP tokens and releases one tranche of SOL to the user.
 * Call once per epoch until epochs_remaining == 0.
 *
 * Accounts: [user(signer,writable), slab(writable), withdrawQueue(writable),
 *            lpVaultMint(writable), userLpAta(writable), vault(writable),
 *            userAta(writable), vaultAuthority, tokenProgram, lpVaultState(writable)]
 */
/** @deprecated v12.x ClaimQueuedWithdrawal (old tag 103). Not in v17. */
export function encodeClaimQueuedWithdrawal(): Uint8Array {
  return removedInstruction("ClaimQueuedWithdrawal (v12 tag 103 — not in v17)", IX_TAG.ClaimQueuedWithdrawal, undefined);
}

/**
 * CancelQueuedWithdrawal (Tag 49, PERC-309) — cancel a queued withdrawal, refund remaining LP.
 *
 * Closes the withdraw_queue PDA and returns its rent lamports to the user.
 * The queued LP amount that was not yet claimed is NOT refunded — it is burned.
 * Use only to abandon a partial withdrawal.
 *
 * Accounts: [user(signer,writable), slab, withdrawQueue(writable)]
 */
/** @deprecated v12.x CancelQueuedWithdrawal (old tag 104). Not in v17. */
export function encodeCancelQueuedWithdrawal(): Uint8Array {
  return removedInstruction("CancelQueuedWithdrawal (v12 tag 104 — not in v17)", IX_TAG.CancelQueuedWithdrawal, undefined);
}

// ============================================================================
// PERC-305: ExecuteAdl (Tag 50) — Auto-Deleverage
// ============================================================================

/**
 * ExecuteAdl (Tag 50, PERC-305) — auto-deleverage the most profitable position.
 *
 * Permissionless. Surgically closes or reduces `targetIdx` position when
 * `pnl_pos_tot > max_pnl_cap` on the market. The caller receives no reward —
 * the incentive is unblocking the market for normal trading.
 *
 * Requires `UpdateRiskParams.max_pnl_cap > 0` on the market.
 *
 * Accounts: [caller(signer), slab(writable), clock, oracle, ...backupOracles?]
 *
 * @param targetIdx - Account index of the position to deleverage.
 *
 * @example
 * ```ts
 * const data = encodeExecuteAdl({ targetIdx: 5 });
 * ```
 */
export interface ExecuteAdlArgs {
  targetIdx: number;
}

/** @deprecated v12.x ExecuteAdl (old tag 101). Not in v17. */
export function encodeExecuteAdl(_args: ExecuteAdlArgs): Uint8Array {
  return removedInstruction("ExecuteAdl (v12 tag 101 — not in v17)", IX_TAG.ExecuteAdl, undefined);
}

// ============================================================================
// CloseStaleSlabs (Tag 51) / ReclaimSlabRent (Tag 52) — Slab recovery
// ============================================================================

/**
 * CloseStaleSlabs (Tag 51) — close a slab of an invalid/old layout and recover rent SOL.
 *
 * Admin only. Skips slab_guard; validates header magic + admin authority instead.
 * Use for slabs created by old program layouts (e.g. pre-PERC-120 devnet deploys)
 * whose size does not match any current valid tier.
 *
 * Accounts: [dest(signer,writable), slab(writable)]
 */
/** @deprecated v12.x CloseStaleSlabs (old tag 100). Not in v17. */
export function encodeCloseStaleSlabs(): Uint8Array {
  return removedInstruction("CloseStaleSlabs (v12 tag 100 — not in v17)", IX_TAG.CloseStaleSlabs, undefined);
}

/**
 * ReclaimSlabRent (Tag 52) — reclaim rent from an uninitialised slab.
 *
 * For use when market creation failed mid-flow (slab funded but InitMarket not called).
 * The slab account must sign (proves the caller holds the slab keypair).
 * Cannot close an initialised slab (magic == PERCOLAT) — use CloseSlab (tag 13).
 *
 * Accounts: [dest(signer,writable), slab(signer,writable)]
 */
/** @deprecated v12.x ReclaimSlabRent (old tag 99). Not in v17. */
export function encodeReclaimSlabRent(): Uint8Array {
  return removedInstruction("ReclaimSlabRent (v12 tag 99 — not in v17)", IX_TAG.ReclaimSlabRent, undefined);
}

// ============================================================================
// AuditCrank (Tag 53) — Permissionless on-chain invariant check
// ============================================================================

/**
 * AuditCrank (Tag 53) — verify conservation invariants on-chain (permissionless).
 *
 * Walks all accounts and verifies: capital sum, pnl_pos_tot, total_oi, LP consistency,
 * and solvency. Sets FLAG_PAUSED on violation (with a 150-slot cooldown guard to
 * prevent DoS from transient failures).
 *
 * Accounts: [slab(writable)]
 *
 * @example
 * ```ts
 * const data = encodeAuditCrank();
 * ```
 */
/** @deprecated v12.x AuditCrank (old tag 91). Not in v17. */
export function encodeAuditCrank(): Uint8Array {
  return removedInstruction("AuditCrank (v12 tag 91 — not in v17)", IX_TAG.AuditCrank, undefined);
}

// ============================================================================
// v18 wire (integration `a9318945`) — encoders added for the first time by
// the v16-migration SDK update. These tags existed in the v17 wrapper (some
// unchanged, some reshaped) but had NO encoder anywhere in this file before
// now.
// ============================================================================

/**
 * UpdateAssetLifecycle (tag 40) — activate, retire or reconfigure an asset
 * slot (v18 wire, integration `a9318945`).
 *
 * Wire: tag(1) + action(u8) + asset_index(u16) + market_id(u64) +
 *   authority_epoch(u64) + now_slot(u64) + initial_price(u64) +
 *   max_init_fee(u128) + insurance_authority[32] + insurance_operator[32] +
 *   backing_bucket_authority[32] + oracle_authority[32] = 180 bytes.
 *
 * BREAKING vs v17: adds `market_id` and `authority_epoch` (right after
 * `asset_index`) and `max_init_fee` (u128, right after `initial_price`).
 * `authority_epoch` is a CAS check against the TARGET asset's own
 * `AssetControlSequencesV16.authority_epoch` lane — pass the LIVE current
 * epoch, NOT current+1.
 *
 * @param action   Lifecycle action byte (program-defined — activate/retire/reconfigure).
 * @param assetIndex Asset index being acted on.
 * @param marketId   The asset's market_id.
 * @param authorityEpoch  Live-read current authority_epoch for this asset (CAS, expected-current).
 * @param nowSlot    Current slot.
 * @param initialPrice  Initial mark price in e6 units.
 * @param maxInitFee    Maximum permissionless-market-init fee the caller will accept (u128).
 * @param insuranceAuthority     New/current insurance authority for this asset.
 * @param insuranceOperator      New/current insurance operator for this asset.
 * @param backingBucketAuthority New/current backing-bucket authority for this asset.
 * @param oracleAuthority        New/current oracle authority for this asset.
 */
export interface UpdateAssetLifecycleArgs {
  action: number;
  assetIndex: number;
  marketId: bigint | string;
  authorityEpoch: bigint | string;
  nowSlot: bigint | string;
  initialPrice: bigint | string;
  maxInitFee: bigint | string;
  insuranceAuthority: PublicKey | string;
  insuranceOperator: PublicKey | string;
  backingBucketAuthority: PublicKey | string;
  oracleAuthority: PublicKey | string;
}

export function encodeUpdateAssetLifecycle(args: UpdateAssetLifecycleArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.UpdateAssetLifecycle),
    encU8(args.action),
    encU16(args.assetIndex),
    encU64(args.marketId),
    encU64(args.authorityEpoch),
    encU64(args.nowSlot),
    encU64(args.initialPrice),
    encU128(args.maxInitFee),
    encPubkey(args.insuranceAuthority),
    encPubkey(args.insuranceOperator),
    encPubkey(args.backingBucketAuthority),
    encPubkey(args.oracleAuthority),
  );
}

/**
 * CureAndCancelClose (tag 42) — deposit to cure a bankrupt/closing portfolio
 * and cancel its in-progress close (v18 wire, integration `a9318945`).
 *
 * Wire: tag(1) + portfolio_id(u64) + position_epoch(u64) +
 *   optional_deposit(u128) = 33 bytes.
 *
 * BREAKING vs v17 (17-byte, deposit-only payload): CAS-binds to the
 * portfolio's identity and current position epoch (both live-read).
 *
 * @param portfolioId      The portfolio's program-assigned identity.
 * @param positionEpoch    The portfolio's current position epoch, read live.
 * @param optionalDeposit  Atoms to deposit while curing (u128; 0 = no deposit, cancel only).
 */
export interface CureAndCancelCloseArgs {
  portfolioId: bigint | string;
  positionEpoch: bigint | string;
  optionalDeposit: bigint | string;
}

export function encodeCureAndCancelClose(args: CureAndCancelCloseArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.CureAndCancelClose),
    encU64(args.portfolioId),
    encU64(args.positionEpoch),
    encU128(args.optionalDeposit),
  );
}

/**
 * ForfeitRecoveryLeg (tag 43) — forfeit a leg's residual B budget during
 * bankruptcy recovery (v18 wire, integration `a9318945`).
 *
 * Wire: tag(1) + portfolio_id(u64) + position_epoch(u64) + asset_index(u16) +
 *   b_loss_atom_budget(u128) = 35 bytes.
 *
 * BREAKING vs v17: adds `portfolio_id`/`position_epoch` CAS binding (both
 * live-read) BEFORE `asset_index`. The trailing field itself was also
 * renamed on the wrapper side: `b_delta_budget` -> `b_loss_atom_budget`
 * (same position/type/width — cosmetic rename only, not a wire-shape
 * change).
 *
 * @param portfolioId      The portfolio's program-assigned identity.
 * @param positionEpoch    The portfolio's current position epoch, read live.
 * @param assetIndex       Leg's asset index.
 * @param bLossAtomBudget  Budget of B-domain loss atoms to forfeit (u128).
 */
export interface ForfeitRecoveryLegArgs {
  portfolioId: bigint | string;
  positionEpoch: bigint | string;
  assetIndex: number;
  bLossAtomBudget: bigint | string;
}

export function encodeForfeitRecoveryLeg(args: ForfeitRecoveryLegArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.ForfeitRecoveryLeg),
    encU64(args.portfolioId),
    encU64(args.positionEpoch),
    encU16(args.assetIndex),
    encU128(args.bLossAtomBudget),
  );
}

/**
 * RebalanceReduce (tag 44) — reduce a leg's position during bankruptcy
 * recovery rebalancing (v18 wire, integration `a9318945`).
 *
 * Wire: tag(1) + portfolio_id(u64) + position_epoch(u64) + asset_index(u16) +
 *   reduce_q(u128) = 35 bytes.
 *
 * BREAKING vs v17: adds `portfolio_id`/`position_epoch` CAS binding (both
 * live-read) BEFORE `asset_index`.
 *
 * @param portfolioId    The portfolio's program-assigned identity.
 * @param positionEpoch  The portfolio's current position epoch, read live.
 * @param assetIndex     Leg's asset index.
 * @param reduceQ        Quantity to reduce the leg by (u128).
 */
export interface RebalanceReduceArgs {
  portfolioId: bigint | string;
  positionEpoch: bigint | string;
  assetIndex: number;
  reduceQ: bigint | string;
}

export function encodeRebalanceReduce(args: RebalanceReduceArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.RebalanceReduce),
    encU64(args.portfolioId),
    encU64(args.positionEpoch),
    encU16(args.assetIndex),
    encU128(args.reduceQ),
  );
}

/**
 * UpdateBaseUnitMints (tag 60) — rotate the primary/secondary base-unit
 * mints (v18 wire, integration `a9318945`).
 *
 * Wire: tag(1) + primary_mint[32] + secondary_mint[32] + authority_epoch(u64)
 *   = 73 bytes.
 *
 * BREAKING vs v17 (65-byte payload): appends `authority_epoch` — a CAS
 * check (strict `current == expected`). Pass the LIVE current epoch, NOT
 * current+1.
 *
 * @param primaryMint     New primary base-unit mint.
 * @param secondaryMint   New secondary base-unit mint.
 * @param authorityEpoch  Live-read current authority_epoch (CAS, expected-current).
 */
export interface UpdateBaseUnitMintsArgs {
  primaryMint: PublicKey | string;
  secondaryMint: PublicKey | string;
  authorityEpoch: bigint | string;
}

export function encodeUpdateBaseUnitMints(args: UpdateBaseUnitMintsArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.UpdateBaseUnitMints),
    encPubkey(args.primaryMint),
    encPubkey(args.secondaryMint),
    encU64(args.authorityEpoch),
  );
}

/**
 * SwapSecondaryForPrimary (tag 61) — swap secondary base-unit atoms for
 * primary (v18 wire, integration `a9318945`).
 *
 * Wire: tag(1) + amount(u128) + authority_epoch(u64) = 25 bytes.
 *
 * BREAKING vs v17 (17-byte payload): appends `authority_epoch` — a CAS
 * check. Pass the LIVE current epoch, NOT current+1.
 *
 * @param amount          Secondary atoms to swap (u128).
 * @param authorityEpoch  Live-read current authority_epoch (CAS, expected-current).
 */
export interface SwapSecondaryForPrimaryArgs {
  amount: bigint | string;
  authorityEpoch: bigint | string;
}

export function encodeSwapSecondaryForPrimary(args: SwapSecondaryForPrimaryArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.SwapSecondaryForPrimary),
    encU128(args.amount),
    encU64(args.authorityEpoch),
  );
}

// ============================================================================
// SMART PRICE ROUTER — quote computation for LP selection
// ============================================================================

/**
 * Parsed vAMM matcher parameters (from on-chain matcher context account)
 */
export interface VammMatcherParams {
  mode: number;                    // 0 = Passive, 1 = vAMM
  tradingFeeBps: number;
  baseSpreadBps: number;
  maxTotalBps: number;
  impactKBps: number;
  liquidityNotionalE6: bigint;
}

/** Magic bytes identifying a vAMM matcher context: "PERCMATC" as u64 LE = 0x504552434d415443 */
export const VAMM_MAGIC = 0x504552434d415443n;
/** Alias matching the Rust constant name for parity tests */
export const MATCHER_MAGIC = VAMM_MAGIC;

/** Offset where matcher return is written in the context account (always 0 per ABI) */
export const CTX_RETURN_OFFSET = 0;
/** Byte length of the MatcherReturn section of the context account */
export const MATCHER_RETURN_LEN = 64;
/** Offset into matcher context where vAMM params start (= MATCHER_RETURN_LEN) */
export const CTX_VAMM_OFFSET = 64;
/** Byte length of the MatcherCtx (vAMM state) section of the context account */
export const CTX_VAMM_LEN = 256;
/** Total matcher context account size: MATCHER_RETURN_LEN + CTX_VAMM_LEN */
export const MATCHER_CONTEXT_LEN = 320;

// ============================================================================
// MatcherReturn (v18, integration `a9318945`) — the 64-byte CPI response a
// matcher program writes into its own context account for the wrapper to
// read back after `TradeCpi`/`BatchTradeCpi`. Locked wire per
// WRAPPER_SYNC_LOCKED_WIRE.md, byte-verified against
// `percolator-prog::matcher_abi::{MatcherReturn, read_matcher_return}`.
// ============================================================================

/** `matcher_abi::FLAG_VALID` — bit0 of `MatcherReturn.flags`. */
export const MATCHER_RETURN_FLAG_VALID = 1;
/** `matcher_abi::FLAG_PARTIAL_OK` — bit1 of `MatcherReturn.flags`. */
export const MATCHER_RETURN_FLAG_PARTIAL_OK = 2;
/** `matcher_abi::FLAG_REJECTED` — bit2 of `MatcherReturn.flags`. */
export const MATCHER_RETURN_FLAG_REJECTED = 4;
/**
 * `matcher_abi::FLAG_BACKING_FEE_CAP_SHIFT` (sync/w2-e24cf78e, ADOPT upstream
 * e24cf78e "require matcher consent for CPI backing fees"). Bits 8..21 of
 * `flags` carry the LP matcher's self-declared cap (bps, 0..=10000) on how
 * much backing-domain fee it consents to being charged on its own
 * (account_b) side of a CPI-filled trade. An unupgraded matcher (one that
 * never sets these bits) reads back cap=0, which fails closed — the wrapper
 * REJECTS any CPI trade that would actually charge a nonzero backing-domain
 * fee against the LP until the matcher program is updated to emit a real cap.
 */
export const MATCHER_RETURN_FLAG_BACKING_FEE_CAP_SHIFT = 8;
/** `matcher_abi::FLAG_BACKING_FEE_CAP_MASK` = `0x3fff << 8`. */
export const MATCHER_RETURN_FLAG_BACKING_FEE_CAP_MASK = 0x3fff << MATCHER_RETURN_FLAG_BACKING_FEE_CAP_SHIFT;
/**
 * Every flag bit the wrapper's `read_matcher_return` gate recognizes. ANY
 * bit outside this mask set anywhere in `flags` makes the wrapper reject the
 * whole CPI trade — matches the wrapper's own
 * `KNOWN_FLAGS = FLAG_VALID | FLAG_PARTIAL_OK | FLAG_REJECTED | FLAG_BACKING_FEE_CAP_MASK`
 * check exactly, and {@link decodeMatcherReturn} enforces the identical gate
 * client-side.
 */
export const MATCHER_RETURN_KNOWN_FLAGS =
  MATCHER_RETURN_FLAG_VALID |
  MATCHER_RETURN_FLAG_PARTIAL_OK |
  MATCHER_RETURN_FLAG_REJECTED |
  MATCHER_RETURN_FLAG_BACKING_FEE_CAP_MASK;

/**
 * Decoded 64-byte `MatcherReturn` — the CPI response wire, byte-identical to
 * `percolator-prog::matcher_abi::MatcherReturn`:
 *   abi_version:u32@0, flags:u32@4, exec_price_e6:u64@8, exec_size:i128@16,
 *   req_id:u64@32, lp_account_id:u64@40, oracle_price_e6:u64@48, asset_index:u64@56.
 */
export interface MatcherReturn {
  abiVersion: number;
  flags: number;
  execPriceE6: bigint;
  execSize: bigint;
  reqId: bigint;
  lpAccountId: bigint;
  oraclePriceE6: bigint;
  assetIndex: bigint;
  /** Decoded from `flags` bit0 (`FLAG_VALID`). */
  valid: boolean;
  /** Decoded from `flags` bit1 (`FLAG_PARTIAL_OK`). */
  partialOk: boolean;
  /** Decoded from `flags` bit2 (`FLAG_REJECTED`). */
  rejected: boolean;
  /**
   * Decoded from `flags` bits 8..21 (`FLAG_BACKING_FEE_CAP_MASK`), 0..=10000.
   * 0 fails closed against any nonzero backing-domain fee — see
   * {@link MATCHER_RETURN_FLAG_BACKING_FEE_CAP_SHIFT}'s doc comment.
   */
  backingFeeCapBps: number;
}

/**
 * Decode a 64-byte `MatcherReturn` from a matcher context account's raw
 * bytes, mirroring `percolator-prog::matcher_abi::read_matcher_return`
 * EXACTLY, including its `KNOWN_FLAGS` gate.
 *
 * @param data    Raw matcher context account bytes.
 * @param offset  Byte offset where the MatcherReturn starts (default
 *                {@link CTX_RETURN_OFFSET} = 0, per ABI).
 * @throws If `data` is too short, or `flags` has any bit set outside
 *   {@link MATCHER_RETURN_KNOWN_FLAGS} (matches the wrapper's own
 *   fail-closed gate — the wrapper would reject the CPI trade the same way).
 */
export function decodeMatcherReturn(data: Uint8Array, offset: number = CTX_RETURN_OFFSET): MatcherReturn {
  if (data.length < offset + MATCHER_RETURN_LEN) {
    throw new Error(
      `decodeMatcherReturn: data too short — need ${offset + MATCHER_RETURN_LEN} bytes, got ${data.length}`,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset + offset, MATCHER_RETURN_LEN);
  const abiVersion = view.getUint32(0, true);
  const flags = view.getUint32(4, true);
  const execPriceE6 = view.getBigUint64(8, true);
  const execSizeLo = view.getBigUint64(16, true);
  const execSizeHi = view.getBigUint64(24, true);
  let execSize = (execSizeHi << 64n) | execSizeLo;
  if (execSize >= 1n << 127n) execSize -= 1n << 128n; // i128 sign extension
  const reqId = view.getBigUint64(32, true);
  const lpAccountId = view.getBigUint64(40, true);
  const oraclePriceE6 = view.getBigUint64(48, true);
  const assetIndex = view.getBigUint64(56, true);

  if ((flags & ~MATCHER_RETURN_KNOWN_FLAGS) !== 0) {
    throw new Error(
      `decodeMatcherReturn: unknown flag bits set (flags=0x${flags.toString(16)}, ` +
      `known=0x${MATCHER_RETURN_KNOWN_FLAGS.toString(16)})`,
    );
  }

  return {
    abiVersion,
    flags,
    execPriceE6,
    execSize,
    reqId,
    lpAccountId,
    oraclePriceE6,
    assetIndex,
    valid: (flags & MATCHER_RETURN_FLAG_VALID) !== 0,
    partialOk: (flags & MATCHER_RETURN_FLAG_PARTIAL_OK) !== 0,
    rejected: (flags & MATCHER_RETURN_FLAG_REJECTED) !== 0,
    backingFeeCapBps: (flags & MATCHER_RETURN_FLAG_BACKING_FEE_CAP_MASK) >>> MATCHER_RETURN_FLAG_BACKING_FEE_CAP_SHIFT,
  };
}

/**
 * Encode a `MatcherReturn` to its 64-byte wire form — the inverse of
 * {@link decodeMatcherReturn}. Useful for a TypeScript-side reference/test
 * matcher writing its own CPI response.
 *
 * Composes `flags` from the individual boolean/bps fields rather than taking
 * a raw `flags` number, so a caller cannot accidentally set an unknown bit —
 * the wire is always exactly `MATCHER_RETURN_KNOWN_FLAGS`-clean by
 * construction.
 *
 * @param args  Same shape as {@link MatcherReturn} minus the derived `flags` field.
 */
export function encodeMatcherReturn(args: {
  abiVersion: number;
  execPriceE6: bigint | string;
  execSize: bigint | string;
  reqId: bigint | string;
  lpAccountId: bigint | string;
  oraclePriceE6: bigint | string;
  assetIndex: bigint | string;
  valid: boolean;
  partialOk: boolean;
  rejected: boolean;
  backingFeeCapBps: number;
}): Uint8Array {
  if (args.backingFeeCapBps < 0 || args.backingFeeCapBps > 10_000) {
    throw new Error(`encodeMatcherReturn: backingFeeCapBps must be 0..=10000, got ${args.backingFeeCapBps}`);
  }
  const flags =
    (args.valid ? MATCHER_RETURN_FLAG_VALID : 0) |
    (args.partialOk ? MATCHER_RETURN_FLAG_PARTIAL_OK : 0) |
    (args.rejected ? MATCHER_RETURN_FLAG_REJECTED : 0) |
    ((args.backingFeeCapBps << MATCHER_RETURN_FLAG_BACKING_FEE_CAP_SHIFT) & MATCHER_RETURN_FLAG_BACKING_FEE_CAP_MASK);

  return concatBytes(
    encU32(args.abiVersion),
    encU32(flags),
    encU64(args.execPriceE6),
    encI128(args.execSize),
    encU64(args.reqId),
    encU64(args.lpAccountId),
    encU64(args.oraclePriceE6),
    encU64(args.assetIndex),
  );
}

/** Byte length of a MatcherCall instruction (tag 0 CPI payload) */
export const MATCHER_CALL_LEN = 67;
/**
 * Byte length of an InitMatcherCtx instruction payload sent to the matcher program.
 * Layout: tag(1) + kind(1) + trading_fee_bps(4) + base_spread_bps(4) +
 *   max_total_bps(4) + impact_k_bps(4) + liquidity_notional_e6(16) +
 *   max_fill_abs(16) + max_inventory_abs(16) + fee_to_insurance_bps(2) +
 *   skew_spread_mult_bps(2) + lp_account_id(8) = 78
 */
export const INIT_CTX_LEN = 78;

const BPS_DENOM = 10_000n;

/**
 * Compute execution price for a given LP quote.
 * For buys (isLong=true): price above oracle.
 * For sells (isLong=false): price below oracle.
 */
export function computeVammQuote(
  params: VammMatcherParams,
  oraclePriceE6: bigint,
  tradeSize: bigint,
  isLong: boolean,
): bigint {
  const absSize = tradeSize < 0n ? -tradeSize : tradeSize;
  const absNotionalE6 = (absSize * oraclePriceE6) / 1_000_000n;

  // Impact for vAMM mode
  let impactBps = 0n;
  if (params.mode === 1 && params.liquidityNotionalE6 > 0n) {
    impactBps = (absNotionalE6 * BigInt(params.impactKBps)) / params.liquidityNotionalE6;
  }

  // Total = base_spread + trading_fee + impact, capped at max_total
  const maxTotal = BigInt(params.maxTotalBps);
  const baseFee = BigInt(params.baseSpreadBps) + BigInt(params.tradingFeeBps);
  const maxImpact = maxTotal > baseFee ? maxTotal - baseFee : 0n;
  const clampedImpact = impactBps < maxImpact ? impactBps : maxImpact;
  let totalBps = baseFee + clampedImpact;
  if (totalBps > maxTotal) totalBps = maxTotal;

  if (isLong) {
    return (oraclePriceE6 * (BPS_DENOM + totalBps)) / BPS_DENOM;
  } else {
    // Prevent underflow: if totalBps >= BPS_DENOM, price would go negative
    if (totalBps >= BPS_DENOM) return 1n; // minimum 1 micro-dollar
    return (oraclePriceE6 * (BPS_DENOM - totalBps)) / BPS_DENOM;
  }
}

// ============================================================================
// PERC-622: AdvanceOraclePhase (permissionless crank)
// ============================================================================

/**
 * AdvanceOraclePhase (Tag 56) — permissionless oracle phase advancement.
 *
 * Checks if a market should transition from Phase 0→1→2 based on
 * time elapsed and cumulative volume. Anyone can call this.
 *
 * Instruction data: 1 byte (tag only)
 *
 * Accounts:
 *   0. [writable] Slab
 */
/** @deprecated v12.x AdvanceOraclePhase (old tag 92). Not in v17. */
export function encodeAdvanceOraclePhase(): Uint8Array {
  return removedInstruction("AdvanceOraclePhase (v12 tag 92 — not in v17)", IX_TAG.AdvanceOraclePhase, undefined);
}

/** Oracle phase constants matching on-chain values */
export const ORACLE_PHASE_NASCENT = 0;
export const ORACLE_PHASE_GROWING = 1;
export const ORACLE_PHASE_MATURE = 2;

/** Phase transition thresholds (must match program constants) */
export const PHASE1_MIN_SLOTS = 648_000n;         // ~72h at 400ms
export const PHASE1_VOLUME_MIN_SLOTS = 36_000n;    // ~4h at 400ms
export const PHASE2_VOLUME_THRESHOLD = 100_000_000_000n; // $100K in e6
export const PHASE2_MATURITY_SLOTS = 3_024_000n;   // ~14 days at 400ms

/**
 * Check if an oracle phase transition is due (TypeScript mirror of on-chain logic).
 *
 * @returns [newPhase, shouldTransition]
 */
export function checkPhaseTransition(
  currentSlot: bigint,
  marketCreatedSlot: bigint,
  oraclePhase: number,
  cumulativeVolumeE6: bigint,
  phase2DeltaSlots: number,
  hasMatureOracle: boolean,
): [number, boolean] {
  switch (oraclePhase) {
    case 0: {
      const elapsed = currentSlot - (marketCreatedSlot > 0n ? marketCreatedSlot : currentSlot);
      const timeReady = elapsed >= PHASE1_MIN_SLOTS;
      const volumeReady = elapsed >= PHASE1_VOLUME_MIN_SLOTS
        && cumulativeVolumeE6 >= PHASE2_VOLUME_THRESHOLD;
      if (timeReady || volumeReady) {
        return [ORACLE_PHASE_GROWING, true];
      }
      return [ORACLE_PHASE_NASCENT, false];
    }
    case 1: {
      if (hasMatureOracle) return [ORACLE_PHASE_MATURE, true];
      const phase2Start = marketCreatedSlot + BigInt(phase2DeltaSlots);
      const elapsedSincePhase2 = currentSlot - phase2Start;
      if (elapsedSincePhase2 >= PHASE2_MATURITY_SLOTS) {
        return [ORACLE_PHASE_MATURE, true];
      }
      return [ORACLE_PHASE_GROWING, false];
    }
    default:
      return [ORACLE_PHASE_MATURE, false];
  }
}

// ============================================================================
// PERC-629: Dynamic Creation Deposit
// ============================================================================

/**
 * SlashCreationDeposit (Tag 58) — permissionless: slash a market creator's deposit
 * after the spam grace period has elapsed (PERC-629).
 *
 * **WARNING**: Tag 58 is reserved in tags.rs but has NO instruction decoder or
 * handler in the on-chain program. Sending this instruction will fail with
 * `InvalidInstructionData`. Do not use until the on-chain handler is deployed.
 *
 * Instruction data: 1 byte (tag only)
 *
 * Accounts:
 *   0. [signer]           Caller (anyone)
 *   1. []                 Slab
 *   2. [writable]         Creator history PDA
 *   3. [writable]         Insurance vault
 *   4. [writable]         Treasury
 *   5. []                 System program
 *
 * @deprecated Not yet implemented on-chain — will fail with InvalidInstructionData.
 */
export function encodeSlashCreationDeposit(): Uint8Array {
  return removedInstruction("SlashCreationDeposit", IX_TAG.SlashCreationDeposit);
}

// ============================================================================
// PERC-628: Elastic Shared Vault + Epoch Withdrawals
// ============================================================================

/**
 * InitSharedVault (Tag 59) — admin: create the global shared vault PDA (PERC-628).
 *
 * Instruction data: tag(1) + epochDurationSlots(8) + maxMarketExposureBps(2) = 11 bytes
 *
 * Accounts:
 *   0. [signer]           Admin
 *   1. [writable]         Shared vault PDA
 *   2. []                 System program
 */
export interface InitSharedVaultArgs {
  epochDurationSlots: bigint | string;
  maxMarketExposureBps: number;
}

/** @deprecated v12.x InitSharedVault (old tag 94). Not in v17. */
export function encodeInitSharedVault(_args: InitSharedVaultArgs): Uint8Array {
  return removedInstruction("InitSharedVault (v12 tag 94 — not in v17)", IX_TAG.InitSharedVault, undefined);
}

/**
 * AllocateMarket (Tag 60) — admin: allocate virtual liquidity from the shared vault
 * to a market (PERC-628).
 *
 * Instruction data: tag(1) + amount(16) = 17 bytes
 *
 * Accounts:
 *   0. [signer]           Admin
 *   1. []                 Slab
 *   2. [writable]         Shared vault PDA
 *   3. [writable]         Market alloc PDA
 *   4. []                 System program
 */
export interface AllocateMarketArgs {
  amount: bigint | string;
}

/** @deprecated v12.x AllocateMarket (old tag 95). Not in v17. */
export function encodeAllocateMarket(_args: AllocateMarketArgs): Uint8Array {
  return removedInstruction("AllocateMarket (v12 tag 95 — not in v17)", IX_TAG.AllocateMarket, undefined);
}

/**
 * QueueWithdrawalSV (Tag 61) — user: queue a withdrawal request for the current
 * epoch (PERC-628). Tokens are locked until the epoch elapses.
 *
 * Instruction data: tag(1) + lpAmount(8) = 9 bytes
 *
 * Accounts:
 *   0. [signer]           User
 *   1. [writable]         Shared vault PDA
 *   2. [writable]         Withdraw request PDA
 *   3. []                 System program
 */
export interface QueueWithdrawalSVArgs {
  lpAmount: bigint | string;
}

/** @deprecated v12.x QueueWithdrawalSV (old tag 96). Not in v17. */
export function encodeQueueWithdrawalSV(_args: QueueWithdrawalSVArgs): Uint8Array {
  return removedInstruction("QueueWithdrawalSV (v12 tag 96 — not in v17)", IX_TAG.QueueWithdrawalSV, undefined);
}

/**
 * ClaimEpochWithdrawal (Tag 62) — user: claim a queued withdrawal after the epoch
 * has elapsed (PERC-628). Receives pro-rata collateral from the vault.
 *
 * Instruction data: 1 byte (tag only)
 *
 * Accounts:
 *   0. [signer]           User
 *   1. [writable]         Shared vault PDA
 *   2. [writable]         Withdraw request PDA
 *   3. []                 Slab
 *   4. [writable]         Vault
 *   5. [writable]         User ATA
 *   6. []                 Vault authority
 *   7. []                 Token program
 */
/** @deprecated v12.x ClaimEpochWithdrawal (old tag 97). Not in v17. */
export function encodeClaimEpochWithdrawal(): Uint8Array {
  return removedInstruction("ClaimEpochWithdrawal (v12 tag 97 — not in v17)", IX_TAG.ClaimEpochWithdrawal, undefined);
}

/**
 * AdvanceEpoch (Tag 63) — permissionless crank: move the shared vault to the next
 * epoch once `epoch_duration_slots` have elapsed (PERC-628).
 *
 * Instruction data: 1 byte (tag only)
 *
 * Accounts:
 *   0. [signer]           Caller (anyone)
 *   1. [writable]         Shared vault PDA
 */
/** @deprecated v12.x AdvanceEpoch (old tag 98). Not in v17. */
export function encodeAdvanceEpoch(): Uint8Array {
  return removedInstruction("AdvanceEpoch (v12 tag 98 — not in v17)", IX_TAG.AdvanceEpoch, undefined);
}

// PERC-628: Tag 63 ─────────────────────────────────────────────────────────

// PERC-8110 ────────────────────────────────────────────────────────────────

/**
 * SetOiImbalanceHardBlock (Tag 71, PERC-8110) — set OI imbalance hard-block threshold (admin only).
 *
 * When `|long_oi − short_oi| / total_oi * 10_000 >= threshold_bps`, any new trade that would
 * *increase* the imbalance is rejected with `OiImbalanceHardBlock` (error code 59).
 *
 * - `threshold_bps = 0`: hard block disabled.
 * - `threshold_bps = 8_000`: block trades that push skew above 80%.
 * - `threshold_bps = 10_000`: never allow >100% skew (always blocks one side when oi > 0).
 *
 * Instruction data layout: tag(1) + threshold_bps(2) = 3 bytes
 *
 * Accounts:
 *   0. [signer]   admin
 *   1. [writable] slab
 *
 * @example
 * ```ts
 * const ix = new TransactionInstruction({
 *   programId: PROGRAM_ID,
 *   keys: buildAccountMetas(ACCOUNTS_SET_OI_IMBALANCE_HARD_BLOCK, { admin, slab }),
 *   data: Buffer.from(encodeSetOiImbalanceHardBlock({ thresholdBps: 8_000 })),
 * });
 * ```
 */
/** @deprecated v12.x SetOiImbalanceHardBlock (old tag 71). Not in v17. */
export function encodeSetOiImbalanceHardBlock(_args: { thresholdBps: number }): Uint8Array {
  return removedInstruction("SetOiImbalanceHardBlock (v12 tag 71 — not in v17)", IX_TAG.SetOiImbalanceHardBlock, undefined);
}

// ============================================================================
// PERC-608 — Position NFT instructions (tags 64–69)
// ============================================================================

/**
 * MintPositionNft (Tag 64, PERC-608) — mint a Token-2022 NFT representing a position.
 *
 * Creates a PositionNft PDA + Token-2022 mint with metadata, then mints 1 NFT to the
 * position owner's ATA. The NFT represents ownership of `user_idx` in the slab.
 *
 * The program creates the ATA internally via CPI when the 11th account (Associated Token
 * Program) is provided. This is required because the NFT mint PDA doesn't exist until the
 * program creates it, so the ATA can't be created in a preceding instruction.
 *
 * Instruction data layout: tag(1) + user_idx(2) = 3 bytes
 *
 * Accounts (11):
 *   0.  [signer, writable] payer
 *   1.  [writable]         slab
 *   2.  [writable]         position_nft PDA  (created — seeds: ["position_nft", slab, user_idx_u16_le])
 *   3.  [writable]         nft_mint PDA      (created — seeds: ["position_nft_mint", slab, user_idx_u16_le])
 *   4.  [writable]         owner_ata         (Token-2022 ATA for nft_mint — created by program if absent)
 *   5.  [signer]           owner             (must match engine account owner)
 *   6.  []                 vault_authority PDA (seeds: ["vault", slab])
 *   7.  []                 token_2022_program (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb)
 *   8.  []                 system_program
 *   9.  []                 rent sysvar
 *   10. []                 associated_token_program (ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL)
 */
export interface MintPositionNftArgs {
  userIdx: number;
}

/**
 * @deprecated v12.x MintPositionNft (old tag 64). v17 reuses tag 64 for ForceCloseAbandonedAsset.
 * NFT operations in v17 use the standalone percolator-nft program; use SetNftProgramId(73)
 * to register it and TransferPortfolioOwnership(72) for B-3 transfers.
 */
export function encodeMintPositionNft(_args: MintPositionNftArgs): Uint8Array {
  return removedInstruction(
    "MintPositionNft (v12 tag 64 — COLLIDES with v17 ForceCloseAbandonedAsset)",
    IX_TAG.MintPositionNft,
    "percolator-nft program",
  );
}

/**
 * TransferPositionOwnership (Tag 65, PERC-608) — transfer an open position to a new owner.
 *
 * Transfers the Token-2022 NFT from current owner to new owner and updates the on-chain
 * engine account's owner field. Requires `pending_settlement == 0`.
 *
 * Instruction data layout: tag(1) + user_idx(2) = 3 bytes
 *
 * Accounts:
 *   0. [signer, writable] current_owner
 *   1. [writable]         slab
 *   2. [writable]         position_nft PDA
 *   3. [writable]         nft_mint PDA
 *   4. [writable]         current_owner_ata  (source Token-2022 ATA)
 *   5. [writable]         new_owner_ata      (destination Token-2022 ATA)
 *   6. []                 new_owner
 *   7. []                 token_2022_program
 */
export interface TransferPositionOwnershipArgs {
  userIdx: number;
}

/**
 * @deprecated v12.x TransferPositionOwnership (old tag 65). v17 reuses tag 65 for UpdateAssetAuthority.
 * Use encodeTransferPortfolioOwnership() (tag 72) for B-3 ownership transfer in v17.
 */
export function encodeTransferPositionOwnership(_args: TransferPositionOwnershipArgs): Uint8Array {
  return removedInstruction(
    "TransferPositionOwnership (v12 tag 65 — COLLIDES with v17 UpdateAssetAuthority)",
    IX_TAG.TransferPositionOwnership,
    "encodeTransferPortfolioOwnership() (tag 72)",
  );
}

/**
 * BurnPositionNft (Tag 66, PERC-608) — burn the Position NFT when a position is closed.
 *
 * Burns the NFT, closes the PositionNft PDA and the mint PDA, returning rent to the owner.
 * Can only be called after the position is fully closed (size == 0).
 *
 * Instruction data layout: tag(1) + user_idx(2) = 3 bytes
 *
 * Accounts:
 *   0. [signer, writable] owner
 *   1. [writable]         slab
 *   2. [writable]         position_nft PDA  (closed — rent to owner)
 *   3. [writable]         nft_mint PDA      (closed via Token-2022 close_account)
 *   4. [writable]         owner_ata         (Token-2022 ATA, balance burned)
 *   5. []                 vault_authority PDA
 *   6. []                 token_2022_program
 */
export interface BurnPositionNftArgs {
  userIdx: number;
}

/**
 * @deprecated v12.x BurnPositionNft (old tag 66). v17 reuses tag 66 for BatchTradeNoCpi.
 * NFT burn is handled by the standalone percolator-nft program in v17.
 */
export function encodeBurnPositionNft(_args: BurnPositionNftArgs): Uint8Array {
  return removedInstruction(
    "BurnPositionNft (v12 tag 66 — COLLIDES with v17 BatchTradeNoCpi)",
    IX_TAG.BurnPositionNft,
    "percolator-nft program",
  );
}

/**
 * SetPendingSettlement (Tag 67, PERC-608) — keeper sets the pending_settlement flag.
 *
 * Called by the keeper/admin before performing a funding settlement transfer.
 * Blocks NFT transfers until ClearPendingSettlement is called.
 * Admin-only (protected by GH#1475 keeper allowlist guard).
 *
 * Instruction data layout: tag(1) + user_idx(2) = 3 bytes
 *
 * Accounts:
 *   0. [signer]   keeper / admin
 *   1. []         slab  (read — for PDA verification + admin check)
 *   2. [writable] position_nft PDA
 */
export interface SetPendingSettlementArgs {
  userIdx: number;
}

/**
 * @deprecated v12.x SetPendingSettlement (old tag 67). v17 reuses tag 67 for BatchTradeCpi.
 */
export function encodeSetPendingSettlement(_args: SetPendingSettlementArgs): Uint8Array {
  return removedInstruction(
    "SetPendingSettlement (v12 tag 67 — COLLIDES with v17 BatchTradeCpi)",
    IX_TAG.SetPendingSettlement,
    "percolator-nft program",
  );
}

/**
 * ClearPendingSettlement (Tag 68, PERC-608) — keeper clears the pending_settlement flag.
 *
 * Called by the keeper/admin after KeeperCrank has run and funding is settled.
 * Admin-only (protected by GH#1475 keeper allowlist guard).
 *
 * Instruction data layout: tag(1) + user_idx(2) = 3 bytes
 *
 * Accounts:
 *   0. [signer]   keeper / admin
 *   1. []         slab  (read — for PDA verification + admin check)
 *   2. [writable] position_nft PDA
 */
export interface ClearPendingSettlementArgs {
  userIdx: number;
}

/**
 * @deprecated v12.x ClearPendingSettlement (old tag 68). v17 reuses tag 68 for SetMatcherConfig.
 */
export function encodeClearPendingSettlement(_args: ClearPendingSettlementArgs): Uint8Array {
  return removedInstruction(
    "ClearPendingSettlement (v12 tag 68 — COLLIDES with v17 SetMatcherConfig)",
    IX_TAG.ClearPendingSettlement,
    "percolator-nft program",
  );
}

/**
 * TransferOwnershipCpi (Tag 69, PERC-608) — internal CPI target for percolator-nft TransferHook.
 *
 * Called by the Token-2022 TransferHook on the percolator-nft program during an NFT transfer.
 * Updates the engine account's owner field to the new_owner public key.
 * NOT intended for direct external use — always called via Token-2022 CPI.
 *
 * Instruction data layout: tag(1) + user_idx(2) + new_owner(32) = 35 bytes
 *
 * Accounts:
 *   0. [signer]   nft TransferHook program (CPI caller)
 *   1. [writable] slab
 *   (remaining accounts per Token-2022 ExtraAccountMeta spec)
 */
export interface TransferOwnershipCpiArgs {
  userIdx: number;
  newOwner: PublicKey | string;
}

/**
 * @deprecated v12.x TransferOwnershipCpi (old tag 69). v17 reuses tag 69 for RestartAssetOracle.
 */
export function encodeTransferOwnershipCpi(_args: TransferOwnershipCpiArgs): Uint8Array {
  return removedInstruction(
    "TransferOwnershipCpi (v12 tag 69 — COLLIDES with v17 RestartAssetOracle)",
    IX_TAG.TransferOwnershipCpi,
    "percolator-nft transfer hook",
  );
}

// ============================================================================
// PERC-8111 — SetWalletCap (tag 70)
// ============================================================================

/**
 * SetWalletCap (Tag 70, PERC-8111) — set the per-wallet position cap (admin only).
 *
 * Limits the maximum absolute position size any single wallet may hold on this market.
 * Enforced on every trade (TradeNoCpi + TradeCpi) after execute_trade.
 *
 * - `capE6 = 0`: disable per-wallet cap (no limit, default).
 * - `capE6 > 0`: max |position_size| in e6 units ($1 = 1_000_000).
 *   Phase 1 launch value: 1_000_000_000n ($1,000).
 *
 * When a trade would breach the cap, the on-chain error `WalletPositionCapExceeded`
 * (error code 58) is returned.
 *
 * Instruction data layout: tag(1) + cap_e6(8) = 9 bytes
 *
 * Accounts:
 *   0. [signer]   admin
 *   1. [writable] slab
 *
 * @example
 * ```ts
 * // Set $1K per-wallet cap
 * const ix = new TransactionInstruction({
 *   programId: PROGRAM_ID,
 *   keys: buildAccountMetas(ACCOUNTS_SET_WALLET_CAP, [admin, slab]),
 *   data: Buffer.from(encodeSetWalletCap({ capE6: 1_000_000_000n })),
 * });
 *
 * // Disable cap
 * const disableIx = new TransactionInstruction({
 *   programId: PROGRAM_ID,
 *   keys: buildAccountMetas(ACCOUNTS_SET_WALLET_CAP, [admin, slab]),
 *   data: Buffer.from(encodeSetWalletCap({ capE6: 0n })),
 * });
 * ```
 */
export interface SetWalletCapArgs {
  /** Max position size in e6 units. 0 = disabled. $1 = 1_000_000n, $1K = 1_000_000_000n. */
  capE6: bigint | string;
}

/** @deprecated v12.x SetWalletCap (old tag 70). Not in v17. */
export function encodeSetWalletCap(_args: SetWalletCapArgs): Uint8Array {
  return removedInstruction("SetWalletCap (v12 tag 70 — not in v17)", IX_TAG.SetWalletCap, undefined);
}

// ============================================================================
// InitMatcherCtx — bootstrap matcher context via wrapper CPI to matcher program (tag 83)
// ============================================================================

/**
 * InitMatcherCtx (tag 83) — LP owner bootstraps the matcher context account by invoking
 * the wrapper, which CPIs to the matcher program signing as the matcher_delegate PDA.
 *
 * v17 wire: tag(1=83) + kind(u8) + trading_fee_bps(u32 LE) + base_spread_bps(u32 LE) +
 *   max_total_bps(u32 LE) + impact_k_bps(u32 LE) + liquidity_notional_e6(u128 LE) +
 *   max_fill_abs(u128 LE) + max_inventory_abs(u128 LE) + fee_to_insurance_bps(u16 LE) +
 *   skew_spread_mult_bps(u16 LE) = 70 bytes total.
 *
 * PREREQUISITE: SetMatcherConfig (tag 68, enabled=1) must be called FIRST. The wrapper's
 * handler reads the LP portfolio's stored matcher config and verifies that:
 *   cfg.matcher_program == matcherProg
 *   cfg.matcher_context == matcherCtx
 *   cfg.matcher_delegate == matcherDelegate (derived via deriveMatcherDelegate())
 *
 * The wrapper calls derive_matcher_delegate and invoke_signed so the delegate PDA acts
 * as a signer in the matcher CPI — this is what satisfies the matcher's lp_pda.is_signer
 * check on the deployed binary. No client-side signer of the delegate is needed.
 *
 * Accounts (per handle_init_matcher_ctx in deployed wrapper, tag 83):
 *   [0] lp_owner        signer (LP portfolio owner)
 *   [1] market          read-only (program-owned market slab)
 *   [2] lp_portfolio    read-only (LP's portfolio; must have provenance matching market + owner)
 *   [3] matcher_ctx     writable (320-byte account owned by matcher program)
 *   [4] matcher_prog    read-only, executable (the matcher program)
 *   [5] matcher_delegate read-only (PDA derived by deriveMatcherDelegate; wrapper signs for it)
 *
 * @param args.kind              0=Passive, 1=vAMM
 * @param args.tradingFeeBps     Base trading fee in bps (u32, e.g. 30)
 * @param args.baseSpreadBps     Base spread in bps (u32)
 * @param args.maxTotalBps       Max total spread in bps (u32)
 * @param args.impactKBps        vAMM price impact constant in bps (u32; 0 for Passive)
 * @param args.liquidityNotionalE6 Liquidity notional in e6 units (u128; 0 for Passive)
 * @param args.maxFillAbs        Max single fill in absolute units (u128; use i128::MAX for unlimited)
 * @param args.maxInventoryAbs   Max inventory in absolute units (u128; use i128::MAX for unlimited)
 * @param args.feeToInsuranceBps Fraction of fees to insurance in bps (u16)
 * @param args.skewSpreadMultBps Skew spread multiplier in bps (u16; 0=disabled)
 *
 * Confirmed live on the deployed wrapper (percolator-prog@e26c97a4) at tag 83 by
 * forensic rebuild + live simulateTransaction (see ~/v17/DECISIONS-LEDGER.md,
 * "Pinned deployed revisions", 2026-07-15). The v17 protocol-fee instructions
 * were renumbered (WithdrawProtocolFee=84, SetProtocolFeeAuthority=85) to keep
 * this tag free.
 *
 * @example
 * ```ts
 * const data = encodeInitMatcherCtx({
 *   kind: 0,  // Passive
 *   tradingFeeBps: 30,
 *   baseSpreadBps: 50,
 *   maxTotalBps: 200,
 *   impactKBps: 0,
 *   liquidityNotionalE6: 0n,
 *   maxFillAbs: 170141183460469231731687303715884105727n,  // i128::MAX
 *   maxInventoryAbs: 170141183460469231731687303715884105727n,
 *   feeToInsuranceBps: 0,
 *   skewSpreadMultBps: 0,
 * });
 * ```
 */
export interface InitMatcherCtxArgs {
  /**
   * @deprecated lpIdx is not present in the v17 wire format. The wrapper derives the LP
   * info from the lp_portfolio account (accounts[2]). This field is ignored if provided.
   */
  lpIdx?: number;
  /** Matcher kind: 0=Passive, 1=vAMM. */
  kind: number;
  /** Base trading fee in bps (u32, e.g. 30 = 0.30%). */
  tradingFeeBps: number;
  /** Base spread in bps (u32). */
  baseSpreadBps: number;
  /** Max total spread in bps (u32). */
  maxTotalBps: number;
  /** vAMM price impact constant in bps (u32). Use 0 for Passive kind. */
  impactKBps: number;
  /** Liquidity notional in e6 units (u128). Use 0n for Passive kind. */
  liquidityNotionalE6: bigint | string;
  /** Max single fill size in absolute units (u128). Use 170141183460469231731687303715884105727n for no limit (i128::MAX). */
  maxFillAbs: bigint | string;
  /** Max inventory size in absolute units (u128). Use 170141183460469231731687303715884105727n for no limit. */
  maxInventoryAbs: bigint | string;
  /** Fraction of fees routed to insurance fund in bps (u16). */
  feeToInsuranceBps: number;
  /** Skew spread multiplier in bps (u16). 0 = disabled. */
  skewSpreadMultBps: number;
}

/** Wire length of InitMatcherCtx instruction payload (tag + 10 fields). */
export const INIT_MATCHER_CTX_V17_LEN = 70;

/**
 * Encode InitMatcherCtx instruction data (v17 wire format, tag 83).
 *
 * Sends to the WRAPPER program (not the matcher directly). The wrapper CPIs the matcher
 * via invoke_signed, making the delegate PDA a signer in the matcher's process_init call.
 *
 * @param args InitMatcherCtxArgs (lpIdx field ignored in v17)
 * @returns 70-byte Uint8Array
 */
export function encodeInitMatcherCtx(args: InitMatcherCtxArgs): Uint8Array {
  const data = concatBytes(
    encU8(83),                           // IX_TAG.InitMatcherCtx = 83
    encU8(args.kind),
    encU32(args.tradingFeeBps),   // u32 LE (range-checked: AUD-S3-A5)
    encU32(args.baseSpreadBps),   // u32 LE (range-checked: AUD-S3-A5)
    encU32(args.maxTotalBps),     // u32 LE (range-checked: AUD-S3-A5)
    encU32(args.impactKBps),      // u32 LE (range-checked: AUD-S3-A5)
    encU128(args.liquidityNotionalE6),   // u128 LE
    encU128(args.maxFillAbs),            // u128 LE
    encU128(args.maxInventoryAbs),       // u128 LE
    encU16(args.feeToInsuranceBps),      // u16 LE
    encU16(args.skewSpreadMultBps),      // u16 LE
  );
  if (data.length !== INIT_MATCHER_CTX_V17_LEN) {
    throw new Error(
      `encodeInitMatcherCtx: expected ${INIT_MATCHER_CTX_V17_LEN} bytes, got ${data.length}`,
    );
  }
  return data;
}

// ============================================================================
// Missing encoders — corrected tag mappings (tags 22-74)
// ============================================================================

/**
 * @deprecated v12.x SetInsuranceWithdrawPolicy (old tag 22). Not in v17.
 */
export interface SetInsuranceWithdrawPolicyArgs {
  authority: PublicKey | string;
  minWithdrawBase: bigint | string;
  maxWithdrawBps: number;
  cooldownSlots: bigint | string;
}
export function encodeSetInsuranceWithdrawPolicy(_args: SetInsuranceWithdrawPolicyArgs): Uint8Array {
  return removedInstruction("SetInsuranceWithdrawPolicy (v12 tag 22 — not in v17)", IX_TAG.SetInsuranceWithdrawPolicy, undefined);
}

/**
 * @deprecated v12.x WithdrawInsuranceLimited (old tag 23). v17 uses tag 23 for WithdrawInsuranceLimited (same tag, different meaning — verify wire before using).
 */
export function encodeWithdrawInsuranceLimited(_args: { amount: bigint | string }): Uint8Array {
  return removedInstruction("WithdrawInsuranceLimited (v12 tag 23 — verify v17 wire before use)", IX_TAG.WithdrawInsuranceLimited, undefined);
}

/**
 * @deprecated v12.x ResolvePermissionless (old tag 29). v17 uses tag 39 for ResolveStalePermissionless.
 */
export function encodeResolvePermissionless(): Uint8Array {
  return removedInstruction(
    "ResolvePermissionless (v12 tag 29 — use ResolveStalePermissionless(39) in v17)",
    IX_TAG.ResolvePermissionless,
    "encodeResolveStalePermissionless()",
  );
}

/**
 * @deprecated v12.x ForceCloseResolved (old tag 30) is NOT CloseResolved in v17.
 * v17 reuses tag 30 for CloseResolved with a completely different wire format.
 * This function throws at runtime to prevent silent on-chain mismatch.
 */
export function encodeForceCloseResolved(_args: { userIdx: number }): Uint8Array {
  return removedInstruction(
    "ForceCloseResolved",
    IX_TAG.ForceCloseResolved,
    "encodeCloseResolved() for v17",
  );
}

/**
 * @deprecated v12.x CreateLpVault wire format. Use encodeCreateLpVaultV17() for v17.
 * This is kept for source-compat only — the v12 wire format will be rejected by v17.
 */
export function encodeCreateLpVault(args: { feeShareBps: bigint | string; utilCurveEnabled?: boolean }): Uint8Array {
  return removedInstruction(
    "encodeCreateLpVault (v12 format)",
    IX_TAG.CreateLpVault,
    "encodeCreateLpVaultV17()",
  );
}

/**
 * @deprecated v12.x LpVaultDeposit wire format. Use encodeDepositToLpVault() for v17.
 * This is kept for source-compat only — the v12 wire format will be rejected by v17.
 */
export function encodeLpVaultDeposit(_args: { amount: bigint | string }): Uint8Array {
  return removedInstruction(
    "encodeLpVaultDeposit (v12 format)",
    IX_TAG.LpVaultDeposit,
    "encodeDepositToLpVault()",
  );
}

/**
 * @deprecated v12.x ChallengeSettlement. v17 reuses tag 43 for ForfeitRecoveryLeg.
 */
export function encodeChallengeSettlement(_args: { proposedPriceE6: bigint | string }): Uint8Array {
  return removedInstruction(
    "ChallengeSettlement",
    IX_TAG.ChallengeSettlement,
    undefined,
  );
}

/** @deprecated v12.x ResolveDispute. v17 reuses tag 44 for RebalanceReduce. */
export function encodeResolveDispute(_args: { accept: number }): Uint8Array {
  return removedInstruction("ResolveDispute", IX_TAG.ResolveDispute, undefined);
}

/** @deprecated v12.x DepositLpCollateral. v17 reuses tag 45 for FinalizeResetSide. */
export function encodeDepositLpCollateral(_args: { userIdx: number; lpAmount: bigint | string }): Uint8Array {
  return removedInstruction("DepositLpCollateral", IX_TAG.DepositLpCollateral, undefined);
}

/** @deprecated v12.x WithdrawLpCollateral. v17 reuses tag 46 for ClaimResolvedPayoutTopup. */
export function encodeWithdrawLpCollateral(_args: { userIdx: number; lpAmount: bigint | string }): Uint8Array {
  return removedInstruction("WithdrawLpCollateral", IX_TAG.WithdrawLpCollateral, undefined);
}

/** @deprecated v12.x SetOffsetPair. v17 reuses tag 54 for SyncInsuranceLedger. */
export function encodeSetOffsetPair(_args: { offsetBps: number }): Uint8Array {
  return removedInstruction("SetOffsetPair", IX_TAG.SetOffsetPair, undefined);
}

/** @deprecated v12.x AttestCrossMargin. v17 reuses tag 55 for UpdateTradeFeePolicy. */
export function encodeAttestCrossMargin(_args: { userIdxA: number; userIdxB: number }): Uint8Array {
  return removedInstruction("AttestCrossMargin", IX_TAG.AttestCrossMargin, undefined);
}

/** @deprecated v12.x RescueOrphanVault. v17 reuses tag 72 for TransferPortfolioOwnership. */
export function encodeRescueOrphanVault(): Uint8Array {
  return removedInstruction("RescueOrphanVault", IX_TAG.RescueOrphanVault, "encodeTransferPortfolioOwnership()");
}

/** @deprecated v12.x CloseOrphanSlab. v17 reuses tag 73 for SetNftProgramId. */
export function encodeCloseOrphanSlab(): Uint8Array {
  return removedInstruction("CloseOrphanSlab", IX_TAG.CloseOrphanSlab, "encodeSetNftProgramId()");
}

/** @deprecated v12.x SetDexPool. v17 reuses tag 74 for CreateLpVault. */
export function encodeSetDexPool(_args: { pool: PublicKey | string }): Uint8Array {
  return removedInstruction("SetDexPool", IX_TAG.SetDexPool, "encodeCreateLpVaultV17()");
}

/** @deprecated v12.x Insurance LP alias — removed in v17. */
export function encodeCreateInsuranceMint(): Uint8Array {
  return removedInstruction("CreateInsuranceMint (v12 alias)", IX_TAG.CreateLpVault, "encodeCreateLpVaultV17()");
}

/** @deprecated v12.x Insurance LP alias — removed in v17. */
export function encodeDepositInsuranceLP(_args: { amount: bigint | string }): Uint8Array {
  return removedInstruction("DepositInsuranceLP (v12 alias)", IX_TAG.DepositToLpVault, "encodeDepositToLpVault()");
}

/** @deprecated v12.x Insurance LP alias — removed in v17. */
export function encodeWithdrawInsuranceLP(_args: { lpAmount: bigint | string }): Uint8Array {
  return removedInstruction("WithdrawInsuranceLP (v12 alias)", IX_TAG.RequestRedeemLpShares, "encodeRequestRedeemLpSharesV22()");
}

// ============================================================================
// Phase B admin setters (tags 78-81) — added 2026-04-17
// Wire up MarketConfig fields added in prog Phase A. Admin-only, validated.
// Accounts for all 4: [admin(signer), slab(writable)] (2 accounts).
// ============================================================================

/**
 * @deprecated v12.x SetMaxPnlCap (old tag 78). v17 reuses tag 78 for LpVaultCrankFees.
 * This function throws at runtime to prevent silent on-chain mismatch.
 */
export interface SetMaxPnlCapArgs {
  cap: bigint | string;
}

export function encodeSetMaxPnlCap(_args: SetMaxPnlCapArgs): Uint8Array {
  return removedInstruction(
    "SetMaxPnlCap (v12 tag 78 — now LpVaultCrankFees in v17)",
    IX_TAG.SetMaxPnlCap,
    "encodeLpVaultCrankFees() [if you meant v17] or no equivalent",
  );
}

/**
 * @deprecated v12.x SetOiCapMultiplier (old tag 79). v17 reuses tag 79 for SetLpVaultPaused.
 */
export interface SetOiCapMultiplierArgs {
  packed: bigint | string;
}

export function encodeSetOiCapMultiplier(_args: SetOiCapMultiplierArgs): Uint8Array {
  return removedInstruction(
    "SetOiCapMultiplier (v12 tag 79 — now SetLpVaultPaused in v17)",
    IX_TAG.SetOiCapMultiplier,
    "encodeSetLpVaultPaused() [if you meant v17]",
  );
}

/** @deprecated v12.x helper — kept for legacy callers that use packOiCap(). */
export function packOiCap(multiplierBps: number, softCapBps: number): bigint {
  if (multiplierBps < 0 || multiplierBps > 0xFFFF_FFFF) {
    throw new Error(`packOiCap: multiplier_bps out of u32 range: ${multiplierBps}`);
  }
  if (softCapBps < 0 || softCapBps > 0xFFFF_FFFF) {
    throw new Error(`packOiCap: soft_cap_bps out of u32 range: ${softCapBps}`);
  }
  return BigInt(multiplierBps) | (BigInt(softCapBps) << 32n);
}

/**
 * @deprecated v12.x SetDisputeParams (old tag 80). v17 reuses tag 80 for CloseLpVault.
 */
export interface SetDisputeParamsArgs {
  windowSlots: bigint | string;
  bondAmount: bigint | string;
}

export function encodeSetDisputeParams(_args: SetDisputeParamsArgs): Uint8Array {
  return removedInstruction(
    "SetDisputeParams (v12 tag 80 — now CloseLpVault in v17)",
    IX_TAG.SetDisputeParams,
    "encodeCloseLpVault() [if you meant v17]",
  );
}

/**
 * @deprecated v12.x SetLpCollateralParams (old tag 81). Not in v17.
 */
export interface SetLpCollateralParamsArgs {
  enabled: number;
  ltvBps: number;
}

export function encodeSetLpCollateralParams(_args: SetLpCollateralParamsArgs): Uint8Array {
  return removedInstruction("SetLpCollateralParams (v12 tag 81 — not in v17)", IX_TAG.SetLpCollateralParams, undefined);
}

/**
 * @deprecated v12.x AcceptAdmin (old tag 82). v17 uses UpdateAuthority(32) for admin rotation.
 */
export function encodeAcceptAdmin(): Uint8Array {
  return removedInstruction("AcceptAdmin (v12 tag 82 — not in v17)", IX_TAG.AcceptAdmin, "encodeUpdateAuthority()");
}

// ============================================================================
// G-3 fixes (audit-2026-04-27): missing per-account encoders for tags 25-28.
// Wrapper handlers exist at src/percolator.rs:2088, 2092, 2097, 2103.
// ============================================================================

/**
 * @deprecated v12.x ReclaimEmptyAccount (old tag 85). Not in v17.
 */
export interface ReclaimEmptyAccountArgs {
  userIdx: number;
}

export function encodeReclaimEmptyAccount(_args: ReclaimEmptyAccountArgs): Uint8Array {
  return removedInstruction("ReclaimEmptyAccount (v12 tag 85 — not in v17)", IX_TAG.ReclaimEmptyAccount, undefined);
}

/**
 * @deprecated v12.x SettleAccount (old tag 86). Not in v17.
 */
export interface SettleAccountArgs {
  userIdx: number;
}

export function encodeSettleAccount(_args: SettleAccountArgs): Uint8Array {
  return removedInstruction("SettleAccount (v12 tag 86 — not in v17)", IX_TAG.SettleAccount, undefined);
}

/**
 * @deprecated v12.x DepositFeeCredits (old tag 27). Not in v17.
 */
export interface DepositFeeCreditsArgs {
  userIdx: number;
  amount: bigint | string;
}

export function encodeDepositFeeCredits(_args: DepositFeeCreditsArgs): Uint8Array {
  return removedInstruction("DepositFeeCredits (v12 tag 27 — not in v17)", IX_TAG.DepositFeeCredits, undefined);
}

/**
 * ConvertReleasedPnl (tag 28) — voluntary PnL conversion with open position.
 * Owner only.
 *
 * v18 wire (integration `a9318945`): tag(1) + portfolio_id(u64) +
 *   position_epoch(u64) + amount(u128 LE) = 33 bytes.
 *
 * BREAKING vs v17 (17-byte payload): the v16-migration identity-binding
 * overhaul CAS-binds this to the portfolio's identity and current position
 * epoch (both read live, immediately before signing).
 *
 * Accounts: see ACCOUNTS_CONVERT_RELEASED_PNL.
 *
 * @param portfolioId    The portfolio's program-assigned identity.
 * @param positionEpoch  The portfolio's current position epoch, read live.
 * @param amount         Amount of released PnL to convert (u128).
 *
 * @example
 * ```ts
 * const data = encodeConvertReleasedPnl({
 *   portfolioId: portfolio.portfolioId,
 *   positionEpoch: portfolio.legs[0].epochSnap,
 *   amount: 1_000_000n,
 * });
 * ```
 */
export interface ConvertReleasedPnlArgs {
  /** @deprecated userIdx is not needed in v17+ — portfolios are identified by account key. */
  userIdx?: number;
  portfolioId: bigint | string;
  positionEpoch: bigint | string;
  amount: bigint | string;
}

export function encodeConvertReleasedPnl(args: ConvertReleasedPnlArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.ConvertReleasedPnl),
    encU64(args.portfolioId),
    encU64(args.positionEpoch),
    encU128(args.amount),
  );
}

// ============================================================================
// G-2 fix (audit-2026-04-27): UpdateAuthority (tag 83). v12.18.x 4-way split.
// Wrapper: src/percolator.rs:6876 (handler), 2140-2146 (decode).
// ============================================================================

/**
 * UpdateAuthority (tag 32) — rotate the single market-level authority (marketauth).
 *
 * v18 wire (integration `a9318945`): tag(1) + new_pubkey[32] + authority_epoch(u64)
 *   = 41 bytes.
 *
 * BREAKING vs v17 (33-byte payload): the v16-migration identity-binding
 * overhaul appends `authority_epoch` — a CAS check (strict `current ==
 * expected`, auto-incremented by the program). Pass the LIVE current epoch,
 * NOT current+1 — this closes the durable-nonce replay window where a
 * signed rotation intent, if never submitted, would otherwise remain valid
 * across later legitimate rotations.
 *
 * Accounts: [currentAuth(signer), newAuth(signer), slab(writable)]
 *
 * @param newPubkey       New marketauth pubkey. Burning to zero is rejected on-chain.
 * @param authorityEpoch  Live-read current authority_epoch (CAS, expected-current).
 *
 * @example
 * ```ts
 * const data = encodeUpdateAuthority({ newPubkey: newAdminKey, authorityEpoch: 0n });
 * ```
 */
export interface UpdateAuthorityArgs {
  newPubkey: PublicKey | string;
  authorityEpoch: bigint | string;
}

export function encodeUpdateAuthority(args: UpdateAuthorityArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.UpdateAuthority),
    encPubkey(args.newPubkey),
    encU64(args.authorityEpoch),
  );
}

// ============================================================================
// v17 NEW — UpdateAssetAuthority (tag 65)
// ============================================================================

/**
 * Per-asset authority kind for UpdateAssetAuthority (tag 65).
 *
 * Exact mapping from v16_program.rs lines 5246-5250:
 *   ASSET_AUTH_ADMIN              = 0  →  AssetAdmin
 *   ASSET_AUTH_INSURANCE          = 1  →  Insurance
 *   ASSET_AUTH_INSURANCE_OPERATOR = 2  →  InsuranceOperator
 *   ASSET_AUTH_BACKING_BUCKET     = 3  →  BackingBucket
 *   ASSET_AUTH_ORACLE             = 4  →  Oracle
 *
 * CRITICAL: the kind byte is sent on-chain and routes to a specific authority
 * slot. Wrong values silently corrupt authority state:
 *   - Calling with kind=Insurance(1) rotates `insurance_authority` (correct).
 *   - Calling with the OLD wrong value 0 for Insurance hits `asset_admin` slot,
 *     corrupting the market-level admin key instead.
 *
 * Stake program uses kind=AssetAdmin(0) targeting asset_index=0 to bind
 * the stake vault PDA into the asset_admin authority slot.
 */
export const ASSET_AUTH_KIND = {
  /** ASSET_AUTH_ADMIN = 0 in v16_program.rs:5246 — routes to asset_admin field */
  AssetAdmin: 0,
  /** ASSET_AUTH_INSURANCE = 1 in v16_program.rs:5247 — routes to insurance_authority field */
  Insurance: 1,
  /** ASSET_AUTH_INSURANCE_OPERATOR = 2 in v16_program.rs:5248 — routes to insurance_operator field */
  InsuranceOperator: 2,
  /** ASSET_AUTH_BACKING_BUCKET = 3 in v16_program.rs:5249 — routes to backing_bucket_authority field */
  BackingBucket: 3,
  /** ASSET_AUTH_ORACLE = 4 in v16_program.rs:5250 — routes to oracle_authority field */
  Oracle: 4,
} as const;
Object.freeze(ASSET_AUTH_KIND);

export type AssetAuthKind = (typeof ASSET_AUTH_KIND)[keyof typeof ASSET_AUTH_KIND];

/**
 * UpdateAssetAuthority (tag 65) — rotate a per-asset authority (v18 wire,
 * integration `a9318945`; LOCKED WIRE per WRAPPER_SYNC_LOCKED_WIRE.md).
 *
 * Wire: tag(1) + asset_index(u16)@1 + market_id(u64)@3 + kind(u8)@11 +
 *   new_pubkey[32]@12 + authority_epoch(u64)@44 = 52 bytes.
 *
 * BREAKING vs v17 (36-byte payload): adds `market_id` (right after
 * `asset_index`, TB-4's market-id-bearing cluster) and appends
 * `authority_epoch` — a CAS check against this asset's OWN
 * `AssetControlSequencesV16.authority_epoch` lane. Pass the LIVE current
 * epoch, NOT current+1 (durable-nonce landmine if wrong — see the lane's own
 * doc comment in the wrapper source).
 *
 * Gated by the asset's own asset_admin (can rotate any) or by the current
 * holder of that authority (self-rotation). Isolated to the given asset_index.
 *
 * @param assetIndex Asset index (0 = primary, 1+ = additional assets).
 * @param marketId   The asset's market_id.
 * @param kind       ASSET_AUTH_KIND.* constant.
 * @param newPubkey  New authority pubkey. Zero = burn (only AssetAdmin on asset!=0).
 * @param authorityEpoch  Live-read current authority_epoch for this asset (CAS, expected-current).
 *
 * @example
 * ```ts
 * // Rotate insurance authority for asset 0
 * // ASSET_AUTH_KIND.Insurance = 1 (routes to insurance_authority slot on-chain)
 * const data = encodeUpdateAssetAuthority({
 *   assetIndex: 0,
 *   marketId: 1n,
 *   kind: ASSET_AUTH_KIND.Insurance,
 *   newPubkey: newInsuranceKey,
 *   authorityEpoch: 0n,
 * });
 * ```
 */
export interface UpdateAssetAuthorityArgs {
  assetIndex: number;
  marketId: bigint | string;
  kind: AssetAuthKind;
  newPubkey: PublicKey | string;
  authorityEpoch: bigint | string;
}

export function encodeUpdateAssetAuthority(args: UpdateAssetAuthorityArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.UpdateAssetAuthority),
    encU16(args.assetIndex),
    encU64(args.marketId),
    encU8(args.kind),
    encPubkey(args.newPubkey),
    encU64(args.authorityEpoch),
  );
}

// ============================================================================
// v17 NEW — BatchTradeNoCpi (tag 66) + BatchTradeCpi (tag 67)
// ============================================================================

/**
 * One leg of a BatchTradeNoCpi instruction.
 */
export interface BatchTradeNoCpiLeg {
  assetIndex: number;
  marketId: bigint | string;
  sizeQ: bigint | string;
  execPrice: bigint | string;
  feeBps: bigint | string;
}

/**
 * BatchTradeNoCpi (tag 66) — multi-leg NoCpi batch trade (v18 wire,
 * integration `a9318945`).
 *
 * Wire: tag(1) + n_legs(u8) + [asset_index(u16) + market_id(u64) + size_q(i128)
 *   + exec_price(u64) + fee_bps(u64)]×n + account_a_portfolio_id(u64) +
 *   account_a_position_epoch(u64) + account_b_portfolio_id(u64) +
 *   account_b_position_epoch(u64).
 *
 * BREAKING vs v17: each leg gains `market_id` (TB-4's market-id-bearing
 * cluster), and the whole instruction gains the identity-binding trailer
 * (both accounts' portfolio id + position epoch, CAS, AFTER the legs — the
 * wrapper reads legs first, then the two account identities).
 *
 * @param legs Array of up to 255 trade legs.
 * @param accountAPortfolioId    Account A's portfolio identity.
 * @param accountAPositionEpoch  Account A's current position epoch (CAS, live-read).
 * @param accountBPortfolioId    Account B's portfolio identity.
 * @param accountBPositionEpoch  Account B's current position epoch (CAS, live-read).
 *
 * @example
 * ```ts
 * const data = encodeBatchTradeNoCpi({
 *   legs: [
 *     { assetIndex: 0, marketId: 1n, sizeQ: 1_000_000n, execPrice: 50_000_000_000n, feeBps: 30n },
 *     { assetIndex: 1, marketId: 2n, sizeQ: -500_000n,  execPrice: 40_000_000_000n, feeBps: 30n },
 *   ],
 *   accountAPortfolioId: a.portfolioId,
 *   accountAPositionEpoch: a.legs[0].epochSnap,
 *   accountBPortfolioId: b.portfolioId,
 *   accountBPositionEpoch: b.legs[0].epochSnap,
 * });
 * ```
 */
export interface BatchTradeNoCpiArgs {
  legs: BatchTradeNoCpiLeg[];
  accountAPortfolioId: bigint | string;
  accountAPositionEpoch: bigint | string;
  accountBPortfolioId: bigint | string;
  accountBPositionEpoch: bigint | string;
}

function validateBatchTradeFeeBps(value: bigint | string, caller: string): void {
  const feeBps = typeof value === "string" ? BigInt(value) : value;
  if (feeBps > 10_000n) {
    throw new Error(`${caller}: feeBps must be <= 10000, got ${feeBps}`);
  }
}

export function encodeBatchTradeNoCpi(args: BatchTradeNoCpiArgs): Uint8Array {
  if (args.legs.length === 0) {
    throw new Error("encodeBatchTradeNoCpi: at least one leg is required");
  }
  if (args.legs.length > 255) {
    throw new Error(`encodeBatchTradeNoCpi: too many legs (${args.legs.length} > 255)`);
  }

  const parts: Uint8Array[] = [
    encU8(IX_TAG.BatchTradeNoCpi),
    encU8(args.legs.length),
  ];

  for (const leg of args.legs) {
    validateBatchTradeFeeBps(leg.feeBps, "encodeBatchTradeNoCpi");
    parts.push(encU16(leg.assetIndex));
    parts.push(encU64(leg.marketId));
    parts.push(encI128(leg.sizeQ));
    parts.push(encU64(leg.execPrice));
    parts.push(encU64(leg.feeBps));
  }

  parts.push(encU64(args.accountAPortfolioId));
  parts.push(encU64(args.accountAPositionEpoch));
  parts.push(encU64(args.accountBPortfolioId));
  parts.push(encU64(args.accountBPositionEpoch));

  return concatBytes(...parts);
}
/**
 * BatchTradeCpi (tag 67) — multi-leg CPI batch trade (v18 wire, integration
 * `a9318945`).
 *
 * Wire: tag(1) + n_legs(u8) + [asset_index(u16) + market_id(u64) + size_q(i128)
 *   + fee_bps(u64) + limit_price(u64)]×n + max_slippage_atoms(u128) +
 *   max_fee_atoms(u128) + account_a_portfolio_id(u64) +
 *   account_a_position_epoch(u64) + account_b_portfolio_id(u64) +
 *   account_b_position_epoch(u64) + account_b_matcher_sequence(u64).
 *
 * BREAKING vs v17: each leg gains `market_id`; the instruction gains
 * `max_slippage_atoms`/`max_fee_atoms` caps and the full identity-binding
 * trailer (both accounts' portfolio id + position epoch, plus account B's
 * matcher sequence — the CPI-matched side), all AFTER the legs, in that
 * order.
 *
 * @param legs CPI trade legs. The wrapper accepts at most min(11, WRAPPER_MAX_PORTFOLIO_ASSETS) = 4 since #546 (`MATCHER_BATCH_MAX_LEGS`; 5+
 *   fail InvalidInstruction). CU: measured ~342k CU for a 2-leg batch on the relaunch
 *   wrapper, ~120k per extra leg — request a compute-unit limit accordingly
 *   (e.g. `ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })` for 2 legs).
 *   The client wire is unchanged on P1/P3: the wrapper itself appends the per-leg 24-byte
 *   P1/P2 matcher call extension to the matcher CPI when the asset's `matcher_ext_mode == 1`
 *   (see `encodeMatcherBatchCall` / `encodeWrapperMatcherCallExt`).
 * @param maxSlippageAtoms  Aggregate slippage cap across the whole batch (u128).
 * @param maxFeeAtoms       Aggregate fee cap across the whole batch (u128).
 * @param accountAPortfolioId       Account A's portfolio identity.
 * @param accountAPositionEpoch     Account A's current position epoch (CAS, live-read).
 * @param accountBPortfolioId       Account B's portfolio identity.
 * @param accountBPositionEpoch     Account B's current position epoch (CAS, live-read).
 * @param accountBMatcherSequence   Account B's current matcher-sequence watermark (CAS, live-read).
 *
 * @example
 * ```ts
 * const data = encodeBatchTradeCpi({
 *   legs: [{ assetIndex: 0, marketId: 1n, sizeQ: 1_000_000n, feeBps: 30n, limitPrice: 51_000_000_000n }],
 *   maxSlippageAtoms: 0n,
 *   maxFeeAtoms: 0n,
 *   accountAPortfolioId: a.portfolioId,
 *   accountAPositionEpoch: a.legs[0].epochSnap,
 *   accountBPortfolioId: b.portfolioId,
 *   accountBPositionEpoch: b.legs[0].epochSnap,
 *   accountBMatcherSequence: b.matcherSequence,
 * });
 * ```
 */

export interface BatchTradeCpiLeg {
  assetIndex: number;
  marketId: bigint | string;
  sizeQ: bigint | string;
  feeBps: bigint | string;
  limitPrice: bigint | string;
}

export interface BatchTradeCpiArgs {
  legs: BatchTradeCpiLeg[];
  maxSlippageAtoms: bigint | string;
  maxFeeAtoms: bigint | string;
  accountAPortfolioId: bigint | string;
  accountAPositionEpoch: bigint | string;
  accountBPortfolioId: bigint | string;
  accountBPositionEpoch: bigint | string;
  accountBMatcherSequence: bigint | string;
}

export function encodeBatchTradeCpi(args: BatchTradeCpiArgs): Uint8Array {
  if (args.legs.length === 0) {
    throw new Error("encodeBatchTradeCpi: at least one leg is required");
  }
  if (args.legs.length > 255) {
    throw new Error(`encodeBatchTradeCpi: too many legs (${args.legs.length} > 255)`);
  }

  const parts: Uint8Array[] = [
    encU8(IX_TAG.BatchTradeCpi),
    encU8(args.legs.length),
  ];

  for (const leg of args.legs) {
    validateBatchTradeFeeBps(leg.feeBps, "encodeBatchTradeCpi");
    parts.push(encU16(leg.assetIndex));
    parts.push(encU64(leg.marketId));
    parts.push(encI128(leg.sizeQ));
    parts.push(encU64(leg.feeBps));
    parts.push(encU64(leg.limitPrice));
  }

  parts.push(encU128(args.maxSlippageAtoms));
  parts.push(encU128(args.maxFeeAtoms));
  parts.push(encU64(args.accountAPortfolioId));
  parts.push(encU64(args.accountAPositionEpoch));
  parts.push(encU64(args.accountBPortfolioId));
  parts.push(encU64(args.accountBPositionEpoch));
  parts.push(encU64(args.accountBMatcherSequence));

  return concatBytes(...parts);
}

// ============================================================================
// v17 NEW — SetMatcherConfig (tag 68)
// ============================================================================

/**
 * SetMatcherConfig (tag 68) — enable or disable the external matcher for
 * this portfolio, and (v18) set its position-epoch frontier, trade-fee cap
 * and expiry (v18 wire, integration `a9318945`).
 *
 * Wire: tag(1) + portfolio_id(u64) + expected_sequence(u64) +
 *   asset_generation_frontier(u64) + enabled(u8) + trade_fee_cap_bps(u16) +
 *   expiry_slot(u64) = 36 bytes.
 *
 * BREAKING vs v17 (2-byte payload): this is the tag TB-1a's account-side
 * `PortfolioMatcherConfigV16.control` bit-packing was built for —
 * `trade_fee_cap_bps` here SETS bits 50..63 of that on-chain `control` word
 * (see {@link decodePortfolioMatcherControl}), and `asset_generation_frontier`
 * bumps the account's stored position-epoch frontier. `portfolio_id`/
 * `expected_sequence` are the same identity/matcher-sequence CAS binding as
 * every other TB-1b-bound tag — read live, immediately before signing.
 *
 * @param portfolioId              The portfolio's program-assigned identity.
 * @param expectedSequence         The portfolio's current matcher-sequence watermark, read live.
 * @param assetGenerationFrontier  Live-read current asset-set generation frontier.
 * @param enabled          1 = enabled, 0 = disabled.
 * @param tradeFeeCapBps   LP's maximum accepted market base fee, in bps (0..=10000).
 * @param expirySlot       Slot at which this matcher grant stops being live (0 = disabled/never granted).
 *
 * @example
 * ```ts
 * const data = encodeSetMatcherConfig({
 *   portfolioId: portfolio.portfolioId,
 *   expectedSequence: portfolio.matcherSequence,
 *   assetGenerationFrontier: cfg.assetSetEpoch,
 *   enabled: 1,
 *   tradeFeeCapBps: 100,
 *   expirySlot: currentSlot + 216_000n,
 * });
 * ```
 */
export interface SetMatcherConfigArgs {
  portfolioId: bigint | string;
  expectedSequence: bigint | string;
  assetGenerationFrontier: bigint | string;
  enabled: number;
  tradeFeeCapBps: number;
  expirySlot: bigint | string;
}

export function encodeSetMatcherConfig(args: SetMatcherConfigArgs): Uint8Array {
  if (args.enabled !== 0 && args.enabled !== 1) {
    throw new Error(`encodeSetMatcherConfig: enabled must be 0 or 1, got ${args.enabled}`);
  }
  return concatBytes(
    encU8(IX_TAG.SetMatcherConfig),
    encU64(args.portfolioId),
    encU64(args.expectedSequence),
    encU64(args.assetGenerationFrontier),
    encU8(args.enabled),
    encU16(args.tradeFeeCapBps),
    encU64(args.expirySlot),
  );
}

// ============================================================================
// v17 NEW — RestartAssetOracle (tag 69)
// ============================================================================

/**
 * RestartAssetOracle (tag 69) — permissionless oracle restart (v18 wire,
 * integration `a9318945`).
 *
 * Wire: tag(1) + asset_index(u16) + market_id(u64) + now_slot(u64) +
 *   initial_price(u64) + observation_sequence(u64) = 35 bytes.
 *
 * BREAKING vs v17 (20-byte payload): adds `market_id` (right after
 * `asset_index`) and appends `observation_sequence` — a strictly-increasing
 * replay nonce (this asset's `oracle_observation` control-sequences lane).
 *
 * Used to un-stick a stale or hung oracle. Anyone can call this.
 *
 * @param assetIndex    Asset/domain index.
 * @param marketId      The asset's market_id.
 * @param nowSlot       Current slot.
 * @param initialPrice  Initial mark price in e6 units.
 * @param observationSequence  Strictly-increasing replay nonce (this asset's `oracle_observation` lane).
 *
 * @example
 * ```ts
 * const data = encodeRestartAssetOracle({
 *   assetIndex: 0,
 *   marketId: 1n,
 *   nowSlot: currentSlot,
 *   initialPrice: 50_000_000_000n,
 *   observationSequence: nextObservationSequence,
 * });
 * ```
 */
export interface RestartAssetOracleArgs {
  assetIndex: number;
  marketId: bigint | string;
  nowSlot: bigint | string;
  initialPrice: bigint | string;
  observationSequence: bigint | string;
}

export function encodeRestartAssetOracle(args: RestartAssetOracleArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.RestartAssetOracle),
    encU16(args.assetIndex),
    encU64(args.marketId),
    encU64(args.nowSlot),
    encU64(args.initialPrice),
    encU64(args.observationSequence),
  );
}

// ============================================================================
// v17 NEW — WithdrawInsuranceAsset (tag 57)
// ============================================================================

/**
 * WithdrawInsuranceAsset (tag 57) — withdraw from a specific asset's
 * insurance fund (v18 wire, integration `a9318945`).
 *
 * Wire: tag(1) + asset_index(u16) + market_id(u64) + amount(u128) +
 *   authority_epoch(u64) = 35 bytes.
 *
 * BREAKING vs v17 (19-byte payload): adds `market_id` (right after
 * `asset_index`) and appends `authority_epoch` — a CAS check against this
 * asset's OWN `AssetControlSequencesV16.authority_epoch` lane (W3A-1
 * direct-withdrawal binding, same class as WithdrawBackingBucket/
 * WithdrawBackingBucketEarnings). Pass the LIVE current epoch, not current+1.
 *
 * Requires insurance_authority signature. asset_index is u16 (domain
 * u8→u16 migration in v17).
 *
 * @param assetIndex  Asset/domain index (u16, not u8).
 * @param marketId    The asset's market_id.
 * @param amount      Amount to withdraw (u128).
 * @param authorityEpoch  Live-read current authority_epoch for this asset (CAS, expected-current).
 *
 * @example
 * ```ts
 * const data = encodeWithdrawInsuranceAsset({
 *   assetIndex: 0,
 *   marketId: 1n,
 *   amount: 1_000_000n,
 *   authorityEpoch: 0n,
 * });
 * ```
 */
export interface WithdrawInsuranceAssetArgs {
  assetIndex: number;
  marketId: bigint | string;
  amount: bigint | string;
  authorityEpoch: bigint | string;
}

export function encodeWithdrawInsuranceAsset(args: WithdrawInsuranceAssetArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.WithdrawInsuranceAsset),
    encU16(args.assetIndex),
    encU64(args.marketId),
    encU128(args.amount),
    encU64(args.authorityEpoch),
  );
}

// ============================================================================
// v17 NEW — LP-vault renumbered tags (74-80)
// ============================================================================

/**
 * CreateLpVault (tag 74) — create the LP vault for a market/asset domain.
 *
 * Wire: tag(1) + fee_share_bps(u16) + redemption_cooldown_slots(u64) +
 *       oi_reservation_threshold_bps(u16) + domain(u16) = 15 bytes.
 *
 * @param feeShareBps                  LP vault fee share in bps (0-10000).
 * @param redemptionCooldownSlots      Slots between redemption requests.
 * @param oiReservationThresholdBps    OI reservation threshold in bps.
 * @param domain                       Asset/domain index (u16 in v17).
 *
 * @example
 * ```ts
 * const data = encodeCreateLpVault({
 *   feeShareBps: 5000,
 *   redemptionCooldownSlots: 21600n,
 *   oiReservationThresholdBps: 8000,
 *   domain: 0,
 * });
 * ```
 */
export interface CreateLpVaultArgs {
  feeShareBps: number;
  redemptionCooldownSlots: bigint | string;
  oiReservationThresholdBps: number;
  domain: number;
}

export function encodeCreateLpVaultV17(args: CreateLpVaultArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.CreateLpVault),
    encU16(args.feeShareBps),
    encU64(args.redemptionCooldownSlots),
    encU16(args.oiReservationThresholdBps),
    encU16(args.domain),
  );
}

/**
 * DepositToLpVault (tag 75) — deposit collateral into the LP vault.
 *
 * Wire: tag(1) + amount(u128) + domain(u16) = 19 bytes.
 *
 * `domain` selects which pot of the vault's asset receives the backing and MUST
 * satisfy `domain >> 1 === registry.domain >> 1`. Shares are priced off COMBINED
 * NAV across both pots, so the depositor is indifferent to the choice; routing
 * exists so new money can reach whichever pot the house is drawing on.
 *
 * ACCOUNTS (v17 dual-domain): index 10 is the SIBLING-domain backing ledger
 * (`deriveLpBackingLedger(programId, market, domain ^ 1)`). It is required even
 * when uninitialised — NAV spans both pots, and omitting it would understate NAV
 * and mint the depositor free shares at existing holders' expense.
 *
 * @example
 * ```ts
 * const data = encodeDepositToLpVault({ amount: 1_000_000n, domain: 2 });
 * ```
 */
export function encodeDepositToLpVault(args: {
  amount: bigint | string;
  domain: number;
}): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.DepositToLpVault),
    encU128(args.amount),
    encU16(args.domain),
  );
}

/**
 * RequestRedeemLpShares (tag 76) — request redemption of LP vault shares.
 *
 * Wire: tag(1) + shares(u128) = 17 bytes.
 *
 * BREAKING vs v12.x: was LpVaultWithdraw (tag 39) with lpAmount u64.
 * v17 uses shares u128 and a two-step request/execute redemption flow.
 *
 * @deprecated Refused by the v2.2 program since rc23 (percolator-prog #616: the 17-byte form with no payout floor
 * answers InvalidInstructionData). Use the floored v2.2 form, `encodeRequestRedeemLpSharesV22` /
 * `buildRequestRedeemLpSharesIxV22` (26 bytes: shares, min_payout_atoms, keeper_ok). Kept for v1 / pre-v2.2 programs.
 *
 * @example
 * ```ts
 * const data = encodeRequestRedeemLpShares({ shares: 1_000_000n });
 * ```
 */
export function encodeRequestRedeemLpShares(args: { shares: bigint | string }): Uint8Array {
  return concatBytes(encU8(IX_TAG.RequestRedeemLpShares), encU128(args.shares));
}

/**
 * ExecuteRedemption (tag 77) — execute a pending LP redemption.
 *
 * Wire: tag(1) + domain(u16) = 3 bytes.
 *
 * `domain` selects which pot the payout is physically DRAWN from. NAV and
 * available-principal stay COMBINED across both pots, so this does not change
 * what the redeemer is owed — only where the atoms come from. A redemption draws
 * from ONE pot and fails closed (EngineCounterUnderflow) if that pot cannot
 * cover it; rebalance (tag 91) first.
 *
 * ACCOUNTS (v17 dual-domain): index 11 is the SIBLING-domain backing ledger.
 *
 * @example
 * ```ts
 * const data = encodeExecuteRedemption({ domain: 2 });
 * ```
 */
export function encodeExecuteRedemption(args: { domain: number }): Uint8Array {
  return concatBytes(encU8(IX_TAG.ExecuteRedemption), encU16(args.domain));
}

/**
 * LpVaultCrankFees (tag 78) — crank fee accrual for the LP vault.
 *
 * Wire: tag(1) + domain(u16) = 3 bytes.
 *
 * `domain` selects which pot receives the cranked fees. Mints no shares, so the
 * choice cannot dilute; routing exists so fees can become backing in the pot
 * that needs it. The target ledger is created on first use.
 *
 * ACCOUNTS (v17 dual-domain): index 4 is the SIBLING-domain backing ledger and
 * index 5 is the system program (needed to create a missing target ledger).
 *
 * @example
 * ```ts
 * const data = encodeLpVaultCrankFees({ domain: 2 });
 * ```
 */
export function encodeLpVaultCrankFees(args: { domain: number }): Uint8Array {
  return concatBytes(encU8(IX_TAG.LpVaultCrankFees), encU16(args.domain));
}

/**
 * RebalanceLpVaultBacking (tag 91) — move IDLE backing between the two pots of
 * the LP vault's asset.
 *
 * Wire: tag(1) + fromDomain(u16) + toDomain(u16) + amount(u128) = 21 bytes.
 *
 * Permissionless: both pots belong to the same vault, so the move cannot extract
 * value, and the source-side gate refuses anything that would leave the source
 * pot under-backed. Only `fresh_unliened` backing moves — backing pledged against
 * open interest, already consumed, or impaired stays put.
 *
 * ACCOUNTS: [cranker(signer,w), market(w), registry, fromLedger(w), toLedger(w),
 * systemProgram]. The destination ledger is created on first arrival.
 *
 * @example
 * ```ts
 * const data = encodeRebalanceLpVaultBacking({
 *   fromDomain: 2, toDomain: 3, amount: 500_000n,
 * });
 * ```
 */
export function encodeRebalanceLpVaultBacking(args: {
  fromDomain: number;
  toDomain: number;
  amount: bigint | string;
}): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.RebalanceLpVaultBacking),
    encU16(args.fromDomain),
    encU16(args.toDomain),
    encU128(args.amount),
  );
}

/**
 * UpdateInsuranceWithdrawPolicy (tag 92) — set the insurance-withdrawal rate
 * limit (v18 wire, integration `a9318945`).
 *
 * Wire: tag(1) + depositsOnly(u8) + cooldownSlots(u64) + authorityEpoch(u64)
 *   = 18 bytes.
 * Accounts: [marketauth (signer), market (writable)].
 *
 * BREAKING vs v17 (10-byte payload): appends `authorityEpoch` — a CAS check
 * (strict `current == expected`) sharing asset-0's `authority_epoch` lane
 * (same lane as {@link encodeUpdateFeeSplit}/{@link encodeWithdrawCreatorFee}'s
 * asset-scoped checks are NOT — this one is gated on `marketauth`, not a
 * per-asset admin). Pass the LIVE current epoch, NOT current+1.
 *
 * `cooldownSlots` is capped at `MAX_INSURANCE_WITHDRAW_COOLDOWN_SLOTS`; the program rejects
 * anything above it, because an uncapped duration setter would let an admin freeze insurance
 * withdrawals permanently. Zero is legal for both fields and is how a market turns the limit
 * back OFF.
 */
export function encodeUpdateInsuranceWithdrawPolicy(args: {
  depositsOnly: number;
  cooldownSlots: bigint | string;
  authorityEpoch: bigint | string;
}): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.UpdateInsuranceWithdrawPolicy),
    encU8(args.depositsOnly),
    encU64(args.cooldownSlots),
    encU64(args.authorityEpoch),
  );
}

/**
 * Upper bound the program enforces on `cooldownSlots` above (~1 year at 2.5 slots/s).
 * Mirrors `percolator-prog::constants::MAX_INSURANCE_WITHDRAW_COOLDOWN_SLOTS`.
 */
export const MAX_INSURANCE_WITHDRAW_COOLDOWN_SLOTS = 78_840_000n;

/**
 * SetLpVaultPaused (tag 79) — pause or unpause the LP vault.
 *
 * Wire: tag(1) + paused(u8) = 2 bytes.
 *
 * @param paused 1 = paused, 0 = active.
 *
 * @example
 * ```ts
 * const data = encodeSetLpVaultPaused({ paused: 1 });
 * ```
 */
export function encodeSetLpVaultPaused(args: { paused: number }): Uint8Array {
  return concatBytes(encU8(IX_TAG.SetLpVaultPaused), encU8(args.paused));
}

/**
 * CloseLpVault (tag 80) — close an empty LP vault.
 *
 * Wire: tag(1) = 1 byte.
 *
 * @example
 * ```ts
 * const data = encodeCloseLpVault();
 * ```
 */
export function encodeCloseLpVault(): Uint8Array {
  return encU8(IX_TAG.CloseLpVault);
}

// ============================================================================
// v17 NFT / B-3 (tags 72/73) — kept from v16
// ============================================================================

/**
 * TransferPortfolioOwnership (tag 72) — B-3 position ownership transfer.
 *
 * Wire: tag(1) + new_owner[32] + asset_index(u16) = 35 bytes.
 *
 * @param newOwner    New owner pubkey.
 * @param assetIndex  Asset/domain index.
 *
 * @example
 * ```ts
 * const data = encodeTransferPortfolioOwnership({
 *   newOwner: newOwnerKey,
 *   assetIndex: 0,
 * });
 * ```
 */
export interface TransferPortfolioOwnershipArgs {
  newOwner: PublicKey | string;
  assetIndex: number;
}

export function encodeTransferPortfolioOwnership(args: TransferPortfolioOwnershipArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.TransferPortfolioOwnership),
    encPubkey(args.newOwner),
    encU16(args.assetIndex),
  );
}

/**
 * SetNftProgramId (tag 73) — register the percolator-nft program in the NftRegistry.
 *
 * Wire: tag(1) + nft_program_id[32] = 33 bytes.
 *
 * @param nftProgramId  Pubkey of the percolator-nft program.
 *
 * @example
 * ```ts
 * const data = encodeSetNftProgramId({ nftProgramId: NFT_PROGRAM_ID });
 * ```
 */
export interface SetNftProgramIdArgs {
  nftProgramId: PublicKey | string;
}

export function encodeSetNftProgramId(args: SetNftProgramIdArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.SetNftProgramId),
    encPubkey(args.nftProgramId),
  );
}

// ============================================================================
// TASK A — v17 oracle-config encoders (tags 34, 35, 36, 62, 63)
// ============================================================================

/**
 * ConfigureHybridOracle (tag 34) — set Pyth/hybrid oracle config for a market asset.
 *
 * v18 wire (integration `a9318945`): tag(1) + asset_index(u16) + market_id(u64) +
 *           now_slot(u64) + now_unix_ts(i64) +
 *           oracle_leg_count(u8) + oracle_leg_flags(u8) + max_staleness_secs(u64) +
 *           hybrid_soft_stale_slots(u64) + mark_ewma_halflife_slots(u64) +
 *           mark_min_fee(u64) + invert(u8) + unit_scale(u32) + conf_filter_bps(u16) +
 *           oracle_leg_feeds[0..3]([32] each) + observation_sequence(u64) = 172 bytes total.
 *
 * BREAKING vs v17 (156-byte payload): adds `market_id` (right after
 * `asset_index`) and appends `observation_sequence` — a strictly-increasing
 * replay nonce (this asset's `oracle_observation` control-sequences lane).
 *
 * Accounts: [0] oracle_authority (signer), [1] market (writable),
 *           [2..2+oracle_leg_count] oracle feed accounts (read-only).
 *
 * Constraints (from v16_program.rs:10419-10435):
 *   - oracle_leg_count ∈ [1, ORACLE_LEG_CAP=3]
 *   - max_staleness_secs ∈ [1, MAX_ORACLE_STALENESS_SECS=86400]
 *   - hybrid_soft_stale_slots > 0
 *   - invert ∈ {0, 1}
 *   - Caller must be the asset's oracle_authority
 *
 * @param assetIndex               Asset slot index (u16).
 * @param marketId                 The asset's market_id.
 * @param nowSlot                  Current on-chain slot (u64).
 * @param nowUnixTs                Current Unix timestamp in seconds (i64).
 * @param oracleLegCount           Number of active oracle legs (1–3).
 * @param oracleLegFlags           Bit-flags for oracle leg configuration.
 * @param maxStalenessSecs         Maximum oracle staleness in seconds (1–86400).
 * @param hybridSoftStaleSlots     Slots after which the hybrid oracle is considered soft-stale.
 * @param markEwmaHalflifeSlots    EWMA half-life for mark price smoothing (slots).
 * @param markMinFee               Minimum fee charged per mark-price update.
 * @param invert                   0 = normal, 1 = invert price (e.g., for inverted pairs).
 * @param unitScale                Unit scaling factor (u32).
 * @param confFilterBps            Confidence filter in basis points (u16).
 * @param oracleLegFeeds           Array of exactly 3 oracle leg feed pubkeys (unused slots = SystemProgram).
 * @param observationSequence      Strictly-increasing replay nonce (this asset's `oracle_observation` lane).
 *
 * @example
 * ```ts
 * const data = encodeConfigureHybridOracle({
 *   assetIndex: 1,
 *   marketId: 1n,
 *   nowSlot: 300000000n,
 *   nowUnixTs: 1700000000n,
 *   oracleLegCount: 1,
 *   oracleLegFlags: 0,
 *   maxStalenessSecs: 60n,
 *   hybridSoftStaleSlots: 100n,
 *   markEwmaHalflifeSlots: 500n,
 *   markMinFee: 0n,
 *   invert: 0,
 *   unitScale: 1000000,
 *   confFilterBps: 200,
 *   oracleLegFeeds: [PYTH_FEED_KEY, PublicKey.default, PublicKey.default],
 *   observationSequence: nextObservationSequence,
 * });
 * assert(data.length === 172);
 * ```
 */
export interface ConfigureHybridOracleArgs {
  assetIndex: number;
  marketId: bigint | string;
  nowSlot: bigint | string;
  nowUnixTs: bigint | string;
  oracleLegCount: number;
  oracleLegFlags: number;
  maxStalenessSecs: bigint | string;
  hybridSoftStaleSlots: bigint | string;
  markEwmaHalflifeSlots: bigint | string;
  markMinFee: bigint | string;
  invert: number;
  unitScale: number;
  confFilterBps: number;
  /** Exactly 3 entries — unused legs MUST be PublicKey.default (all zeros). */
  oracleLegFeeds: [PublicKey | string, PublicKey | string, PublicKey | string];
  observationSequence: bigint | string;
}

const ORACLE_LEG_CAP = 3;

export function encodeConfigureHybridOracle(args: ConfigureHybridOracleArgs): Uint8Array {
  if (!Number.isInteger(args.oracleLegCount) || args.oracleLegCount < 1 || args.oracleLegCount > ORACLE_LEG_CAP) {
    throw new Error(`encodeConfigureHybridOracle: oracleLegCount must be an integer in 1..${ORACLE_LEG_CAP}`);
  }
  return concatBytes(
    encU8(IX_TAG.ConfigureHybridOracle),
    encU16(args.assetIndex),
    encU64(args.marketId),
    encU64(args.nowSlot),
    encI64(args.nowUnixTs),
    encU8(args.oracleLegCount),
    encU8(args.oracleLegFlags),
    encU64(args.maxStalenessSecs),
    encU64(args.hybridSoftStaleSlots),
    encU64(args.markEwmaHalflifeSlots),
    encU64(args.markMinFee),
    encU8(args.invert),
    encU32(args.unitScale),
    encU16(args.confFilterBps),
    encPubkey(args.oracleLegFeeds[0]),
    encPubkey(args.oracleLegFeeds[1]),
    encPubkey(args.oracleLegFeeds[2]),
    encU64(args.observationSequence),
  );
}

/**
 * ConfigureEwmaMark (tag 35) — set EWMA mark oracle config for a market asset.
 *
 * v18 wire (integration `a9318945`): tag(1) + asset_index(u16) + market_id(u64) +
 *           now_slot(u64) + initial_mark_e6(u64) +
 *           mark_ewma_halflife_slots(u64) + mark_min_fee(u64) +
 *           observation_sequence(u64) = 51 bytes total.
 *
 * BREAKING vs v17 (35-byte payload): adds `market_id` (right after
 * `asset_index`) and appends `observation_sequence`.
 *
 * Accounts: [0] oracle_authority (signer), [1] market (writable).
 *
 * Constraints (from v16_program.rs:10558-10563):
 *   - initial_mark_e6 ∈ [1, MAX_ORACLE_PRICE]
 *   - mark_ewma_halflife_slots > 0
 *   - Caller must be the asset's oracle_authority
 *
 * @param assetIndex               Asset slot index (u16).
 * @param marketId                 The asset's market_id.
 * @param nowSlot                  Current on-chain slot (u64).
 * @param initialMarkE6            Initial mark price × 1e6 (u64, must be > 0).
 * @param markEwmaHalflifeSlots    EWMA half-life for mark price smoothing (slots, must be > 0).
 * @param markMinFee               Minimum fee charged per mark-price update (u64).
 * @param observationSequence      Strictly-increasing replay nonce (this asset's `oracle_observation` lane).
 *
 * @example
 * ```ts
 * const data = encodeConfigureEwmaMark({
 *   assetIndex: 1,
 *   marketId: 1n,
 *   nowSlot: 300000000n,
 *   initialMarkE6: 50000000000n,
 *   markEwmaHalflifeSlots: 500n,
 *   markMinFee: 0n,
 *   observationSequence: nextObservationSequence,
 * });
 * assert(data.length === 51);
 * ```
 */
export interface ConfigureEwmaMarkArgs {
  assetIndex: number;
  marketId: bigint | string;
  nowSlot: bigint | string;
  initialMarkE6: bigint | string;
  markEwmaHalflifeSlots: bigint | string;
  markMinFee: bigint | string;
  observationSequence: bigint | string;
}

function requirePositiveU64(value: bigint | string, field: string): void {
  const n = typeof value === "string" ? BigInt(value) : value;
  if (n <= 0n) {
    throw new Error(`${field} must be > 0`);
  }
}
export function encodeConfigureEwmaMark(args: ConfigureEwmaMarkArgs): Uint8Array {
  requirePositiveU64(args.initialMarkE6, "initialMarkE6");
  requirePositiveU64(args.markEwmaHalflifeSlots, "markEwmaHalflifeSlots");

  return concatBytes(
    encU8(IX_TAG.ConfigureEwmaMark),
    encU16(args.assetIndex),
    encU64(args.marketId),
    encU64(args.nowSlot),
    encU64(args.initialMarkE6),
    encU64(args.markEwmaHalflifeSlots),
    encU64(args.markMinFee),
    encU64(args.observationSequence),
  );
}

/**
 * PushEwmaMark (tag 36) — push a new EWMA mark price observation.
 *
 * v18 wire (integration `a9318945`): tag(1) + asset_index(u16) + market_id(u64) +
 *   now_slot(u64) + mark_e6(u64) + observation_sequence(u64) = 35 bytes total.
 *
 * BREAKING vs v17 (19-byte payload): adds `market_id` (right after
 * `asset_index`) and appends `observation_sequence`.
 *
 * Accounts: [0] oracle_authority (signer), [1] market (writable).
 *
 * Constraints (from v16_program.rs:10771):
 *   - mark_e6 ∈ [1, MAX_ORACLE_PRICE]
 *   - Asset oracle mode must be ORACLE_MODE_EWMA_MARK
 *   - Caller must be the asset's oracle_authority
 *   - now_slot ≥ last EWMA slot and current market slot
 *
 * @param assetIndex    Asset slot index (u16).
 * @param marketId      The asset's market_id.
 * @param nowSlot       Current on-chain slot (u64).
 * @param markE6        New mark price × 1e6 (u64, must be > 0).
 * @param observationSequence  Strictly-increasing replay nonce (this asset's `oracle_observation` lane).
 *
 * @example
 * ```ts
 * const data = encodePushEwmaMark({
 *   assetIndex: 1, marketId: 1n, nowSlot: 300000001n, markE6: 50100000000n,
 *   observationSequence: nextObservationSequence,
 * });
 * assert(data.length === 35);
 * ```
 */
export interface PushEwmaMarkArgs {
  assetIndex: number;
  marketId: bigint | string;
  nowSlot: bigint | string;
  markE6: bigint | string;
  observationSequence: bigint | string;
}

export function encodePushEwmaMark(args: PushEwmaMarkArgs): Uint8Array {
  requirePositiveU64(args.markE6, "markE6");

  return concatBytes(
    encU8(IX_TAG.PushEwmaMark),
    encU16(args.assetIndex),
    encU64(args.marketId),
    encU64(args.nowSlot),
    encU64(args.markE6),
    encU64(args.observationSequence),
  );
}

/**
 * ConfigureAuthMark (tag 62) — set auth-push mark oracle for a market asset.
 *
 * v18 wire (integration `a9318945`): tag(1) + asset_index(u16) + market_id(u64) +
 *   now_slot(u64) + initial_mark_e6(u64) + observation_sequence(u64) = 35 bytes total.
 *
 * BREAKING vs v17 (19-byte payload): adds `market_id` (right after
 * `asset_index`) and appends `observation_sequence`.
 *
 * Accounts: [0] oracle_authority (signer), [1] market (writable).
 *
 * Constraints (from v16_program.rs:10665):
 *   - initial_mark_e6 ∈ [1, MAX_ORACLE_PRICE]
 *   - Caller must be the asset's oracle_authority
 *
 * @param assetIndex       Asset slot index (u16).
 * @param marketId         The asset's market_id.
 * @param nowSlot          Current on-chain slot (u64).
 * @param initialMarkE6    Initial mark price × 1e6 (u64, must be > 0).
 * @param observationSequence  Strictly-increasing replay nonce (this asset's `oracle_observation` lane).
 *
 * @example
 * ```ts
 * const data = encodeConfigureAuthMark({
 *   assetIndex: 1, marketId: 1n, nowSlot: 300000000n, initialMarkE6: 50000000000n,
 *   observationSequence: nextObservationSequence,
 * });
 * assert(data.length === 35);
 * ```
 */
export interface ConfigureAuthMarkArgs {
  assetIndex: number;
  marketId: bigint | string;
  nowSlot: bigint | string;
  initialMarkE6: bigint | string;
  observationSequence: bigint | string;
}

export function encodeConfigureAuthMark(args: ConfigureAuthMarkArgs): Uint8Array {
  requirePositiveU64(args.initialMarkE6, "initialMarkE6");

  return concatBytes(
    encU8(IX_TAG.ConfigureAuthMark),
    encU16(args.assetIndex),
    encU64(args.marketId),
    encU64(args.nowSlot),
    encU64(args.initialMarkE6),
    encU64(args.observationSequence),
  );
}

/**
 * PushAuthMark (tag 63) — push a new auth-mark price observation.
 *
 * v18 wire (integration `a9318945`): tag(1) + asset_index(u16) + market_id(u64) +
 *   now_slot(u64) + mark_e6(u64) + observation_sequence(u64) = 35 bytes total.
 *
 * BREAKING vs v17 (19-byte payload): adds `market_id` (right after
 * `asset_index`) and appends `observation_sequence`.
 *
 * Accounts: [0] oracle_authority (signer), [1] market (writable).
 *
 * Constraints (from v16_program.rs:10847):
 *   - mark_e6 ∈ [1, MAX_ORACLE_PRICE]
 *   - Asset oracle mode must be ORACLE_MODE_AUTH_MARK
 *   - Caller must be the asset's oracle_authority
 *   - now_slot ≥ last EWMA slot and current market slot
 *
 * @param assetIndex    Asset slot index (u16).
 * @param marketId      The asset's market_id.
 * @param nowSlot       Current on-chain slot (u64).
 * @param markE6        New mark price × 1e6 (u64, must be > 0).
 * @param observationSequence  Strictly-increasing replay nonce (this asset's `oracle_observation` lane).
 *
 * @example
 * ```ts
 * const data = encodePushAuthMark({
 *   assetIndex: 1, marketId: 1n, nowSlot: 300000001n, markE6: 50100000000n,
 *   observationSequence: nextObservationSequence,
 * });
 * assert(data.length === 35);
 * ```
 */
export interface PushAuthMarkArgs {
  assetIndex: number;
  marketId: bigint | string;
  nowSlot: bigint | string;
  markE6: bigint | string;
  observationSequence: bigint | string;
  /**
   * v2.2 G8 depth input. Omitted => the 35-byte form, which ZEROES the stored depth on-chain (absent depth is never
   * stale-but-trusted). Present => the 44-byte form `[...35 B][depth_mode u8][depth_e6 u64 LE]`.
   * `mode` 0 = none, 1 = keeper-attested, 2 = on-chain DEX pool (R2.1: `depthE6` must be 0 and the instruction needs four more accounts, see
   * `buildPushAuthMarkDexIxV22`); any other value is refused on-chain with error 128 `DepthInputInvalid`, so it is rejected here too. `depthE6` is the +-2% pool depth in USD e6 (collateral 6 decimals).
   */
  depth?: { mode: 0 | 1 | 2; depthE6: bigint | string };
}

/** Length of the legacy PushAuthMark body. */
export const PUSH_AUTH_MARK_LEN = 35;
/** Length of the v2.2 PushAuthMark body with the depth input. */
export const PUSH_AUTH_MARK_DEPTH_LEN = 44;

export function encodePushAuthMark(args: PushAuthMarkArgs): Uint8Array {
  requirePositiveU64(args.markE6, "markE6");
  const head = concatBytes(
    encU8(IX_TAG.PushAuthMark),
    encU16(args.assetIndex),
    encU64(args.marketId),
    encU64(args.nowSlot),
    encU64(args.markE6),
    encU64(args.observationSequence),
  );
  if (args.depth === undefined) return head;
  const mode: number = args.depth.mode;
  if (mode !== 0 && mode !== 1 && mode !== 2) throw new Error(`PushAuthMark depth mode must be 0 (none), 1 (attested) or 2 (on-chain pool), got ${mode}`);
  // On chain, mode 0 and mode 2 with a non-zero depth are refused with 128 too.
  if (mode === 0 && BigInt(args.depth.depthE6) !== 0n) throw new Error('PushAuthMark depth mode 0 (none) must carry depth 0');
  if (mode === 2 && BigInt(args.depth.depthE6) !== 0n) throw new Error('PushAuthMark depth mode 2 (on-chain pool) must carry depth 0; the program reads the pool');
  return concatBytes(head, encU8(mode), encU64(args.depth.depthE6));
}

// ============================================================================
// TASK B — Matcher passive-init payload (matcher program, not wrapper)
// ============================================================================

/**
 * MatcherInitPassive — 78-byte `InitParams` payload sent to the MATCHER
 * PROGRAM (not wrapper) to initialize a passive LP matcher context.
 *
 * This is NOT a wrapper instruction. Program = matcher program address.
 * Accounts: [0] matcherDelegate (read-only PDA, signer), [1] matcherCtx (writable).
 *
 * Wire layout (78 bytes = {@link INIT_CTX_LEN}, byte-matched against
 * `percolator-match::vamm::InitParams::{parse,encode}` at
 * sync/v16-migration-backing-fee-cap@12bd671, and cross-checked against the
 * checked-in `specs/matcher-parity.json` `init_field_offsets` fixture, which
 * is generated straight from that source via `sdk_parity_fixtures`):
 *   [0]       = 2          (tag: MATCHER_INIT_VAMM_TAG, shared by Passive/vAMM init)
 *   [1]       = 0          (kind: 0 = Passive)
 *   [2..6]    = 0u32 LE    (trading_fee_bps)
 *   [6..10]   = 0u32 LE    (base_spread_bps)
 *   [10..14]  = 100u32 LE  (max_total_bps — 100 bps default fee+spread cap)
 *   [14..18]  = 0u32 LE    (impact_k_bps — vAMM only, unused for Passive)
 *   [18..34]  = 0          (liquidity_notional_e6, u128 LE — vAMM only)
 *   [34..50]  = max_fill_abs (u128 LE)
 *   [50..66]  = 0          (max_inventory_abs, u128 LE — 0 = unlimited)
 *   [66..68]  = 0u16 LE    (fee_to_insurance_bps)
 *   [68..70]  = 0u16 LE    (skew_spread_mult_bps)
 *   [70..78]  = lp_account_id (u64 LE)
 *   Total = 78 bytes
 *
 * GH#10 parity fix: the matcher's `process_init` now unconditionally rejects
 * `lp_account_id == 0` with `InvalidInstructionData` — a context created
 * without a bound lp_account_id had no cross-market spoof-guard binding at
 * all (`ctx.lp_account_id != 0 && call.lp_account_id != ctx.lp_account_id`
 * never triggered for it). The pre-fix 66-byte payload this function used to
 * emit falls short of {@link INIT_CTX_LEN}, so the matcher's `extended` check
 * treats it as the v3-compat shape and defaults `lp_account_id` to 0 —
 * meaning every call was rejected unconditionally against the v18 matcher.
 * `lpAccountId` is therefore now a required, non-zero argument.
 *
 * The matcher delegate PDA is derived via `deriveMatcherDelegate()` in pda.ts using
 * seeds ["matcher", market, accountB, accountBOwner, matcherProg, matcherCtx].
 * The caller passes the same numeric id it derived its delegate PDA from
 * (percolator-prog derives this as the low 8 bytes of the matcher delegate
 * pubkey) so `process_call`'s `call.lp_account_id == ctx.lp_account_id`
 * cross-market check binds correctly.
 *
 * @param maxFillAbs   Maximum absolute fill size (u128). Pass 2n**128n-1n for no limit
 *                     (the matcher clamps this to i128::MAX at init).
 * @param lpAccountId  Numeric LP account identifier (u64). MUST be non-zero — the
 *                     v18 matcher's `process_init` rejects `lp_account_id == 0`
 *                     unconditionally (GH#10).
 *
 * @example
 * ```ts
 * const data = encodeMatcherInitPassive({ maxFillAbs: 2n ** 128n - 1n, lpAccountId: 12345n });
 * assert(data.length === 78);
 * // send to matcherProgram, accounts: [delegate(signer), ctx(w)]
 * ```
 */
export interface MatcherInitPassiveArgs {
  maxFillAbs: bigint | string;
  lpAccountId: bigint | string;
}

export function encodeMatcherInitPassive(args: MatcherInitPassiveArgs): Uint8Array {
  requirePositiveU64(args.lpAccountId, "lpAccountId");

  const buf = new Uint8Array(INIT_CTX_LEN);
  buf[0] = 2; // MATCHER_INIT_VAMM_TAG
  buf[1] = 0; // kind = Passive
  // [10..14] = 100u32 LE (max_total_bps default fee+spread cap)
  buf.set(encU32(100), 10);
  // [34..50] = max_fill_abs u128 LE
  buf.set(encU128(args.maxFillAbs), 34);
  // [70..78] = lp_account_id u64 LE (GH#10 — must be non-zero)
  buf.set(encU64(args.lpAccountId), 70);
  return buf;
}

// ============================================================================
// Protocol-fee program change (tags 84/85) — v17 wire, WrapperConfigV16 496B.
// See ~/v17/PROTOCOL-FEE-DESIGN.md §3. Verified against
// percolator-prog/src/v16_program.rs (feat/protocol-fee-taker-only@626fb617)
// Instruction::decode arms 84/85 and handle_withdraw_protocol_fee /
// handle_set_protocol_fee_authority.
//
// Renumbered 2026-07-15 (83→84, 84→85) to keep tag 83 reserved for
// InitMatcherCtx, which forensic rebuild + live simulateTransaction confirmed
// is live on the deployed wrapper (percolator-prog@e26c97a4) — see
// ~/v17/DECISIONS-LEDGER.md, "Pinned deployed revisions".
//
// ⚠️ Only valid against VERSION=17 markets (protocol-fee wrapper). The
// pre-protocol-fee (VERSION=16) wrapper has no decode arm at tag 84/85 at
// all — sending this encoded data to it would be rejected or misinterpreted.
// ============================================================================

/**
 * WithdrawProtocolFee instruction data (tag 84, v18 wire, integration `a9318945`).
 *
 * v18 wire: tag(1) + amount(u128 LE) + authority_epoch(u64) = 25 bytes.
 *
 * BREAKING vs v17 (17-byte payload): appends `authority_epoch` (W4-AE-84) —
 * a CAS check against the market-wide `protocol_fee_authority_epoch` counter
 * (`PROTOCOL_FEE_AUTHORITY_EPOCH_OFF`, carved into asset-0's wrapper-slot
 * headroom at offset 600; distinct from any per-asset
 * `AssetControlSequencesV16.authority_epoch` lane, since
 * `protocol_fee_authority` is market-config-scoped, not asset-scoped).
 * Incremented by tag 85 (SetProtocolFeeAuthority). Pass the LIVE current
 * epoch, NOT current+1 — this closes an A->B->A replay window across an
 * intervening authority rotation.
 *
 * Pays out from the accrued-but-unwithdrawn protocol claim
 * (`protocol_fee_accrued_atoms - protocol_fee_withdrawn_atoms` on
 * WrapperConfigV17) to an external token account. Signer-gated on
 * `cfg.protocolFeeAuthority` (see `parseWrapperConfigV17`). The transfer is
 * clamped to what's actually available on-chain (engine surplus, vault
 * balance) and only the actually-transferred amount is marked withdrawn —
 * this never errors solely because the ledger raced ahead of availability.
 *
 * @param amount Atoms to withdraw (u128). Pass `0n` to withdraw all
 *               currently-available capacity.
 * @param authorityEpoch  Live-read current `protocol_fee_authority_epoch` (CAS, expected-current).
 *
 * @example
 * ```ts
 * const data = encodeWithdrawProtocolFee({ amount: 0n, authorityEpoch: 0n }); // withdraw-all
 * // accounts: ACCOUNTS_WITHDRAW_PROTOCOL_FEE from abi/accounts.ts
 * ```
 */
export interface WithdrawProtocolFeeArgs {
  amount: bigint | string;
  authorityEpoch: bigint | string;
}

export function encodeWithdrawProtocolFee(args: WithdrawProtocolFeeArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.WithdrawProtocolFee),
    encU128(args.amount),
    encU64(args.authorityEpoch),
  );
}

/**
 * SetProtocolFeeAuthority instruction data (tag 85).
 *
 * v17 wire: tag(1) + new_authority(32) = 33 bytes.
 *
 * Rotates `cfg.protocolFeeAuthority` on a single market. Gated on the
 * program's BPF upgrade authority (a `ProgramData` PDA read, NOT
 * marketauth/insurance_authority/any creator-facing gate) — see
 * ACCOUNTS_SET_PROTOCOL_FEE_AUTHORITY in abi/accounts.ts. No global fan-out;
 * a keeper script iterates markets for a mass rotation.
 *
 * @param newAuthority New protocol-fee-authority pubkey.
 *
 * @example
 * ```ts
 * const data = encodeSetProtocolFeeAuthority({ newAuthority: newTreasury });
 * ```
 */
export interface SetProtocolFeeAuthorityArgs {
  newAuthority: PublicKey;
}

export function encodeSetProtocolFeeAuthority(args: SetProtocolFeeAuthorityArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.SetProtocolFeeAuthority),
    encPubkey(args.newAuthority),
  );
}

// ============================================================================
// v17 FEE-COLLECTION SPLIT (tags 86/87/88)
// percolator-prog feat/protocol-fee-taker-only@2b3a6a65
// ============================================================================

/**
 * On-chain fee-split constants, mirrored from `v16_program.rs::constants`.
 *
 * `T = trade_fee_base_bps` is the whole trade fee. It splits four ways at
 * every trade-fee credit site: a constant 2000 bps protocol skim, then the
 * three stored shares below, which are bps *of T* and must sum to exactly
 * `FEE_SHARE_TOTAL_BPS`.
 *
 * The floors are percentages of the post-protocol remainder (creator <= 45%,
 * LP >= 40%, insurance >= 15%) converted to bps-of-T by `pct * 8000`. They sum
 * to exactly 8000, i.e. they are precisely complementary — pushing creator
 * above its ceiling necessarily drags another leg under its floor.
 *
 * Defaults are written unconditionally at InitMarket and are never instruction
 * arguments, so a market that never calls UpdateFeeSplit still pays all four
 * legs correctly from its first trade.
 */
export const FEE_SPLIT = {
  /** Constant protocol skim, bps of T. Compile-time in the program; not stored, not settable. */
  PROTOCOL_FEE_BPS: 2000,
  /** The three stored shares must sum to exactly this (= 10_000 - PROTOCOL_FEE_BPS). */
  FEE_SHARE_TOTAL_BPS: 8000,
  DEFAULT_CREATOR_SHARE_BPS: 1600,
  DEFAULT_LP_SHARE_BPS: 4800,
  DEFAULT_INSURANCE_SHARE_BPS: 1600,
  /** Creator ceiling, bps of T (45% of the post-protocol remainder). */
  MAX_CREATOR_SHARE_BPS: 3600,
  /** LP floor, bps of T (40% of the post-protocol remainder). */
  MIN_LP_SHARE_BPS: 3200,
  /** Insurance/staker floor, bps of T (15% of the post-protocol remainder). */
  MIN_INSURANCE_SHARE_BPS: 1200,
} as const;
Object.freeze(FEE_SPLIT);

/**
 * Client-side mirror of `policy_v16::validate_fee_split`. Returns `null` when
 * the split would be accepted on-chain, otherwise a human-readable reason.
 *
 * Provided so a wizard/UI can reject a bad split before paying for a
 * transaction; the wrapper enforces the same rules regardless (Custom(52)
 * FeeSplitSumInvalid for the sum, Custom(51) FeeSplitFloorViolation for the
 * floors), so this is a convenience, never the security boundary.
 *
 * @param args The three candidate shares, in bps of T.
 * @returns `null` if valid, else a string describing the first violation.
 *
 * @example
 * ```ts
 * validateFeeSplit({ creatorShareBps: 1600, lpShareBps: 4800, insuranceShareBps: 1600 });
 * // => null (these are the on-chain defaults)
 * validateFeeSplit({ creatorShareBps: 4000, lpShareBps: 3200, insuranceShareBps: 800 });
 * // => "creatorShareBps 4000 exceeds MAX_CREATOR_SHARE_BPS 3600"
 * ```
 */
export function validateFeeSplit(args: UpdateFeeSplitArgs): string | null {
  const { creatorShareBps, lpShareBps, insuranceShareBps } = args;
  const sum = creatorShareBps + lpShareBps + insuranceShareBps;
  if (sum !== FEE_SPLIT.FEE_SHARE_TOTAL_BPS) {
    return `shares sum to ${sum}, must sum to exactly FEE_SHARE_TOTAL_BPS ${FEE_SPLIT.FEE_SHARE_TOTAL_BPS}`;
  }
  if (creatorShareBps > FEE_SPLIT.MAX_CREATOR_SHARE_BPS) {
    return `creatorShareBps ${creatorShareBps} exceeds MAX_CREATOR_SHARE_BPS ${FEE_SPLIT.MAX_CREATOR_SHARE_BPS}`;
  }
  if (lpShareBps < FEE_SPLIT.MIN_LP_SHARE_BPS) {
    return `lpShareBps ${lpShareBps} is below MIN_LP_SHARE_BPS ${FEE_SPLIT.MIN_LP_SHARE_BPS}`;
  }
  if (insuranceShareBps < FEE_SPLIT.MIN_INSURANCE_SHARE_BPS) {
    return `insuranceShareBps ${insuranceShareBps} is below MIN_INSURANCE_SHARE_BPS ${FEE_SPLIT.MIN_INSURANCE_SHARE_BPS}`;
  }
  return null;
}

/**
 * UpdateFeeSplit instruction data (tag 86, v18 wire, integration `a9318945`).
 *
 * v18 wire: tag(1) + creator_share_bps(u16 LE) + lp_share_bps(u16 LE) +
 * insurance_share_bps(u16 LE) + authority_epoch(u64) = 15 bytes.
 *
 * BREAKING vs v17 (7-byte payload): appends `authority_epoch` (W4-AE-EXTEND)
 * — a CAS check sharing asset-0's `AssetControlSequencesV16.authority_epoch`
 * lane (this tag is gated on `cfg.marketauth`, which asset-0's lane already
 * tracks rotations for via tag 32). Pass the LIVE current epoch, NOT
 * current+1.
 *
 * Sets the three stored fee shares. Gated on `cfg.marketauth` — see
 * ACCOUNTS_UPDATE_FEE_SPLIT in abi/accounts.ts. Shares are bps of T and must
 * sum to FEE_SHARE_TOTAL_BPS (8000) while satisfying the floors; use
 * {@link validateFeeSplit} to check before sending.
 *
 * ⚠ ORDERING: call this BEFORE `StakeInitPool`, which irreversibly rotates
 * `cfg.marketauth` to the stake-pool PDA. Afterwards a PDA cannot sign a
 * top-level transaction and this tag is reachable only via the stake program's
 * CPI proxy — see {@link encodeStakeAdminUpdateFeeSplit} (stake tag 25).
 *
 * @param creatorShareBps Creator's share of T in bps. Must be <= 3600.
 * @param lpShareBps LP vault's share of T in bps. Must be >= 3200.
 * @param insuranceShareBps Insurance/staker share of T in bps. Must be >= 1200.
 * @param authorityEpoch  Live-read current authority_epoch for asset 0 (CAS, expected-current).
 * @returns 15-byte instruction data buffer.
 *
 * @example
 * ```ts
 * // Restore the on-chain defaults explicitly.
 * const data = encodeUpdateFeeSplit({
 *   creatorShareBps: 1600,
 *   lpShareBps: 4800,
 *   insuranceShareBps: 1600,
 *   authorityEpoch: 0n,
 * });
 * // accounts: ACCOUNTS_UPDATE_FEE_SPLIT from abi/accounts.ts
 * ```
 */
export interface UpdateFeeSplitArgs {
  creatorShareBps: number;
  lpShareBps: number;
  insuranceShareBps: number;
  authorityEpoch: bigint | string;
}

export function encodeUpdateFeeSplit(args: UpdateFeeSplitArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.UpdateFeeSplit),
    encU16(args.creatorShareBps),
    encU16(args.lpShareBps),
    encU16(args.insuranceShareBps),
    encU64(args.authorityEpoch),
  );
}

/**
 * WithdrawInsuranceReserveToStake instruction data (tag 87).
 *
 * v17 wire: tag(1) = 1 byte. No arguments — the amount is
 * `insurance_reserve_accrued_atoms - insurance_reserve_withdrawn_atoms`,
 * clamped on-chain to engine-available surplus, and the destination is derived
 * rather than passed.
 *
 * Permissionless: any signer may crank it. The destination is `pool.vault`,
 * read out of the stake pool at `["stake_pool", market]` under the wrapper's
 * PINNED stake program id, so there is nothing for a caller to redirect.
 *
 * ⚠ Live-only. Rejects Recovery and Resolved (Custom 21 EngineLockActive) and
 * matured-Live. `ResolveMarket` is one-way and `WithdrawInsuranceAsset` (tag
 * 41/57) cannot reach this unbudgeted leg, so anything accrued but not pushed
 * before a market resolves is PERMANENTLY FORFEITED by stakers. Crank before
 * resolution.
 *
 * ⚠ A default (non-devnet) wrapper build has no pinned stake program id and
 * fails closed with Custom(60) StakeProgramNotPinned. There is no v17 mainnet
 * stake deployment.
 *
 * @returns 1-byte instruction data buffer.
 *
 * @example
 * ```ts
 * const data = encodeWithdrawInsuranceReserveToStake();
 * // accounts: ACCOUNTS_WITHDRAW_INSURANCE_RESERVE_TO_STAKE from abi/accounts.ts
 * ```
 */
export function encodeWithdrawInsuranceReserveToStake(): Uint8Array {
  return encU8(IX_TAG.WithdrawInsuranceReserveToStake);
}

/**
 * UpdateMaintenanceFeePerSlot instruction data (tag 88).
 *
 * v17 wire: tag(1) + maintenance_fee_per_slot(u128 LE) = 17 bytes.
 *
 * ⚠ THE PAYLOAD IS u128, NOT u64. The wrapper decodes it with `read_u128`,
 * matching the storage type (`WrapperConfigV16::maintenance_fee_per_slot`) and
 * InitMarket's own encoding. A u64 payload leaves 8 bytes unconsumed and the
 * wrapper rejects the instruction outright.
 *
 * Gated on `cfg.marketauth`. The wrapper range-checks against
 * `MAX_PROTOCOL_FEE_ABS` (1e36) and returns Custom(14) EngineInvalidConfig if
 * exceeded — the same bound InitMarket applies.
 *
 * Same StakeInitPool ordering caveat as tag 86; the proxy is
 * {@link encodeStakeAdminUpdateMaintenanceFeePerSlot} (stake tag 26).
 *
 * @param maintenanceFeePerSlot Fee charged per slot, u128. Default is 0
 *                              (maintenance fee disabled).
 * @returns 17-byte instruction data buffer.
 *
 * @example
 * ```ts
 * const data = encodeUpdateMaintenanceFeePerSlot({ maintenanceFeePerSlot: 0n });
 * // accounts: ACCOUNTS_UPDATE_MAINTENANCE_FEE_PER_SLOT from abi/accounts.ts
 * ```
 */
export interface UpdateMaintenanceFeePerSlotArgs {
  maintenanceFeePerSlot: bigint | string;
}

export function encodeUpdateMaintenanceFeePerSlot(
  args: UpdateMaintenanceFeePerSlotArgs,
): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.UpdateMaintenanceFeePerSlot),
    encU128(args.maintenanceFeePerSlot),
  );
}

/**
 * UpdateTradeFeePolicy instruction data (tag 55, v18 wire, integration `a9318945`).
 *
 * v18 wire: tag(1) + trade_fee_base_bps(u64 LE) + policy_sequence(u64 LE) = 17 bytes.
 *
 * BREAKING vs v17 (9-byte payload): appends `policy_sequence` — a
 * strictly-increasing replay nonce (asset-0's `trade_fee` control-sequences
 * lane), NOT a CAS/current-epoch value.
 *
 * Sets `T`, the base trade fee that the four-way split divides. Gated on
 * ASSET 0's `insurance_authority`, NOT on `marketauth` — so unlike tags 86/88
 * this survives `StakeInitPool` but is stranded by `BindInsuranceAuthority`,
 * after which the proxy is {@link encodeStakeAdminUpdateTradeFeePolicy}
 * (stake tag 28).
 *
 * ⚠ Note the type asymmetry with tag 88: this decodes with `read_u64`, tag 88
 * with `read_u128`.
 *
 * Added 2026-07-20: IX_TAG.UpdateTradeFeePolicy existed but had no encoder,
 * which left stake tag 28's CPI target unrepresentable from the SDK.
 *
 * @param tradeFeeBaseBps Base trade fee in bps (u64).
 * @param policySequence  Strictly-increasing replay nonce (asset-0's `trade_fee` lane).
 * @returns 17-byte instruction data buffer.
 *
 * @example
 * ```ts
 * const data = encodeUpdateTradeFeePolicy({ tradeFeeBaseBps: 30n, policySequence: nextPolicySequence });
 * ```
 */
export interface UpdateTradeFeePolicyArgs {
  tradeFeeBaseBps: bigint | string;
  policySequence: bigint | string;
}

export function encodeUpdateTradeFeePolicy(args: UpdateTradeFeePolicyArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.UpdateTradeFeePolicy),
    encU64(args.tradeFeeBaseBps),
    encU64(args.policySequence),
  );
}

/**
 * ExpireBackingBucket instruction data (tag 89).
 *
 * v17 wire: tag(1) + domain(u16 LE) = 3 bytes. Verified against
 * v16_program.rs's tag-89 decode arm (`89 => Self::ExpireBackingBucket {
 * domain: read_u16(&mut rest)? }`) followed by the shared
 * `if !rest.is_empty()` guard — any trailing byte is rejected.
 *
 * PERMISSIONLESS. One account, the market, writable, and NO signer at all
 * (see ACCOUNTS_EXPIRE_BACKING_BUCKET). Any keeper can call it; there is no
 * authority to hold.
 *
 * ## Why this exists
 *
 * A realized loss reserves capital as counterparty backing, which opens the
 * source domain's bucket as `Fresh` with a fixed `expiry_slot`. Once that
 * expiry passes while the bucket is still `Fresh`, the domain becomes a DEAD
 * END in all three directions, permanently:
 *
 *   - settling a GAIN against it     -> Custom(19) EngineStale
 *   - reserving a further LOSS       -> Custom(21) EngineLockActive
 *   - `TopUpBackingBucket` to re-fund it -> Custom(21) EngineLockActive
 *
 * The bucket cannot even be paid to come back. Before tag 89 the wrapper had
 * no call site that reached the engine's own escape hatch
 * (`expire_source_backing_bucket_not_atomic`) on a LIVE market — the engine
 * used it only on the RESOLVED close path — so a lapse bricked the domain for
 * good. Tag 89 IS that missing call site.
 *
 * ## ⚠ This is routine maintenance, not an edge case — wire a keeper
 *
 * EVERY BACKED MARKET LAPSES EVENTUALLY. `fresh_counterparty_backing_expiry_slot`
 * returns the stored expiry unchanged on a live bucket, so the expiry is set
 * once when the bucket opens and is never extended. Seeding a long horizon
 * (e.g. MAX_BACKING_BUCKET_EXPIRY_SLOT) DEFERS the lapse; it does not prevent
 * it. Treat tag 89 as a standing keeper duty alongside the crank, not as an
 * incident-response tool: a keeper should scan live markets for domains whose
 * bucket is `Fresh` with `current_slot >= expiry_slot` and expire them. If
 * nobody cranks it, the first lapse silently bricks the domain and the failure
 * surfaces to users as an unexplained Custom(19)/Custom(21) on ordinary
 * settlement.
 *
 * ## Safety
 *
 * Permissionless is not an authority hole. The engine refuses the transition
 * unless the bucket is `Fresh` AND `now_slot >= expiry_slot`, and `now_slot`
 * is read from the runtime `Clock` (via
 * `authenticated_market_slot_or_fallback_view`), NEVER from a caller argument
 * — so no caller can force an early forfeiture. Moves no tokens.
 *
 * Expiry forfeits the lapsed principal to the junior pool. That is the
 * engine's documented expiry semantics, not a haircut invented by this
 * instruction; the alternative is the account never settling at all.
 *
 * ## Failure modes
 *
 * - Custom(21) EngineLockActive — the market is not Live (`mode != 0`). The
 *   resolved/wound-down path reaches the transition through the engine's own
 *   resolved-close sweep, so re-entering it from outside is refused.
 * - Custom(9) InvalidInstruction — `domain >= 2 * max_market_slots`.
 * - Custom(19) EngineStale — the engine declined: the bucket is not `Fresh`,
 *   or it is `Fresh` but has NOT yet lapsed. Fails closed, so calling this
 *   speculatively on a healthy domain is safe (it just reverts).
 *
 * @param domain Backing-bucket domain index (2*assetIndex for long,
 *               2*assetIndex+1 for short), u16. Must be
 *               `< 2 * max_market_slots`.
 * @returns 3-byte instruction data buffer.
 *
 * @example
 * ```ts
 * // Keeper: unbrick the long domain of asset 0 after its bucket lapsed.
 * const data = encodeExpireBackingBucket({ domain: 0 });
 * // accounts: ACCOUNTS_EXPIRE_BACKING_BUCKET — [market] writable, no signer
 * // beyond the fee payer.
 * ```
 */
export interface ExpireBackingBucketArgs {
  domain: number;
}

export function encodeExpireBackingBucket(args: ExpireBackingBucketArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.ExpireBackingBucket),
    encU16(args.domain),
  );
}

// ============================================================================
// v17 CREATOR FEE CLAIM (tag 90)
// percolator-prog, 2026-07-23 creator-fee-claim design §3.
//
// Companion read side: `creatorFeeClaimableAtoms` on WrapperConfigV17
// (u64 LE at V17_CREATOR_FEE_CLAIMABLE_OFF = 568, inside the UNCHANGED
// 576-byte config — see solana/slab.ts).
// ============================================================================

/**
 * WithdrawCreatorFee instruction data (tag 90, v18 wire, integration `a9318945`).
 *
 * v18 wire: tag(1) + amount(u128 LE) + asset_index(u16 LE) + authority_epoch(u64 LE)
 *   = 27 bytes. Verified against percolator-prog `src/v16_program.rs`:
 *
 *   decode arm:  90 => Self::WithdrawCreatorFee { amount: read_u128(&mut rest)?,
 *                  asset_index: read_u16(&mut rest)?, authority_epoch: read_u64(&mut rest)? }
 *   tail guard:  if !rest.is_empty() { return Err(InvalidInstructionData) }
 *                -> total length is EXACTLY 27; any trailing byte is rejected
 *   encode arm:  out.push(90); push_u128(&mut out, amount); push_u16(&mut out, asset_index);
 *                push_u64(&mut out, authority_epoch)
 *
 * BREAKING vs v17 (17-byte, amount-only payload): GH#420 appends
 * `asset_index` (WHICH asset's creator fees — creator-fee accrual moved from
 * one global `WrapperConfigV16::creator_fee_claimable_atoms` counter to a
 * per-asset `AssetOracleProfileV16::creator_fee_claimable_atoms` field, so
 * the withdraw call must now say which asset it's draining) and
 * `authority_epoch` (W4-AE-EXTEND CAS, against THIS asset's OWN
 * `AssetControlSequencesV16.authority_epoch` lane — WithdrawCreatorFee's
 * authority is per-asset, unlike UpdateFeeSplit/UpdateInsuranceWithdrawPolicy
 * which gate on marketauth and share asset-0's lane). Pass the LIVE current
 * epoch, NOT current+1.
 *
 * Pays the market creator's accrued trade-fee share out of the market vault to
 * an external token account, debiting `creatorFeeClaimableAtoms` by exactly
 * `amount`. That counter is disjoint from the insurance domain budget (the loss
 * backstop): before this change the creator leg was credited INTO the backstop,
 * so a "claim fees" button was really a backstop withdrawal. Tag 90 cannot
 * touch the backstop, and tag 57 (WithdrawInsuranceAsset) cannot touch this
 * counter.
 *
 * ⚠ `amount: 0n` is REJECTED by the program (InvalidInstruction), NOT treated
 * as the "withdraw all" sentinel that {@link encodeWithdrawProtocolFee} (tag
 * 84) uses. To drain, read `creatorFeeClaimableAtoms` from
 * `parseWrapperConfigV17` and pass that exact value.
 *
 * ⚠ Over-claim is rejected, not clamped — there is no partial fill, and nothing
 * is debited on failure. If the vault's unbudgeted surplus is momentarily thin
 * the whole instruction fails closed (EngineLockActive); retry with less.
 *
 * ⚠ Authority is asset 0's `insurance_operator` and ONLY that (never
 * `cfg.marketauth`), so claiming still works on a staked market where
 * StakeInitPool has rotated `marketauth` to the stake-pool PDA.
 *
 * @param amount Atoms to claim (u128 on the wire; the on-chain counter is a
 *               u64, so anything above u64::MAX is an over-claim).
 * @param assetIndex      WHICH asset's creator fees to claim.
 * @param authorityEpoch  Live-read current authority_epoch for this asset (CAS, expected-current).
 *
 * @example
 * ```ts
 * const profile = parseAssetOracleProfileV17(marketAccount.data, profileOff);
 * // Drain asset 0's full claimable balance:
 * const data = encodeWithdrawCreatorFee({
 *   amount: profile.creatorFeeClaimableAtoms,
 *   assetIndex: 0,
 *   authorityEpoch: 0n,
 * });
 * // accounts: ACCOUNTS_WITHDRAW_CREATOR_FEE from abi/accounts.ts
 * ```
 */
export interface WithdrawCreatorFeeArgs {
  amount: bigint | string;
  assetIndex: number;
  authorityEpoch: bigint | string;
}

export function encodeWithdrawCreatorFee(args: WithdrawCreatorFeeArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.WithdrawCreatorFee),
    encU128(args.amount),
    encU16(args.assetIndex),
    encU64(args.authorityEpoch),
  );
}
