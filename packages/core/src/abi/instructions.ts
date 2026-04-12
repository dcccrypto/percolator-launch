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
 * Oracle price constraints.
 * Maximum oracle price that can be pushed to the on-chain oracle authority.
 */
export const MAX_ORACLE_PRICE = 1_000_000_000_000n; // 1 trillion e6 = 1M USD/unit

/**
 * Instruction tags - exact match to Rust ix::Instruction::decode
 */
export const IX_TAG = {
  InitMarket: 0,
  InitUser: 1,
  InitLP: 2,
  DepositCollateral: 3,
  WithdrawCollateral: 4,
  KeeperCrank: 5,
  TradeNoCpi: 6,
  LiquidateAtOracle: 7,
  CloseAccount: 8,
  TopUpInsurance: 9,
  TradeCpi: 10,
  SetRiskThreshold: 11,
  UpdateAdmin: 12,
  CloseSlab: 13,
  UpdateConfig: 14,
  SetMaintenanceFee: 15,
  SetOracleAuthority: 16,
  PushOraclePrice: 17,
  SetOraclePriceCap: 18,
  ResolveMarket: 19,
  WithdrawInsurance: 20,
  AdminForceClose: 21,
  // Tags 22-23: on-chain these are SetInsuranceWithdrawPolicy / WithdrawInsuranceLimited.
  // Legacy aliases (UpdateRiskParams/RenounceAdmin) kept for backward compat.
  SetInsuranceWithdrawPolicy: 22,
  /** @deprecated Use SetInsuranceWithdrawPolicy */ UpdateRiskParams: 22,
  WithdrawInsuranceLimited: 23,
  /** @deprecated Use WithdrawInsuranceLimited */ RenounceAdmin: 23,
  // Tags 24–26: on-chain = QueryLpFees/ReclaimEmptyAccount/SettleAccount.
  // Old insurance LP tags removed — those moved to percolator-stake.
  QueryLpFees: 24,
  ReclaimEmptyAccount: 25,
  SettleAccount: 26,
  // Tags 27-28: on-chain = DepositFeeCredits/ConvertReleasedPnl.
  DepositFeeCredits: 27,
  ConvertReleasedPnl: 28,
  // Tags 29-30: on-chain = ResolvePermissionless/ForceCloseResolved.
  ResolvePermissionless: 29,
  /** @deprecated Use ResolvePermissionless */ AcceptAdmin: 29,
  ForceCloseResolved: 30,
  // Tag 31: gap (no decode arm on-chain)
  SetPythOracle: 32,
  UpdateMarkPrice: 33,
  UpdateHyperpMark: 34,
  TradeCpiV2: 35,
  UnresolveMarket: 36,
  CreateLpVault: 37,
  LpVaultDeposit: 38,
  LpVaultWithdraw: 39,
  LpVaultCrankFees: 40,
  /** PERC-306: Fund per-market isolated insurance balance */
  FundMarketInsurance: 41,
  /** PERC-306: Set insurance isolation BPS for a market */
  SetInsuranceIsolation: 42,
  // Tag 43 is ChallengeSettlement on-chain (PERC-314).
  // PERC-305 (ExecuteAdl) is NOT implemented on-chain — do NOT assign tag 43 here.
  // When PERC-305 is implemented, assign a new unused tag (≥47).
  /** PERC-314: Challenge settlement price during dispute window */
  ChallengeSettlement: 43,
  /** PERC-314: Resolve dispute (admin adjudication) */
  ResolveDispute: 44,
  /** PERC-315: Deposit LP vault tokens as perp collateral */
  DepositLpCollateral: 45,
  /** PERC-315: Withdraw LP collateral (position must be closed) */
  WithdrawLpCollateral: 46,
  /** PERC-309: Queue a large LP withdrawal (user; creates withdraw_queue PDA). */
  QueueWithdrawal: 47,
  /** PERC-309: Claim one epoch tranche from a queued LP withdrawal (user). */
  ClaimQueuedWithdrawal: 48,
  /** PERC-309: Cancel a queued withdrawal, refund remaining LP tokens (user). */
  CancelQueuedWithdrawal: 49,
  /** PERC-305: Auto-deleverage — surgically close profitable positions when PnL cap is exceeded (permissionless). */
  ExecuteAdl: 50,
  /** Close a stale slab of an invalid/old layout and recover rent SOL (admin only). */
  CloseStaleSlabs: 51,
  /** Reclaim rent from an uninitialised slab whose market creation failed mid-flow. Slab must sign. */
  ReclaimSlabRent: 52,
  /** Permissionless on-chain audit crank: verifies conservation invariants and pauses market on violation. */
  AuditCrank: 53,
  /** Cross-Market Portfolio Margining: SetOffsetPair */
  SetOffsetPair: 54,
  /** Cross-Market Portfolio Margining: AttestCrossMargin */
  AttestCrossMargin: 55,
  /** PERC-622: Advance oracle phase (permissionless crank) */
  AdvanceOraclePhase: 56,
  // 57: removed (keeper fund)
  /** PERC-629: Slash a market creator's deposit (permissionless) */
  SlashCreationDeposit: 58,
  /** PERC-628: Initialize the global shared vault (admin) */
  InitSharedVault: 59,
  /** PERC-628: Allocate virtual liquidity to a market (admin) */
  AllocateMarket: 60,
  /** PERC-628: Queue a withdrawal for the current epoch */
  QueueWithdrawalSV: 61,
  /** PERC-628: Claim a queued withdrawal after epoch elapses */
  ClaimEpochWithdrawal: 62,
  /** PERC-628: Advance the shared vault epoch (permissionless crank) */
  AdvanceEpoch: 63,
  /** PERC-608: Mint a Position NFT for a user's open position. */
  MintPositionNft: 64,
  /** PERC-608: Transfer position ownership via the NFT (keeper-gated). */
  TransferPositionOwnership: 65,
  /** PERC-608: Burn the Position NFT when a position is closed. */
  BurnPositionNft: 66,
  /** PERC-608: Keeper sets pending_settlement flag before a funding transfer. */
  SetPendingSettlement: 67,
  /** PERC-608: Keeper clears pending_settlement flag after KeeperCrank. */
  ClearPendingSettlement: 68,
  /** PERC-608: Internal CPI call from percolator-nft TransferHook to update on-chain owner. */
  TransferOwnershipCpi: 69,
  /** PERC-8111: Set per-wallet position cap (admin only, cap_e6=0 disables). */
  SetWalletCap: 70,
  /** PERC-8110: Set OI imbalance hard-block threshold (admin only). */
  SetOiImbalanceHardBlock: 71,
  /** PERC-8270: Rescue orphan vault — recover tokens from a closed market's vault (admin). */
  RescueOrphanVault: 72,
  /** PERC-8270: Close orphan slab — reclaim rent from a slab whose market closed unexpectedly (admin). */
  CloseOrphanSlab: 73,
  /** PERC-SetDexPool: Pin admin-approved DEX pool address for a HYPERP market (admin). */
  SetDexPool: 74,
  /** CPI to the matcher program to initialize a matcher context account for an LP slot. Admin-only. */
  InitMatcherCtx: 75,
  /** PauseMarket (tag 76): admin emergency pause. Blocks Trade/Deposit/Withdraw/InitUser. */
  PauseMarket: 76,
  /** UnpauseMarket (tag 77): admin unpause. Re-enables all operations. */
  UnpauseMarket: 77,
  // 78: removed (keeper fund)
} as const;
Object.freeze(IX_TAG);

