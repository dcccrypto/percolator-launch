import { NextResponse } from "next/server";
import { getBackendUrl, getNetwork } from "@/lib/config";
import { getServiceClient } from "@/lib/supabase";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

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
 * Security note: this route is only available on devnet.
 * An explicit runtime guard below enforces this; do not rely solely on upstream callers.
 */
export async function GET() {
  // Explicit mainnet guard — do not serve price data on mainnet (#658)
  if (getNetwork() === "mainnet") {
    return NextResponse.json({ error: "Not available on mainnet" }, { status: 403 });
  }

  try {
    // ── Primary: Supabase market_stats ─────────────────────────
    const db = getServiceClient();
    if (db) {
      const { data: stats, error } = await (db as any)
        .from("market_stats")
        .select("slab_address, mark_price, index_price, updated_at")
        .not("mark_price", "is", null)
        .gt("mark_price", 0)
        .order("updated_at", { ascending: false });

      if (!error && stats && stats.length > 0) {
        const prices: Record<
          string,
          { mark_price: number; index_price: number | null; updated_at: string }
        > = {};
        for (const s of stats) {
          if (
            s.slab_address &&
            typeof s.mark_price === "number" &&
            s.mark_price > 0
          ) {
            // Deduplicate: only keep the latest row per slab (query is ordered desc)
            if (!prices[s.slab_address]) {
              prices[s.slab_address] = {
                mark_price: s.mark_price,
                index_price:
                  typeof s.index_price === "number" ? s.index_price : null,
                updated_at: s.updated_at ?? "",
              };
            }
          }
        }
        return NextResponse.json({ prices });
      }
    }

    // ── Fallback: proxy to backend /prices ─────────────────────
    const backendUrl = getBackendUrl();
    // Guard: refuse to proxy to the production fallback when BACKEND_URL env is not explicitly
    // set — prevents silent devnet→production data leakage (#659)
    const hasExplicitBackendUrl =
      !!process.env.NEXT_PUBLIC_API_URL || !!process.env.NEXT_PUBLIC_BACKEND_URL;
    if (!hasExplicitBackendUrl) {
      console.error(
        "[/api/prices] BACKEND_URL not configured; refusing to proxy to production default from devnet",
      );
      return NextResponse.json({ prices: {} }, { status: 502 });
    }
    const res = await fetch(`${backendUrl}/prices`, {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return NextResponse.json({ prices: {} }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    Sentry.captureException(err, { tags: { endpoint: "/api/prices" } });
    return NextResponse.json({ prices: {} }, { status: 502 });
  }
}
