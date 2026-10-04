/**
 * Pure byte decoders for the limits UI (plan §1). Offsets come only from
 * `./constants` (verified against branch source). Every decoder is total: it
 * returns `null` for a too-short buffer or for bytes the program itself would
 * refuse (non-zero reserved bytes, inconsistent flags), so the UI can show
 * "limits unavailable" instead of a guessed number.
 */
import * as C from "./constants";

function dv(d: Uint8Array): DataView {
  return new DataView(d.buffer, d.byteOffset, d.byteLength);
}
export function u128(d: Uint8Array, off: number): bigint {
  const v = dv(d);
  return v.getBigUint64(off, true) | (v.getBigUint64(off + 8, true) << 64n);
}
export function i128(d: Uint8Array, off: number): bigint {
  const v = dv(d);
  return v.getBigUint64(off, true) | (v.getBigInt64(off + 8, true) << 64n);
}
const u64 = (d: Uint8Array, off: number): bigint => dv(d).getBigUint64(off, true);
const u32 = (d: Uint8Array, off: number): number => dv(d).getUint32(off, true);
const u16 = (d: Uint8Array, off: number): number => dv(d).getUint16(off, true);
const allZero = (d: Uint8Array, off: number, len: number): boolean => {
  for (let k = off; k < off + len; k++) if (d[k] !== 0) return false;
  return true;
};

// ── Market slab ──────────────────────────────────────────────────────────────

export interface MarketEngineView {
  currentSlot: bigint;
  mode: number;
  initialMarginBps: bigint;
  maintenanceMarginBps: bigint;
  maxTradingFeeBps: bigint;
  maxAbsFundingE9PerSlot: bigint;
  tradeFeeBaseBps: bigint;
  marketId: bigint;
  effectivePriceE6: bigint;
  /** UX WP-4: the oracle target the effective price is catching up to (Earn worse-of pricing). */
  targetPriceE6: bigint;
  aLong: bigint;
  aShort: bigint;
  oiEffLongQ: bigint;
  oiEffShortQ: bigint;
  modeLong: number;
  modeShort: number;
  /** Side reset epochs; a leg whose `epoch_snap` differs is from before a reset (M-3). */
  epochLong: bigint;
  epochShort: bigint;
  /** Money + epoch fields for the P3 vault valuation (harvestable fees, cert currency). */
  vaultAtoms: bigint;
  insuranceAtoms: bigint;
  sourceInsuranceCreditReservedTotal: bigint;
  insuranceDomainBudgetRemainingTotal: bigint;
  lpFeeAccruedAtoms: bigint;
  lpFeeWithdrawnAtoms: bigint;
  riskEpoch: bigint;
  assetSetEpoch: bigint;
  oracleEpoch: bigint;
  fundingEpoch: bigint;
}

/** Bytes needed to decode asset `i`'s engine view and wrapper-slot records. */
export const marketLimitsSliceLen = (i = 0): number => C.assetEngineOff(i) + 1301;

/** A v18 wrapper MARKET account header (magic, version 18, kind 1). v17 slabs have another layout. */
export function isV18MarketHeader(d: Uint8Array): boolean {
  if (d.length < C.HEADER_LEN) return false;
  const v = dv(d);
  return v.getBigUint64(0, true) === C.WRAPPER_MAGIC && v.getUint16(8, true) === C.WRAPPER_VERSION_V18 && d[C.HEADER_KIND_OFF] === C.KIND_MARKET_ACCOUNT;
}

