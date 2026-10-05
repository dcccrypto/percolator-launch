import { NextRequest, NextResponse } from "next/server";
import { validateSlabParam } from "@/lib/route-validators";
import { toE6 } from "@/lib/format";
import { boundedSet } from "@/lib/bounded-map";
import { change24h } from "@/lib/chart/header-stats";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// BUG 18 fix: this route is force-dynamic and previously always sent no-store,
// so under the hosted playground (no indexer backend) EVERY client poll (~10s,
// per useLivePrice) hit the upstream fresh, fanned out across every viewer.
// Cache the fallback response for a short TTL so repeated polls within the
// window reuse one upstream fetch instead of re-hitting it per viewer per poll.
const FALLBACK_CACHE_HEADERS = { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } as const;

type Stats24h = { change24h: number; high24h: string; low24h: string };

/** Short in-memory TTL cache for the GeckoTerminal fallback, keyed by slab.
 *  Belt-and-suspenders alongside FALLBACK_CACHE_HEADERS: on a warm serverless
 *  instance (or local dev, where there's no CDN in front to honor s-maxage)
 *  this still collapses repeated ~10s polls into one upstream fetch per TTL
 *  window per slab. */
const FALLBACK_CACHE_TTL_MS = 60_000;
// Hard cap on this in-memory cache. The GeckoTerminal fallback path serves ANY
// slab and writes an entry on every miss (including null misses), so the key
// space is attacker-controlled; TTL is checked only on read and nothing else
// evicts. Without a bound, a flood of distinct slabs would grow this Map without
// limit (memory-exhaustion DoS). Matches the sibling /api/chart route's cap.
const FALLBACK_CACHE_MAX_ENTRIES = 10_000;
const fallbackCache = new Map<string, { value: Stats24h | null; expiresAt: number }>();

const GECKOTERMINAL_OHLCV_BASE = "https://api.geckoterminal.com/api/v2/networks/solana/pools";

/** [timestamp, open, high, low, close, volume] — GeckoTerminal's OHLCV row shape. */
type GeckoOhlcvBar = [number, number, number, number, number, number];

/**
 * 24h stats derived directly from GeckoTerminal's public OHLCV API for the
 * market's own DEX pool — the same venue the market is priced from. The pool
 * address comes from this app's OWN Supabase-backed `/api/markets/:slab`
 * (reliable, independent of the Railway-hosted indexer) rather than a
 * hardcoded symbol map, so it works for ANY market — curated or
 * wizard-launched — as long as GeckoTerminal has indexed its pool. No Pyth.
 */
async function geckoTerminalStatsFallback(slab: string, origin: string, cookie?: string | null): Promise<Stats24h | null> {
  const cacheKey = `gt:${slab}`;
  const cached = fallbackCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const setCache = (value: Stats24h | null): Stats24h | null => {
    boundedSet(fallbackCache, cacheKey, { value, expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS }, FALLBACK_CACHE_MAX_ENTRIES);
    return value;
  };

  try {
    // Self-referential call rather than a fresh Supabase query here: /api/markets/:slab
    // already owns blocklist filtering, network (devnet/mainnet) scoping, slug resolution,
    // and the on-chain fallback for when Supabase itself isn't configured — reusing it keeps
    // this route from having to duplicate (and risk drifting from) all of that.
    // The waitlist gate (middleware) 401s /api/* without the visitor's pg_access session, so the
    // self-call must carry the caller's cookie — without it the 24h high/low/change went blank
    // the moment the gate was enabled (2026-10-02).
    const marketRes = await fetch(`${origin}/api/markets/${slab}`, {
      signal: AbortSignal.timeout(5_000),
      ...(cookie ? { headers: { cookie } } : {}),
    });
    if (!marketRes.ok) return setCache(null);
    const marketJson = (await marketRes.json()) as { market?: { dex_pool_address?: string | null } };
    const pool = marketJson.market?.dex_pool_address;
    if (!pool) return setCache(null);

    // GeckoTerminal leaves out hours with no trades, so 24 bars of a quiet pool can reach days
    // back. 25 bars always reach past now-24h (unless the pool is younger); the window below is
    // cut by timestamp.
    const url = `${GECKOTERMINAL_OHLCV_BASE}/${encodeURIComponent(pool)}/ohlcv/hour?aggregate=1&limit=25`;
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
    const last = bars[0][4]; // newest close
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoff = nowSec - 86_400;
    // Reference: the price at now-24h (the close of the last bar at or before it); with less
    // history, the first bar's open.
    const change = change24h(bars.map((b) => ({ timeSec: b[0], open: b[1], close: b[4] })).reverse(), last, nowSec);
    if (!change) return setCache(null);
    // High/low over the last 24h only, counting the price it opened at (the reference bar's
    // close) and the newest close.
    const refBar = bars.find((b) => b[0] <= cutoff);
    const seen = [last, ...(refBar ? [refBar[4]] : []), ...bars.filter((b) => b[0] > cutoff).flatMap((b) => [b[2], b[3]])];
    const high = Math.max(...seen);
    const low = Math.min(...seen);
    if (!Number.isFinite(high) || !Number.isFinite(low)) return setCache(null);

    const toE6Str = (v: number) => toE6(v).toString();
    return setCache({
      change24h: change.pct,
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

    // The oracle-price-history proxy that used to run first is gone. It called
    // `${NEXT_PUBLIC_API_URL}/prices/:slab` on percolator-api, a service that no
    // longer exists (the host answers "Application not found"), so it could only
    // ever fail — burning a round trip on every call of an endpoint useLivePrice
    // polls every 10s, per market. The indexer that replaced that service is
    // ingest-only: it serves /health and the Helius webhook, nothing else.
    //
    // The GeckoTerminal path below is the primary (and only) stats source. The
    // Pyth Benchmarks fallback that used to run first is gone too: NO PYTH.
    const prices: Array<{ price_e6: string; timestamp: number }> = [];

    if (prices.length === 0) {
      // geckoTerminalStatsFallback works for ANY market (looks up the pool via
      // /api/markets/:slab) as long as GeckoTerminal has indexed the pool, which
      // is the common case even for a brand-new pump.fun-style coin.
      const stats = await geckoTerminalStatsFallback(validSlab, req.nextUrl.origin, req.headers.get("cookie")).catch(() => null);
      // BUG 18 fix: was NO_STORE — this is the live path on the hosted playground
      // (no indexer backend), polled every ~10s by every viewer. Cache it briefly
      // so repeated polls within the window don't each re-hit GeckoTerminal
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
