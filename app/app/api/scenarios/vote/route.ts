import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const runtime = "edge";

const VALID_SCENARIOS = new Set([
  "flash-crash",
  "short-squeeze",
  "black-swan",
  "high-vol",
  "gentle-trend",
]);

/**
 * POST /api/scenarios/vote
 * Body: { scenario: string, wallet?: string }
 * Increments vote count for a scenario in Supabase sim_scenarios table.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { scenario, wallet } = body as { scenario?: string; wallet?: string };

    if (!scenario || !VALID_SCENARIOS.has(scenario)) {
      return NextResponse.json({ error: "Invalid scenario" }, { status: 400 });
    }

    const db = getServiceClient();

    // Check if scenario row exists
    const { data: existing } = await db
      .from("sim_scenarios" as never)
      .select("id, vote_count, votes" as never)
      .eq("scenario_type" as never, scenario as never)
      .single();

    if (existing) {
      // Increment vote count, optionally add wallet to voters array
      const row = existing as { id: string; vote_count: number; votes: string[] };
      const updates: Record<string, unknown> = {
        vote_count: (row.vote_count ?? 0) + 1,
      };
      if (wallet && !row.votes?.includes(wallet)) {
        updates.votes = [...(row.votes || []), wallet];
      }
      await db
        .from("sim_scenarios" as never)
        .update(updates as never)
        .eq("id" as never, row.id as never);
    } else {
      // Create new scenario row
      await db.from("sim_scenarios" as never).insert({
        scenario_type: scenario,
        proposed_by: wallet || "anonymous",
        votes: wallet ? [wallet] : [],
        vote_count: 1,
        status: "voting",
      } as never);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: true, note: String(err) });
  }
}
