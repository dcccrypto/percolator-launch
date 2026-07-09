import { NextRequest, NextResponse } from "next/server";
import { getBackendUrl } from "@/lib/config";
import { validateSlabParam } from "@/lib/route-validators";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// BUG 18 fix: this route is force-dynamic and previously always sent no-store,
// so under the hosted playground (no indexer backend) EVERY client poll (~10s,
// per useLivePrice) fell through to pythStatsFallback() and hit
// benchmarks.pyth.network fresh, fanned out across every viewer, and degraded
// to { stats: null } on 429. Mirror the sibling /api/chart/pyth route: cache
// the fallback response for a short TTL so repeated polls within the window
// reuse one upstream fetch instead of re-hitting Pyth per viewer per poll.
const FALLBACK_CACHE_HEADERS = { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } as const;

/** Pyth Benchmarks — same public source /api/chart/pyth proxies for chart
 *  history. Used as the 24h-stats fallback when the indexer backend is not
 *  running (local playground, and the hosted playground deploy): without it
 *  this route 502s every 10s and 24H HIGH / 24H LOW render as dashes forever. */
const PYTH_BASE = "https://benchmarks.pyth.network/v1/shims/tradingview/history";

type Stats24h = { change24h: number; high24h: string; low24h: string };

/** Short in-memory TTL cache for pythStatsFallback(), keyed by slab. Belt-and-
 *  suspenders alongside FALLBACK_CACHE_HEADERS: on a warm serverless instance
 *  (or local dev, where there's no CDN in front to honor s-maxage) this still
 *  collapses repeated ~10s polls into one upstream fetch per TTL window per slab. */
const FALLBACK_CACHE_TTL_MS = 60_000;
const fallbackCache = new Map<string, { value: Stats24h | null; expiresAt: number }>();

/** Compute 24h stats from Pyth Benchmarks hourly bars for a playground slab.
 *  Returns null when the slab has no playground meta or Pyth has no data —
 *  callers then respond `{ stats: null }` (dashes in the UI, no error spam). */
async function pythStatsFallback(slab: string): Promise<Stats24h | null> {
  const cached = fallbackCache.get(slab);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const meta = PLAYGROUND_SLAB_META[slab];
  if (!meta) return null;
  // "JUP-PERP" → "Crypto.JUP/USD". Guard the base so only sane symbols reach Pyth.
  const base = meta.symbol.split("-")[0];
  if (!/^[A-Z0-9]{2,10}$/.test(base)) return null;

  const to = Math.floor(Date.now() / 1000);
  const from = to - 86_400;
  const url = `${PYTH_BASE}?symbol=${encodeURIComponent(`Crypto.${base}/USD`)}&resolution=60&from=${from}&to=${to}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "percolator-prices-proxy/1.0" },
    signal: AbortSignal.timeout(10_000),
  });
  // Cache negative results too (short TTL) — otherwise a rate-limited (429)
  // upstream gets hammered again on the very next ~10s poll instead of backing off.
  if (!res.ok) {
    fallbackCache.set(slab, { value: null, expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS });
    return null;
  }
  const data = (await res.json()) as { s?: string; o?: number[]; h?: number[]; l?: number[]; c?: number[] };
  if (data.s !== "ok" || !data.o?.length || !data.h?.length || !data.l?.length || !data.c?.length) {
    fallbackCache.set(slab, { value: null, expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS });
    return null;
  }

  const high = Math.max(...data.h);
  const low = Math.min(...data.l);
  const first = data.o[0];
  const last = data.c[data.c.length - 1];
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(first) || first <= 0) {
    fallbackCache.set(slab, { value: null, expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS });
    return null;
  }

  const toE6Str = (v: number) => BigInt(Math.round(v * 1_000_000)).toString();
  const result: Stats24h = {
    change24h: ((last - first) / first) * 100,
    high24h: toE6Str(high),
    low24h: toE6Str(low),
  };
  fallbackCache.set(slab, { value: result, expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS });
  return result;
}

const GECKOTERMINAL_OHLCV_BASE = "https://api.geckoterminal.com/api/v2/networks/solana/pools";

/** [timestamp, open, high, low, close, volume] — GeckoTerminal's OHLCV row shape. */
type GeckoOhlcvBar = [number, number, number, number, number, number];

/**
 * Fallback 24h stats derived directly from GeckoTerminal's public OHLCV API,
 * for markets `pythStatsFallback` can't cover — anything without a
 * `PLAYGROUND_SLAB_META` entry (every wizard/community-launched market) or
 * without a mapped Pyth feed for its underlying asset. Same shape/caching
 * discipline as `pythStatsFallback`; the only difference is the upstream
 * source and that the DEX pool address comes from this app's OWN
 * Supabase-backed `/api/markets/:slab` (reliable, independent of the
 * Railway-hosted indexer the primary path above already degrades away from)
 * instead of a hardcoded symbol map — so it works for ANY market, including
 * ones for tokens Pyth has never heard of (e.g. a freshly-launched pump.fun
 * coin), as long as GeckoTerminal has indexed its pool.
 */
async function geckoTerminalStatsFallback(slab: string, origin: string): Promise<Stats24h | null> {
  const cacheKey = `gt:${slab}`;
  const cached = fallbackCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const setCache = (value: Stats24h | null): Stats24h | null => {
    fallbackCache.set(cacheKey, { value, expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS });
    return value;
  };

  try {
    // Self-referential call rather than a fresh Supabase query here: /api/markets/:slab
    // already owns blocklist filtering, network (devnet/mainnet) scoping, slug resolution,
    // and the on-chain fallback for when Supabase itself isn't configured — reusing it keeps
    // this route from having to duplicate (and risk drifting from) all of that.
    const marketRes = await fetch(`${origin}/api/markets/${slab}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!marketRes.ok) return setCache(null);
    const marketJson = (await marketRes.json()) as { market?: { dex_pool_address?: string | null } };
    const pool = marketJson.market?.dex_pool_address;
    if (!pool) return setCache(null);

    const url = `${GECKOTERMINAL_OHLCV_BASE}/${encodeURIComponent(pool)}/ohlcv/hour?aggregate=1&limit=24`;
    const res = await fetch(url, {
      headers: { "User-Agent": "percolator-prices-proxy/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return setCache(null);
    const data = (await res.json()) as {
      data?: { attributes?: { ohlcv_list?: GeckoOhlcvBar[] } };
    };
    const bars = data.data?.attributes?.ohlcv_list ?? [];
    if (bars.length === 0) return setCache(null);

    // Newest-first per GeckoTerminal's API contract.
    const high = Math.max(...bars.map((b) => b[2]));
    const low = Math.min(...bars.map((b) => b[3]));
    const last = bars[0][4];                 // newest close
    const first = bars[bars.length - 1][1];  // oldest open
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(first) || first <= 0) {
      return setCache(null);
    }

    const toE6Str = (v: number) => BigInt(Math.round(v * 1_000_000)).toString();
    return setCache({
      change24h: ((last - first) / first) * 100,
      high24h: toE6Str(high),
      low24h: toE6Str(low),
    });
  } catch {
    return setCache(null);
  }
}

