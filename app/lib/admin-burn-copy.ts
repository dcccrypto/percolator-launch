/**
 * What "burn the admin key" really does, in one place. Source: percolator-prog `UpdateAssetAuthority` (tag 65, kind AssetAdmin,
 * new key = zero) clears ONLY asset 0's `asset_admin`. That key is the creator's: it signs `WithdrawCreatorFee` (tag 90) and may
 * reassign the asset's own price-feed, insurance and backing keys (a held key still needs its holder's signature). It is the only
 * authority the instruction allows to be zeroed ("only the cold-storage asset_admin may be intentionally burned"). It does not touch the
 * market authority, the price-feed / insurance / backing keys themselves, the keeper, or the program's upgrade authority, so it never
 * freezes the market or locks anyone's funds.
 */
import { PublicKey } from "@solana/web3.js";
import { isWrapperAccount } from "@/lib/v22/layout";
import { readAssetAdmin } from "@/lib/v18-wire";

export const ADMIN_BURN_COPY = {
  /** Landing proof point body. */
  landing:
    "Creators can give up their admin key for good after launch. Then the creator can no longer claim creator fees or reassign the market's price-feed, insurance and backing keys. Those keys, the market authority and the program's upgrade key are not affected.",
  /** Market page chip tooltip, key burned. */
  burned:
    "Creator admin key burned. The creator can no longer claim creator fees or reassign this market's price-feed, insurance and backing keys. Those keys, the market authority and the program's upgrade key are not affected.",
  /** Market page chip tooltip, key still held. */
  active:
    "This market still has a creator admin key. It can claim creator fees and reassign the price-feed, insurance and backing keys. It has not been given up yet.",
  /** The burn confirmation (Your Markets). What the creator gives up, and what a burn leaves alone. */
  confirm:
    "This is permanent. You will no longer be able to reassign this market's price-feed, insurance and backing keys with this key. Those keys, the market authority and the program's upgrade key are not affected.",
  /** Market page chip labels. Named for the one key a burn clears (asset 0's asset_admin), not "admin" as a whole. */
  chipBurned: "Creator key burned",
  chipActive: "Creator key held",
} as const;

/**
 * Whether the market's creator admin key (asset 0's `asset_admin`) is burned. On a wrapper market (v17+) this reads the
 * key a burn actually zeroes; the slab header's `admin` there is the market authority (SlabProvider's shim), which a burn
 * never touches, so keying the chip off it said "Admin Active" after a burn. Legacy slabs keep the header admin.
 * null = unknown (no data, or an unreadable profile): show no chip rather than guess.
 */
export function creatorAdminBurned(slabRaw: Uint8Array | null | undefined, legacyHeaderAdmin: PublicKey | null | undefined): boolean | null {
  if (slabRaw && slabRaw.length > 0 && isWrapperAccount(slabRaw)) {
    try {
      return readAssetAdmin(slabRaw, 0).equals(PublicKey.default);
    } catch {
      return null;
    }
  }
  return legacyHeaderAdmin ? legacyHeaderAdmin.equals(PublicKey.default) : null;
}
