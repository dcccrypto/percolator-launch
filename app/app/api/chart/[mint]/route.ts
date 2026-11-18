/**
 * GET /api/chart/[mint]?timeframe=hour&aggregate=1&limit=24[&before=<unixSeconds>]
 *
 * Fetches OHLCV candle data directly from GeckoTerminal's public API (no key
 * required). Optional: set COINGECKO_API_KEY (+ COINGECKO_API_TIER=demo|pro) to use
 * the authenticated CoinGecko on-chain API instead — see lib/gecko-fetch.ts (#2578). This route used to proxy to percolator-api's GET /chart/:mint,
 * but that Railway service is down/deprecated ("Application not found") —
 * every trade-page chart rendered empty axes because the proxy target no
 * longer exists. GeckoTerminal fetch now lives here instead, mirroring the
 * pattern already used by the 24h-stats fallback (see
 * geckoTerminalStatsFallback in app/api/prices/[slab]/route.ts) and the logo
 * resolver (app/api/token-logo/[mint]/route.ts).
 *
 * Resolution:
 *   1. GET /networks/solana/tokens/{mint}?include=top_pools — resolve the
 *      mint's most-liquid pool (highest reserve_in_usd among the returned
 *      `included` pool objects).
 *   2. GET /networks/solana/pools/{pool}/ohlcv/{timeframe}?aggregate=&limit=
 *      [&before_timestamp=] — fetch candles for that pool. GeckoTerminal
 *      returns rows newest-first; we reverse to ascending (oldest → newest)
 *      for the chart.
 *
 * `before` (optional, unix SECONDS, integer): scroll-back paging (#2581).
 * GeckoTerminal's OHLCV endpoint accepts `before_timestamp` and pages straight
 * past the single window this route used to fetch — two requests retrieve a
 * token's ENTIRE history back to pool creation. Validated as a plain digit
 * string before being forwarded; an invalid/missing value is silently treated
 * as "no paging" (page 1) rather than erroring, matching how `aggregate`/
 * `limit` already degrade. It also joins the cache key below — without that,
 * page 2 would be served page 1's cached bars.
 *
 * Degrades gracefully on any failure (no pool found, upstream error, bad
 * data): returns `{ candles: [], poolAddress: null }` with a 200 status so
 * the client's oracle-price fallback (useTokenChart / TradingChart) still
 * has something to draw instead of erroring out.
 *
 * Response: { candles: CandleData[], poolAddress: string | null, cached: boolean }
 */

import { cacheAgeMs } from "@/lib/cache-age";
import { type NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { registeredPoolForSlab } from "@/lib/registered-pool";
import { boundedSet } from "@/lib/bounded-map";
import { geckoFetch, getGeckoConfig } from "@/lib/gecko-fetch";

export const dynamic = "force-dynamic";

// Re-export the CandleData type so consumers can import it from the route module
// without importing from percolator-api directly.
export interface CandleData {
  timestamp: number; // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}


const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
} as const;
/** A `before`-paged (historical) batch is IMMUTABLE — a closed time window's
 *  OHLCV bars never change, unlike the live page which grows a new bar every
 *  tick — so both the in-process cache (see HISTORICAL_CANDLE_TTL below) and
 *  the CDN may hold it far longer than a page-1 response. This is also the
 *  #2578 mitigation: once one viewer pages a (mint, timeframe, before) back,
 *  every other viewer (and a reload of the same one) is served for free
 *  instead of spending another GeckoTerminal call. */
const HISTORICAL_CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=604800, immutable",
} as const;
/** Failure responses must NOT be CDN-cached: a GeckoTerminal 429/error would
 *  otherwise pin an EMPTY chart for 60s+ even though a retry seconds later
 *  would succeed — one rate-limit blip blanked every viewer's chart. */
const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

/** GeckoTerminal-supported OHLCV timeframe granularities. */
const VALID_TIMEFRAMES = new Set(["minute", "hour", "day"]);

