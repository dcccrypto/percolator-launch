// src/abi/encode.ts
import { PublicKey } from "@solana/web3.js";
var U8_MAX = 255;
var U16_MAX = 65535;
var U32_MAX = 4294967295;
function encU8(val) {
  if (!Number.isInteger(val) || val < 0 || val > U8_MAX) {
    throw new Error(`encU8: value out of range (0..255), got ${val}`);
  }
  return new Uint8Array([val]);
}
function encU16(val) {
  if (!Number.isInteger(val) || val < 0 || val > U16_MAX) {
    throw new Error(`encU16: value out of range (0..65535), got ${val}`);
  }
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, val, true);
  return buf;
}
function encU32(val) {
  if (!Number.isInteger(val) || val < 0 || val > U32_MAX) {
    throw new Error(`encU32: value out of range (0..4294967295), got ${val}`);
  }
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, val, true);
  return buf;
}
function encU64(val) {
  const n = typeof val === "string" ? BigInt(val) : val;
  if (n < 0n) throw new Error("encU64: value must be non-negative");
  if (n > 0xffffffffffffffffn) throw new Error("encU64: value exceeds u64 max");
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, n, true);
  return buf;
}
function encI64(val) {
  const n = typeof val === "string" ? BigInt(val) : val;
  const min = -(1n << 63n);
  const max = (1n << 63n) - 1n;
  if (n < min || n > max) throw new Error("encI64: value out of range");
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigInt64(0, n, true);
  return buf;
}
function encU128(val) {
  const n = typeof val === "string" ? BigInt(val) : val;
  if (n < 0n) throw new Error("encU128: value must be non-negative");
  const max = (1n << 128n) - 1n;
  if (n > max) throw new Error("encU128: value exceeds u128 max");
  const buf = new Uint8Array(16);
  const view = new DataView(buf.buffer);
  const lo = n & 0xffffffffffffffffn;
  const hi = n >> 64n;
  view.setBigUint64(0, lo, true);
  view.setBigUint64(8, hi, true);
  return buf;
}
function encI128(val) {
  const n = typeof val === "string" ? BigInt(val) : val;
  const min = -(1n << 127n);
  const max = (1n << 127n) - 1n;
  if (n < min || n > max) throw new Error("encI128: value out of range");
  let unsigned = n;
  if (n < 0n) {
    unsigned = (1n << 128n) + n;
  }
  const buf = new Uint8Array(16);
  const view = new DataView(buf.buffer);
  const lo = unsigned & 0xffffffffffffffffn;
  const hi = unsigned >> 64n;
  view.setBigUint64(0, lo, true);
  view.setBigUint64(8, hi, true);
  return buf;
}
function encPubkey(val) {
  try {
    const pk = typeof val === "string" ? new PublicKey(val) : val;
    return pk.toBytes();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`encPubkey: invalid public key "${String(val)}" \u2014 ${msg}`);
  }
}
function encBool(val) {
  return encU8(val ? 1 : 0);
}
function concatBytes(...arrays) {
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// src/abi/instructions.ts
var MAX_ORACLE_PRICE = 1000000000000n;
var IX_TAG = {
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
  /** @deprecated Use SetInsuranceWithdrawPolicy */
  UpdateRiskParams: 22,
  WithdrawInsuranceLimited: 23,
  /** @deprecated Use WithdrawInsuranceLimited */
  RenounceAdmin: 23,
  // Tags 24–26: on-chain = QueryLpFees/ReclaimEmptyAccount/SettleAccount.
  // Old insurance LP tags removed — those moved to percolator-stake.
  QueryLpFees: 24,
  ReclaimEmptyAccount: 25,
  SettleAccount: 26,
  // Tags 27-28: on-chain = DepositFeeCredits/ConvertReleasedPnl.
  // Legacy aliases (PauseMarket/UnpauseMarket) kept — those instructions don't exist on-chain.
  DepositFeeCredits: 27,
  /** @deprecated No on-chain PauseMarket instruction */
  PauseMarket: 27,
  ConvertReleasedPnl: 28,
  /** @deprecated No on-chain UnpauseMarket instruction */
  UnpauseMarket: 28,
  // Tags 29-30: on-chain = ResolvePermissionless/ForceCloseResolved.
  ResolvePermissionless: 29,
  /** @deprecated Use ResolvePermissionless */
  AcceptAdmin: 29,
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
  /** PERC-623: Top up a market's keeper fund (permissionless) */
  TopUpKeeperFund: 57,
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
  InitMatcherCtx: 75
};
Object.freeze(IX_TAG);
var HEX_RE = /^[0-9a-fA-F]{64}$/;
function encodeFeedId(feedId) {
  const hex = feedId.startsWith("0x") ? feedId.slice(2) : feedId;
  if (!HEX_RE.test(hex)) {
    throw new Error(
      `Invalid feed ID: expected 64 hex chars, got "${hex.length === 64 ? "non-hex characters" : hex.length + " chars"}"`
    );
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 64; i += 2) {
    const byte = parseInt(hex.substring(i, i + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(
        `Failed to parse hex byte at position ${i}: "${hex.substring(i, i + 2)}"`
      );
    }
    bytes[i / 2] = byte;
  }
  return bytes;
}
var INIT_MARKET_DATA_LEN = 352;
function encodeInitMarket(args) {
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
    // Note: insurance_floor occupies the old riskReductionThreshold slot,
    // and liquidationBufferBps is read but discarded (kept for wire compat).
    encU64(args.warmupPeriodSlots),
    encU64(args.maintenanceMarginBps),
    encU64(args.initialMarginBps),
    encU64(args.tradingFeeBps),
    encU64(args.maxAccounts),
    encU128(args.newAccountFee),
    encU128(args.insuranceFloor ?? 0n),
    // wire slot: old riskReductionThreshold → now insurance_floor
    encU128(args.maintenanceFeePerSlot),
    encU64(args.maxCrankStalenessSlots),
    encU64(args.liquidationFeeBps),
    encU128(args.liquidationFeeCap),
    encU64(args.liquidationBufferBps ?? 0n),
    // wire slot: read and discarded by program
    encU128(args.minLiquidationAbs),
    encU128(args.minInitialDeposit),
    encU128(args.minNonzeroMmReq),
    encU128(args.minNonzeroImReq)
  );
  if (data.length !== INIT_MARKET_DATA_LEN) {
    throw new Error(
      `encodeInitMarket: expected ${INIT_MARKET_DATA_LEN} bytes, got ${data.length}`
    );
  }
  return data;
}
function encodeInitUser(args) {
  return concatBytes(encU8(IX_TAG.InitUser), encU64(args.feePayment));
}
function encodeInitLP(args) {
  return concatBytes(
    encU8(IX_TAG.InitLP),
    encPubkey(args.matcherProgram),
    encPubkey(args.matcherContext),
    encU64(args.feePayment)
  );
}
function encodeDepositCollateral(args) {
  return concatBytes(
    encU8(IX_TAG.DepositCollateral),
    encU16(args.userIdx),
    encU64(args.amount)
  );
}
function encodeWithdrawCollateral(args) {
  return concatBytes(
    encU8(IX_TAG.WithdrawCollateral),
    encU16(args.userIdx),
    encU64(args.amount)
  );
}
function encodeKeeperCrank(args) {
  return concatBytes(
    encU8(IX_TAG.KeeperCrank),
    encU16(args.callerIdx),
    encU8(args.allowPanic ? 1 : 0)
  );
}
function encodeTradeNoCpi(args) {
  return concatBytes(
    encU8(IX_TAG.TradeNoCpi),
    encU16(args.lpIdx),
    encU16(args.userIdx),
    encI128(args.size)
  );
}
function encodeLiquidateAtOracle(args) {
  return concatBytes(
    encU8(IX_TAG.LiquidateAtOracle),
    encU16(args.targetIdx)
  );
}
function encodeCloseAccount(args) {
  return concatBytes(encU8(IX_TAG.CloseAccount), encU16(args.userIdx));
}
function encodeTopUpInsurance(args) {
  return concatBytes(encU8(IX_TAG.TopUpInsurance), encU64(args.amount));
}
function encodeTradeCpi(args) {
  return concatBytes(
    encU8(IX_TAG.TradeCpi),
    encU16(args.lpIdx),
    encU16(args.userIdx),
    encI128(args.size)
  );
}
function encodeTradeCpiV2(args) {
  return concatBytes(
    encU8(IX_TAG.TradeCpiV2),
    encU16(args.lpIdx),
    encU16(args.userIdx),
    encI128(args.size),
    encU8(args.bump)
  );
}
function encodeSetRiskThreshold(args) {
  return concatBytes(
    encU8(IX_TAG.SetRiskThreshold),
    encU128(args.newThreshold)
  );
}
function encodeUpdateAdmin(args) {
  return concatBytes(encU8(IX_TAG.UpdateAdmin), encPubkey(args.newAdmin));
}
function encodeCloseSlab() {
  return encU8(IX_TAG.CloseSlab);
}
function encodeUpdateConfig(args) {
  return concatBytes(
    encU8(IX_TAG.UpdateConfig),
    encU64(args.fundingHorizonSlots),
    encU64(args.fundingKBps),
    encU128(args.fundingInvScaleNotionalE6),
    encI64(args.fundingMaxPremiumBps),
    // Rust: i64 (can be negative)
    encI64(args.fundingMaxBpsPerSlot),
    // Rust: i64 (can be negative)
    encU128(args.threshFloor),
    encU64(args.threshRiskBps),
    encU64(args.threshUpdateIntervalSlots),
    encU64(args.threshStepBps),
    encU64(args.threshAlphaBps),
    encU128(args.threshMin),
    encU128(args.threshMax),
    encU128(args.threshMinStep)
  );
}
function encodeSetMaintenanceFee(args) {
  return concatBytes(
    encU8(IX_TAG.SetMaintenanceFee),
    encU128(args.newFee)
  );
}
function encodeSetOracleAuthority(args) {
  return concatBytes(
    encU8(IX_TAG.SetOracleAuthority),
    encPubkey(args.newAuthority)
  );
}
function encodePushOraclePrice(args) {
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
    encI64(args.timestamp)
  );
}
function encodeSetOraclePriceCap(args) {
  return concatBytes(
    encU8(IX_TAG.SetOraclePriceCap),
    encU64(args.maxChangeE2bps)
  );
}
function encodeResolveMarket() {
  return encU8(IX_TAG.ResolveMarket);
}
function encodeWithdrawInsurance() {
  return encU8(IX_TAG.WithdrawInsurance);
}
function encodeAdminForceClose(args) {
  return concatBytes(
    encU8(IX_TAG.AdminForceClose),
    encU16(args.targetIdx)
  );
}
function encodeUpdateRiskParams(args) {
  const parts = [
    encU8(IX_TAG.UpdateRiskParams),
    encU64(args.initialMarginBps),
    encU64(args.maintenanceMarginBps)
  ];
  if (args.tradingFeeBps !== void 0) {
    parts.push(encU64(args.tradingFeeBps));
  }
  return concatBytes(...parts);
}
var RENOUNCE_ADMIN_CONFIRMATION = 0x52454E4F554E4345n;
var UNRESOLVE_CONFIRMATION = 0xDEADBEEFCAFE1234n;
function encodeRenounceAdmin() {
  return concatBytes(
    encU8(IX_TAG.RenounceAdmin),
    encU64(RENOUNCE_ADMIN_CONFIRMATION)
  );
}
function encodeLpVaultWithdraw(args) {
  return concatBytes(encU8(IX_TAG.LpVaultWithdraw), encU64(args.lpAmount));
}
function encodePauseMarket() {
  return encU8(IX_TAG.PauseMarket);
}
function encodeUnpauseMarket() {
  return encU8(IX_TAG.UnpauseMarket);
}
function encodeSetPythOracle(args) {
  if (args.feedId.length !== 32) throw new Error("feedId must be 32 bytes");
  if (args.maxStalenessSecs <= 0n) throw new Error("maxStalenessSecs must be > 0");
  const buf = new Uint8Array(43);
  const dv3 = new DataView(buf.buffer);
  buf[0] = 32;
  buf.set(args.feedId, 1);
  dv3.setBigUint64(
    33,
    args.maxStalenessSecs,
    /* little-endian */
    true
  );
  dv3.setUint16(41, args.confFilterBps, true);
  return buf;
}
var PYTH_RECEIVER_PROGRAM_ID = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
async function derivePythPriceUpdateAccount(feedId, shardId = 0) {
  const { PublicKey: PublicKey14 } = await import("@solana/web3.js");
  const shardBuf = new Uint8Array(2);
  new DataView(shardBuf.buffer).setUint16(0, shardId, true);
  const [pda] = PublicKey14.findProgramAddressSync(
    [shardBuf, feedId],
    new PublicKey14(PYTH_RECEIVER_PROGRAM_ID)
  );
  return pda.toBase58();
}
function encodeUpdateMarkPrice() {
  return new Uint8Array([33]);
}
var MARK_PRICE_EMA_WINDOW_SLOTS = 72000n;
var MARK_PRICE_EMA_ALPHA_E6 = 2000000n / (MARK_PRICE_EMA_WINDOW_SLOTS + 1n);
function computeEmaMarkPrice(markPrevE6, oracleE6, dtSlots, alphaE6 = MARK_PRICE_EMA_ALPHA_E6, capE2bps = 0n) {
  if (oracleE6 === 0n) return markPrevE6;
  if (markPrevE6 === 0n || dtSlots === 0n) return oracleE6;
  let oracleClamped = oracleE6;
  if (capE2bps > 0n) {
    const maxDelta = markPrevE6 * capE2bps / 1000000n * dtSlots;
    const lo = markPrevE6 > maxDelta ? markPrevE6 - maxDelta : 0n;
    const hi = markPrevE6 + maxDelta;
    if (oracleClamped < lo) oracleClamped = lo;
    if (oracleClamped > hi) oracleClamped = hi;
  }
  const effectiveAlpha = alphaE6 * dtSlots > 1000000n ? 1000000n : alphaE6 * dtSlots;
  const oneMinusAlpha = 1000000n - effectiveAlpha;
  return (oracleClamped * effectiveAlpha + markPrevE6 * oneMinusAlpha) / 1000000n;
}
function encodeUpdateHyperpMark() {
  return new Uint8Array([34]);
}
function encodeFundMarketInsurance(args) {
  return concatBytes(encU8(IX_TAG.FundMarketInsurance), encU64(args.amount));
}
function encodeSetInsuranceIsolation(args) {
  return concatBytes(encU8(IX_TAG.SetInsuranceIsolation), encU16(args.bps));
}
function encodeQueueWithdrawal(args) {
  return concatBytes(encU8(IX_TAG.QueueWithdrawal), encU64(args.lpAmount));
}
function encodeClaimQueuedWithdrawal() {
  return encU8(IX_TAG.ClaimQueuedWithdrawal);
}
function encodeCancelQueuedWithdrawal() {
  return encU8(IX_TAG.CancelQueuedWithdrawal);
}
function encodeExecuteAdl(args) {
  return concatBytes(encU8(IX_TAG.ExecuteAdl), encU16(args.targetIdx));
}
function encodeCloseStaleSlabs() {
  return encU8(IX_TAG.CloseStaleSlabs);
}
function encodeReclaimSlabRent() {
  return encU8(IX_TAG.ReclaimSlabRent);
}
function encodeAuditCrank() {
  return encU8(IX_TAG.AuditCrank);
}
var VAMM_MAGIC = 0x504552434d415443n;
var CTX_VAMM_OFFSET = 64;
var BPS_DENOM = 10000n;
function computeVammQuote(params, oraclePriceE6, tradeSize, isLong) {
  const absSize = tradeSize < 0n ? -tradeSize : tradeSize;
  const absNotionalE6 = absSize * oraclePriceE6 / 1000000n;
  let impactBps = 0n;
  if (params.mode === 1 && params.liquidityNotionalE6 > 0n) {
    impactBps = absNotionalE6 * BigInt(params.impactKBps) / params.liquidityNotionalE6;
  }
  const maxTotal = BigInt(params.maxTotalBps);
  const baseFee = BigInt(params.baseSpreadBps) + BigInt(params.tradingFeeBps);
  const maxImpact = maxTotal > baseFee ? maxTotal - baseFee : 0n;
  const clampedImpact = impactBps < maxImpact ? impactBps : maxImpact;
  let totalBps = baseFee + clampedImpact;
  if (totalBps > maxTotal) totalBps = maxTotal;
  if (isLong) {
    return oraclePriceE6 * (BPS_DENOM + totalBps) / BPS_DENOM;
  } else {
    if (totalBps >= BPS_DENOM) return 1n;
    return oraclePriceE6 * (BPS_DENOM - totalBps) / BPS_DENOM;
  }
}
function encodeAdvanceOraclePhase() {
  return encU8(IX_TAG.AdvanceOraclePhase);
}
var ORACLE_PHASE_NASCENT = 0;
var ORACLE_PHASE_GROWING = 1;
var ORACLE_PHASE_MATURE = 2;
var PHASE1_MIN_SLOTS = 648000n;
var PHASE1_VOLUME_MIN_SLOTS = 36000n;
var PHASE2_VOLUME_THRESHOLD = 100000000000n;
var PHASE2_MATURITY_SLOTS = 3024000n;
function checkPhaseTransition(currentSlot, marketCreatedSlot, oraclePhase, cumulativeVolumeE6, phase2DeltaSlots, hasMatureOracle) {
  switch (oraclePhase) {
    case 0: {
      const elapsed = currentSlot - (marketCreatedSlot > 0n ? marketCreatedSlot : currentSlot);
      const timeReady = elapsed >= PHASE1_MIN_SLOTS;
      const volumeReady = elapsed >= PHASE1_VOLUME_MIN_SLOTS && cumulativeVolumeE6 >= PHASE2_VOLUME_THRESHOLD;
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
function encodeTopUpKeeperFund(args) {
  return concatBytes(encU8(IX_TAG.TopUpKeeperFund), encU64(args.amount));
}
function encodeSlashCreationDeposit() {
  return encU8(IX_TAG.SlashCreationDeposit);
}
function encodeInitSharedVault(args) {
  return concatBytes(
    encU8(IX_TAG.InitSharedVault),
    encU64(args.epochDurationSlots),
    encU16(args.maxMarketExposureBps)
  );
}
function encodeAllocateMarket(args) {
  return concatBytes(encU8(IX_TAG.AllocateMarket), encU128(args.amount));
}
function encodeQueueWithdrawalSV(args) {
  return concatBytes(encU8(IX_TAG.QueueWithdrawalSV), encU64(args.lpAmount));
}
function encodeClaimEpochWithdrawal() {
  return encU8(IX_TAG.ClaimEpochWithdrawal);
}
function encodeAdvanceEpoch() {
  return encU8(IX_TAG.AdvanceEpoch);
}
function encodeSetOiImbalanceHardBlock(args) {
  if (args.thresholdBps < 0 || args.thresholdBps > 1e4) {
    throw new Error(`encodeSetOiImbalanceHardBlock: thresholdBps must be 0\u201310_000, got ${args.thresholdBps}`);
  }
  return concatBytes(encU8(IX_TAG.SetOiImbalanceHardBlock), encU16(args.thresholdBps));
}
function encodeMintPositionNft(args) {
  return concatBytes(encU8(IX_TAG.MintPositionNft), encU16(args.userIdx));
}
function encodeTransferPositionOwnership(args) {
  return concatBytes(encU8(IX_TAG.TransferPositionOwnership), encU16(args.userIdx));
}
function encodeBurnPositionNft(args) {
  return concatBytes(encU8(IX_TAG.BurnPositionNft), encU16(args.userIdx));
}
function encodeSetPendingSettlement(args) {
  return concatBytes(encU8(IX_TAG.SetPendingSettlement), encU16(args.userIdx));
}
function encodeClearPendingSettlement(args) {
  return concatBytes(encU8(IX_TAG.ClearPendingSettlement), encU16(args.userIdx));
}
function encodeTransferOwnershipCpi(args) {
  return concatBytes(
    encU8(IX_TAG.TransferOwnershipCpi),
    encU16(args.userIdx),
    encPubkey(args.newOwner)
  );
}
function encodeSetWalletCap(args) {
  return concatBytes(encU8(IX_TAG.SetWalletCap), encU64(args.capE6));
}
function encodeInitMatcherCtx(args) {
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
    encU16(args.skewSpreadMultBps)
  );
}
function encodeSetInsuranceWithdrawPolicy(args) {
  return concatBytes(encU8(IX_TAG.SetInsuranceWithdrawPolicy), encPubkey(args.authority), encU64(args.minWithdrawBase), encU16(args.maxWithdrawBps), encU64(args.cooldownSlots));
}
function encodeWithdrawInsuranceLimited(args) {
  return concatBytes(encU8(IX_TAG.WithdrawInsuranceLimited), encU64(args.amount));
}
function encodeResolvePermissionless() {
  return concatBytes(encU8(IX_TAG.ResolvePermissionless));
}
function encodeForceCloseResolved(args) {
  return concatBytes(encU8(IX_TAG.ForceCloseResolved), encU16(args.userIdx));
}
function encodeCreateLpVault(args) {
  const parts = [encU8(IX_TAG.CreateLpVault), encU64(args.feeShareBps)];
  if (args.utilCurveEnabled !== void 0) {
    parts.push(encU8(args.utilCurveEnabled ? 1 : 0));
  }
  return concatBytes(...parts);
}
function encodeLpVaultDeposit(args) {
  return concatBytes(encU8(IX_TAG.LpVaultDeposit), encU64(args.amount));
}
function encodeLpVaultCrankFees() {
  return concatBytes(encU8(IX_TAG.LpVaultCrankFees));
}
function encodeChallengeSettlement(args) {
  return concatBytes(encU8(IX_TAG.ChallengeSettlement), encU64(args.proposedPriceE6));
}
function encodeResolveDispute(args) {
  return concatBytes(encU8(IX_TAG.ResolveDispute), encU8(args.accept));
}
function encodeDepositLpCollateral(args) {
  return concatBytes(encU8(IX_TAG.DepositLpCollateral), encU16(args.userIdx), encU64(args.lpAmount));
}
function encodeWithdrawLpCollateral(args) {
  return concatBytes(encU8(IX_TAG.WithdrawLpCollateral), encU16(args.userIdx), encU64(args.lpAmount));
}
function encodeSetOffsetPair(args) {
  return concatBytes(encU8(IX_TAG.SetOffsetPair), encU16(args.offsetBps));
}
function encodeAttestCrossMargin(args) {
  return concatBytes(encU8(IX_TAG.AttestCrossMargin), encU16(args.userIdxA), encU16(args.userIdxB));
}
function encodeRescueOrphanVault() {
  return concatBytes(encU8(IX_TAG.RescueOrphanVault));
}
function encodeCloseOrphanSlab() {
  return concatBytes(encU8(IX_TAG.CloseOrphanSlab));
}
function encodeSetDexPool(args) {
  return concatBytes(encU8(IX_TAG.SetDexPool), encPubkey(args.pool));
}
function encodeCreateInsuranceMint() {
  return encodeCreateLpVault({ feeShareBps: 0n });
}
function encodeDepositInsuranceLP(args) {
  return encodeLpVaultDeposit({ amount: args.amount });
}
function encodeWithdrawInsuranceLP(args) {
  return encodeLpVaultWithdraw({ lpAmount: args.lpAmount });
}

// src/abi/accounts.ts
import {
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
var ACCOUNTS_INIT_MARKET = [
  { name: "admin", signer: true, writable: true },
  { name: "slab", signer: false, writable: true },
  { name: "mint", signer: false, writable: false },
  { name: "vault", signer: false, writable: false },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "clock", signer: false, writable: false },
  { name: "rent", signer: false, writable: false },
  { name: "dummyAta", signer: false, writable: false },
  { name: "systemProgram", signer: false, writable: false }
];
var ACCOUNTS_INIT_USER = [
  { name: "user", signer: true, writable: true },
  { name: "slab", signer: false, writable: true },
  { name: "userAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "clock", signer: false, writable: false }
];
var ACCOUNTS_INIT_LP = [
  { name: "user", signer: true, writable: true },
  { name: "slab", signer: false, writable: true },
  { name: "userAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false }
];
var ACCOUNTS_DEPOSIT_COLLATERAL = [
  { name: "user", signer: true, writable: true },
  { name: "slab", signer: false, writable: true },
  { name: "userAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "clock", signer: false, writable: false }
];
var ACCOUNTS_WITHDRAW_COLLATERAL = [
  { name: "user", signer: true, writable: true },
  { name: "slab", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "userAta", signer: false, writable: true },
  { name: "vaultPda", signer: false, writable: false },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "clock", signer: false, writable: false },
  { name: "oracleIdx", signer: false, writable: false }
];
var ACCOUNTS_KEEPER_CRANK = [
  { name: "caller", signer: true, writable: true },
  { name: "slab", signer: false, writable: true },
  { name: "clock", signer: false, writable: false },
  { name: "oracle", signer: false, writable: false }
];
var ACCOUNTS_TRADE_NOCPI = [
  { name: "user", signer: true, writable: true },
  { name: "lp", signer: true, writable: true },
  { name: "slab", signer: false, writable: true },
  { name: "oracle", signer: false, writable: false }
];
var ACCOUNTS_LIQUIDATE_AT_ORACLE = [
  { name: "unused", signer: false, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "clock", signer: false, writable: false },
  { name: "oracle", signer: false, writable: false }
];
var ACCOUNTS_CLOSE_ACCOUNT = [
  { name: "user", signer: true, writable: true },
  { name: "slab", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "userAta", signer: false, writable: true },
  { name: "vaultPda", signer: false, writable: false },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "clock", signer: false, writable: false },
  { name: "oracle", signer: false, writable: false }
];
var ACCOUNTS_TOPUP_INSURANCE = [
  { name: "user", signer: true, writable: true },
  { name: "slab", signer: false, writable: true },
  { name: "userAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false }
];
var ACCOUNTS_TRADE_CPI = [
  { name: "user", signer: true, writable: true },
  { name: "lpOwner", signer: false, writable: false },
  // LP delegated to matcher - no signature needed
  { name: "slab", signer: false, writable: true },
  { name: "oracle", signer: false, writable: false },
  { name: "matcherProg", signer: false, writable: false },
  { name: "matcherCtx", signer: false, writable: true },
  { name: "lpPda", signer: false, writable: false }
];
var ACCOUNTS_SET_RISK_THRESHOLD = [
  { name: "admin", signer: true, writable: true },
  { name: "slab", signer: false, writable: true }
];
var ACCOUNTS_UPDATE_ADMIN = [
  { name: "admin", signer: true, writable: true },
  { name: "slab", signer: false, writable: true }
];
var ACCOUNTS_CLOSE_SLAB = [
  { name: "admin", signer: true, writable: true },
  { name: "slab", signer: false, writable: true }
];
var ACCOUNTS_UPDATE_CONFIG = [
  { name: "admin", signer: true, writable: true },
  { name: "slab", signer: false, writable: true }
];
var ACCOUNTS_SET_MAINTENANCE_FEE = [
  { name: "admin", signer: true, writable: true },
  { name: "slab", signer: false, writable: true }
];
var ACCOUNTS_SET_ORACLE_AUTHORITY = [
  { name: "admin", signer: true, writable: true },
  { name: "slab", signer: false, writable: true }
];
var ACCOUNTS_SET_ORACLE_PRICE_CAP = [
  { name: "admin", signer: true, writable: true },
  { name: "slab", signer: false, writable: true }
];
var ACCOUNTS_PUSH_ORACLE_PRICE = [
  { name: "authority", signer: true, writable: true },
  { name: "slab", signer: false, writable: true }
];
var ACCOUNTS_RESOLVE_MARKET = [
  { name: "admin", signer: true, writable: true },
  { name: "slab", signer: false, writable: true }
];
var ACCOUNTS_WITHDRAW_INSURANCE = [
  { name: "admin", signer: true, writable: true },
  { name: "slab", signer: false, writable: true },
  { name: "adminAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "vaultPda", signer: false, writable: false }
];
var ACCOUNTS_PAUSE_MARKET = [
  { name: "admin", signer: true, writable: true },
  { name: "slab", signer: false, writable: true }
];
var ACCOUNTS_UNPAUSE_MARKET = [
  { name: "admin", signer: true, writable: true },
  { name: "slab", signer: false, writable: true }
];
function buildAccountMetas(spec, keys) {
  let keysArray;
  if (Array.isArray(keys)) {
    keysArray = keys;
  } else {
    keysArray = spec.map((s) => {
      const key = keys[s.name];
      if (!key) {
        throw new Error(
          `buildAccountMetas: missing key for account "${s.name}". Provided keys: [${Object.keys(keys).join(", ")}]`
        );
      }
      return key;
    });
  }
  if (keysArray.length !== spec.length) {
    throw new Error(
      `Account count mismatch: expected ${spec.length}, got ${keysArray.length}`
    );
  }
  return spec.map((s, i) => ({
    pubkey: keysArray[i],
    isSigner: s.signer,
    isWritable: s.writable
  }));
}
var ACCOUNTS_CREATE_INSURANCE_MINT = [
  { name: "admin", signer: true, writable: false },
  { name: "slab", signer: false, writable: false },
  { name: "insLpMint", signer: false, writable: true },
  { name: "vaultAuthority", signer: false, writable: false },
  { name: "collateralMint", signer: false, writable: false },
  { name: "systemProgram", signer: false, writable: false },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "rent", signer: false, writable: false },
  { name: "payer", signer: true, writable: true }
];
var ACCOUNTS_DEPOSIT_INSURANCE_LP = [
  { name: "depositor", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "depositorAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "insLpMint", signer: false, writable: true },
  { name: "depositorLpAta", signer: false, writable: true },
  { name: "vaultAuthority", signer: false, writable: false }
];
var ACCOUNTS_WITHDRAW_INSURANCE_LP = [
  { name: "withdrawer", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "withdrawerAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "insLpMint", signer: false, writable: true },
  { name: "withdrawerLpAta", signer: false, writable: true },
  { name: "vaultAuthority", signer: false, writable: false }
];
var ACCOUNTS_LP_VAULT_WITHDRAW = [
  { name: "withdrawer", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "withdrawerAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "lpVaultMint", signer: false, writable: true },
  { name: "withdrawerLpAta", signer: false, writable: true },
  { name: "vaultAuthority", signer: false, writable: false },
  { name: "lpVaultState", signer: false, writable: true },
  { name: "creatorLockPda", signer: false, writable: true }
];
var ACCOUNTS_FUND_MARKET_INSURANCE = [
  { name: "admin", signer: true, writable: true },
  { name: "slab", signer: false, writable: true },
  { name: "adminAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false }
];
var ACCOUNTS_SET_INSURANCE_ISOLATION = [
  { name: "admin", signer: true, writable: false },
  { name: "slab", signer: false, writable: true }
];
var ACCOUNTS_QUEUE_WITHDRAWAL = [
  { name: "user", signer: true, writable: true },
  { name: "slab", signer: false, writable: true },
  { name: "lpVaultState", signer: false, writable: false },
  { name: "withdrawQueue", signer: false, writable: true },
  { name: "systemProgram", signer: false, writable: false }
];
var ACCOUNTS_CLAIM_QUEUED_WITHDRAWAL = [
  { name: "user", signer: true, writable: true },
  { name: "slab", signer: false, writable: true },
  { name: "withdrawQueue", signer: false, writable: true },
  { name: "lpVaultMint", signer: false, writable: true },
  { name: "userLpAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "userAta", signer: false, writable: true },
  { name: "vaultAuthority", signer: false, writable: false },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "lpVaultState", signer: false, writable: true }
];
var ACCOUNTS_CANCEL_QUEUED_WITHDRAWAL = [
  { name: "user", signer: true, writable: true },
  { name: "slab", signer: false, writable: false },
  { name: "withdrawQueue", signer: false, writable: true }
];
var ACCOUNTS_EXECUTE_ADL = [
  { name: "caller", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "clock", signer: false, writable: false },
  { name: "oracle", signer: false, writable: false }
];
var ACCOUNTS_CLOSE_STALE_SLABS = [
  { name: "dest", signer: true, writable: true },
  { name: "slab", signer: false, writable: true }
];
var ACCOUNTS_RECLAIM_SLAB_RENT = [
  { name: "dest", signer: true, writable: true },
  { name: "slab", signer: true, writable: true }
];
var ACCOUNTS_AUDIT_CRANK = [
  { name: "slab", signer: false, writable: true }
];
var ACCOUNTS_ADVANCE_ORACLE_PHASE = [
  { name: "slab", signer: false, writable: true }
];
var ACCOUNTS_TOPUP_KEEPER_FUND = [
  { name: "funder", signer: true, writable: true },
  { name: "slab", signer: false, writable: true },
  { name: "keeperFund", signer: false, writable: true }
];
var ACCOUNTS_SET_OI_IMBALANCE_HARD_BLOCK = [
  { name: "admin", signer: true, writable: false },
  { name: "slab", signer: false, writable: true }
];
var ACCOUNTS_MINT_POSITION_NFT = [
  { name: "payer", signer: true, writable: true },
  { name: "slab", signer: false, writable: true },
  { name: "positionNftPda", signer: false, writable: true },
  { name: "nftMint", signer: false, writable: true },
  { name: "ownerAta", signer: false, writable: true },
  { name: "owner", signer: true, writable: false },
  { name: "vaultAuthority", signer: false, writable: false },
  { name: "token2022Program", signer: false, writable: false },
  { name: "systemProgram", signer: false, writable: false },
  { name: "rent", signer: false, writable: false }
];
var ACCOUNTS_TRANSFER_POSITION_OWNERSHIP = [
  { name: "currentOwner", signer: true, writable: true },
  { name: "slab", signer: false, writable: true },
  { name: "positionNftPda", signer: false, writable: true },
  { name: "nftMint", signer: false, writable: true },
  { name: "currentOwnerAta", signer: false, writable: true },
  { name: "newOwnerAta", signer: false, writable: true },
  { name: "newOwner", signer: false, writable: false },
  { name: "token2022Program", signer: false, writable: false }
];
var ACCOUNTS_BURN_POSITION_NFT = [
  { name: "owner", signer: true, writable: true },
  { name: "slab", signer: false, writable: true },
  { name: "positionNftPda", signer: false, writable: true },
  { name: "nftMint", signer: false, writable: true },
  { name: "ownerAta", signer: false, writable: true },
  { name: "vaultAuthority", signer: false, writable: false },
  { name: "token2022Program", signer: false, writable: false }
];
var ACCOUNTS_SET_PENDING_SETTLEMENT = [
  { name: "keeper", signer: true, writable: false },
  { name: "slab", signer: false, writable: false },
  { name: "positionNftPda", signer: false, writable: true }
];
var ACCOUNTS_CLEAR_PENDING_SETTLEMENT = [
  { name: "keeper", signer: true, writable: false },
  { name: "slab", signer: false, writable: false },
  { name: "positionNftPda", signer: false, writable: true }
];
var ACCOUNTS_SET_WALLET_CAP = [
  { name: "admin", signer: true, writable: false },
  { name: "slab", signer: false, writable: true }
];
var ACCOUNTS_SET_DEX_POOL = [
  { name: "admin", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "poolAccount", signer: false, writable: false }
];
var ACCOUNTS_INIT_MATCHER_CTX = [
  { name: "admin", signer: true, writable: false },
  { name: "slab", signer: false, writable: false },
  { name: "matcherCtx", signer: false, writable: true },
  { name: "matcherProg", signer: false, writable: false },
  { name: "lpPda", signer: false, writable: false }
];
var WELL_KNOWN = {
  tokenProgram: TOKEN_PROGRAM_ID,
  clock: SYSVAR_CLOCK_PUBKEY,
  rent: SYSVAR_RENT_PUBKEY,
  systemProgram: SystemProgram.programId
};

// src/abi/errors.ts
var PERCOLATOR_ERRORS = {
  0: {
    name: "InvalidMagic",
    hint: "The slab account has invalid data. Ensure you're using the correct slab address."
  },
  1: {
    name: "InvalidVersion",
    hint: "Slab version mismatch. The program may have been upgraded. Check for CLI updates."
  },
  2: {
    name: "AlreadyInitialized",
    hint: "This account is already initialized. Use a different account or skip initialization."
  },
  3: {
    name: "NotInitialized",
    hint: "The slab is not initialized. Run 'init-market' first."
  },
  4: {
    name: "InvalidSlabLen",
    hint: "Slab account has wrong size. Create a new slab account with correct size."
  },
  5: {
    name: "InvalidOracleKey",
    hint: "Oracle account doesn't match config. Check the --oracle parameter matches the market's oracle."
  },
  6: {
    name: "OracleStale",
    hint: "Oracle price is too old. Wait for oracle to update or check if oracle is paused."
  },
  7: {
    name: "OracleConfTooWide",
    hint: "Oracle confidence interval is too wide. Wait for more stable market conditions."
  },
  8: {
    name: "InvalidVaultAta",
    hint: "Vault token account is invalid. Check the vault account is correctly configured."
  },
  9: {
    name: "InvalidMint",
    hint: "Token mint doesn't match. Ensure you're using the correct collateral token."
  },
  10: {
    name: "ExpectedSigner",
    hint: "Missing required signature. Ensure the correct wallet is specified with --wallet."
  },
  11: {
    name: "ExpectedWritable",
    hint: "Account must be writable. This is likely a CLI bug - please report it."
  },
  12: {
    name: "OracleInvalid",
    hint: "Oracle data is invalid. Check the oracle account is a valid Pyth price feed."
  },
  13: {
    name: "EngineInsufficientBalance",
    hint: "Not enough collateral. Deposit more with 'deposit' before this operation."
  },
  14: {
    name: "EngineUndercollateralized",
    hint: "Account is undercollateralized. Deposit more collateral or reduce position size."
  },
  15: {
    name: "EngineUnauthorized",
    hint: "Not authorized. You must be the account owner or admin for this operation."
  },
  16: {
    name: "EngineInvalidMatchingEngine",
    hint: "Matcher program/context doesn't match LP config. Check --matcher-program and --matcher-context."
  },
  17: {
    name: "EnginePnlNotWarmedUp",
    hint: "PnL not warmed up yet. Wait for the warmup period to complete before trading."
  },
  18: {
    name: "EngineOverflow",
    hint: "Numeric overflow in calculation. Try a smaller amount or position size."
  },
  19: {
    name: "EngineAccountNotFound",
    hint: "Account not found at this index. Run 'init-user' or 'init-lp' first, or check the index."
  },
  20: {
    name: "EngineNotAnLPAccount",
    hint: "Expected an LP account but got a user account. Check the --lp-idx parameter."
  },
  21: {
    name: "EnginePositionSizeMismatch",
    hint: "Position size mismatch between user and LP. This shouldn't happen - please report it."
  },
  22: {
    name: "EngineRiskReductionOnlyMode",
    hint: "Market is in risk-reduction mode. Only position-reducing trades are allowed."
  },
  23: {
    name: "EngineAccountKindMismatch",
    hint: "Wrong account type. User operations require user accounts, LP operations require LP accounts."
  },
  24: {
    name: "InvalidTokenAccount",
    hint: "Token account is invalid. Ensure you have an ATA for the collateral mint."
  },
  25: {
    name: "InvalidTokenProgram",
    hint: "Invalid token program. Ensure SPL Token program is accessible."
  },
  26: {
    name: "InvalidConfigParam",
    hint: "Invalid configuration parameter. Check that leverage, fees, and risk thresholds are within allowed ranges."
  },
  27: {
    name: "HyperpTradeNoCpiDisabled",
    hint: "TradeNoCpi is disabled for this market. Use TradeCpi with LP matching instead."
  },
  28: {
    name: "InsuranceMintAlreadyExists",
    hint: "Insurance LP mint already exists for this market. Cannot recreate."
  },
  29: {
    name: "InsuranceMintNotCreated",
    hint: "Insurance LP mint has not been created yet. Run CreateInsuranceMint first."
  },
  30: {
    name: "InsuranceBelowThreshold",
    hint: "Insurance fund balance is below the required threshold. Deposit more to insurance fund."
  },
  31: {
    name: "InsuranceZeroAmount",
    hint: "Insurance deposit/withdrawal amount must be greater than zero."
  },
  32: {
    name: "InsuranceSupplyMismatch",
    hint: "Insurance LP token supply doesn't match vault balance. This is an internal error - please report it."
  },
  33: {
    name: "MarketPaused",
    hint: "This market is currently paused by the admin. Trading, deposits, and withdrawals are disabled."
  },
  34: {
    name: "AdminRenounceNotAllowed",
    hint: "Cannot renounce admin \u2014 the market must be RESOLVED first before renouncing admin control."
  },
  35: {
    name: "InvalidConfirmation",
    hint: "Invalid confirmation code for RenounceAdmin. This is a safety check \u2014 please verify the code."
  },
  36: {
    name: "InsufficientSeed",
    hint: "Vault seed balance is below the required minimum (500,000,000 raw tokens). Deposit more tokens to the vault before InitMarket."
  },
  37: {
    name: "InsufficientDexLiquidity",
    hint: "DEX pool has insufficient liquidity for safe Hyperp oracle bootstrapping. The quote-side reserves must meet the minimum threshold."
  },
  38: {
    name: "LpVaultAlreadyExists",
    hint: "LP vault already created for this market. Each market can only have one LP vault."
  },
  39: {
    name: "LpVaultNotCreated",
    hint: "LP vault not yet created. Call CreateLpVault first before depositing or withdrawing."
  },
  40: {
    name: "LpVaultZeroAmount",
    hint: "LP vault deposit or withdrawal amount must be greater than zero."
  },
  41: {
    name: "LpVaultSupplyMismatch",
    hint: "LP vault supply/capital mismatch \u2014 LP share supply > 0 but vault capital is 0. This is an internal error \u2014 please report it."
  },
  42: {
    name: "LpVaultWithdrawExceedsAvailable",
    hint: "LP vault withdrawal exceeds available capital. Some capital is reserved for open interest coverage."
  },
  43: {
    name: "LpVaultInvalidFeeShare",
    hint: "LP vault fee share basis points out of range. Must be 0\u201310,000 (0%\u2013100%)."
  },
  44: {
    name: "LpVaultNoNewFees",
    hint: "No new fees to distribute to LP vault. Wait for more trading activity to accrue fees."
  },
  // ── PERC-312 / PERC-314 / PERC-315 / PERC-309 / PERC-8111 / PERC-8110 (codes 45–60) ─────────
  45: {
    name: "SafetyValveDominantSideBlocked",
    hint: "New position on the dominant side is blocked while the market is rebalancing (safety valve)."
  },
  46: {
    name: "DisputeWindowClosed",
    hint: "The dispute window for this resolved market has closed."
  },
  47: {
    name: "DisputeAlreadyExists",
    hint: "A dispute already exists for this market \u2014 cannot open another."
  },
  48: {
    name: "MarketNotResolved",
    hint: "Market is not resolved \u2014 cannot dispute an active market."
  },
  49: {
    name: "NoActiveDispute",
    hint: "No active dispute found for this market."
  },
  50: {
    name: "LpCollateralDisabled",
    hint: "LP collateral is not enabled for this market."
  },
  51: {
    name: "LpCollateralPositionOpen",
    hint: "Cannot withdraw LP collateral while a position is still open."
  },
  52: {
    name: "WithdrawQueueAlreadyExists",
    hint: "A withdrawal queue entry already exists for this user/market."
  },
  53: {
    name: "WithdrawQueueNotFound",
    hint: "No queued withdrawal found for this user/market."
  },
  54: {
    name: "WithdrawQueueNothingClaimable",
    hint: "Nothing is claimable from the withdrawal queue this epoch \u2014 wait for the next epoch."
  },
  55: {
    name: "AuditViolation",
    hint: "Audit crank detected a conservation invariant violation \u2014 this is a critical internal error, please report it."
  },
  56: {
    name: "CrossMarginPairNotFound",
    hint: "Cross-margin offset pair is not configured for these two slabs."
  },
  57: {
    name: "CrossMarginAttestationStale",
    hint: "Cross-margin attestation is stale \u2014 too many slots have elapsed since the last attestation."
  },
  58: {
    name: "WalletPositionCapExceeded",
    hint: "Trade rejected: the resulting position would exceed the per-wallet position cap (max_wallet_pos_e6) for this market."
  },
  59: {
    name: "OiImbalanceHardBlock",
    hint: "Trade rejected: it would increase the OI imbalance (|long_oi \u2212 short_oi| / total_oi) beyond the configured hard-block threshold (oi_imbalance_hard_block_bps). Try the opposite side."
  },
  60: {
    name: "EngineInvalidEntryPrice",
    hint: "Entry price must be positive when opening a position."
  },
  61: {
    name: "EngineSideBlocked",
    hint: "New position blocked \u2014 this side is in DrainOnly or ResetPending mode. Wait for the market to stabilise."
  },
  62: {
    name: "EngineCorruptState",
    hint: "Engine detected a corrupt state invariant violation \u2014 this is a critical internal error, please report it."
  },
  63: {
    name: "InsuranceFundNotDepleted",
    hint: "ADL rejected \u2014 insurance fund is not fully depleted (balance > 0). ADL is only permitted once insurance is exhausted."
  },
  64: {
    name: "NoAdlCandidates",
    hint: "ADL rejected \u2014 no eligible candidate positions found for deleveraging."
  },
  65: {
    name: "BankruptPositionAlreadyClosed",
    hint: "ADL rejected \u2014 the target position is already closed (size == 0). Re-rank and pick a different target."
  }
};
function decodeError(code) {
  return PERCOLATOR_ERRORS[code];
}
function getErrorName(code) {
  return PERCOLATOR_ERRORS[code]?.name ?? `Unknown(${code})`;
}
function getErrorHint(code) {
  return PERCOLATOR_ERRORS[code]?.hint;
}
var CUSTOM_ERROR_HEX_MAX_LEN = 8;
function parseErrorFromLogs(logs) {
  if (!Array.isArray(logs)) {
    return null;
  }
  const re = new RegExp(
    `custom program error: 0x([0-9a-fA-F]{1,${CUSTOM_ERROR_HEX_MAX_LEN}})(?![0-9a-fA-F])`,
    "i"
  );
  for (const log of logs) {
    if (typeof log !== "string") {
      continue;
    }
    const match = log.match(re);
    if (match) {
      const code = parseInt(match[1], 16);
      if (!Number.isFinite(code) || code < 0 || code > 4294967295) {
        continue;
      }
      const info = decodeError(code);
      return {
        code,
        name: info?.name ?? `Unknown(${code})`,
        hint: info?.hint
      };
    }
  }
  return null;
}

// src/solana/slab.ts
import { PublicKey as PublicKey3 } from "@solana/web3.js";
function dv(data) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}
function readU8(data, off) {
  return data[off];
}
function readU16LE(data, off) {
  return dv(data).getUint16(off, true);
}
function readU32LE(data, off) {
  return dv(data).getUint32(off, true);
}
function readU64LE(data, off) {
  return dv(data).getBigUint64(off, true);
}
function readI64LE(data, off) {
  return dv(data).getBigInt64(off, true);
}
function readI128LE(buf, offset) {
  const lo = readU64LE(buf, offset);
  const hi = readU64LE(buf, offset + 8);
  const unsigned = hi << 64n | lo;
  const SIGN_BIT = 1n << 127n;
  if (unsigned >= SIGN_BIT) {
    return unsigned - (1n << 128n);
  }
  return unsigned;
}
function readU128LE(buf, offset) {
  const lo = readU64LE(buf, offset);
  const hi = readU64LE(buf, offset + 8);
  return hi << 64n | lo;
}
var MAGIC = 0x504552434f4c4154n;
var FLAG_RESOLVED = 1 << 0;
var V0_HEADER_LEN = 72;
var V0_CONFIG_LEN = 408;
var V0_ENGINE_OFF = 480;
var V0_ACCOUNT_SIZE = 240;
var V0_RESERVED_OFF = 48;
var V0_ENGINE_PARAMS_OFF = 48;
var V0_PARAMS_SIZE = 56;
var V0_ENGINE_CURRENT_SLOT_OFF = 104;
var V0_ENGINE_FUNDING_INDEX_OFF = 112;
var V0_ENGINE_LAST_FUNDING_SLOT_OFF = 128;
var V0_ENGINE_FUNDING_RATE_BPS_OFF = 136;
var V0_ENGINE_LAST_CRANK_SLOT_OFF = 144;
var V0_ENGINE_MAX_CRANK_STALENESS_OFF = 152;
var V0_ENGINE_TOTAL_OI_OFF = 160;
var V0_ENGINE_C_TOT_OFF = 176;
var V0_ENGINE_PNL_POS_TOT_OFF = 192;
var V0_ENGINE_LIQ_CURSOR_OFF = 208;
var V0_ENGINE_GC_CURSOR_OFF = 210;
var V0_ENGINE_LAST_SWEEP_START_OFF = 216;
var V0_ENGINE_LAST_SWEEP_COMPLETE_OFF = 224;
var V0_ENGINE_CRANK_CURSOR_OFF = 232;
var V0_ENGINE_SWEEP_START_IDX_OFF = 234;
var V0_ENGINE_LIFETIME_LIQUIDATIONS_OFF = 240;
var V0_ENGINE_LIFETIME_FORCE_CLOSES_OFF = 248;
var V0_ENGINE_NET_LP_POS_OFF = 256;
var V0_ENGINE_LP_SUM_ABS_OFF = 272;
var V0_ENGINE_LP_MAX_ABS_OFF = 288;
var V0_ENGINE_LP_MAX_ABS_SWEEP_OFF = 304;
var V0_ENGINE_BITMAP_OFF = 320;
var V1_HEADER_LEN = 104;
var V1_CONFIG_LEN = 496;
var V1_ENGINE_OFF = 600;
var V1_ENGINE_OFF_LEGACY = 640;
var V1_ACCOUNT_SIZE = 248;
var V1_RESERVED_OFF = 80;
var V1_ENGINE_PARAMS_OFF = 72;
var V1_PARAMS_SIZE = 288;
var V1_ENGINE_CURRENT_SLOT_OFF = 360;
var V1_ENGINE_FUNDING_INDEX_OFF = 368;
var V1_ENGINE_LAST_FUNDING_SLOT_OFF = 384;
var V1_ENGINE_FUNDING_RATE_BPS_OFF = 392;
var V1_ENGINE_MARK_PRICE_OFF = 400;
var V1_ENGINE_LAST_CRANK_SLOT_OFF = 424;
var V1_ENGINE_MAX_CRANK_STALENESS_OFF = 432;
var V1_ENGINE_TOTAL_OI_OFF = 440;
var V1_ENGINE_LONG_OI_OFF = 456;
var V1_ENGINE_SHORT_OI_OFF = 472;
var V1_ENGINE_C_TOT_OFF = 488;
var V1_ENGINE_PNL_POS_TOT_OFF = 504;
var V1_ENGINE_LIQ_CURSOR_OFF = 520;
var V1_ENGINE_GC_CURSOR_OFF = 522;
var V1_ENGINE_LAST_SWEEP_START_OFF = 528;
var V1_ENGINE_LAST_SWEEP_COMPLETE_OFF = 536;
var V1_ENGINE_CRANK_CURSOR_OFF = 544;
var V1_ENGINE_SWEEP_START_IDX_OFF = 546;
var V1_ENGINE_LIFETIME_LIQUIDATIONS_OFF = 552;
var V1_ENGINE_LIFETIME_FORCE_CLOSES_OFF = 560;
var V1_ENGINE_NET_LP_POS_OFF = 568;
var V1_ENGINE_LP_SUM_ABS_OFF = 584;
var V1_ENGINE_LP_MAX_ABS_OFF = 600;
var V1_ENGINE_LP_MAX_ABS_SWEEP_OFF = 616;
var V1_ENGINE_EMERGENCY_OI_MODE_OFF = 632;
var V1_ENGINE_EMERGENCY_START_SLOT_OFF = 640;
var V1_ENGINE_LAST_BREAKER_SLOT_OFF = 648;
var V1_ENGINE_BITMAP_OFF = 656;
var V1_LEGACY_ENGINE_BITMAP_OFF_ACTUAL = 672;
var V1D_CONFIG_LEN = 320;
var V1D_ENGINE_OFF = 424;
var V1D_ACCOUNT_SIZE = 248;
var V1D_ENGINE_INSURANCE_OFF = 16;
var V1D_ENGINE_PARAMS_OFF = 96;
var V1D_PARAMS_SIZE = 288;
var V1D_ENGINE_CURRENT_SLOT_OFF = 384;
var V1D_ENGINE_FUNDING_INDEX_OFF = 392;
var V1D_ENGINE_LAST_FUNDING_SLOT_OFF = 408;
var V1D_ENGINE_FUNDING_RATE_BPS_OFF = 416;
var V1D_ENGINE_MARK_PRICE_OFF = 424;
var V1D_ENGINE_LAST_CRANK_SLOT_OFF = 448;
var V1D_ENGINE_MAX_CRANK_STALENESS_OFF = 456;
var V1D_ENGINE_TOTAL_OI_OFF = 464;
var V1D_ENGINE_LONG_OI_OFF = 480;
var V1D_ENGINE_SHORT_OI_OFF = 496;
var V1D_ENGINE_C_TOT_OFF = 512;
var V1D_ENGINE_PNL_POS_TOT_OFF = 528;
var V1D_ENGINE_LIQ_CURSOR_OFF = 544;
var V1D_ENGINE_GC_CURSOR_OFF = 546;
var V1D_ENGINE_LAST_SWEEP_START_OFF = 552;
var V1D_ENGINE_LAST_SWEEP_COMPLETE_OFF = 560;
var V1D_ENGINE_CRANK_CURSOR_OFF = 568;
var V1D_ENGINE_SWEEP_START_IDX_OFF = 570;
var V1D_ENGINE_LIFETIME_LIQUIDATIONS_OFF = 576;
var V1D_ENGINE_LIFETIME_FORCE_CLOSES_OFF = 584;
var V1D_ENGINE_NET_LP_POS_OFF = 592;
var V1D_ENGINE_LP_SUM_ABS_OFF = 608;
var V1D_ENGINE_BITMAP_OFF = 624;
var V2_HEADER_LEN = 104;
var V2_CONFIG_LEN = 496;
var V2_ENGINE_OFF = 600;
var V2_ACCOUNT_SIZE = 248;
var V2_ENGINE_BITMAP_OFF = 432;
var V2_ENGINE_CURRENT_SLOT_OFF = 352;
var V2_ENGINE_FUNDING_INDEX_OFF = 360;
var V2_ENGINE_LAST_FUNDING_SLOT_OFF = 376;
var V2_ENGINE_FUNDING_RATE_BPS_OFF = 384;
var V2_ENGINE_LAST_CRANK_SLOT_OFF = 392;
var V2_ENGINE_MAX_CRANK_STALENESS_OFF = 400;
var V2_ENGINE_TOTAL_OI_OFF = 408;
var V2_ENGINE_C_TOT_OFF = 424;
var V2_ENGINE_PNL_POS_TOT_OFF = 440;
var V2_ENGINE_LIQ_CURSOR_OFF = 456;
var V2_ENGINE_GC_CURSOR_OFF = 458;
var V2_ENGINE_LAST_SWEEP_START_OFF = 464;
var V2_ENGINE_LAST_SWEEP_COMPLETE_OFF = 472;
var V2_ENGINE_CRANK_CURSOR_OFF = 480;
var V2_ENGINE_SWEEP_START_IDX_OFF = 482;
var V2_ENGINE_LIFETIME_LIQUIDATIONS_OFF = 488;
var V2_ENGINE_LIFETIME_FORCE_CLOSES_OFF = 496;
var V2_ENGINE_NET_LP_POS_OFF = 504;
var V2_ENGINE_LP_SUM_ABS_OFF = 520;
var V2_ENGINE_LP_MAX_ABS_OFF = 536;
var V2_ENGINE_LP_MAX_ABS_SWEEP_OFF = 552;
var V_ADL_ENGINE_OFF = 624;
var V_ADL_CONFIG_LEN = 520;
var V_SETDEXPOOL_CONFIG_LEN = 544;
var V_SETDEXPOOL_ENGINE_OFF = 648;
var V_ADL_ACCOUNT_SIZE = 312;
var V_ADL_ENGINE_PARAMS_OFF = 96;
var V_ADL_PARAMS_SIZE = 336;
var V_ADL_ENGINE_CURRENT_SLOT_OFF = 432;
var V_ADL_ENGINE_FUNDING_INDEX_OFF = 440;
var V_ADL_ENGINE_LAST_FUNDING_SLOT_OFF = 456;
var V_ADL_ENGINE_FUNDING_RATE_BPS_OFF = 464;
var V_ADL_ENGINE_MARK_PRICE_OFF = 504;
var V_ADL_ENGINE_LAST_CRANK_SLOT_OFF = 528;
var V_ADL_ENGINE_MAX_CRANK_STALENESS_OFF = 536;
var V_ADL_ENGINE_TOTAL_OI_OFF = 544;
var V_ADL_ENGINE_LONG_OI_OFF = 560;
var V_ADL_ENGINE_SHORT_OI_OFF = 576;
var V_ADL_ENGINE_C_TOT_OFF = 592;
var V_ADL_ENGINE_PNL_POS_TOT_OFF = 608;
var V_ADL_ENGINE_LIQ_CURSOR_OFF = 640;
var V_ADL_ENGINE_GC_CURSOR_OFF = 642;
var V_ADL_ENGINE_LAST_SWEEP_START_OFF = 648;
var V_ADL_ENGINE_LAST_SWEEP_COMPLETE_OFF = 656;
var V_ADL_ENGINE_CRANK_CURSOR_OFF = 664;
var V_ADL_ENGINE_SWEEP_START_IDX_OFF = 666;
var V_ADL_ENGINE_LIFETIME_LIQUIDATIONS_OFF = 672;
var V_ADL_ENGINE_LIFETIME_FORCE_CLOSES_OFF = 680;
var V_ADL_ENGINE_NET_LP_POS_OFF = 904;
var V_ADL_ENGINE_LP_SUM_ABS_OFF = 920;
var V_ADL_ENGINE_LP_MAX_ABS_OFF = 936;
var V_ADL_ENGINE_LP_MAX_ABS_SWEEP_OFF = 952;
var V_ADL_ENGINE_EMERGENCY_OI_MODE_OFF = 968;
var V_ADL_ENGINE_EMERGENCY_START_SLOT_OFF = 976;
var V_ADL_ENGINE_LAST_BREAKER_SLOT_OFF = 984;
var V_ADL_ENGINE_BITMAP_OFF = 1008;
var V_ADL_ACCT_WARMUP_STARTED_OFF = 64;
var V_ADL_ACCT_WARMUP_SLOPE_OFF = 72;
var V_ADL_ACCT_POSITION_SIZE_OFF = 88;
var V_ADL_ACCT_ENTRY_PRICE_OFF = 104;
var V_ADL_ACCT_FUNDING_INDEX_OFF = 112;
var V_ADL_ACCT_MATCHER_PROGRAM_OFF = 128;
var V_ADL_ACCT_MATCHER_CONTEXT_OFF = 160;
var V_ADL_ACCT_OWNER_OFF = 192;
var V_ADL_ACCT_FEE_CREDITS_OFF = 224;
var V_ADL_ACCT_LAST_FEE_SLOT_OFF = 240;
var V12_1_ENGINE_OFF = 648;
var V12_1_ACCOUNT_SIZE = 320;
var V12_1_ACCOUNT_SIZE_SBF = 280;
var V12_1_ENGINE_BITMAP_OFF = 1016;
var V12_1_ENGINE_PARAMS_OFF_SBF = 32;
var V12_1_ENGINE_PARAMS_OFF_HOST = 96;
var V12_1_PARAMS_SIZE_SBF = 184;
var V12_1_PARAMS_SIZE = 352;
var V12_1_SBF_OFF_CURRENT_SLOT = 216;
var V12_1_SBF_OFF_FUNDING_RATE = 224;
var V12_1_SBF_OFF_LAST_CRANK_SLOT = 232;
var V12_1_SBF_OFF_MAX_CRANK_STALENESS = 240;
var V12_1_SBF_OFF_C_TOT = 248;
var V12_1_SBF_OFF_PNL_POS_TOT = 264;
var V12_1_SBF_OFF_LIQ_CURSOR = 296;
var V12_1_SBF_OFF_GC_CURSOR = 298;
var V12_1_SBF_OFF_LAST_SWEEP_START = 304;
var V12_1_SBF_OFF_LAST_SWEEP_COMPLETE = 312;
var V12_1_SBF_OFF_CRANK_CURSOR = 320;
var V12_1_SBF_OFF_SWEEP_START_IDX = 322;
var V12_1_SBF_OFF_LIFETIME_LIQUIDATIONS = 328;
var V12_1_ENGINE_CURRENT_SLOT_OFF = 448;
var V12_1_ENGINE_FUNDING_RATE_BPS_OFF = 456;
var V12_1_ENGINE_LAST_CRANK_SLOT_OFF = 464;
var V12_1_ENGINE_MAX_CRANK_STALENESS_OFF = 472;
var V12_1_ENGINE_C_TOT_OFF = 480;
var V12_1_ENGINE_PNL_POS_TOT_OFF = 496;
var V12_1_ENGINE_LIQ_CURSOR_OFF = 528;
var V12_1_ENGINE_GC_CURSOR_OFF = 530;
var V12_1_ENGINE_LAST_SWEEP_START_OFF = 536;
var V12_1_ENGINE_LAST_SWEEP_COMPLETE_OFF = 544;
var V12_1_ENGINE_CRANK_CURSOR_OFF = 552;
var V12_1_ENGINE_SWEEP_START_IDX_OFF = 554;
var V12_1_ENGINE_LIFETIME_LIQUIDATIONS_OFF = 560;
var V12_1_ENGINE_TOTAL_OI_OFF = 816;
var V12_1_ENGINE_LONG_OI_OFF = 832;
var V12_1_ENGINE_SHORT_OI_OFF = 848;
var V12_1_ENGINE_NET_LP_POS_OFF = 864;
var V12_1_ENGINE_LP_SUM_ABS_OFF = 880;
var V12_1_ENGINE_LP_MAX_ABS_OFF = 896;
var V12_1_ENGINE_LP_MAX_ABS_SWEEP_OFF = 912;
var V12_1_ENGINE_MARK_PRICE_OFF = 928;
var V12_1_ENGINE_FUNDING_INDEX_OFF = 936;
var V12_1_ENGINE_LAST_FUNDING_SLOT_OFF = 944;
var V12_1_ENGINE_EMERGENCY_OI_MODE_OFF = 968;
var V12_1_ENGINE_EMERGENCY_START_SLOT_OFF = 976;
var V12_1_ENGINE_LAST_BREAKER_SLOT_OFF = 984;
var V12_1_ENGINE_LIFETIME_FORCE_CLOSES_OFF = 1008;
var V12_1_ACCT_MATCHER_PROGRAM_OFF = 144;
var V12_1_ACCT_MATCHER_CONTEXT_OFF = 176;
var V12_1_ACCT_OWNER_OFF = 208;
var V12_1_ACCT_FEE_CREDITS_OFF = 240;
var V12_1_ACCT_LAST_FEE_SLOT_OFF = 256;
var V12_1_ACCT_POSITION_SIZE_OFF = 88;
var V12_1_ACCT_ENTRY_PRICE_OFF = -1;
var V12_1_ACCT_FUNDING_INDEX_OFF = 288;
var V1M_ENGINE_OFF = 640;
var V1M_CONFIG_LEN = 536;
var V1M_ACCOUNT_SIZE = 248;
var V1M2_ENGINE_OFF = 616;
var V1M2_CONFIG_LEN = 512;
var V1M_ENGINE_PARAMS_OFF = 72;
var V1M2_ENGINE_PARAMS_OFF = 96;
var V1M_PARAMS_SIZE = 336;
var V1M_ENGINE_CURRENT_SLOT_OFF = 408;
var V1M_ENGINE_FUNDING_INDEX_OFF = 416;
var V1M_ENGINE_LAST_FUNDING_SLOT_OFF = 432;
var V1M_ENGINE_FUNDING_RATE_BPS_OFF = 440;
var V1M_ENGINE_MARK_PRICE_OFF = 448;
var V1M_ENGINE_LAST_CRANK_SLOT_OFF = 472;
var V1M_ENGINE_MAX_CRANK_STALENESS_OFF = 480;
var V1M_ENGINE_TOTAL_OI_OFF = 488;
var V1M_ENGINE_LONG_OI_OFF = 504;
var V1M_ENGINE_SHORT_OI_OFF = 520;
var V1M_ENGINE_C_TOT_OFF = 536;
var V1M_ENGINE_PNL_POS_TOT_OFF = 552;
var V1M_ENGINE_LIQ_CURSOR_OFF = 568;
var V1M_ENGINE_GC_CURSOR_OFF = 570;
var V1M_ENGINE_LAST_SWEEP_START_OFF = 576;
var V1M_ENGINE_LAST_SWEEP_COMPLETE_OFF = 584;
var V1M_ENGINE_CRANK_CURSOR_OFF = 592;
var V1M_ENGINE_SWEEP_START_IDX_OFF = 594;
var V1M_ENGINE_LIFETIME_LIQUIDATIONS_OFF = 600;
var V1M_ENGINE_LIFETIME_FORCE_CLOSES_OFF = 608;
var V1M_ENGINE_NET_LP_POS_OFF = 616;
var V1M_ENGINE_LP_SUM_ABS_OFF = 632;
var V1M_ENGINE_LP_MAX_ABS_OFF = 648;
var V1M_ENGINE_LP_MAX_ABS_SWEEP_OFF = 664;
var V1M_ENGINE_EMERGENCY_OI_MODE_OFF = 680;
var V1M_ENGINE_EMERGENCY_START_SLOT_OFF = 688;
var V1M_ENGINE_LAST_BREAKER_SLOT_OFF = 696;
var V1M_ENGINE_BITMAP_OFF = 720;
var V1M2_ACCOUNT_SIZE = 312;
var V1M2_ENGINE_BITMAP_OFF = 1008;
var ENGINE_OFF = V1_ENGINE_OFF;
var ENGINE_MARK_PRICE_OFF = V1_ENGINE_MARK_PRICE_OFF;
function computeSlabSize(engineOff, bitmapOff, accountSize, maxAccounts, postBitmap = 18) {
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOff = Math.ceil(preAccountsLen / 8) * 8;
  return engineOff + accountsOff + maxAccounts * accountSize;
}
var TIERS = [64, 256, 1024, 4096];
var V0_SIZES = /* @__PURE__ */ new Map();
var V1_SIZES = /* @__PURE__ */ new Map();
var V1_SIZES_LEGACY = /* @__PURE__ */ new Map();
var V1D_SIZES = /* @__PURE__ */ new Map();
var V2_SIZES = /* @__PURE__ */ new Map();
var V1M_SIZES = /* @__PURE__ */ new Map();
var V_ADL_SIZES = /* @__PURE__ */ new Map();
var V1M2_SIZES = /* @__PURE__ */ new Map();
var V_SETDEXPOOL_SIZES = /* @__PURE__ */ new Map();
var V12_1_SIZES = /* @__PURE__ */ new Map();
var V1D_SIZES_LEGACY = /* @__PURE__ */ new Map();
for (const n of TIERS) {
  V0_SIZES.set(computeSlabSize(V0_ENGINE_OFF, V0_ENGINE_BITMAP_OFF, V0_ACCOUNT_SIZE, n), n);
  V1_SIZES.set(computeSlabSize(V1_ENGINE_OFF, V1_ENGINE_BITMAP_OFF, V1_ACCOUNT_SIZE, n), n);
  V1_SIZES_LEGACY.set(computeSlabSize(V1_ENGINE_OFF_LEGACY, V1_ENGINE_BITMAP_OFF, V1_ACCOUNT_SIZE, n), n);
  V1D_SIZES.set(computeSlabSize(V1D_ENGINE_OFF, V1D_ENGINE_BITMAP_OFF, V1D_ACCOUNT_SIZE, n, 2), n);
  V1D_SIZES_LEGACY.set(computeSlabSize(V1D_ENGINE_OFF, V1D_ENGINE_BITMAP_OFF, V1D_ACCOUNT_SIZE, n, 18), n);
  V2_SIZES.set(computeSlabSize(V2_ENGINE_OFF, V2_ENGINE_BITMAP_OFF, V2_ACCOUNT_SIZE, n, 18), n);
  V1M_SIZES.set(computeSlabSize(V1M_ENGINE_OFF, V1M_ENGINE_BITMAP_OFF, V1M_ACCOUNT_SIZE, n, 18), n);
  V_ADL_SIZES.set(computeSlabSize(V_ADL_ENGINE_OFF, V_ADL_ENGINE_BITMAP_OFF, V_ADL_ACCOUNT_SIZE, n, 18), n);
  V1M2_SIZES.set(computeSlabSize(V1M2_ENGINE_OFF, V1M2_ENGINE_BITMAP_OFF, V1M2_ACCOUNT_SIZE, n, 18), n);
  V_SETDEXPOOL_SIZES.set(computeSlabSize(V_SETDEXPOOL_ENGINE_OFF, V_ADL_ENGINE_BITMAP_OFF, V_ADL_ACCOUNT_SIZE, n, 18), n);
  V12_1_SIZES.set(computeSlabSize(V12_1_ENGINE_OFF, V12_1_ENGINE_BITMAP_OFF, V12_1_ACCOUNT_SIZE, n, 18), n);
}
var V12_1_SBF_ACCOUNT_SIZE = 280;
var V12_1_SBF_ENGINE_OFF = 616;
var V12_1_SBF_BITMAP_OFF = 584;
for (const [, n] of [["Micro", 64], ["Small", 256], ["Medium", 1024], ["Large", 4096]]) {
  const bitmapBytes = Math.ceil(n / 64) * 8;
  const preAccLen = V12_1_SBF_BITMAP_OFF + bitmapBytes + 18 + n * 2;
  const accountsOff = Math.ceil(preAccLen / 8) * 8;
  const total = V12_1_SBF_ENGINE_OFF + accountsOff + n * V12_1_SBF_ACCOUNT_SIZE;
  V12_1_SIZES.set(total, n);
}
var SLAB_TIERS_V2 = {
  small: { maxAccounts: 256, dataSize: 65088, label: "Small", description: "256 slots (V2 BPF intermediate)" },
  large: { maxAccounts: 4096, dataSize: 1025568, label: "Large", description: "4,096 slots (V2 BPF intermediate)" }
};
var SLAB_TIERS_V1M = {};
for (const [label, n] of [["Micro", 64], ["Small", 256], ["Medium", 1024], ["Large", 4096]]) {
  const size = computeSlabSize(V1M_ENGINE_OFF, V1M_ENGINE_BITMAP_OFF, V1M_ACCOUNT_SIZE, n, 18);
  SLAB_TIERS_V1M[label.toLowerCase()] = { maxAccounts: n, dataSize: size, label, description: `${n} slots (V1M mainnet)` };
}
var SLAB_TIERS_V1M2 = {};
for (const [label, n] of [["Micro", 64], ["Small", 256], ["Medium", 1024], ["Large", 4096]]) {
  const size = computeSlabSize(V1M2_ENGINE_OFF, V1M2_ENGINE_BITMAP_OFF, V1M2_ACCOUNT_SIZE, n, 18);
  SLAB_TIERS_V1M2[label.toLowerCase()] = { maxAccounts: n, dataSize: size, label, description: `${n} slots (V1M2 mainnet upgraded)` };
}
var SLAB_TIERS_V_ADL = {};
for (const [label, n] of [["Micro", 64], ["Small", 256], ["Medium", 1024], ["Large", 4096]]) {
  const size = computeSlabSize(V_ADL_ENGINE_OFF, V_ADL_ENGINE_BITMAP_OFF, V_ADL_ACCOUNT_SIZE, n, 18);
  SLAB_TIERS_V_ADL[label.toLowerCase()] = { maxAccounts: n, dataSize: size, label, description: `${n} slots (V_ADL PERC-8270)` };
}
function buildLayout(version, maxAccounts, engineOffOverride) {
  const isV0 = version === 0;
  const engineOff = engineOffOverride ?? (isV0 ? V0_ENGINE_OFF : V1_ENGINE_OFF);
  const isV1Legacy = !isV0 && engineOffOverride === V1_ENGINE_OFF_LEGACY;
  const bitmapOff = isV0 ? V0_ENGINE_BITMAP_OFF : V1_ENGINE_BITMAP_OFF;
  const actualBitmapOff = isV1Legacy ? V1_LEGACY_ENGINE_BITMAP_OFF_ACTUAL : isV0 ? V0_ENGINE_BITMAP_OFF : V1_ENGINE_BITMAP_OFF;
  const accountSize = isV0 ? V0_ACCOUNT_SIZE : V1_ACCOUNT_SIZE;
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = actualBitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffRel = Math.ceil(preAccountsLen / 8) * 8;
  return {
    version,
    headerLen: isV0 ? V0_HEADER_LEN : V1_HEADER_LEN,
    configOffset: isV0 ? V0_HEADER_LEN : V1_HEADER_LEN,
    configLen: isV0 ? V0_CONFIG_LEN : V1_CONFIG_LEN,
    reservedOff: isV0 ? V0_RESERVED_OFF : V1_RESERVED_OFF,
    engineOff,
    accountSize,
    maxAccounts,
    bitmapWords,
    accountsOff: engineOff + accountsOffRel,
    engineInsuranceOff: 16,
    engineParamsOff: isV0 ? V0_ENGINE_PARAMS_OFF : V1_ENGINE_PARAMS_OFF,
    paramsSize: isV0 ? V0_PARAMS_SIZE : V1_PARAMS_SIZE,
    engineCurrentSlotOff: isV0 ? V0_ENGINE_CURRENT_SLOT_OFF : V1_ENGINE_CURRENT_SLOT_OFF,
    engineFundingIndexOff: isV0 ? V0_ENGINE_FUNDING_INDEX_OFF : V1_ENGINE_FUNDING_INDEX_OFF,
    engineLastFundingSlotOff: isV0 ? V0_ENGINE_LAST_FUNDING_SLOT_OFF : V1_ENGINE_LAST_FUNDING_SLOT_OFF,
    engineFundingRateBpsOff: isV0 ? V0_ENGINE_FUNDING_RATE_BPS_OFF : V1_ENGINE_FUNDING_RATE_BPS_OFF,
    engineMarkPriceOff: isV0 ? -1 : V1_ENGINE_MARK_PRICE_OFF,
    engineLastCrankSlotOff: isV0 ? V0_ENGINE_LAST_CRANK_SLOT_OFF : V1_ENGINE_LAST_CRANK_SLOT_OFF,
    engineMaxCrankStalenessOff: isV0 ? V0_ENGINE_MAX_CRANK_STALENESS_OFF : V1_ENGINE_MAX_CRANK_STALENESS_OFF,
    engineTotalOiOff: isV0 ? V0_ENGINE_TOTAL_OI_OFF : V1_ENGINE_TOTAL_OI_OFF,
    engineLongOiOff: isV0 ? -1 : V1_ENGINE_LONG_OI_OFF,
    engineShortOiOff: isV0 ? -1 : V1_ENGINE_SHORT_OI_OFF,
    engineCTotOff: isV0 ? V0_ENGINE_C_TOT_OFF : V1_ENGINE_C_TOT_OFF,
    enginePnlPosTotOff: isV0 ? V0_ENGINE_PNL_POS_TOT_OFF : V1_ENGINE_PNL_POS_TOT_OFF,
    engineLiqCursorOff: isV0 ? V0_ENGINE_LIQ_CURSOR_OFF : V1_ENGINE_LIQ_CURSOR_OFF,
    engineGcCursorOff: isV0 ? V0_ENGINE_GC_CURSOR_OFF : V1_ENGINE_GC_CURSOR_OFF,
    engineLastSweepStartOff: isV0 ? V0_ENGINE_LAST_SWEEP_START_OFF : V1_ENGINE_LAST_SWEEP_START_OFF,
    engineLastSweepCompleteOff: isV0 ? V0_ENGINE_LAST_SWEEP_COMPLETE_OFF : V1_ENGINE_LAST_SWEEP_COMPLETE_OFF,
    engineCrankCursorOff: isV0 ? V0_ENGINE_CRANK_CURSOR_OFF : V1_ENGINE_CRANK_CURSOR_OFF,
    engineSweepStartIdxOff: isV0 ? V0_ENGINE_SWEEP_START_IDX_OFF : V1_ENGINE_SWEEP_START_IDX_OFF,
    engineLifetimeLiquidationsOff: isV0 ? V0_ENGINE_LIFETIME_LIQUIDATIONS_OFF : V1_ENGINE_LIFETIME_LIQUIDATIONS_OFF,
    engineLifetimeForceClosesOff: isV0 ? V0_ENGINE_LIFETIME_FORCE_CLOSES_OFF : V1_ENGINE_LIFETIME_FORCE_CLOSES_OFF,
    engineNetLpPosOff: isV0 ? V0_ENGINE_NET_LP_POS_OFF : V1_ENGINE_NET_LP_POS_OFF,
    engineLpSumAbsOff: isV0 ? V0_ENGINE_LP_SUM_ABS_OFF : V1_ENGINE_LP_SUM_ABS_OFF,
    engineLpMaxAbsOff: isV0 ? V0_ENGINE_LP_MAX_ABS_OFF : V1_ENGINE_LP_MAX_ABS_OFF,
    engineLpMaxAbsSweepOff: isV0 ? V0_ENGINE_LP_MAX_ABS_SWEEP_OFF : V1_ENGINE_LP_MAX_ABS_SWEEP_OFF,
    engineEmergencyOiModeOff: isV0 ? -1 : V1_ENGINE_EMERGENCY_OI_MODE_OFF,
    engineEmergencyStartSlotOff: isV0 ? -1 : V1_ENGINE_EMERGENCY_START_SLOT_OFF,
    engineLastBreakerSlotOff: isV0 ? -1 : V1_ENGINE_LAST_BREAKER_SLOT_OFF,
    engineBitmapOff: actualBitmapOff,
    postBitmap: 18,
    acctOwnerOff: ACCT_OWNER_OFF,
    hasInsuranceIsolation: !isV0,
    engineInsuranceIsolatedOff: isV0 ? -1 : 48,
    engineInsuranceIsolationBpsOff: isV0 ? -1 : 64
  };
}
function buildLayoutV1D(maxAccounts, postBitmap = 2) {
  const engineOff = V1D_ENGINE_OFF;
  const bitmapOff = V1D_ENGINE_BITMAP_OFF;
  const accountSize = V1D_ACCOUNT_SIZE;
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffRel = Math.ceil(preAccountsLen / 8) * 8;
  return {
    version: 1,
    headerLen: V1_HEADER_LEN,
    configOffset: V1_HEADER_LEN,
    configLen: V1D_CONFIG_LEN,
    reservedOff: V1_RESERVED_OFF,
    engineOff,
    accountSize,
    maxAccounts,
    bitmapWords,
    accountsOff: engineOff + accountsOffRel,
    engineInsuranceOff: V1D_ENGINE_INSURANCE_OFF,
    engineParamsOff: V1D_ENGINE_PARAMS_OFF,
    paramsSize: V1D_PARAMS_SIZE,
    engineCurrentSlotOff: V1D_ENGINE_CURRENT_SLOT_OFF,
    engineFundingIndexOff: V1D_ENGINE_FUNDING_INDEX_OFF,
    engineLastFundingSlotOff: V1D_ENGINE_LAST_FUNDING_SLOT_OFF,
    engineFundingRateBpsOff: V1D_ENGINE_FUNDING_RATE_BPS_OFF,
    engineMarkPriceOff: V1D_ENGINE_MARK_PRICE_OFF,
    engineLastCrankSlotOff: V1D_ENGINE_LAST_CRANK_SLOT_OFF,
    engineMaxCrankStalenessOff: V1D_ENGINE_MAX_CRANK_STALENESS_OFF,
    engineTotalOiOff: V1D_ENGINE_TOTAL_OI_OFF,
    engineLongOiOff: V1D_ENGINE_LONG_OI_OFF,
    engineShortOiOff: V1D_ENGINE_SHORT_OI_OFF,
    engineCTotOff: V1D_ENGINE_C_TOT_OFF,
    enginePnlPosTotOff: V1D_ENGINE_PNL_POS_TOT_OFF,
    engineLiqCursorOff: V1D_ENGINE_LIQ_CURSOR_OFF,
    engineGcCursorOff: V1D_ENGINE_GC_CURSOR_OFF,
    engineLastSweepStartOff: V1D_ENGINE_LAST_SWEEP_START_OFF,
    engineLastSweepCompleteOff: V1D_ENGINE_LAST_SWEEP_COMPLETE_OFF,
    engineCrankCursorOff: V1D_ENGINE_CRANK_CURSOR_OFF,
    engineSweepStartIdxOff: V1D_ENGINE_SWEEP_START_IDX_OFF,
    engineLifetimeLiquidationsOff: V1D_ENGINE_LIFETIME_LIQUIDATIONS_OFF,
    engineLifetimeForceClosesOff: V1D_ENGINE_LIFETIME_FORCE_CLOSES_OFF,
    engineNetLpPosOff: V1D_ENGINE_NET_LP_POS_OFF,
    engineLpSumAbsOff: V1D_ENGINE_LP_SUM_ABS_OFF,
    engineLpMaxAbsOff: -1,
    // not present in deployed V1
    engineLpMaxAbsSweepOff: -1,
    // not present in deployed V1
    engineEmergencyOiModeOff: -1,
    // not present in deployed V1
    engineEmergencyStartSlotOff: -1,
    // not present in deployed V1
    engineLastBreakerSlotOff: -1,
    // not present in deployed V1
    engineBitmapOff: V1D_ENGINE_BITMAP_OFF,
    postBitmap,
    acctOwnerOff: ACCT_OWNER_OFF,
    hasInsuranceIsolation: true,
    engineInsuranceIsolatedOff: 48,
    // same within InsuranceFund
    engineInsuranceIsolationBpsOff: 64
    // same within InsuranceFund
  };
}
function buildLayoutV2(maxAccounts) {
  const engineOff = V2_ENGINE_OFF;
  const bitmapOff = V2_ENGINE_BITMAP_OFF;
  const accountSize = V2_ACCOUNT_SIZE;
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffRel = Math.ceil(preAccountsLen / 8) * 8;
  return {
    version: 2,
    headerLen: V2_HEADER_LEN,
    configOffset: V2_HEADER_LEN,
    configLen: V2_CONFIG_LEN,
    reservedOff: V1_RESERVED_OFF,
    // V2 shares V1's header layout (reserved at 80)
    engineOff,
    accountSize,
    maxAccounts,
    bitmapWords,
    accountsOff: engineOff + accountsOffRel,
    engineInsuranceOff: 16,
    engineParamsOff: V1_ENGINE_PARAMS_OFF,
    // same as V1: 72
    paramsSize: V1_PARAMS_SIZE,
    // same as V1: 288
    engineCurrentSlotOff: V2_ENGINE_CURRENT_SLOT_OFF,
    engineFundingIndexOff: V2_ENGINE_FUNDING_INDEX_OFF,
    engineLastFundingSlotOff: V2_ENGINE_LAST_FUNDING_SLOT_OFF,
    engineFundingRateBpsOff: V2_ENGINE_FUNDING_RATE_BPS_OFF,
    engineMarkPriceOff: -1,
    // V2 has no mark_price
    engineLastCrankSlotOff: V2_ENGINE_LAST_CRANK_SLOT_OFF,
    engineMaxCrankStalenessOff: V2_ENGINE_MAX_CRANK_STALENESS_OFF,
    engineTotalOiOff: V2_ENGINE_TOTAL_OI_OFF,
    engineLongOiOff: -1,
    // V2 has no long_oi
    engineShortOiOff: -1,
    // V2 has no short_oi
    engineCTotOff: V2_ENGINE_C_TOT_OFF,
    enginePnlPosTotOff: V2_ENGINE_PNL_POS_TOT_OFF,
    engineLiqCursorOff: V2_ENGINE_LIQ_CURSOR_OFF,
    engineGcCursorOff: V2_ENGINE_GC_CURSOR_OFF,
    engineLastSweepStartOff: V2_ENGINE_LAST_SWEEP_START_OFF,
    engineLastSweepCompleteOff: V2_ENGINE_LAST_SWEEP_COMPLETE_OFF,
    engineCrankCursorOff: V2_ENGINE_CRANK_CURSOR_OFF,
    engineSweepStartIdxOff: V2_ENGINE_SWEEP_START_IDX_OFF,
    engineLifetimeLiquidationsOff: V2_ENGINE_LIFETIME_LIQUIDATIONS_OFF,
    engineLifetimeForceClosesOff: V2_ENGINE_LIFETIME_FORCE_CLOSES_OFF,
    engineNetLpPosOff: V2_ENGINE_NET_LP_POS_OFF,
    engineLpSumAbsOff: V2_ENGINE_LP_SUM_ABS_OFF,
    engineLpMaxAbsOff: V2_ENGINE_LP_MAX_ABS_OFF,
    engineLpMaxAbsSweepOff: V2_ENGINE_LP_MAX_ABS_SWEEP_OFF,
    engineEmergencyOiModeOff: -1,
    // V2 has no emergency OI fields
    engineEmergencyStartSlotOff: -1,
    engineLastBreakerSlotOff: -1,
    engineBitmapOff: V2_ENGINE_BITMAP_OFF,
    postBitmap: 18,
    acctOwnerOff: ACCT_OWNER_OFF,
    hasInsuranceIsolation: true,
    engineInsuranceIsolatedOff: 48,
    engineInsuranceIsolationBpsOff: 64
  };
}
function buildLayoutV1M(maxAccounts) {
  const engineOff = V1M_ENGINE_OFF;
  const bitmapOff = V1M_ENGINE_BITMAP_OFF;
  const accountSize = V1M_ACCOUNT_SIZE;
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffRel = Math.ceil(preAccountsLen / 8) * 8;
  return {
    version: 1,
    headerLen: V1_HEADER_LEN,
    configOffset: V1_HEADER_LEN,
    configLen: V1M_CONFIG_LEN,
    reservedOff: V1_RESERVED_OFF,
    engineOff,
    accountSize,
    maxAccounts,
    bitmapWords,
    accountsOff: engineOff + accountsOffRel,
    engineInsuranceOff: 16,
    engineParamsOff: V1M_ENGINE_PARAMS_OFF,
    paramsSize: V1M_PARAMS_SIZE,
    engineCurrentSlotOff: V1M_ENGINE_CURRENT_SLOT_OFF,
    engineFundingIndexOff: V1M_ENGINE_FUNDING_INDEX_OFF,
    engineLastFundingSlotOff: V1M_ENGINE_LAST_FUNDING_SLOT_OFF,
    engineFundingRateBpsOff: V1M_ENGINE_FUNDING_RATE_BPS_OFF,
    engineMarkPriceOff: V1M_ENGINE_MARK_PRICE_OFF,
    engineLastCrankSlotOff: V1M_ENGINE_LAST_CRANK_SLOT_OFF,
    engineMaxCrankStalenessOff: V1M_ENGINE_MAX_CRANK_STALENESS_OFF,
    engineTotalOiOff: V1M_ENGINE_TOTAL_OI_OFF,
    engineLongOiOff: V1M_ENGINE_LONG_OI_OFF,
    engineShortOiOff: V1M_ENGINE_SHORT_OI_OFF,
    engineCTotOff: V1M_ENGINE_C_TOT_OFF,
    enginePnlPosTotOff: V1M_ENGINE_PNL_POS_TOT_OFF,
    engineLiqCursorOff: V1M_ENGINE_LIQ_CURSOR_OFF,
    engineGcCursorOff: V1M_ENGINE_GC_CURSOR_OFF,
    engineLastSweepStartOff: V1M_ENGINE_LAST_SWEEP_START_OFF,
    engineLastSweepCompleteOff: V1M_ENGINE_LAST_SWEEP_COMPLETE_OFF,
    engineCrankCursorOff: V1M_ENGINE_CRANK_CURSOR_OFF,
    engineSweepStartIdxOff: V1M_ENGINE_SWEEP_START_IDX_OFF,
    engineLifetimeLiquidationsOff: V1M_ENGINE_LIFETIME_LIQUIDATIONS_OFF,
    engineLifetimeForceClosesOff: V1M_ENGINE_LIFETIME_FORCE_CLOSES_OFF,
    engineNetLpPosOff: V1M_ENGINE_NET_LP_POS_OFF,
    engineLpSumAbsOff: V1M_ENGINE_LP_SUM_ABS_OFF,
    engineLpMaxAbsOff: V1M_ENGINE_LP_MAX_ABS_OFF,
    engineLpMaxAbsSweepOff: V1M_ENGINE_LP_MAX_ABS_SWEEP_OFF,
    engineEmergencyOiModeOff: V1M_ENGINE_EMERGENCY_OI_MODE_OFF,
    engineEmergencyStartSlotOff: V1M_ENGINE_EMERGENCY_START_SLOT_OFF,
    engineLastBreakerSlotOff: V1M_ENGINE_LAST_BREAKER_SLOT_OFF,
    engineBitmapOff: V1M_ENGINE_BITMAP_OFF,
    postBitmap: 18,
    acctOwnerOff: ACCT_OWNER_OFF,
    hasInsuranceIsolation: true,
    engineInsuranceIsolatedOff: 48,
    engineInsuranceIsolationBpsOff: 64
  };
}
function buildLayoutV1M2(maxAccounts) {
  const engineOff = V1M2_ENGINE_OFF;
  const bitmapOff = V1M2_ENGINE_BITMAP_OFF;
  const accountSize = V1M2_ACCOUNT_SIZE;
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffRel = Math.ceil(preAccountsLen / 8) * 8;
  return {
    version: 1,
    headerLen: V1_HEADER_LEN,
    configOffset: V1_HEADER_LEN,
    configLen: V1M2_CONFIG_LEN,
    reservedOff: V1_RESERVED_OFF,
    engineOff,
    accountSize,
    maxAccounts,
    bitmapWords,
    accountsOff: engineOff + accountsOffRel,
    engineInsuranceOff: 16,
    engineParamsOff: V1M2_ENGINE_PARAMS_OFF,
    // 96 — expanded InsuranceFund (same as V_ADL)
    paramsSize: V_ADL_PARAMS_SIZE,
    // 336 — same as V_ADL
    // Runtime fields: V1M2 engine struct is layout-identical to V_ADL — reuse V_ADL constants.
    engineCurrentSlotOff: V_ADL_ENGINE_CURRENT_SLOT_OFF,
    // 432
    engineFundingIndexOff: V_ADL_ENGINE_FUNDING_INDEX_OFF,
    // 440
    engineLastFundingSlotOff: V_ADL_ENGINE_LAST_FUNDING_SLOT_OFF,
    // 456
    engineFundingRateBpsOff: V_ADL_ENGINE_FUNDING_RATE_BPS_OFF,
    // 464
    engineMarkPriceOff: V_ADL_ENGINE_MARK_PRICE_OFF,
    // 504
    engineLastCrankSlotOff: V_ADL_ENGINE_LAST_CRANK_SLOT_OFF,
    // 528
    engineMaxCrankStalenessOff: V_ADL_ENGINE_MAX_CRANK_STALENESS_OFF,
    // 536
    engineTotalOiOff: V_ADL_ENGINE_TOTAL_OI_OFF,
    // 544
    engineLongOiOff: V_ADL_ENGINE_LONG_OI_OFF,
    // 560
    engineShortOiOff: V_ADL_ENGINE_SHORT_OI_OFF,
    // 576
    engineCTotOff: V_ADL_ENGINE_C_TOT_OFF,
    // 592
    enginePnlPosTotOff: V_ADL_ENGINE_PNL_POS_TOT_OFF,
    // 608
    engineLiqCursorOff: V_ADL_ENGINE_LIQ_CURSOR_OFF,
    // 640
    engineGcCursorOff: V_ADL_ENGINE_GC_CURSOR_OFF,
    // 642
    engineLastSweepStartOff: V_ADL_ENGINE_LAST_SWEEP_START_OFF,
    // 648
    engineLastSweepCompleteOff: V_ADL_ENGINE_LAST_SWEEP_COMPLETE_OFF,
    // 656
    engineCrankCursorOff: V_ADL_ENGINE_CRANK_CURSOR_OFF,
    // 664
    engineSweepStartIdxOff: V_ADL_ENGINE_SWEEP_START_IDX_OFF,
    // 666
    engineLifetimeLiquidationsOff: V_ADL_ENGINE_LIFETIME_LIQUIDATIONS_OFF,
    // 672
    engineLifetimeForceClosesOff: V_ADL_ENGINE_LIFETIME_FORCE_CLOSES_OFF,
    // 680
    engineNetLpPosOff: V_ADL_ENGINE_NET_LP_POS_OFF,
    // 904
    engineLpSumAbsOff: V_ADL_ENGINE_LP_SUM_ABS_OFF,
    // 920
    engineLpMaxAbsOff: V_ADL_ENGINE_LP_MAX_ABS_OFF,
    // 936
    engineLpMaxAbsSweepOff: V_ADL_ENGINE_LP_MAX_ABS_SWEEP_OFF,
    // 952
    engineEmergencyOiModeOff: V_ADL_ENGINE_EMERGENCY_OI_MODE_OFF,
    // 968
    engineEmergencyStartSlotOff: V_ADL_ENGINE_EMERGENCY_START_SLOT_OFF,
    // 976
    engineLastBreakerSlotOff: V_ADL_ENGINE_LAST_BREAKER_SLOT_OFF,
    // 984
    engineBitmapOff: V1M2_ENGINE_BITMAP_OFF,
    postBitmap: 18,
    acctOwnerOff: V_ADL_ACCT_OWNER_OFF,
    // 192 — same shift as V_ADL (reserved_pnl u64→u128)
    hasInsuranceIsolation: true,
    engineInsuranceIsolatedOff: 48,
    engineInsuranceIsolationBpsOff: 64
  };
}
function buildLayoutVADL(maxAccounts) {
  const engineOff = V_ADL_ENGINE_OFF;
  const bitmapOff = V_ADL_ENGINE_BITMAP_OFF;
  const accountSize = V_ADL_ACCOUNT_SIZE;
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffRel = Math.ceil(preAccountsLen / 8) * 8;
  return {
    version: 1,
    headerLen: V1_HEADER_LEN,
    // 104 (unchanged)
    configOffset: V1_HEADER_LEN,
    configLen: V_ADL_CONFIG_LEN,
    // 520
    reservedOff: V1_RESERVED_OFF,
    // 80
    engineOff,
    accountSize,
    maxAccounts,
    bitmapWords,
    accountsOff: engineOff + accountsOffRel,
    engineInsuranceOff: 16,
    engineParamsOff: V_ADL_ENGINE_PARAMS_OFF,
    // 96 (vault=16 + InsuranceFund=80)
    paramsSize: V_ADL_PARAMS_SIZE,
    // 336
    engineCurrentSlotOff: V_ADL_ENGINE_CURRENT_SLOT_OFF,
    // 432
    engineFundingIndexOff: V_ADL_ENGINE_FUNDING_INDEX_OFF,
    // 440
    engineLastFundingSlotOff: V_ADL_ENGINE_LAST_FUNDING_SLOT_OFF,
    // 456
    engineFundingRateBpsOff: V_ADL_ENGINE_FUNDING_RATE_BPS_OFF,
    // 464
    engineMarkPriceOff: V_ADL_ENGINE_MARK_PRICE_OFF,
    // 504
    engineLastCrankSlotOff: V_ADL_ENGINE_LAST_CRANK_SLOT_OFF,
    // 528
    engineMaxCrankStalenessOff: V_ADL_ENGINE_MAX_CRANK_STALENESS_OFF,
    // 536
    engineTotalOiOff: V_ADL_ENGINE_TOTAL_OI_OFF,
    // 544
    engineLongOiOff: V_ADL_ENGINE_LONG_OI_OFF,
    // 560
    engineShortOiOff: V_ADL_ENGINE_SHORT_OI_OFF,
    // 576
    engineCTotOff: V_ADL_ENGINE_C_TOT_OFF,
    // 592
    enginePnlPosTotOff: V_ADL_ENGINE_PNL_POS_TOT_OFF,
    // 608
    engineLiqCursorOff: V_ADL_ENGINE_LIQ_CURSOR_OFF,
    // 640
    engineGcCursorOff: V_ADL_ENGINE_GC_CURSOR_OFF,
    // 642
    engineLastSweepStartOff: V_ADL_ENGINE_LAST_SWEEP_START_OFF,
    // 648
    engineLastSweepCompleteOff: V_ADL_ENGINE_LAST_SWEEP_COMPLETE_OFF,
    // 656
    engineCrankCursorOff: V_ADL_ENGINE_CRANK_CURSOR_OFF,
    // 664
    engineSweepStartIdxOff: V_ADL_ENGINE_SWEEP_START_IDX_OFF,
    // 666
    engineLifetimeLiquidationsOff: V_ADL_ENGINE_LIFETIME_LIQUIDATIONS_OFF,
    // 672
    engineLifetimeForceClosesOff: V_ADL_ENGINE_LIFETIME_FORCE_CLOSES_OFF,
    // 680
    engineNetLpPosOff: V_ADL_ENGINE_NET_LP_POS_OFF,
    // 904
    engineLpSumAbsOff: V_ADL_ENGINE_LP_SUM_ABS_OFF,
    // 920
    engineLpMaxAbsOff: V_ADL_ENGINE_LP_MAX_ABS_OFF,
    // 936
    engineLpMaxAbsSweepOff: V_ADL_ENGINE_LP_MAX_ABS_SWEEP_OFF,
    // 952
    engineEmergencyOiModeOff: V_ADL_ENGINE_EMERGENCY_OI_MODE_OFF,
    // 968
    engineEmergencyStartSlotOff: V_ADL_ENGINE_EMERGENCY_START_SLOT_OFF,
    // 976
    engineLastBreakerSlotOff: V_ADL_ENGINE_LAST_BREAKER_SLOT_OFF,
    // 984
    engineBitmapOff: V_ADL_ENGINE_BITMAP_OFF,
    // 1008
    postBitmap: 18,
    acctOwnerOff: V_ADL_ACCT_OWNER_OFF,
    // 192
    hasInsuranceIsolation: true,
    engineInsuranceIsolatedOff: 48,
    engineInsuranceIsolationBpsOff: 64
  };
}
var SLAB_TIERS_V_SETDEXPOOL = {};
for (const [label, n] of [["Micro", 64], ["Small", 256], ["Medium", 1024], ["Large", 4096]]) {
  const size = computeSlabSize(V_SETDEXPOOL_ENGINE_OFF, V_ADL_ENGINE_BITMAP_OFF, V_ADL_ACCOUNT_SIZE, n, 18);
  SLAB_TIERS_V_SETDEXPOOL[label.toLowerCase()] = { maxAccounts: n, dataSize: size, label, description: `${n} slots (V_SETDEXPOOL PERC-SetDexPool)` };
}
var SLAB_TIERS_V12_1 = {};
for (const [label, n] of [["Micro", 64], ["Small", 256], ["Medium", 1024], ["Large", 4096]]) {
  const size = computeSlabSize(V12_1_ENGINE_OFF, V12_1_ENGINE_BITMAP_OFF, V12_1_ACCOUNT_SIZE, n, 18);
  SLAB_TIERS_V12_1[label.toLowerCase()] = { maxAccounts: n, dataSize: size, label, description: `${n} slots (v12.1)` };
}
function buildLayoutVSetDexPool(maxAccounts) {
  const engineOff = V_SETDEXPOOL_ENGINE_OFF;
  const bitmapOff = V_ADL_ENGINE_BITMAP_OFF;
  const accountSize = V_ADL_ACCOUNT_SIZE;
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffRel = Math.ceil(preAccountsLen / 8) * 8;
  return {
    version: 1,
    headerLen: V1_HEADER_LEN,
    configOffset: V1_HEADER_LEN,
    configLen: V_SETDEXPOOL_CONFIG_LEN,
    // 544
    reservedOff: V1_RESERVED_OFF,
    engineOff,
    accountSize,
    maxAccounts,
    bitmapWords,
    accountsOff: engineOff + accountsOffRel,
    engineInsuranceOff: 16,
    engineParamsOff: V_ADL_ENGINE_PARAMS_OFF,
    paramsSize: V_ADL_PARAMS_SIZE,
    engineCurrentSlotOff: V_ADL_ENGINE_CURRENT_SLOT_OFF,
    engineFundingIndexOff: V_ADL_ENGINE_FUNDING_INDEX_OFF,
    engineLastFundingSlotOff: V_ADL_ENGINE_LAST_FUNDING_SLOT_OFF,
    engineFundingRateBpsOff: V_ADL_ENGINE_FUNDING_RATE_BPS_OFF,
    engineMarkPriceOff: V_ADL_ENGINE_MARK_PRICE_OFF,
    engineLastCrankSlotOff: V_ADL_ENGINE_LAST_CRANK_SLOT_OFF,
    engineMaxCrankStalenessOff: V_ADL_ENGINE_MAX_CRANK_STALENESS_OFF,
    engineTotalOiOff: V_ADL_ENGINE_TOTAL_OI_OFF,
    engineLongOiOff: V_ADL_ENGINE_LONG_OI_OFF,
    engineShortOiOff: V_ADL_ENGINE_SHORT_OI_OFF,
    engineCTotOff: V_ADL_ENGINE_C_TOT_OFF,
    enginePnlPosTotOff: V_ADL_ENGINE_PNL_POS_TOT_OFF,
    engineLiqCursorOff: V_ADL_ENGINE_LIQ_CURSOR_OFF,
    engineGcCursorOff: V_ADL_ENGINE_GC_CURSOR_OFF,
    engineLastSweepStartOff: V_ADL_ENGINE_LAST_SWEEP_START_OFF,
    engineLastSweepCompleteOff: V_ADL_ENGINE_LAST_SWEEP_COMPLETE_OFF,
    engineCrankCursorOff: V_ADL_ENGINE_CRANK_CURSOR_OFF,
    engineSweepStartIdxOff: V_ADL_ENGINE_SWEEP_START_IDX_OFF,
    engineLifetimeLiquidationsOff: V_ADL_ENGINE_LIFETIME_LIQUIDATIONS_OFF,
    engineLifetimeForceClosesOff: V_ADL_ENGINE_LIFETIME_FORCE_CLOSES_OFF,
    engineNetLpPosOff: V_ADL_ENGINE_NET_LP_POS_OFF,
    engineLpSumAbsOff: V_ADL_ENGINE_LP_SUM_ABS_OFF,
    engineLpMaxAbsOff: V_ADL_ENGINE_LP_MAX_ABS_OFF,
    engineLpMaxAbsSweepOff: V_ADL_ENGINE_LP_MAX_ABS_SWEEP_OFF,
    engineEmergencyOiModeOff: V_ADL_ENGINE_EMERGENCY_OI_MODE_OFF,
    engineEmergencyStartSlotOff: V_ADL_ENGINE_EMERGENCY_START_SLOT_OFF,
    engineLastBreakerSlotOff: V_ADL_ENGINE_LAST_BREAKER_SLOT_OFF,
    engineBitmapOff: V_ADL_ENGINE_BITMAP_OFF,
    postBitmap: 18,
    acctOwnerOff: V_ADL_ACCT_OWNER_OFF,
    hasInsuranceIsolation: true,
    engineInsuranceIsolatedOff: 48,
    engineInsuranceIsolationBpsOff: 64
  };
}
function buildLayoutV12_1(maxAccounts, dataLen) {
  const hostSize = computeSlabSize(V12_1_ENGINE_OFF, V12_1_ENGINE_BITMAP_OFF, V12_1_ACCOUNT_SIZE, maxAccounts, 18);
  const isSbf = dataLen !== void 0 && dataLen !== hostSize;
  const engineOff = isSbf ? V12_1_SBF_ENGINE_OFF : V12_1_ENGINE_OFF;
  const bitmapOff = isSbf ? V12_1_SBF_BITMAP_OFF : V12_1_ENGINE_BITMAP_OFF - V12_1_ENGINE_OFF;
  const accountSize = isSbf ? V12_1_ACCOUNT_SIZE_SBF : V12_1_ACCOUNT_SIZE;
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = bitmapOff + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOffRel = Math.ceil(preAccountsLen / 8) * 8;
  return {
    version: 1,
    headerLen: V0_HEADER_LEN,
    // 72
    configOffset: V0_HEADER_LEN,
    // 72
    configLen: isSbf ? 544 : 576,
    reservedOff: V1_RESERVED_OFF,
    engineOff,
    accountSize,
    maxAccounts,
    bitmapWords,
    accountsOff: engineOff + accountsOffRel,
    engineInsuranceOff: 16,
    engineParamsOff: isSbf ? V12_1_ENGINE_PARAMS_OFF_SBF : V12_1_ENGINE_PARAMS_OFF_HOST,
    paramsSize: isSbf ? V12_1_PARAMS_SIZE_SBF : V12_1_PARAMS_SIZE,
    // SBF engine offsets — all verified by cargo build-sbf offset_of! assertions.
    // Fields that don't exist in the deployed program are set to -1 on SBF.
    engineCurrentSlotOff: isSbf ? V12_1_SBF_OFF_CURRENT_SLOT : V12_1_ENGINE_CURRENT_SLOT_OFF,
    engineFundingIndexOff: isSbf ? -1 : V12_1_ENGINE_FUNDING_INDEX_OFF,
    // not in deployed struct
    engineLastFundingSlotOff: isSbf ? -1 : V12_1_ENGINE_LAST_FUNDING_SLOT_OFF,
    // not in deployed struct
    engineFundingRateBpsOff: isSbf ? V12_1_SBF_OFF_FUNDING_RATE : V12_1_ENGINE_FUNDING_RATE_BPS_OFF,
    engineMarkPriceOff: isSbf ? -1 : V12_1_ENGINE_MARK_PRICE_OFF,
    // not in deployed struct
    engineLastCrankSlotOff: isSbf ? V12_1_SBF_OFF_LAST_CRANK_SLOT : V12_1_ENGINE_LAST_CRANK_SLOT_OFF,
    engineMaxCrankStalenessOff: isSbf ? V12_1_SBF_OFF_MAX_CRANK_STALENESS : V12_1_ENGINE_MAX_CRANK_STALENESS_OFF,
    engineTotalOiOff: isSbf ? -1 : V12_1_ENGINE_TOTAL_OI_OFF,
    // not in deployed struct
    engineLongOiOff: isSbf ? -1 : V12_1_ENGINE_LONG_OI_OFF,
    // not in deployed struct
    engineShortOiOff: isSbf ? -1 : V12_1_ENGINE_SHORT_OI_OFF,
    // not in deployed struct
    engineCTotOff: isSbf ? V12_1_SBF_OFF_C_TOT : V12_1_ENGINE_C_TOT_OFF,
    enginePnlPosTotOff: isSbf ? V12_1_SBF_OFF_PNL_POS_TOT : V12_1_ENGINE_PNL_POS_TOT_OFF,
    engineLiqCursorOff: isSbf ? V12_1_SBF_OFF_LIQ_CURSOR : V12_1_ENGINE_LIQ_CURSOR_OFF,
    engineGcCursorOff: isSbf ? V12_1_SBF_OFF_GC_CURSOR : V12_1_ENGINE_GC_CURSOR_OFF,
    engineLastSweepStartOff: isSbf ? V12_1_SBF_OFF_LAST_SWEEP_START : V12_1_ENGINE_LAST_SWEEP_START_OFF,
    engineLastSweepCompleteOff: isSbf ? V12_1_SBF_OFF_LAST_SWEEP_COMPLETE : V12_1_ENGINE_LAST_SWEEP_COMPLETE_OFF,
    engineCrankCursorOff: isSbf ? V12_1_SBF_OFF_CRANK_CURSOR : V12_1_ENGINE_CRANK_CURSOR_OFF,
    engineSweepStartIdxOff: isSbf ? V12_1_SBF_OFF_SWEEP_START_IDX : V12_1_ENGINE_SWEEP_START_IDX_OFF,
    engineLifetimeLiquidationsOff: isSbf ? V12_1_SBF_OFF_LIFETIME_LIQUIDATIONS : V12_1_ENGINE_LIFETIME_LIQUIDATIONS_OFF,
    engineLifetimeForceClosesOff: isSbf ? -1 : V12_1_ENGINE_LIFETIME_FORCE_CLOSES_OFF,
    // not in deployed struct
    engineNetLpPosOff: isSbf ? -1 : V12_1_ENGINE_NET_LP_POS_OFF,
    // not in deployed struct
    engineLpSumAbsOff: isSbf ? -1 : V12_1_ENGINE_LP_SUM_ABS_OFF,
    // not in deployed struct
    engineLpMaxAbsOff: isSbf ? -1 : V12_1_ENGINE_LP_MAX_ABS_OFF,
    // not in deployed struct
    engineLpMaxAbsSweepOff: isSbf ? -1 : V12_1_ENGINE_LP_MAX_ABS_SWEEP_OFF,
    // not in deployed struct
    engineEmergencyOiModeOff: isSbf ? -1 : V12_1_ENGINE_EMERGENCY_OI_MODE_OFF,
    // not in deployed struct
    engineEmergencyStartSlotOff: isSbf ? -1 : V12_1_ENGINE_EMERGENCY_START_SLOT_OFF,
    // not in deployed struct
    engineLastBreakerSlotOff: isSbf ? -1 : V12_1_ENGINE_LAST_BREAKER_SLOT_OFF,
    // not in deployed struct
    engineBitmapOff: bitmapOff,
    postBitmap: 18,
    acctOwnerOff: V12_1_ACCT_OWNER_OFF,
    // InsuranceFund on deployed program is just {balance: U128} = 16 bytes.
    // No isolated_balance or insurance_isolation_bps fields.
    hasInsuranceIsolation: !isSbf,
    engineInsuranceIsolatedOff: isSbf ? -1 : 48,
    engineInsuranceIsolationBpsOff: isSbf ? -1 : 64
  };
}
function detectSlabLayout(dataLen, data) {
  const v121n = V12_1_SIZES.get(dataLen);
  if (v121n !== void 0) return buildLayoutV12_1(v121n, dataLen);
  const vsdpn = V_SETDEXPOOL_SIZES.get(dataLen);
  if (vsdpn !== void 0) return buildLayoutVSetDexPool(vsdpn);
  const v1m2n = V1M2_SIZES.get(dataLen);
  if (v1m2n !== void 0) return buildLayoutV1M2(v1m2n);
  const vadln = V_ADL_SIZES.get(dataLen);
  if (vadln !== void 0) return buildLayoutVADL(vadln);
  const v1mn = V1M_SIZES.get(dataLen);
  if (v1mn !== void 0) return buildLayoutV1M(v1mn);
  const v0n = V0_SIZES.get(dataLen);
  if (v0n !== void 0) return buildLayout(0, v0n);
  const v1dn = V1D_SIZES.get(dataLen);
  if (v1dn !== void 0) {
    if (data && data.length >= 12) {
      const version = readU32LE(data, 8);
      if (version === 2) return buildLayoutV2(v1dn);
    }
    return buildLayoutV1D(v1dn, 2);
  }
  const v1dln = V1D_SIZES_LEGACY.get(dataLen);
  if (v1dln !== void 0) return buildLayoutV1D(v1dln, 18);
  const v1n = V1_SIZES.get(dataLen);
  if (v1n !== void 0) return buildLayout(1, v1n);
  const v1ln = V1_SIZES_LEGACY.get(dataLen);
  if (v1ln !== void 0) return buildLayout(1, v1ln, V1_ENGINE_OFF_LEGACY);
  return null;
}
function detectLayout(dataLen) {
  const layout = detectSlabLayout(dataLen);
  if (!layout) return null;
  return { bitmapWords: layout.bitmapWords, accountsOff: layout.accountsOff, maxAccounts: layout.maxAccounts };
}
var PARAMS_WARMUP_PERIOD_OFF = 0;
var PARAMS_MAINTENANCE_MARGIN_OFF = 8;
var PARAMS_INITIAL_MARGIN_OFF = 16;
var PARAMS_TRADING_FEE_OFF = 24;
var PARAMS_MAX_ACCOUNTS_OFF = 32;
var PARAMS_NEW_ACCOUNT_FEE_OFF = 40;
var PARAMS_RISK_THRESHOLD_OFF = 56;
var PARAMS_MAINTENANCE_FEE_OFF = 72;
var PARAMS_MAX_CRANK_STALENESS_OFF = 88;
var PARAMS_LIQUIDATION_FEE_BPS_OFF = 96;
var PARAMS_LIQUIDATION_FEE_CAP_OFF = 104;
var PARAMS_LIQUIDATION_BUFFER_OFF = 120;
var PARAMS_MIN_LIQUIDATION_OFF = 128;
var ACCT_ACCOUNT_ID_OFF = 0;
var ACCT_CAPITAL_OFF = 8;
var ACCT_KIND_OFF = 24;
var ACCT_PNL_OFF = 32;
var ACCT_RESERVED_PNL_OFF = 48;
var ACCT_WARMUP_STARTED_OFF = 56;
var ACCT_WARMUP_SLOPE_OFF = 64;
var ACCT_POSITION_SIZE_OFF = 80;
var ACCT_ENTRY_PRICE_OFF = 96;
var ACCT_FUNDING_INDEX_OFF = 104;
var ACCT_MATCHER_PROGRAM_OFF = 120;
var ACCT_MATCHER_CONTEXT_OFF = 152;
var ACCT_OWNER_OFF = 184;
var ACCT_FEE_CREDITS_OFF = 216;
var ACCT_LAST_FEE_SLOT_OFF = 232;
var AccountKind = /* @__PURE__ */ ((AccountKind2) => {
  AccountKind2[AccountKind2["User"] = 0] = "User";
  AccountKind2[AccountKind2["LP"] = 1] = "LP";
  return AccountKind2;
})(AccountKind || {});
async function fetchSlab(connection, slabPubkey) {
  const info = await connection.getAccountInfo(slabPubkey);
  if (!info) {
    throw new Error(`Slab account not found: ${slabPubkey.toBase58()}`);
  }
  return new Uint8Array(info.data);
}
var RAMP_START_BPS = 1000n;
var DEFAULT_OI_RAMP_SLOTS = 432000n;
function computeEffectiveOiCapBps(config, currentSlot) {
  const target = config.oiCapMultiplierBps;
  if (target === 0n) return 0n;
  if (config.oiRampSlots === 0n) return target;
  if (target <= RAMP_START_BPS) return target;
  const elapsed = currentSlot > config.marketCreatedSlot ? currentSlot - config.marketCreatedSlot : 0n;
  if (elapsed >= config.oiRampSlots) return target;
  const range = target - RAMP_START_BPS;
  const rampAdd = range * elapsed / config.oiRampSlots;
  const result = RAMP_START_BPS + rampAdd;
  return result < target ? result : target;
}
function readNonce(data) {
  const layout = detectSlabLayout(data.length, data);
  if (!layout) {
    throw new Error(`readNonce: unrecognized slab data length ${data.length}`);
  }
  const roff = layout.reservedOff;
  if (data.length < roff + 8) throw new Error("Slab data too short for nonce");
  return readU64LE(data, roff);
}
function readLastThrUpdateSlot(data) {
  const layout = detectSlabLayout(data.length, data);
  if (!layout) {
    throw new Error(`readLastThrUpdateSlot: unrecognized slab data length ${data.length}`);
  }
  const roff = layout.reservedOff;
  if (data.length < roff + 16) throw new Error("Slab data too short for lastThrUpdateSlot");
  return readU64LE(data, roff + 8);
}
function parseHeader(data) {
  if (data.length < V0_HEADER_LEN) {
    throw new Error(`Slab data too short for header: ${data.length} < ${V0_HEADER_LEN}`);
  }
  const magic = readU64LE(data, 0);
  if (magic !== MAGIC) {
    throw new Error(`Invalid slab magic: expected ${MAGIC.toString(16)}, got ${magic.toString(16)}`);
  }
  const version = readU32LE(data, 8);
  const bump = readU8(data, 12);
  const flags = readU8(data, 13);
  const admin = new PublicKey3(data.subarray(16, 48));
  const layout = detectSlabLayout(data.length, data);
  const roff = layout ? layout.reservedOff : V0_RESERVED_OFF;
  const nonce = readU64LE(data, roff);
  const lastThrUpdateSlot = readU64LE(data, roff + 8);
  return {
    magic,
    version,
    bump,
    flags,
    resolved: (flags & FLAG_RESOLVED) !== 0,
    paused: (flags & 2) !== 0,
    admin,
    nonce,
    lastThrUpdateSlot
  };
}
function parseConfig(data, layoutHint) {
  const layout = layoutHint !== void 0 ? layoutHint : detectSlabLayout(data.length, data);
  const configOff = layout ? layout.configOffset : V0_HEADER_LEN;
  const configLen = layout ? layout.configLen : V0_CONFIG_LEN;
  const minLen = configOff + Math.min(configLen, 120);
  if (data.length < minLen) {
    throw new Error(`Slab data too short for config: ${data.length} < ${minLen}`);
  }
  let off = configOff;
  const collateralMint = new PublicKey3(data.subarray(off, off + 32));
  off += 32;
  const vaultPubkey = new PublicKey3(data.subarray(off, off + 32));
  off += 32;
  const indexFeedId = new PublicKey3(data.subarray(off, off + 32));
  off += 32;
  const maxStalenessSlots = readU64LE(data, off);
  off += 8;
  const confFilterBps = readU16LE(data, off);
  off += 2;
  const vaultAuthorityBump = readU8(data, off);
  off += 1;
  const invert = readU8(data, off);
  off += 1;
  const unitScale = readU32LE(data, off);
  off += 4;
  const fundingHorizonSlots = readU64LE(data, off);
  off += 8;
  const fundingKBps = readU64LE(data, off);
  off += 8;
  const fundingInvScaleNotionalE6 = readU128LE(data, off);
  off += 16;
  const fundingMaxPremiumBps = readI64LE(data, off);
  off += 8;
  const fundingMaxBpsPerSlot = readI64LE(data, off);
  off += 8;
  const threshFloor = readU128LE(data, off);
  off += 16;
  const threshRiskBps = readU64LE(data, off);
  off += 8;
  const threshUpdateIntervalSlots = readU64LE(data, off);
  off += 8;
  const threshStepBps = readU64LE(data, off);
  off += 8;
  const threshAlphaBps = readU64LE(data, off);
  off += 8;
  const threshMin = readU128LE(data, off);
  off += 16;
  const threshMax = readU128LE(data, off);
  off += 16;
  const threshMinStep = readU128LE(data, off);
  off += 16;
  const oracleAuthority = new PublicKey3(data.subarray(off, off + 32));
  off += 32;
  const authorityPriceE6 = readU64LE(data, off);
  off += 8;
  const authorityTimestamp = readI64LE(data, off);
  off += 8;
  const oraclePriceCapE2bps = readU64LE(data, off);
  off += 8;
  const lastEffectivePriceE6 = readU64LE(data, off);
  off += 8;
  const oiCapMultiplierBps = readU64LE(data, off);
  off += 8;
  const maxPnlCap = readU64LE(data, off);
  off += 8;
  const remaining = configOff + configLen - off;
  let adaptiveFundingEnabled = false;
  let adaptiveScaleBps = 0;
  let adaptiveMaxFundingBps = 0n;
  let marketCreatedSlot = 0n;
  let oiRampSlots = 0n;
  let resolvedSlot = 0n;
  let insuranceIsolationBps = 0;
  let oraclePhase = 0;
  let cumulativeVolumeE6 = 0n;
  let phase2DeltaSlots = 0;
  if (remaining >= 40) {
    marketCreatedSlot = readU64LE(data, off);
    off += 8;
    oiRampSlots = readU64LE(data, off);
    off += 8;
    adaptiveFundingEnabled = readU8(data, off) !== 0;
    off += 1;
    off += 1;
    adaptiveScaleBps = readU16LE(data, off);
    off += 2;
    off += 4;
    adaptiveMaxFundingBps = readU64LE(data, off);
    off += 8;
    if (remaining >= 42) {
      insuranceIsolationBps = readU16LE(data, off);
      if (remaining >= 56) {
        const padOff = off + 2;
        oraclePhase = Math.min(readU8(data, padOff + 2), 2);
        cumulativeVolumeE6 = readU64LE(data, padOff + 3);
        phase2DeltaSlots = data[padOff + 11] | data[padOff + 12] << 8 | data[padOff + 13] << 16;
      }
    }
  }
  let dexPool = null;
  const DEX_POOL_REL_OFF = 512;
  if (configLen >= DEX_POOL_REL_OFF + 32 && data.length >= configOff + DEX_POOL_REL_OFF + 32) {
    const dexPoolBytes = data.subarray(configOff + DEX_POOL_REL_OFF, configOff + DEX_POOL_REL_OFF + 32);
    if (dexPoolBytes.some((b) => b !== 0)) {
      dexPool = new PublicKey3(dexPoolBytes);
    }
  }
  return {
    collateralMint,
    vaultPubkey,
    indexFeedId,
    maxStalenessSlots,
    confFilterBps,
    vaultAuthorityBump,
    invert,
    unitScale,
    fundingHorizonSlots,
    fundingKBps,
    fundingInvScaleNotionalE6,
    fundingMaxPremiumBps,
    fundingMaxBpsPerSlot,
    fundingPremiumWeightBps: 0n,
    fundingSettlementIntervalSlots: 0n,
    fundingPremiumDampeningE6: 0n,
    fundingPremiumMaxBpsPerSlot: 0n,
    threshFloor,
    threshRiskBps,
    threshUpdateIntervalSlots,
    threshStepBps,
    threshAlphaBps,
    threshMin,
    threshMax,
    threshMinStep,
    oracleAuthority,
    authorityPriceE6,
    authorityTimestamp,
    oraclePriceCapE2bps,
    lastEffectivePriceE6,
    oiCapMultiplierBps,
    maxPnlCap,
    adaptiveFundingEnabled,
    adaptiveScaleBps,
    adaptiveMaxFundingBps,
    marketCreatedSlot,
    oiRampSlots,
    resolvedSlot,
    insuranceIsolationBps,
    oraclePhase,
    cumulativeVolumeE6,
    phase2DeltaSlots,
    dexPool
  };
}
function parseParams(data, layoutHint) {
  const layout = layoutHint !== void 0 ? layoutHint : detectSlabLayout(data.length, data);
  const engineOff = layout ? layout.engineOff : V0_ENGINE_OFF;
  const paramsOff = layout ? layout.engineParamsOff : V0_ENGINE_PARAMS_OFF;
  const paramsSize = layout ? layout.paramsSize : V0_PARAMS_SIZE;
  const base = engineOff + paramsOff;
  if (data.length < base + Math.min(paramsSize, 56)) {
    throw new Error("Slab data too short for RiskParams");
  }
  const result = {
    warmupPeriodSlots: readU64LE(data, base + PARAMS_WARMUP_PERIOD_OFF),
    maintenanceMarginBps: readU64LE(data, base + PARAMS_MAINTENANCE_MARGIN_OFF),
    initialMarginBps: readU64LE(data, base + PARAMS_INITIAL_MARGIN_OFF),
    tradingFeeBps: readU64LE(data, base + PARAMS_TRADING_FEE_OFF),
    maxAccounts: readU64LE(data, base + PARAMS_MAX_ACCOUNTS_OFF),
    newAccountFee: readU128LE(data, base + PARAMS_NEW_ACCOUNT_FEE_OFF),
    // Extended params: only read if V1 (paramsSize >= 144)
    riskReductionThreshold: 0n,
    maintenanceFeePerSlot: 0n,
    maxCrankStalenessSlots: 0n,
    liquidationFeeBps: 0n,
    liquidationFeeCap: 0n,
    liquidationBufferBps: 0n,
    minLiquidationAbs: 0n
  };
  if (paramsSize >= 144) {
    result.riskReductionThreshold = readU128LE(data, base + PARAMS_RISK_THRESHOLD_OFF);
    result.maintenanceFeePerSlot = readU128LE(data, base + PARAMS_MAINTENANCE_FEE_OFF);
    result.maxCrankStalenessSlots = readU64LE(data, base + PARAMS_MAX_CRANK_STALENESS_OFF);
    result.liquidationFeeBps = readU64LE(data, base + PARAMS_LIQUIDATION_FEE_BPS_OFF);
    result.liquidationFeeCap = readU128LE(data, base + PARAMS_LIQUIDATION_FEE_CAP_OFF);
    result.liquidationBufferBps = readU64LE(data, base + PARAMS_LIQUIDATION_BUFFER_OFF);
    result.minLiquidationAbs = readU128LE(data, base + PARAMS_MIN_LIQUIDATION_OFF);
  }
  return result;
}
function parseEngine(data) {
  const layout = detectSlabLayout(data.length, data);
  if (!layout) {
    throw new Error(`Unrecognized slab data length: ${data.length}. Cannot determine layout version.`);
  }
  const base = layout.engineOff;
  return {
    vault: readU128LE(data, base),
    insuranceFund: {
      balance: readU128LE(data, base + layout.engineInsuranceOff),
      // feeRevenue: only exists in percolator-core (80-byte InsuranceFund), not deployed (16-byte)
      feeRevenue: layout.hasInsuranceIsolation ? readU128LE(data, base + layout.engineInsuranceOff + 16) : 0n,
      isolatedBalance: layout.hasInsuranceIsolation ? readU128LE(data, base + layout.engineInsuranceIsolatedOff) : 0n,
      isolationBps: layout.hasInsuranceIsolation ? readU16LE(data, base + layout.engineInsuranceIsolationBpsOff) : 0
    },
    currentSlot: readU64LE(data, base + layout.engineCurrentSlotOff),
    fundingIndexQpbE6: layout.engineFundingIndexOff >= 0 ? readI128LE(data, base + layout.engineFundingIndexOff) : 0n,
    lastFundingSlot: layout.engineLastFundingSlotOff >= 0 ? readU64LE(data, base + layout.engineLastFundingSlotOff) : 0n,
    fundingRateBpsPerSlotLast: readI64LE(data, base + layout.engineFundingRateBpsOff),
    lastCrankSlot: readU64LE(data, base + layout.engineLastCrankSlotOff),
    maxCrankStalenessSlots: readU64LE(data, base + layout.engineMaxCrankStalenessOff),
    totalOpenInterest: layout.engineTotalOiOff >= 0 ? readU128LE(data, base + layout.engineTotalOiOff) : 0n,
    longOi: layout.engineLongOiOff >= 0 ? readU128LE(data, base + layout.engineLongOiOff) : 0n,
    shortOi: layout.engineShortOiOff >= 0 ? readU128LE(data, base + layout.engineShortOiOff) : 0n,
    cTot: readU128LE(data, base + layout.engineCTotOff),
    pnlPosTot: readU128LE(data, base + layout.enginePnlPosTotOff),
    liqCursor: readU16LE(data, base + layout.engineLiqCursorOff),
    gcCursor: readU16LE(data, base + layout.engineGcCursorOff),
    lastSweepStartSlot: readU64LE(data, base + layout.engineLastSweepStartOff),
    lastSweepCompleteSlot: readU64LE(data, base + layout.engineLastSweepCompleteOff),
    crankCursor: readU16LE(data, base + layout.engineCrankCursorOff),
    sweepStartIdx: readU16LE(data, base + layout.engineSweepStartIdxOff),
    lifetimeLiquidations: readU64LE(data, base + layout.engineLifetimeLiquidationsOff),
    lifetimeForceCloses: layout.engineLifetimeForceClosesOff >= 0 ? readU64LE(data, base + layout.engineLifetimeForceClosesOff) : 0n,
    netLpPos: layout.engineNetLpPosOff >= 0 ? readI128LE(data, base + layout.engineNetLpPosOff) : 0n,
    lpSumAbs: layout.engineLpSumAbsOff >= 0 ? readU128LE(data, base + layout.engineLpSumAbsOff) : 0n,
    lpMaxAbs: layout.engineLpMaxAbsOff >= 0 ? readU128LE(data, base + layout.engineLpMaxAbsOff) : 0n,
    lpMaxAbsSweep: layout.engineLpMaxAbsSweepOff >= 0 ? readU128LE(data, base + layout.engineLpMaxAbsSweepOff) : 0n,
    emergencyOiMode: layout.engineEmergencyOiModeOff >= 0 ? data[base + layout.engineEmergencyOiModeOff] !== 0 : false,
    emergencyStartSlot: layout.engineEmergencyStartSlotOff >= 0 ? readU64LE(data, base + layout.engineEmergencyStartSlotOff) : 0n,
    lastBreakerSlot: layout.engineLastBreakerSlotOff >= 0 ? readU64LE(data, base + layout.engineLastBreakerSlotOff) : 0n,
    markPriceE6: layout.engineMarkPriceOff >= 0 ? readU64LE(data, base + layout.engineMarkPriceOff) : 0n,
    numUsedAccounts: (() => {
      if (layout.postBitmap < 18) return 0;
      const bw = layout.bitmapWords;
      return readU16LE(data, base + layout.engineBitmapOff + bw * 8);
    })(),
    nextAccountId: (() => {
      if (layout.postBitmap < 18) return 0n;
      const bw = layout.bitmapWords;
      const numUsedOff = layout.engineBitmapOff + bw * 8;
      return readU64LE(data, base + Math.ceil((numUsedOff + 2) / 8) * 8);
    })()
  };
}
function parseUsedIndices(data) {
  const layout = detectSlabLayout(data.length, data);
  if (!layout) throw new Error(`Unrecognized slab data length: ${data.length}`);
  const base = layout.engineOff + layout.engineBitmapOff;
  if (data.length < base + layout.bitmapWords * 8) {
    throw new Error("Slab data too short for bitmap");
  }
  const used = [];
  for (let word = 0; word < layout.bitmapWords; word++) {
    const bits = readU64LE(data, base + word * 8);
    if (bits === 0n) continue;
    for (let bit = 0; bit < 64; bit++) {
      if (bits >> BigInt(bit) & 1n) {
        used.push(word * 64 + bit);
      }
    }
  }
  return used;
}
function isAccountUsed(data, idx) {
  const layout = detectSlabLayout(data.length, data);
  if (!layout) return false;
  if (!Number.isInteger(idx) || idx < 0 || idx >= layout.maxAccounts) return false;
  const base = layout.engineOff + layout.engineBitmapOff;
  const word = Math.floor(idx / 64);
  const bit = idx % 64;
  const bits = readU64LE(data, base + word * 8);
  return (bits >> BigInt(bit) & 1n) !== 0n;
}
function maxAccountIndex(dataLen) {
  const layout = detectSlabLayout(dataLen);
  if (!layout) return 0;
  const accountsEnd = dataLen - layout.accountsOff;
  if (accountsEnd <= 0) return 0;
  return Math.floor(accountsEnd / layout.accountSize);
}
function parseAccount(data, idx) {
  const layout = detectSlabLayout(data.length, data);
  if (!layout) throw new Error(`Unrecognized slab data length: ${data.length}`);
  const maxIdx = maxAccountIndex(data.length);
  if (!Number.isInteger(idx) || idx < 0 || idx >= maxIdx) {
    throw new Error(`Account index out of range: ${idx} (max: ${maxIdx - 1})`);
  }
  const base = layout.accountsOff + idx * layout.accountSize;
  if (data.length < base + layout.accountSize) {
    throw new Error("Slab data too short for account");
  }
  const isV12_1 = (layout.engineOff === V12_1_ENGINE_OFF || layout.engineOff === V12_1_SBF_ENGINE_OFF) && (layout.accountSize === V12_1_ACCOUNT_SIZE || layout.accountSize === V12_1_ACCOUNT_SIZE_SBF);
  const isAdl = layout.accountSize >= 312 || isV12_1;
  const warmupStartedOff = isAdl ? V_ADL_ACCT_WARMUP_STARTED_OFF : ACCT_WARMUP_STARTED_OFF;
  const warmupSlopeOff = isAdl ? V_ADL_ACCT_WARMUP_SLOPE_OFF : ACCT_WARMUP_SLOPE_OFF;
  const positionSizeOff = isV12_1 ? V12_1_ACCT_POSITION_SIZE_OFF : isAdl ? V_ADL_ACCT_POSITION_SIZE_OFF : ACCT_POSITION_SIZE_OFF;
  const entryPriceOff = isV12_1 ? V12_1_ACCT_ENTRY_PRICE_OFF : isAdl ? V_ADL_ACCT_ENTRY_PRICE_OFF : ACCT_ENTRY_PRICE_OFF;
  const fundingIndexOff = isV12_1 ? V12_1_ACCT_FUNDING_INDEX_OFF : isAdl ? V_ADL_ACCT_FUNDING_INDEX_OFF : ACCT_FUNDING_INDEX_OFF;
  const matcherProgOff = isV12_1 ? V12_1_ACCT_MATCHER_PROGRAM_OFF : isAdl ? V_ADL_ACCT_MATCHER_PROGRAM_OFF : ACCT_MATCHER_PROGRAM_OFF;
  const matcherCtxOff = isV12_1 ? V12_1_ACCT_MATCHER_CONTEXT_OFF : isAdl ? V_ADL_ACCT_MATCHER_CONTEXT_OFF : ACCT_MATCHER_CONTEXT_OFF;
  const feeCreditsOff = isV12_1 ? V12_1_ACCT_FEE_CREDITS_OFF : isAdl ? V_ADL_ACCT_FEE_CREDITS_OFF : ACCT_FEE_CREDITS_OFF;
  const lastFeeSlotOff = isV12_1 ? V12_1_ACCT_LAST_FEE_SLOT_OFF : isAdl ? V_ADL_ACCT_LAST_FEE_SLOT_OFF : ACCT_LAST_FEE_SLOT_OFF;
  const kindByte = readU8(data, base + ACCT_KIND_OFF);
  const kind = kindByte === 1 ? 1 /* LP */ : 0 /* User */;
  return {
    kind,
    accountId: readU64LE(data, base + ACCT_ACCOUNT_ID_OFF),
    capital: readU128LE(data, base + ACCT_CAPITAL_OFF),
    pnl: readI128LE(data, base + ACCT_PNL_OFF),
    reservedPnl: isAdl ? readU128LE(data, base + ACCT_RESERVED_PNL_OFF) : readU64LE(data, base + ACCT_RESERVED_PNL_OFF),
    warmupStartedAtSlot: readU64LE(data, base + warmupStartedOff),
    warmupSlopePerStep: readU128LE(data, base + warmupSlopeOff),
    positionSize: readI128LE(data, base + positionSizeOff),
    entryPrice: entryPriceOff >= 0 ? readU64LE(data, base + entryPriceOff) : 0n,
    // V12_1: entry_price removed
    // V12_1 changed funding_index from i128 to i64 (legacy field moved to end of account)
    fundingIndex: isV12_1 ? BigInt(readI64LE(data, base + fundingIndexOff)) : readI128LE(data, base + fundingIndexOff),
    matcherProgram: new PublicKey3(data.subarray(base + matcherProgOff, base + matcherProgOff + 32)),
    matcherContext: new PublicKey3(data.subarray(base + matcherCtxOff, base + matcherCtxOff + 32)),
    owner: new PublicKey3(data.subarray(base + layout.acctOwnerOff, base + layout.acctOwnerOff + 32)),
    feeCredits: readI128LE(data, base + feeCreditsOff),
    lastFeeSlot: readU64LE(data, base + lastFeeSlotOff)
  };
}
function parseAllAccounts(data) {
  const indices = parseUsedIndices(data);
  const maxIdx = maxAccountIndex(data.length);
  const validIndices = indices.filter((idx) => idx < maxIdx);
  const droppedCount = indices.length - validIndices.length;
  if (droppedCount > 0) {
    console.warn(
      `[parseAllAccounts] bitmap claims ${indices.length} used accounts but only ${maxIdx} fit in the slab \u2014 ${droppedCount} out-of-bounds indices dropped (possible bitmap corruption)`
    );
  }
  return validIndices.map((idx) => ({
    idx,
    account: parseAccount(data, idx)
  }));
}

// src/solana/pda.ts
import { PublicKey as PublicKey4 } from "@solana/web3.js";
var textEncoder = new TextEncoder();
function deriveVaultAuthority(programId, slab) {
  return PublicKey4.findProgramAddressSync(
    [textEncoder.encode("vault"), slab.toBytes()],
    programId
  );
}
function deriveInsuranceLpMint(programId, slab) {
  return PublicKey4.findProgramAddressSync(
    [textEncoder.encode("ins_lp"), slab.toBytes()],
    programId
  );
}
var LP_INDEX_U16_MAX = 65535;
function deriveLpPda(programId, slab, lpIdx) {
  if (typeof lpIdx !== "number" || !Number.isInteger(lpIdx) || lpIdx < 0 || lpIdx > LP_INDEX_U16_MAX) {
    throw new Error(
      `deriveLpPda: lpIdx must be an integer in [0, ${LP_INDEX_U16_MAX}], got ${lpIdx}`
    );
  }
  const idxBuf = new Uint8Array(2);
  new DataView(idxBuf.buffer).setUint16(0, lpIdx, true);
  return PublicKey4.findProgramAddressSync(
    [textEncoder.encode("lp"), slab.toBytes(), idxBuf],
    programId
  );
}
function deriveKeeperFund(programId, slab) {
  return PublicKey4.findProgramAddressSync(
    [textEncoder.encode("keeper_fund"), slab.toBytes()],
    programId
  );
}
var PUMPSWAP_PROGRAM_ID = new PublicKey4(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);
var RAYDIUM_CLMM_PROGRAM_ID = new PublicKey4(
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"
);
var METEORA_DLMM_PROGRAM_ID = new PublicKey4(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
);
var PYTH_PUSH_ORACLE_PROGRAM_ID = new PublicKey4(
  "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT"
);
var CREATOR_LOCK_SEED = "creator_lock";
function deriveCreatorLockPda(programId, slab) {
  return PublicKey4.findProgramAddressSync(
    [textEncoder.encode(CREATOR_LOCK_SEED), slab.toBytes()],
    programId
  );
}
function normalizePythFeedIdHex(feedIdHex) {
  let s = feedIdHex.trim();
  if (s.startsWith("0x") || s.startsWith("0X")) {
    s = s.slice(2);
  }
  return s;
}
var FEED_HEX_RE = /^[0-9a-fA-F]{64}$/;
function derivePythPushOraclePDA(feedIdHex) {
  const normalized = normalizePythFeedIdHex(feedIdHex);
  if (!FEED_HEX_RE.test(normalized)) {
    throw new Error(
      `derivePythPushOraclePDA: feedIdHex must be 64 hex digits (32 bytes); got ${normalized.length === 64 ? "non-hexadecimal characters" : normalized.length + " chars"}`
    );
  }
  const feedId = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    feedId[i] = parseInt(normalized.substring(i * 2, i * 2 + 2), 16);
  }
  const shardBuf = new Uint8Array(2);
  return PublicKey4.findProgramAddressSync(
    [shardBuf, feedId],
    PYTH_PUSH_ORACLE_PROGRAM_ID
  );
}

// src/solana/ata.ts
import {
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_PROGRAM_ID as TOKEN_PROGRAM_ID2
} from "@solana/spl-token";
async function getAta(owner, mint, allowOwnerOffCurve = false, tokenProgramId = TOKEN_PROGRAM_ID2) {
  return getAssociatedTokenAddress(mint, owner, allowOwnerOffCurve, tokenProgramId);
}
function getAtaSync(owner, mint, allowOwnerOffCurve = false, tokenProgramId = TOKEN_PROGRAM_ID2) {
  return getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve, tokenProgramId);
}
async function fetchTokenAccount(connection, address, tokenProgramId = TOKEN_PROGRAM_ID2) {
  return getAccount(connection, address, void 0, tokenProgramId);
}

// src/solana/discovery.ts
import { PublicKey as PublicKey6 } from "@solana/web3.js";

// src/solana/static-markets.ts
import { PublicKey as PublicKey5 } from "@solana/web3.js";
var MAINNET_MARKETS = [
  { slabAddress: "CBMzT1jxdmFnhT9UiHbgDkFhdsCuKwYSGXxcE8NnFFBn", symbol: "SOL-PERP", name: "SOL/USDC Perpetual" }
];
var DEVNET_MARKETS = [
  // Populated from prior discoverMarkets() runs on devnet.
  // These serve as the tier-3 safety net for devnet users.
];
var STATIC_REGISTRY = {
  mainnet: MAINNET_MARKETS,
  devnet: DEVNET_MARKETS
};
var USER_MARKETS = {
  mainnet: [],
  devnet: []
};
function getStaticMarkets(network) {
  const builtin = STATIC_REGISTRY[network] ?? [];
  const user = USER_MARKETS[network] ?? [];
  if (user.length === 0) return [...builtin];
  const seen = /* @__PURE__ */ new Map();
  for (const entry of builtin) {
    seen.set(entry.slabAddress, entry);
  }
  for (const entry of user) {
    seen.set(entry.slabAddress, entry);
  }
  return [...seen.values()];
}
function registerStaticMarkets(network, entries) {
  const existing = USER_MARKETS[network];
  const seen = new Set(existing.map((e) => e.slabAddress));
  for (const entry of entries) {
    if (!entry.slabAddress) continue;
    if (seen.has(entry.slabAddress)) continue;
    try {
      new PublicKey5(entry.slabAddress);
    } catch {
      console.warn(
        `[registerStaticMarkets] Skipping invalid slabAddress: ${entry.slabAddress}`
      );
      continue;
    }
    seen.add(entry.slabAddress);
    existing.push(entry);
  }
}
function clearStaticMarkets(network) {
  if (network) {
    USER_MARKETS[network] = [];
  } else {
    USER_MARKETS.mainnet = [];
    USER_MARKETS.devnet = [];
  }
}

// src/solana/discovery.ts
var ENGINE_BITMAP_OFF_V0 = 320;
var MAGIC_BYTES = new Uint8Array([84, 65, 76, 79, 67, 82, 69, 80]);
var SLAB_TIERS = {
  micro: SLAB_TIERS_V12_1["micro"],
  small: SLAB_TIERS_V12_1["small"],
  medium: SLAB_TIERS_V12_1["medium"],
  large: SLAB_TIERS_V12_1["large"]
};
var SLAB_TIERS_V0 = {
  small: { maxAccounts: 256, dataSize: 62808, label: "Small", description: "256 slots \xB7 ~0.44 SOL" },
  medium: { maxAccounts: 1024, dataSize: 248760, label: "Medium", description: "1,024 slots \xB7 ~1.73 SOL" },
  large: { maxAccounts: 4096, dataSize: 992568, label: "Large", description: "4,096 slots \xB7 ~6.90 SOL" }
};
var SLAB_TIERS_V1D = {
  micro: { maxAccounts: 64, dataSize: 17064, label: "Micro", description: "64 slots (V1D devnet)" },
  small: { maxAccounts: 256, dataSize: 65088, label: "Small", description: "256 slots (V1D devnet)" },
  medium: { maxAccounts: 1024, dataSize: 257184, label: "Medium", description: "1,024 slots (V1D devnet)" },
  large: { maxAccounts: 4096, dataSize: 1025568, label: "Large", description: "4,096 slots (V1D devnet)" }
};
var SLAB_TIERS_V1D_LEGACY = {
  micro: { maxAccounts: 64, dataSize: 17080, label: "Micro", description: "64 slots (V1D legacy, postBitmap=18)" },
  small: { maxAccounts: 256, dataSize: 65104, label: "Small", description: "256 slots (V1D legacy, postBitmap=18)" },
  medium: { maxAccounts: 1024, dataSize: 257200, label: "Medium", description: "1,024 slots (V1D legacy, postBitmap=18)" },
  large: { maxAccounts: 4096, dataSize: 1025584, label: "Large", description: "4,096 slots (V1D legacy, postBitmap=18)" }
};
var SLAB_TIERS_V1 = SLAB_TIERS;
var SLAB_TIERS_V_ADL_DISCOVERY = SLAB_TIERS_V_ADL;
function slabDataSize(maxAccounts) {
  const ENGINE_OFF_V0 = 480;
  const ENGINE_BITMAP_OFF_V02 = 320;
  const ACCOUNT_SIZE_V0 = 240;
  const bitmapBytes = Math.ceil(maxAccounts / 64) * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = ENGINE_BITMAP_OFF_V02 + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOff = Math.ceil(preAccountsLen / 8) * 8;
  return ENGINE_OFF_V0 + accountsOff + maxAccounts * ACCOUNT_SIZE_V0;
}
function slabDataSizeV1(maxAccounts) {
  const ENGINE_OFF_V1 = 640;
  const ENGINE_BITMAP_OFF_V1 = 656;
  const ACCOUNT_SIZE_V1 = 248;
  const bitmapBytes = Math.ceil(maxAccounts / 64) * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = ENGINE_BITMAP_OFF_V1 + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOff = Math.ceil(preAccountsLen / 8) * 8;
  return ENGINE_OFF_V1 + accountsOff + maxAccounts * ACCOUNT_SIZE_V1;
}
function validateSlabTierMatch(dataSize, programSlabLen) {
  return dataSize === programSlabLen;
}
var ALL_SLAB_SIZES = [
  ...Object.values(SLAB_TIERS).map((t) => t.dataSize),
  ...Object.values(SLAB_TIERS_V0).map((t) => t.dataSize),
  ...Object.values(SLAB_TIERS_V1D).map((t) => t.dataSize),
  ...Object.values(SLAB_TIERS_V1D_LEGACY).map((t) => t.dataSize),
  ...Object.values(SLAB_TIERS_V1M).map((t) => t.dataSize),
  ...Object.values(SLAB_TIERS_V_ADL).map((t) => t.dataSize)
];
var SLAB_DATA_SIZE = SLAB_TIERS.large.dataSize;
var HEADER_SLICE_LENGTH = 1940;
function dv2(data) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}
function readU16LE2(data, off) {
  return dv2(data).getUint16(off, true);
}
function readU64LE2(data, off) {
  return dv2(data).getBigUint64(off, true);
}
function readI64LE2(data, off) {
  return dv2(data).getBigInt64(off, true);
}
function readU128LE2(buf, offset) {
  const lo = readU64LE2(buf, offset);
  const hi = readU64LE2(buf, offset + 8);
  return hi << 64n | lo;
}
function readI128LE2(buf, offset) {
  const lo = readU64LE2(buf, offset);
  const hi = readU64LE2(buf, offset + 8);
  const unsigned = hi << 64n | lo;
  const SIGN_BIT = 1n << 127n;
  if (unsigned >= SIGN_BIT) return unsigned - (1n << 128n);
  return unsigned;
}
function parseEngineLight(data, layout, maxAccounts = 4096) {
  const isV0 = !layout || layout.version === 0;
  const base = layout ? layout.engineOff : 480;
  const bitmapOff = layout ? layout.engineBitmapOff : ENGINE_BITMAP_OFF_V0;
  const minLen = base + bitmapOff;
  if (data.length < minLen) {
    throw new Error(`Slab data too short for engine light parse: ${data.length} < ${minLen}`);
  }
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const numUsedOff = bitmapOff + bitmapWords * 8;
  const nextAccountIdOff = Math.ceil((numUsedOff + 2) / 8) * 8;
  const canReadNumUsed = data.length >= base + numUsedOff + 2;
  const canReadNextId = data.length >= base + nextAccountIdOff + 8;
  if (isV0) {
    return {
      vault: readU128LE2(data, base + 0),
      insuranceFund: {
        balance: readU128LE2(data, base + 16),
        feeRevenue: readU128LE2(data, base + 32),
        isolatedBalance: 0n,
        isolationBps: 0
      },
      currentSlot: readU64LE2(data, base + 104),
      fundingIndexQpbE6: readI128LE2(data, base + 112),
      lastFundingSlot: readU64LE2(data, base + 128),
      fundingRateBpsPerSlotLast: readI64LE2(data, base + 136),
      lastCrankSlot: readU64LE2(data, base + 144),
      maxCrankStalenessSlots: readU64LE2(data, base + 152),
      totalOpenInterest: readU128LE2(data, base + 160),
      longOi: 0n,
      shortOi: 0n,
      cTot: readU128LE2(data, base + 176),
      pnlPosTot: readU128LE2(data, base + 192),
      liqCursor: readU16LE2(data, base + 208),
      gcCursor: readU16LE2(data, base + 210),
      lastSweepStartSlot: readU64LE2(data, base + 216),
      lastSweepCompleteSlot: readU64LE2(data, base + 224),
      crankCursor: readU16LE2(data, base + 232),
      sweepStartIdx: readU16LE2(data, base + 234),
      lifetimeLiquidations: readU64LE2(data, base + 240),
      lifetimeForceCloses: readU64LE2(data, base + 248),
      netLpPos: readI128LE2(data, base + 256),
      lpSumAbs: readU128LE2(data, base + 272),
      lpMaxAbs: readU128LE2(data, base + 288),
      lpMaxAbsSweep: 0n,
      emergencyOiMode: false,
      emergencyStartSlot: 0n,
      lastBreakerSlot: 0n,
      markPriceE6: 0n,
      // V0 engine has no mark_price field
      numUsedAccounts: canReadNumUsed ? readU16LE2(data, base + numUsedOff) : 0,
      nextAccountId: canReadNextId ? readU64LE2(data, base + nextAccountIdOff) : 0n
    };
  }
  const isV2 = layout?.version === 2;
  if (isV2) {
    return {
      vault: readU128LE2(data, base + 0),
      insuranceFund: {
        balance: readU128LE2(data, base + 16),
        feeRevenue: readU128LE2(data, base + 32),
        isolatedBalance: readU128LE2(data, base + 48),
        isolationBps: readU16LE2(data, base + 64)
      },
      currentSlot: readU64LE2(data, base + 352),
      fundingIndexQpbE6: readI128LE2(data, base + 360),
      lastFundingSlot: readU64LE2(data, base + 376),
      fundingRateBpsPerSlotLast: readI64LE2(data, base + 384),
      lastCrankSlot: readU64LE2(data, base + 392),
      maxCrankStalenessSlots: readU64LE2(data, base + 400),
      totalOpenInterest: readU128LE2(data, base + 408),
      longOi: 0n,
      // V2 has no long_oi
      shortOi: 0n,
      // V2 has no short_oi
      cTot: readU128LE2(data, base + 424),
      pnlPosTot: readU128LE2(data, base + 440),
      liqCursor: readU16LE2(data, base + 456),
      gcCursor: readU16LE2(data, base + 458),
      lastSweepStartSlot: readU64LE2(data, base + 464),
      lastSweepCompleteSlot: readU64LE2(data, base + 472),
      crankCursor: readU16LE2(data, base + 480),
      sweepStartIdx: readU16LE2(data, base + 482),
      lifetimeLiquidations: readU64LE2(data, base + 488),
      lifetimeForceCloses: readU64LE2(data, base + 496),
      netLpPos: readI128LE2(data, base + 504),
      lpSumAbs: readU128LE2(data, base + 520),
      lpMaxAbs: readU128LE2(data, base + 536),
      lpMaxAbsSweep: readU128LE2(data, base + 552),
      emergencyOiMode: false,
      // V2 has no emergency OI fields
      emergencyStartSlot: 0n,
      lastBreakerSlot: 0n,
      markPriceE6: 0n,
      // V2 has no mark_price
      numUsedAccounts: canReadNumUsed ? readU16LE2(data, base + numUsedOff) : 0,
      nextAccountId: canReadNextId ? readU64LE2(data, base + nextAccountIdOff) : 0n
    };
  }
  const isVAdl = layout !== null && layout.engineOff === 624 && layout.accountSize === 312;
  if (isVAdl) {
    const l = layout;
    return {
      vault: readU128LE2(data, base + 0),
      insuranceFund: {
        balance: readU128LE2(data, base + l.engineInsuranceOff),
        feeRevenue: readU128LE2(data, base + l.engineInsuranceOff + 16),
        isolatedBalance: readU128LE2(data, base + l.engineInsuranceIsolatedOff),
        isolationBps: readU16LE2(data, base + l.engineInsuranceIsolationBpsOff)
      },
      currentSlot: readU64LE2(data, base + l.engineCurrentSlotOff),
      fundingIndexQpbE6: readI128LE2(data, base + l.engineFundingIndexOff),
      lastFundingSlot: readU64LE2(data, base + l.engineLastFundingSlotOff),
      fundingRateBpsPerSlotLast: readI64LE2(data, base + l.engineFundingRateBpsOff),
      lastCrankSlot: readU64LE2(data, base + l.engineLastCrankSlotOff),
      maxCrankStalenessSlots: readU64LE2(data, base + l.engineMaxCrankStalenessOff),
      totalOpenInterest: readU128LE2(data, base + l.engineTotalOiOff),
      longOi: l.engineLongOiOff >= 0 ? readU128LE2(data, base + l.engineLongOiOff) : 0n,
      shortOi: l.engineShortOiOff >= 0 ? readU128LE2(data, base + l.engineShortOiOff) : 0n,
      cTot: readU128LE2(data, base + l.engineCTotOff),
      pnlPosTot: readU128LE2(data, base + l.enginePnlPosTotOff),
      liqCursor: readU16LE2(data, base + l.engineLiqCursorOff),
      gcCursor: readU16LE2(data, base + l.engineGcCursorOff),
      lastSweepStartSlot: readU64LE2(data, base + l.engineLastSweepStartOff),
      lastSweepCompleteSlot: readU64LE2(data, base + l.engineLastSweepCompleteOff),
      crankCursor: readU16LE2(data, base + l.engineCrankCursorOff),
      sweepStartIdx: readU16LE2(data, base + l.engineSweepStartIdxOff),
      lifetimeLiquidations: readU64LE2(data, base + l.engineLifetimeLiquidationsOff),
      lifetimeForceCloses: readU64LE2(data, base + l.engineLifetimeForceClosesOff),
      netLpPos: readI128LE2(data, base + l.engineNetLpPosOff),
      lpSumAbs: readU128LE2(data, base + l.engineLpSumAbsOff),
      lpMaxAbs: readU128LE2(data, base + l.engineLpMaxAbsOff),
      lpMaxAbsSweep: readU128LE2(data, base + l.engineLpMaxAbsSweepOff),
      emergencyOiMode: l.engineEmergencyOiModeOff >= 0 ? data[base + l.engineEmergencyOiModeOff] !== 0 : false,
      emergencyStartSlot: l.engineEmergencyStartSlotOff >= 0 ? readU64LE2(data, base + l.engineEmergencyStartSlotOff) : 0n,
      lastBreakerSlot: l.engineLastBreakerSlotOff >= 0 ? readU64LE2(data, base + l.engineLastBreakerSlotOff) : 0n,
      markPriceE6: l.engineMarkPriceOff >= 0 ? readU64LE2(data, base + l.engineMarkPriceOff) : 0n,
      numUsedAccounts: canReadNumUsed ? readU16LE2(data, base + numUsedOff) : 0,
      nextAccountId: canReadNextId ? readU64LE2(data, base + nextAccountIdOff) : 0n
    };
  }
  return {
    vault: readU128LE2(data, base + 0),
    insuranceFund: {
      balance: readU128LE2(data, base + 16),
      feeRevenue: readU128LE2(data, base + 32),
      isolatedBalance: readU128LE2(data, base + 48),
      isolationBps: readU16LE2(data, base + 64)
    },
    currentSlot: readU64LE2(data, base + 360),
    // PERC-1094: params end at 72+288=360 (was 352)
    fundingIndexQpbE6: readI128LE2(data, base + 368),
    lastFundingSlot: readU64LE2(data, base + 384),
    fundingRateBpsPerSlotLast: readI64LE2(data, base + 392),
    lastCrankSlot: readU64LE2(data, base + 424),
    maxCrankStalenessSlots: readU64LE2(data, base + 408),
    totalOpenInterest: readU128LE2(data, base + 416),
    longOi: readU128LE2(data, base + 432),
    shortOi: readU128LE2(data, base + 448),
    cTot: readU128LE2(data, base + 464),
    pnlPosTot: readU128LE2(data, base + 480),
    liqCursor: readU16LE2(data, base + 496),
    gcCursor: readU16LE2(data, base + 498),
    lastSweepStartSlot: readU64LE2(data, base + 504),
    lastSweepCompleteSlot: readU64LE2(data, base + 512),
    crankCursor: readU16LE2(data, base + 520),
    sweepStartIdx: readU16LE2(data, base + 522),
    lifetimeLiquidations: readU64LE2(data, base + 528),
    lifetimeForceCloses: readU64LE2(data, base + 536),
    netLpPos: readI128LE2(data, base + 544),
    lpSumAbs: readU128LE2(data, base + 560),
    lpMaxAbs: readU128LE2(data, base + 576),
    lpMaxAbsSweep: readU128LE2(data, base + 592),
    emergencyOiMode: data[base + 608] !== 0,
    emergencyStartSlot: readU64LE2(data, base + 616),
    lastBreakerSlot: readU64LE2(data, base + 624),
    markPriceE6: readU64LE2(data, base + 400),
    // PERC-1094: was 392
    numUsedAccounts: canReadNumUsed ? readU16LE2(data, base + numUsedOff) : 0,
    nextAccountId: canReadNextId ? readU64LE2(data, base + nextAccountIdOff) : 0n
  };
}
function isRateLimitError(err) {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("429") || msg.toLowerCase().includes("rate limit") || msg.toLowerCase().includes("too many requests");
}
function withJitter(delayMs) {
  return delayMs + Math.floor(Math.random() * delayMs * 0.25);
}
async function discoverMarkets(connection, programId, options = {}) {
  const {
    sequential = false,
    interTierDelayMs = 200,
    rateLimitBackoffMs = [1e3, 3e3, 9e3, 27e3],
    maxParallelTiers = 6
  } = options;
  const ALL_TIERS = [
    ...Object.values(SLAB_TIERS),
    ...Object.values(SLAB_TIERS_V0),
    ...Object.values(SLAB_TIERS_V1D),
    ...Object.values(SLAB_TIERS_V1D_LEGACY),
    ...Object.values(SLAB_TIERS_V2),
    ...Object.values(SLAB_TIERS_V1M),
    ...Object.values(SLAB_TIERS_V_ADL)
  ];
  let rawAccounts = [];
  async function fetchTierWithRetry(tier) {
    for (let attempt = 0; attempt <= rateLimitBackoffMs.length; attempt++) {
      try {
        const results = await connection.getProgramAccounts(programId, {
          filters: [{ dataSize: tier.dataSize }],
          dataSlice: { offset: 0, length: HEADER_SLICE_LENGTH }
        });
        return results.map((entry) => ({ ...entry, maxAccounts: tier.maxAccounts, dataSize: tier.dataSize }));
      } catch (err) {
        if (isRateLimitError(err) && attempt < rateLimitBackoffMs.length) {
          const delay = withJitter(rateLimitBackoffMs[attempt]);
          console.warn(
            `[discoverMarkets] 429 on tier dataSize=${tier.dataSize} attempt=${attempt + 1}, backing off ${delay}ms`
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        console.warn(
          `[discoverMarkets] Tier query failed (dataSize=${tier.dataSize}, attempt=${attempt + 1}):`,
          err instanceof Error ? err.message : err
        );
        return [];
      }
    }
    return [];
  }
  const maxTierQueries = options.maxTierQueries ?? ALL_TIERS.length;
  const tiersToQuery = ALL_TIERS.slice(0, maxTierQueries);
  const effectiveMaxParallelTiers = Math.max(1, Number.isFinite(maxParallelTiers) ? maxParallelTiers : 6);
  try {
    if (sequential) {
      for (let i = 0; i < tiersToQuery.length; i++) {
        const tier = tiersToQuery[i];
        const entries = await fetchTierWithRetry(tier);
        rawAccounts.push(...entries);
        if (i < tiersToQuery.length - 1) {
          await new Promise((r) => setTimeout(r, interTierDelayMs));
        }
      }
    } else {
      for (let offset = 0; offset < tiersToQuery.length; offset += effectiveMaxParallelTiers) {
        const chunk = tiersToQuery.slice(offset, offset + effectiveMaxParallelTiers);
        const queries = chunk.map(
          (tier) => connection.getProgramAccounts(programId, {
            filters: [{ dataSize: tier.dataSize }],
            dataSlice: { offset: 0, length: HEADER_SLICE_LENGTH }
          }).then(
            (results2) => results2.map((entry) => ({
              ...entry,
              maxAccounts: tier.maxAccounts,
              dataSize: tier.dataSize
            }))
          )
        );
        const results = await Promise.allSettled(queries);
        for (const result of results) {
          if (result.status === "fulfilled") {
            for (const entry of result.value) {
              rawAccounts.push(entry);
            }
          } else {
            console.warn(
              "[discoverMarkets] Tier query rejected:",
              result.reason instanceof Error ? result.reason.message : result.reason
            );
          }
        }
      }
    }
    if (rawAccounts.length === 0) {
      console.warn("[discoverMarkets] dataSize filters returned 0 markets, falling back to memcmp");
      const fallback = await connection.getProgramAccounts(programId, {
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: "F6P2QNqpQV5"
              // base58 of TALOCREP (u64 LE magic)
            }
          }
        ],
        dataSlice: { offset: 0, length: HEADER_SLICE_LENGTH }
      });
      rawAccounts = [...fallback].map((e) => ({ ...e, maxAccounts: 4096, dataSize: SLAB_TIERS.large.dataSize }));
    }
  } catch (err) {
    console.warn(
      "[discoverMarkets] dataSize filters failed, falling back to memcmp:",
      err instanceof Error ? err.message : err
    );
    try {
      const fallback = await connection.getProgramAccounts(programId, {
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: "F6P2QNqpQV5"
              // base58 of TALOCREP (u64 LE magic)
            }
          }
        ],
        dataSlice: { offset: 0, length: HEADER_SLICE_LENGTH }
      });
      rawAccounts = [...fallback].map((e) => ({ ...e, maxAccounts: 4096, dataSize: SLAB_TIERS.large.dataSize }));
    } catch (memcmpErr) {
      console.warn(
        "[discoverMarkets] memcmp fallback also failed:",
        memcmpErr instanceof Error ? memcmpErr.message : memcmpErr
      );
    }
  }
  if (rawAccounts.length === 0 && options.apiBaseUrl) {
    console.warn(
      "[discoverMarkets] RPC discovery returned 0 markets, falling back to REST API"
    );
    try {
      const apiResult = await discoverMarketsViaApi(
        connection,
        programId,
        options.apiBaseUrl,
        { timeoutMs: options.apiTimeoutMs }
      );
      if (apiResult.length > 0) {
        return apiResult;
      }
      console.warn(
        "[discoverMarkets] REST API returned 0 markets, checking tier-3 static bundle"
      );
    } catch (apiErr) {
      console.warn(
        "[discoverMarkets] API fallback also failed:",
        apiErr instanceof Error ? apiErr.message : apiErr
      );
    }
  }
  if (rawAccounts.length === 0 && options.network) {
    const staticEntries = getStaticMarkets(options.network);
    if (staticEntries.length > 0) {
      console.warn(
        `[discoverMarkets] Tier 1+2 failed, falling back to static bundle (${staticEntries.length} addresses for ${options.network})`
      );
      try {
        return await discoverMarketsViaStaticBundle(
          connection,
          programId,
          staticEntries
        );
      } catch (staticErr) {
        console.warn(
          "[discoverMarkets] Static bundle fallback also failed:",
          staticErr instanceof Error ? staticErr.message : staticErr
        );
      }
    } else {
      console.warn(
        `[discoverMarkets] Static bundle has 0 entries for ${options.network} \u2014 skipping tier 3`
      );
    }
  }
  const accounts = rawAccounts;
  const markets = [];
  const seenPubkeys = /* @__PURE__ */ new Set();
  for (const { pubkey, account, maxAccounts, dataSize } of accounts) {
    const pkStr = pubkey.toBase58();
    if (seenPubkeys.has(pkStr)) continue;
    seenPubkeys.add(pkStr);
    const data = new Uint8Array(account.data);
    let valid = true;
    for (let i = 0; i < MAGIC_BYTES.length; i++) {
      if (data[i] !== MAGIC_BYTES[i]) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;
    const layout = detectSlabLayout(dataSize, data);
    if (!layout) {
      console.warn(
        `[discoverMarkets] Skipping account ${pkStr}: unrecognized layout for dataSize=${dataSize}`
      );
      continue;
    }
    try {
      const header = parseHeader(data);
      const config = parseConfig(data, layout);
      const engine = parseEngineLight(data, layout, maxAccounts);
      const params = parseParams(data, layout);
      markets.push({ slabAddress: pubkey, programId, header, config, engine, params });
    } catch (err) {
      console.warn(
        `[discoverMarkets] Failed to parse account ${pubkey.toBase58()}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return markets;
}
async function getMarketsByAddress(connection, programId, addresses, options = {}) {
  if (addresses.length === 0) return [];
  const {
    batchSize = 100,
    interBatchDelayMs = 0
  } = options;
  const effectiveBatchSize = Math.max(1, Math.min(batchSize, 100));
  const fetched = [];
  for (let offset = 0; offset < addresses.length; offset += effectiveBatchSize) {
    const batch = addresses.slice(offset, offset + effectiveBatchSize);
    const response = await connection.getMultipleAccountsInfo(batch);
    for (let i = 0; i < batch.length; i++) {
      const info = response[i];
      if (info && info.data) {
        if (!info.owner.equals(programId)) {
          console.warn(
            `[getMarketsByAddress] Skipping ${batch[i].toBase58()}: owner mismatch (expected ${programId.toBase58()}, got ${info.owner.toBase58()})`
          );
          continue;
        }
        fetched.push({ pubkey: batch[i], data: info.data });
      }
    }
    if (interBatchDelayMs > 0 && offset + effectiveBatchSize < addresses.length) {
      await new Promise((r) => setTimeout(r, interBatchDelayMs));
    }
  }
  const markets = [];
  for (const entry of fetched) {
    if (!entry) continue;
    const { pubkey, data: rawData } = entry;
    const data = new Uint8Array(rawData);
    let valid = true;
    for (let i = 0; i < MAGIC_BYTES.length; i++) {
      if (data[i] !== MAGIC_BYTES[i]) {
        valid = false;
        break;
      }
    }
    if (!valid) {
      console.warn(
        `[getMarketsByAddress] Skipping ${pubkey.toBase58()}: invalid magic bytes`
      );
      continue;
    }
    const layout = detectSlabLayout(data.length, data);
    if (!layout) {
      console.warn(
        `[getMarketsByAddress] Skipping ${pubkey.toBase58()}: unrecognized layout for dataSize=${data.length}`
      );
      continue;
    }
    try {
      const header = parseHeader(data);
      const config = parseConfig(data, layout);
      const engine = parseEngineLight(data, layout, layout.maxAccounts);
      const params = parseParams(data, layout);
      markets.push({ slabAddress: pubkey, programId, header, config, engine, params });
    } catch (err) {
      console.warn(
        `[getMarketsByAddress] Failed to parse account ${pubkey.toBase58()}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return markets;
}
async function discoverMarketsViaApi(connection, programId, apiBaseUrl, options = {}) {
  const { timeoutMs = 1e4, onChainOptions } = options;
  const base = apiBaseUrl.replace(/\/+$/, "");
  const url = `${base}/markets`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(
      `[discoverMarketsViaApi] API returned ${response.status} ${response.statusText} from ${url}`
    );
  }
  const body = await response.json();
  const apiMarkets = body.markets;
  if (!Array.isArray(apiMarkets) || apiMarkets.length === 0) {
    console.warn("[discoverMarketsViaApi] API returned 0 markets");
    return [];
  }
  const addresses = [];
  for (const entry of apiMarkets) {
    if (!entry.slab_address || typeof entry.slab_address !== "string") continue;
    try {
      addresses.push(new PublicKey6(entry.slab_address));
    } catch {
      console.warn(
        `[discoverMarketsViaApi] Skipping invalid slab address: ${entry.slab_address}`
      );
    }
  }
  if (addresses.length === 0) {
    console.warn("[discoverMarketsViaApi] No valid slab addresses from API");
    return [];
  }
  console.log(
    `[discoverMarketsViaApi] API returned ${addresses.length} slab addresses, fetching on-chain data`
  );
  return getMarketsByAddress(connection, programId, addresses, onChainOptions);
}
async function discoverMarketsViaStaticBundle(connection, programId, entries, options = {}) {
  if (entries.length === 0) return [];
  const addresses = [];
  for (const entry of entries) {
    if (!entry.slabAddress || typeof entry.slabAddress !== "string") continue;
    try {
      addresses.push(new PublicKey6(entry.slabAddress));
    } catch {
      console.warn(
        `[discoverMarketsViaStaticBundle] Skipping invalid slab address: ${entry.slabAddress}`
      );
    }
  }
  if (addresses.length === 0) {
    console.warn("[discoverMarketsViaStaticBundle] No valid slab addresses in static bundle");
    return [];
  }
  console.log(
    `[discoverMarketsViaStaticBundle] Fetching ${addresses.length} slab addresses on-chain`
  );
  return getMarketsByAddress(connection, programId, addresses, options.onChainOptions);
}

// src/solana/dex-oracle.ts
import { PublicKey as PublicKey7 } from "@solana/web3.js";
function detectDexType(ownerProgramId) {
  if (ownerProgramId.equals(PUMPSWAP_PROGRAM_ID)) return "pumpswap";
  if (ownerProgramId.equals(RAYDIUM_CLMM_PROGRAM_ID)) return "raydium-clmm";
  if (ownerProgramId.equals(METEORA_DLMM_PROGRAM_ID)) return "meteora-dlmm";
  return null;
}
function parseDexPool(dexType, poolAddress, data) {
  switch (dexType) {
    case "pumpswap":
      return parsePumpSwapPool(poolAddress, data);
    case "raydium-clmm":
      return parseRaydiumClmmPool(poolAddress, data);
    case "meteora-dlmm":
      return parseMeteoraPool(poolAddress, data);
  }
}
function computeDexSpotPriceE6(dexType, data, vaultData) {
  switch (dexType) {
    case "pumpswap":
      if (!vaultData) throw new Error("PumpSwap requires vaultData (base and quote vault accounts)");
      return computePumpSwapPriceE6(data, vaultData);
    case "raydium-clmm":
      return computeRaydiumClmmPriceE6(data);
    case "meteora-dlmm":
      return computeMeteoraDlmmPriceE6(data);
  }
}
var PUMPSWAP_MIN_LEN = 195;
function parsePumpSwapPool(poolAddress, data) {
  if (data.length < PUMPSWAP_MIN_LEN) {
    throw new Error(`PumpSwap pool data too short: ${data.length} < ${PUMPSWAP_MIN_LEN}`);
  }
  return {
    dexType: "pumpswap",
    poolAddress,
    baseMint: new PublicKey7(data.slice(35, 67)),
    quoteMint: new PublicKey7(data.slice(67, 99)),
    baseVault: new PublicKey7(data.slice(131, 163)),
    quoteVault: new PublicKey7(data.slice(163, 195))
  };
}
var SPL_TOKEN_AMOUNT_MIN_LEN = 72;
function computePumpSwapPriceE6(_poolData, vaultData) {
  if (vaultData.base.length < SPL_TOKEN_AMOUNT_MIN_LEN) {
    throw new Error(`PumpSwap base vault data too short: ${vaultData.base.length} < ${SPL_TOKEN_AMOUNT_MIN_LEN}`);
  }
  if (vaultData.quote.length < SPL_TOKEN_AMOUNT_MIN_LEN) {
    throw new Error(`PumpSwap quote vault data too short: ${vaultData.quote.length} < ${SPL_TOKEN_AMOUNT_MIN_LEN}`);
  }
  const baseDv = new DataView(vaultData.base.buffer, vaultData.base.byteOffset, vaultData.base.byteLength);
  const quoteDv = new DataView(vaultData.quote.buffer, vaultData.quote.byteOffset, vaultData.quote.byteLength);
  const baseAmount = readU64LE3(baseDv, 64);
  const quoteAmount = readU64LE3(quoteDv, 64);
  if (baseAmount === 0n) return 0n;
  return quoteAmount * 1000000n / baseAmount;
}
var RAYDIUM_CLMM_MIN_LEN = 269;
function parseRaydiumClmmPool(poolAddress, data) {
  if (data.length < RAYDIUM_CLMM_MIN_LEN) {
    throw new Error(`Raydium CLMM pool data too short: ${data.length} < ${RAYDIUM_CLMM_MIN_LEN}`);
  }
  return {
    dexType: "raydium-clmm",
    poolAddress,
    baseMint: new PublicKey7(data.slice(73, 105)),
    quoteMint: new PublicKey7(data.slice(105, 137))
  };
}
var MAX_TOKEN_DECIMALS = 24;
function computeRaydiumClmmPriceE6(data) {
  if (data.length < RAYDIUM_CLMM_MIN_LEN) {
    throw new Error(`Raydium CLMM data too short: ${data.length} < ${RAYDIUM_CLMM_MIN_LEN}`);
  }
  const dv3 = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decimals0 = data[233];
  const decimals1 = data[234];
  if (decimals0 > MAX_TOKEN_DECIMALS || decimals1 > MAX_TOKEN_DECIMALS) {
    throw new Error(
      `Raydium CLMM: decimals out of range (${decimals0}, ${decimals1}); max ${MAX_TOKEN_DECIMALS}`
    );
  }
  const sqrtPriceX64 = readU128LE3(dv3, 253);
  if (sqrtPriceX64 === 0n) return 0n;
  const scaledSqrt = sqrtPriceX64 * 1000000n;
  const term = scaledSqrt >> 64n;
  const priceE6Raw = term * sqrtPriceX64 >> 64n;
  const decimalDiff = 6 + decimals0 - decimals1;
  const adjustedDiff = decimalDiff - 6;
  if (adjustedDiff >= 0) {
    const scale = 10n ** BigInt(adjustedDiff);
    return priceE6Raw * scale;
  } else {
    const scale = 10n ** BigInt(-adjustedDiff);
    return priceE6Raw / scale;
  }
}
var METEORA_DLMM_MIN_LEN = 145;
function parseMeteoraPool(poolAddress, data) {
  if (data.length < METEORA_DLMM_MIN_LEN) {
    throw new Error(`Meteora DLMM pool data too short: ${data.length} < ${METEORA_DLMM_MIN_LEN}`);
  }
  return {
    dexType: "meteora-dlmm",
    poolAddress,
    baseMint: new PublicKey7(data.slice(81, 113)),
    quoteMint: new PublicKey7(data.slice(113, 145))
  };
}
var MAX_BIN_STEP = 1e4;
var MAX_ACTIVE_ID_ABS = 5e5;
function computeMeteoraDlmmPriceE6(data) {
  if (data.length < METEORA_DLMM_MIN_LEN) {
    throw new Error(`Meteora DLMM data too short: ${data.length} < ${METEORA_DLMM_MIN_LEN}`);
  }
  const dv3 = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const binStep = dv3.getUint16(73, true);
  const activeId = dv3.getInt32(76, true);
  if (binStep === 0) return 0n;
  if (binStep > MAX_BIN_STEP) {
    throw new Error(`Meteora DLMM: binStep ${binStep} exceeds max ${MAX_BIN_STEP}`);
  }
  if (Math.abs(activeId) > MAX_ACTIVE_ID_ABS) {
    throw new Error(
      `Meteora DLMM: |activeId| ${Math.abs(activeId)} exceeds max ${MAX_ACTIVE_ID_ABS}`
    );
  }
  const SCALE = 1000000000000000000n;
  const base = SCALE + BigInt(binStep) * SCALE / 10000n;
  const isNeg = activeId < 0;
  let exp = isNeg ? BigInt(-activeId) : BigInt(activeId);
  let result = SCALE;
  let b = base;
  while (exp > 0n) {
    if (exp & 1n) {
      result = result * b / SCALE;
    }
    exp >>= 1n;
    if (exp > 0n) {
      b = b * b / SCALE;
    }
  }
  if (isNeg) {
    if (result === 0n) return 0n;
    return SCALE * 1000000n / result;
  } else {
    return result / 1000000000000n;
  }
}
function readU64LE3(dv3, offset) {
  const lo = BigInt(dv3.getUint32(offset, true));
  const hi = BigInt(dv3.getUint32(offset + 4, true));
  return lo | hi << 32n;
}
function readU128LE3(dv3, offset) {
  const lo = readU64LE3(dv3, offset);
  const hi = readU64LE3(dv3, offset + 8);
  return lo | hi << 64n;
}

// src/solana/oracle.ts
var CHAINLINK_MIN_SIZE = 224;
var MAX_DECIMALS = 18;
var CHAINLINK_DECIMALS_OFFSET = 138;
var CHAINLINK_ANSWER_OFFSET = 216;
function readU82(data, off) {
  return data[off];
}
function readBigInt64LE(data, off) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(off, true);
}
function parseChainlinkPrice(data) {
  if (data.length < CHAINLINK_MIN_SIZE) {
    throw new Error(
      `Oracle account data too small: ${data.length} bytes (need at least ${CHAINLINK_MIN_SIZE})`
    );
  }
  const decimals = readU82(data, CHAINLINK_DECIMALS_OFFSET);
  if (decimals > MAX_DECIMALS) {
    throw new Error(
      `Oracle decimals out of range: ${decimals} (max ${MAX_DECIMALS})`
    );
  }
  const price = readBigInt64LE(data, CHAINLINK_ANSWER_OFFSET);
  if (price <= 0n) {
    throw new Error(
      `Oracle price is non-positive: ${price}`
    );
  }
  return { price, decimals };
}
function isValidChainlinkOracle(data) {
  try {
    parseChainlinkPrice(data);
    return true;
  } catch {
    return false;
  }
}

// src/solana/token-program.ts
import { PublicKey as PublicKey8 } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID as TOKEN_PROGRAM_ID3 } from "@solana/spl-token";
var TOKEN_2022_PROGRAM_ID = new PublicKey8(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);
async function detectTokenProgram(connection, mint) {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint account not found: ${mint.toBase58()}`);
  return info.owner;
}
function isToken2022(tokenProgramId) {
  return tokenProgramId.equals(TOKEN_2022_PROGRAM_ID);
}
function isStandardToken(tokenProgramId) {
  return tokenProgramId.equals(TOKEN_PROGRAM_ID3);
}

// src/solana/stake.ts
import { PublicKey as PublicKey10, SystemProgram as SystemProgram2, SYSVAR_RENT_PUBKEY as SYSVAR_RENT_PUBKEY2, SYSVAR_CLOCK_PUBKEY as SYSVAR_CLOCK_PUBKEY2 } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID as TOKEN_PROGRAM_ID4 } from "@solana/spl-token";

// src/config/program-ids.ts
import { PublicKey as PublicKey9 } from "@solana/web3.js";
function safeEnv(key) {
  try {
    return typeof process !== "undefined" && process?.env ? process.env[key] : void 0;
  } catch {
    return void 0;
  }
}
var PROGRAM_IDS = {
  devnet: {
    percolator: "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",
    matcher: "GTRgyTDfrMvBubALAqtHuQwT8tbGyXid7svXZKtWfC9k"
  },
  mainnet: {
    percolator: "GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24",
    matcher: "DHP6DtwXP1yJsz8YzfoeigRFPB979gzmumkmCxDLSkUX"
  }
};
function getProgramId(network) {
  const override = safeEnv("PROGRAM_ID");
  if (override) {
    console.warn(
      `[percolator-sdk] PROGRAM_ID env override active: ${override} \u2014 ensure this points to a trusted program`
    );
    return new PublicKey9(override);
  }
  const detectedNetwork = getCurrentNetwork();
  const targetNetwork = network ?? detectedNetwork;
  const programId = PROGRAM_IDS[targetNetwork].percolator;
  return new PublicKey9(programId);
}
function getMatcherProgramId(network) {
  const override = safeEnv("MATCHER_PROGRAM_ID");
  if (override) {
    console.warn(
      `[percolator-sdk] MATCHER_PROGRAM_ID env override active: ${override} \u2014 ensure this points to a trusted program`
    );
    return new PublicKey9(override);
  }
  const detectedNetwork = getCurrentNetwork();
  const targetNetwork = network ?? detectedNetwork;
  const programId = PROGRAM_IDS[targetNetwork].matcher;
  if (!programId) {
    throw new Error(`Matcher program not deployed on ${targetNetwork}`);
  }
  return new PublicKey9(programId);
}
function getCurrentNetwork() {
  const network = safeEnv("NETWORK")?.toLowerCase();
  if (network === "mainnet" || network === "mainnet-beta") {
    return "mainnet";
  }
  return "devnet";
}

// src/solana/stake.ts
var STAKE_PROGRAM_IDS = {
  devnet: "6aJb1F9CDCVWCNYFwj8aQsVb696YnW6J1FznteHq4Q6k",
  mainnet: "DC5fovFQD5SZYsetwvEqd4Wi4PFY1Yfnc669VMe6oa7F"
};
function getStakeProgramId(network) {
  const override = safeEnv("STAKE_PROGRAM_ID");
  if (override) {
    console.warn(
      `[percolator-sdk] STAKE_PROGRAM_ID env override active: ${override} \u2014 ensure this points to a trusted program`
    );
    return new PublicKey10(override);
  }
  const detectedNetwork = network ?? (() => {
    const n = safeEnv("NEXT_PUBLIC_DEFAULT_NETWORK")?.toLowerCase() ?? safeEnv("NETWORK")?.toLowerCase() ?? "";
    return n === "mainnet" || n === "mainnet-beta" ? "mainnet" : "devnet";
  })();
  const id = STAKE_PROGRAM_IDS[detectedNetwork];
  if (!id) {
    throw new Error(
      `Stake program not deployed on ${detectedNetwork}. Set STAKE_PROGRAM_ID env var or wait for DevOps to deploy and update STAKE_PROGRAM_IDS.mainnet.`
    );
  }
  return new PublicKey10(id);
}
var STAKE_PROGRAM_ID = new PublicKey10(STAKE_PROGRAM_IDS.devnet);
var STAKE_IX = {
  InitPool: 0,
  Deposit: 1,
  Withdraw: 2,
  FlushToInsurance: 3,
  UpdateConfig: 4,
  TransferAdmin: 5,
  AdminSetOracleAuthority: 6,
  AdminSetRiskThreshold: 7,
  AdminSetMaintenanceFee: 8,
  AdminResolveMarket: 9,
  AdminWithdrawInsurance: 10,
  AdminSetInsurancePolicy: 11,
  /** PERC-272: Accrue trading fees to LP vault */
  AccrueFees: 12,
  /** PERC-272: Init pool in trading LP mode */
  InitTradingPool: 13,
  /** PERC-313: Set HWM config (enable + floor bps) */
  AdminSetHwmConfig: 14,
  /** PERC-303: Enable/configure senior-junior LP tranches */
  AdminSetTrancheConfig: 15,
  /** PERC-303: Deposit into junior (first-loss) tranche */
  DepositJunior: 16
};
var TEXT = new TextEncoder();
function deriveStakePool(slab, programId) {
  return PublicKey10.findProgramAddressSync(
    [TEXT.encode("stake_pool"), slab.toBytes()],
    programId ?? getStakeProgramId()
  );
}
function deriveStakeVaultAuth(pool, programId) {
  return PublicKey10.findProgramAddressSync(
    [TEXT.encode("vault_auth"), pool.toBytes()],
    programId ?? getStakeProgramId()
  );
}
function deriveDepositPda(pool, user, programId) {
  return PublicKey10.findProgramAddressSync(
    [TEXT.encode("deposit"), pool.toBytes(), user.toBytes()],
    programId ?? getStakeProgramId()
  );
}
function readU64LE4(data, off) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(
    off,
    /* littleEndian= */
    true
  );
}
function readU16LE3(data, off) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getUint16(
    off,
    /* littleEndian= */
    true
  );
}
function u64Le(v) {
  const big = BigInt(v);
  if (big < 0n) throw new Error(`u64Le: value must be non-negative, got ${big}`);
  if (big > 0xFFFFFFFFFFFFFFFFn) throw new Error(`u64Le: value exceeds u64 max`);
  const arr = new Uint8Array(8);
  new DataView(arr.buffer).setBigUint64(0, big, true);
  return arr;
}
function u128Le(v) {
  const big = BigInt(v);
  if (big < 0n) throw new Error(`u128Le: value must be non-negative, got ${big}`);
  if (big > (1n << 128n) - 1n) throw new Error(`u128Le: value exceeds u128 max`);
  const arr = new Uint8Array(16);
  const view = new DataView(arr.buffer);
  view.setBigUint64(0, big & 0xFFFFFFFFFFFFFFFFn, true);
  view.setBigUint64(8, big >> 64n, true);
  return arr;
}
function u16Le(v) {
  if (v < 0 || v > 65535) throw new Error(`u16Le: value out of u16 range (0..65535), got ${v}`);
  const arr = new Uint8Array(2);
  new DataView(arr.buffer).setUint16(0, v, true);
  return arr;
}
function encodeStakeInitPool(cooldownSlots, depositCap) {
  return concatBytes(
    new Uint8Array([STAKE_IX.InitPool]),
    u64Le(cooldownSlots),
    u64Le(depositCap)
  );
}
function encodeStakeDeposit(amount) {
  return concatBytes(new Uint8Array([STAKE_IX.Deposit]), u64Le(amount));
}
function encodeStakeWithdraw(lpAmount) {
  return concatBytes(new Uint8Array([STAKE_IX.Withdraw]), u64Le(lpAmount));
}
function encodeStakeFlushToInsurance(amount) {
  return concatBytes(new Uint8Array([STAKE_IX.FlushToInsurance]), u64Le(amount));
}
function encodeStakeUpdateConfig(newCooldownSlots, newDepositCap) {
  return concatBytes(
    new Uint8Array([STAKE_IX.UpdateConfig]),
    new Uint8Array([newCooldownSlots != null ? 1 : 0]),
    u64Le(newCooldownSlots ?? 0n),
    new Uint8Array([newDepositCap != null ? 1 : 0]),
    u64Le(newDepositCap ?? 0n)
  );
}
function encodeStakeTransferAdmin() {
  return new Uint8Array([STAKE_IX.TransferAdmin]);
}
function encodeStakeAdminSetOracleAuthority(newAuthority) {
  return concatBytes(
    new Uint8Array([STAKE_IX.AdminSetOracleAuthority]),
    newAuthority.toBytes()
  );
}
function encodeStakeAdminSetRiskThreshold(newThreshold) {
  return concatBytes(
    new Uint8Array([STAKE_IX.AdminSetRiskThreshold]),
    u128Le(newThreshold)
  );
}
function encodeStakeAdminSetMaintenanceFee(newFee) {
  return concatBytes(
    new Uint8Array([STAKE_IX.AdminSetMaintenanceFee]),
    u128Le(newFee)
  );
}
function encodeStakeAdminResolveMarket() {
  return new Uint8Array([STAKE_IX.AdminResolveMarket]);
}
function encodeStakeAdminWithdrawInsurance(amount) {
  return concatBytes(
    new Uint8Array([STAKE_IX.AdminWithdrawInsurance]),
    u64Le(amount)
  );
}
function encodeStakeAccrueFees() {
  return new Uint8Array([STAKE_IX.AccrueFees]);
}
function encodeStakeInitTradingPool(cooldownSlots, depositCap) {
  return concatBytes(
    new Uint8Array([STAKE_IX.InitTradingPool]),
    u64Le(cooldownSlots),
    u64Le(depositCap)
  );
}
function encodeStakeAdminSetHwmConfig(enabled, hwmFloorBps) {
  return concatBytes(
    new Uint8Array([STAKE_IX.AdminSetHwmConfig]),
    new Uint8Array([enabled ? 1 : 0]),
    u16Le(hwmFloorBps)
  );
}
function encodeStakeAdminSetTrancheConfig(juniorFeeMultBps) {
  return concatBytes(
    new Uint8Array([STAKE_IX.AdminSetTrancheConfig]),
    u16Le(juniorFeeMultBps)
  );
}
function encodeStakeDepositJunior(amount) {
  return concatBytes(new Uint8Array([STAKE_IX.DepositJunior]), u64Le(amount));
}
function encodeStakeAdminSetInsurancePolicy(authority, minWithdrawBase, maxWithdrawBps, cooldownSlots) {
  return concatBytes(
    new Uint8Array([STAKE_IX.AdminSetInsurancePolicy]),
    authority.toBytes(),
    u64Le(minWithdrawBase),
    u16Le(maxWithdrawBps),
    u64Le(cooldownSlots)
  );
}
var STAKE_POOL_SIZE = 352;
function decodeStakePool(data) {
  if (data.length < STAKE_POOL_SIZE) {
    throw new Error(`StakePool data too short: ${data.length} < ${STAKE_POOL_SIZE}`);
  }
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let off = 0;
  const isInitialized = bytes[off] === 1;
  off += 1;
  const bump = bytes[off];
  off += 1;
  const vaultAuthorityBump = bytes[off];
  off += 1;
  const adminTransferred = bytes[off] === 1;
  off += 1;
  off += 4;
  const slab = new PublicKey10(bytes.subarray(off, off + 32));
  off += 32;
  const admin = new PublicKey10(bytes.subarray(off, off + 32));
  off += 32;
  const collateralMint = new PublicKey10(bytes.subarray(off, off + 32));
  off += 32;
  const lpMint = new PublicKey10(bytes.subarray(off, off + 32));
  off += 32;
  const vault = new PublicKey10(bytes.subarray(off, off + 32));
  off += 32;
  const totalDeposited = readU64LE4(bytes, off);
  off += 8;
  const totalLpSupply = readU64LE4(bytes, off);
  off += 8;
  const cooldownSlots = readU64LE4(bytes, off);
  off += 8;
  const depositCap = readU64LE4(bytes, off);
  off += 8;
  const totalFlushed = readU64LE4(bytes, off);
  off += 8;
  const totalReturned = readU64LE4(bytes, off);
  off += 8;
  const totalWithdrawn = readU64LE4(bytes, off);
  off += 8;
  const percolatorProgram = new PublicKey10(bytes.subarray(off, off + 32));
  off += 32;
  const totalFeesEarned = readU64LE4(bytes, off);
  off += 8;
  const lastFeeAccrualSlot = readU64LE4(bytes, off);
  off += 8;
  const lastVaultSnapshot = readU64LE4(bytes, off);
  off += 8;
  const poolMode = bytes[off];
  off += 1;
  off += 7;
  const reservedStart = off;
  const hwmEnabled = bytes[reservedStart + 9] === 1;
  const hwmTvlLow = readU64LE4(bytes, reservedStart + 10);
  const hwmTvlHigh = readU64LE4(bytes, reservedStart + 18);
  const epochHighWaterTvl = hwmTvlLow | hwmTvlHigh << 64n;
  const hwmFloorBps = readU16LE3(bytes, reservedStart + 26);
  const trancheEnabled = bytes[reservedStart + 32] === 1;
  const juniorBalance = readU64LE4(bytes, reservedStart + 33);
  const juniorTotalLp = readU64LE4(bytes, reservedStart + 41);
  const juniorFeeMultBps = readU16LE3(bytes, reservedStart + 49);
  return {
    isInitialized,
    bump,
    vaultAuthorityBump,
    adminTransferred,
    slab,
    admin,
    collateralMint,
    lpMint,
    vault,
    totalDeposited,
    totalLpSupply,
    cooldownSlots,
    depositCap,
    totalFlushed,
    totalReturned,
    totalWithdrawn,
    percolatorProgram,
    totalFeesEarned,
    lastFeeAccrualSlot,
    lastVaultSnapshot,
    poolMode,
    hwmEnabled,
    epochHighWaterTvl,
    hwmFloorBps,
    trancheEnabled,
    juniorBalance,
    juniorTotalLp,
    juniorFeeMultBps
  };
}
function initPoolAccounts(a) {
  return [
    { pubkey: a.admin, isSigner: true, isWritable: true },
    { pubkey: a.slab, isSigner: false, isWritable: false },
    { pubkey: a.pool, isSigner: false, isWritable: true },
    { pubkey: a.lpMint, isSigner: false, isWritable: true },
    { pubkey: a.vault, isSigner: false, isWritable: true },
    { pubkey: a.vaultAuth, isSigner: false, isWritable: false },
    { pubkey: a.collateralMint, isSigner: false, isWritable: false },
    { pubkey: a.percolatorProgram, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID4, isSigner: false, isWritable: false },
    { pubkey: SystemProgram2.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY2, isSigner: false, isWritable: false }
  ];
}
function depositAccounts(a) {
  return [
    { pubkey: a.user, isSigner: true, isWritable: false },
    { pubkey: a.pool, isSigner: false, isWritable: true },
    { pubkey: a.userCollateralAta, isSigner: false, isWritable: true },
    { pubkey: a.vault, isSigner: false, isWritable: true },
    { pubkey: a.lpMint, isSigner: false, isWritable: true },
    { pubkey: a.userLpAta, isSigner: false, isWritable: true },
    { pubkey: a.vaultAuth, isSigner: false, isWritable: false },
    { pubkey: a.depositPda, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID4, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_CLOCK_PUBKEY2, isSigner: false, isWritable: false },
    { pubkey: SystemProgram2.programId, isSigner: false, isWritable: false }
  ];
}
function withdrawAccounts(a) {
  return [
    { pubkey: a.user, isSigner: true, isWritable: false },
    { pubkey: a.pool, isSigner: false, isWritable: true },
    { pubkey: a.userLpAta, isSigner: false, isWritable: true },
    { pubkey: a.lpMint, isSigner: false, isWritable: true },
    { pubkey: a.vault, isSigner: false, isWritable: true },
    { pubkey: a.userCollateralAta, isSigner: false, isWritable: true },
    { pubkey: a.vaultAuth, isSigner: false, isWritable: false },
    { pubkey: a.depositPda, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID4, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_CLOCK_PUBKEY2, isSigner: false, isWritable: false }
  ];
}
function flushToInsuranceAccounts(a) {
  return [
    { pubkey: a.caller, isSigner: true, isWritable: false },
    { pubkey: a.pool, isSigner: false, isWritable: true },
    { pubkey: a.vault, isSigner: false, isWritable: true },
    { pubkey: a.vaultAuth, isSigner: false, isWritable: false },
    { pubkey: a.slab, isSigner: false, isWritable: true },
    { pubkey: a.wrapperVault, isSigner: false, isWritable: true },
    { pubkey: a.percolatorProgram, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID4, isSigner: false, isWritable: false }
  ];
}

// src/solana/adl.ts
import {
  TransactionInstruction,
  SYSVAR_CLOCK_PUBKEY as SYSVAR_CLOCK_PUBKEY3
} from "@solana/web3.js";
function computePnlPct(pnl, capital) {
  if (capital === 0n) return 0n;
  return pnl * 10000n / capital;
}
function isAdlTriggered(slabData) {
  const layout = detectSlabLayout(slabData.length);
  if (!layout) return false;
  try {
    const engine = parseEngine(slabData);
    if (engine.pnlPosTot === 0n) return false;
    const config = parseConfig(slabData, layout);
    if (config.maxPnlCap === 0n) return false;
    return engine.pnlPosTot > config.maxPnlCap;
  } catch {
    return false;
  }
}
async function fetchAdlRankedPositions(connection, slab) {
  const data = await fetchSlab(connection, slab);
  return rankAdlPositions(data);
}
function rankAdlPositions(slabData) {
  const layout = detectSlabLayout(slabData.length);
  let pnlPosTot = 0n;
  try {
    const engine = parseEngine(slabData);
    pnlPosTot = engine.pnlPosTot;
  } catch (err) {
    console.warn(
      `[rankAdlPositions] parseEngine failed:`,
      err instanceof Error ? err.message : err
    );
  }
  let maxPnlCap = 0n;
  let isTriggered = false;
  if (layout) {
    try {
      const config = parseConfig(slabData, layout);
      maxPnlCap = config.maxPnlCap;
      isTriggered = maxPnlCap > 0n && pnlPosTot > maxPnlCap;
    } catch {
    }
  }
  const accounts = parseAllAccounts(slabData);
  const positions = [];
  for (const { idx, account } of accounts) {
    if (account.kind !== 0 /* User */) continue;
    if (account.positionSize === 0n) continue;
    const side = account.positionSize > 0n ? "long" : "short";
    const pnlPct = computePnlPct(account.pnl, account.capital);
    positions.push({
      idx,
      owner: account.owner,
      positionSize: account.positionSize,
      pnl: account.pnl,
      capital: account.capital,
      pnlPct,
      side,
      adlRank: -1
      // assigned below
    });
  }
  const longs = positions.filter((p) => p.side === "long").sort((a, b) => b.pnlPct > a.pnlPct ? 1 : b.pnlPct < a.pnlPct ? -1 : 0);
  longs.forEach((p, i) => {
    p.adlRank = i;
  });
  const shorts = positions.filter((p) => p.side === "short").sort((a, b) => b.pnlPct > a.pnlPct ? 1 : b.pnlPct < a.pnlPct ? -1 : 0);
  shorts.forEach((p, i) => {
    p.adlRank = i;
  });
  const ranked = [...longs, ...shorts].sort(
    (a, b) => b.pnlPct > a.pnlPct ? 1 : b.pnlPct < a.pnlPct ? -1 : 0
  );
  return { ranked, longs, shorts, isTriggered, pnlPosTot, maxPnlCap };
}
function buildAdlInstruction(caller, slab, oracle, programId, targetIdx, backupOracles = []) {
  if (!Number.isInteger(targetIdx) || targetIdx < 0) {
    throw new Error(
      `buildAdlInstruction: targetIdx must be a non-negative integer, got ${targetIdx}`
    );
  }
  const data = Buffer.from(encodeExecuteAdl({ targetIdx }));
  const keys = [
    { pubkey: caller, isSigner: true, isWritable: false },
    { pubkey: slab, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_CLOCK_PUBKEY3, isSigner: false, isWritable: false },
    { pubkey: oracle, isSigner: false, isWritable: false },
    ...backupOracles.map((k) => ({ pubkey: k, isSigner: false, isWritable: false }))
  ];
  return new TransactionInstruction({ keys, programId, data });
}
async function buildAdlTransaction(connection, caller, slab, oracle, programId, preferSide, backupOracles = []) {
  const ranking = await fetchAdlRankedPositions(connection, slab);
  if (!ranking.isTriggered) return null;
  let target;
  if (preferSide === "long") {
    target = ranking.longs[0];
  } else if (preferSide === "short") {
    target = ranking.shorts[0];
  } else {
    target = ranking.ranked[0];
  }
  if (!target) return null;
  return buildAdlInstruction(caller, slab, oracle, programId, target.idx, backupOracles);
}
var ADL_EVENT_TAG = 0xAD1E0001n;
function parseAdlEvent(logs) {
  for (const line of logs) {
    if (typeof line !== "string") continue;
    const match = line.match(
      /^Program log: (\d+) (\d+) (\d+) (\d+) (\d+)$/
    );
    if (!match) continue;
    let tag;
    try {
      tag = BigInt(match[1]);
    } catch {
      continue;
    }
    if (tag !== ADL_EVENT_TAG) continue;
    try {
      const targetIdx = Number(BigInt(match[2]));
      const price = BigInt(match[3]);
      const closedLo = BigInt(match[4]);
      const closedHi = BigInt(match[5]);
      const closedAbs = closedHi << 64n | closedLo;
      return { tag, targetIdx, price, closedAbs };
    } catch {
      continue;
    }
  }
  return null;
}
async function fetchAdlRankings(apiBase, slab, fetchFn = fetch) {
  const slabStr = typeof slab === "string" ? slab : slab.toBase58();
  const base = apiBase.replace(/\/$/, "");
  const url = `${base}/api/adl/rankings?slab=${encodeURIComponent(slabStr)}`;
  const res = await fetchFn(url);
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
    }
    throw new Error(
      `fetchAdlRankings: HTTP ${res.status} from ${url}${body ? ` \u2014 ${body}` : ""}`
    );
  }
  const json = await res.json();
  return json;
}

// src/runtime/tx.ts
import {
  TransactionInstruction as TransactionInstruction2,
  Transaction,
  ComputeBudgetProgram
} from "@solana/web3.js";
function buildIx(params) {
  return new TransactionInstruction2({
    programId: params.programId,
    keys: params.keys,
    // TransactionInstruction types expect Buffer, but Uint8Array works at runtime.
    // Cast to avoid Buffer polyfill issues in the browser.
    data: params.data
  });
}
var MAX_COMPUTE_UNIT_LIMIT = 14e5;
async function simulateOrSend(params) {
  const { connection, ix, signers, simulate, commitment = "confirmed", computeUnitLimit } = params;
  if (!signers.length) {
    throw new Error("simulateOrSend: at least one signer is required");
  }
  if (computeUnitLimit !== void 0) {
    if (typeof computeUnitLimit !== "number" || !Number.isInteger(computeUnitLimit) || computeUnitLimit < 1 || computeUnitLimit > MAX_COMPUTE_UNIT_LIMIT) {
      throw new Error(
        `computeUnitLimit must be an integer in [1, ${MAX_COMPUTE_UNIT_LIMIT}]`
      );
    }
  }
  const tx = new Transaction();
  if (computeUnitLimit !== void 0) {
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: computeUnitLimit
      })
    );
  }
  tx.add(ix);
  const latestBlockhash = await connection.getLatestBlockhash(commitment);
  tx.recentBlockhash = latestBlockhash.blockhash;
  tx.feePayer = signers[0].publicKey;
  if (simulate) {
    try {
      tx.sign(...signers);
      const result = await connection.simulateTransaction(tx, signers);
      const logs = result.value.logs ?? [];
      let err = null;
      let hint;
      if (result.value.err) {
        const parsed = parseErrorFromLogs(logs);
        if (parsed) {
          err = `${parsed.name} (0x${parsed.code.toString(16)})`;
          hint = parsed.hint;
        } else {
          err = JSON.stringify(result.value.err);
        }
      }
      return {
        signature: "(simulated)",
        slot: result.context.slot,
        err,
        hint,
        logs,
        unitsConsumed: result.value.unitsConsumed ?? void 0
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        signature: "(simulated)",
        slot: 0,
        err: message,
        logs: []
      };
    }
  }
  const options = {
    skipPreflight: false,
    preflightCommitment: commitment
  };
  try {
    const signature = await connection.sendTransaction(tx, signers, options);
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
      },
      commitment
    );
    const txInfo = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    });
    const logs = txInfo?.meta?.logMessages ?? [];
    let err = null;
    let hint;
    if (confirmation.value.err) {
      const parsed = parseErrorFromLogs(logs);
      if (parsed) {
        err = `${parsed.name} (0x${parsed.code.toString(16)})`;
        hint = parsed.hint;
      } else {
        err = JSON.stringify(confirmation.value.err);
      }
    }
    return {
      signature,
      slot: txInfo?.slot ?? 0,
      err,
      hint,
      logs
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      signature: "",
      slot: 0,
      err: message,
      logs: []
    };
  }
}
function formatResult(result, jsonMode) {
  if (jsonMode) {
    return JSON.stringify(result, null, 2);
  }
  const lines = [];
  if (result.err) {
    lines.push(`Error: ${result.err}`);
    if (result.hint) {
      lines.push(`Hint: ${result.hint}`);
    }
    if (result.unitsConsumed !== void 0) {
      lines.push(`Compute Units: ${result.unitsConsumed.toLocaleString()}`);
    }
    if (result.logs.length > 0) {
      lines.push("Logs:");
      result.logs.forEach((log) => lines.push(`  ${log}`));
    }
  } else {
    lines.push(`Signature: ${result.signature}`);
    lines.push(`Slot: ${result.slot}`);
    if (result.unitsConsumed !== void 0) {
      lines.push(`Compute Units: ${result.unitsConsumed.toLocaleString()}`);
    }
    if (result.signature !== "(simulated)") {
      lines.push(`Explorer: https://explorer.solana.com/tx/${result.signature}`);
    }
  }
  return lines.join("\n");
}