/**
 * InitMarket instruction data (256 bytes total)
 * Layout: tag(1) + admin(32) + mint(32) + indexFeedId(32) +
 *         maxStaleSecs(8) + confFilter(2) + invert(1) + unitScale(4) +
 *         RiskParams(144)
 *
 * Note: indexFeedId is the Pyth Pull feed ID (32 bytes hex), NOT an oracle pubkey.
 * The program validates PriceUpdateV2 accounts against this feed ID at runtime.
 */
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
  maxInsuranceFloor?: bigint | string;         // u128 — max insurance floor
  minOraclePriceCap?: bigint | string;         // u64 — min oracle price cap in e2bps
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
  minInitialDeposit: bigint | string;         // u128 — min deposit to open account
  minNonzeroMmReq: bigint | string;           // u128 — must be > 0, < minNonzeroImReq
  minNonzeroImReq: bigint | string;           // u128 — must be > minNonzeroMmReq, <= minInitialDeposit
}

/**
 * Encode a Pyth feed ID (hex string) to 32-byte Uint8Array.
 */
const HEX_RE = /^[0-9a-fA-F]{64}$/;

function encodeFeedId(feedId: string): Uint8Array {
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

// tag(1) + admin(32) + mint(32) + feedId(32) + staleness(8) + conf(2) + invert(1) + scale(4) +
// markPrice(8) + maxMaintFee(16) + maxInsFloor(16) + minOracleCap(8) +
// RiskParams: hMin(8) + mmBps(8) + imBps(8) + tradeFee(8) + maxAcct(8) + newAcctFee(16) +
//   maintFee(16) + maxStale(8) + liqFee(8) + liqCap(16) +
//   minLiqAbs(16) + minDeposit(16) + minMm(16) + minIm(16) + insFloor(16) + hMax(8)
// = 1+32+32+32+8+2+1+4+8+16+16+8 + 8+8+8+8+8+16+16+16+8+8+16+8+16+16+16+16+8 = 360
const INIT_MARKET_DATA_LEN = 352; // v12.15: hMax inline (was appended), maintenanceFeePerSlot→hMax+pad

export function encodeInitMarket(args: InitMarketArgs): Uint8Array {
  // Resolve hMin/hMax with fallback to warmupPeriodSlots for backwards compat
  const hMin = args.hMin ?? args.warmupPeriodSlots ?? 0n;
  const hMax = args.hMax ?? args.warmupPeriodSlots ?? 0n;

  const data = concatBytes(
    encU8(IX_TAG.InitMarket),
    encPubkey(args.admin),
    encPubkey(args.collateralMint),
    encodeFeedId(args.indexFeedId),
    encU64(args.maxStalenessSecs),
    encU16(args.confFilterBps),
    encU8(args.invert),
    encU32(args.unitScale),
    encU64(args.initialMarkPriceE6),
    // 3 fields between header and RiskParams (immutable after init)
    encU128(args.maxMaintenanceFeePerSlot ?? 0n),
    encU128(args.maxInsuranceFloor ?? 0n),
    encU64(args.minOraclePriceCap ?? 0n),
    // RiskParams wire format — must match read_risk_params() in percolator.rs
    // In v12.15: warmup_period_slots replaced by hMin/hMax. hMin is written first (same slot),
    // hMax appended at end. liquidationBufferBps is read but discarded (kept for wire compat).
    encU64(hMin),
    encU64(args.maintenanceMarginBps),
    encU64(args.initialMarginBps),
    encU64(args.tradingFeeBps),
    encU64(args.maxAccounts),
    encU128(args.newAccountFee),
    encU128(args.insuranceFloor ?? 0n),          // wire slot: old riskReductionThreshold → now insurance_floor
    encU64(hMax),                                // v12.15: h_max (u64) — was low 8 bytes of maintenanceFeePerSlot (u128)
    encU64(0n),                                  // padding (u64) — remaining 8 bytes of old u128 slot
    encU64(args.maxCrankStalenessSlots),
    encU64(args.liquidationFeeBps),
    encU128(args.liquidationFeeCap),
    encU64(args.liquidationBufferBps ?? 0n),     // wire slot: read as resolve_price_deviation_bps by program
    encU128(args.minLiquidationAbs),
    encU128(args.minInitialDeposit),
    encU128(args.minNonzeroMmReq),
    encU128(args.minNonzeroImReq),
  );
  if (data.length !== INIT_MARKET_DATA_LEN) {
    throw new Error(
      `encodeInitMarket: expected ${INIT_MARKET_DATA_LEN} bytes, got ${data.length}`,
    );
  }
  return data;
}

/**
 * InitUser instruction data (9 bytes)
 */
export interface InitUserArgs {
  feePayment: bigint | string;
}

export function encodeInitUser(args: InitUserArgs): Uint8Array {
  return concatBytes(encU8(IX_TAG.InitUser), encU64(args.feePayment));
}

/**
 * InitLP instruction data (73 bytes)
 */
export interface InitLPArgs {
  matcherProgram: PublicKey | string;
  matcherContext: PublicKey | string;
  feePayment: bigint | string;
}

export function encodeInitLP(args: InitLPArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.InitLP),
    encPubkey(args.matcherProgram),
    encPubkey(args.matcherContext),
    encU64(args.feePayment),
  );
}