/* ── In-process GeckoTerminal quota protection ──────────────────────────────
 * GT's free tier allows ~30 calls/min per IP, and every chart request used to
 * spend TWO of them (token→top_pools + ohlcv) with zero reuse — the pool
 * lookup was repeated on every 60s poll and every timeframe switch, for every
 * open chart. A single browser session could exhaust the quota, after which
 * this route silently served empty candles (and the CDN cached the emptiness).
 * Verified empirically: two chart requests in quick succession succeeded, the
 * following ones returned 0 bars with pool resolution dead until cooldown.
 *
 * - mint → pool: pools don't move; cache hits for 6h, misses for 60s (a miss
 *   may be a 429, not a real "no pools" — don't pin it).
 * - candles: cache per (pool, timeframe, aggregate, limit) for 45s (matches
 *   the client's 60s poll), and keep the last good batch for 15min as a
 *   stale-if-error fallback so a 429 degrades to slightly-old candles
 *   instead of a blank chart.
 * Per-instance only (serverless), but the CDN s-maxage covers cross-instance
 * reuse on the hosted deployment. */
const POOL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const POOL_MISS_TTL_MS = 60 * 1000;
const CANDLE_CACHE_TTL_MS = 45 * 1000;
const CANDLE_STALE_MAX_MS = 15 * 60 * 1000;
/** A `before`-paged batch never goes stale by definition (see
 *  HISTORICAL_CACHE_HEADERS above) — the in-process cache entry is valid
 *  until it's evicted by candleCache's LRU cap, not on a timer. Modeled as
 *  "never expires on TTL grounds" rather than a very-long finite TTL so the
 *  stale-if-error fallback path below never has a reason to fire for it. */
const HISTORICAL_CANDLE_TTL_MS = Infinity;
// Hard entry cap per cache. The route validates `mint` only as a well-formed
// pubkey (not a real token), and resolveTopPool caches even NULL misses — so a
// warm/long-lived instance hit with millions of distinct random pubkeys would
// grow these Maps without bound (memory DoS). TTL is checked only on read,
// never evicted, so the cap is the real backstop. ~10k small entries is far
// above the handful of live markets yet trivially bounded (~sub-MB).
const CACHE_MAX_ENTRIES = 10_000;
const poolCache = new Map<string, { pool: string | null; at: number }>();
const candleCache = new Map<string, { candles: CandleData[]; at: number }>();

/** [unixSeconds, open, high, low, close, volume] — GeckoTerminal's OHLCV row shape. */
type GeckoOhlcvBar = [number, number, number, number, number, number];

interface GeckoPoolIncluded {
  id?: string;
  attributes?: {
    address?: string;
  };
}

function emptyResponse() {
  // Empty results are almost always transient (GT rate limit / upstream
  // hiccup) — never CDN-cache them; see NO_STORE_HEADERS.
  return NextResponse.json(
    { candles: [] as CandleData[], poolAddress: null, cached: false },
    { headers: NO_STORE_HEADERS },
  );
}

/**
 * Resolve a mint's most-liquid pool via GeckoTerminal's `top_pools` include.
 *
 * Uses GeckoTerminal's own `relationships.top_pools` ORDER (best-first, per
 * its ranking) rather than re-sorting the `included` pool objects by a
 * single field like `reserve_in_usd` — that field is trivially spoofable for
 * freshly-launched/manipulated pools. Verified empirically: for SOL, a
 * low-volume "CASHCAT/SOL" pool reported a fake `reserve_in_usd` of >$2B —
 * far above the real SOL/USDC pool's ~$25M — while GT's own `top_pools`
 * order correctly ranked the legit SOL/USDC pool first. Trusting GT's order
 * avoids picking the manipulated pool.
 *
 * Returns null on any failure or when the token has no indexed pools.
 */