// src/math/trading.ts
function computeMarkPnl(positionSize, entryPrice, oraclePrice) {
  if (positionSize === 0n || oraclePrice === 0n) return 0n;
  const absPos = positionSize < 0n ? -positionSize : positionSize;
  const diff = positionSize > 0n ? oraclePrice - entryPrice : entryPrice - oraclePrice;
  return diff * absPos / oraclePrice;
}
function computeLiqPrice(entryPrice, capital, positionSize, maintenanceMarginBps) {
  if (positionSize === 0n || entryPrice === 0n) return 0n;
  const absPos = positionSize < 0n ? -positionSize : positionSize;
  const capitalPerUnitE6 = capital * 1000000n / absPos;
  if (positionSize > 0n) {
    const adjusted = capitalPerUnitE6 * 10000n / (10000n + maintenanceMarginBps);
    const liq = entryPrice - adjusted;
    return liq > 0n ? liq : 0n;
  } else {
    if (maintenanceMarginBps >= 10000n) return 18446744073709551615n;
    const adjusted = capitalPerUnitE6 * 10000n / (10000n - maintenanceMarginBps);
    return entryPrice + adjusted;
  }
}
function computePreTradeLiqPrice(oracleE6, margin, posSize, maintBps, feeBps, direction) {
  if (oracleE6 === 0n || margin === 0n || posSize === 0n) return 0n;
  const absPos = posSize < 0n ? -posSize : posSize;
  const signedPos = direction === "long" ? absPos : -absPos;
  const feeAdjust = oracleE6 * feeBps / 10000n;
  let adjustedEntry;
  if (direction === "long") {
    adjustedEntry = oracleE6 + feeAdjust;
  } else {
    const shortEntry = oracleE6 - feeAdjust;
    adjustedEntry = shortEntry > 0n ? shortEntry : 1n;
  }
  return computeLiqPrice(adjustedEntry, margin, signedPos, maintBps);
}
function computeTradingFee(notional, tradingFeeBps) {
  return notional * tradingFeeBps / 10000n;
}
function computeDynamicFeeBps(notional, config) {
  if (config.tier2Threshold === 0n) return config.baseBps;
  if (config.tier3Threshold > 0n && notional >= config.tier3Threshold) return config.tier3Bps;
  if (notional >= config.tier2Threshold) return config.tier2Bps;
  return config.baseBps;
}
function computeDynamicTradingFee(notional, config) {
  const feeBps = computeDynamicFeeBps(notional, config);
  if (notional <= 0n || feeBps <= 0n) return 0n;
  return (notional * feeBps + 9999n) / 10000n;
}
function computeFeeSplit(totalFee, config) {
  if (config.lpBps === 0n && config.protocolBps === 0n && config.creatorBps === 0n) {
    return [totalFee, 0n, 0n];
  }
  const lp = totalFee * config.lpBps / 10000n;
  const protocol = totalFee * config.protocolBps / 10000n;
  const creator = totalFee - lp - protocol;
  return [lp, protocol, creator];
}
function computePnlPercent(pnlTokens, capital) {
  if (capital === 0n) return 0;
  const scaledPct = pnlTokens * 10000n / capital;
  if (scaledPct > BigInt(Number.MAX_SAFE_INTEGER) || scaledPct < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `computePnlPercent: scaled result ${scaledPct} exceeds Number.MAX_SAFE_INTEGER \u2014 precision loss`
    );
  }
  return Number(scaledPct) / 100;
}
function computeEstimatedEntryPrice(oracleE6, tradingFeeBps, direction) {
  if (oracleE6 === 0n) return 0n;
  const feeImpact = oracleE6 * tradingFeeBps / 10000n;
  if (direction === "long") return oracleE6 + feeImpact;
  const shortEntry = oracleE6 - feeImpact;
  return shortEntry > 0n ? shortEntry : 1n;
}
var MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
var MIN_SAFE_BIGINT = BigInt(-Number.MAX_SAFE_INTEGER);
function computeFundingRateAnnualized(fundingRateBpsPerSlot) {
  if (fundingRateBpsPerSlot > MAX_SAFE_BIGINT || fundingRateBpsPerSlot < MIN_SAFE_BIGINT) {
    throw new Error(
      `computeFundingRateAnnualized: value ${fundingRateBpsPerSlot} exceeds safe integer range`
    );
  }
  const bpsPerSlot = Number(fundingRateBpsPerSlot);
  const slotsPerYear = 2.5 * 60 * 60 * 24 * 365;
  return bpsPerSlot * slotsPerYear / 100;
}
function computeRequiredMargin(notional, initialMarginBps) {
  return notional * initialMarginBps / 10000n;
}
function computeMaxLeverage(initialMarginBps) {
  if (initialMarginBps <= 0n) {
    throw new Error("computeMaxLeverage: initialMarginBps must be positive");
  }
  return Number(10000n / initialMarginBps);
}

