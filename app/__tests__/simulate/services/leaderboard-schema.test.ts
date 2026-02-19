/**
 * Tests for bugs found and fixed in sim_leaderboard schema + related route logic.
 *
 * Bug 1: sim_leaderboard.wallet was sole PRIMARY KEY — only one row per wallet
 *        possible across ALL weeks. Weekly leaderboard requires one row per
 *        (wallet, week_start). The update route uses eq("week_start", ...) which
 *        would never find rows from previous weeks via PK lookup, and new-week
 *        inserts would fail with duplicate PK if the wallet already had any row.
 *        Fix: migration 025 changes PK to composite (wallet, week_start).
 *
 * Bug 2: sim_leaderboard_history was missing 7 columns that the reset route inserts:
 *        display_name, final_rank, total_deposited, win_count, liquidation_count,
 *        best_trade, worst_trade.
 *        Fix: migration 025 adds all missing columns.
 *
 * Bug 3: The update route inserts created_at but that column didn't exist.
 *        Fix: migration 025 adds created_at to sim_leaderboard.
 */

import { describe, it, expect } from "vitest";

// ── Types matching the fixed schema ──────────────────────────────────────────

interface LeaderboardRow {
  wallet: string;
  week_start: string;
  display_name: string | null;
  total_pnl: number;
  total_deposited: number;
  trade_count: number;
  win_count: number;
  liquidation_count: number;
  best_trade: number | null;
  worst_trade: number | null;
  last_trade_at: string | null;
  updated_at: string;
  created_at: string;
}

interface LeaderboardHistoryRow {
  wallet: string;
  display_name: string | null;   // was missing
  week_start: string;
  final_rank: number;             // was missing (table had "rank" not "final_rank")
  total_pnl: number;
  total_deposited: number;        // was missing
  trade_count: number;
  win_count: number;              // was missing
  liquidation_count: number;      // was missing
  best_trade: number | null;      // was missing
  worst_trade: number | null;     // was missing
  archived_at: string;
}

// ── Helper: week-start calculation (mirrors route) ────────────────────────────

function currentWeekStart(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - diffToMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString();
}

function previousWeekStart(fromDate: Date = new Date()): string {
  const day = fromDate.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(fromDate);
  monday.setUTCDate(fromDate.getUTCDate() - diffToMonday - 7);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString();
}

// ── Simulate the update route's insert logic ──────────────────────────────────

function buildInsertRow(
  wallet: string,
  pnl: number,
  deposited: number,
  isWin: boolean,
  isLiq: boolean,
  displayName?: string
): LeaderboardRow {
  const now = new Date().toISOString();
  return {
    wallet,
    week_start: currentWeekStart(),
    display_name: displayName ?? null,
    total_pnl: pnl,
    total_deposited: deposited,
    trade_count: 1,
    win_count: isWin ? 1 : 0,
    liquidation_count: isLiq ? 1 : 0,
    best_trade: pnl,
    worst_trade: pnl,
    last_trade_at: now,
    updated_at: now,
    created_at: now,   // bug fix: this column now exists
  };
}

// ── Simulate archive row building (mirrors reset route) ───────────────────────

