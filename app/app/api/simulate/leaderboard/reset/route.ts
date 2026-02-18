/**
 * POST /api/simulate/leaderboard/reset
 *
 * Weekly leaderboard reset — called by a cron job every Monday at 00:00 UTC.
 * 1. Archives the current sim_leaderboard rows into sim_leaderboard_history
 * 2. Deletes the current week's rows from sim_leaderboard
 *
 * Protected by x-api-key header.
 *
 * Response: { success: true, archived: number, weekStart: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { requireAuth, UNAUTHORIZED } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

// Returns the week-start for the week that just finished
// (previous Monday at 00:00 UTC — we call this on Monday morning,
//  so "previous week" started 7 days ago)
function previousWeekStart(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - diffToMonday - 7); // go back one more week
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString();
}

// Also useful to know current week start for cleanup
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getServiceClient() as any;
    const prevWeek = previousWeekStart();
    const currWeek = currentWeekStart();

    // 1. Fetch all rows from the week that just ended
    const { data: rows, error: fetchErr } = await db
      .from("sim_leaderboard")
      .select("*")
      .eq("week_start", prevWeek);

    if (fetchErr) {
      console.error("[leaderboard/reset] fetch:", fetchErr);
      return NextResponse.json({ error: fetchErr.message }, { status: 500 });
    }

    const toArchive = rows ?? [];

    if (toArchive.length > 0) {
      // 2. Insert into history with final rank
      const historyRows = toArchive
        .sort(
          (a: { total_pnl: number }, b: { total_pnl: number }) =>
            b.total_pnl - a.total_pnl
        )
        .map(
          (
            row: {
              wallet: string;
              display_name?: string;
              total_pnl: number;
              total_deposited: number;
              trade_count: number;
              win_count: number;
              liquidation_count: number;
              best_trade?: number;
              worst_trade?: number;
            },
            i: number
          ) => ({
            wallet: row.wallet,
            display_name: row.display_name ?? null,
            week_start: prevWeek,
            final_rank: i + 1,
            total_pnl: row.total_pnl,
            total_deposited: row.total_deposited,
            trade_count: row.trade_count,
            win_count: row.win_count,
            liquidation_count: row.liquidation_count,
            best_trade: row.best_trade ?? null,
            worst_trade: row.worst_trade ?? null,
            archived_at: new Date().toISOString(),
          })
        );

      const { error: insertErr } = await db
        .from("sim_leaderboard_history")
        .insert(historyRows);

      if (insertErr) {
        console.error("[leaderboard/reset] archive insert:", insertErr);
        return NextResponse.json({ error: insertErr.message }, { status: 500 });
      }

      // 3. Delete the archived rows from the live table
      const { error: deleteErr } = await db
        .from("sim_leaderboard")
        .delete()
        .eq("week_start", prevWeek);

      if (deleteErr) {
        console.error("[leaderboard/reset] delete:", deleteErr);
        return NextResponse.json({ error: deleteErr.message }, { status: 500 });
      }
    }

    console.log(
      `[leaderboard/reset] Archived ${toArchive.length} entries from week ${prevWeek}. New week: ${currWeek}`
    );

    return NextResponse.json({
      success: true,
      archived: toArchive.length,
      weekStart: prevWeek,
      newWeek: currWeek,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[leaderboard/reset] unexpected:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