/**
 * DepositCollateral instruction data (11 bytes)
 */
export interface DepositCollateralArgs {
  userIdx: number;
  amount: bigint | string;
}

export function encodeDepositCollateral(args: DepositCollateralArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.DepositCollateral),
    encU16(args.userIdx),
    encU64(args.amount),
  );
}

/**
 * WithdrawCollateral instruction data (11 bytes)
 */
export interface WithdrawCollateralArgs {
  userIdx: number;
  amount: bigint | string;
}

export function encodeWithdrawCollateral(args: WithdrawCollateralArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.WithdrawCollateral),
    encU16(args.userIdx),
    encU64(args.amount),
  );
}

/**
 * KeeperCrank instruction data (4 bytes)
 * Funding rate is computed on-chain from LP inventory.
 */
export interface KeeperCrankArgs {
  callerIdx: number;
  allowPanic: boolean;
}

export function encodeKeeperCrank(args: KeeperCrankArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.KeeperCrank),
    encU16(args.callerIdx),
    encU8(args.allowPanic ? 1 : 0),
  );
}

/**
 * TradeNoCpi instruction data (21 bytes)
 */
export interface TradeNoCpiArgs {
  lpIdx: number;
  userIdx: number;
  size: bigint | string;
}

export function encodeTradeNoCpi(args: TradeNoCpiArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.TradeNoCpi),
    encU16(args.lpIdx),
    encU16(args.userIdx),
    encI128(args.size),
  );
}

/**
 * LiquidateAtOracle instruction data (3 bytes)
 */
export interface LiquidateAtOracleArgs {
  targetIdx: number;
}

export function encodeLiquidateAtOracle(args: LiquidateAtOracleArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.LiquidateAtOracle),
    encU16(args.targetIdx),
  );
}

/**
 * CloseAccount instruction data (3 bytes)
 */
export interface CloseAccountArgs {
  userIdx: number;
}

export function encodeCloseAccount(args: CloseAccountArgs): Uint8Array {
  return concatBytes(encU8(IX_TAG.CloseAccount), encU16(args.userIdx));
}

/**
 * TopUpInsurance instruction data (9 bytes)
 */
export interface TopUpInsuranceArgs {
  amount: bigint | string;
}

export function encodeTopUpInsurance(args: TopUpInsuranceArgs): Uint8Array {
  return concatBytes(encU8(IX_TAG.TopUpInsurance), encU64(args.amount));
}

