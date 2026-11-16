/** The copy lives in ./admin-burn-text (imports nothing, so the landing page does not pull the SDK for it). Re-exported here for existing callers. */
import { PublicKey } from "@solana/web3.js";
import { isWrapperAccount } from "@/lib/v22/layout";
import { readAssetAdmin } from "@/lib/v18-wire";

export { ADMIN_BURN_COPY } from "@/lib/admin-burn-text";

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
