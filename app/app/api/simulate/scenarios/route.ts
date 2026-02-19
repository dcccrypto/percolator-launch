/**
 * GET  /api/simulate/scenarios — List active and voting scenarios
 * POST /api/simulate/scenarios — Propose a new scenario
 *
 * Rules:
 * - Only preset scenario types allowed
 * - 5-minute cooldown between scenarios activating
 * - Proposals expire after 5 minutes if not voted through
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_TYPES = [
  "flash_crash",
  "short_squeeze",
  "black_swan",
  "high_volatility",
  "gentle_trend",
] as const;

type ScenarioType = (typeof ALLOWED_TYPES)[number];

const SCENARIO_DURATIONS_MS: Record<ScenarioType, number> = {
  flash_crash:      60_000,
  short_squeeze:   120_000,
  black_swan:      600_000,
  high_volatility: 300_000,
  gentle_trend:   1_800_000,
};

const COOLDOWN_MS = 5 * 60 * 1_000;        // 5 min cooldown between activations
const PROPOSAL_TTL_MS = 5 * 60 * 1_000;    // 5 min to collect votes

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getServiceClient() as any;

    // Expire stale voting proposals
    await db
      .from("sim_scenarios")
      .update({ status: "expired" })
      .eq("status", "voting")
      .lt("created_at", new Date(Date.now() - PROPOSAL_TTL_MS).toISOString());

    // Expire active scenarios that have passed their expires_at
    await db
      .from("sim_scenarios")
      .update({ status: "completed" })
      .eq("status", "active")
      .not("expires_at", "is", null)
      .lt("expires_at", new Date().toISOString());

    // Fetch current active + voting scenarios
    const { data, error } = await db
      .from("sim_scenarios")
      .select("*")
      .in("status", ["active", "voting"])
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) {
      console.error("[scenarios] GET error:", error);
      return NextResponse.json({ error: "Database error" }, { status: 500 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const active = data?.filter((s: any) => s.status === "active") ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const voting = data?.filter((s: any) => s.status === "voting") ?? [];

    return NextResponse.json({
      active,
      voting,
      allowedTypes: ALLOWED_TYPES,
      cooldownMs: COOLDOWN_MS,
      votesRequired: 3,
    });
  } catch (err) {
    console.error("[scenarios] GET exception:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ─── POST ─────────────────────────────────────────────────────────────────────

interface ProposeBody {
  scenarioType: string;
  proposedBy: string; // wallet address
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({})) as Partial<ProposeBody>;
    const { scenarioType, proposedBy } = body;

    // Validate inputs
    if (!scenarioType || !ALLOWED_TYPES.includes(scenarioType as ScenarioType)) {
      return NextResponse.json(
        {
          error: "Invalid scenario type",
          allowedTypes: ALLOWED_TYPES,
        },
        { status: 400 },
      );
    }

    if (!proposedBy || typeof proposedBy !== "string" || proposedBy.length < 32) {
      return NextResponse.json(
        { error: "proposedBy must be a valid Solana wallet address" },
        { status: 400 },
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getServiceClient() as any;

    // Check cooldown: block if any scenario is currently active, or ended within COOLDOWN_MS.
    const now = Date.now();
    const cooldownCutoff = new Date(now - COOLDOWN_MS).toISOString();

    const { data: anyActive } = await db
      .from("sim_scenarios")
      .select("id, expires_at")
      .eq("status", "active")
      .limit(1);

    if (anyActive && anyActive.length > 0) {
      const expiresAt = anyActive[0].expires_at
        ? new Date(anyActive[0].expires_at).getTime()
        : now;
      const cooldownRemaining = Math.ceil((expiresAt + COOLDOWN_MS - now) / 1_000);
      return NextResponse.json(
        {
          error: "Cooldown active — a scenario is currently running",
          cooldownRemainingSeconds: Math.max(0, cooldownRemaining),
        },
        { status: 429 },
      );
    }

    const { data: recentlyEnded } = await db
      .from("sim_scenarios")
      .select("id, expires_at")
      .in("status", ["completed", "expired"])
      .gte("expires_at", cooldownCutoff)
      .limit(1);

    if (recentlyEnded && recentlyEnded.length > 0) {
      const expiresAt = new Date(recentlyEnded[0].expires_at!).getTime();
      const cooldownRemaining = Math.ceil((expiresAt + COOLDOWN_MS - now) / 1_000);
      return NextResponse.json(
        {
          error: "Cooldown active — another scenario was recently active",
          cooldownRemainingSeconds: Math.max(0, cooldownRemaining),
        },
        { status: 429 },
      );
    }

    // Check if there's already a voting proposal for this type
    const { data: existing } = await db
      .from("sim_scenarios")
      .select("id, vote_count, votes")
      .eq("status", "voting")
      .eq("scenario_type", scenarioType)
      .gt("created_at", new Date(Date.now() - PROPOSAL_TTL_MS).toISOString())
      .limit(1);

    if (existing && existing.length > 0) {
      return NextResponse.json(
        {
          error: "A proposal for this scenario type is already in voting",
          existing: existing[0],
        },
        { status: 409 },
      );
    }

    // Create new proposal (proposer gets first vote automatically)
    const expiresAt = new Date(
      Date.now() + (SCENARIO_DURATIONS_MS[scenarioType as ScenarioType] ?? 60_000),
    ).toISOString();

    const { data: created, error: insertError } = await db
      .from("sim_scenarios")
      .insert({
        scenario_type: scenarioType,
        proposed_by: proposedBy,
        votes: [proposedBy],
        vote_count: 1,
        status: "voting",
        expires_at: expiresAt,
      })
      .select()
      .single();

    if (insertError || !created) {
      console.error("[scenarios] Insert error:", insertError);
      return NextResponse.json({ error: "Failed to create proposal" }, { status: 500 });
    }

    return NextResponse.json(
      {
        success: true,
        proposal: created,
        votesRequired: 3,
        message: `Proposal created. Need 2 more votes to activate.`,
      },
      { status: 201 },
    );
  } catch (err) {
    console.error("[scenarios] POST exception:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
