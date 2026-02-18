import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

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
 * Body: { scenario: string }
 * Increments vote count for a scenario in Supabase sim_scenarios table.
 * Rate limiting is done client-side via localStorage cooldown (5 min per scenario).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { scenario } = body as { scenario?: string };

    if (!scenario || !VALID_SCENARIOS.has(scenario)) {
      return NextResponse.json({ error: "Invalid scenario" }, { status: 400 });
    }

    const db = getSupabase();

    // Upsert + increment
    const { error } = await (db as any).rpc("increment_scenario_votes", {
      p_scenario_id: scenario,
    });

    if (error) {
      // Fallback: try direct upsert
      const { error: upsertErr } = await db
        .from("sim_scenarios" as never)
        .upsert(
          { id: scenario, votes: 1, active: false } as never,
          { onConflict: "id", ignoreDuplicates: false }
        );

      if (upsertErr) {
        // Table probably doesn't exist — silently accept vote
        return NextResponse.json({ ok: true, note: "offline" });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    // Accept vote gracefully even on error
    return NextResponse.json({ ok: true, note: String(err) });
  }
}