export function decodeMarketEngineView(d: Uint8Array, assetIndex = 0): MarketEngineView | null {
  const e = C.assetEngineOff(assetIndex);
  if (d.length < e + C.A_MODE_SHORT + 1) return null;
  // Never read these offsets off a non-v18 account (a v17 slab reads a_long = a_short = 0,
  // which would look like the ADL reduce-only state).
  if (!isV18MarketHeader(d)) return null;
  const g = C.MARKET_GROUP_OFF;
  const cfg = g + C.H_CONFIG;
  return {
    currentSlot: u64(d, g + C.H_CURRENT_SLOT),
    mode: d[g + C.H_MODE],
    initialMarginBps: u64(d, cfg + C.CFG_INITIAL_MARGIN_BPS),
    maintenanceMarginBps: u64(d, cfg + C.CFG_MAINTENANCE_MARGIN_BPS),
    maxTradingFeeBps: u64(d, cfg + C.CFG_MAX_TRADING_FEE_BPS),
    maxAbsFundingE9PerSlot: u64(d, cfg + C.CFG_MAX_ABS_FUNDING_E9_PER_SLOT),
    tradeFeeBaseBps: u64(d, C.HEADER_LEN + C.WCFG_TRADE_FEE_BASE_BPS),
    marketId: u64(d, e + C.A_MARKET_ID),
    effectivePriceE6: u64(d, e + C.A_EFFECTIVE_PRICE),
    targetPriceE6: u64(d, e + C.A_RAW_ORACLE_TARGET_PRICE),
    aLong: u128(d, e + C.A_A_LONG),
    aShort: u128(d, e + C.A_A_SHORT),
    oiEffLongQ: u128(d, e + C.A_OI_EFF_LONG_Q),
    oiEffShortQ: u128(d, e + C.A_OI_EFF_SHORT_Q),
    modeLong: d[e + C.A_MODE_LONG],
    modeShort: d[e + C.A_MODE_SHORT],
    epochLong: u64(d, e + C.A_EPOCH_LONG),
    epochShort: u64(d, e + C.A_EPOCH_SHORT),
    vaultAtoms: u128(d, g + C.H_VAULT),
    insuranceAtoms: u128(d, g + C.H_INSURANCE),
    sourceInsuranceCreditReservedTotal: u128(d, g + C.H_SOURCE_INSURANCE_CREDIT_RESERVED_TOTAL),
    insuranceDomainBudgetRemainingTotal: u128(d, g + C.H_INSURANCE_DOMAIN_BUDGET_REMAINING_TOTAL),
    lpFeeAccruedAtoms: u128(d, C.HEADER_LEN + C.WCFG_LP_FEE_ACCRUED_ATOMS),
    lpFeeWithdrawnAtoms: u128(d, C.HEADER_LEN + C.WCFG_LP_FEE_WITHDRAWN_ATOMS),
    riskEpoch: u64(d, g + C.H_RISK_EPOCH),
    assetSetEpoch: u64(d, g + C.H_ASSET_SET_EPOCH),
    oracleEpoch: u64(d, g + C.H_ORACLE_EPOCH),
    fundingEpoch: u64(d, g + C.H_FUNDING_EPOCH),
  };
}

export interface AssetRiskLimits {
  sideOiCapQ: bigint;
  lpFloorAtoms: bigint;
  lpExposureKBps: number;
  execBandBps: number;
  matcherExtMode: number;
  /** P2 fee channel protocol maximum (bps); 0 = channel off. */
  maxRequestedFeeBps: number;
  /** True when every field is zero (deployed/zeroed slot = all protocol defaults). */
  allDefault: boolean;
}

/** P1 `AssetRiskLimitsV17`; null when too short or when `validate_asset_risk_limits` would refuse. */
export function decodeAssetRiskLimits(d: Uint8Array, assetIndex = 0): AssetRiskLimits | null {
  const b = C.assetWrapperOff(assetIndex) + C.ASSET_RISK_LIMITS_OFF;
  if (d.length < b + C.ASSET_RISK_LIMITS_LEN) return null;
  if (d[b + C.RL_RESERVED0] !== 0 || !allZero(d, b + C.RL_RESERVED, C.RL_RESERVED_LEN)) return null;
  const r: AssetRiskLimits = {
    sideOiCapQ: u128(d, b + C.RL_SIDE_OI_CAP_Q),
    lpFloorAtoms: u128(d, b + C.RL_LP_FLOOR_ATOMS),
    lpExposureKBps: u32(d, b + C.RL_LP_EXPOSURE_K_BPS),
    execBandBps: u16(d, b + C.RL_EXEC_BAND_BPS),
    matcherExtMode: d[b + C.RL_MATCHER_EXT_MODE],
    maxRequestedFeeBps: u16(d, b + C.RL_MAX_REQUESTED_FEE_BPS),
    allDefault: allZero(d, b, C.ASSET_RISK_LIMITS_LEN),
  };
  if (
    r.matcherExtMode > C.MATCHER_EXT_MODE_V1 ||
    r.execBandBps > C.MAX_EXEC_BAND_BPS ||
    r.lpExposureKBps > C.MAX_LP_EXPOSURE_K_BPS ||
    r.maxRequestedFeeBps > C.MAX_REQUESTED_FEE_BPS
  ) {
    return null;
  }
  return r;
}

