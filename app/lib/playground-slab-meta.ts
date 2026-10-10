/**
 * Playground devnet slab → token metadata.
 *
 * Used in:
 *  - app/api/markets/route.ts     (discoveredToApiRow → bulk list)
 *  - app/api/markets/[slab]/route.ts  (on-chain fallback for individual slab)
 *
 * RELAUNCH (2026-10-01): the table is EMPTY. Its 2026-09-22 entries were markets of the ABANDONED
 * pre-relaunch wrapper; the relaunch markets come from the wizard (on-chain discovery + Blob).
 * Old v18 markets:
 * all marketauth=FbTbD, each with nft_registry + stake pool + matcher + LP — every
 * one proven trade+stake. Both backing-bucket domains (asset 0) are seeded to a
 * non-lapsing expiry (u64::MAX/2 = 9223372036854775807) via TopUpBackingBucket at
 * creation. The 2026-07-10 v17 markets on the old wrapper are ABANDONED.
 *
 * v2.2 preview: the env-configured market list (NEXT_PUBLIC_V22_MARKETS_JSON, lib/v22/market-meta.ts) is merged in
 * when the v2.2 flag is on. Flag off it adds nothing, so this table is exactly the static one below.
 */
import { v22MarketMetaFromEnv } from "@/lib/v22/market-meta";

const STATIC_PLAYGROUND_SLAB_META: Record<string, {
  symbol: string;
  name: string;
  mainnet_ca: string;
  dex_pool_address: string;
  /**
   * The market's v17 LP-portfolio account (the AMM counterparty — the
   * standalone portfolio with an enabled PortfolioMatcherConfigV16). Its
   * `capital` field is the market's real "Market LP" backing in Sim-USDC
   * atoms. Discovered once via getProgramAccounts (see lib/lp-portfolio.ts)
   * and hardcoded here so the bulk /api/markets list can read it with a
   * single cheap getMultipleAccountsInfo call instead of a per-market scan.
   * Re-discover and update if a market's LP portfolio is ever re-seeded.
   */
  lp_portfolio_address: string;
}> = {
  // RELAUNCH 2026-10-01: empty. Every curated slab above belonged to the ABANDONED pre-relaunch
  // wrapper (GnwdeQr...), so listing them showed dead markets. Markets on the fresh wrapper are
  // created in the wizard and listed through on-chain discovery + the registration Blob; add a
  // curated entry here only for a slab OWNED BY THE CURRENT WRAPPER (lib/program-ids.ts).
};

export const PLAYGROUND_SLAB_META: typeof STATIC_PLAYGROUND_SLAB_META = {
  ...v22MarketMetaFromEnv(),
  // Static entries win over an env entry for the same slab.
  ...STATIC_PLAYGROUND_SLAB_META,
};
