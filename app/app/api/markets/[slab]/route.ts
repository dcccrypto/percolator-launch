import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getServiceClient } from "@/lib/supabase";
import * as Sentry from "@sentry/nextjs";
export const dynamic = "force-dynamic";

function isValidPublicKey(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * GET /api/markets/[slab]
 * Accepts either a base58 slab address OR a market slug (e.g. "SOL-PERP", "SOL").
 * When a slug is given, resolves it by matching the `symbol` column (case-insensitive,
 * with optional "-PERP" suffix stripped).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  const { slab } = await params;
  try {
    const supabase = getServiceClient();
    let data: Record<string, unknown> | null = null;

    if (isValidPublicKey(slab)) {
      // Standard lookup by slab address
      const { data: row, error } = await supabase
        .from("markets_with_stats")
        .select("*")
        .eq("slab_address", slab)
        .maybeSingle();

      if (error) {
        Sentry.captureException(error, {
          tags: { endpoint: "/api/markets/[slab]", method: "GET", slab },
        });
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      data = row;
    } else {
      // Slug resolution: strip "-PERP" suffix and match symbol case-insensitively
      const slugNorm = slab.toUpperCase().replace(/-PERP$/, "");

      // Fetch all markets and filter in JS to avoid needing ilike + function indexes
      const { data: rows, error } = await supabase
        .from("markets_with_stats")
        .select("*");

      if (error) {
        Sentry.captureException(error, {
          tags: { endpoint: "/api/markets/[slab]", method: "GET", slab },
        });
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      const match = (rows ?? []).find((m: Record<string, unknown>) => {
        const sym = String(m.symbol ?? "").toUpperCase().replace(/-PERP$/, "");
        return sym === slugNorm || String(m.symbol ?? "").toUpperCase() === slab.toUpperCase();
      });
      data = match ?? null;
    }

    if (!data) {
      return NextResponse.json({ error: "Market not found" }, { status: 404 });
    }

    return NextResponse.json({ market: data });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "/api/markets/[slab]", method: "GET", slab },
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
