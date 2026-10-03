/**
 * Markets hidden from LISTINGS only (the /markets page, the landing Live Markets rail and the
 * /trade default pick). Unlike lib/blocklist.ts this does NOT block the market: its trade page,
 * positions, close, withdraw and Earn exit keep working by direct link, and the keeper keeps
 * cranking it (the keeper reads the `markets` table, not the listing) — holders must still be
 * able to exit.
 *
 * 2026-10-02: SI (8WC8vALs…) — LP capital 0 + ADL reduce-only, so every open fails; hidden for
 * the launch until it is restored. Extra slabs: NEXT_PUBLIC_LISTING_HIDDEN (comma-separated).
 */
const DEFAULT_HIDDEN = ["8WC8vALsDJhNCUVRmqZBDSg5xgFAhDrgy7zWqF512pDx"];

export const LISTING_HIDDEN_SLABS: ReadonlySet<string> = new Set([
  ...DEFAULT_HIDDEN,
  ...(process.env.NEXT_PUBLIC_LISTING_HIDDEN ?? "").split(",").map((s) => s.trim()).filter(Boolean),
]);

export function isHiddenFromListing(slab: string): boolean {
  return LISTING_HIDDEN_SLABS.has(slab);
}
