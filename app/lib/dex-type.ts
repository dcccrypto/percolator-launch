/**
 * Keeper dexType vocabulary + normalization. Client-safe module — imported by
 * both the create wizard (client) and the keeper-register API route (server).
 * Deliberately separate from lib/playground-registered-markets.ts, which
 * imports the server-only @vercel/blob SDK.
 */

/** The dex types the keeper can price against. */
export const KEEPER_DEX_TYPES = ["raydium-clmm", "meteora-dlmm", "pumpswap"] as const;
export type KeeperDexType = (typeof KEEPER_DEX_TYPES)[number];

/**
 * Normalize a DexScreener `dexId` (what the create wizard's pool lookup
 * carries) to the keeper's dexType vocabulary.
 *
 * DexScreener reports `"meteora"` / `"raydium"` for the very pools the keeper
 * calls `"meteora-dlmm"` / `"raydium-clmm"`. Passing the raw id through made
 * POST /api/playground/keeper-register 400 for every token whose top pool is
 * on Meteora or Raydium — and the wizard swallowed that as a non-fatal warn,
 * so the market launched on-chain but never got registered: no keeper cranks,
 * no price, no name, invisible on /markets.
 *
 * This is the best-effort STRING mapping (client hint / RPC-outage fallback).
 * The keeper-register route's authoritative classification is by the pool
 * account's mainnet owner program — see classifyPoolByOwner there.
 *
 * Returns null for dexes the keeper cannot price.
 */
export function normalizeDexType(raw: string | null | undefined): KeeperDexType | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if ((KEEPER_DEX_TYPES as readonly string[]).includes(v)) return v as KeeperDexType;
  if (v === "meteora" || v === "meteora-damm" || v === "meteoradlmm") return "meteora-dlmm";
  if (v === "raydium" || v === "raydium-cpmm" || v === "raydium-amm") return "raydium-clmm";
  if (v === "pump" || v === "pumpfun" || v === "pump-swap") return "pumpswap";
  return null;
}
