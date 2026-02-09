import { NextRequest, NextResponse } from "next/server";
import { requireAuth, UNAUTHORIZED } from "@/lib/api-auth";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/markets/[slab]/prices — oracle price history (for charts)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  const { slab } = await params;
  const limit = parseInt(req.nextUrl.searchParams.get("limit") || "500");
  const since = req.nextUrl.searchParams.get("since"); // ISO timestamp

  const supabase = getServiceClient();
  let query = supabase
    .from("oracle_prices")
    .select("price_e6, timestamp, created_at")
    .eq("slab_address", slab)
    .order("timestamp", { ascending: false })
    .limit(Math.min(limit, 1000));

  if (since) {
    query = query.gte("created_at", since);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ prices: data });
}

// POST /api/markets/[slab]/prices — record oracle price (called by oracle service)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  if (!requireAuth(req)) return UNAUTHORIZED;
  const { slab } = await params;
  const apiKey = req.headers.get("x-api-key");
  if (apiKey !== process.env.INDEXER_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const supabase = getServiceClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase.from("oracle_prices") as any).insert({
    slab_address: slab,
    price_e6: body.price_e6,
    timestamp: body.timestamp,
    tx_signature: body.tx_signature,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
