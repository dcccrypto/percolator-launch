/**
 * Static market registry — bundled list of known Percolator slab addresses.
 *
 * This is the tier-3 fallback for `discoverMarkets()`: when both
 * `getProgramAccounts` (tier 1) and the REST API (tier 2) are unavailable,
 * the SDK falls back to this bundled list to bootstrap market discovery.
 *
 * The addresses are fetched on-chain via `getMarketsByAddress`
 * (`getMultipleAccounts`), so all data is still verified on-chain.  The static
 * list only provides the *address directory* — no cached market data is used.
 *
 * ## Maintenance
 *
 * Update this list when new markets are deployed or old ones are retired.
 * Run `scripts/update-static-markets.ts` to regenerate from a permissive RPC
 * or the REST API.
 *
 * @module
 */

import { PublicKey } from "@solana/web3.js";
import type { Network } from "../config/program-ids.js";

/**
 * A single entry in the static market registry.
 *
 * Only the slab address (base58) is required.  Optional metadata fields
 * (`symbol`, `name`) are provided for debugging/logging purposes only —
 * they are **not** used for on-chain data and may become stale.
 */
export interface StaticMarketEntry {
  /** Base58-encoded slab account address. */
  slabAddress: string;
  /** Optional human-readable symbol (e.g. "SOL-PERP"). */
  symbol?: string;
  /** Optional descriptive name. */
  name?: string;
}

/**
 * Known mainnet market slab addresses.
 *
 * These are the markets deployed to the mainnet Percolator program
 * (`ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv`).
 *
 * **Last updated:** 2026-04-11 (V12_1_EP mainnet market with entry_price support).
 */
const MAINNET_MARKETS: StaticMarketEntry[] = [
  { slabAddress: "7psyeWRts4pRX2cyAWD1NH87bR9ugXP7pe6ARgfG79Do", symbol: "SOL-PERP", name: "SOL/USDC Perpetual" },
];

/**
 * Known devnet market slab addresses.
 *
 * These are discovered from the devnet Percolator program
 * (`FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD`).
 *
 * **Last updated:** 2026-04-04.
 */
const DEVNET_MARKETS: StaticMarketEntry[] = [
  // Populated from prior discoverMarkets() runs on devnet.
  // These serve as the tier-3 safety net for devnet users.
];

/**
 * Full static registry indexed by network.
 */
const STATIC_REGISTRY: Record<Network, StaticMarketEntry[]> = {
  mainnet: MAINNET_MARKETS,
  devnet: DEVNET_MARKETS,
};

/**
 * User-provided market entries appended at runtime via {@link registerStaticMarkets}.
 * Keyed by network.
 */
const USER_MARKETS: Record<Network, StaticMarketEntry[]> = {
  mainnet: [],
  devnet: [],
};

/**
 * Get the bundled static market list for a given network.
 *
 * Returns the built-in list merged with any entries added via
 * {@link registerStaticMarkets}.  Duplicates (by `slabAddress`) are removed
 * automatically — user-registered entries take precedence.
 *
 * @param network - Target network (`"mainnet"` or `"devnet"`)
 * @returns Array of static market entries (may be empty if no markets are known)
 *
 * @example
 * ```ts
 * import { getStaticMarkets } from "@percolator/sdk";
 *
 * const markets = getStaticMarkets("mainnet");
 * console.log(`${markets.length} known mainnet slab addresses`);
 * ```
 */
export function getStaticMarkets(network: Network): StaticMarketEntry[] {
  const builtin = STATIC_REGISTRY[network] ?? [];
  const user = USER_MARKETS[network] ?? [];

  if (user.length === 0) return [...builtin];

  // Merge: user entries override builtin entries with same slabAddress
  const seen = new Map<string, StaticMarketEntry>();
  for (const entry of builtin) {
    seen.set(entry.slabAddress, entry);
  }
  for (const entry of user) {
    seen.set(entry.slabAddress, entry);
  }
  return [...seen.values()];
}

/**
 * Register additional static market entries at runtime.
 *
 * Use this to inject known slab addresses before calling `discoverMarkets()`
 * so that tier-3 fallback has addresses to work with — especially useful
 * right after mainnet launch when the bundled list may be empty.
 *
 * Entries are deduplicated by `slabAddress` — calling this multiple times
 * with the same address is safe.
 *
 * @param network - Target network
 * @param entries - One or more static market entries to register
 *
 * @example
 * ```ts
 * import { registerStaticMarkets } from "@percolator/sdk";
 *
 * registerStaticMarkets("mainnet", [
 *   { slabAddress: "ABC123...", symbol: "SOL-PERP" },
 *   { slabAddress: "DEF456...", symbol: "ETH-PERP" },
 * ]);
 * ```
 */
export function registerStaticMarkets(
  network: Network,
  entries: StaticMarketEntry[],
): void {
  const existing = USER_MARKETS[network];
  const seen = new Set(existing.map(e => e.slabAddress));

  for (const entry of entries) {
    if (!entry.slabAddress) continue;
    if (seen.has(entry.slabAddress)) continue;
    // Validate that slabAddress is a valid base58 public key
    try {
      new PublicKey(entry.slabAddress);
    } catch {
      console.warn(
        `[registerStaticMarkets] Skipping invalid slabAddress: ${entry.slabAddress}`,
      );
      continue;
    }
    seen.add(entry.slabAddress);
    existing.push(entry);
  }
}

/**
 * Clear all user-registered static market entries for a network.
 *
 * Useful in tests or when resetting state.
 *
 * @param network - Target network to clear (omit to clear all networks)
 */
export function clearStaticMarkets(network?: Network): void {
  if (network) {
    USER_MARKETS[network] = [];
  } else {
    USER_MARKETS.mainnet = [];
    USER_MARKETS.devnet = [];
  }
}