export interface AssetVaultLp {
  bound: boolean;
  vaultLpPortfolio: Uint8Array;
  lpNetQ: bigint;
  levCapQ: bigint;
  lpNetSlot: bigint;
  skewSlopeE9: bigint;
  skewMaxE9: bigint;
  levMaxImrBps: number;
  /** P3-H2 vault-LP exposure cap, bps of conservative equity (0 = default 1x). */
  vaultLpMaxLevBps: number;
  approvedMatcherProgram: Uint8Array;
}

/** P3 `AssetVaultLpV18` (@8d651c45); null when too short or `validate_asset_vault_lp` would refuse. */
export function decodeAssetVaultLp(d: Uint8Array, assetIndex = 0): AssetVaultLp | null {
  const b = C.assetWrapperOff(assetIndex) + C.ASSET_VAULT_LP_OFF;
  if (d.length < b + C.ASSET_VAULT_LP_LEN) return null;
  const flags = d[b + C.AV_FLAGS];
  const key = d.slice(b + C.AV_VAULT_LP_PORTFOLIO, b + C.AV_VAULT_LP_PORTFOLIO + 32);
  const bound = (flags & C.ASSET_VAULT_LP_FLAG_BOUND) !== 0;
  const levMaxImrBps = u16(d, b + C.AV_LEV_MAX_IMR_BPS);
  const vaultLpMaxLevBps = u32(d, b + C.AV_VAULT_LP_MAX_LEV_BPS);
  if (
    (flags & ~C.ASSET_VAULT_LP_FLAG_BOUND) !== 0 ||
    d[b + C.AV_RESERVED0] !== 0 ||
    vaultLpMaxLevBps > C.VAULT_LP_MAX_LEV_BPS ||
    levMaxImrBps > 10_000 ||
    bound !== !allZero(key, 0, 32)
  ) {
    return null;
  }
  return {
    bound,
    vaultLpPortfolio: key,
    lpNetQ: i128(d, b + C.AV_LP_NET_Q),
    levCapQ: u128(d, b + C.AV_LEV_CAP_Q),
    lpNetSlot: u64(d, b + C.AV_LP_NET_SLOT),
    skewSlopeE9: u64(d, b + C.AV_SKEW_SLOPE_E9),
    skewMaxE9: u64(d, b + C.AV_SKEW_MAX_E9),
    levMaxImrBps,
    vaultLpMaxLevBps,
    approvedMatcherProgram: d.slice(b + C.AV_APPROVED_MATCHER_PROGRAM, b + C.AV_APPROVED_MATCHER_PROGRAM + 32),
  };
}

// ── Portfolio ────────────────────────────────────────────────────────────────

export interface HealthCertView {
  certifiedEquity: bigint;
  oracleEpoch: bigint;
  fundingEpoch: bigint;
  riskEpoch: bigint;
  assetSetEpoch: bigint;
  activeBitmapAtCert: bigint;
  /** Raw bool byte: 0/1 are the only values the engine decodes (anything else => not current). */
  validByte: number;
}

export interface PortfolioRiskView {
  owner: Uint8Array;
  capital: bigint;
  pnl: bigint;
  feeCredits: bigint;
  activeBitmap: bigint;
  staleState: number;
  bStaleState: number;
  cert: HealthCertView;
}

