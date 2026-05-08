import { NextResponse } from "next/server";
import { getWaitlistSupabase } from "@/lib/waitlist/supabase";

export const runtime = "nodejs";

// 5-second cache so the homepage counter doesn't hit Supabase on every page view
let _cache: { count: number; ts: number } | null = null;
const CACHE_MS = 5_000;

export async function GET() {
  if (_cache && Date.now() - _cache.ts < CACHE_MS) {
    return NextResponse.json(
      { count: _cache.count },
      { headers: { "Cache-Control": "s-maxage=5, stale-while-revalidate=30" } },
    );
  }

  try {
    const supabase = getWaitlistSupabase();
    const { data, error } = await supabase.rpc("waitlist_count");
    if (error) {
      console.error("[waitlist count] rpc error", error);
      return NextResponse.json({ count: 0 }, { status: 200 });
    }
    const count = typeof data === "number" ? data : 0;
    _cache = { count, ts: Date.now() };
    return NextResponse.json(
      { count },
      { headers: { "Cache-Control": "s-maxage=5, stale-while-revalidate=30" } },
    );
  } catch (err) {
    console.error("[waitlist count] unexpected error", err);
    return NextResponse.json({ count: 0 }, { status: 200 });
  }
}
