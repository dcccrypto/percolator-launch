import { NextResponse } from "next/server";
import { getServiceClient, getServerNetwork } from "@/lib/supabase";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

/** Mutable marks — discourage shared caches from serving stale prices (GH#1574 area). */
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/**
 * GET /api/prices
 *
 * Returns current mark prices for all active markets.
 *
 * Primary source: Supabase `market_stats` table (oracle/stats-collector writes here
 * on every price update — typically sub-second latency on devnet).
 * Fallback: backend /prices endpoint.
 *
 * Response shape:
 *   {
 *     prices: {
 *       [slabAddress: string]: {
 *         mark_price: number;       // USD float
 *         index_price: number | null;
 *         updated_at: string;       // ISO timestamp
 *       }
 *     }
 *   }
 *
 * Network: this route is restricted to devnet only.
 * On mainnet, `market_stats` will contain mainnet oracle data — this guard
 * prevents accidental serving of stale devnet prices on production.
 *
 * REDUCED SCHEMA (2026-07): the indexer was cut down to history-only and
 * `market_stats.mark_price` / `market_stats.index_price` were both dropped —
 * only `last_price` remains. The response CONTRACT is kept identical for
 * callers (mark_price / index_price keys still present): mark_price is now
 * sourced from `last_price`, and index_price is always null (that column no
 * longer exists to source it from).
 */
export async function GET() {
  // ── Network guard: devnet only (GH#1574) ───────────────────
  const network =
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() ??
    process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim();
  if (network === "mainnet-beta" || network === "mainnet") {
    return NextResponse.json(
      { error: "prices endpoint not available on mainnet" },
      { status: 403, headers: NO_STORE },
    );
  }


  try {
    // ── Primary: Supabase market_stats ─────────────────────────
    const db = getServiceClient();
    if (db) {
      // PERC-8195: filter by network so devnet/mainnet prices don't mix
      // REDUCED SCHEMA (2026-07): mark_price/index_price columns are gone —
      // last_price is the only price column left on market_stats. Source
      // mark_price from it; index_price has no equivalent anymore.
      const { data: stats, error } = await db
        .from("market_stats")
        .select("slab_address, last_price, updated_at")
        .eq("network", getServerNetwork())
        .not("last_price", "is", null)
        .gt("last_price", 0)
        .order("updated_at", { ascending: false });

      if (!error && stats && stats.length > 0) {
        const prices: Record<
          string,
          { mark_price: number; index_price: number | null; updated_at: string }
        > = {};
        for (const s of stats) {
          if (
            s.slab_address &&
            typeof s.last_price === "number" &&
            s.last_price > 0
          ) {
            // Deduplicate: only keep the latest row per slab (query is ordered desc)
            if (!prices[s.slab_address]) {
              prices[s.slab_address] = {
                mark_price: s.last_price,
                index_price: null,
                updated_at: s.updated_at ?? "",
              };
            }
          }
        }
        return NextResponse.json({ prices }, { headers: NO_STORE });
      }
    }

    // The proxy fallback to `${NEXT_PUBLIC_API_URL}/prices` is gone: that host
    // (percolator-api) no longer exists and answered "Application not found",
    // so this route surfaced ITS 404 as its own status. An empty price map is
    // the honest answer — market_stats.last_price is populated by indexed
    // trades, so "no prices yet" is a real state, not an error.
    return NextResponse.json({ prices: {} }, { headers: NO_STORE });
  } catch (err) {
    Sentry.captureException(err, { tags: { endpoint: "/api/prices" } });
    return NextResponse.json({ prices: {} }, { status: 502, headers: NO_STORE });
  }
}
