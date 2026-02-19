/**
 * GET /api/simulate/leaderboard
 *
 * Fetches the simulator leaderboard sorted by total_pnl DESC.
 *
 * Query params:
 *   ?period=weekly  — current week only (default)
 *   ?period=alltime — all-time aggregates
 *
 * Response: { entries: LeaderboardRow[], period: string, generatedAt: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Current ISO week-start (Monday 00:00 UTC)
function currentWeekStart(): string {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sun, 1 = Mon …
  const diffToMonday = (day + 6) % 7; // days since last Monday
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - diffToMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString();
}

// Faucet claim = 10,000 simUSDC (6 decimals) — the initial deposit every user starts with
const FAUCET_AMOUNT = 10_000 * 1_000_000; // 10,000,000,000

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const period = searchParams.get("period") ?? "weekly";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = getServiceClient() as any;

    let query = db
      .from("sim_leaderboard")
      .select(
        "wallet, display_name, total_pnl, total_deposited, trade_count, win_count, liquidation_count, best_trade, worst_trade"
      )
      .order("total_pnl", { ascending: false })
      .limit(100);

    if (period === "weekly") {
      query = query.eq("week_start", currentWeekStart());
    }
    // alltime: no filter → return all rows (one per wallet, aggregated over all time)

    const { data, error } = await query;

    if (error) {
      console.error("[leaderboard GET]", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const entries = (data ?? []).map(
      (
        row: {
          wallet: string;
          display_name: string | null;
          total_pnl: number;
          total_deposited: number;
          trade_count: number;
          win_count: number;
          liquidation_count: number;
          best_trade: number | null;
          worst_trade: number | null;
        },
        i: number
      ) => ({
        rank: i + 1,
        wallet: row.wallet,
        display_name: row.display_name ?? null,
        total_pnl: row.total_pnl ?? 0,
        total_deposited: row.total_deposited ?? 0,
        trade_count: row.trade_count ?? 0,
        win_count: row.win_count ?? 0,
        liquidation_count: row.liquidation_count ?? 0,
        best_trade: row.best_trade ?? null,
        worst_trade: row.worst_trade ?? null,
        roi_pct: (row.total_pnl / FAUCET_AMOUNT) * 100,
        win_rate:
          row.trade_count > 0
            ? (row.win_count / row.trade_count) * 100
            : 0,
      })
    );

    return NextResponse.json({
      entries,
      period,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[leaderboard GET] unexpected:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
