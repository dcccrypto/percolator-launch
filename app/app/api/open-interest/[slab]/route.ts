import { type NextRequest, NextResponse } from "next/server";
import { proxyToApi } from "@/lib/api-proxy";
import { isBlockedSlab } from "@/lib/blocklist";

export const dynamic = "force-dynamic";

/**
 * Phantom OI threshold: values at or above this are corrupted pre-migration data
 * from uninitialized on-chain state (e.g. 9.87e+34). Matches the backend guard
 * in packages/api/src/routes/open-interest.ts (GH#1458).
 */
const MAX_SANE_OI_RAW = 1e18;

function isPhantomOiRecord(record: {
  totalOi?: string | number | null;
  netLpPos?: string | number | null;
}): boolean {
  const oi = Number(record.totalOi ?? 0);
  const lp = Number(record.netLpPos ?? 0);
  return (
    !Number.isFinite(oi) ||
    Math.abs(oi) >= MAX_SANE_OI_RAW ||
    !Number.isFinite(lp) ||
    Math.abs(lp) >= MAX_SANE_OI_RAW
  );
}

/**
 * GET /api/open-interest/[slab]
 *
 * Defense-in-depth proxy: proxies to Railway percolator-api, then:
 * 1. Returns 404 for blocked slabs (GH#1462)
 * 2. Strips phantom OI records from history (GH#1458)
 *
 * Previously this was a next.config.js rewrite with no server-side filtering,
 * so phantom data from Railway (if it hadn't redeployed) passed straight through.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slab: string }> },
) {
  const { slab } = await params;

  // Blocklist check — short-circuit before hitting Railway.
  if (isBlockedSlab(slab)) {
    return NextResponse.json({ error: "Market not found" }, { status: 404 });
  }

  const upstream = await proxyToApi(req, `/open-interest/${slab}`);

  if (!upstream.ok) return upstream;

  let data: Record<string, unknown>;
  try {
    data = await upstream.clone().json();
  } catch {
    return upstream;
  }

  // GH#1462: Strip phantom OI records from history array.
  if (Array.isArray(data.history)) {
    data = {
      ...data,
      history: (
        data.history as Array<{
          totalOi?: string | number | null;
          netLpPos?: string | number | null;
        }>
      ).filter((h) => !isPhantomOiRecord(h)),
    };
  }

  const upstreamCacheControl =
    upstream.headers.get("Cache-Control") ?? "no-store, max-age=0";

  return NextResponse.json(data, {
    status: upstream.status,
    headers: { "Cache-Control": upstreamCacheControl },
  });
}
