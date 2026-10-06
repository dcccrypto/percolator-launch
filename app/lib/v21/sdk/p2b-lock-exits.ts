/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/p2b-lock-exits @ eb819c5 (#399), with only the imports retargeted
 * at the installed @percolatorct/sdk 8.0.0 root. Delete when @percolatorct/sdk >= 9.0.0 ships and
 * point ./index.ts at the package. Do not edit here; fix upstream in percolator-sdk.
 */
/**
 * P2b bounded lock exits — wrapper tags 104 `AdlWindDown` / 105 `SetAdlWindDownMaxSlots`,
 * the ADL episode record, the attributed bankruptcy h-lock byte, and lock codes 120..122.
 *
 * Source: percolator-prog `feat/p2b-lock-exits-wrapper` (PR #525) on engine
 * `feat/p2b-lock-exits` (percolator PR #276). DRAFT: do not publish before those deploy.
 *
 * @module p2b-lock-exits
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  concatBytes, encU8, encU16, encU32, encU64, buildAccountMetas,
  assetRiskLimitsAccountOffsetP1, ASSET_RISK_LIMITS_LEN_P1,
  type AccountSpec,
} from "@percolatorct/sdk";

/** P2b tag table. 103 is VaultLpAllocate (Earn allocation), not P2b. */
export const IX_TAG_P2B = Object.freeze({ AdlWindDown: 104, SetAdlWindDownMaxSlots: 105 } as const);

/** `state::ADL_WIND_DOWN_DEFAULT_MAX_EPISODE_SLOTS` (~1 h). Stored 0 means this. */
export const ADL_WIND_DOWN_DEFAULT_MAX_EPISODE_SLOTS = 9_000;
/** `state::ADL_WIND_DOWN_MAX_MARK_AGE_SLOTS`: a pushed mark older than this cannot anchor tag 104. */
export const ADL_WIND_DOWN_MAX_MARK_AGE_SLOTS = 150;

/** The dust bound: one whole unit of the market's collateral (10^decimals atoms). */
export function adlWindDownDustNotionalAtoms(collateralDecimals: number): bigint {
  return 10n ** BigInt(Math.min(collateralDecimals, 30));
}

// ---------------------------------------------------------------------------- tag 104

/** Tag 104 fields. `portfolioId` / `positionEpoch` bind the target episode (read live). */
export interface AdlWindDownArgs {
  nowSlot: bigint | string;
  assetIndex: number;
  portfolioId: bigint | string;
  positionEpoch: bigint | string;
}

/** Wire: `[104, now_slot u64, asset_index u16, portfolio_id u64, position_epoch u64]` (27 B). */
export function encodeAdlWindDown(a: AdlWindDownArgs): Uint8Array {
  if (!Number.isInteger(a.assetIndex) || a.assetIndex < 0 || a.assetIndex > 0xffff) throw new Error("bad assetIndex");
  return concatBytes(
    encU8(IX_TAG_P2B.AdlWindDown), encU64(a.nowSlot), encU16(a.assetIndex), encU64(a.portfolioId), encU64(a.positionEpoch),
  );
}

/** Tag 104 accounts: `[caller (any), market (w), portfolio (w), collateral mint]` then the asset's oracle accounts. */
export const ACCOUNTS_ADL_WIND_DOWN: readonly AccountSpec[] = [
  { name: "caller", signer: false, writable: false },
  { name: "market", signer: false, writable: true },
  { name: "portfolio", signer: false, writable: true },
  { name: "collateralMint", signer: false, writable: false },
] as const;

/**
 * Build tag 104 (PERMISSIONLESS: no signer). Refreshes the asset price like a liquidation
 * crank, records/keeps the ADL episode, and force-closes the portfolio's leg at the mark only
 * when the side is dust or the episode outlived its bound, at a fresh, committed mark.
 */
export function buildAdlWindDownIx(
  programId: PublicKey,
  keys: { caller: PublicKey; market: PublicKey; portfolio: PublicKey; collateralMint: PublicKey },
  args: AdlWindDownArgs,
  oracleAccounts: readonly PublicKey[] = [],
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      ...buildAccountMetas(ACCOUNTS_ADL_WIND_DOWN, keys),
      ...oracleAccounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    ],
    data: Buffer.from(encodeAdlWindDown(args)),
  });
}

// ---------------------------------------------------------------------------- tag 105

/** Wire: `[105, asset_index u16, max_episode_slots u32]` (7 B). Tighten-only on chain. */
export function encodeSetAdlWindDownMaxSlots(a: { assetIndex: number; maxEpisodeSlots: number }): Uint8Array {
  if (!Number.isInteger(a.maxEpisodeSlots) || a.maxEpisodeSlots < 1 || a.maxEpisodeSlots > ADL_WIND_DOWN_DEFAULT_MAX_EPISODE_SLOTS) {
    throw new Error(`maxEpisodeSlots must be in 1..=${ADL_WIND_DOWN_DEFAULT_MAX_EPISODE_SLOTS}`);
  }
  return concatBytes(encU8(IX_TAG_P2B.SetAdlWindDownMaxSlots), encU16(a.assetIndex), encU32(a.maxEpisodeSlots));
}

/** Tag 105 accounts: `[upgrade_authority (s), ProgramData, market (w)]`. */
export const ACCOUNTS_SET_ADL_WIND_DOWN_MAX_SLOTS: readonly AccountSpec[] = [
  { name: "upgradeAuthority", signer: true, writable: false },
  { name: "programData", signer: false, writable: false },
  { name: "market", signer: false, writable: true },
] as const;

