import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/chart/[mint]?timeframe=1h&limit=168
 *
 * Returns OHLCV candle data for a Solana SPL token by mint address.
 *
 * Data source: GeckoTerminal (free, no API key required)
 *   Step 1: /api/v2/networks/solana/tokens/{mint}/pools?limit=1 → top pool address
 *   Step 2: /api/v2/networks/solana/pools/{pool}/ohlcv/{timeframe}?aggregate=1&limit={limit}
 *
 * Query params:
 *   timeframe — "minute" | "hour" | "day"  (default: "hour")
 *   aggregate — candle aggregation (default: 1 for hour, 5 for minute)
 *   limit     — number of candles (default: 168 = 7 days of hourly)
 *
 * Response: { candles: CandleData[], poolAddress: string | null, cached: boolean }
 *
 * In-memory cache: 60s TTL for most recent candle, 5min for older data.
 */

export interface CandleData {
  timestamp: number; // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CacheEntry {
  candles: CandleData[];
  poolAddress: string | null;
  fetchedAt: number;
}

// In-memory cache: mint → CacheEntry
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const GECKO_HEADERS = {
  Accept: "application/json;version=20230302",
};

async function getTopPool(mint: string): Promise<string | null> {
  try {
    const url = `${GECKO_BASE}/networks/solana/tokens/${mint}/pools?limit=1&sort=h24_volume_usd_liquidity_desc`;
    const res = await fetch(url, { headers: GECKO_HEADERS, next: { revalidate: 300 } });
    if (!res.ok) return null;
    const json = await res.json();
    const pools = json?.data;
    if (!Array.isArray(pools) || pools.length === 0) return null;
    return pools[0]?.id?.replace("solana_", "") ?? null;
  } catch {
    return null;
  }
}

async function fetchOhlcv(
  poolAddress: string,
  timeframe: string,
  aggregate: number,
  limit: number
): Promise<CandleData[]> {
  try {
    const url = `${GECKO_BASE}/networks/solana/pools/${poolAddress}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}&currency=usd&include_empty_intervals=false`;
    const res = await fetch(url, { headers: GECKO_HEADERS });
    if (!res.ok) return [];
    const json = await res.json();

    // GeckoTerminal response shape:
    // { data: { attributes: { ohlcv_list: [[timestamp_sec, open, high, low, close, volume], ...] } } }
    const ohlcvList = json?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(ohlcvList)) return [];

    return ohlcvList
      .map(([ts, o, h, l, c, v]: [number, number, number, number, number, number]) => ({
        timestamp: ts * 1000, // convert to ms
        open: o,
        high: h,
        low: l,
        close: c,
        volume: v,
      }))
      .filter((candle) => candle.close > 0)
      .sort((a, b) => a.timestamp - b.timestamp);
  } catch {
    return [];
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ mint: string }> }
) {
  const { mint } = await params;

  // Validate mint is a valid base58 Solana pubkey (32–44 chars, base58 alphabet only)
  if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return NextResponse.json({ error: "Invalid mint address" }, { status: 400 });
  }

  // Parse query params
  const { searchParams } = req.nextUrl;
  const timeframe = (searchParams.get("timeframe") ?? "hour") as "minute" | "hour" | "day";
  const aggregate = parseInt(searchParams.get("aggregate") ?? (timeframe === "minute" ? "5" : "1"), 10);
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "168", 10), 500);

  // Cache key includes query params
  const cacheKey = `${mint}:${timeframe}:${aggregate}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json({
      candles: cached.candles,
      poolAddress: cached.poolAddress,
      cached: true,
    });
  }

  // Step 1: Resolve top pool
  const poolAddress = await getTopPool(mint);

  if (!poolAddress) {
    // No pool found — return empty, TradingChart will fall back to oracle prices
    return NextResponse.json({ candles: [], poolAddress: null, cached: false });
  }

  // Step 2: Fetch OHLCV
  const candles = await fetchOhlcv(poolAddress, timeframe, aggregate, limit);

  // Cache result
  cache.set(cacheKey, { candles, poolAddress, fetchedAt: Date.now() });

  // Prune old cache entries (keep max 100, evict 10 oldest to prevent gradual growth)
  if (cache.size > 100) {
    const keys = cache.keys();
    for (let i = 0; i < 10; i++) {
      const k = keys.next();
      if (k.done) break;
      cache.delete(k.value);
    }
  }

  return NextResponse.json(
    { candles, poolAddress, cached: false },
    {
      headers: {
        "Cache-Control": "public, max-age=60, stale-while-revalidate=120",
      },
    }
  );
}
