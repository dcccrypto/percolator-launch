import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const sb = getServiceClient();
    const { data, error } = await (sb as any)
      .from("simulation_price_history")
      .select("price_e6, timestamp")
      .eq("session_id", id)
      .order("timestamp", { ascending: true });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data ?? []);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
