import { NextResponse } from "next/server";
import { getTrendingTokens, type TrendingTokensResult } from "@/lib/trending-tokens";

// Reads no request input, but the upstream data is live — keep it dynamic and
// set real CDN headers (mirrors /api/leaderboard): one server fetch per ~15s
// window, served to every visitor from the edge cache regardless of traffic.
export const dynamic = "force-dynamic";

const TRENDING_CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=15, stale-while-revalidate=30",
} as const;

/**
 * GET /api/trending-tokens
 *
 * Trending launchpad tokens (pump.fun) that pass the safety screen and don't yet
 * have a Percolator perp. The pipeline (lib/trending-tokens) fails soft, so this
 * returns a list — possibly empty — and never a 500.
 */
export async function GET() {
  try {
    const result = await getTrendingTokens();
    return NextResponse.json(result, { headers: TRENDING_CACHE_HEADERS });
  } catch (err) {
    console.warn("[trending-tokens] unexpected failure:", err instanceof Error ? err.message : String(err));
    const empty: TrendingTokensResult = { tokens: [], generatedAt: new Date().toISOString(), sourceEmpty: true };
    return NextResponse.json(empty, { headers: { "Cache-Control": "no-store" } });
  }
}
