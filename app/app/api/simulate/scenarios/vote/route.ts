/**
 * POST /api/simulate/scenarios/vote
 *
 * Vote for an existing scenario proposal.
 * Activates the scenario when 3 votes are reached within 5 minutes.
 *
 * Request:  { scenarioId: string, voter: string (wallet address) }
 * Response: { success: true, scenario: {...}, activated: boolean }
 *           | { error: string }
 *
 * Rules:
 * - 3 votes required to activate
 * - Must vote within 5 min of proposal creation
 * - Each wallet can only vote once per proposal
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// ─── Constants ────────────────────────────────────────────────────────────────

const VOTES_TO_ACTIVATE = 3;
const PROPOSAL_TTL_MS = 5 * 60 * 1_000; // 5 min window to collect votes
const COOLDOWN_MS = 5 * 60 * 1_000;     // 5 min cooldown between activations

const SCENARIO_DURATIONS_MS: Record<string, number> = {
  flash_crash:      60_000,
  short_squeeze:   120_000,
  black_swan:      600_000,
  high_volatility: 300_000,
  gentle_trend:   1_800_000,
};

// ─── POST ─────────────────────────────────────────────────────────────────────

interface VoteBody {
  scenarioId: string;
  voter: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({})) as Partial<VoteBody>;
    const { scenarioId, voter } = body;

    if (!scenarioId || typeof scenarioId !== "string") {
      return NextResponse.json({ error: "scenarioId is required" }, { status: 400 });
    }

    if (!voter || typeof voter !== "string" || voter.length < 32) {
      return NextResponse.json(
        { error: "voter must be a valid Solana wallet address" },
        { status: 400 },
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getServiceClient() as any;

    // Fetch the proposal
    const { data: scenario, error: fetchError } = await db
      .from("sim_scenarios")
      .select("*")
      .eq("id", scenarioId)
      .single();

    if (fetchError || !scenario) {
      return NextResponse.json({ error: "Scenario not found" }, { status: 404 });
    }

    // Must be in voting state
    if (scenario.status !== "voting") {
      return NextResponse.json(
        {
          error: `Scenario is not accepting votes (status: ${scenario.status})`,
          status: scenario.status,
        },
        { status: 409 },
      );
    }

    // Check proposal hasn't expired
    const createdAt = new Date(scenario.created_at).getTime();
    if (Date.now() - createdAt > PROPOSAL_TTL_MS) {
      // Expire it
      await db
        .from("sim_scenarios")
        .update({ status: "expired" })
        .eq("id", scenarioId);

      return NextResponse.json(
        { error: "Voting period has expired (5 minute window)" },
        { status: 410 },
      );
    }

    // Prevent double-voting
    const existingVotes: string[] = scenario.votes ?? [];
    if (existingVotes.includes(voter)) {
      return NextResponse.json(
        { error: "You have already voted for this scenario" },
        { status: 409 },
      );
    }

    const newVotes = [...existingVotes, voter];
    const newVoteCount = newVotes.length;
    const shouldActivate = newVoteCount >= VOTES_TO_ACTIVATE;

    // Check cooldown before activation.
    // Bug fix: the old check only looked for scenarios activated within COOLDOWN_MS.
    // That misses (a) scenarios still active that were activated > COOLDOWN_MS ago,
    // and (b) scenarios that expired within the last COOLDOWN_MS.
    // Correct logic: block if ANY scenario is currently active, OR if any scenario
    // expired within the last COOLDOWN_MS.
    if (shouldActivate) {
      const now = Date.now();
      const cooldownCutoff = new Date(now - COOLDOWN_MS).toISOString();

      // Case 1: any currently active scenario
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
            error: "Cannot activate — a scenario is currently active",
            cooldownRemainingSeconds: Math.max(0, cooldownRemaining),
          },
          { status: 429 },
        );
      }

      // Case 2: any scenario that expired within COOLDOWN_MS (status = completed/expired)
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
            error: "Cannot activate — cooldown is active from a recently ended scenario",
            cooldownRemainingSeconds: Math.max(0, cooldownRemaining),
          },
          { status: 429 },
        );
      }
    }

    // Compute new state
    const now = new Date().toISOString();
    const durationMs = SCENARIO_DURATIONS_MS[scenario.scenario_type] ?? 60_000;
    const expiresAt = shouldActivate
      ? new Date(Date.now() + durationMs).toISOString()
      : scenario.expires_at;

    const updates: Record<string, unknown> = {
      votes: newVotes,
      vote_count: newVoteCount,
    };

    if (shouldActivate) {
      updates.status = "active";
      updates.activated_at = now;
      updates.expires_at = expiresAt;
    }

    const { data: updated, error: updateError } = await db
      .from("sim_scenarios")
      .update(updates)
      .eq("id", scenarioId)
      .select()
      .single();

    if (updateError || !updated) {
      console.error("[vote] Update error:", updateError);
      return NextResponse.json({ error: "Failed to record vote" }, { status: 500 });
    }

    const response = {
      success: true,
      scenario: updated,
      activated: shouldActivate,
      votesRemaining: Math.max(0, VOTES_TO_ACTIVATE - newVoteCount),
      message: shouldActivate
        ? `🚀 Scenario "${scenario.scenario_type}" activated! Duration: ${Math.round(durationMs / 1000)}s`
        : `Vote recorded. ${VOTES_TO_ACTIVATE - newVoteCount} more vote(s) needed to activate.`,
    };

    return NextResponse.json(response, { status: 200 });
  } catch (err) {
    console.error("[vote] POST exception:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
