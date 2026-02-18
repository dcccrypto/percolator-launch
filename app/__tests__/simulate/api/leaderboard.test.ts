import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Testable leaderboard logic (extracted from routes) ─────────────────────

interface LeaderboardEntry {
  wallet: string;
  display_name: string | null;
  total_pnl: number;
  total_deposited: number;
  trade_count: number;
  win_count: number;
  liquidation_count: number;
  best_trade: number;
  worst_trade: number;
  last_trade_at: string | null;
  week_start: string;
  updated_at: string;
}

function rankLeaderboard(entries: LeaderboardEntry[]): (LeaderboardEntry & { rank: number; roi_pct: number; win_rate: number })[] {
  const sorted = [...entries].sort((a, b) => b.total_pnl - a.total_pnl);
  return sorted.map((entry, i) => ({
    ...entry,
    rank: i + 1,
    roi_pct: entry.total_deposited > 0 ? (entry.total_pnl / entry.total_deposited) * 100 : 0,
    win_rate: entry.trade_count > 0 ? (entry.win_count / entry.trade_count) * 100 : 0,
  }));
}

function applyTradeUpdate(
  existing: LeaderboardEntry | null,
  wallet: string,
  pnlDelta: number,
  depositedDelta: number,
  isWin: boolean,
  isLiquidation: boolean
): LeaderboardEntry {
  const now = new Date().toISOString();
  const weekStart = getWeekStart();

  if (!existing) {
    return {
      wallet,
      display_name: null,
      total_pnl: pnlDelta,
      total_deposited: depositedDelta,
      trade_count: 1,
      win_count: isWin ? 1 : 0,
      liquidation_count: isLiquidation ? 1 : 0,
      best_trade: Math.max(pnlDelta, 0),
      worst_trade: Math.min(pnlDelta, 0),
      last_trade_at: now,
      week_start: weekStart,
      updated_at: now,
    };
  }

  return {
    ...existing,
    total_pnl: existing.total_pnl + pnlDelta,
    total_deposited: existing.total_deposited + depositedDelta,
    trade_count: existing.trade_count + 1,
    win_count: existing.win_count + (isWin ? 1 : 0),
    liquidation_count: existing.liquidation_count + (isLiquidation ? 1 : 0),
    best_trade: Math.max(existing.best_trade, pnlDelta),
    worst_trade: Math.min(existing.worst_trade, pnlDelta),
    last_trade_at: now,
    updated_at: now,
  };
}

function getWeekStart(): string {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Monday start
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString();
}

function validateUpdatePayload(body: any): { valid: boolean; error?: string } {
  if (!body.wallet || typeof body.wallet !== "string") {
    return { valid: false, error: "wallet is required" };
  }
  if (typeof body.pnl_delta !== "number") {
    return { valid: false, error: "pnl_delta must be a number" };
  }
  return { valid: true };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Leaderboard: rankLeaderboard", () => {
  it("ranks by PnL descending", () => {
    const entries: LeaderboardEntry[] = [
      makeEntry({ wallet: "A", total_pnl: 100 }),
      makeEntry({ wallet: "B", total_pnl: 500 }),
      makeEntry({ wallet: "C", total_pnl: 250 }),
    ];
    const ranked = rankLeaderboard(entries);
    expect(ranked[0].wallet).toBe("B");
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].wallet).toBe("C");
    expect(ranked[1].rank).toBe(2);
    expect(ranked[2].wallet).toBe("A");
    expect(ranked[2].rank).toBe(3);
  });

  it("returns empty array for empty input", () => {
    expect(rankLeaderboard([])).toEqual([]);
  });

  it("calculates ROI correctly", () => {
    const entries = [makeEntry({ total_pnl: 500, total_deposited: 1000 })];
    const ranked = rankLeaderboard(entries);
    expect(ranked[0].roi_pct).toBe(50);
  });

  it("handles zero deposited (no division by zero)", () => {
    const entries = [makeEntry({ total_pnl: 100, total_deposited: 0 })];
    const ranked = rankLeaderboard(entries);
    expect(ranked[0].roi_pct).toBe(0);
  });

  it("calculates win rate correctly", () => {
    const entries = [makeEntry({ trade_count: 10, win_count: 7 })];
    const ranked = rankLeaderboard(entries);
    expect(ranked[0].win_rate).toBe(70);
  });

  it("handles zero trades (no division by zero)", () => {
    const entries = [makeEntry({ trade_count: 0, win_count: 0 })];
    const ranked = rankLeaderboard(entries);
    expect(ranked[0].win_rate).toBe(0);
  });

  it("handles negative PnL ranking", () => {
    const entries = [
      makeEntry({ wallet: "winner", total_pnl: 100 }),
      makeEntry({ wallet: "loser", total_pnl: -500 }),
    ];
    const ranked = rankLeaderboard(entries);
    expect(ranked[0].wallet).toBe("winner");
    expect(ranked[1].wallet).toBe("loser");
  });

  it("handles tie in PnL (stable sort)", () => {
    const entries = [
      makeEntry({ wallet: "A", total_pnl: 100 }),
      makeEntry({ wallet: "B", total_pnl: 100 }),
    ];
    const ranked = rankLeaderboard(entries);
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].rank).toBe(2);
  });
});

