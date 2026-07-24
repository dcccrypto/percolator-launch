/**
 * Shared types for the /my-markets creator dashboard (CreatorMarketRow,
 * CreatorAttentionStrip, and the page itself).
 */

import type { CreatedMarket } from "@/hooks/useCreatedMarkets";
import { sanitizePriceE6, applyInvert } from "@/lib/oraclePrice";

/**
 * Subset of the /api/markets/[slab] response this dashboard actually reads.
 * That route already does the real work (parsing raw v17 bytes server-side,
 * resolving the real on-chain LP capital via lib/lp-portfolio.ts's
 * withOnChainMarketLp) — this dashboard must NOT re-implement byte parsing
 * client-side, just consume the fields.
 *
 * NOTE on scale: `vault_balance`, `insurance_balance`, `lp_collateral`, and
 * `total_open_interest` are all RAW COLLATERAL ATOMS (same convention as
 * on-chain bigints, e.g. components/trade/MarketStatsCard.tsx's
 * `marketLpFromApi`) — divide by 10^decimals before display.
 */
export interface CreatorMarketDetail {
  slab_address: string;
  /** Real on-chain LP capital backing this market (see lib/lp-portfolio.ts
   *  getMarketLpCapital) when Supabase's own vault_balance/c_tot are null —
   *  which is always, for v17. Raw atoms. Null = unknown (never fabricate 0). */
  vault_balance: number | null;
  /** Supabase's stored LP-collateral figure at market-creation time — may
   *  drift from the live `vault_balance` above (deposits/withdrawals since
   *  creation). Surfaced only as a secondary sub-label when it diverges. */
  lp_collateral: number | null;
  insurance_balance: number | null;
  total_open_interest: number | null;
  c_tot: number | null;
  total_accounts: number | null;
  /** Mainnet DEX pool this market's keeper cranks from — required to retry
   *  keeper registration (see CreatorAttentionStrip). */
  dex_pool_address: string | null;
  mainnet_ca: string | null;
  symbol: string | null;
  name: string | null;
  logo_url: string | null;
  /** "hyperp" | "keeper" | "admin" | "pyth-pinned" — see lib/oraclePrice.ts detectOracleMode */
  oracle_mode: string | null;
  /** Market admin/creator wallet (`deployer` column — same wallet as
   *  configV17.marketauth at creation time; may have since rotated). */
  deployer: string | null;
  /** Creator-fee claim (tag 90): accrued claimable balance, atoms as a string
   *  (u64 can exceed JS number precision). null/"0" = nothing to claim. */
  creator_fee_claimable_atoms: string | null;
  /** Wallet that may claim those fees — asset 0's `asset_admin`. The creator can
   *  claim only from THIS wallet (survives staking, unlike marketauth). */
  creator_fee_authority: string | null;
}

/** Map a raw /api/markets/[slab] JSON body into the fields this dashboard needs.
 *  Defensive Number() coercion — Supabase NUMERIC columns arrive as strings. */
export function toCreatorMarketDetail(raw: Record<string, unknown>): CreatorMarketDetail {
  const num = (v: unknown): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    slab_address: str(raw.slab_address) ?? "",
    vault_balance: num(raw.vault_balance),
    lp_collateral: num(raw.lp_collateral),
    insurance_balance: num(raw.insurance_balance ?? raw.insurance_fund),
    total_open_interest: num(raw.total_open_interest),
    c_tot: num(raw.c_tot),
    total_accounts: num(raw.total_accounts),
    dex_pool_address: str(raw.dex_pool_address),
    mainnet_ca: str(raw.mainnet_ca),
    symbol: str(raw.symbol),
    name: str(raw.name),
    logo_url: str(raw.logo_url),
    oracle_mode: str(raw.oracle_mode),
    deployer: str(raw.deployer),
    creator_fee_claimable_atoms: str(raw.creator_fee_claimable_atoms),
    creator_fee_authority: str(raw.creator_fee_authority),
  };
}

/**
 * C-08 decimals derivation (mirrors today's page.tsx:402-406): unitScale is
 * stored in both v17 (configV17.unitScale) and v12 (config.unitScale).
 * Math.log10(1_000_000) = 6; Math.log10(1_000_000_000) = 9. Default 6 (the
 * playground's sim-USDC decimals) if unknown/zero.
 */
export function unitScaleToDecimals(unitScaleRaw: number | bigint | undefined): number {
  const n = Number(unitScaleRaw ?? 1_000_000);
  return n > 1 ? Math.round(Math.log10(n)) : 6;
}

/**
 * Resolve a market's oracle price in E6, oracle-mode aware — the same
 * v17 markEwmaE6/v12 authorityPriceE6 mapping SlabProvider/CreatorMarketRow
 * use. Used as the FALLBACK when a live price-store tick isn't available yet
 * (see hooks/useLiveSlabPrices.ts) for USD-normalizing OI across markets that
 * each price a different underlying asset — OI is a quantity of that
 * market's own asset, so summing raw OI across markets with different assets
 * (e.g. SOL OI + JUP OI) is meaningless without converting each to USD first.
 */
export function resolveCreatedMarketPriceE6(market: CreatedMarket): bigint {
  if (market.configV17) {
    return applyInvert(sanitizePriceE6(market.configV17.markEwmaE6 ?? 0n), market.configV17.invert);
  }
  return market.config?.authorityPriceE6 ?? 0n;
}

/**
 * "Liquidity backing this market" (audit finding: absent from the old page
 * entirely). Pulled out as a pure function (used by CreatorMarketRow) so the
 * v17-vs-v12 source-of-truth switch is unit-testable without rendering:
 *  - v17: the API's real on-chain LP-portfolio capital (see
 *    lib/lp-portfolio.ts getMarketLpCapital) — Supabase's own vault_balance/
 *    c_tot are always null for v17, so the API route already backfills this
 *    from an on-chain scan; never fabricate a value the API didn't provide.
 *  - v12: engine.vault (legacy path — mock-mode / any lingering v12 market).
 */
export function deriveMarketLiquidityAtoms(market: CreatedMarket, detail: CreatorMarketDetail | null): bigint | null {
  if (market.configV17) {
    return detail?.vault_balance != null ? BigInt(Math.round(detail.vault_balance)) : null;
  }
  return market.engine?.vault ?? null;
}

/**
 * True when Supabase's stored (creation-time) `lp_collateral` figure has
 * drifted far enough from the live liquidity figure above to be worth
 * surfacing as a secondary sub-label (deposits/withdrawals since creation).
 * "Materially" = more than 2x in either direction — small drift (fees,
 * funding) is expected and not interesting; recomputed each render, never
 * cached, so this can't go stale.
 */
export function lpCollateralMateriallyDiverges(liquidityAtoms: bigint | null, storedAtoms: bigint | null): boolean {
  if (liquidityAtoms == null || storedAtoms == null || storedAtoms <= 0n) return false;
  return liquidityAtoms > storedAtoms * 2n || liquidityAtoms * 2n < storedAtoms;
}
