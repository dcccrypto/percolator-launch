/**
 * PRICE_WS_MARKETS_FILE for scripts/local-price-ws-server.ts (v22price 2026-10-22): turn an oracle-keeper registry file
 * (`{ markets: [{ marketAddress, poolAddress, dexType, label }] }`, e.g. the v2.2 devnet keeper's registry.v22fresh.json)
 * into the price feed's DEX market list, so a deployment for markets that are NOT in the database (the v2.2 preview)
 * streams exactly the keeper's markets. Only single-pool rows with a dexType the reader supports are taken; multi-asset
 * rows (no single pool) and unknown dex types are skipped, never guessed.
 */
import type { DexType } from "@percolatorct/sdk";

export interface MarketsFileEntry {
  slab: string;
  poolAddress: string;
  dexType: DexType;
  label: string;
}

const SUPPORTED: ReadonlySet<string> = new Set<DexType>(["pumpswap", "raydium-clmm", "meteora-dlmm"]);

export function parseMarketsFile(json: string): MarketsFileEntry[] {
  const raw = JSON.parse(json) as { markets?: Array<{ marketAddress?: unknown; poolAddress?: unknown; dexType?: unknown; label?: unknown }> };
  const out: MarketsFileEntry[] = [];
  for (const m of raw.markets ?? []) {
    if (typeof m.marketAddress !== "string" || typeof m.poolAddress !== "string" || typeof m.dexType !== "string") continue;
    if (!SUPPORTED.has(m.dexType)) continue;
    out.push({
      slab: m.marketAddress,
      poolAddress: m.poolAddress,
      dexType: m.dexType as DexType,
      label: typeof m.label === "string" ? m.label : m.marketAddress.slice(0, 8),
    });
  }
  return out;
}