export function decodePortfolioRisk(d: Uint8Array): PortfolioRiskView | null {
  if (d.length < C.PF_B_STALE_STATE + 1) return null;
  return {
    owner: d.slice(C.PF_OWNER, C.PF_OWNER + 32),
    capital: u128(d, C.PF_CAPITAL),
    pnl: i128(d, C.PF_PNL),
    feeCredits: i128(d, C.PF_FEE_CREDITS),
    activeBitmap: u64(d, C.PF_ACTIVE_BITMAP),
    staleState: d[C.PF_STALE_STATE],
    bStaleState: d[C.PF_B_STALE_STATE],
    cert: {
      certifiedEquity: i128(d, C.PF_HEALTH_CERT + C.CERT_EQUITY),
      oracleEpoch: u64(d, C.PF_HEALTH_CERT + C.CERT_ORACLE_EPOCH),
      fundingEpoch: u64(d, C.PF_HEALTH_CERT + C.CERT_FUNDING_EPOCH),
      riskEpoch: u64(d, C.PF_HEALTH_CERT + C.CERT_RISK_EPOCH),
      assetSetEpoch: u64(d, C.PF_HEALTH_CERT + C.CERT_ASSET_SET_EPOCH),
      activeBitmapAtCert: u64(d, C.PF_HEALTH_CERT + C.CERT_ACTIVE_BITMAP),
      validByte: d[C.PF_HEALTH_CERT + C.CERT_VALID],
    },
  };
}

export interface PortfolioLegView {
  slot: number;
  assetIndex: number;
  /** 0 Long, 1 Short (engine encode_side). */
  side: number;
  /** Raw `basis_pos_q` (i128), NOT the ADL-scaled position. */
  basisPosQ: bigint;
}

/** Every ACTIVE leg (slot order), as the wrapper iterates `lp.legs` (UX WP-4 worse-of bounds). */
export function decodePortfolioLegs(d: Uint8Array): PortfolioLegView[] {
  if (d.length < C.PF_LEGS + C.PF_MAX_LEGS * C.PF_LEG_LEN) return [];
  const v = dv(d);
  const out: PortfolioLegView[] = [];
  for (let s = 0; s < C.PF_MAX_LEGS; s++) {
    const l = C.PF_LEGS + s * C.PF_LEG_LEN;
    if (d[l + C.LEG_ACTIVE] !== 1) continue;
    out.push({ slot: s, assetIndex: v.getUint32(l + C.LEG_ASSET_INDEX, true), side: d[l + C.LEG_SIDE], basisPosQ: i128(d, l + C.LEG_BASIS_POS_Q) });
  }
  return out;
}

/**
 * Port of wrapper `signed_position_for_asset_view`: the first active leg for
 * `(assetIndex, marketId)`, `+|basis|` Long / `-|basis|` Short. BASIS, not
 * ADL-scaled — exactly what P1's caps use.
 */
export function signedPositionForAsset(d: Uint8Array, assetIndex: number, marketId: bigint): bigint {
  if (d.length < C.PF_LEGS + C.PF_MAX_LEGS * C.PF_LEG_LEN) return 0n;
  const v = dv(d);
  for (let s = 0; s < C.PF_MAX_LEGS; s++) {
    const l = C.PF_LEGS + s * C.PF_LEG_LEN;
    if (d[l + C.LEG_ACTIVE] !== 1) continue;
    if (v.getUint32(l + C.LEG_ASSET_INDEX, true) !== assetIndex) continue;
    if (v.getBigUint64(l + C.LEG_MARKET_ID, true) !== marketId) continue;
    const basis = i128(d, l + C.LEG_BASIS_POS_Q);
    const mag = basis < 0n ? -basis : basis;
    return d[l + C.LEG_SIDE] === 0 ? mag : -mag;
  }
  return 0n;
}

// ── Matcher context (P2) ─────────────────────────────────────────────────────

export interface V2BlockView {
  flags: number;
  feeLoBps: number;
  feeHiBps: number;
  feeColdBps: number;
  volAMilli: number;
  volBDen: number;
  volAlphaBps: number;
  volWarmupLeft: number;
  volMoveCap10bps: number;
  volRefSlots: number;
  thinRebateMultBps: number;
  skewCapBps: number;
  rebateCapBps: number;
  maxMarkAgeSlots: number;
  observedStaleSlots: number;
  boundAssetPlus1: number;
  skewRefInventory: bigint;
  volVarE4: bigint;
  volLastPriceE6: bigint;
  volLastSlot: bigint;
}

export interface MatcherCtxView {
  kind: number;
  tradingFeeBps: number;
  baseSpreadBps: number;
  maxTotalBps: number;
  impactKBps: number;
  liquidityNotionalE6: bigint;
  maxFillAbs: bigint;
  inventoryBase: bigint;
  maxInventoryAbs: bigint;
  feeToInsuranceBps: number;
  skewSpreadMultBps: number;
  /** null = no v2 block (every v1 context; marker byte 0). */
  v2: V2BlockView | null;
}

