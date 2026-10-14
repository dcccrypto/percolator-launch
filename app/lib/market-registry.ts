import * as Sentry from "@sentry/nextjs";
import { getServiceClient, getServerNetwork } from "@/lib/supabase";
import { readLiveMarketStateResolutions } from "@/lib/live-market-state";
import { BLOCKED_SLAB_ADDRESSES } from "@/lib/blocklist";
import { getConfig } from "@/lib/config";
import { isMissingColumnError } from "@/lib/supabase-missing-column";

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
  // Egress (review E2, 2026-10-14): rows that can never be listed are dropped IN THE QUERY, not
  // after the fetch. `status = 'closed'` is how the 2026-10-01 relaunch retired every old-wrapper
  // row (the view's own definition also excludes it; this keeps the filter if a live view drifts),
  // and slabs this instance has already PROVEN dead (tombstone / foreign owner, both permanent) are
  // excluded by address. `.not(...)` rather than `.neq(...)`: same SQL (`status <> 'closed'`; the
  // column is NOT NULL).
  let primary = supabase
    .from("markets_with_stats")
    .select(MARKET_SELECT_FIELDS)
    .eq("network", getServerNetwork())
    .not("slab_address", "is", null)
    .not("status", "eq", "closed");
  const gone = knownGoneFilter();
  if (gone) primary = primary.not("slab_address", "in", gone);
  let { data, error } = await primary
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
  if (isMissingColumnError(error, "network")) {
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
// ── Egress: one shared, short-lived copy per server instance (review E2, 2026-10-14) ──────────
//
// /api/markets (every URL variant), /api/stats and /api/funding/global all call this. Each call
// used to re-read every registry row from Supabase plus one batched RPC read; the CDN could not
// collapse them (5+ distinct URLs, a cookie-gated playground). Now an instance re-reads at most
// once per MARKET_ROWS_MEMO_MS, and concurrent callers share the one in-flight read.

const DEFAULT_MEMO_MS = 20_000;

function memoTtlMs(): number {
  const raw = process.env.MARKET_ROWS_MEMO_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MEMO_MS;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MEMO_MS;
}

let memo: { at: number; rows: MarketRegistryRow[] } | null = null;
let inflight: { startedAt: number; promise: Promise<MarketRegistryRow[] | null> } | null = null;

/**
 * Slabs PROVEN un-listable for good: the CloseSlab tombstone, or an account owned by another
 * program (an abandoned wrapper's market). Neither can become a live market of this wrapper again,
 * so they are excluded from later queries by address. Bounded so the query string stays small;
 * a plain RPC `null` is NOT recorded (a keypair-created account could still appear there).
 */
const knownGone = new Set<string>();
const KNOWN_GONE_MAX = 200;

function rememberGone(slab: string): void {
  if (knownGone.size < KNOWN_GONE_MAX) knownGone.add(slab);
}

function knownGoneFilter(): string | null {
  // Base58 only, so no quoting is needed inside PostgREST's in.(...) list.
  const slabs = [...knownGone].filter((s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s));
  return slabs.length > 0 ? `(${slabs.join(",")})` : null;
}

/** Test hook: forget the memo, any in-flight read and the proven-dead set. */
export function resetMarketRegistryCache(): void {
  memo = null;
  inflight = null;
  knownGone.clear();
}

/**
 * Load registry rows merged with live on-chain state (memoized; see above).
 *
 * `maxAgeMs` lowers the accepted age of the shared copy (never raises it past the TTL): the
 * post-registration fresh fetch (/api/markets ?fresh=) passes 3 s so a creator sees their new market, while
 * a flood of fresh requests still costs at most one read per that window per instance.
 *
 * The returned array and rows are shared between callers: treat them as read-only.
 */
export async function loadMergedMarketRows(opts: { maxAgeMs?: number } = {}): Promise<MarketRegistryRow[] | null> {
  const ttl = memoTtlMs();
  if (ttl === 0) return loadMergedMarketRowsUncached();
  const maxAge = Math.min(opts.maxAgeMs ?? ttl, ttl);
  const now = Date.now();
  if (memo && now - memo.at < maxAge) return memo.rows;
  if (inflight && now - inflight.startedAt < maxAge) return inflight.promise;
  const startedAt = now;
  const promise = loadMergedMarketRowsUncached()
    .then((rows) => {
      // Failures are not cached: the next caller retries.
      if (rows !== null && (!memo || memo.at <= startedAt)) memo = { at: startedAt, rows };
      return rows;
    })
    .finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
  inflight = { startedAt, promise };
  return promise;
}

async function loadMergedMarketRowsUncached(): Promise<MarketRegistryRow[] | null> {
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
  const wrapper = getConfig().programId;
  const current = registryRows.filter((m) => {
    const slab = String(m.slab_address ?? "");

    if (liveRead.missing.has(slab)) {
      // Optional chain: partial test doubles of readLiveMarketStateResolutions omit `tombstoned`.
      if (liveRead.tombstoned?.has(slab)) rememberGone(slab);
      return false;
    }

    const owner = liveStates.get(slab)?.owner;
    if (owner !== undefined && owner !== wrapper) {
      rememberGone(slab);
      return false;
    }
    return true;
  });

  return current.map((m) => {
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
