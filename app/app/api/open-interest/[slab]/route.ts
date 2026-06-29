import { type NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { parseEngine, isV17Account } from "@percolatorct/sdk";
import { proxyToApi } from "@/lib/api-proxy";
import { validateSlabParam } from "@/lib/route-validators";
import { isBlockedSlab } from "@/lib/blocklist";
import { getConfig } from "@/lib/config";
import { hasIndexerDb } from "@/lib/indexer-db";

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
 * Read path (in priority order):
 *  1. On-chain — fetch slab account via RPC, parse with SDK parseEngine() to
 *     get longOi, shortOi, netLpPos.  No Railway / Supabase dependency.
 *     Returns { totalOi, longOi, shortOi, netLpPosition, historicalOi: [] }.
 *     Historical data is omitted (the component chart gracefully skips the
 *     bar section when historicalOi is empty).
 *  2. Proxy to Railway percolator-api — legacy fallback used only when the chain
 *     read fails AND INDEXER_DATABASE_URL is NOT set (i.e. Railway is still live).
 *  3. Empty zeros — returned when both paths fail so the component can degrade
 *     gracefully instead of showing an unhandled error.
 *
 * Defense-in-depth still applied on the proxy fallback path:
 *  - 404 for blocked slabs (GH#1462)
 *  - Phantom OI records stripped from history array (GH#1458)
 *
 * MEDIUM-003: slab parameter validated before any downstream use.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slab: string }> },
) {
  const { slab } = await params;

  // Validate slab parameter format
  const validation = validateSlabParam(slab);
  if (!validation.valid) {
    return validation.response;
  }
  const validSlab = validation.slab;

  // Blocklist check — short-circuit before hitting chain or Railway.
  if (isBlockedSlab(validSlab)) {
    return NextResponse.json({ error: "Market not found" }, { status: 404 });
  }

  // ── PRIMARY PATH: read OI directly from chain ────────────────────────────
  try {
    const cfg = getConfig();
    const connection = new Connection(cfg.rpcUrl, "confirmed");
    const slabPk = new PublicKey(validSlab);
    const info = await connection.getAccountInfo(slabPk, "confirmed");

    if (!info) {
      // Account doesn't exist on-chain — 404, don't fall through to Railway.
      return NextResponse.json({ error: "Market not found" }, { status: 404 });
    }

    const bytes = new Uint8Array(info.data);

    // v17 market group accounts (PERCV16\0 magic) do not embed a v12-style engine
    // block; their aggregate OI lives in per-portfolio accounts and is not yet
    // aggregated server-side.  Return zeros cleanly — the component handles
    // empty historicalOi by hiding the bar chart and showing "0 / 0 OI".
    if (isV17Account(bytes)) {
      return NextResponse.json(
        {
          totalOi: "0",
          longOi: "0",
          shortOi: "0",
          netLpPosition: "0",
          historicalOi: [],
        },
        { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" } },
      );
    }

    // v12.x slab — parseEngine gives us longOi / shortOi / netLpPos directly.
    const engine = parseEngine(bytes);
    const longOi = engine.longOi;
    const shortOi = engine.shortOi;
    const totalOi = longOi + shortOi;
    const netLpPosition = engine.netLpPos;

    return NextResponse.json(
      {
        totalOi: totalOi.toString(),
        longOi: longOi.toString(),
        shortOi: shortOi.toString(),
        netLpPosition: netLpPosition.toString(),
        // Historical OI requires correlating funding_history with per-side engine
        // snapshots which aren't stored in the indexer schema.  Return empty so
        // the component renders the current-snapshot bars only.
        historicalOi: [],
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
        },
      },
    );
  } catch (err) {
    console.warn(`[/api/open-interest/${validSlab}] chain read failed, falling through:`, err);
  }

  // ── SECONDARY PATH: proxy to Railway (non-playground / Railway still live) ─
  // Skipped when INDEXER_DATABASE_URL is set so the route never depends on the
  // offline Railway backend in playground / self-contained mode.
  if (!hasIndexerDb()) {
    const upstream = await proxyToApi(req, `/open-interest/${validSlab}`);

    if (!upstream.ok) return upstream;

    let data: Record<string, unknown>;
    try {
      data = await upstream.clone().json() as Record<string, unknown>;
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

  // ── FALLBACK: all paths failed — return empty zeros ───────────────────────
  // Valid shape so the component doesn't throw; renders "Balanced / 0 / 0" state.
  console.warn(`[/api/open-interest/${validSlab}] all paths failed — returning zero OI`);
  return NextResponse.json(
    {
      totalOi: "0",
      longOi: "0",
      shortOi: "0",
      netLpPosition: "0",
      historicalOi: [],
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}