// src/math/warmup.ts
function computeWarmupUnlockedCapital(totalCapital, currentSlot, warmupStartSlot, warmupPeriodSlots) {
  if (warmupPeriodSlots === 0n || warmupStartSlot === 0n) return totalCapital;
  if (totalCapital <= 0n) return 0n;
  const elapsed = currentSlot > warmupStartSlot ? currentSlot - warmupStartSlot : 0n;
  if (elapsed >= warmupPeriodSlots) return totalCapital;
  return totalCapital * elapsed / warmupPeriodSlots;
}
function computeWarmupLeverageCap(initialMarginBps, totalCapital, currentSlot, warmupStartSlot, warmupPeriodSlots) {
  const maxLev = computeMaxLeverage(initialMarginBps);
  if (warmupPeriodSlots === 0n || warmupStartSlot === 0n) return maxLev;
  if (totalCapital <= 0n) return 1;
  const unlocked = computeWarmupUnlockedCapital(
    totalCapital,
    currentSlot,
    warmupStartSlot,
    warmupPeriodSlots
  );
  if (unlocked <= 0n) return 1;
  const effectiveLev = Number(BigInt(maxLev) * unlocked / totalCapital);
  return Math.max(1, effectiveLev);
}
function computeWarmupMaxPositionSize(initialMarginBps, totalCapital, currentSlot, warmupStartSlot, warmupPeriodSlots) {
  const maxLev = computeMaxLeverage(initialMarginBps);
  const unlocked = computeWarmupUnlockedCapital(
    totalCapital,
    currentSlot,
    warmupStartSlot,
    warmupPeriodSlots
  );
  return unlocked * BigInt(maxLev);
}

