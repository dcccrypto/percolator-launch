/**
 * What "burn the admin key" really does, in one place. Source: percolator-prog `UpdateAssetAuthority` (tag 65, kind AssetAdmin,
 * new key = zero) clears ONLY asset 0's `asset_admin`. That key is the creator's: it signs `WithdrawCreatorFee` (tag 90) and may
 * reassign the asset's own price-feed, insurance and backing keys (a held key still needs its holder's signature). It is the only
 * authority the instruction allows to be zeroed ("only the cold-storage asset_admin may be intentionally burned"). It does not touch the
 * market authority, the price-feed / insurance / backing keys themselves, the keeper, or the program's upgrade authority, so it never
 * freezes the market or locks anyone's funds.
 */
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
} as const;