/**
 * TradeCpi instruction data (21 bytes)
 */
export interface TradeCpiArgs {
  lpIdx: number;
  userIdx: number;
  size: bigint | string;
}

export function encodeTradeCpi(args: TradeCpiArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.TradeCpi),
    encU16(args.lpIdx),
    encU16(args.userIdx),
    encI128(args.size),
  );
}

/**
 * TradeCpiV2 instruction data (22 bytes) — PERC-154 optimized trade CPI.
 *
 * Same as TradeCpi but includes a caller-provided PDA bump byte.
 * Uses create_program_address instead of find_program_address,
 * saving ~1500 CU per trade. The bump should be obtained once via
 * deriveLpPda() and cached for the lifetime of the market.
 */
export interface TradeCpiV2Args {
  lpIdx: number;
  userIdx: number;
  size: bigint | string;
  bump: number;
}

export function encodeTradeCpiV2(args: TradeCpiV2Args): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.TradeCpiV2),
    encU16(args.lpIdx),
    encU16(args.userIdx),
    encI128(args.size),
    encU8(args.bump),
  );
}

/**
 * SetRiskThreshold instruction data (17 bytes)
 */
export interface SetRiskThresholdArgs {
  newThreshold: bigint | string;
}

export function encodeSetRiskThreshold(args: SetRiskThresholdArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.SetRiskThreshold),
    encU128(args.newThreshold),
  );
}

/**
 * UpdateAdmin instruction data (33 bytes)
 */
export interface UpdateAdminArgs {
  newAdmin: PublicKey | string;
}

export function encodeUpdateAdmin(args: UpdateAdminArgs): Uint8Array {
  return concatBytes(encU8(IX_TAG.UpdateAdmin), encPubkey(args.newAdmin));
}

/**
 * CloseSlab instruction data (1 byte)
 */
export function encodeCloseSlab(): Uint8Array {
  return encU8(IX_TAG.CloseSlab);
}

/**
 * UpdateConfig instruction data
 * Updates funding and threshold parameters at runtime (admin only)
 */
export interface UpdateConfigArgs {
  // Funding parameters
  fundingHorizonSlots: bigint | string;
  fundingKBps: bigint | string;
  fundingInvScaleNotionalE6: bigint | string;
  fundingMaxPremiumBps: bigint | string;
  fundingMaxBpsPerSlot: bigint | string;
  // Threshold parameters
  threshFloor: bigint | string;
  threshRiskBps: bigint | string;
  threshUpdateIntervalSlots: bigint | string;
  threshStepBps: bigint | string;
  threshAlphaBps: bigint | string;
  threshMin: bigint | string;
  threshMax: bigint | string;
  threshMinStep: bigint | string;
}

export function encodeUpdateConfig(args: UpdateConfigArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.UpdateConfig),
    encU64(args.fundingHorizonSlots),
    encU64(args.fundingKBps),
    encU128(args.fundingInvScaleNotionalE6),
    encI64(args.fundingMaxPremiumBps),  // Rust: i64 (can be negative)
    encI64(args.fundingMaxBpsPerSlot),  // Rust: i64 (can be negative)
    encU128(args.threshFloor),
    encU64(args.threshRiskBps),
    encU64(args.threshUpdateIntervalSlots),
    encU64(args.threshStepBps),
    encU64(args.threshAlphaBps),
    encU128(args.threshMin),
    encU128(args.threshMax),
    encU128(args.threshMinStep),
  );
}

/**
 * SetMaintenanceFee instruction data (17 bytes)
 */
export interface SetMaintenanceFeeArgs {
  newFee: bigint | string;
}

export function encodeSetMaintenanceFee(args: SetMaintenanceFeeArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.SetMaintenanceFee),
    encU128(args.newFee),
  );
}

/**
 * SetOracleAuthority instruction data (33 bytes)
 * Sets the oracle price authority. Pass zero pubkey to disable and require Pyth/Chainlink.
 */
export interface SetOracleAuthorityArgs {
  newAuthority: PublicKey | string;
}

export function encodeSetOracleAuthority(args: SetOracleAuthorityArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.SetOracleAuthority),
    encPubkey(args.newAuthority),
  );
}

/**
 * PushOraclePrice instruction data (17 bytes)
 * Push a new oracle price (oracle authority only).
 * The price should be in e6 format and already include any inversion/scaling.
 */
export interface PushOraclePriceArgs {
  priceE6: bigint | string;
  timestamp: bigint | string;
}

/**
 * Encode PushOraclePrice instruction data with validation.
 *
 * Validates oracle price constraints:
 * - Price cannot be zero (division by zero in on-chain engine)
 * - Price cannot exceed MAX_ORACLE_PRICE (prevents overflow in price math)
 *
 * @param args - PushOraclePrice arguments
 * @returns Encoded instruction data (17 bytes)
 * @throws Error if price is 0 or exceeds MAX_ORACLE_PRICE
 */