export function decodeMatcherCtx(d: Uint8Array): MatcherCtxView | null {
  if (d.length < C.MC_V2_BLOCK + C.V2_BLOCK_LEN) return null;
  const b = C.MC_V2_BLOCK;
  const v2: V2BlockView | null =
    d[b + C.V2.version] !== C.V2_BLOCK_VERSION
      ? null
      : {
          flags: d[b + C.V2.flags],
          feeLoBps: u16(d, b + C.V2.feeLoBps),
          feeHiBps: u16(d, b + C.V2.feeHiBps),
          feeColdBps: u16(d, b + C.V2.feeColdBps),
          volAMilli: u16(d, b + C.V2.volAMilli),
          volBDen: u16(d, b + C.V2.volBDen),
          volAlphaBps: u16(d, b + C.V2.volAlphaBps),
          volWarmupLeft: d[b + C.V2.volWarmupLeft],
          volMoveCap10bps: d[b + C.V2.volMoveCap10bps],
          volRefSlots: u16(d, b + C.V2.volRefSlots),
          thinRebateMultBps: u16(d, b + C.V2.thinRebateMultBps),
          skewCapBps: u16(d, b + C.V2.skewCapBps),
          rebateCapBps: u16(d, b + C.V2.rebateCapBps),
          maxMarkAgeSlots: u16(d, b + C.V2.maxMarkAgeSlots),
          observedStaleSlots: u16(d, b + C.V2.observedStaleSlots),
          boundAssetPlus1: u16(d, b + C.V2.boundAssetPlus1),
          skewRefInventory: u64(d, b + C.V2.skewRefInventory),
          volVarE4: u64(d, b + C.V2.volVarE4),
          volLastPriceE6: u64(d, b + C.V2.volLastPriceE6),
          volLastSlot: u64(d, b + C.V2.volLastSlot),
        };
  return {
    kind: d[C.MC_KIND],
    tradingFeeBps: u32(d, C.MC_TRADING_FEE_BPS),
    baseSpreadBps: u32(d, C.MC_BASE_SPREAD_BPS),
    maxTotalBps: u32(d, C.MC_MAX_TOTAL_BPS),
    impactKBps: u32(d, C.MC_IMPACT_K_BPS),
    liquidityNotionalE6: u128(d, C.MC_LIQUIDITY_NOTIONAL_E6),
    maxFillAbs: u128(d, C.MC_MAX_FILL_ABS),
    inventoryBase: i128(d, C.MC_INVENTORY_BASE),
    maxInventoryAbs: u128(d, C.MC_MAX_INVENTORY_ABS),
    feeToInsuranceBps: u16(d, C.MC_FEE_TO_INSURANCE_BPS),
    skewSpreadMultBps: u16(d, C.MC_SKEW_SPREAD_MULT_BPS),
    v2,
  };
}

// ── P3 vault state PDA ───────────────────────────────────────────────────────

export interface VaultLpStateView {
  seniorClaimAtoms: bigint;
  juniorDepositedAtoms: bigint;
  juniorWithdrawnAtoms: bigint;
  seniorFeeCreditedAtoms: bigint;
  recalledAtoms: bigint;
  assetIndex: number;
  juniorFloorBps: number;
  seniorFeeShareBps: number;
  lpPortfolio: Uint8Array;
  juniorOwner: Uint8Array;
  /** Senior draw (d119eebd): cumulative senior backing moved into the vault LP. */
  seniorDrawnAtoms: bigint;
  /** Senior draw: the loss Earn depositors bear right now (restored first on recovery). */
  seniorDrawOutstandingAtoms: bigint;
}

