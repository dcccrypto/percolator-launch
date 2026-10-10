/**
 * v18 write-wire anti-replay field sourcing.
 *
 * The v18 wrapper (integration `a9318945`, VERSION 18) binds every state-changing
 * instruction to live on-chain CAS/replay counters. Wrong values are REJECTED
 * on-chain, so these MUST be read live before building each instruction — never
 * hardcoded.
 *
 * Field → source (ported VERBATIM from the gate-validated seed client
 * ~/percolator-v17-devnet-test/playground/newmarkets.ts and percolator-gate
 * branch migration-v18 src/market.ts):
 *   • portfolioId / expectedSequence(=matcherSequence) / positionEpoch(=matcherPositionEpoch)
 *       → parsePortfolioV17(portfolioAccount)
 *   • marketId (asset i)  → AssetStateV16.market_id = u64 at
 *       assetProfileOff(i) + V17_ASSET_ORACLE_WRAPPER_LEN (engine slot offset 0)
 *   • authorityEpoch      → AssetControlSequencesV17.authorityEpoch (asset 0), CAS,
 *       pass the CURRENT value (NOT +1)
 *   • observationSequence → AssetControlSequencesV17.oracleObservation (asset 0) + 1
 *       (strictly-increasing replay nonce)
 *   • protocolFeeAuthorityEpoch → parseProtocolFeeAuthorityEpoch (market-wide, only
 *       for WithdrawProtocolFee)
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  parseAssetControlSequencesV17,
  parseProtocolFeeAuthorityEpoch,
  type AssetControlSequencesV17,
  type CrankObservationHint,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_ASSET_SLOT_LEN,
} from "@percolatorct/sdk";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { marketGeometry, parsePortfolio } from "@/lib/v22/layout";

/**
 * Absolute byte offset where asset `assetIndex`'s wrapper slot starts. The market account BYTES are REQUIRED: the geometry
 * is chosen by the account's VERSION (v2.2: 2,629 B slots after an 806 B group; v2.1: 2,325 B after 758 B). A byte-less
 * form cannot know the layout, so with the v2.2 flag on the bytes are required (review F4). Flag off the bytes are ignored (v2.1 constants, as before).
 */
export function assetProfileOff(assetIndex: number, slabData?: Uint8Array): number {
  if (!isDevnetV22Enabled()) return V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + assetIndex * V17_MARKET_ASSET_SLOT_LEN;
  if (!slabData) throw new Error("assetProfileOff: the market account bytes are required when v2.2 is enabled (the layout comes from the account VERSION)");
  return marketGeometry(slabData, "assetProfileOff").slotOff(assetIndex);
}

function readU64LE(data: Uint8Array, off: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return (BigInt(view.getUint32(off + 4, true)) << 32n) | BigInt(view.getUint32(off, true));
}

/**
 * Offsets into `MarketGroupV16HeaderAccount` (engine c141d47f, `#[repr(C)]`
 * bytemuck::Pod over align-1 byte-array fields — no padding), relative to
 * V17_MARKET_GROUP_OFF. Summed from the struct and cross-checked two ways:
 * `insurance` lands at 301 (= the SDK's V17_HEADER_INSURANCE_OFF) and the header
 * totals 758 B (= V17_MARKET_GROUP_LEN); then read off live slabs (a seeded
 * market's c_tot equals its 50k LP deposit; a Live market's mode is 0).
 */
const HDR_C_TOT = 317; // u128
const HDR_MATERIALIZED_PORTFOLIO_COUNT = 517; // u64
const HDR_NEXT_MARKET_ID = 581; // u64 — the asset generation frontier
const HDR_MODE = 626; // u8 — 0 Live, 1 Resolved

export interface MarketGroupHeaderState {
  /** 0 = Live, 1 = Resolved. CloseSlab requires 1. */
  mode: number;
  /**
   * `next_market_id` — the `asset_generation_frontier` ResolveMarket (and
   * SetMatcherConfig) are CAS-bound to. It is max_market_slots + 1 after
   * InitMarket, so it depends on the market's slot count — read it, never assume.
   */
  nextMarketId: bigint;
  /** Total user capital. CloseSlab refuses while non-zero. */
  cTot: bigint;
  /** Live portfolios. CloseSlab refuses while non-zero. */
  materializedPortfolioCount: bigint;
}

export function readMarketGroupHeader(slabData: Uint8Array): MarketGroupHeaderState {
  const geo = marketGeometry(slabData, "readMarketGroupHeader");
  const g = geo.groupOff;
  const L = geo.layout.group;
  if (slabData.length < geo.slotsBase) {
    throw new Error(`slab too short for the market-group header @ ${g}`);
  }
  return {
    mode: slabData[g + L.mode],
    // next_market_id is not a column of the SDK table; it sits at a fixed distance after c_tot in both layouts.
    nextMarketId: readU64LE(slabData, g + L.cTot + (HDR_NEXT_MARKET_ID - HDR_C_TOT)),
    cTot: readU64LE(slabData, g + L.cTot) | (readU64LE(slabData, g + L.cTot + 8) << 64n),
    materializedPortfolioCount: readU64LE(slabData, g + L.materializedPortfolioCount),
  };
}