async function resolveTopPool(mint: string): Promise<string | null> {
  const cached = poolCache.get(mint);
  if (cached) {
    const ttl = cached.pool ? POOL_CACHE_TTL_MS : POOL_MISS_TTL_MS;
    if (cacheAgeMs(cached.at) < ttl) return cached.pool;
  }
  const pool = await resolveTopPoolUncached(mint);
  // A resolved pool is durable knowledge; a null may just be a 429 — the
  // short miss-TTL above keeps us from hammering GT while never pinning it.
  boundedSet(poolCache, mint, { pool: pool ?? cached?.pool ?? null, at: Date.now() }, CACHE_MAX_ENTRIES);
  // If this attempt failed but we have ANY previously-known pool, keep using
  // it — pools don't move, and a rate-limited lookup must not blank a chart
  // that worked a minute ago.
  return pool ?? cached?.pool ?? null;
}

async function resolveTopPoolUncached(mint: string): Promise<string | null> {
  try {
    const res = await geckoFetch(`${getGeckoConfig().base}/tokens/${mint}?include=top_pools`);
    if (!res || !res.ok) return null;
    const json = await res.json();

    const topIds: string[] = (json?.data?.relationships?.top_pools?.data ?? [])
      .map((p: { id?: string }) => p?.id)
      .filter((id: string | undefined): id is string => !!id);
    if (topIds.length === 0) return null;

    const included: GeckoPoolIncluded[] = Array.isArray(json?.included) ? json.included : [];
    const includedById = new Map(included.map((p) => [p.id, p]));

    for (const id of topIds) {
      const fromIncluded = includedById.get(id)?.attributes?.address;
      if (fromIncluded) return fromIncluded;
      // `included` may be absent/incomplete for this id — the id itself is
      // "solana_<poolAddress>"; fall back to parsing it directly.
      const parts = id.split("_");
      if (parts.length >= 2) return parts.slice(1).join("_");
    }
    return null;
  } catch {
    return null;
  }
}

/** Fetch + parse OHLCV candles for a resolved pool. Empty array on any failure/no-data.
 *  `before` (unix seconds, already validated by the caller) pages backward via
 *  GeckoTerminal's `before_timestamp` — omitted entirely for a page-1 request. */