describe("Leaderboard: applyTradeUpdate", () => {
  it("creates new entry for first trade", () => {
    const result = applyTradeUpdate(null, "wallet1", 500, 1000, true, false);
    expect(result.wallet).toBe("wallet1");
    expect(result.total_pnl).toBe(500);
    expect(result.total_deposited).toBe(1000);
    expect(result.trade_count).toBe(1);
    expect(result.win_count).toBe(1);
    expect(result.liquidation_count).toBe(0);
    expect(result.best_trade).toBe(500);
    expect(result.worst_trade).toBe(0);
  });

  it("creates new entry with loss", () => {
    const result = applyTradeUpdate(null, "wallet1", -300, 1000, false, false);
    expect(result.total_pnl).toBe(-300);
    expect(result.win_count).toBe(0);
    expect(result.best_trade).toBe(0);
    expect(result.worst_trade).toBe(-300);
  });

  it("creates new entry with liquidation", () => {
    const result = applyTradeUpdate(null, "wallet1", -1000, 1000, false, true);
    expect(result.liquidation_count).toBe(1);
  });

  it("increments existing entry", () => {
    const existing = makeEntry({ total_pnl: 500, trade_count: 5, win_count: 3, total_deposited: 5000 });
    const result = applyTradeUpdate(existing, existing.wallet, 200, 1000, true, false);
    expect(result.total_pnl).toBe(700);
    expect(result.trade_count).toBe(6);
    expect(result.win_count).toBe(4);
    expect(result.total_deposited).toBe(6000);
  });

  it("tracks best trade (higher than existing)", () => {
    const existing = makeEntry({ best_trade: 500 });
    const result = applyTradeUpdate(existing, existing.wallet, 800, 0, true, false);
    expect(result.best_trade).toBe(800);
  });

  it("keeps existing best trade (lower new trade)", () => {
    const existing = makeEntry({ best_trade: 800 });
    const result = applyTradeUpdate(existing, existing.wallet, 200, 0, true, false);
    expect(result.best_trade).toBe(800);
  });

  it("tracks worst trade (lower than existing)", () => {
    const existing = makeEntry({ worst_trade: -300 });
    const result = applyTradeUpdate(existing, existing.wallet, -500, 0, false, false);
    expect(result.worst_trade).toBe(-500);
  });

  it("keeps existing worst trade (higher new loss)", () => {
    const existing = makeEntry({ worst_trade: -800 });
    const result = applyTradeUpdate(existing, existing.wallet, -200, 0, false, false);
    expect(result.worst_trade).toBe(-800);
  });

  it("increments liquidation count", () => {
    const existing = makeEntry({ liquidation_count: 2 });
    const result = applyTradeUpdate(existing, existing.wallet, -1000, 0, false, true);
    expect(result.liquidation_count).toBe(3);
  });
});

describe("Leaderboard: validateUpdatePayload", () => {
  it("accepts valid payload", () => {
    expect(validateUpdatePayload({ wallet: "abc123", pnl_delta: 100 })).toEqual({ valid: true });
  });

  it("rejects missing wallet", () => {
    const result = validateUpdatePayload({ pnl_delta: 100 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("wallet");
  });

  it("rejects empty wallet", () => {
    const result = validateUpdatePayload({ wallet: "", pnl_delta: 100 });
    expect(result.valid).toBe(false);
  });

  it("rejects missing pnl_delta", () => {
    const result = validateUpdatePayload({ wallet: "abc" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("pnl_delta");
  });

  it("rejects string pnl_delta", () => {
    const result = validateUpdatePayload({ wallet: "abc", pnl_delta: "100" });
    expect(result.valid).toBe(false);
  });
});

// ─── Helper ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return {
    wallet: "testWallet123",
    display_name: null,
    total_pnl: 0,
    total_deposited: 0,
    trade_count: 0,
    win_count: 0,
    liquidation_count: 0,
    best_trade: 0,
    worst_trade: 0,
    last_trade_at: null,
    week_start: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}