/** `read_vault_lp_state` subset: kind byte + version + floor bound; null = refuse. */
export function decodeVaultLpState(d: Uint8Array): VaultLpStateView | null {
  if (d.length < C.VAULT_LP_STATE_ACCOUNT_LEN) return null;
  if (d[C.HEADER_KIND_OFF] !== C.KIND_VAULT_LP_STATE) return null;
  if (d[C.VS.version] !== C.VAULT_LP_STATE_VERSION) return null;
  const floor = u16(d, C.VS.juniorFloorBps);
  if (floor < C.VAULT_LP_MIN_JUNIOR_FLOOR_BPS || floor > C.VAULT_LP_MAX_JUNIOR_FLOOR_BPS) return null;
  return {
    seniorClaimAtoms: u128(d, C.VS.seniorClaimAtoms),
    juniorDepositedAtoms: u128(d, C.VS.juniorDepositedAtoms),
    juniorWithdrawnAtoms: u128(d, C.VS.juniorWithdrawnAtoms),
    seniorFeeCreditedAtoms: u128(d, C.VS.seniorFeeCreditedAtoms),
    recalledAtoms: u128(d, C.VS.recalledAtoms),
    assetIndex: u16(d, C.VS.assetIndex),
    juniorFloorBps: floor,
    seniorFeeShareBps: u16(d, C.VS.seniorFeeShareBps),
    lpPortfolio: d.slice(C.VS.lpPortfolio, C.VS.lpPortfolio + 32),
    juniorOwner: d.slice(C.VS.juniorOwner, C.VS.juniorOwner + 32),
    seniorDrawnAtoms: u128(d, C.VS.seniorDrawnAtoms),
    seniorDrawOutstandingAtoms: u128(d, C.VS.seniorDrawOutstandingAtoms),
  };
}

/**
 * `LpVaultRegistryV16.total_lp_shares_outstanding` — the share count the program prices
 * Earn deposits/redemptions against (tags 75/77). null = not a registry account.
 */
export function decodeLpVaultRegistryShares(d: Uint8Array): bigint | null {
  if (d.length < C.LP_VAULT_REGISTRY_ACCOUNT_LEN) return null;
  if (d[C.HEADER_KIND_OFF] !== C.KIND_LP_VAULT_REGISTRY) return null;
  return u128(d, C.REG_TOTAL_LP_SHARES_OUTSTANDING);
}

/**
 * `registry_vault_lp_bound` (P3 424fe7e4): `_reserved[0]` 0 => unbound, 1 => bound, anything
 * else => the program refuses InvalidAccountData on every Earn op ("invalid", fail closed).
 */
export function decodeLpVaultRegistryBound(d: Uint8Array): boolean | "invalid" | null {
  if (d.length < C.LP_VAULT_REGISTRY_ACCOUNT_LEN) return null;
  if (d[C.HEADER_KIND_OFF] !== C.KIND_LP_VAULT_REGISTRY) return null;
  const f = d[C.REG_VAULT_LP_BOUND_FLAG];
  return f === 0 ? false : f === 1 ? true : "invalid";
}

/** `oi_reservation_threshold_bps` (registry bytes 130..132 after the 16-byte header); 0 = guard off. */
export function decodeLpVaultRegistryOiThresholdBps(d: Uint8Array): number | null {
  if (d.length < C.LP_VAULT_REGISTRY_ACCOUNT_LEN) return null;
  if (d[C.HEADER_KIND_OFF] !== C.KIND_LP_VAULT_REGISTRY) return null;
  return u16(d, C.HEADER_LEN + 130);
}

/** The registry's own domain (its backing pot; the sibling is `domain ^ 1`). */
export function decodeLpVaultRegistryDomain(d: Uint8Array): number | null {
  if (d.length < C.LP_VAULT_REGISTRY_ACCOUNT_LEN) return null;
  if (d[C.HEADER_KIND_OFF] !== C.KIND_LP_VAULT_REGISTRY) return null;
  return u16(d, C.REG_DOMAIN);
}

// ── Resolved-mode exit (F-4 / P3-H1) ──────────────────────────────────────────

export interface ResolvedMarketView {
  mode: number;
  currentSlot: bigint;
  resolvedSlot: bigint;
  forceCloseDelaySlots: bigint;
  cTot: bigint;
  materializedPortfolioCount: bigint;
  marketauth: Uint8Array;
}

