import { NextRequest, NextResponse } from "next/server";
import { requireAuth, UNAUTHORIZED } from "@/lib/api-auth";
import { getServiceClient } from "@/lib/supabase";
export const dynamic = "force-dynamic";

// GET /api/markets/[slab]/trades — recent trades for a market
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  const { slab } = await params;
  const limit = parseInt(req.nextUrl.searchParams.get("limit") || "50");

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("trades")
    .select("*")
    .eq("slab_address", slab)
    .order("created_at", { ascending: false })
    .limit(Math.min(limit, 100));

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ trades: data });
}

// POST /api/markets/[slab]/trades — record a trade (called by indexer)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  if (!requireAuth(req)) return UNAUTHORIZED;
  const { slab } = await params;

  const body = await req.json();
  const supabase = getServiceClient();

  // Allowlist fields to prevent mass assignment
  const { error } = await (supabase.from("trades") as any).insert({
    slab_address: slab,
    trader: body.trader,
    side: body.side,
    size: body.size,
    price: body.price,
    fee: body.fee,
    tx_signature: body.tx_signature,
    slot: body.slot,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
