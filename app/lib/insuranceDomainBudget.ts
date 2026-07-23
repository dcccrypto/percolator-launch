import { PublicKey } from "@solana/web3.js";
import {
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_ASSET_SLOT_LEN,
} from "@percolatorct/sdk";

/**
 * Pure readers for a v17 market (slab) account's per-asset creator-fee revenue.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * The market's accrued creator fee revenue lives in the engine's per-asset
 * `insurance_domain_budget` (a `Vec<u128>` indexed by DOMAIN, two domains per
 * asset: long = asset*2, short = asset*2+1). The `insurance_operator`
 * (defaults to the creator) withdraws it via WithdrawInsuranceAsset (tag 57).
 *
 * The pinned SDK exposes `parseMarketGroupV17OI()` (group-level insurance +
 * per-slot open-interest) but does NOT decode `insurance_domain_budget` or the
 * per-asset `insurance_operator`. Worse, `SlabProvider.assetProfile` parses the
 * AssetOracleProfile at the WRONG offset for these deployed markets (it reads at
 * V17_HEADER_LEN + V17_WRAPPER_CONFIG_LEN = 448, which is the START of the
 * MarketGroup header, not the per-asset slot) — so its `insuranceOperator` is
 * group-header garbage. This module reads BOTH fields from the raw slab bytes at
 * the offsets verified below, so the claim UI never displays or gates on a
 * value derived from the wrong field.
 *
 * OFFSETS (verified two independent ways)
 * ───────────────────────────────────────
 *  1. `cargo run --example dump_layout` in percolator-prog:
 *       - market slot stride = V17_MARKET_ASSET_SLOT_LEN (1797)
 *       - each slot = [512-byte wrapper asset prefix (holds AssetOracleProfileV16
 *         at prefix offset 0)] + [EngineAssetSlotV16Account (1285)]
 *       - within EngineAssetSlotV16Account:
 *           insurance_domain_budget_long  @ 499
 *           insurance_domain_budget_short @ 515
 *       - within AssetOracleProfileV16 (at prefix offset 0):
 *           insurance_operator @ 56
 *     (Matches the SDK's own verified `parseMarketGroupV17OI`, which reads
 *      oi_eff_long_q @ slotBase + 512 + 273.)
 *  2. Live devnet playground market GsBBecjFRwUvsrJ3bCinmCqDhERGtop9BKKEkE8SVa1C
 *     (program 69VUZ7a2…): budget_long(2502588437) + budget_short(2502588438)
 *     == group insurance @ (V17_MARKET_GROUP_OFF+301) = 5005176875, and
 *     insurance_operator @ slot0+56 == marketauth (the creator). Exact match.
 *
 * FORWARD COMPATIBILITY
 * ─────────────────────
 * `slotsBase` is derived from the SDK-exported V17_MARKET_GROUP_OFF /
 * V17_MARKET_GROUP_LEN, so a future SDK bump for the fee-split wrapper (whose
 * larger WrapperConfig moves V17_MARKET_GROUP_OFF from 448→592) shifts these
 * reads automatically. The ENGINE-internal offsets below (wrapper-prefix 512,
 * budget 499/515, operator 56) are stable across wrapper versions — they belong
 * to the `percolator` engine crate, which does not change with the wrapper
 * config block.
 */

/** Size of the per-slot wrapper asset prefix that precedes EngineAssetSlotV16Account. */
export const ASSET_SLOT_WRAPPER_PREFIX = 512;
/** insurance_domain_budget_long offset within EngineAssetSlotV16Account. */
export const INSURANCE_DOMAIN_BUDGET_LONG_REL = 499;
/** insurance_domain_budget_short offset within EngineAssetSlotV16Account. */
export const INSURANCE_DOMAIN_BUDGET_SHORT_REL = 515;
/** insurance_operator offset within the AssetOracleProfileV16 (at the slot prefix start). */
export const PROFILE_INSURANCE_OPERATOR_REL = 56;

/** First byte of asset slot 0 within the market account. */
export const SLOTS_BASE = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN;

function readU128LE(data: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let i = 0; i < 16; i++) {
    result |= BigInt(data[offset + i]) << BigInt(8 * i);
  }
  return result;
}

/** Byte offset of asset-slot `i` within the market account. */
export function slotBase(assetIndex: number): number {
  return SLOTS_BASE + assetIndex * V17_MARKET_ASSET_SLOT_LEN;
}

/**
 * Number of asset slots physically present in a market account, inferred from
 * its length. Matches the on-chain `market_account_len_for_capacity` layout.
 * Returns 0 for buffers too short to contain the group header.
 */
export function marketAssetCapacity(data: Uint8Array): number {
  if (data.length < SLOTS_BASE) return 0;
  return Math.floor((data.length - SLOTS_BASE) / V17_MARKET_ASSET_SLOT_LEN);
}

/**
 * The accrued creator-fee revenue for one asset = the sum of its long + short
 * `insurance_domain_budget` (both domains of that asset). This is the REAL
 * claimable field — it is NOT back-derived from anything that can legitimately
 * be zero (e.g. open interest or the group insurance total).
 *
 * @throws Error if the slot is not fully contained in the buffer.
 */
export function readInsuranceDomainBudget(data: Uint8Array, assetIndex: number): bigint {
  const base = slotBase(assetIndex);
  const longOff = base + ASSET_SLOT_WRAPPER_PREFIX + INSURANCE_DOMAIN_BUDGET_LONG_REL;
  const shortOff = base + ASSET_SLOT_WRAPPER_PREFIX + INSURANCE_DOMAIN_BUDGET_SHORT_REL;
  if (shortOff + 16 > data.length) {
    throw new Error(
      `readInsuranceDomainBudget: asset ${assetIndex} out of range (need ${shortOff + 16} bytes, have ${data.length})`,
    );
  }
  return readU128LE(data, longOff) + readU128LE(data, shortOff);
}

/**
 * The `insurance_operator` pubkey for one asset, read from the per-asset
 * AssetOracleProfileV16 at the correct slot offset (NOT SlabProvider's
 * misaligned offset-448 read). Defaults to the creator at market creation.
 *
 * @returns the operator PublicKey, or null if the slot is out of range.
 */
export function readAssetInsuranceOperator(data: Uint8Array, assetIndex: number): PublicKey | null {
  const off = slotBase(assetIndex) + PROFILE_INSURANCE_OPERATOR_REL;
  if (off + 32 > data.length) return null;
  return new PublicKey(data.slice(off, off + 32));
}