// src/validation.ts
import { PublicKey as PublicKey13 } from "@solana/web3.js";
var U16_MAX2 = 65535;
var U64_MAX = BigInt("18446744073709551615");
var I64_MIN = BigInt("-9223372036854775808");
var I64_MAX = BigInt("9223372036854775807");
var U128_MAX = (1n << 128n) - 1n;
var I128_MIN = -(1n << 127n);
var I128_MAX = (1n << 127n) - 1n;
function requireDecimalUIntString(value, field) {
  const t = value.trim();
  if (t === "") {
    throw new ValidationError(field, `"${value}" is not a valid number`);
  }
  if (!/^(0|[1-9]\d*)$/.test(t)) {
    throw new ValidationError(
      field,
      `"${value}" is not a valid non-negative integer (use decimal digits only, e.g. 123).`
    );
  }
  return t;
}
var ValidationError = class extends Error {
  constructor(field, message) {
    super(`Invalid ${field}: ${message}`);
    this.field = field;
    this.name = "ValidationError";
  }
};
function validatePublicKey(value, field) {
  try {
    return new PublicKey13(value);
  } catch {
    throw new ValidationError(
      field,
      `"${value}" is not a valid base58 public key. Example: "11111111111111111111111111111111"`
    );
  }
}
function validateIndex(value, field) {
  const t = requireDecimalUIntString(value, field);
  const bi = BigInt(t);
  if (bi > BigInt(U16_MAX2)) {
    throw new ValidationError(
      field,
      `must be <= ${U16_MAX2} (u16 max), got ${t}`
    );
  }
  return Number(bi);
}
function validateAmount(value, field) {
  let num;
  try {
    num = BigInt(value);
  } catch {
    throw new ValidationError(
      field,
      `"${value}" is not a valid number. Use decimal digits only.`
    );
  }
  if (num < 0n) {
    throw new ValidationError(field, `must be non-negative, got ${num}`);
  }
  if (num > U64_MAX) {
    throw new ValidationError(
      field,
      `must be <= ${U64_MAX} (u64 max), got ${num}`
    );
  }
  return num;
}
function validateU128(value, field) {
  let num;
  try {
    num = BigInt(value);
  } catch {
    throw new ValidationError(
      field,
      `"${value}" is not a valid number. Use decimal digits only.`
    );
  }
  if (num < 0n) {
    throw new ValidationError(field, `must be non-negative, got ${num}`);
  }
  if (num > U128_MAX) {
    throw new ValidationError(
      field,
      `must be <= ${U128_MAX} (u128 max), got ${num}`
    );
  }
  return num;
}
function validateI64(value, field) {
  let num;
  try {
    num = BigInt(value);
  } catch {
    throw new ValidationError(
      field,
      `"${value}" is not a valid number. Use decimal digits only, with optional leading minus.`
    );
  }
  if (num < I64_MIN) {
    throw new ValidationError(
      field,
      `must be >= ${I64_MIN} (i64 min), got ${num}`
    );
  }
  if (num > I64_MAX) {
    throw new ValidationError(
      field,
      `must be <= ${I64_MAX} (i64 max), got ${num}`
    );
  }
  return num;
}
function validateI128(value, field) {
  let num;
  try {
    num = BigInt(value);
  } catch {
    throw new ValidationError(
      field,
      `"${value}" is not a valid number. Use decimal digits only, with optional leading minus.`
    );
  }
  if (num < I128_MIN) {
    throw new ValidationError(
      field,
      `must be >= ${I128_MIN} (i128 min), got ${num}`
    );
  }
  if (num > I128_MAX) {
    throw new ValidationError(
      field,
      `must be <= ${I128_MAX} (i128 max), got ${num}`
    );
  }
  return num;
}
function validateBps(value, field) {
  const t = requireDecimalUIntString(value, field);
  const bi = BigInt(t);
  if (bi > 10000n) {
    throw new ValidationError(
      field,
      `must be <= 10000 (100%), got ${t}`
    );
  }
  return Number(bi);
}
function validateU64(value, field) {
  return validateAmount(value, field);
}
function validateU16(value, field) {
  const t = requireDecimalUIntString(value, field);
  const bi = BigInt(t);
  if (bi > BigInt(U16_MAX2)) {
    throw new ValidationError(
      field,
      `must be <= ${U16_MAX2} (u16 max), got ${t}`
    );
  }
  return Number(bi);
}

