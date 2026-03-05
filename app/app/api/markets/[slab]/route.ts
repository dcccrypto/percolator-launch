import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getServiceClient } from "@/lib/supabase";
import { SLUG_ALIASES } from "@/lib/symbol-utils";
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

      // Sort to prefer the most active slab when multiple markets share the same
      // symbol / mint (e.g. 25 SOL devnet markets).
      // Rule: treat volume_24h=0 and volume_24h=null identically as "no volume" (-1)
      // so a dead slab with explicit vol=0 never beats a fresh slab with vol=null.
      // Tiebreakers: total_open_interest DESC, then created_at DESC (newest wins).
      const sorted = (rows ?? []).slice().sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
        const va = typeof a.volume_24h === "number" && (a.volume_24h as number) > 0 ? (a.volume_24h as number) : -1;
        const vb = typeof b.volume_24h === "number" && (b.volume_24h as number) > 0 ? (b.volume_24h as number) : -1;
        if (vb !== va) return vb - va;
        const oa = typeof a.total_open_interest === "number" && (a.total_open_interest as number) > 0 ? (a.total_open_interest as number) : -1;
        const ob = typeof b.total_open_interest === "number" && (b.total_open_interest as number) > 0 ? (b.total_open_interest as number) : -1;
        if (ob !== oa) return ob - oa;
        return new Date(String(b.created_at ?? 0)).getTime() - new Date(String(a.created_at ?? 0)).getTime();
      });

      // 1. Try symbol match (e.g. DB symbol = "SOL-PERP")
      let match = sorted.find((m: Record<string, unknown>) => {
        const sym = String(m.symbol ?? "").toUpperCase().replace(/-PERP$/, "");
        return sym === slugNorm || String(m.symbol ?? "").toUpperCase() === slab.toUpperCase();
      });

      // 2. Fallback: well-known mint alias (e.g. SOL → So111...)
      if (!match) {
        const aliasMint = SLUG_ALIASES[slugNorm];
        if (aliasMint) {
          match = sorted.find((m: Record<string, unknown>) => m.mint_address === aliasMint);
        }
      }

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
