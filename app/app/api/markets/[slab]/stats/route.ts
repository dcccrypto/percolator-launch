import { NextRequest, NextResponse } from "next/server";
import { requireAuth, UNAUTHORIZED } from "@/lib/api-auth";
import { getServiceClient } from "@/lib/supabase";
export const dynamic = "force-dynamic";

// POST /api/markets/[slab]/stats — update market stats (called by indexer/keeper)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  if (!requireAuth(req)) return UNAUTHORIZED;
  const { slab } = await params;

  // Simple API key auth for services
  const apiKey = req.headers.get("x-api-key");
  if (apiKey !== process.env.INDEXER_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const supabase = getServiceClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase
    .from("market_stats") as any)
    .upsert({
      slab_address: slab,
      ...body,
      updated_at: new Date().toISOString(),
    });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
