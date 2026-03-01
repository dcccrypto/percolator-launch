// src/abi/encode.ts
import { PublicKey } from "@solana/web3.js";
function encU8(val) {
  return new Uint8Array([val & 255]);
}
function encU16(val) {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, val, true);
  return buf;
}
function encU32(val) {
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
  const pk = typeof val === "string" ? new PublicKey(val) : val;
  return pk.toBytes();
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
  UpdateRiskParams: 22,
  RenounceAdmin: 23,
  CreateInsuranceMint: 24,
  DepositInsuranceLP: 25,
  WithdrawInsuranceLP: 26,
  PauseMarket: 27,
  UnpauseMarket: 28,
  AcceptAdmin: 29,
  SetInsuranceWithdrawPolicy: 30,
  WithdrawInsuranceLimited: 31,
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
  WithdrawLpCollateral: 46
};
function encodeFeedId(feedId) {
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
function encodeInitMarket(args) {
  return concatBytes(
    encU8(IX_TAG.InitMarket),
    encPubkey(args.admin),
    encPubkey(args.collateralMint),
    encodeFeedId(args.indexFeedId),
    // index_feed_id (32 bytes) - all zeros for Hyperp mode
    encU64(args.maxStalenessSecs),
    // max_staleness_secs (Pyth Pull uses unix timestamps)
    encU16(args.confFilterBps),
    encU8(args.invert),
    encU32(args.unitScale),
    encU64(args.initialMarkPriceE6),
    // initial_mark_price_e6 (required non-zero for Hyperp)
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
    encU128(args.minLiquidationAbs)
  );
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
  return concatBytes(
    encU8(IX_TAG.PushOraclePrice),
    encU64(args.priceE6),
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
function encodeRenounceAdmin() {
  return encU8(IX_TAG.RenounceAdmin);
}
function encodeCreateInsuranceMint() {
  return encU8(IX_TAG.CreateInsuranceMint);
}
function encodeDepositInsuranceLP(args) {
  return concatBytes(encU8(IX_TAG.DepositInsuranceLP), encU64(args.amount));
}
function encodeWithdrawInsuranceLP(args) {
  return concatBytes(encU8(IX_TAG.WithdrawInsuranceLP), encU64(args.lpAmount));
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
  const { PublicKey: PublicKey11 } = await import("@solana/web3.js");
  const shardBuf = new Uint8Array(2);
  new DataView(shardBuf.buffer).setUint16(0, shardId, true);
  const [pda] = PublicKey11.findProgramAddressSync(
    [shardBuf, feedId],
    new PublicKey11(PYTH_RECEIVER_PROGRAM_ID)
  );
  return pda.toBase58();
}
IX_TAG["SetPythOracle"] = 32;
IX_TAG["UpdateMarkPrice"] = 33;
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
    const maxDelta = markPrevE6 * capE2bps * dtSlots / 1000000n;
    const lo = markPrevE6 > maxDelta ? markPrevE6 - maxDelta : 0n;
    const hi = markPrevE6 + maxDelta;
    if (oracleClamped < lo) oracleClamped = lo;
    if (oracleClamped > hi) oracleClamped = hi;
  }
  const effectiveAlpha = alphaE6 * dtSlots > 1000000n ? 1000000n : alphaE6 * dtSlots;
  const oneMinusAlpha = 1000000n - effectiveAlpha;
  return (oracleClamped * effectiveAlpha + markPrevE6 * oneMinusAlpha) / 1000000n;
}
IX_TAG["UpdateHyperpMark"] = 34;
function encodeUpdateHyperpMark() {
  return new Uint8Array([34]);
}
function encodeFundMarketInsurance(args) {
  return concatBytes(encU8(IX_TAG.FundMarketInsurance), encU64(args.amount));
}
function encodeSetInsuranceIsolation(args) {
  return concatBytes(encU8(IX_TAG.SetInsuranceIsolation), encU16(args.bps));
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
  { name: "tokenProgram", signer: false, writable: false }
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
  if (keys.length !== spec.length) {
    throw new Error(
      `Account count mismatch: expected ${spec.length}, got ${keys.length}`
    );
  }
  return spec.map((s, i) => ({
    pubkey: keys[i],
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
var ACCOUNTS_EXECUTE_ADL = [
  { name: "keeper", signer: true, writable: false },
  { name: "slab", signer: false, writable: true }
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
function parseErrorFromLogs(logs) {
  for (const log of logs) {
    const match = log.match(/custom program error: 0x([0-9a-fA-F]+)/);
    if (match) {
      const code = parseInt(match[1], 16);
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
var MAGIC = 0x504552434f4c4154n;
var HEADER_LEN = 104;
var CONFIG_OFFSET = HEADER_LEN;
var CONFIG_LEN = 496;
var RESERVED_OFF = 80;
var FLAG_RESOLVED = 1 << 0;
async function fetchSlab(connection, slabPubkey) {
  const info = await connection.getAccountInfo(slabPubkey);
  if (!info) {
    throw new Error(`Slab account not found: ${slabPubkey.toBase58()}`);
  }
  return new Uint8Array(info.data);
}
function parseHeader(data) {
  if (data.length < HEADER_LEN) {
    throw new Error(`Slab data too short for header: ${data.length} < ${HEADER_LEN}`);
  }
  const magic = readU64LE(data, 0);
  if (magic !== MAGIC) {
    throw new Error(`Invalid slab magic: expected ${MAGIC.toString(16)}, got ${magic.toString(16)}`);
  }
  const version = readU32LE(data, 8);
  const bump = readU8(data, 12);
  const flags = readU8(data, 13);
  const admin = new PublicKey3(data.subarray(16, 48));
  const nonce = readU64LE(data, RESERVED_OFF);
  const lastThrUpdateSlot = readU64LE(data, RESERVED_OFF + 8);
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
function parseConfig(data) {
  const minLen = CONFIG_OFFSET + CONFIG_LEN;
  if (data.length < minLen) {
    throw new Error(`Slab data too short for config: ${data.length} < ${minLen}`);
  }
  let off = CONFIG_OFFSET;
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
  const adaptiveFundingEnabled = readU8(data, off) !== 0;
  off += 1;
  off += 1;
  const adaptiveScaleBps = readU16LE(data, off);
  off += 2;
  off += 4;
  const adaptiveMaxFundingBps = readU64LE(data, off);
  off += 8;
  const marketCreatedSlot = readU64LE(data, off);
  off += 8;
  const oiRampSlots = readU64LE(data, off);
  off += 8;
  const resolvedSlot = readU64LE(data, off);
  off += 8;
  off += 8;
  const insuranceIsolationBps = readU16LE(data, off);
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
    insuranceIsolationBps
  };
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
  if (data.length < RESERVED_OFF + 8) {
    throw new Error("Slab data too short for nonce");
  }
  return readU64LE(data, RESERVED_OFF);
}
function readLastThrUpdateSlot(data) {
  if (data.length < RESERVED_OFF + 16) {
    throw new Error("Slab data too short for lastThrUpdateSlot");
  }
  return readU64LE(data, RESERVED_OFF + 8);
}
var ENGINE_OFF = 600;
var ENGINE_VAULT_OFF = 0;
var ENGINE_INSURANCE_OFF = 16;
var ENGINE_INSURANCE_ISOLATED_OFF = 48;
var ENGINE_INSURANCE_ISOLATION_BPS_OFF = 64;
var ENGINE_PARAMS_OFF = 72;
var ENGINE_CURRENT_SLOT_OFF = 360;
var ENGINE_FUNDING_INDEX_OFF = 368;
var ENGINE_LAST_FUNDING_SLOT_OFF = 384;
var ENGINE_FUNDING_RATE_BPS_OFF = 392;
var ENGINE_LAST_CRANK_SLOT_OFF = 424;
var ENGINE_MAX_CRANK_STALENESS_OFF = 432;
var ENGINE_TOTAL_OI_OFF = 440;
var ENGINE_LONG_OI_OFF = 456;
var ENGINE_SHORT_OI_OFF = 472;
var ENGINE_C_TOT_OFF = 488;
var ENGINE_PNL_POS_TOT_OFF = 504;
var ENGINE_LIQ_CURSOR_OFF = 520;
var ENGINE_GC_CURSOR_OFF = 522;
var ENGINE_LAST_SWEEP_START_OFF = 528;
var ENGINE_LAST_SWEEP_COMPLETE_OFF = 536;
var ENGINE_CRANK_CURSOR_OFF = 544;
var ENGINE_SWEEP_START_IDX_OFF = 546;
var ENGINE_LIFETIME_LIQUIDATIONS_OFF = 552;
var ENGINE_LIFETIME_FORCE_CLOSES_OFF = 560;
var ENGINE_NET_LP_POS_OFF = 568;
var ENGINE_LP_SUM_ABS_OFF = 584;
var ENGINE_LP_MAX_ABS_OFF = 600;
var ENGINE_LP_MAX_ABS_SWEEP_OFF = 616;
var ENGINE_EMERGENCY_OI_MODE_OFF = 632;
var ENGINE_EMERGENCY_START_SLOT_OFF = 640;
var ENGINE_LAST_BREAKER_SLOT_OFF = 648;
var ENGINE_BITMAP_OFF = 656;
var DEFAULT_MAX_ACCOUNTS = 4096;
var DEFAULT_BITMAP_WORDS = 64;
var ACCOUNT_SIZE = 248;
var ENGINE_ACCOUNTS_OFF = 9384;
function slabLayout(maxAccounts) {
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = ENGINE_BITMAP_OFF + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOff = Math.ceil(preAccountsLen / 8) * 8;
  return { bitmapWords, accountsOff, maxAccounts };
}
function detectLayout(dataLen) {
  for (const n of [64, 256, 1024, 4096]) {
    const layout = slabLayout(n);
    const expectedLen = ENGINE_OFF + layout.accountsOff + n * ACCOUNT_SIZE;
    if (dataLen === expectedLen) return layout;
  }
  return null;
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
function parseParams(data) {
  const base = ENGINE_OFF + ENGINE_PARAMS_OFF;
  if (data.length < base + 144) {
    throw new Error("Slab data too short for RiskParams");
  }
  return {
    warmupPeriodSlots: readU64LE(data, base + PARAMS_WARMUP_PERIOD_OFF),
    maintenanceMarginBps: readU64LE(data, base + PARAMS_MAINTENANCE_MARGIN_OFF),
    initialMarginBps: readU64LE(data, base + PARAMS_INITIAL_MARGIN_OFF),
    tradingFeeBps: readU64LE(data, base + PARAMS_TRADING_FEE_OFF),
    maxAccounts: readU64LE(data, base + PARAMS_MAX_ACCOUNTS_OFF),
    newAccountFee: readU128LE(data, base + PARAMS_NEW_ACCOUNT_FEE_OFF),
    riskReductionThreshold: readU128LE(data, base + PARAMS_RISK_THRESHOLD_OFF),
    maintenanceFeePerSlot: readU128LE(data, base + PARAMS_MAINTENANCE_FEE_OFF),
    maxCrankStalenessSlots: readU64LE(data, base + PARAMS_MAX_CRANK_STALENESS_OFF),
    liquidationFeeBps: readU64LE(data, base + PARAMS_LIQUIDATION_FEE_BPS_OFF),
    liquidationFeeCap: readU128LE(data, base + PARAMS_LIQUIDATION_FEE_CAP_OFF),
    liquidationBufferBps: readU64LE(data, base + PARAMS_LIQUIDATION_BUFFER_OFF),
    minLiquidationAbs: readU128LE(data, base + PARAMS_MIN_LIQUIDATION_OFF)
  };
}
function parseEngine(data) {
  const base = ENGINE_OFF;
  const layout = detectLayout(data.length);
  const minLen = layout ? layout.accountsOff : ENGINE_ACCOUNTS_OFF;
  if (data.length < base + minLen) {
    throw new Error("Slab data too short for RiskEngine");
  }
  return {
    vault: readU128LE(data, base + ENGINE_VAULT_OFF),
    insuranceFund: {
      balance: readU128LE(data, base + ENGINE_INSURANCE_OFF),
      feeRevenue: readU128LE(data, base + ENGINE_INSURANCE_OFF + 16),
      isolatedBalance: readU128LE(data, base + ENGINE_INSURANCE_ISOLATED_OFF),
      isolationBps: readU16LE(data, base + ENGINE_INSURANCE_ISOLATION_BPS_OFF)
    },
    currentSlot: readU64LE(data, base + ENGINE_CURRENT_SLOT_OFF),
    fundingIndexQpbE6: readI128LE(data, base + ENGINE_FUNDING_INDEX_OFF),
    lastFundingSlot: readU64LE(data, base + ENGINE_LAST_FUNDING_SLOT_OFF),
    fundingRateBpsPerSlotLast: readI64LE(data, base + ENGINE_FUNDING_RATE_BPS_OFF),
    lastCrankSlot: readU64LE(data, base + ENGINE_LAST_CRANK_SLOT_OFF),
    maxCrankStalenessSlots: readU64LE(data, base + ENGINE_MAX_CRANK_STALENESS_OFF),
    totalOpenInterest: readU128LE(data, base + ENGINE_TOTAL_OI_OFF),
    longOi: readU128LE(data, base + ENGINE_LONG_OI_OFF),
    shortOi: readU128LE(data, base + ENGINE_SHORT_OI_OFF),
    cTot: readU128LE(data, base + ENGINE_C_TOT_OFF),
    pnlPosTot: readU128LE(data, base + ENGINE_PNL_POS_TOT_OFF),
    liqCursor: readU16LE(data, base + ENGINE_LIQ_CURSOR_OFF),
    gcCursor: readU16LE(data, base + ENGINE_GC_CURSOR_OFF),
    lastSweepStartSlot: readU64LE(data, base + ENGINE_LAST_SWEEP_START_OFF),
    lastSweepCompleteSlot: readU64LE(data, base + ENGINE_LAST_SWEEP_COMPLETE_OFF),
    crankCursor: readU16LE(data, base + ENGINE_CRANK_CURSOR_OFF),
    sweepStartIdx: readU16LE(data, base + ENGINE_SWEEP_START_IDX_OFF),
    lifetimeLiquidations: readU64LE(data, base + ENGINE_LIFETIME_LIQUIDATIONS_OFF),
    lifetimeForceCloses: readU64LE(data, base + ENGINE_LIFETIME_FORCE_CLOSES_OFF),
    // LP Aggregates for funding rate calculation
    netLpPos: readI128LE(data, base + ENGINE_NET_LP_POS_OFF),
    lpSumAbs: readU128LE(data, base + ENGINE_LP_SUM_ABS_OFF),
    lpMaxAbs: readU128LE(data, base + ENGINE_LP_MAX_ABS_OFF),
    lpMaxAbsSweep: readU128LE(data, base + ENGINE_LP_MAX_ABS_SWEEP_OFF),
    emergencyOiMode: data[base + ENGINE_EMERGENCY_OI_MODE_OFF] !== 0,
    emergencyStartSlot: readU64LE(data, base + ENGINE_EMERGENCY_START_SLOT_OFF),
    lastBreakerSlot: readU64LE(data, base + ENGINE_LAST_BREAKER_SLOT_OFF),
    numUsedAccounts: (() => {
      const bw = layout ? layout.bitmapWords : DEFAULT_BITMAP_WORDS;
      return readU16LE(data, base + ENGINE_BITMAP_OFF + bw * 8);
    })(),
    nextAccountId: (() => {
      const bw = layout ? layout.bitmapWords : DEFAULT_BITMAP_WORDS;
      const numUsedOff = ENGINE_BITMAP_OFF + bw * 8;
      return readU64LE(data, base + Math.ceil((numUsedOff + 2) / 8) * 8);
    })()
  };
}
function parseUsedIndices(data) {
  const layout = detectLayout(data.length);
  const bitmapWords = layout ? layout.bitmapWords : DEFAULT_BITMAP_WORDS;
  const base = ENGINE_OFF + ENGINE_BITMAP_OFF;
  if (data.length < base + bitmapWords * 8) {
    throw new Error("Slab data too short for bitmap");
  }
  const used = [];
  for (let word = 0; word < bitmapWords; word++) {
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
  const layout = detectLayout(data.length);
  const maxAcc = layout ? layout.maxAccounts : DEFAULT_MAX_ACCOUNTS;
  if (!Number.isInteger(idx) || idx < 0 || idx >= maxAcc) return false;
  const base = ENGINE_OFF + ENGINE_BITMAP_OFF;
  const word = Math.floor(idx / 64);
  const bit = idx % 64;
  const bits = readU64LE(data, base + word * 8);
  return (bits >> BigInt(bit) & 1n) !== 0n;
}
function maxAccountIndex(dataLen) {
  const layout = detectLayout(dataLen);
  const accOff = layout ? layout.accountsOff : ENGINE_ACCOUNTS_OFF;
  const accountsEnd = dataLen - ENGINE_OFF - accOff;
  if (accountsEnd <= 0) return 0;
  return Math.floor(accountsEnd / ACCOUNT_SIZE);
}
function parseAccount(data, idx) {
  const maxIdx = maxAccountIndex(data.length);
  if (!Number.isInteger(idx) || idx < 0 || idx >= maxIdx) {
    throw new Error(`Account index out of range: ${idx} (max: ${maxIdx - 1})`);
  }
  const layout = detectLayout(data.length);
  const accOff = layout ? layout.accountsOff : ENGINE_ACCOUNTS_OFF;
  const base = ENGINE_OFF + accOff + idx * ACCOUNT_SIZE;
  if (data.length < base + ACCOUNT_SIZE) {
    throw new Error("Slab data too short for account");
  }
  const kindByte = readU8(data, base + ACCT_KIND_OFF);
  const kind = kindByte === 1 ? 1 /* LP */ : 0 /* User */;
  return {
    kind,
    accountId: readU64LE(data, base + ACCT_ACCOUNT_ID_OFF),
    capital: readU128LE(data, base + ACCT_CAPITAL_OFF),
    pnl: readI128LE(data, base + ACCT_PNL_OFF),
    reservedPnl: readU64LE(data, base + ACCT_RESERVED_PNL_OFF),
    warmupStartedAtSlot: readU64LE(data, base + ACCT_WARMUP_STARTED_OFF),
    warmupSlopePerStep: readU128LE(data, base + ACCT_WARMUP_SLOPE_OFF),
    positionSize: readI128LE(data, base + ACCT_POSITION_SIZE_OFF),
    entryPrice: readU64LE(data, base + ACCT_ENTRY_PRICE_OFF),
    fundingIndex: readI128LE(data, base + ACCT_FUNDING_INDEX_OFF),
    matcherProgram: new PublicKey3(data.subarray(base + ACCT_MATCHER_PROGRAM_OFF, base + ACCT_MATCHER_PROGRAM_OFF + 32)),
    matcherContext: new PublicKey3(data.subarray(base + ACCT_MATCHER_CONTEXT_OFF, base + ACCT_MATCHER_CONTEXT_OFF + 32)),
    owner: new PublicKey3(data.subarray(base + ACCT_OWNER_OFF, base + ACCT_OWNER_OFF + 32)),
    feeCredits: readI128LE(data, base + ACCT_FEE_CREDITS_OFF),
    lastFeeSlot: readU64LE(data, base + ACCT_LAST_FEE_SLOT_OFF)
  };
}
function parseAllAccounts(data) {
  const indices = parseUsedIndices(data);
  const maxIdx = maxAccountIndex(data.length);
  const validIndices = indices.filter((idx) => idx < maxIdx);
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
function deriveLpPda(programId, slab, lpIdx) {
  const idxBuf = new Uint8Array(2);
  new DataView(idxBuf.buffer).setUint16(0, lpIdx, true);
  return PublicKey4.findProgramAddressSync(
    [textEncoder.encode("lp"), slab.toBytes(), idxBuf],
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
function derivePythPushOraclePDA(feedIdHex) {
  const feedId = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    feedId[i] = parseInt(feedIdHex.substring(i * 2, i * 2 + 2), 16);
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
async function getAta(owner, mint, tokenProgramId = TOKEN_PROGRAM_ID2) {
  return getAssociatedTokenAddress(mint, owner, false, tokenProgramId);
}
function getAtaSync(owner, mint, tokenProgramId = TOKEN_PROGRAM_ID2) {
  return getAssociatedTokenAddressSync(mint, owner, false, tokenProgramId);
}
async function fetchTokenAccount(connection, address, tokenProgramId = TOKEN_PROGRAM_ID2) {
  return getAccount(connection, address, void 0, tokenProgramId);
}

// src/solana/discovery.ts
var ENGINE_BITMAP_OFF2 = 656;
var MAGIC_BYTES = new Uint8Array([84, 65, 76, 79, 67, 82, 69, 80]);
var SLAB_TIERS = {
  small: { maxAccounts: 256, dataSize: 65312, label: "Small", description: "256 slots \xB7 ~0.45 SOL" },
  medium: { maxAccounts: 1024, dataSize: 257408, label: "Medium", description: "1,024 slots \xB7 ~1.79 SOL" },
  large: { maxAccounts: 4096, dataSize: 1025792, label: "Large", description: "4,096 slots \xB7 ~7.14 SOL" }
};
function slabDataSize(maxAccounts) {
  const ENGINE_OFF_LOCAL = 600;
  const ENGINE_FIXED = 656;
  const ACCOUNT_SIZE2 = 248;
  const bitmapBytes = Math.ceil(maxAccounts / 64) * 8;
  const postBitmap = 18;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = ENGINE_FIXED + bitmapBytes + postBitmap + nextFreeBytes;
  const accountsOff = Math.ceil(preAccountsLen / 8) * 8;
  return ENGINE_OFF_LOCAL + accountsOff + maxAccounts * ACCOUNT_SIZE2;
}
function validateSlabTierMatch(dataSize, programSlabLen) {
  return dataSize === programSlabLen;
}
var ALL_SLAB_SIZES = Object.values(SLAB_TIERS).map((t) => t.dataSize);
var SLAB_DATA_SIZE = SLAB_TIERS.large.dataSize;
var HEADER_SLICE_LENGTH = 1900;
var ENGINE_OFF2 = 600;
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
function parseEngineLight(data, maxAccounts = 4096) {
  const base = ENGINE_OFF2;
  const minLen = base + ENGINE_BITMAP_OFF2;
  if (data.length < minLen) {
    throw new Error(`Slab data too short for engine light parse: ${data.length} < ${minLen}`);
  }
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const numUsedOff = ENGINE_BITMAP_OFF2 + bitmapWords * 8;
  const nextAccountIdOff = Math.ceil((numUsedOff + 2) / 8) * 8;
  const canReadNumUsed = data.length >= base + numUsedOff + 2;
  const canReadNextId = data.length >= base + nextAccountIdOff + 8;
  return {
    vault: readU128LE2(data, base + 0),
    insuranceFund: {
      balance: readU128LE2(data, base + 16),
      feeRevenue: readU128LE2(data, base + 32),
      isolatedBalance: readU128LE2(data, base + 48),
      isolationBps: readU16LE2(data, base + 64)
    },
    currentSlot: readU64LE2(data, base + 384),
    fundingIndexQpbE6: readI128LE2(data, base + 392),
    lastFundingSlot: readU64LE2(data, base + 384),
    fundingRateBpsPerSlotLast: readI64LE2(data, base + 392),
    lastCrankSlot: readU64LE2(data, base + 424),
    maxCrankStalenessSlots: readU64LE2(data, base + 456),
    totalOpenInterest: readU128LE2(data, base + 440),
    longOi: readU128LE2(data, base + 456),
    shortOi: readU128LE2(data, base + 472),
    cTot: readU128LE2(data, base + 488),
    pnlPosTot: readU128LE2(data, base + 552),
    liqCursor: readU16LE2(data, base + 568),
    gcCursor: readU16LE2(data, base + 546),
    lastSweepStartSlot: readU64LE2(data, base + 552),
    lastSweepCompleteSlot: readU64LE2(data, base + 584),
    crankCursor: readU16LE2(data, base + 568),
    sweepStartIdx: readU16LE2(data, base + 546),
    lifetimeLiquidations: readU64LE2(data, base + 552),
    lifetimeForceCloses: readU64LE2(data, base + 584),
    netLpPos: readI128LE2(data, base + 568),
    lpSumAbs: readU128LE2(data, base + 584),
    lpMaxAbs: readU128LE2(data, base + 600),
    lpMaxAbsSweep: readU128LE2(data, base + 640),
    emergencyOiMode: data[base + 632] !== 0,
    emergencyStartSlot: readU64LE2(data, base + 640),
    lastBreakerSlot: readU64LE2(data, base + 648),
    numUsedAccounts: canReadNumUsed ? readU16LE2(data, base + numUsedOff) : 0,
    nextAccountId: canReadNextId ? readU64LE2(data, base + nextAccountIdOff) : 0n
  };
}
async function discoverMarkets(connection, programId) {
  const ALL_TIERS = Object.values(SLAB_TIERS);
  let rawAccounts = [];
  try {
    const queries = ALL_TIERS.map(
      (tier) => connection.getProgramAccounts(programId, {
        filters: [{ dataSize: tier.dataSize }],
        dataSlice: { offset: 0, length: HEADER_SLICE_LENGTH }
      }).then((results2) => results2.map((entry) => ({ ...entry, maxAccounts: tier.maxAccounts })))
    );
    const results = await Promise.allSettled(queries);
    let hadRejection = false;
    for (const result of results) {
      if (result.status === "fulfilled") {
        for (const entry of result.value) {
          rawAccounts.push(entry);
        }
      } else {
        hadRejection = true;
        console.warn(
          "[discoverMarkets] Tier query rejected:",
          result.reason instanceof Error ? result.reason.message : result.reason
        );
      }
    }
    if (hadRejection && rawAccounts.length === 0) {
      console.warn("[discoverMarkets] All tier queries failed, falling back to memcmp");
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
      rawAccounts = [...fallback].map((e) => ({ ...e, maxAccounts: 4096 }));
    }
  } catch (err) {
    console.warn(
      "[discoverMarkets] dataSize filters failed, falling back to memcmp:",
      err instanceof Error ? err.message : err
    );
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
    rawAccounts = [...fallback].map((e) => ({ ...e, maxAccounts: 4096 }));
  }
  const accounts = rawAccounts;
  const markets = [];
  for (const { pubkey, account, maxAccounts } of accounts) {
    const data = new Uint8Array(account.data);
    let valid = true;
    for (let i = 0; i < MAGIC_BYTES.length; i++) {
      if (data[i] !== MAGIC_BYTES[i]) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;
    try {
      const header = parseHeader(data);
      const config = parseConfig(data);
      const engine = parseEngineLight(data, maxAccounts);
      const params = parseParams(data);
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

// src/solana/dex-oracle.ts
import { PublicKey as PublicKey5 } from "@solana/web3.js";
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
    baseMint: new PublicKey5(data.slice(35, 67)),
    quoteMint: new PublicKey5(data.slice(67, 99)),
    baseVault: new PublicKey5(data.slice(131, 163)),
    quoteVault: new PublicKey5(data.slice(163, 195))
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
    baseMint: new PublicKey5(data.slice(73, 105)),
    quoteMint: new PublicKey5(data.slice(105, 137))
  };
}
function computeRaydiumClmmPriceE6(data) {
  if (data.length < RAYDIUM_CLMM_MIN_LEN) {
    throw new Error(`Raydium CLMM data too short: ${data.length} < ${RAYDIUM_CLMM_MIN_LEN}`);
  }
  const dv3 = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decimals0 = data[233];
  const decimals1 = data[234];
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
    baseMint: new PublicKey5(data.slice(81, 113)),
    quoteMint: new PublicKey5(data.slice(113, 145))
  };
}
function computeMeteoraDlmmPriceE6(data) {
  if (data.length < METEORA_DLMM_MIN_LEN) {
    throw new Error(`Meteora DLMM data too short: ${data.length} < ${METEORA_DLMM_MIN_LEN}`);
  }
  const dv3 = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const binStep = dv3.getUint16(74, true);
  const activeId = dv3.getInt32(77, true);
  if (binStep === 0) return 0n;
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
import { PublicKey as PublicKey6 } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID as TOKEN_PROGRAM_ID3 } from "@solana/spl-token";
var TOKEN_2022_PROGRAM_ID = new PublicKey6(
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
import { PublicKey as PublicKey7, SystemProgram as SystemProgram2, SYSVAR_RENT_PUBKEY as SYSVAR_RENT_PUBKEY2, SYSVAR_CLOCK_PUBKEY as SYSVAR_CLOCK_PUBKEY2 } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID as TOKEN_PROGRAM_ID4 } from "@solana/spl-token";
var STAKE_PROGRAM_ID = new PublicKey7(
  "4mJ8CasWfJCGEjGNaJThNfFfUWJTfZLBwz6qmUGqxVMc"
);
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
function deriveStakePool(slab, programId = STAKE_PROGRAM_ID) {
  return PublicKey7.findProgramAddressSync(
    [Buffer.from("stake_pool"), slab.toBuffer()],
    programId
  );
}
function deriveStakeVaultAuth(pool, programId = STAKE_PROGRAM_ID) {
  return PublicKey7.findProgramAddressSync(
    [Buffer.from("vault_auth"), pool.toBuffer()],
    programId
  );
}
function deriveDepositPda(pool, user, programId = STAKE_PROGRAM_ID) {
  return PublicKey7.findProgramAddressSync(
    [Buffer.from("deposit"), pool.toBuffer(), user.toBuffer()],
    programId
  );
}
function u64Le(v) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(v));
  return buf;
}
function u128Le(v) {
  const buf = Buffer.alloc(16);
  const big = BigInt(v);
  buf.writeBigUInt64LE(big & 0xFFFFFFFFFFFFFFFFn, 0);
  buf.writeBigUInt64LE(big >> 64n, 8);
  return buf;
}
function u16Le(v) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(v);
  return buf;
}
function encodeStakeInitPool(cooldownSlots, depositCap) {
  return Buffer.concat([
    Buffer.from([STAKE_IX.InitPool]),
    u64Le(cooldownSlots),
    u64Le(depositCap)
  ]);
}
function encodeStakeDeposit(amount) {
  return Buffer.concat([Buffer.from([STAKE_IX.Deposit]), u64Le(amount)]);
}
function encodeStakeWithdraw(lpAmount) {
  return Buffer.concat([Buffer.from([STAKE_IX.Withdraw]), u64Le(lpAmount)]);
}
function encodeStakeFlushToInsurance(amount) {
  return Buffer.concat([Buffer.from([STAKE_IX.FlushToInsurance]), u64Le(amount)]);
}
function encodeStakeUpdateConfig(newCooldownSlots, newDepositCap) {
  return Buffer.concat([
    Buffer.from([STAKE_IX.UpdateConfig]),
    Buffer.from([newCooldownSlots != null ? 1 : 0]),
    u64Le(newCooldownSlots ?? 0n),
    Buffer.from([newDepositCap != null ? 1 : 0]),
    u64Le(newDepositCap ?? 0n)
  ]);
}
function encodeStakeTransferAdmin() {
  return Buffer.from([STAKE_IX.TransferAdmin]);
}
function encodeStakeAdminSetOracleAuthority(newAuthority) {
  return Buffer.concat([
    Buffer.from([STAKE_IX.AdminSetOracleAuthority]),
    newAuthority.toBuffer()
  ]);
}
function encodeStakeAdminSetRiskThreshold(newThreshold) {
  return Buffer.concat([
    Buffer.from([STAKE_IX.AdminSetRiskThreshold]),
    u128Le(newThreshold)
  ]);
}
function encodeStakeAdminSetMaintenanceFee(newFee) {
  return Buffer.concat([
    Buffer.from([STAKE_IX.AdminSetMaintenanceFee]),
    u128Le(newFee)
  ]);
}
function encodeStakeAdminResolveMarket() {
  return Buffer.from([STAKE_IX.AdminResolveMarket]);
}
function encodeStakeAdminWithdrawInsurance(amount) {
  return Buffer.concat([
    Buffer.from([STAKE_IX.AdminWithdrawInsurance]),
    u64Le(amount)
  ]);
}
function encodeStakeAccrueFees() {
  return Buffer.from([STAKE_IX.AccrueFees]);
}
function encodeStakeInitTradingPool(cooldownSlots, depositCap) {
  return Buffer.concat([
    Buffer.from([STAKE_IX.InitTradingPool]),
    u64Le(cooldownSlots),
    u64Le(depositCap)
  ]);
}
function encodeStakeAdminSetHwmConfig(enabled, hwmFloorBps) {
  return Buffer.concat([
    Buffer.from([STAKE_IX.AdminSetHwmConfig]),
    Buffer.from([enabled ? 1 : 0]),
    u16Le(hwmFloorBps)
  ]);
}
function encodeStakeAdminSetTrancheConfig(juniorFeeMultBps) {
  return Buffer.concat([
    Buffer.from([STAKE_IX.AdminSetTrancheConfig]),
    u16Le(juniorFeeMultBps)
  ]);
}
function encodeStakeDepositJunior(amount) {
  return Buffer.concat([Buffer.from([STAKE_IX.DepositJunior]), u64Le(amount)]);
}
function encodeStakeAdminSetInsurancePolicy(authority, minWithdrawBase, maxWithdrawBps, cooldownSlots) {
  return Buffer.concat([
    Buffer.from([STAKE_IX.AdminSetInsurancePolicy]),
    authority.toBuffer(),
    u64Le(minWithdrawBase),
    u16Le(maxWithdrawBps),
    u64Le(cooldownSlots)
  ]);
}
var STAKE_POOL_SIZE = 352;
function decodeStakePool(data) {
  if (data.length < STAKE_POOL_SIZE) {
    throw new Error(`StakePool data too short: ${data.length} < ${STAKE_POOL_SIZE}`);
  }
  const buf = Buffer.from(data);
  let off = 0;
  const isInitialized = buf[off] === 1;
  off += 1;
  const bump = buf[off];
  off += 1;
  const vaultAuthorityBump = buf[off];
  off += 1;
  const adminTransferred = buf[off] === 1;
  off += 1;
  off += 4;
  const slab = new PublicKey7(buf.subarray(off, off + 32));
  off += 32;
  const admin = new PublicKey7(buf.subarray(off, off + 32));
  off += 32;
  const collateralMint = new PublicKey7(buf.subarray(off, off + 32));
  off += 32;
  const lpMint = new PublicKey7(buf.subarray(off, off + 32));
  off += 32;
  const vault = new PublicKey7(buf.subarray(off, off + 32));
  off += 32;
  const totalDeposited = buf.readBigUInt64LE(off);
  off += 8;
  const totalLpSupply = buf.readBigUInt64LE(off);
  off += 8;
  const cooldownSlots = buf.readBigUInt64LE(off);
  off += 8;
  const depositCap = buf.readBigUInt64LE(off);
  off += 8;
  const totalFlushed = buf.readBigUInt64LE(off);
  off += 8;
  const totalReturned = buf.readBigUInt64LE(off);
  off += 8;
  const totalWithdrawn = buf.readBigUInt64LE(off);
  off += 8;
  const percolatorProgram = new PublicKey7(buf.subarray(off, off + 32));
  off += 32;
  const totalFeesEarned = buf.readBigUInt64LE(off);
  off += 8;
  const lastFeeAccrualSlot = buf.readBigUInt64LE(off);
  off += 8;
  const lastVaultSnapshot = buf.readBigUInt64LE(off);
  off += 8;
  const poolMode = buf[off];
  off += 1;
  off += 7;
  const reservedStart = off;
  const hwmEnabled = buf[reservedStart + 9] === 1;
  const hwmTvlLow = buf.readBigUInt64LE(reservedStart + 10);
  const hwmTvlHigh = buf.readBigUInt64LE(reservedStart + 18);
  const epochHighWaterTvl = hwmTvlLow + (hwmTvlHigh << 64n);
  const hwmFloorBps = buf.readUInt16LE(reservedStart + 26);
  const trancheEnabled = buf[reservedStart + 32] === 1;
  const juniorBalance = buf.readBigUInt64LE(reservedStart + 33);
  const juniorTotalLp = buf.readBigUInt64LE(reservedStart + 41);
  const juniorFeeMultBps = buf.readUInt16LE(reservedStart + 49);
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

// src/runtime/tx.ts
import {
  TransactionInstruction,
  Transaction,
  ComputeBudgetProgram
} from "@solana/web3.js";
function buildIx(params) {
  return new TransactionInstruction({
    programId: params.programId,
    keys: params.keys,
    // TransactionInstruction types expect Buffer, but Uint8Array works at runtime.
    // Cast to avoid Buffer polyfill issues in the browser.
    data: params.data
  });
}
async function simulateOrSend(params) {
  const { connection, ix, signers, simulate, commitment = "confirmed", computeUnitLimit } = params;
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
  const fee = absPos * feeBps / 10000n;
  const effectiveCapital = margin > fee ? margin - fee : 0n;
  const signedPos = direction === "long" ? absPos : -absPos;
  return computeLiqPrice(oracleE6, effectiveCapital, signedPos, maintBps);
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
  return Number(scaledPct) / 100;
}
function computeEstimatedEntryPrice(oracleE6, tradingFeeBps, direction) {
  if (oracleE6 === 0n) return 0n;
  const feeImpact = oracleE6 * tradingFeeBps / 10000n;
  return direction === "long" ? oracleE6 + feeImpact : oracleE6 - feeImpact;
}
function computeFundingRateAnnualized(fundingRateBpsPerSlot) {
  const bpsPerSlot = Number(fundingRateBpsPerSlot);
  const slotsPerYear = 2.5 * 60 * 60 * 24 * 365;
  return bpsPerSlot * slotsPerYear / 100;
}
function computeRequiredMargin(notional, initialMarginBps) {
  return notional * initialMarginBps / 10000n;
}
function computeMaxLeverage(initialMarginBps) {
  if (initialMarginBps === 0n) return 1;
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
import { PublicKey as PublicKey9 } from "@solana/web3.js";
var U16_MAX = 65535;
var U64_MAX = BigInt("18446744073709551615");
var I64_MIN = BigInt("-9223372036854775808");
var I64_MAX = BigInt("9223372036854775807");
var U128_MAX = (1n << 128n) - 1n;
var I128_MIN = -(1n << 127n);
var I128_MAX = (1n << 127n) - 1n;
var ValidationError = class extends Error {
  constructor(field, message) {
    super(`Invalid ${field}: ${message}`);
    this.field = field;
    this.name = "ValidationError";
  }
};
function validatePublicKey(value, field) {
  try {
    return new PublicKey9(value);
  } catch {
    throw new ValidationError(
      field,
      `"${value}" is not a valid base58 public key. Example: "11111111111111111111111111111111"`
    );
  }
}
function validateIndex(value, field) {
  const num = parseInt(value, 10);
  if (isNaN(num)) {
    throw new ValidationError(field, `"${value}" is not a valid number`);
  }
  if (num < 0) {
    throw new ValidationError(field, `must be non-negative, got ${num}`);
  }
  if (num > U16_MAX) {
    throw new ValidationError(
      field,
      `must be <= ${U16_MAX} (u16 max), got ${num}`
    );
  }
  return num;
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
  const num = parseInt(value, 10);
  if (isNaN(num)) {
    throw new ValidationError(field, `"${value}" is not a valid number`);
  }
  if (num < 0) {
    throw new ValidationError(field, `must be non-negative, got ${num}`);
  }
  if (num > 1e4) {
    throw new ValidationError(
      field,
      `must be <= 10000 (100%), got ${num}`
    );
  }
  return num;
}
function validateU64(value, field) {
  return validateAmount(value, field);
}
function validateU16(value, field) {
  const num = parseInt(value, 10);
  if (isNaN(num)) {
    throw new ValidationError(field, `"${value}" is not a valid number`);
  }
  if (num < 0) {
    throw new ValidationError(field, `must be non-negative, got ${num}`);
  }
  if (num > U16_MAX) {
    throw new ValidationError(
      field,
      `must be <= ${U16_MAX} (u16 max), got ${num}`
    );
  }
  return num;
}

// src/oracle/price-router.ts
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
var SUPPORTED_DEX_IDS = /* @__PURE__ */ new Set(["pumpswap", "raydium", "meteora"]);
async function fetchDexSources(mint, signal) {
  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal,
      headers: { "User-Agent": "percolator/1.0" }
    });
    const json = await resp.json();
    const pairs = json.pairs || [];
    const sources = [];
    for (const pair of pairs) {
      if (pair.chainId !== "solana") continue;
      const dexId = (pair.dexId || "").toLowerCase();
      if (!SUPPORTED_DEX_IDS.has(dexId)) continue;
      const liquidity = pair.liquidity?.usd || 0;
      if (liquidity < 100) continue;
      let confidence = 30;
      if (liquidity > 1e6) confidence = 90;
      else if (liquidity > 1e5) confidence = 75;
      else if (liquidity > 1e4) confidence = 60;
      else if (liquidity > 1e3) confidence = 45;
      sources.push({
        type: "dex",
        address: pair.pairAddress,
        dexId,
        pairLabel: `${pair.baseToken?.symbol || "?"} / ${pair.quoteToken?.symbol || "?"}`,
        liquidity,
        price: parseFloat(pair.priceUsd) || 0,
        confidence
      });
    }
    sources.sort((a, b) => b.liquidity - a.liquidity);
    return sources.slice(0, 10);
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
    const resp = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`, {
      signal,
      headers: { "User-Agent": "percolator/1.0" }
    });
    const json = await resp.json();
    const data = json.data?.[mint];
    if (!data || !data.price) return null;
    return {
      type: "jupiter",
      address: mint,
      pairLabel: `${data.mintSymbol || "?"} / USD (Jupiter)`,
      liquidity: 0,
      // Jupiter aggregator — no single pool liquidity
      price: parseFloat(data.price) || 0,
      confidence: 40
      // Fallback — lower confidence
    };
  } catch {
    return null;
  }
}
async function resolvePrice(mint, signal) {
  const [dexSources, jupiterSource] = await Promise.all([
    fetchDexSources(mint, signal),
    fetchJupiterSource(mint, signal)
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

// src/config/program-ids.ts
import { PublicKey as PublicKey10 } from "@solana/web3.js";
var PROGRAM_IDS = {
  devnet: {
    percolator: "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",
    matcher: "GTRgyTDfrMvBubALAqtHuQwT8tbGyXid7svXZKtWfC9k"
  },
  mainnet: {
    percolator: "GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24",
    matcher: ""
    // TODO: Deploy matcher to mainnet
  }
};
function getProgramId(network) {
  if (process.env.PROGRAM_ID) {
    return new PublicKey10(process.env.PROGRAM_ID);
  }
  const targetNetwork = network ?? process.env.NETWORK ?? "devnet";
  const programId = PROGRAM_IDS[targetNetwork].percolator;
  return new PublicKey10(programId);
}
function getMatcherProgramId(network) {
  if (process.env.MATCHER_PROGRAM_ID) {
    return new PublicKey10(process.env.MATCHER_PROGRAM_ID);
  }
  const targetNetwork = network ?? process.env.NETWORK ?? "devnet";
  const programId = PROGRAM_IDS[targetNetwork].matcher;
  if (!programId) {
    throw new Error(`Matcher program not deployed on ${targetNetwork}`);
  }
  return new PublicKey10(programId);
}
function getCurrentNetwork() {
  const network = process.env.NETWORK?.toLowerCase();
  if (network === "mainnet" || network === "mainnet-beta") {
    return "mainnet";
  }
  return "devnet";
}
export {
  ACCOUNTS_CLOSE_ACCOUNT,
  ACCOUNTS_CLOSE_SLAB,
  ACCOUNTS_CREATE_INSURANCE_MINT,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_DEPOSIT_INSURANCE_LP,
  ACCOUNTS_EXECUTE_ADL,
  ACCOUNTS_FUND_MARKET_INSURANCE,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_LIQUIDATE_AT_ORACLE,
  ACCOUNTS_PAUSE_MARKET,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_RESOLVE_MARKET,
  ACCOUNTS_SET_INSURANCE_ISOLATION,
  ACCOUNTS_SET_MAINTENANCE_FEE,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_SET_ORACLE_PRICE_CAP,
  ACCOUNTS_SET_RISK_THRESHOLD,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_TRADE_CPI,
  ACCOUNTS_TRADE_NOCPI,
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
  CTX_VAMM_OFFSET,
  DEFAULT_OI_RAMP_SLOTS,
  IX_TAG,
  MARK_PRICE_EMA_ALPHA_E6,
  MARK_PRICE_EMA_WINDOW_SLOTS,
  MAX_DECIMALS,
  METEORA_DLMM_PROGRAM_ID,
  PERCOLATOR_ERRORS,
  PROGRAM_IDS,
  PUMPSWAP_PROGRAM_ID,
  PYTH_PUSH_ORACLE_PROGRAM_ID,
  PYTH_RECEIVER_PROGRAM_ID,
  PYTH_SOLANA_FEEDS,
  RAMP_START_BPS,
  RAYDIUM_CLMM_PROGRAM_ID,
  SLAB_TIERS,
  STAKE_IX,
  STAKE_POOL_SIZE,
  STAKE_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  VAMM_MAGIC,
  ValidationError,
  WELL_KNOWN,
  buildAccountMetas,
  buildIx,
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
  deriveDepositPda,
  deriveInsuranceLpMint,
  deriveLpPda,
  derivePythPriceUpdateAccount,
  derivePythPushOraclePDA,
  deriveStakePool,
  deriveStakeVaultAuth,
  deriveVaultAuthority,
  detectDexType,
  detectLayout,
  detectTokenProgram,
  discoverMarkets,
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
  encodeCloseAccount,
  encodeCloseSlab,
  encodeCreateInsuranceMint,
  encodeDepositCollateral,
  encodeDepositInsuranceLP,
  encodeFundMarketInsurance,
  encodeInitLP,
  encodeInitMarket,
  encodeInitUser,
  encodeKeeperCrank,
  encodeLiquidateAtOracle,
  encodePauseMarket,
  encodePushOraclePrice,
  encodeRenounceAdmin,
  encodeResolveMarket,
  encodeSetInsuranceIsolation,
  encodeSetMaintenanceFee,
  encodeSetOracleAuthority,
  encodeSetOraclePriceCap,
  encodeSetPythOracle,
  encodeSetRiskThreshold,
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
  encodeTradeCpi,
  encodeTradeCpiV2,
  encodeTradeNoCpi,
  encodeUnpauseMarket,
  encodeUpdateAdmin,
  encodeUpdateConfig,
  encodeUpdateHyperpMark,
  encodeUpdateMarkPrice,
  encodeUpdateRiskParams,
  encodeWithdrawCollateral,
  encodeWithdrawInsurance,
  encodeWithdrawInsuranceLP,
  fetchSlab,
  fetchTokenAccount,
  flushToInsuranceAccounts,
  formatResult,
  getAta,
  getAtaSync,
  getCurrentNetwork,
  getErrorHint,
  getErrorName,
  getMatcherProgramId,
  getProgramId,
  initPoolAccounts,
  isAccountUsed,
  isStandardToken,
  isToken2022,
  isValidChainlinkOracle,
  maxAccountIndex,
  parseAccount,
  parseAllAccounts,
  parseChainlinkPrice,
  parseConfig,
  parseDexPool,
  parseEngine,
  parseErrorFromLogs,
  parseHeader,
  parseParams,
  parseUsedIndices,
  readLastThrUpdateSlot,
  readNonce,
  resolvePrice,
  simulateOrSend,
  slabDataSize,
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