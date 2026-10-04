import { NextResponse } from "next/server";
import { getTrendingTokens, type TrendingTokensResult } from "@/lib/trending-tokens";

// Reads no request input, but the upstream data is live — keep it dynamic and
// set real CDN headers (mirrors /api/leaderboard).
export const dynamic = "force-dynamic";

/**
 * Cache policy. GeckoTerminal's keyless tier is 30 calls/min per IP and the chart
 * route already spends that budget from Vercel's shared egress, so this route asks
 * upstream at most once a minute per warm instance (memo below) and the CDN serves
 * everyone else. Well inside CoinGecko's attribution/caching terms (cache <= 24h).
 * A "source unavailable" answer is cached briefly so recovery shows up fast.
 */
const TRENDING_CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
} as const;
const TRENDING_UNAVAILABLE_HEADERS = {
  "Cache-Control": "public, s-maxage=15, stale-while-revalidate=30",
} as const;
const MEMO_TTL_MS = 60_000;

// Route files may only export handlers/config, so tests reset this with vi.resetModules().
let memo: { at: number; result: TrendingTokensResult } | null = null;

/**
 * GET /api/trending-tokens
 *
 * Third-party tokens trending on Solana DEXs that a Percolator market could be
 * created on and that don't have one yet (lib/trending-tokens). Fails soft: always
 * a list (possibly empty) plus `sourceEmpty`, never a 500.
 */
export async function GET() {
  try {
    if (memo && Date.now() - memo.at < MEMO_TTL_MS) {
      return NextResponse.json(memo.result, { headers: TRENDING_CACHE_HEADERS });
    }
    const result = await getTrendingTokens();
    if (result.sourceEmpty) {
      return NextResponse.json(result, { headers: TRENDING_UNAVAILABLE_HEADERS });
    }
    memo = { at: Date.now(), result };
    return NextResponse.json(result, { headers: TRENDING_CACHE_HEADERS });
  } catch (err) {
    console.warn("[trending-tokens] unexpected failure:", err instanceof Error ? err.message : String(err));
    const empty: TrendingTokensResult = {
      tokens: [],
      generatedAt: new Date().toISOString(),
      sourceEmpty: true,
      sources: { geckoterminal: "error", pumpfun: "error" },
    };
    return NextResponse.json(empty, { headers: { "Cache-Control": "no-store" } });
  }
}
