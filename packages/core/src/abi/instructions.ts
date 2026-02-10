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
  UpdateRiskParams: 22,
  RenounceAdmin: 23,
  CreateInsuranceMint: 24,
  DepositInsuranceLP: 25,
  WithdrawInsuranceLP: 26,
  PauseMarket: 27,
  UnpauseMarket: 28,
} as const;

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
  maxStalenessSecs: bigint | string;  // Max staleness in SECONDS (Pyth Pull uses unix timestamps)
  confFilterBps: number;
  invert: number;              // 0 = no inversion, 1 = invert oracle price (USD/SOL -> SOL/USD)
  unitScale: number;           // Lamports per unit (0 = no scaling, e.g. 1000 = 1 SOL = 1,000,000 units)
  initialMarkPriceE6: bigint | string;  // Initial mark price (required non-zero for Hyperp mode)
  warmupPeriodSlots: bigint | string;
  maintenanceMarginBps: bigint | string;
  initialMarginBps: bigint | string;
  tradingFeeBps: bigint | string;
  maxAccounts: bigint | string;
  newAccountFee: bigint | string;
  riskReductionThreshold: bigint | string;
  maintenanceFeePerSlot: bigint | string;
  maxCrankStalenessSlots: bigint | string;
  liquidationFeeBps: bigint | string;
  liquidationFeeCap: bigint | string;
  liquidationBufferBps: bigint | string;
  minLiquidationAbs: bigint | string;
}

/**
 * Encode a Pyth feed ID (hex string) to 32-byte Uint8Array.
 */
function encodeFeedId(feedId: string): Uint8Array {
  // Remove 0x prefix if present
  const hex = feedId.startsWith("0x") ? feedId.slice(2) : feedId;
  if (hex.length !== 64) {
    throw new Error(`Invalid feed ID length: expected 64 hex chars, got ${hex.length}`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 64; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function encodeInitMarket(args: InitMarketArgs): Uint8Array {
  // Layout: tag(1) + admin(32) + mint(32) + index_feed_id(32) + max_staleness_secs(8) +
  //         conf_filter_bps(2) + invert(1) + unit_scale(4) + initial_mark_price_e6(8) + RiskParams(...)
  // Note: _reserved field is only in MarketConfig on-chain, not in instruction data
  return concatBytes(
    encU8(IX_TAG.InitMarket),
    encPubkey(args.admin),
    encPubkey(args.collateralMint),
    encodeFeedId(args.indexFeedId),   // index_feed_id (32 bytes) - all zeros for Hyperp mode
    encU64(args.maxStalenessSecs),    // max_staleness_secs (Pyth Pull uses unix timestamps)
    encU16(args.confFilterBps),
    encU8(args.invert),
    encU32(args.unitScale),
    encU64(args.initialMarkPriceE6),  // initial_mark_price_e6 (required non-zero for Hyperp)
    encU64(args.warmupPeriodSlots),
    encU64(args.maintenanceMarginBps),
    encU64(args.initialMarginBps),
    encU64(args.tradingFeeBps),
    encU64(args.maxAccounts),
    encU128(args.newAccountFee),
    encU128(args.riskReductionThreshold),
    encU128(args.maintenanceFeePerSlot),
    encU64(args.maxCrankStalenessSlots),
    encU64(args.liquidationFeeBps),
    encU128(args.liquidationFeeCap),
    encU64(args.liquidationBufferBps),
    encU128(args.minLiquidationAbs),
  );
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
    encU64(args.fundingMaxPremiumBps),
    encU64(args.fundingMaxBpsPerSlot),
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

export function encodePushOraclePrice(args: PushOraclePriceArgs): Uint8Array {
  return concatBytes(
    encU8(IX_TAG.PushOraclePrice),
    encU64(args.priceE6),
    encI64(args.timestamp),
  );
}

/**
 * SetOraclePriceCap instruction data (9 bytes)
 * Set oracle price circuit breaker cap (admin only).
 * max_change_e2bps in 0.01 bps units (1_000_000 = 100%). 0 = disabled.
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
 * UpdateRiskParams instruction data (17 bytes)
 * Update initial and maintenance margin BPS (admin only).
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
 * RenounceAdmin instruction data (1 byte)
 * Irreversibly set admin to all zeros. After this, all admin-only instructions fail.
 */
export function encodeRenounceAdmin(): Uint8Array {
  return encU8(IX_TAG.RenounceAdmin);
}

/**
 * CreateInsuranceMint instruction data (1 byte)
 * Creates the SPL mint PDA for insurance LP tokens. Admin only, once per market.
 */
export function encodeCreateInsuranceMint(): Uint8Array {
  return encU8(IX_TAG.CreateInsuranceMint);
}

/**
 * DepositInsuranceLP instruction data (9 bytes)
 * Deposit collateral into insurance fund, receive LP tokens proportional to share.
 */
export interface DepositInsuranceLPArgs {
  amount: bigint | string;
}

export function encodeDepositInsuranceLP(args: DepositInsuranceLPArgs): Uint8Array {
  return concatBytes(encU8(IX_TAG.DepositInsuranceLP), encU64(args.amount));
}

/**
 * WithdrawInsuranceLP instruction data (9 bytes)
 * Burn LP tokens and withdraw proportional share of insurance fund.
 */
export interface WithdrawInsuranceLPArgs {
  lpAmount: bigint | string;
}

export function encodeWithdrawInsuranceLP(args: WithdrawInsuranceLPArgs): Uint8Array {
  return concatBytes(encU8(IX_TAG.WithdrawInsuranceLP), encU64(args.lpAmount));
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
// MATCHER INSTRUCTIONS (sent to matcher program, not percolator)
// ============================================================================

/**
 * Matcher instruction tags
 */
export const MATCHER_IX_TAG = {
  InitPassive: 0,
  InitCurve: 1,
  InitVamm: 2,
} as const;

/**
 * InitVamm matcher instruction data (66 bytes)
 * Tag 2 — configures a vAMM LP with spread/impact pricing.
 *
 * Layout: tag(1) + mode(1) + tradingFeeBps(4) + baseSpreadBps(4) +
 *         maxTotalBps(4) + impactKBps(4) + liquidityNotionalE6(16) +
 *         maxFillAbs(16) + maxInventoryAbs(16)
 */
export interface InitVammArgs {
  mode: number;                         // 0 = passive, 1 = vAMM
  tradingFeeBps: number;                // Trading fee in bps (e.g. 5 = 0.05%)
  baseSpreadBps: number;                // Base spread in bps (e.g. 10 = 0.10%)
  maxTotalBps: number;                  // Max total (spread + impact + fee) in bps
  impactKBps: number;                   // Impact coefficient at full liquidity
  liquidityNotionalE6: bigint | string; // Notional liquidity for impact calc (e6)
  maxFillAbs: bigint | string;          // Max fill per trade (abs units)
  maxInventoryAbs: bigint | string;     // Max inventory (0 = unlimited)
}

export function encodeInitVamm(args: InitVammArgs): Uint8Array {
  return concatBytes(
    encU8(MATCHER_IX_TAG.InitVamm),
    encU8(args.mode),
    encU32(args.tradingFeeBps),
    encU32(args.baseSpreadBps),
    encU32(args.maxTotalBps),
    encU32(args.impactKBps),
    encU128(args.liquidityNotionalE6),
    encU128(args.maxFillAbs),
    encU128(args.maxInventoryAbs),
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
