/**
 * GET /api/chart/[mint]?timeframe=hour&aggregate=1&limit=24
 *
 * Fetches OHLCV candle data directly from GeckoTerminal's public API (no key
 * required). This route used to proxy to percolator-api's GET /chart/:mint,
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
 *      — fetch candles for that pool. GeckoTerminal returns rows
 *      newest-first; we reverse to ascending (oldest → newest) for the chart.
 *
 * Degrades gracefully on any failure (no pool found, upstream error, bad
 * data): returns `{ candles: [], poolAddress: null }` with a 200 status so
 * the client's oracle-price fallback (useTokenChart / TradingChart) still
 * has something to draw instead of erroring out.
 *
 * Response: { candles: CandleData[], poolAddress: string | null, cached: boolean }
 */

import { type NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { boundedSet } from "@/lib/bounded-map";

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

const GECKOTERMINAL_BASE = "https://api.geckoterminal.com/api/v2/networks/solana";
const FETCH_TIMEOUT_MS = 8_000;
const GECKO_HEADERS = { Accept: "application/json", "User-Agent": "percolator-chart-proxy/1.0" };

const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
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
    if (Date.now() - cached.at < ttl) return cached.pool;
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
    const res = await fetch(`${GECKOTERMINAL_BASE}/tokens/${mint}?include=top_pools`, {
      headers: GECKO_HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
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

/** Fetch + parse OHLCV candles for a resolved pool. Empty array on any failure/no-data. */
async function fetchCandles(
  pool: string,
  timeframe: string,
  aggregate: string,
  limit: string,
): Promise<CandleData[]> {
  try {
    const url =
      `${GECKOTERMINAL_BASE}/pools/${encodeURIComponent(pool)}/ohlcv/${timeframe}` +
      `?aggregate=${encodeURIComponent(aggregate)}&limit=${encodeURIComponent(limit)}`;
    const res = await fetch(url, { headers: GECKO_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return [];
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

  try {
    const pool = await resolveTopPool(canonicalMint);
    if (!pool) return emptyResponse();

    const cacheKey = `${pool}:${timeframe}:${aggregate}:${limit}`;
    const cached = candleCache.get(cacheKey);
    const age = cached ? Date.now() - cached.at : Infinity;

    // Fresh enough — serve without spending a GeckoTerminal call. This is
    // what keeps N open charts + the client's 60s poll inside GT's quota.
    if (cached && age < CANDLE_CACHE_TTL_MS) {
      return NextResponse.json(
        { candles: cached.candles, poolAddress: pool, cached: true },
        { headers: CACHE_HEADERS },
      );
    }

    const candles = await fetchCandles(pool, timeframe, aggregate, limit);
    if (candles.length > 0) {
      boundedSet(candleCache, cacheKey, { candles, at: Date.now() }, CACHE_MAX_ENTRIES);
      return NextResponse.json({ candles, poolAddress: pool, cached: false }, { headers: CACHE_HEADERS });
    }

    // Empty fetch = usually a GT 429, not "this pool has no history".
    // Stale-if-error: serve the last good batch (up to 15min old) instead of
    // blanking a chart that rendered fine a minute ago.
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