export function encodePushOraclePrice(args: PushOraclePriceArgs): Uint8Array {
  const price = typeof args.priceE6 === "string" ? BigInt(args.priceE6) : args.priceE6;

  if (price === 0n) {
    throw new Error("encodePushOraclePrice: price cannot be zero (division by zero in engine)");
  }

  if (price > MAX_ORACLE_PRICE) {
    throw new Error(`encodePushOraclePrice: price exceeds maximum (${MAX_ORACLE_PRICE}), got ${price}`);
  }

  return concatBytes(
    encU8(IX_TAG.PushOraclePrice),
    encU64(price),
    encI64(args.timestamp),
  );
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

export function encodeSetOraclePriceCap(args: SetOraclePriceCapArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.SetOraclePriceCap),
    encU64(args.maxChangeE2bps),
  );
}

/**
 * ResolveMarket instruction data (1 byte)
 * Resolves a binary/premarket - sets RESOLVED flag, positions force-closed via crank.
 * Requires admin oracle price (authority_price_e6) to be set first.
 */
export function encodeResolveMarket(): Uint8Array {
  return encU8(IX_TAG.ResolveMarket);
}

/**
 * WithdrawInsurance instruction data (1 byte)
 * Withdraw insurance fund to admin (requires RESOLVED and all positions closed).
 */
export function encodeWithdrawInsurance(): Uint8Array {
  return encU8(IX_TAG.WithdrawInsurance);
}

/**
 * AdminForceClose instruction data (3 bytes)
 * Force-close any position at oracle price (admin only, skips margin checks).
 */
export interface AdminForceCloseArgs {
  targetIdx: number;
}

export function encodeAdminForceClose(args: AdminForceCloseArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.AdminForceClose),
    encU16(args.targetIdx),
  );
}

/**
 * UpdateRiskParams instruction data (17 or 25 bytes)
 * Update initial and maintenance margin BPS (admin only).
 *
 * R2-S13: The Rust program uses `data.len() >= 25` to detect the optional
 * tradingFeeBps field, so variable-length encoding is safe. When tradingFeeBps
 * is omitted, the data is 17 bytes (tag + 2×u64). When included, 25 bytes.
 */
export interface UpdateRiskParamsArgs {
  initialMarginBps: bigint | string;
  maintenanceMarginBps: bigint | string;
  tradingFeeBps?: bigint | string;
}

export function encodeUpdateRiskParams(args: UpdateRiskParamsArgs): Uint8Array {
  const parts = [
    encU8(IX_TAG.UpdateRiskParams),
    encU64(args.initialMarginBps),
    encU64(args.maintenanceMarginBps),
  ];
  if (args.tradingFeeBps !== undefined) {
    parts.push(encU64(args.tradingFeeBps));
  }
  return concatBytes(...parts);
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
 * RenounceAdmin instruction data (9 bytes)
 * Irreversibly set admin to all zeros. After this, all admin-only instructions fail.
 *
 * Requires the confirmation code 0x52454E4F554E4345 ("RENOUNCE" as u64 LE)
 * to prevent accidental invocation.
 */
export function encodeRenounceAdmin(): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.RenounceAdmin),
    encU64(RENOUNCE_ADMIN_CONFIRMATION),
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

export function encodeLpVaultWithdraw(args: LpVaultWithdrawArgs): Uint8Array {
  return concatBytes(encU8(IX_TAG.LpVaultWithdraw), encU64(args.lpAmount));
}

/**
 * PauseMarket instruction data (1 byte)
 * Pauses the market — disables trading, deposits, and withdrawals.
 */
export function encodePauseMarket(): Uint8Array {
  return encU8(IX_TAG.PauseMarket);
}

/**
 * UnpauseMarket instruction data (1 byte)
 * Unpauses the market — re-enables trading, deposits, and withdrawals.
 */
export function encodeUnpauseMarket(): Uint8Array {
  return encU8(IX_TAG.UnpauseMarket);
}

// ============================================================================
// PERC-117: Pyth Oracle CPI Instructions
// ============================================================================

/**
 * SetPythOracle (Tag 32) — switch a market to Pyth-pinned mode.
 *
 * After this instruction:
 * - oracle_authority is cleared → PushOraclePrice is disabled
 * - index_feed_id is set to feed_id → validated on every price read
 * - max_staleness_secs and conf_filter_bps are updated
 * - All price reads go directly to read_pyth_price_e6() with on-chain
 *   staleness + confidence + feed-ID validation (no silent fallback)
 *
 * Instruction data: tag(1) + feed_id(32) + max_staleness_secs(8) + conf_filter_bps(2) = 43 bytes
 *
 * Accounts:
 *   0. [signer, writable] Admin
 *   1. [writable]         Slab
 */
export interface SetPythOracleArgs {
  /** 32-byte Pyth feed ID. All zeros is invalid (reserved for Hyperp mode). */
  feedId: Uint8Array;
  /** Maximum age of Pyth price in seconds before OracleStale is returned. Must be > 0. */
  maxStalenessSecs: bigint;
  /** Max confidence/price ratio in bps (0 = no confidence check). */
  confFilterBps: number;
}