/**
 * GET /api/prices/[slab]
 *
 * Proxies the backend /prices/:slab endpoint and transforms the response
 * into the stats shape expected by useLivePrice.ts:
 *
 *   { stats?: { change24h?: number; high24h?: string; low24h?: string } }
 *
 * Backend returns: { prices: [{ price_e6: string, timestamp: number }] }
 * sorted descending by timestamp, up to 100 entries (oracle price history).
 *
 * We compute 24h stats from the history:
 *  - high24h / low24h: max/min price_e6 in the window
 *  - change24h: % change from oldest entry in window vs latest
 *
 * MEDIUM-003: Added slab parameter validation.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  try {
    const { slab } = await params;

    // Validate slab parameter format
    const validation = validateSlabParam(slab);
    if (!validation.valid) {
      return validation.response;
    }
    const validSlab = validation.slab;

    // Primary: indexer backend oracle-price history. Absent on the local /
    // hosted playground — any failure falls through to the Pyth fallback
    // instead of 502ing (this endpoint is polled every 10s by useLivePrice).
    // getBackendUrl() THROWS when NEXT_PUBLIC_API_URL is unset (the documented
    // playground config), so it must be inside this try too.
    let prices: Array<{ price_e6: string; timestamp: number }> = [];
    try {
      const backendUrl = getBackendUrl();
      const res = await fetch(`${backendUrl}/prices/${validSlab}`, {
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json() as {
          prices?: Array<{ price_e6: string; timestamp: number }>;
        };
        prices = data.prices ?? [];
      }
    } catch {
      /* backend unreachable — use the Pyth fallback below */
    }

    if (prices.length === 0) {
      // pythStatsFallback only covers the curated PLAYGROUND_SLAB_META markets
      // (SOL/BONK/JUP/TRUMP/PENGU) — null for anything else, including every
      // wizard/community-launched market. geckoTerminalStatsFallback picks up
      // there: it works for ANY market (looks up the pool via /api/markets/:slab)
      // as long as GeckoTerminal has indexed the pool, which is the common case
      // even for a brand-new pump.fun-style coin.
      let stats = await pythStatsFallback(validSlab).catch(() => null);
      if (!stats) {
        stats = await geckoTerminalStatsFallback(validSlab, req.nextUrl.origin).catch(() => null);
      }
      // BUG 18 fix: was NO_STORE — this is the live path on the hosted playground
      // (no indexer backend), polled every ~10s by every viewer. Cache it briefly
      // so repeated polls within the window don't each re-hit Pyth/GeckoTerminal
      // (see FALLBACK_CACHE_HEADERS / fallbackCache above).
      return NextResponse.json({ stats }, { headers: FALLBACK_CACHE_HEADERS });
    }

    // Prices are sorted desc (newest first). Find entries within last 24h.
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoff24h = nowSec - 86_400;

    const window = prices.filter((p) => p.timestamp >= cutoff24h);
    const all = window.length > 0 ? window : prices; // fall back to all if window empty

    const values = all.map((p) => BigInt(p.price_e6));
    const latest = values[0];                              // newest (sorted desc)
    const oldest = values[values.length - 1];              // oldest in window

    let high = values[0];
    let low = values[0];
    for (const v of values) {
      if (v > high) high = v;
      if (v < low) low = v;
    }

    // change24h as percentage
    const change24h =
      oldest > 0n
        ? (Number(latest - oldest) / Number(oldest)) * 100
        : 0;

    return NextResponse.json(
      {
        stats: {
          change24h,
          high24h: high.toString(),
          low24h: low.toString(),
        },
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    Sentry.captureException(err, { tags: { endpoint: "/api/prices/[slab]" } });
    return NextResponse.json(
      { error: "Failed to fetch price stats" },
      { status: 502, headers: NO_STORE },
    );
  }
}