const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/** Build tag 105 (upgrade-authority gated; can only LOWER the bound). */
export function buildSetAdlWindDownMaxSlotsIx(
  programId: PublicKey, market: PublicKey, upgradeAuthority: PublicKey, args: { assetIndex: number; maxEpisodeSlots: number },
): TransactionInstruction {
  const [programData] = PublicKey.findProgramAddressSync([programId.toBytes()], BPF_LOADER_UPGRADEABLE);
  return new TransactionInstruction({
    programId,
    keys: buildAccountMetas(ACCOUNTS_SET_ADL_WIND_DOWN_MAX_SLOTS, { upgradeAuthority, programData, market }),
    data: Buffer.from(encodeSetAdlWindDownMaxSlots(args)),
  });
}

// ---------------------------------------------------------------------------- episode record

/**
 * Field offsets inside the 64-byte `AssetRiskLimitsV17` record. P2b owns bytes 44..64 (asset-slot
 * 652..672); bytes 42..44 (650..652) belong to the Earn senior floor (prog #526), not P2b.
 */
export const ADL_EPISODE_FIELD_OFF = Object.freeze({
  maxEpisodeSlots: 44, sinceSlot: 48, epochKeyLong: 56, epochKeyShort: 60,
} as const);

/**
 * The on-chain episode key (`processor::adl_episode_key`): each side-reset epoch (low 32 bits)
 * XOR a multiplicative mix of the asset's market_id (the long word uses the mix, the short word
 * the mix rotated left 16).
 */
export function adlEpisodeKey(marketId: bigint, epochLong: bigint, epochShort: bigint): [number, number] {
  const lo = Number(marketId & 0xffffffffn);
  const hi = Number((marketId >> 32n) & 0xffffffffn);
  const mix = Math.imul((lo ^ hi) >>> 0, 0x9e3779b1) >>> 0;
  const rot = ((mix << 16) | (mix >>> 16)) >>> 0;
  return [((Number(epochLong & 0xffffffffn) ^ mix) >>> 0), ((Number(epochShort & 0xffffffffn) ^ rot) >>> 0)];
}

/** Decoded ADL wind-down episode record. */
export interface AdlEpisode {
  /** Stored override (0 = default). */
  maxEpisodeSlots: number;
  /** Effective bound in slots. */
  effectiveMaxEpisodeSlots: number;
  /** First slot tag 104 observed this episode (0n = none recorded). */
  sinceSlot: bigint;
  /** Stored key words (see `adlEpisodeKey`). */
  epochKeyLong: number;
  epochKeyShort: number;
}

/** Decode the episode fields from one 64-byte risk-limits record. */
export function decodeAdlEpisodeRecord(rec: Uint8Array): AdlEpisode {
  if (rec.length !== ASSET_RISK_LIMITS_LEN_P1) throw new Error(`record must be 64 bytes, got ${rec.length}`);
  const v = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  const F = ADL_EPISODE_FIELD_OFF;
  const maxEpisodeSlots = v.getUint32(F.maxEpisodeSlots, true);
  return {
    maxEpisodeSlots,
    effectiveMaxEpisodeSlots: maxEpisodeSlots === 0 ? ADL_WIND_DOWN_DEFAULT_MAX_EPISODE_SLOTS : maxEpisodeSlots,
    sinceSlot: v.getBigUint64(F.sinceSlot, true),
    epochKeyLong: v.getUint32(F.epochKeyLong, true),
    epochKeyShort: v.getUint32(F.epochKeyShort, true),
  };
}

/** Decode asset `i`'s episode from a raw market account. */
export function decodeAdlEpisode(marketData: Uint8Array, assetIndex: number): AdlEpisode {
  const off = assetRiskLimitsAccountOffsetP1(assetIndex);
  if (marketData.length < off + ASSET_RISK_LIMITS_LEN_P1) throw new Error(`market account too short for asset ${assetIndex}`);
  return decodeAdlEpisodeRecord(marketData.subarray(off, off + ASSET_RISK_LIMITS_LEN_P1));
}

/**
 * Slots until tag 104 may force-close, given the asset's CURRENT market_id and side-reset epochs
 * (a key mismatch or no record means the next tag 104 only arms the episode). `null` = not armed.
 */
export function adlEpisodeSlotsRemaining(
  ep: AdlEpisode, marketId: bigint, epochLong: bigint, epochShort: bigint, nowSlot: bigint,
): bigint | null {
  const [kl, ks] = adlEpisodeKey(marketId, epochLong, epochShort);
  const armed = ep.sinceSlot !== 0n && ep.epochKeyLong === kl && ep.epochKeyShort === ks;
  if (!armed) return null;
  const end = ep.sinceSlot + BigInt(ep.effectiveMaxEpisodeSlots);
  return nowSlot >= end ? 0n : end - nowSlot;
}

// ---------------------------------------------------------------------------- h-lock byte

/** The engine's bankruptcy h-lock byte is ACTIVE iff non-zero (it is no longer only 0/1). */
export function isBankruptcyHlockActive(byte: number): boolean {
  return byte !== 0;
}

/**
 * Decode the attributed h-lock byte: 0 inactive; 1 active, unattributed (clears only when no
 * positive claim remains anywhere); `1 | mask<<1` active, attributed to the claim-source domains
 * in `mask` (domain d = asset*2 + side; clears when those domains hold no claims).
 */
export function decodeBankruptcyHlock(byte: number): { active: boolean; unattributed: boolean; domains: number[] } {
  if (byte === 0) return { active: false, unattributed: false, domains: [] };
  if ((byte & 1) === 0) throw new Error(`invalid h-lock byte ${byte}: bit 0 clear`);
  const mask = byte >> 1;
  const domains: number[] = [];
  for (let d = 0; d < 7; d++) if (mask & (1 << d)) domains.push(d);
  return { active: true, unattributed: mask === 0, domains };
}
