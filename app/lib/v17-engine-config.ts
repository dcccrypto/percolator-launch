/**
 * v17 engine-config parser → RiskParams.
 *
 * WHY THIS EXISTS
 * ---------------
 * v17 market-group ("slab") accounts embed the engine's `V16ConfigAccount`
 * (which holds the REAL per-market `maintenance_margin_bps` /
 * `initial_margin_bps` / fee params) inside the same account the frontend
 * already fetches — but `SlabProvider`'s v17 parse path historically set
 * `params: null` and every consumer fell back to hardcoded guesses
 * (`?? 500n` maintenance, `?? 1000n` initial). On these markets the real
 * values are 600 / 1200, so every liquidation price, max-leverage figure and
 * required-margin number was computed with the wrong margin — in the UNSAFE
 * direction (positions rendered as safer than they are). This parser reads the
 * true values so all RiskParams consumers (PositionsDock, OrderTicket,
 * AccountRiskSidebar, PositionPanel, MarketStatsCard, …) are corrected at once.
 *
 * The SDK does not (yet) expose a parser for the v17 engine-config region, so
 * this is an app-local reader. It is NOT a program or SDK change.
 *
 * OFFSETS — how they were derived (and how to re-verify)
 * ------------------------------------------------------
 * The v17 account layout is:
 *   [0..16)     v17 header
 *   [16..448)   WrapperConfigV16 (432 bytes)         (SDK: parseWrapperConfigV17)
 *   [448..1206) market-group region (758 bytes)      (holds V16ConfigAccount)
 *   [1206..]    per-asset slots (1797 bytes each)
 * `V16ConfigAccount` begins 32 bytes into the market-group region (after a
 * 32-byte group header) at absolute offset 480, and is packed repr(C) with no
 * padding. Verified empirically against all 5 live devnet markets — the 12
 * leading fields (max_portfolio_assets, min_nonzero_{mm,im}_req, h_min, h_max,
 * maintenance_margin_bps=600, initial_margin_bps=1200, max_trading_fee_bps=100,
 * liquidation_fee_bps=50, liquidation_fee_cap=1e10, min_liquidation_abs=0)
 * decode exactly to the values the markets were created with.
 * Re-verification harness:
 *   ~/percolator-v17-devnet-test/playground/flowtest/verify-config-layout.ts
 */

import type { RiskParams } from "@percolatorct/sdk";

const V17_HEADER_LEN = 16;
const V17_WRAPPER_CONFIG_LEN = 432;
const V17_MARKET_GROUP_OFF = V17_HEADER_LEN + V17_WRAPPER_CONFIG_LEN; // 448
/** Bytes of market-group header preceding the embedded V16ConfigAccount. */
const V17_MARKET_GROUP_HEADER_LEN = 32;
/** Absolute byte offset of V16ConfigAccount inside the v17 slab account. */
export const V17_ENGINE_CONFIG_OFF =
  V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_HEADER_LEN; // 480

/** Field offsets WITHIN V16ConfigAccount (packed, no padding). */
const F = {
  maxPortfolioAssets: 0, // u16
  minNonzeroMmReq: 6, // u128
  minNonzeroImReq: 22, // u128
  hMin: 38, // u64
  hMax: 46, // u64
  maintenanceMarginBps: 54, // u64
  initialMarginBps: 62, // u64
  maxTradingFeeBps: 70, // u64
  liquidationFeeBps: 78, // u64
  liquidationFeeCap: 86, // u128
  minLiquidationAbs: 102, // u128
} as const;

/** Last field we read ends at rel 118 (min_liquidation_abs u128). */
const CONFIG_READ_LEN = 118;

function u16(dv: DataView, off: number): bigint {
  return BigInt(dv.getUint16(off, true));
}
function u64(dv: DataView, off: number): bigint {
  return dv.getBigUint64(off, true);
}
function u128(dv: DataView, off: number): bigint {
  const lo = dv.getBigUint64(off, true);
  const hi = dv.getBigUint64(off + 8, true);
  return lo + (hi << 64n);
}

/**
 * Parse a full `RiskParams` from a v17 slab account.
 *
 * @param data        raw v17 slab account bytes
 * @param tradeFeeBps the wrapper's actual base trade fee (bps) —
 *                    `wrapperConfigV17.tradeFeeBps`, the fee genuinely charged
 *                    (30), not the engine cap `max_trading_fee_bps` (100).
 * @returns the parsed RiskParams, or `null` if the account is too short
 *          (caller keeps the old `params: null` fallback behavior).
 */
export function parseV17RiskParams(
  data: Uint8Array,
  tradeFeeBps: bigint,
): RiskParams | null {
  const base = V17_ENGINE_CONFIG_OFF;
  if (data.length < base + CONFIG_READ_LEN) return null;

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const hMin = u64(dv, base + F.hMin);
  const hMax = u64(dv, base + F.hMax);

  return {
    // Deprecated alias — mirrors hMin for backwards compat (see SDK RiskParams).
    warmupPeriodSlots: hMin,
    // ── The fields consumers actually read (the fix) ────────────────────────
    maintenanceMarginBps: u64(dv, base + F.maintenanceMarginBps),
    initialMarginBps: u64(dv, base + F.initialMarginBps),
    tradingFeeBps: tradeFeeBps,
    // riskReductionThreshold is not part of V16ConfigAccount and is unset (no
    // risk gate) on these markets — 0n matches the prior `?? 0n` fallback.
    riskReductionThreshold: 0n,
    // ── Correct where read from chain, safe-defaulted where not present ─────
    maxAccounts: u16(dv, base + F.maxPortfolioAssets),
    newAccountFee: 0n,
    maintenanceFeePerSlot: 0n,
    maxCrankStalenessSlots: 0n,
    liquidationFeeBps: u64(dv, base + F.liquidationFeeBps),
    liquidationFeeCap: u128(dv, base + F.liquidationFeeCap),
    liquidationBufferBps: 0n,
    minLiquidationAbs: u128(dv, base + F.minLiquidationAbs),
    minInitialDeposit: 0n,
    minNonzeroMmReq: u128(dv, base + F.minNonzeroMmReq),
    minNonzeroImReq: u128(dv, base + F.minNonzeroImReq),
    insuranceFloor: 0n,
    hMin,
    hMax,
  };
}
