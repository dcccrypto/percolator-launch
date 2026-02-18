import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const runtime = "edge";
export const revalidate = 0;

/* ── Types ───────────────────────────────────────────────── */
interface ScenarioRow {
  id: string;
  votes: number;
  active: boolean;
  ends_at: string | null;
  cooldown_until: string | null;
}

/**
 * GET /api/scenarios/state
 * Returns current vote counts and active scenario from Supabase sim_scenarios table.
 * Falls back gracefully if the table doesn't exist yet.
 */
export async function GET() {
  try {
    const db = getSupabase();

    const { data, error } = await db
      .from("sim_scenarios" as never)
      .select("id, votes, active, ends_at, cooldown_until")
      .order("votes", { ascending: false });

    if (error) {
      // Table might not exist yet in DB — return empty/default
      return NextResponse.json(
        { scenarios: null, error: error.message },
        { status: 200 }
      );
    }

    const rows = (data as ScenarioRow[]) ?? [];

    const scenarios = Object.fromEntries(
      rows.map((row) => [
        row.id,
        {
          id:            row.id,
          votes:         row.votes ?? 0,
          active:        row.active ?? false,
          endsAt:        row.ends_at ? new Date(row.ends_at).getTime() : undefined,
          cooldownUntil: row.cooldown_until
            ? new Date(row.cooldown_until).getTime()
            : undefined,
        },
      ])
    );

    return NextResponse.json({ scenarios });
  } catch (err) {
    return NextResponse.json(
      { scenarios: null, error: String(err) },
      { status: 200 }
    );
  }
}