export function encodeSetPythOracle(args: SetPythOracleArgs): Uint8Array {
  if (args.feedId.length !== 32) throw new Error('feedId must be 32 bytes');
  if (args.maxStalenessSecs <= 0n) throw new Error('maxStalenessSecs must be > 0');

  const buf = new Uint8Array(43);
  const dv = new DataView(buf.buffer);

  // Tag 32 (SetPythOracle)
  buf[0] = 32;
  buf.set(args.feedId, 1);
  dv.setBigUint64(33, args.maxStalenessSecs, /* little-endian */ true);
  dv.setUint16(41, args.confFilterBps, true);

  return buf;
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
 * UpdateMarkPrice (Tag 33) — permissionless EMA mark price crank.
 *
 * Reads the current oracle price on-chain, applies 8-hour EMA smoothing
 * with circuit breaker, and writes result to authority_price_e6.
 *
 * Instruction data: 1 byte (tag only — all params read from on-chain state)
 *
 * Accounts:
 *   0. [writable] Slab
 *   1. []         Oracle account (Pyth PriceUpdateV2 / Chainlink / DEX AMM)
 *   2. []         Clock sysvar (SysvarC1ock11111111111111111111111111111111)
 *   3..N []       Remaining accounts (PumpSwap vaults, etc. if needed)
 */
export function encodeUpdateMarkPrice(): Uint8Array {
  return new Uint8Array([33]);
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
  return new Uint8Array([34]);
}

// ============================================================================
// PERC-306: Per-Market Insurance Isolation
// ============================================================================

/**
 * Fund per-market isolated insurance balance.
 * Accounts: [admin(signer,writable), slab(writable), admin_ata(writable), vault(writable), token_program]
 */
export function encodeFundMarketInsurance(args: { amount: bigint }): Uint8Array {
  return concatBytes(encU8(IX_TAG.FundMarketInsurance), encU64(args.amount));
}

/**
 * Set insurance isolation BPS for a market.
 * Accounts: [admin(signer), slab(writable)]
 */
export function encodeSetInsuranceIsolation(args: { bps: number }): Uint8Array {
  return concatBytes(encU8(IX_TAG.SetInsuranceIsolation), encU16(args.bps));
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
export function encodeQueueWithdrawal(args: { lpAmount: bigint | string }): Uint8Array {
  return concatBytes(encU8(IX_TAG.QueueWithdrawal), encU64(args.lpAmount));
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
export function encodeClaimQueuedWithdrawal(): Uint8Array {
  return encU8(IX_TAG.ClaimQueuedWithdrawal);
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
export function encodeCancelQueuedWithdrawal(): Uint8Array {
  return encU8(IX_TAG.CancelQueuedWithdrawal);
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

export function encodeExecuteAdl(args: ExecuteAdlArgs): Uint8Array {
  return concatBytes(encU8(IX_TAG.ExecuteAdl), encU16(args.targetIdx));
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
export function encodeCloseStaleSlabs(): Uint8Array {
  return encU8(IX_TAG.CloseStaleSlabs);
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
export function encodeReclaimSlabRent(): Uint8Array {
  return encU8(IX_TAG.ReclaimSlabRent);
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
export function encodeAuditCrank(): Uint8Array {
  return encU8(IX_TAG.AuditCrank);
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

/** Magic bytes identifying a vAMM matcher context: "PERCMATC" as u64 LE */
export const VAMM_MAGIC = 0x5045_5243_4d41_5443n;

/** Offset into matcher context where vAMM params start */
export const CTX_VAMM_OFFSET = 64;

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
export function encodeAdvanceOraclePhase(): Uint8Array {
  return encU8(IX_TAG.AdvanceOraclePhase);
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
  return encU8(IX_TAG.SlashCreationDeposit);
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

export function encodeInitSharedVault(args: InitSharedVaultArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.InitSharedVault),
    encU64(args.epochDurationSlots),
    encU16(args.maxMarketExposureBps),
  );
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

export function encodeAllocateMarket(args: AllocateMarketArgs): Uint8Array {
  return concatBytes(encU8(IX_TAG.AllocateMarket), encU128(args.amount));
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

export function encodeQueueWithdrawalSV(args: QueueWithdrawalSVArgs): Uint8Array {
  return concatBytes(encU8(IX_TAG.QueueWithdrawalSV), encU64(args.lpAmount));
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
export function encodeClaimEpochWithdrawal(): Uint8Array {
  return encU8(IX_TAG.ClaimEpochWithdrawal);
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
export function encodeAdvanceEpoch(): Uint8Array {
  return encU8(IX_TAG.AdvanceEpoch);
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
export function encodeSetOiImbalanceHardBlock(args: { thresholdBps: number }): Uint8Array {
  if (args.thresholdBps < 0 || args.thresholdBps > 10_000) {
    throw new Error(`encodeSetOiImbalanceHardBlock: thresholdBps must be 0–10_000, got ${args.thresholdBps}`);
  }
  return concatBytes(encU8(IX_TAG.SetOiImbalanceHardBlock), encU16(args.thresholdBps));
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

export function encodeMintPositionNft(args: MintPositionNftArgs): Uint8Array {
  return concatBytes(encU8(IX_TAG.MintPositionNft), encU16(args.userIdx));
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

export function encodeTransferPositionOwnership(args: TransferPositionOwnershipArgs): Uint8Array {
  return concatBytes(encU8(IX_TAG.TransferPositionOwnership), encU16(args.userIdx));
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

export function encodeBurnPositionNft(args: BurnPositionNftArgs): Uint8Array {
  return concatBytes(encU8(IX_TAG.BurnPositionNft), encU16(args.userIdx));
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

export function encodeSetPendingSettlement(args: SetPendingSettlementArgs): Uint8Array {
  return concatBytes(encU8(IX_TAG.SetPendingSettlement), encU16(args.userIdx));
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

export function encodeClearPendingSettlement(args: ClearPendingSettlementArgs): Uint8Array {
  return concatBytes(encU8(IX_TAG.ClearPendingSettlement), encU16(args.userIdx));
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

export function encodeTransferOwnershipCpi(args: TransferOwnershipCpiArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.TransferOwnershipCpi),
    encU16(args.userIdx),
    encPubkey(args.newOwner),
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

export function encodeSetWalletCap(args: SetWalletCapArgs): Uint8Array {
  return concatBytes(encU8(IX_TAG.SetWalletCap), encU64(args.capE6));
}

// ============================================================================
// InitMatcherCtx — CPI to matcher program to initialize a matcher context (tag 75)
// ============================================================================

/**
 * InitMatcherCtx (Tag 75) — admin initializes the matcher context account for an LP slot.
 *
 * The matcher program (DHP6DtwXP1yJsz8YzfoeigRFPB979gzmumkmCxDLSkUX) requires its context
 * account to be initialized before TradeCpi can work. Only the percolator program can sign
 * as the LP PDA via invoke_signed, so this instruction acts as the trusted initializer.
 *
 * Instruction data layout: tag(1) + lp_idx(2) + kind(1) + trading_fee_bps(4) +
 *   base_spread_bps(4) + max_total_bps(4) + impact_k_bps(4) +
 *   liquidity_notional_e6(16) + max_fill_abs(16) + max_inventory_abs(16) +
 *   fee_to_insurance_bps(2) + skew_spread_mult_bps(2) = 72 bytes
 *
 * Accounts:
 *   0. [signer]   admin
 *   1. []         slab (program-owned; used to verify admin + LP slot)
 *   2. [writable] matcherCtx (must match LP's stored matcher_context)
 *   3. []         matcherProg (executable; must match LP's stored matcher_program)
 *   4. []         lpPda (PDA ["lp", slab, lp_idx]; required by CPI as signer)
 */
export interface InitMatcherCtxArgs {
  /** LP account index in the engine (0-based). */
  lpIdx: number;
  /** Matcher kind: 0=Passive, 1=vAMM. */
  kind: number;
  /** Base trading fee in bps (e.g. 30 = 0.30%). */
  tradingFeeBps: number;
  /** Base spread in bps. */
  baseSpreadBps: number;
  /** Max total spread in bps. */
  maxTotalBps: number;
  /** vAMM impact constant in bps (0 for passive matchers). */
  impactKBps: number;
  /** Liquidity notional in e6 units (0 for passive matchers). */
  liquidityNotionalE6: bigint | string;
  /** Max single fill size in absolute units (u128::MAX = no limit). */
  maxFillAbs: bigint | string;
  /** Max inventory size in absolute units (u128::MAX = no limit). */
  maxInventoryAbs: bigint | string;
  /** Fraction of fees routed to insurance fund in bps. */
  feeToInsuranceBps: number;
  /** Skew spread multiplier in bps (0 = disabled). */
  skewSpreadMultBps: number;
}

export function encodeInitMatcherCtx(args: InitMatcherCtxArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.InitMatcherCtx),
    encU16(args.lpIdx),
    encU8(args.kind),
    encU32(args.tradingFeeBps),
    encU32(args.baseSpreadBps),
    encU32(args.maxTotalBps),
    encU32(args.impactKBps),
    encU128(args.liquidityNotionalE6),
    encU128(args.maxFillAbs),
    encU128(args.maxInventoryAbs),
    encU16(args.feeToInsuranceBps),
    encU16(args.skewSpreadMultBps),
  );
}

// ============================================================================
// Missing encoders — corrected tag mappings (tags 22-74)
// ============================================================================

/** SetInsuranceWithdrawPolicy (tag 22): authority + min_withdraw_base + max_withdraw_bps + cooldown_slots */
export interface SetInsuranceWithdrawPolicyArgs {
  authority: PublicKey | string;
  minWithdrawBase: bigint | string;
  maxWithdrawBps: number;
  cooldownSlots: bigint | string;
}
export function encodeSetInsuranceWithdrawPolicy(args: SetInsuranceWithdrawPolicyArgs): Uint8Array {
  return concatBytes(encU8(IX_TAG.SetInsuranceWithdrawPolicy), encPubkey(args.authority), encU64(args.minWithdrawBase), encU16(args.maxWithdrawBps), encU64(args.cooldownSlots));
}

/** WithdrawInsuranceLimited (tag 23): amount */
export function encodeWithdrawInsuranceLimited(args: { amount: bigint | string }): Uint8Array {
  return concatBytes(encU8(IX_TAG.WithdrawInsuranceLimited), encU64(args.amount));
}

/** ResolvePermissionless (tag 29): no args */
export function encodeResolvePermissionless(): Uint8Array {
  return concatBytes(encU8(IX_TAG.ResolvePermissionless));
}

/** ForceCloseResolved (tag 30): user_idx */
export function encodeForceCloseResolved(args: { userIdx: number }): Uint8Array {
  return concatBytes(encU8(IX_TAG.ForceCloseResolved), encU16(args.userIdx));
}

/** CreateLpVault (tag 37): fee_share_bps + util_curve_enabled */
export function encodeCreateLpVault(args: { feeShareBps: bigint | string; utilCurveEnabled?: boolean }): Uint8Array {
  const parts = [encU8(IX_TAG.CreateLpVault), encU64(args.feeShareBps)];
  if (args.utilCurveEnabled !== undefined) {
    parts.push(encU8(args.utilCurveEnabled ? 1 : 0));
  }
  return concatBytes(...parts);
}

/** LpVaultDeposit (tag 38): amount */
export function encodeLpVaultDeposit(args: { amount: bigint | string }): Uint8Array {
  return concatBytes(encU8(IX_TAG.LpVaultDeposit), encU64(args.amount));
}

/** LpVaultCrankFees (tag 40): no args */
export function encodeLpVaultCrankFees(): Uint8Array {
  return concatBytes(encU8(IX_TAG.LpVaultCrankFees));
}

/** ChallengeSettlement (tag 43): proposed_price_e6 */
export function encodeChallengeSettlement(args: { proposedPriceE6: bigint | string }): Uint8Array {
  return concatBytes(encU8(IX_TAG.ChallengeSettlement), encU64(args.proposedPriceE6));
}

/** ResolveDispute (tag 44): accept (0 = reject, 1 = accept) */
export function encodeResolveDispute(args: { accept: number }): Uint8Array {
  return concatBytes(encU8(IX_TAG.ResolveDispute), encU8(args.accept));
}

/** DepositLpCollateral (tag 45): user_idx + lp_amount */
export function encodeDepositLpCollateral(args: { userIdx: number; lpAmount: bigint | string }): Uint8Array {
  return concatBytes(encU8(IX_TAG.DepositLpCollateral), encU16(args.userIdx), encU64(args.lpAmount));
}

/** WithdrawLpCollateral (tag 46): user_idx + lp_amount */
export function encodeWithdrawLpCollateral(args: { userIdx: number; lpAmount: bigint | string }): Uint8Array {
  return concatBytes(encU8(IX_TAG.WithdrawLpCollateral), encU16(args.userIdx), encU64(args.lpAmount));
}

/** SetOffsetPair (tag 54): offset_bps */
export function encodeSetOffsetPair(args: { offsetBps: number }): Uint8Array {
  return concatBytes(encU8(IX_TAG.SetOffsetPair), encU16(args.offsetBps));
}

/** AttestCrossMargin (tag 55): user_idx_a + user_idx_b */
export function encodeAttestCrossMargin(args: { userIdxA: number; userIdxB: number }): Uint8Array {
  return concatBytes(encU8(IX_TAG.AttestCrossMargin), encU16(args.userIdxA), encU16(args.userIdxB));
}

/** RescueOrphanVault (tag 72): no args */
export function encodeRescueOrphanVault(): Uint8Array {
  return concatBytes(encU8(IX_TAG.RescueOrphanVault));
}

/** CloseOrphanSlab (tag 73): no args */
export function encodeCloseOrphanSlab(): Uint8Array {
  return concatBytes(encU8(IX_TAG.CloseOrphanSlab));
}

/** SetDexPool (tag 74): pool pubkey */
export function encodeSetDexPool(args: { pool: PublicKey | string }): Uint8Array {
  return concatBytes(encU8(IX_TAG.SetDexPool), encPubkey(args.pool));
}

// Insurance LP — aliases for LP Vault instructions (tags 37/38/39).
// The insurance LP feature uses the same on-chain instructions as the LP vault
// but with insurance-specific account layouts (ACCOUNTS_*_INSURANCE_LP).

/** CreateInsuranceMint: creates the insurance LP mint PDA (tag 37, same as CreateLpVault) */
export function encodeCreateInsuranceMint(): Uint8Array {
  // CreateLpVault with default params (fee_share_bps=0, no util curve)
  return encodeCreateLpVault({ feeShareBps: 0n });
}

/** DepositInsuranceLP: deposit collateral, receive LP tokens (tag 38, same as LpVaultDeposit) */
export function encodeDepositInsuranceLP(args: { amount: bigint | string }): Uint8Array {
  return encodeLpVaultDeposit({ amount: args.amount });
}

/** WithdrawInsuranceLP: burn LP tokens, withdraw collateral (tag 39, same as LpVaultWithdraw) */
export function encodeWithdrawInsuranceLP(args: { lpAmount: bigint | string }): Uint8Array {
  return encodeLpVaultWithdraw({ lpAmount: args.lpAmount });
}