async function fetchCandles(
  pool: string,
  timeframe: string,
  aggregate: string,
  limit: string,
  before?: string,
): Promise<CandleData[]> {
  try {
    const url =
      `${getGeckoConfig().base}/pools/${encodeURIComponent(pool)}/ohlcv/${timeframe}` +
      `?aggregate=${encodeURIComponent(aggregate)}&limit=${encodeURIComponent(limit)}` +
      (before ? `&before_timestamp=${encodeURIComponent(before)}` : "");
    const res = await geckoFetch(url);
    if (!res || !res.ok) return [];
    const json = await res.json();
    const bars = json?.data?.attributes?.ohlcv_list as GeckoOhlcvBar[] | undefined;
    if (!Array.isArray(bars) || bars.length === 0) return [];

    // GeckoTerminal returns rows newest-first; reverse to ascending
    // (oldest -> newest), which is what the chart component expects.
    return bars
      .filter((b): b is GeckoOhlcvBar => Array.isArray(b) && b.length === 6)
      .map((b) => ({
        timestamp: b[0] * 1000,
        open: b[1],
        high: b[2],
        low: b[3],
        close: b[4],
        volume: b[5],
      }))
      .reverse();
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;

  // Validate mint before making any upstream calls. PublicKey constructor
  // ensures the bytes decode to a valid 32-byte point, not just a
  // base58-alphabet string.
  let canonicalMint: string;
  try {
    if (!mint) throw new Error("missing");
    canonicalMint = new PublicKey(mint).toBase58();
  } catch {
    return NextResponse.json({ error: "Invalid mint address" }, { status: 400 });
  }

  const sp = req.nextUrl.searchParams;
  const timeframeParam = (sp.get("timeframe") ?? "hour").toLowerCase();
  const timeframe = VALID_TIMEFRAMES.has(timeframeParam) ? timeframeParam : "hour";
  const aggregateParam = sp.get("aggregate") ?? "1";
  const aggregate = /^\d+$/.test(aggregateParam) ? aggregateParam : "1";
  const limitParam = sp.get("limit") ?? "100";
  const limitParsed = parseInt(limitParam, 10);
  const limit = String(Number.isFinite(limitParsed) ? Math.min(Math.max(limitParsed, 1), 1000) : 100);
  // Scroll-back paging (#2581). A plain non-zero digit string, or undefined —
  // never rejects the request; an invalid value just falls back to page 1.
  const beforeParam = sp.get("before");
  const before =
    beforeParam && /^\d+$/.test(beforeParam) && Number(beforeParam) > 0 ? beforeParam : undefined;

  // A REGISTERED market's chart is its registered pool (the venue the keeper prices it from),
  // never GeckoTerminal's "top pool" for the mint (lib/registered-pool.ts).
  const slabParam = sp.get("slab");

  try {
    let registered: Awaited<ReturnType<typeof registeredPoolForSlab>> = null;
    if (slabParam) {
      try {
        registered = await registeredPoolForSlab(slabParam, canonicalMint);
      } catch {
        // Can't tell which venue this market uses right now: never fall back to a different pool
        // (that IS the mismatch), and never let the CDN keep this answer.
        return NextResponse.json(
          { candles: [], poolAddress: null, cached: false, error: "Market venue lookup failed; try again shortly." },
          { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" } },
        );
      }
    }
    const pool = registered?.pool ?? (await resolveTopPool(canonicalMint));
    if (!pool) return emptyResponse();

    // `before` joins the key — otherwise page 2 would read (and pollute) page
    // 1's cache entry.
    const cacheKey = `${pool}:${timeframe}:${aggregate}:${limit}:${before ?? "-"}`;
    const cached = candleCache.get(cacheKey);
    const age = cached ? cacheAgeMs(cached.at) : Infinity;
    const ttl = before ? HISTORICAL_CANDLE_TTL_MS : CANDLE_CACHE_TTL_MS;
    const cacheHeaders = before ? HISTORICAL_CACHE_HEADERS : CACHE_HEADERS;

    // Fresh enough — serve without spending a GeckoTerminal call. This is
    // what keeps N open charts + the client's 60s poll inside GT's quota
    // (page 1), and — for a `before` page — makes every repeat/other-viewer
    // request of a page some earlier viewer already scrolled to completely
    // free (see HISTORICAL_CACHE_HEADERS).
    if (cached && age < ttl) {
      return NextResponse.json(
        { candles: cached.candles, poolAddress: pool, cached: true },
        { headers: cacheHeaders },
      );
    }

    const candles = await fetchCandles(pool, timeframe, aggregate, limit, before);
    if (candles.length > 0) {
      boundedSet(candleCache, cacheKey, { candles, at: Date.now() }, CACHE_MAX_ENTRIES);
      return NextResponse.json({ candles, poolAddress: pool, cached: false }, { headers: cacheHeaders });
    }

    // Empty fetch = usually a GT 429, not "this pool has no history" — for
    // page 1. Stale-if-error: serve the last good batch (up to 15min old)
    // instead of blanking a chart that rendered fine a minute ago. (Never
    // reached for a `before` page: its ttl is infinite, so a still-cached
    // entry already returned above; this only runs for a `before` page whose
    // entry was evicted, where there's nothing to fall back to anyway.)
    if (cached && age < CANDLE_STALE_MAX_MS && cached.candles.length > 0) {
      return NextResponse.json(
        { candles: cached.candles, poolAddress: pool, cached: true },
        { headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      { candles, poolAddress: pool, cached: false },
      { headers: NO_STORE_HEADERS },
    );
  } catch {
    // Never let an unexpected error break the chart — the client falls back
    // to drawing from the live oracle price when candles is empty.
    return emptyResponse();
  }
}
