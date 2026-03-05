import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { PublicKey } from "@solana/web3.js";

/**
 * GET /api/trader/:wallet/trades?limit=20&offset=0&slab=<optional>
 *
 * Returns paginated trade history for a specific wallet address.
 * Uses service_role client (bypasses RLS) — all on-chain trades are public.
 *
 * PERC-420: Trade history for portfolio page
 */
export const dynamic = "force-dynamic";

export interface TraderTradeEntry {
  id: string;
  slab_address: string;
  trader: string;
  side: "long" | "short";
  size: string; // raw bigint as string
  price: number;
  fee: number;
  tx_signature: string | null;
  created_at: string;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ wallet: string }> },
) {
  const { wallet } = await params;
  const url = new URL(_request.url);

  // Validate wallet address
  let walletKey: string;
  try {
    walletKey = new PublicKey(wallet).toBase58();
  } catch {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }

  // Pagination
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const limit = Math.min(Math.max(1, Number.isNaN(rawLimit) ? 20 : rawLimit), 100);
  const rawOffset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const offset = Math.max(0, Number.isNaN(rawOffset) ? 0 : rawOffset);

  // Optional slab filter
  const slabFilter = url.searchParams.get("slab");

  try {
    const supabase = getServiceClient();

    let query = supabase
      .from("trades")
      .select("id, slab_address, trader, side, size, price, fee, tx_signature, created_at", { count: "exact" })
      .eq("trader", walletKey)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (slabFilter) {
      // Basic slab address validation (44 chars base58)
      const safeSlab = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(slabFilter) ? slabFilter : null;
      if (safeSlab) query = query.eq("slab_address", safeSlab);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    const trades: TraderTradeEntry[] = (data ?? []).map((row) => ({
      id: String(row.id),
      slab_address: String(row.slab_address),
      trader: String(row.trader),
      side: row.side as "long" | "short",
      size: String(row.size),
      price: Number(row.price),
      fee: Number(row.fee),
      tx_signature: row.tx_signature ? String(row.tx_signature) : null,
      created_at: String(row.created_at),
    }));

    return NextResponse.json({
      trades,
      total: count ?? 0,
      limit,
      offset,
    });
  } catch (err) {
    console.error("[trader-trades] error:", err);
    return NextResponse.json(
      {
        error: "Failed to fetch trade history",
        ...(process.env.NODE_ENV !== "production" && {
          details: err instanceof Error ? err.message : String(err),
        }),
      },
      { status: 500 },
    );
  }
}
