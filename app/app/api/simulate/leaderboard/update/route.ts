/**
 * POST /api/simulate/leaderboard/update
 *
 * Updates a user's leaderboard entry after a trade.
 * Upserts into sim_leaderboard — creates the row if it doesn't exist,
 * or increments/updates counters if it does.
 *
 * Protected by x-api-key header (INDEXER_API_KEY env var).
 *
 * Request body:
 *   {
 *     wallet: string,
 *     pnl_delta: number,       // signed: positive = profit, negative = loss
 *     deposited_delta: number, // amount deposited for this trade (position size)
 *     is_win: boolean,
 *     is_liquidation: boolean,
 *     display_name?: string,
 *   }
 *
 * Response: { success: true } | { error: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { requireAuth, UNAUTHORIZED } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

// Current ISO week-start (Monday 00:00 UTC)
function currentWeekStart(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - diffToMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString();
}

export async function POST(req: NextRequest) {
  if (!requireAuth(req)) return UNAUTHORIZED;

  try {
    const body = await req.json().catch(() => ({}));
    const {
      wallet,
      pnl_delta,
      deposited_delta,
      is_win,
      is_liquidation,
      display_name,
    } = body as {
      wallet?: string;
      pnl_delta?: number;
      deposited_delta?: number;
      is_win?: boolean;
      is_liquidation?: boolean;
      display_name?: string;
    };

    // Validate required fields
    if (!wallet || typeof wallet !== "string") {
      return NextResponse.json({ error: "Missing wallet" }, { status: 400 });
    }
    if (typeof pnl_delta !== "number") {
      return NextResponse.json({ error: "Missing pnl_delta" }, { status: 400 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getServiceClient() as any;
    const weekStart = currentWeekStart();
    const deposited = deposited_delta ?? 0;

    // Try to fetch existing row for this wallet + week
    const { data: existing, error: fetchErr } = await db
      .from("sim_leaderboard")
      .select("*")
      .eq("wallet", wallet)
      .eq("week_start", weekStart)
      .maybeSingle();

    if (fetchErr) {
      console.error("[leaderboard/update] fetch:", fetchErr);
      return NextResponse.json({ error: fetchErr.message }, { status: 500 });
    }

    if (existing) {
      // Row exists — compute updated values
      const newPnl = (existing.total_pnl ?? 0) + pnl_delta;
      const newDeposited = (existing.total_deposited ?? 0) + deposited;
      const newTrades = (existing.trade_count ?? 0) + 1;
      const newWins = (existing.win_count ?? 0) + (is_win ? 1 : 0);
      const newLiqs = (existing.liquidation_count ?? 0) + (is_liquidation ? 1 : 0);
      const newBest =
        existing.best_trade === null
          ? pnl_delta
          : Math.max(existing.best_trade, pnl_delta);
      const newWorst =
        existing.worst_trade === null
          ? pnl_delta
          : Math.min(existing.worst_trade, pnl_delta);

      const { error: updateErr } = await db
        .from("sim_leaderboard")
        .update({
          total_pnl: newPnl,
          total_deposited: newDeposited,
          trade_count: newTrades,
          win_count: newWins,
          liquidation_count: newLiqs,
          best_trade: newBest,
          worst_trade: newWorst,
          ...(display_name ? { display_name } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("wallet", wallet)
        .eq("week_start", weekStart);

      if (updateErr) {
        console.error("[leaderboard/update] update:", updateErr);
        return NextResponse.json({ error: updateErr.message }, { status: 500 });
      }
    } else {
      // New row
      const { error: insertErr } = await db.from("sim_leaderboard").insert({
        wallet,
        week_start: weekStart,
        total_pnl: pnl_delta,
        total_deposited: deposited,
        trade_count: 1,
        win_count: is_win ? 1 : 0,
        liquidation_count: is_liquidation ? 1 : 0,
        best_trade: pnl_delta,
        worst_trade: pnl_delta,
        ...(display_name ? { display_name } : {}),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      if (insertErr) {
        console.error("[leaderboard/update] insert:", insertErr);
        return NextResponse.json({ error: insertErr.message }, { status: 500 });
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[leaderboard/update] unexpected:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
