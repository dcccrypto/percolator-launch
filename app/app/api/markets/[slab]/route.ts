import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import * as Sentry from "@sentry/nextjs";
export const dynamic = "force-dynamic";

// GET /api/markets/[slab] — get single market with stats
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  const { slab } = await params;
  try {
    const supabase = getServiceClient();

    const { data, error } = await supabase
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
