/**
 * Decode one v2.2 market account into the API's market view. Pure: bytes + the read's slot in, a plain object out;
 * an account the API cannot serve throws ApiError (`market_unsupported` / `market_unreadable`).
 *
 * Freshness. `oracle.lastPushSlot` is the wrapper's `last_good_oracle_slot` (the slot of the last accepted oracle
 * push); `ageSlots` is the READ's context slot minus that. `stale` uses the market's own bound `max_staleness_secs`
 * when it is set; many markets leave it 0 (keeper-pushed AUTH_MARK mode), and then the documented default
 * DEFAULT_STALE_SECS applies and `staleBoundSource` says "default". Slots are converted at 400 ms.
 */
import { PublicKey } from "@solana/web3.js";
import { parseAssetOracleProfileV17, parseWrapperConfigV17, V17_HEADER_LEN } from "@percolatorct/sdk";
import { ApiError } from "../errors";
import { SLOT_MS } from "./common";
import { isWrapperMarketAccount, marketGeometry } from "@/lib/v22/layout";
import { marketAssetSlots } from "@/lib/v22/trade-refresh";
import { lotExpOfMarketV22 } from "@/lib/v22/sdk/v22-lot";
import { decodeAssetRiskLimits, decodeMarketEngineView } from "@/lib/limits/decode";
import { detectOracleMode, sanitizePriceE6 } from "@/lib/oraclePrice";
import { maxLeverageFromSlab } from "@/lib/slab-max-leverage";
import { parseV17RiskParams } from "@/lib/v17-engine-config";
import { effectiveExecBandBps } from "@/lib/limits/risk-limits";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";
import { collateralDecimalsOf } from "../builders/collateral";

/** Staleness bound used when the market does not carry one (`max_staleness_secs` = 0). */
export const DEFAULT_STALE_SECS = 120;

export interface OracleFreshness {
  mode: string;
  modeByte: number;
  /** Slot of the last accepted oracle push; null = never pushed. */
  lastPushSlot: bigint | null;
  ageSlots: number | null;
  ageSecs: number | null;
  staleBoundSecs: number;
  staleBoundSource: "market" | "default";
  stale: boolean;
  markEwmaE6: bigint;
}

export interface MarketView {
  market: string;
  programId: string;
  symbol: string | null;
  name: string | null;
  lotExp: number;
  assets: number;
  /** The collateral token the market holds (base58) and its decimals (null = a mint the API cannot value in USD; orders that add risk are refused). */
  collateralMint: string;
  collateralDecimals: number | null;
  oracleMode: string;
  effectivePriceE6: bigint;
  targetPriceE6: bigint;
  markEwmaE6: bigint;
  oracle: OracleFreshness;
  feeBps: bigint;
  maxLeverage: number | null;
  openInterest: { longQ: bigint; shortQ: bigint };
}

export interface MarketDetail extends MarketView {
  risk: {
    initialMarginBps: bigint;
    maintenanceMarginBps: bigint;
    maxTradingFeeBps: bigint;
    maxRequestedFeeBps: number;
    maxAbsFundingE9PerSlot: bigint;
    liquidationFeeBps: bigint | null;
    liquidationFeeCap: bigint | null;
    minNonzeroInitialMarginReq: bigint | null;
    minNonzeroMaintenanceMarginReq: bigint | null;
    execBandBps: number | null;
    sideOiCapQ: bigint | null;
    lpFloorAtoms: bigint | null;
    engineMode: number;
    sideModes: { long: number; short: number };
    vaultAtoms: bigint;
    insuranceAtoms: bigint;
  };
}

const ZERO = new PublicKey(new Uint8Array(32));

/** The market's decoded pieces, shared by the summary and the detail view. */
function parts(raw: Uint8Array) {
  if (!isWrapperMarketAccount(raw)) throw new ApiError("market_unsupported", "not a v2.2 market account");
  let version: number;
  try {
    version = marketGeometry(raw, "bot-api-market").layout.version;
  } catch {
    throw new ApiError("market_unsupported", "not a v2.2 market account");
  }
  if (version < 19) throw new ApiError("market_unsupported", "only v2.2 markets are supported");
  const assets = marketAssetSlots(raw);
  if (assets === null) throw new ApiError("market_unreadable");
  if (assets > 1) throw new ApiError("market_unsupported", "multi-asset markets are not supported yet");
  try {
    const cfg = parseWrapperConfigV17(raw, V17_HEADER_LEN);
    const profile = parseAssetOracleProfileV17(raw, marketGeometry(raw, "bot-api-market").slotsBase);
    const engine = decodeMarketEngineView(raw, 0);
    if (!engine) throw new Error("engine view");
    return { cfg, profile, engine, assets, lotExp: lotExpOfMarketV22(raw) };
  } catch {
    throw new ApiError("market_unreadable");
  }
}