export function decodeResolvedMarket(d: Uint8Array): ResolvedMarketView | null {
  const g = C.MARKET_GROUP_OFF;
  if (d.length < g + C.MARKET_GROUP_LEN) return null;
  if (!isV18MarketHeader(d)) return null;
  return {
    mode: d[g + C.H_MODE],
    currentSlot: u64(d, g + C.H_CURRENT_SLOT),
    resolvedSlot: u64(d, g + C.H_RESOLVED_SLOT),
    forceCloseDelaySlots: u64(d, C.HEADER_LEN + C.WCFG_FORCE_CLOSE_DELAY_SLOTS),
    cTot: u128(d, g + C.H_C_TOT),
    materializedPortfolioCount: u64(d, g + C.H_MATERIALIZED_PORTFOLIO_COUNT),
    marketauth: d.slice(C.HEADER_LEN, C.HEADER_LEN + 32),
  };
}

export interface ResolvedPortfolioView {
  owner: Uint8Array;
  capital: bigint;
  pnl: bigint;
  reservedPnl: bigint;
  feeCredits: bigint;
  cancelDepositEscrow: bigint;
  activeBitmap: bigint;
  stale: boolean;
  bStale: boolean;
  rebalanceLock: boolean;
  liquidationLock: boolean;
  receiptPresent: boolean;
  receiptFinalized: boolean;
}

export function decodeResolvedPortfolio(d: Uint8Array): ResolvedPortfolioView | null {
  const r = C.PF_RESOLVED_PAYOUT_RECEIPT;
  if (d.length < r + C.RECEIPT_FINALIZED + 1) return null;
  if (d[C.HEADER_KIND_OFF] !== C.KIND_PORTFOLIO) return null;
  return {
    owner: d.slice(C.PF_OWNER, C.PF_OWNER + 32),
    capital: u128(d, C.PF_CAPITAL),
    pnl: i128(d, C.PF_PNL),
    reservedPnl: u128(d, C.PF_RESERVED_PNL),
    feeCredits: i128(d, C.PF_FEE_CREDITS),
    cancelDepositEscrow: u128(d, C.PF_CANCEL_DEPOSIT_ESCROW),
    activeBitmap: u64(d, C.PF_ACTIVE_BITMAP),
    stale: d[C.PF_STALE_STATE] !== 0,
    bStale: d[C.PF_B_STALE_STATE] !== 0,
    rebalanceLock: d[C.PF_REBALANCE_LOCK] !== 0,
    liquidationLock: d[C.PF_LIQUIDATION_LOCK] !== 0,
    receiptPresent: d[r + C.RECEIPT_PRESENT] !== 0,
    receiptFinalized: d[r + C.RECEIPT_FINALIZED] !== 0,
  };
}

/**
 * P3 F-14 terminal quantities (wrapper `vault_terminal_residual_atoms` /
 * `vault_physical_idle_backing_atoms`):
 *  - residual = vault - (c_tot + insurance + backing_provider_earnings_total
 *               + source_fresh_backing_total_num / BOUND_SCALE), saturating: vault tokens no
 *    counter owns. On a terminal-flat Resolved bound market, 77 refuses 84 while it is non-zero
 *    and tag 78 absorbs it into the vault's pot;
 *  - physical = sum over the registry's own + sibling domain of floor(fresh_unliened / BOUND_SCALE):
 *    what Resolved seniors are paid from (min(physical, C)); the junior's 102 takes physical - C.
 */
export function decodeTerminalBacking(d: Uint8Array, registryDomain: number): { residual: bigint; physical: bigint } | null {
  const g = C.MARKET_GROUP_OFF;
  if (!isV18MarketHeader(d) || d.length < g + C.MARKET_GROUP_LEN) return null;
  const owned =
    u128(d, g + C.H_C_TOT) +
    u128(d, g + C.H_INSURANCE) +
    u128(d, g + C.H_BACKING_PROVIDER_EARNINGS_TOTAL) +
    u128(d, g + C.H_SOURCE_FRESH_BACKING_TOTAL_NUM) / C.BOUND_SCALE;
  const vault = u128(d, g + C.H_VAULT);
  const residual = vault > owned ? vault - owned : 0n;
  let physical = 0n;
  for (const dom of [registryDomain, registryDomain ^ 1]) {
    const off = C.assetEngineOff(Math.floor(dom / 2)) + (dom % 2 === 0 ? C.SLOT_BACKING_LONG : C.SLOT_BACKING_SHORT) + C.BUCKET_FRESH_UNLIENED_BACKING_NUM;
    if (d.length < off + 16) return null;
    physical += u128(d, off) / C.BOUND_SCALE;
  }
  return { residual, physical };
}
