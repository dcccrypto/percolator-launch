import * as Sentry from "@sentry/nextjs";
import { isAcceptedWrapper, marketWorld } from "@/lib/v21/worlds";
import { getServiceClient, getServerNetwork } from "@/lib/supabase";
import { readLiveMarketStateResolutions } from "@/lib/live-market-state";
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
 * A slab confirmed dead is dropped: an explicit RPC `null`, or the wrapper-owned closed-market
 * tombstone CloseSlab leaves (CloseSlab shrinks to 16 bytes, it does not delete). Unresolved RPC/parse reads
 * keep their registry values and preserve the existing fail-open behaviour.
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

  const liveRead = await readLiveMarketStateResolutions(
    registryRows.map((m) => String(m.slab_address ?? "")).filter(Boolean),
  );
  const liveStates = liveRead.states;

  // Relaunch (2026-10-01): a registry row whose slab is owned by another
  // program is a market of an abandoned wrapper — never list it.
  //
  // GH#2988: distinguish positive account absence from an unresolved RPC gap.
  // A successful RPC `null`, or the CloseSlab tombstone (liveRead.missing covers both, and this
  // applies to curated PLAYGROUND_SLAB_META markets too), means the slab is gone and should no
  // longer be discoverable. RPC/parse uncertainty keeps the existing fail-open policy.
  const current = registryRows.filter((m) => {
    const slab = String(m.slab_address ?? "");

    if (liveRead.missing.has(slab)) {
      return false;
    }

    const owner = liveStates.get(slab)?.owner;
    return owner === undefined || isAcceptedWrapper(owner);
  });

  return current.map((m) => {
    const live = liveStates.get(String(m.slab_address ?? ""));
    if (!live) return m;
    // Flag on only: tag Supabase-only rows with their world from the slab's own owner (L-8), so the
    // v1 label survives the cutover. Absent when the flag is off or the owner is foreign/unknown.
    const world = marketWorld(live.owner);
    return {
      ...m,
      ...(world ? { world } : {}),
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
      // Real per-market leverage cap from on-chain initialMarginBps. The stored
      // column is 10 for every market (the indexer never derived it), which is
      // correct only by coincidence for 1000bps markets and wrong for the rest
      // (e.g. SOL 666bps -> 15x). Prefer the live value; fall back to the DB
      // column when the engine-config region couldn't be read (RPC/parse gap),
      // matching this file's "partial reads degrade to pre-merge behaviour" policy.
      max_leverage: live.maxLeverage ?? m.max_leverage,
      // BUG FIX (2026-09-25): completeness signal for filtering markets whose
      // creation died partway through (e.g. failed at "Create Earn vault",
      // before stake-pool init ever ran) — see LiveMarketState.isComplete's
      // doc comment in lib/live-market-state.ts for what this actually checks.
      // Left absent (not merged in) when live state couldn't be read, so a
      // transient RPC gap degrades to "unknown" rather than "incomplete" —
      // consumers (app/api/markets/route.ts) treat undefined as visible,
      // matching this file's existing "partial RPC results degrade to the
      // pre-merge behaviour rather than zeroing a market out" policy.
      is_complete: live.isComplete,
    };
  });
}
