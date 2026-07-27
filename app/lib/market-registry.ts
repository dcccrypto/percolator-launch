import * as Sentry from "@sentry/nextjs";
import { getServiceClient, getServerNetwork } from "@/lib/supabase";
import { readLiveMarketStates } from "@/lib/live-market-state";
import { BLOCKED_SLAB_ADDRESSES } from "@/lib/blocklist";

/**
 * The one place market rows are loaded.
 *
 * /api/markets and /api/stats must agree: they used to disagree badly enough
 * that the dashboard rendered "161 markets / $237K OI" beside pages showing 6
 * markets / ~$35K, which on a verifiability-first product reads as fabrication.
 * That was patched by having /api/stats HTTP-fetch /api/markets — correct in
 * result, but it costs a second serverless invocation (and its cold start) on
 * every stats request, and duplicates all the RPC work.
 *
 * Sharing the loader gets the same guarantee structurally: both routes read the
 * same rows from the same query merged with the same live on-chain state, in
 * process. Divergence now requires someone to deliberately filter differently.
 */

/**
 * Columns read from markets_with_stats.
 *
 * REDUCED SCHEMA (2026-07): the indexer was cut to history-only — market_stats
 * carries ONLY slab_address/volume_24h/volume_24h_usd/trade_count_24h/
 * last_price/network/updated_at. mark_price, index_price, open_interest_*,
 * total_open_interest, insurance_*, total_accounts, funding_rate, net_lp_pos,
 * lp_sum_abs, c_tot, vault_balance and stats_updated_at were dropped and are
 * NOT selected here. They are supplied by the on-chain merge below instead.
 */
export const MARKET_SELECT_FIELDS =
  "slab_address,mint_address,symbol,name,decimals,deployer,logo_url,metadata_source,max_leverage,trading_fee_bps," +
  "last_price,volume_24h,trade_count_24h," +
  "created_at,oracle_mode,dex_pool_address,mainnet_ca,oracle_authority";

export type MarketRegistryRow = Record<string, unknown>;

/**
 * Fetch registry rows, degrading through progressively simpler queries when a
 * migration has not been applied to this Supabase instance.
 *
 * Returns null on an error we cannot degrade past — callers fall back to their
 * own non-DB path rather than serving a half-answer.
 */
async function fetchRegistryRows(
  supabase: ReturnType<typeof getServiceClient>,
): Promise<MarketRegistryRow[] | null> {
  let { data, error } = await supabase
    .from("markets_with_stats")
    .select(MARKET_SELECT_FIELDS)
    .eq("network", getServerNetwork())
    .not("slab_address", "is", null)
    // GH#2072: .neq("indexer_excluded", true) excludes NULL rows (SQL: NULL <> true → NULL → excluded).
    // Since most markets have indexer_excluded=NULL, use .or() to include both NULL and non-true values.
    .or("indexer_excluded.is.null,indexer_excluded.neq.true");

  // Fallback 1: indexer_excluded column missing (migration 046 / 20260402170000 not applied).
  if (error && error.message?.includes("indexer_excluded")) {
    Sentry.captureMessage(
      "PERC-8387: indexer_excluded column missing — apply migration 046 + 20260402170000. " +
        "Falling back without indexer_excluded filter.",
      {
        level: "warning",
        tags: { endpoint: "market-registry", degraded: "true" },
        fingerprint: ["perc-8387-indexer-excluded-missing"],
      },
    );
    const fb1 = await supabase
      .from("markets_with_stats")
      .select(MARKET_SELECT_FIELDS)
      .eq("network", getServerNetwork())
      .not("slab_address", "is", null);
    data = fb1.data;
    error = fb1.error;
  }

  // Fallback 2: network column also missing (migration 20260329180000 not applied).
  if (error && error.message?.includes("network")) {
    Sentry.captureMessage(
      "PERC-8215: network column missing — apply migration 20260329180000. Falling back to unfiltered query.",
      {
        level: "warning",
        tags: { endpoint: "market-registry", degraded: "true" },
        fingerprint: ["perc-8215-network-column-missing"],
      },
    );
    const fb2 = await supabase
      .from("markets_with_stats")
      .select(MARKET_SELECT_FIELDS)
      .not("slab_address", "is", null);
    data = fb2.data;
    error = fb2.error;
  }

  // Fallback 3: catch-all for any other column-related error — bare query.
  if (error && (error.message?.includes("column") || error.message?.includes("does not exist"))) {
    Sentry.captureMessage(
      `PERC-8387: Unexpected column error in markets query, using bare fallback. Error: ${error.message}`,
      {
        level: "error",
        tags: { endpoint: "market-registry", degraded: "true" },
        fingerprint: ["perc-8387-bare-fallback"],
      },
    );
    const fb3 = await supabase.from("markets_with_stats").select(MARKET_SELECT_FIELDS);
    data = fb3.data;
    error = fb3.error;
  }

  if (error) {
    Sentry.captureException(error, { tags: { endpoint: "market-registry" } });
    return null;
  }

  return (data ?? []) as unknown as MarketRegistryRow[];
}

/**
 * Load registry rows merged with live on-chain state.
 *
 * Registry supplies what only Postgres has (identity, logo, 24h volume); the
 * chain supplies what only it has (price, OI, insurance, vault, c_tot). Blocked
 * slabs are dropped here so every consumer inherits that filter.
 *
 * A slab missing from the live map keeps its registry values — partial RPC
 * results degrade to the pre-merge behaviour rather than zeroing a market out.
 */
export async function loadMergedMarketRows(): Promise<MarketRegistryRow[] | null> {
  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    return null; // Supabase not configured — caller uses its on-chain path.
  }

  const rows = await fetchRegistryRows(supabase);
  if (rows === null) return null;

  const registryRows = rows.filter((m) => !BLOCKED_SLAB_ADDRESSES.has(m.slab_address as string));

  const liveStates = await readLiveMarketStates(
    registryRows.map((m) => String(m.slab_address ?? "")).filter(Boolean),
  );

  return registryRows.map((m) => {
    const live = liveStates.get(String(m.slab_address ?? ""));
    if (!live) return m;
    return {
      ...m,
      mark_price: live.markPriceUsd,
      // v17 has no separate index feed — mark is the only on-chain price.
      index_price: m.index_price ?? null,
      last_price: m.last_price ?? live.markPriceUsd,
      open_interest_long: live.oiLongQ,
      open_interest_short: live.oiShortQ,
      total_open_interest: live.totalOiQ,
      total_open_interest_usd: live.totalOiUsd,
      insurance_fund: live.insurance,
      insurance_balance: live.insurance,
      vault_balance: live.vault,
      c_tot: live.cTot,
    };
  });
}