/** The live portfolio identity + CAS watermarks bound by the v18 write wire. */
export interface PortfolioIdentity {
  /** Program-assigned stable portfolio id (`portfolioId` on the wire). */
  portfolioId: bigint;
  /** Per-portfolio matcher-sequence CAS watermark (`expectedSequence` on the wire). */
  matcherSequence: bigint;
  /** Position-episode counter (`positionEpoch` on the wire). */
  positionEpoch: bigint;
}

/** Parse the v18 identity trailer from raw portfolio account bytes. */
export function readPortfolioIdentity(portfolioData: Uint8Array): PortfolioIdentity {
  const p = parsePortfolio(portfolioData);
  return {
    portfolioId: p.portfolioId,
    matcherSequence: p.matcherSequence,
    positionEpoch: p.matcherPositionEpoch,
  };
}

/**
 * `market_id` for an asset = AssetStateV16.market_id (offset 0 of the engine
 * slot). Equals `assetIndex + 1` on a fresh market, but we READ it rather than
 * assume (fail-closed).
 */
export function readAssetMarketId(slabData: Uint8Array, assetIndex = 0): bigint {
  const off = marketGeometry(slabData, "readAssetMarketId").engineOff(assetIndex);
  if (slabData.length < off + 8) {
    throw new Error(`slab too short for AssetStateV16.market_id @ ${off}`);
  }
  return readU64LE(slabData, off);
}

/**
 * `asset_admin` for an asset = AssetOracleProfileV17.asset_admin (offset 368
 * inside the 400-byte profile; see percolator-sdk slab.ts "368 asset_admin
 * [32]"). This is the CREATOR-held admin key — unlike WrapperConfigV17.marketauth
 * (rotated to the keyless stake-pool PDA by StakeInitPool), asset 0's asset_admin
 * stays the creator's wallet, and is the authority for UpdateAssetAuthority
 * (burning the admin key). Zero pubkey once renounced.
 */
export function readAssetAdmin(slabData: Uint8Array, assetIndex = 0): PublicKey {
  const off = assetProfileOff(assetIndex, slabData) + 368;
  if (slabData.length < off + 32) {
    throw new Error(`slab too short for AssetOracleProfileV17.asset_admin @ ${off}`);
  }
  return new PublicKey(slabData.slice(off, off + 32));
}

/** Live AssetControlSequencesV16 (oracle-observation nonce + authority-epoch CAS). */
export function readAssetControlSeqs(slabData: Uint8Array, assetIndex = 0): AssetControlSequencesV17 {
  return parseAssetControlSequencesV17(slabData, assetProfileOff(assetIndex, slabData));
}

/** Market-wide `protocol_fee_authority_epoch` (only for WithdrawProtocolFee). */
export function readProtocolFeeAuthorityEpoch(slabData: Uint8Array): bigint {
  return parseProtocolFeeAuthorityEpoch(slabData, assetProfileOff(0, slabData));
}

/**
 * Default PermissionlessCrank observation hint — one entry for asset 0 with no
 * oracle-account push (a plain maintenance/fee-sweep crank). Mirrors the gate's
 * `market.ts` default (`[{ assetIndex, oracleAccounts: 0 }]`).
 */
export function defaultCrankObservations(assetIndex = 0): CrankObservationHint[] {
  return [{ assetIndex, oracleAccounts: 0 }];
}

// ── Connection-based convenience readers (fetch + parse) ────────────────────

async function fetchData(connection: Connection, pk: PublicKey): Promise<Uint8Array> {
  const info = await connection.getAccountInfo(pk, "confirmed");
  if (!info?.data) throw new Error(`account not found: ${pk.toBase58()}`);
  return new Uint8Array(info.data);
}

export async function fetchPortfolioIdentity(
  connection: Connection,
  portfolio: PublicKey,
): Promise<PortfolioIdentity> {
  return readPortfolioIdentity(await fetchData(connection, portfolio));
}

export async function fetchAssetMarketId(
  connection: Connection,
  slab: PublicKey,
  assetIndex = 0,
): Promise<bigint> {
  return readAssetMarketId(await fetchData(connection, slab), assetIndex);
}

export async function fetchAssetControlSeqs(
  connection: Connection,
  slab: PublicKey,
  assetIndex = 0,
): Promise<AssetControlSequencesV17> {
  return readAssetControlSeqs(await fetchData(connection, slab), assetIndex);
}