export function decodeMarket(raw: Uint8Array, at: { market: PublicKey; programId: PublicKey; slot: number }): MarketView {
  const { cfg, profile, engine, assets, lotExp } = parts(raw);
  // Same oracle-mode shim as lib/v22/trade-build.ts (the SlabProvider v17 branch).
  const indexFeedId = cfg.oracleMode !== 0 ? ZERO : (profile.oracleLegFeeds[0] ?? ZERO);
  const mode = detectOracleMode({ oracleAuthority: profile.oracleAuthority, indexFeedId, oracleModeByte: cfg.oracleMode });
  const last = profile.lastGoodOracleSlot;
  const ageSlots = last > 0n ? Math.max(0, at.slot - Number(last)) : null;
  const ageSecs = ageSlots === null ? null : (ageSlots * SLOT_MS) / 1000;
  const marketBound = Number(profile.maxStalenessSecs);
  const staleBoundSecs = marketBound > 0 ? marketBound : DEFAULT_STALE_SECS;
  const meta = PLAYGROUND_SLAB_META[at.market.toBase58()];
  return {
    market: at.market.toBase58(),
    programId: at.programId.toBase58(),
    symbol: meta?.symbol ?? null,
    name: meta?.name ?? null,
    lotExp,
    assets,
    collateralMint: cfg.collateralMint.toBase58(),
    collateralDecimals: collateralDecimalsOf(cfg.collateralMint.toBase58()),
    oracleMode: mode,
    effectivePriceE6: sanitizePriceE6(engine.effectivePriceE6),
    targetPriceE6: sanitizePriceE6(engine.targetPriceE6),
    markEwmaE6: sanitizePriceE6(profile.markEwmaE6),
    oracle: {
      mode,
      modeByte: cfg.oracleMode,
      lastPushSlot: last > 0n ? last : null,
      ageSlots,
      ageSecs,
      staleBoundSecs,
      staleBoundSource: marketBound > 0 ? "market" : "default",
      stale: ageSecs === null || ageSecs > staleBoundSecs,
      markEwmaE6: sanitizePriceE6(profile.markEwmaE6),
    },
    feeBps: cfg.tradeFeeBps,
    maxLeverage: maxLeverageFromSlab(raw),
    openInterest: { longQ: engine.oiEffLongQ, shortQ: engine.oiEffShortQ },
  };
}

export function decodeMarketDetail(raw: Uint8Array, at: { market: PublicKey; programId: PublicKey; slot: number }): MarketDetail {
  const base = decodeMarket(raw, at);
  const { cfg, engine } = parts(raw);
  const params = parseV17RiskParams(raw, cfg.tradeFeeBps);
  const limits = decodeAssetRiskLimits(raw, 0);
  return {
    ...base,
    risk: {
      initialMarginBps: engine.initialMarginBps,
      maintenanceMarginBps: engine.maintenanceMarginBps,
      maxTradingFeeBps: engine.maxTradingFeeBps,
      maxRequestedFeeBps: limits?.maxRequestedFeeBps ?? 0,
      maxAbsFundingE9PerSlot: engine.maxAbsFundingE9PerSlot,
      liquidationFeeBps: params?.liquidationFeeBps ?? null,
      liquidationFeeCap: params?.liquidationFeeCap ?? null,
      minNonzeroInitialMarginReq: params?.minNonzeroImReq ?? null,
      minNonzeroMaintenanceMarginReq: params?.minNonzeroMmReq ?? null,
      execBandBps: limits ? effectiveExecBandBps(limits.execBandBps) : null,
      sideOiCapQ: limits ? limits.sideOiCapQ : null,
      lpFloorAtoms: limits ? limits.lpFloorAtoms : null,
      engineMode: engine.mode,
      sideModes: { long: engine.modeLong, short: engine.modeShort },
      vaultAtoms: engine.vaultAtoms,
      insuranceAtoms: engine.insuranceAtoms,
    },
  };
}
