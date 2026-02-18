import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const runtime = "edge";
export const revalidate = 0;

/* ── Types matching actual DB schema (023_simulator_tables.sql) ── */
interface ScenarioRow {
  id: string;
  scenario_type: string;
  vote_count: number;
  status: string;        // 'voting' | 'active' | 'expired' | 'cooldown'
  expires_at: string | null;
  created_at: string | null;
}

/**
 * GET /api/scenarios/state
 * Returns current vote counts and active scenario from Supabase sim_scenarios table.
 */
export async function GET() {
  try {
    const db = getServiceClient();

    const { data, error } = await db
      .from("sim_scenarios" as never)
      .select("id, scenario_type, vote_count, status, expires_at, created_at")
      .order("vote_count", { ascending: false });

    if (error) {
      return NextResponse.json(
        { scenarios: null, error: error.message },
        { status: 200 }
      );
    }

    const rows = (data as ScenarioRow[]) ?? [];

    const scenarios = Object.fromEntries(
      rows.map((row) => [
        row.scenario_type,
        {
          id:            row.id,
          type:          row.scenario_type,
          votes:         row.vote_count ?? 0,
          active:        row.status === "active",
          endsAt:        row.expires_at ? new Date(row.expires_at).getTime() : undefined,
          cooldownUntil: undefined,
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