// src/oracle/price-router.ts
var DEFAULT_RESOLVE_TIMEOUT_MS = 15e3;
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function combineAbortSignals(signals) {
  const already = signals.find((s) => s.aborted);
  if (already) {
    const c = new AbortController();
    c.abort(already.reason);
    return c.signal;
  }
  const active = signals.filter((s) => !s.aborted);
  if (active.length === 0) {
    const c = new AbortController();
    c.abort();
    return c.signal;
  }
  if (active.length === 1) return active[0];
  const ctrl = new AbortController();
  for (const s of active) {
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}
var SUPPORTED_DEX_IDS = /* @__PURE__ */ new Set(["pumpswap", "raydium", "meteora"]);
function parseDexScreenerPairs(json) {
  if (!isRecord(json)) return [];
  const rawPairs = json.pairs;
  if (!Array.isArray(rawPairs)) return [];
  const sources = [];
  for (const pair of rawPairs) {
    if (!isRecord(pair)) continue;
    if (pair.chainId !== "solana") continue;
    const dexId = String(pair.dexId || "").toLowerCase();
    if (!SUPPORTED_DEX_IDS.has(dexId)) continue;
    let liquidity = 0;
    if (isRecord(pair.liquidity) && typeof pair.liquidity.usd === "number") {
      liquidity = pair.liquidity.usd;
    }
    if (liquidity < 100) continue;
    let confidence = 30;
    if (liquidity > 1e6) confidence = 90;
    else if (liquidity > 1e5) confidence = 75;
    else if (liquidity > 1e4) confidence = 60;
    else if (liquidity > 1e3) confidence = 45;
    const priceUsd = pair.priceUsd;
    const price = typeof priceUsd === "string" || typeof priceUsd === "number" ? parseFloat(String(priceUsd)) || 0 : 0;
    let baseSym = "?";
    let quoteSym = "?";
    if (isRecord(pair.baseToken) && typeof pair.baseToken.symbol === "string") {
      baseSym = pair.baseToken.symbol;
    }
    if (isRecord(pair.quoteToken) && typeof pair.quoteToken.symbol === "string") {
      quoteSym = pair.quoteToken.symbol;
    }
    const addr = pair.pairAddress;
    sources.push({
      type: "dex",
      address: typeof addr === "string" ? addr : "",
      dexId,
      pairLabel: `${baseSym} / ${quoteSym}`,
      liquidity,
      price,
      confidence
    });
  }
  sources.sort((a, b) => b.liquidity - a.liquidity);
  return sources.slice(0, 10);
}
function parseJupiterMintEntry(json, mint) {
  if (!isRecord(json)) return null;
  const data = json.data;
  if (!isRecord(data)) return null;
  const row = data[mint];
  if (!isRecord(row)) return null;
  const rawPrice = row.price;
  if (rawPrice === void 0 || rawPrice === null) return null;
  const price = parseFloat(String(rawPrice)) || 0;
  if (price <= 0) return null;
  let mintSymbol = "?";
  if (typeof row.mintSymbol === "string") mintSymbol = row.mintSymbol;
  return { price, mintSymbol };
}
var PYTH_SOLANA_FEEDS = {
  // SOL
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d": { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
  // BTC
  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43": { symbol: "BTC", mint: "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E" },
  // ETH
  "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace": { symbol: "ETH", mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs" },
  // USDC
  "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a": { symbol: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  // USDT
  "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b": { symbol: "USDT", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
  // BONK
  "72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419": { symbol: "BONK", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
  // JTO
  "b43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2": { symbol: "JTO", mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL" },
  // JUP
  "0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996": { symbol: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  // PYTH
  "0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff": { symbol: "PYTH", mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3" },
  // RAY
  "91568bae053f70f0c3fbf32eb55df25ec609fb8a21cfb1a0e3b34fc3caa1eab0": { symbol: "RAY", mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R" },
  // ORCA
  "37505261e557e251f40c2c721e52c4c8bfb2e54a12f450d0e24078276ad51b95": { symbol: "ORCA", mint: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE" },
  // MNGO
  "f9abf5eb70a2e68e21b72b68cc6e0a4d25e1d77e1ec16eae5b93068a2cb81f90": { symbol: "MNGO", mint: "MangoCzJ36AjZyKwVj3VnYU4GTonjfVEnJmvvWaxLac" },
  // MSOL
  "c2289a6a43d2ce91c6f55caec370f4acc38a2ed477f58813334c6d03749ff2a4": { symbol: "MSOL", mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So" },
  // JITOSOL
  "67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb": { symbol: "JITOSOL", mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn" },
  // WIF
  "4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54e6c5c4b03": { symbol: "WIF", mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" },
  // RENDER
  "3573eb14b04aa0e4f7cf1e7ae1c2a0e3bc6100b2e476876ca079e10e2c42d7c6": { symbol: "RENDER", mint: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof" },
  // W
  "eff7446475e218517566ea99e72a4abec2e1bd8498b43b7d8331e29dcb059389": { symbol: "W", mint: "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ" },
  // TNSR
  "05ecd4597cd48fe13d6cc3596c62af4f9675aee06e2e0ca164a73be4b0813f3b": { symbol: "TNSR", mint: "TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6" },
  // HNT
  "649fdd7ec08e8e2a20f425729854e90293dcbe2376abc47197a14da6ff339756": { symbol: "HNT", mint: "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux" },
  // MOBILE
  "ff4c53361e36a9b1caa490f1e46e07e3c472d54d2a4856a1e4609bd4db36bff0": { symbol: "MOBILE", mint: "mb1eu7TzEc71KxDpsmsKoucSSuuoGLv1drys1oP2jh6" },
  // IOT
  "8bdd20f0c68bf7370a19389bbb3d17c1db7956c38efa08b2f3dd0e5db9b8c1ef": { symbol: "IOT", mint: "iotEVVZLEywoTn1QdwNPddxPWszn3zFhEot3MfL9fns" }
};
var MINT_TO_PYTH_FEED = /* @__PURE__ */ new Map();
for (const [feedId, info] of Object.entries(PYTH_SOLANA_FEEDS)) {
  MINT_TO_PYTH_FEED.set(info.mint, { feedId, symbol: info.symbol });
}
var DEFAULT_FETCH_TIMEOUT_MS = 1e4;
function effectiveSignal(signal) {
  return signal ?? AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS);
}
async function fetchDexSources(mint, signal) {
  try {
    const resp = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
      {
        signal: effectiveSignal(signal),
        headers: { "User-Agent": "percolator/1.0" }
      }
    );
    if (!resp.ok) return [];
    const json = await resp.json();
    return parseDexScreenerPairs(json);
  } catch {
    return [];
  }
}
function lookupPythSource(mint) {
  const entry = MINT_TO_PYTH_FEED.get(mint);
  if (!entry) return null;
  return {
    type: "pyth",
    address: entry.feedId,
    pairLabel: `${entry.symbol} / USD (Pyth)`,
    liquidity: Infinity,
    // Pyth is considered deep liquidity
    price: 0,
    // We don't fetch live price here; caller can enrich
    confidence: 95
    // Pyth is highest reliability for supported tokens
  };
}
async function fetchJupiterSource(mint, signal) {
  try {
    const resp = await fetch(
      `https://api.jup.ag/price/v2?ids=${encodeURIComponent(mint)}`,
      {
        signal: effectiveSignal(signal),
        headers: { "User-Agent": "percolator/1.0" }
      }
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    const row = parseJupiterMintEntry(json, mint);
    if (!row) return null;
    return {
      type: "jupiter",
      address: mint,
      pairLabel: `${row.mintSymbol} / USD (Jupiter)`,
      liquidity: 0,
      // Jupiter aggregator — no single pool liquidity
      price: row.price,
      confidence: 40
      // Fallback — lower confidence
    };
  } catch {
    return null;
  }
}
async function resolvePrice(mint, signal, options) {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? combineAbortSignals([signal, timeoutSignal]) : timeoutSignal;
  const [dexSources, jupiterSource] = await Promise.all([
    fetchDexSources(mint, combinedSignal),
    fetchJupiterSource(mint, combinedSignal)
  ]);
  const pythSource = lookupPythSource(mint);
  const allSources = [];
  if (pythSource) {
    const refPrice = dexSources[0]?.price || jupiterSource?.price || 0;
    pythSource.price = refPrice;
    allSources.push(pythSource);
  }
  allSources.push(...dexSources);
  if (jupiterSource) {
    allSources.push(jupiterSource);
  }
  allSources.sort((a, b) => b.confidence - a.confidence);
  return {
    mint,
    bestSource: allSources[0] || null,
    allSources,
    resolvedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
export {
  ACCOUNTS_ADVANCE_ORACLE_PHASE,
  ACCOUNTS_AUDIT_CRANK,
  ACCOUNTS_BURN_POSITION_NFT,
  ACCOUNTS_CANCEL_QUEUED_WITHDRAWAL,
  ACCOUNTS_CLAIM_QUEUED_WITHDRAWAL,
  ACCOUNTS_CLEAR_PENDING_SETTLEMENT,
  ACCOUNTS_CLOSE_ACCOUNT,
  ACCOUNTS_CLOSE_SLAB,
  ACCOUNTS_CLOSE_STALE_SLABS,
  ACCOUNTS_CREATE_INSURANCE_MINT,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_DEPOSIT_INSURANCE_LP,
  ACCOUNTS_EXECUTE_ADL,
  ACCOUNTS_FUND_MARKET_INSURANCE,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_MATCHER_CTX,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_LIQUIDATE_AT_ORACLE,
  ACCOUNTS_LP_VAULT_WITHDRAW,
  ACCOUNTS_MINT_POSITION_NFT,
  ACCOUNTS_PAUSE_MARKET,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_QUEUE_WITHDRAWAL,
  ACCOUNTS_RECLAIM_SLAB_RENT,
  ACCOUNTS_RESOLVE_MARKET,
  ACCOUNTS_SET_DEX_POOL,
  ACCOUNTS_SET_INSURANCE_ISOLATION,
  ACCOUNTS_SET_MAINTENANCE_FEE,
  ACCOUNTS_SET_OI_IMBALANCE_HARD_BLOCK,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_SET_ORACLE_PRICE_CAP,
  ACCOUNTS_SET_PENDING_SETTLEMENT,
  ACCOUNTS_SET_RISK_THRESHOLD,
  ACCOUNTS_SET_WALLET_CAP,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_TOPUP_KEEPER_FUND,
  ACCOUNTS_TRADE_CPI,
  ACCOUNTS_TRADE_NOCPI,
  ACCOUNTS_TRANSFER_POSITION_OWNERSHIP,
  ACCOUNTS_UNPAUSE_MARKET,
  ACCOUNTS_UPDATE_ADMIN,
  ACCOUNTS_UPDATE_CONFIG,
  ACCOUNTS_WITHDRAW_COLLATERAL,
  ACCOUNTS_WITHDRAW_INSURANCE,
  ACCOUNTS_WITHDRAW_INSURANCE_LP,
  AccountKind,
  CHAINLINK_ANSWER_OFFSET,
  CHAINLINK_DECIMALS_OFFSET,
  CHAINLINK_MIN_SIZE,
  CREATOR_LOCK_SEED,
  CTX_VAMM_OFFSET,
  DEFAULT_OI_RAMP_SLOTS,
  ENGINE_MARK_PRICE_OFF,
  ENGINE_OFF,
  IX_TAG,
  MARK_PRICE_EMA_ALPHA_E6,
  MARK_PRICE_EMA_WINDOW_SLOTS,
  MAX_DECIMALS,
  MAX_ORACLE_PRICE,
  METEORA_DLMM_PROGRAM_ID,
  ORACLE_PHASE_GROWING,
  ORACLE_PHASE_MATURE,
  ORACLE_PHASE_NASCENT,
  PERCOLATOR_ERRORS,
  PHASE1_MIN_SLOTS,
  PHASE1_VOLUME_MIN_SLOTS,
  PHASE2_MATURITY_SLOTS,
  PHASE2_VOLUME_THRESHOLD,
  PROGRAM_IDS,
  PUMPSWAP_PROGRAM_ID,
  PYTH_PUSH_ORACLE_PROGRAM_ID,
  PYTH_RECEIVER_PROGRAM_ID,
  PYTH_SOLANA_FEEDS,
  RAMP_START_BPS,
  RAYDIUM_CLMM_PROGRAM_ID,
  RENOUNCE_ADMIN_CONFIRMATION,
  SLAB_TIERS,
  SLAB_TIERS_V0,
  SLAB_TIERS_V1,
  SLAB_TIERS_V12_1,
  SLAB_TIERS_V1D,
  SLAB_TIERS_V1D_LEGACY,
  SLAB_TIERS_V1M,
  SLAB_TIERS_V1M2,
  SLAB_TIERS_V2,
  SLAB_TIERS_V_ADL,
  SLAB_TIERS_V_ADL_DISCOVERY,
  SLAB_TIERS_V_SETDEXPOOL,
  STAKE_IX,
  STAKE_POOL_SIZE,
  STAKE_PROGRAM_ID,
  STAKE_PROGRAM_IDS,
  TOKEN_2022_PROGRAM_ID,
  UNRESOLVE_CONFIRMATION,
  VAMM_MAGIC,
  ValidationError,
  WELL_KNOWN,
  buildAccountMetas,
  buildAdlInstruction,
  buildAdlTransaction,
  buildIx,
  checkPhaseTransition,
  clearStaticMarkets,
  computeDexSpotPriceE6,
  computeDynamicFeeBps,
  computeDynamicTradingFee,
  computeEffectiveOiCapBps,
  computeEmaMarkPrice,
  computeEstimatedEntryPrice,
  computeFeeSplit,
  computeFundingRateAnnualized,
  computeLiqPrice,
  computeMarkPnl,
  computeMaxLeverage,
  computePnlPercent,
  computePreTradeLiqPrice,
  computeRequiredMargin,
  computeTradingFee,
  computeVammQuote,
  computeWarmupLeverageCap,
  computeWarmupMaxPositionSize,
  computeWarmupUnlockedCapital,
  concatBytes,
  decodeError,
  decodeStakePool,
  depositAccounts,
  deriveCreatorLockPda,
  deriveDepositPda,
  deriveInsuranceLpMint,
  deriveKeeperFund,
  deriveLpPda,
  derivePythPriceUpdateAccount,
  derivePythPushOraclePDA,
  deriveStakePool,
  deriveStakeVaultAuth,
  deriveVaultAuthority,
  detectDexType,
  detectLayout,
  detectSlabLayout,
  detectTokenProgram,
  discoverMarkets,
  discoverMarketsViaApi,
  discoverMarketsViaStaticBundle,
  encBool,
  encI128,
  encI64,
  encPubkey,
  encU128,
  encU16,
  encU32,
  encU64,
  encU8,
  encodeAdminForceClose,
  encodeAdvanceEpoch,
  encodeAdvanceOraclePhase,
  encodeAllocateMarket,
  encodeAttestCrossMargin,
  encodeAuditCrank,
  encodeBurnPositionNft,
  encodeCancelQueuedWithdrawal,
  encodeChallengeSettlement,
  encodeClaimEpochWithdrawal,
  encodeClaimQueuedWithdrawal,
  encodeClearPendingSettlement,
  encodeCloseAccount,
  encodeCloseOrphanSlab,
  encodeCloseSlab,
  encodeCloseStaleSlabs,
  encodeCreateInsuranceMint,
  encodeCreateLpVault,
  encodeDepositCollateral,
  encodeDepositInsuranceLP,
  encodeDepositLpCollateral,
  encodeExecuteAdl,
  encodeForceCloseResolved,
  encodeFundMarketInsurance,
  encodeInitLP,
  encodeInitMarket,
  encodeInitMatcherCtx,
  encodeInitSharedVault,
  encodeInitUser,
  encodeKeeperCrank,
  encodeLiquidateAtOracle,
  encodeLpVaultCrankFees,
  encodeLpVaultDeposit,
  encodeLpVaultWithdraw,
  encodeMintPositionNft,
  encodePauseMarket,
  encodePushOraclePrice,
  encodeQueueWithdrawal,
  encodeQueueWithdrawalSV,
  encodeReclaimSlabRent,
  encodeRenounceAdmin,
  encodeRescueOrphanVault,
  encodeResolveDispute,
  encodeResolveMarket,
  encodeResolvePermissionless,
  encodeSetDexPool,
  encodeSetInsuranceIsolation,
  encodeSetInsuranceWithdrawPolicy,
  encodeSetMaintenanceFee,
  encodeSetOffsetPair,
  encodeSetOiImbalanceHardBlock,
  encodeSetOracleAuthority,
  encodeSetOraclePriceCap,
  encodeSetPendingSettlement,
  encodeSetPythOracle,
  encodeSetRiskThreshold,
  encodeSetWalletCap,
  encodeSlashCreationDeposit,
  encodeStakeAccrueFees,
  encodeStakeAdminResolveMarket,
  encodeStakeAdminSetHwmConfig,
  encodeStakeAdminSetInsurancePolicy,
  encodeStakeAdminSetMaintenanceFee,
  encodeStakeAdminSetOracleAuthority,
  encodeStakeAdminSetRiskThreshold,
  encodeStakeAdminSetTrancheConfig,
  encodeStakeAdminWithdrawInsurance,
  encodeStakeDeposit,
  encodeStakeDepositJunior,
  encodeStakeFlushToInsurance,
  encodeStakeInitPool,
  encodeStakeInitTradingPool,
  encodeStakeTransferAdmin,
  encodeStakeUpdateConfig,
  encodeStakeWithdraw,
  encodeTopUpInsurance,
  encodeTopUpKeeperFund,
  encodeTradeCpi,
  encodeTradeCpiV2,
  encodeTradeNoCpi,
  encodeTransferOwnershipCpi,
  encodeTransferPositionOwnership,
  encodeUnpauseMarket,
  encodeUpdateAdmin,
  encodeUpdateConfig,
  encodeUpdateHyperpMark,
  encodeUpdateMarkPrice,
  encodeUpdateRiskParams,
  encodeWithdrawCollateral,
  encodeWithdrawInsurance,
  encodeWithdrawInsuranceLP,
  encodeWithdrawInsuranceLimited,
  encodeWithdrawLpCollateral,
  fetchAdlRankedPositions,
  fetchAdlRankings,
  fetchSlab,
  fetchTokenAccount,
  flushToInsuranceAccounts,
  formatResult,
  getAta,
  getAtaSync,
  getCurrentNetwork,
  getErrorHint,
  getErrorName,
  getMarketsByAddress,
  getMatcherProgramId,
  getProgramId,
  getStakeProgramId,
  getStaticMarkets,
  initPoolAccounts,
  isAccountUsed,
  isAdlTriggered,
  isStandardToken,
  isToken2022,
  isValidChainlinkOracle,
  maxAccountIndex,
  parseAccount,
  parseAdlEvent,
  parseAllAccounts,
  parseChainlinkPrice,
  parseConfig,
  parseDexPool,
  parseEngine,
  parseErrorFromLogs,
  parseHeader,
  parseParams,
  parseUsedIndices,
  rankAdlPositions,
  readLastThrUpdateSlot,
  readNonce,
  registerStaticMarkets,
  resolvePrice,
  safeEnv,
  simulateOrSend,
  slabDataSize,
  slabDataSizeV1,
  validateAmount,
  validateBps,
  validateI128,
  validateI64,
  validateIndex,
  validatePublicKey,
  validateSlabTierMatch,
  validateU128,
  validateU16,
  validateU64,
  withdrawAccounts
};
//# sourceMappingURL=index.js.map