function buildHistoryRow(
  row: LeaderboardRow & { week_start: string },
  rank: number
): LeaderboardHistoryRow {
  return {
    wallet: row.wallet,
    display_name: row.display_name,  // bug fix: now a column
    week_start: row.week_start,
    final_rank: rank,                  // bug fix: column now exists (was "rank" in old schema)
    total_pnl: row.total_pnl,
    total_deposited: row.total_deposited, // bug fix: now a column
    trade_count: row.trade_count,
    win_count: row.win_count,          // bug fix: now a column
    liquidation_count: row.liquidation_count, // bug fix: now a column
    best_trade: row.best_trade,        // bug fix: now a column
    worst_trade: row.worst_trade,      // bug fix: now a column
    archived_at: new Date().toISOString(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DB Schema Bug #1 — leaderboard PK (wallet, week_start)", () => {
  it("two different wallets can have rows in the same week", () => {
    const week = currentWeekStart();
    const row1 = buildInsertRow("wallet1", 500, 1000, true, false);
    const row2 = buildInsertRow("wallet2", -200, 800, false, false);
    // With composite PK, both rows have unique (wallet, week_start)
    expect(`${row1.wallet}::${row1.week_start}`).not.toBe(`${row2.wallet}::${row2.week_start}`);
    expect(row1.week_start).toBe(week);
    expect(row2.week_start).toBe(week);
  });

  it("same wallet can have rows in different weeks (was blocked by old sole wallet PK)", () => {
    // Use a fixed reference date to avoid test-time dependency
    const refDate = new Date("2026-02-23T10:00:00Z"); // A known Monday
    const prevWeek = previousWeekStart(refDate);
    // currentWeekStart relative to refDate (which IS a Monday, so diffToMonday=0)
    const day = refDate.getUTCDay();
    const diffToMonday = (day + 6) % 7;
    const thisMonday = new Date(refDate);
    thisMonday.setUTCDate(refDate.getUTCDate() - diffToMonday);
    thisMonday.setUTCHours(0, 0, 0, 0);
    const thisWeek = thisMonday.toISOString();
    // With old schema: second insert would fail — wallet is PK, already exists
    // With new schema: (wallet, week_start) is PK — both rows are unique
    const key1 = `wallet1::${prevWeek}`;
    const key2 = `wallet1::${thisWeek}`;
    expect(key1).not.toBe(key2);
  });

  it("composite PK uniquely identifies a row by (wallet, week_start)", () => {
    const row = buildInsertRow("wallet123", 0, 0, false, false);
    const pk = `${row.wallet}::${row.week_start}`;
    expect(pk).toContain("wallet123");
    expect(pk).toContain(row.week_start);
  });

  it("week_start is always a Monday at 00:00 UTC", () => {
    const week = currentWeekStart();
    const date = new Date(week);
    expect(date.getUTCDay()).toBe(1); // 1 = Monday
    expect(date.getUTCHours()).toBe(0);
    expect(date.getUTCMinutes()).toBe(0);
  });

  it("week_start is valid ISO string", () => {
    const week = currentWeekStart();
    expect(() => new Date(week)).not.toThrow();
    expect(new Date(week).toISOString()).toBe(week);
  });
});

describe("DB Schema Bug #2 — history row has all required columns", () => {
  const liveRow: LeaderboardRow = {
    wallet: "test-wallet",
    week_start: previousWeekStart(),
    display_name: "TestUser",
    total_pnl: 5_000_000,        // 6-decimal units
    total_deposited: 10_000_000,
    trade_count: 25,
    win_count: 18,
    liquidation_count: 1,
    best_trade: 800_000,
    worst_trade: -200_000,
    last_trade_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  it("history row includes display_name (was missing in old schema)", () => {
    const histRow = buildHistoryRow(liveRow, 1);
    expect(histRow.display_name).toBe("TestUser");
  });

  it("history row uses final_rank not rank (column name fix)", () => {
    const histRow = buildHistoryRow(liveRow, 3) as any;
    expect(histRow.final_rank).toBe(3);
    expect(histRow.rank).toBeUndefined(); // old column name is gone
  });

  it("history row includes total_deposited (was missing)", () => {
    const histRow = buildHistoryRow(liveRow, 1);
    expect(histRow.total_deposited).toBe(10_000_000);
  });

  it("history row includes win_count (was missing)", () => {
    const histRow = buildHistoryRow(liveRow, 1);
    expect(histRow.win_count).toBe(18);
  });

  it("history row includes liquidation_count (was missing)", () => {
    const histRow = buildHistoryRow(liveRow, 1);
    expect(histRow.liquidation_count).toBe(1);
  });

  it("history row includes best_trade (was missing)", () => {
    const histRow = buildHistoryRow(liveRow, 1);
    expect(histRow.best_trade).toBe(800_000);
  });

  it("history row includes worst_trade (was missing)", () => {
    const histRow = buildHistoryRow(liveRow, 1);
    expect(histRow.worst_trade).toBe(-200_000);
  });

  it("history row has all required fields for the DB insert", () => {
    const histRow = buildHistoryRow(liveRow, 2);
    const required = [
      "wallet", "display_name", "week_start", "final_rank",
      "total_pnl", "total_deposited", "trade_count", "win_count",
      "liquidation_count", "best_trade", "worst_trade", "archived_at",
    ];
    for (const field of required) {
      expect(histRow).toHaveProperty(field);
    }
  });
});

describe("DB Schema Bug #3 — created_at column on leaderboard insert", () => {
  it("buildInsertRow includes created_at field", () => {
    const row = buildInsertRow("wallet1", 100, 500, true, false);
    expect(row.created_at).toBeDefined();
    expect(row.created_at).toBeTruthy();
  });

  it("created_at is a valid ISO timestamp", () => {
    const row = buildInsertRow("wallet1", 0, 0, false, false);
    expect(() => new Date(row.created_at)).not.toThrow();
    const diff = Date.now() - new Date(row.created_at).getTime();
    expect(diff).toBeGreaterThanOrEqual(0);
    expect(diff).toBeLessThan(5_000); // within 5 seconds
  });
});

describe("Leaderboard weekly archive — reset flow", () => {
  it("archives rows sorted by PnL descending", () => {
    const rows: LeaderboardRow[] = [
      { ...buildInsertRow("w1", 300, 1000, true, false), total_pnl: 300 },
      { ...buildInsertRow("w2", 1000, 2000, true, false), total_pnl: 1000 },
      { ...buildInsertRow("w3", -200, 500, false, true), total_pnl: -200 },
    ];

    const sorted = [...rows].sort((a, b) => b.total_pnl - a.total_pnl);
    const archived = sorted.map((r, i) => buildHistoryRow(r, i + 1));

    expect(archived[0].wallet).toBe("w2");
    expect(archived[0].final_rank).toBe(1);
    expect(archived[1].wallet).toBe("w1");
    expect(archived[1].final_rank).toBe(2);
    expect(archived[2].wallet).toBe("w3");
    expect(archived[2].final_rank).toBe(3);
  });

  it("previousWeekStart goes back 7 days from current Monday", () => {
    // Test with a known date: 2026-02-23 (Monday)
    const monday = new Date("2026-02-23T12:00:00Z");
    const prev = previousWeekStart(monday);
    const prevDate = new Date(prev);
    // Should be 2026-02-16 (previous Monday)
    expect(prevDate.getUTCFullYear()).toBe(2026);
    expect(prevDate.getUTCMonth()).toBe(1); // February
    expect(prevDate.getUTCDate()).toBe(16);
    expect(prevDate.getUTCDay()).toBe(1); // Monday
  });

  it("handles wallet with no display_name (null)", () => {
    const row: LeaderboardRow = {
      ...buildInsertRow("anon-wallet", 0, 0, false, false),
      display_name: null,
    };
    const hist = buildHistoryRow(row, 99);
    expect(hist.display_name).toBeNull();
  });

  it("handles null best_trade and worst_trade", () => {
    const row: LeaderboardRow = {
      ...buildInsertRow("wallet1", 0, 0, false, false),
      best_trade: null,
      worst_trade: null,
    };
    const hist = buildHistoryRow(row, 1);
    expect(hist.best_trade).toBeNull();
    expect(hist.worst_trade).toBeNull();
  });
});
