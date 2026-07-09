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

/** GeckoTerminal-supported OHLCV timeframe granularities. */
const VALID_TIMEFRAMES = new Set(["minute", "hour", "day"]);

/** [unixSeconds, open, high, low, close, volume] — GeckoTerminal's OHLCV row shape. */
type GeckoOhlcvBar = [number, number, number, number, number, number];

interface GeckoPoolIncluded {
  id?: string;
  attributes?: {
    address?: string;
  };
}

function emptyResponse() {
  return NextResponse.json(
    { candles: [] as CandleData[], poolAddress: null, cached: false },
    { headers: CACHE_HEADERS },
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

    const candles = await fetchCandles(pool, timeframe, aggregate, limit);
    return NextResponse.json({ candles, poolAddress: pool, cached: false }, { headers: CACHE_HEADERS });
  } catch {
    // Never let an unexpected error break the chart — the client falls back
    // to drawing from the live oracle price when candles is empty.
    return emptyResponse();
  }
}
