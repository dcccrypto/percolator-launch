import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Integration: Simulator Flow Tests ──────────────────────────────────────
// These test the logical flow of the simulator without hitting real APIs.
// They verify data transformations, state machines, and business logic chains.

// ─── Scenario Lifecycle ─────────────────────────────────────────────────────

type ScenarioStatus = "voting" | "active" | "completed" | "expired";

interface ScenarioState {
  id: string;
  type: string;
  status: ScenarioStatus;
  votes: string[];
  activatedAt: number | null;
  expiresAt: number | null;
  createdAt: number;
}

function scenarioLifecycle(
  state: ScenarioState,
  action: { type: "vote"; wallet: string } | { type: "tick"; now: number }
): ScenarioState {
  if (action.type === "vote") {
    if (state.status !== "voting") return state;
    if (state.votes.includes(action.wallet)) return state;
    
    const newVotes = [...state.votes, action.wallet];
    if (newVotes.length >= 3) {
      const now = Date.now();
      return {
        ...state,
        votes: newVotes,
        status: "active",
        activatedAt: now,
        expiresAt: now + getDuration(state.type),
      };
    }
    return { ...state, votes: newVotes };
  }

  if (action.type === "tick") {
    // Check expiry
    if (state.status === "active" && state.expiresAt && action.now >= state.expiresAt) {
      return { ...state, status: "completed" };
    }
    // Check proposal TTL (5 min)
    if (state.status === "voting" && action.now - state.createdAt > 5 * 60 * 1000) {
      return { ...state, status: "expired" };
    }
    return state;
  }

  return state;
}

function getDuration(type: string): number {
  const map: Record<string, number> = {
    crash: 60_000, squeeze: 120_000, blackswan: 600_000,
    volatility: 300_000, trend: 1_800_000,
  };
  return map[type] || 60_000;
}

// ─── Leaderboard Flow ───────────────────────────────────────────────────────

interface TradeResult {
  wallet: string;
  pnl: number;
  deposited: number;
  isWin: boolean;
  isLiquidation: boolean;
}

interface LeaderboardState {
  entries: Map<string, {
    pnl: number;
    deposited: number;
    trades: number;
    wins: number;
    liquidations: number;
    bestTrade: number;
    worstTrade: number;
  }>;
}

function processTradeForLeaderboard(state: LeaderboardState, trade: TradeResult): LeaderboardState {
  const existing = state.entries.get(trade.wallet);
  const newEntries = new Map(state.entries);

  if (!existing) {
    newEntries.set(trade.wallet, {
      pnl: trade.pnl,
      deposited: trade.deposited,
      trades: 1,
      wins: trade.isWin ? 1 : 0,
      liquidations: trade.isLiquidation ? 1 : 0,
      bestTrade: Math.max(trade.pnl, 0),
      worstTrade: Math.min(trade.pnl, 0),
    });
  } else {
    newEntries.set(trade.wallet, {
      pnl: existing.pnl + trade.pnl,
      deposited: existing.deposited + trade.deposited,
      trades: existing.trades + 1,
      wins: existing.wins + (trade.isWin ? 1 : 0),
      liquidations: existing.liquidations + (trade.isLiquidation ? 1 : 0),
      bestTrade: Math.max(existing.bestTrade, trade.pnl),
      worstTrade: Math.min(existing.worstTrade, trade.pnl),
    });
  }

  return { entries: newEntries };
}

function getRankings(state: LeaderboardState): { wallet: string; pnl: number; rank: number }[] {
  return [...state.entries.entries()]
    .sort(([, a], [, b]) => b.pnl - a.pnl)
    .map(([wallet, data], i) => ({ wallet, pnl: data.pnl, rank: i + 1 }));
}

// ─── Faucet Flow ────────────────────────────────────────────────────────────

interface FaucetState {
  claims: Map<string, { amount: number; lastClaim: number }>;
}

function processFaucetClaim(
  state: FaucetState,
  wallet: string,
  amount: number,
  now: number
): { allowed: boolean; newState: FaucetState; reason?: string } {
  const existing = state.claims.get(wallet);
  const DAILY_LIMIT = 10_000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  // Reset if >24h since last claim
  if (existing && (now - existing.lastClaim) > DAY_MS) {
    const newClaims = new Map(state.claims);
    newClaims.set(wallet, { amount, lastClaim: now });
    return { allowed: true, newState: { claims: newClaims } };
  }

  if (existing && existing.amount + amount > DAILY_LIMIT) {
    return { allowed: false, newState: state, reason: "Daily limit exceeded" };
  }

  const newClaims = new Map(state.claims);
  newClaims.set(wallet, {
    amount: (existing?.amount || 0) + amount,
    lastClaim: now,
  });
  return { allowed: true, newState: { claims: newClaims } };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Integration: Scenario Lifecycle", () => {
  it("propose → vote → vote → vote → active → tick → completed", () => {
    let state: ScenarioState = {
      id: "1", type: "crash", status: "voting",
      votes: [], activatedAt: null, expiresAt: null,
      createdAt: Date.now(),
    };

    // 3 votes
    state = scenarioLifecycle(state, { type: "vote", wallet: "A" });
    expect(state.status).toBe("voting");
    expect(state.votes.length).toBe(1);

    state = scenarioLifecycle(state, { type: "vote", wallet: "B" });
    expect(state.status).toBe("voting");
    expect(state.votes.length).toBe(2);

    state = scenarioLifecycle(state, { type: "vote", wallet: "C" });
    expect(state.status).toBe("active");
    expect(state.votes.length).toBe(3);
    expect(state.expiresAt).toBeTruthy();

    // Tick before expiry → still active
    state = scenarioLifecycle(state, { type: "tick", now: state.activatedAt! + 30_000 });
    expect(state.status).toBe("active");

    // Tick after expiry → completed
    state = scenarioLifecycle(state, { type: "tick", now: state.expiresAt! + 1000 });
    expect(state.status).toBe("completed");
  });

  it("proposal expires after 5 min without enough votes", () => {
    let state: ScenarioState = {
      id: "2", type: "squeeze", status: "voting",
      votes: ["A"], activatedAt: null, expiresAt: null,
      createdAt: Date.now(),
    };

    // Tick 6 minutes later → expired
    state = scenarioLifecycle(state, { type: "tick", now: state.createdAt + 6 * 60 * 1000 });
    expect(state.status).toBe("expired");
  });

  it("double vote is ignored", () => {
    let state: ScenarioState = {
      id: "3", type: "trend", status: "voting",
      votes: ["A"], activatedAt: null, expiresAt: null,
      createdAt: Date.now(),
    };

    state = scenarioLifecycle(state, { type: "vote", wallet: "A" });
    expect(state.votes.length).toBe(1); // Still 1
  });

  it("voting on non-voting scenario is ignored", () => {
    let state: ScenarioState = {
      id: "4", type: "crash", status: "active",
      votes: ["A", "B", "C"], activatedAt: Date.now(),
      expiresAt: Date.now() + 60_000, createdAt: Date.now(),
    };

    state = scenarioLifecycle(state, { type: "vote", wallet: "D" });
    expect(state.votes.length).toBe(3); // Unchanged
  });
});

describe("Integration: Leaderboard Tracking", () => {
  it("tracks multiple traders across multiple trades", () => {
    let state: LeaderboardState = { entries: new Map() };

    // Trader A: 3 winning trades
    state = processTradeForLeaderboard(state, { wallet: "A", pnl: 500, deposited: 1000, isWin: true, isLiquidation: false });
    state = processTradeForLeaderboard(state, { wallet: "A", pnl: 300, deposited: 0, isWin: true, isLiquidation: false });
    state = processTradeForLeaderboard(state, { wallet: "A", pnl: -100, deposited: 0, isWin: false, isLiquidation: false });

    // Trader B: 1 big win, 1 liquidation
    state = processTradeForLeaderboard(state, { wallet: "B", pnl: 2000, deposited: 5000, isWin: true, isLiquidation: false });
    state = processTradeForLeaderboard(state, { wallet: "B", pnl: -5000, deposited: 0, isWin: false, isLiquidation: true });

    const a = state.entries.get("A")!;
    expect(a.pnl).toBe(700);
    expect(a.trades).toBe(3);
    expect(a.wins).toBe(2);
    expect(a.bestTrade).toBe(500);
    expect(a.worstTrade).toBe(-100);

    const b = state.entries.get("B")!;
    expect(b.pnl).toBe(-3000);
    expect(b.trades).toBe(2);
    expect(b.wins).toBe(1);
    expect(b.liquidations).toBe(1);
    expect(b.bestTrade).toBe(2000);
    expect(b.worstTrade).toBe(-5000);

    // Rankings: A (700) > B (-3000)
    const rankings = getRankings(state);
    expect(rankings[0].wallet).toBe("A");
    expect(rankings[0].rank).toBe(1);
    expect(rankings[1].wallet).toBe("B");
    expect(rankings[1].rank).toBe(2);
  });

  it("handles first trade for new wallet", () => {
    let state: LeaderboardState = { entries: new Map() };
    state = processTradeForLeaderboard(state, { wallet: "new", pnl: 100, deposited: 500, isWin: true, isLiquidation: false });
    expect(state.entries.has("new")).toBe(true);
    expect(state.entries.get("new")!.trades).toBe(1);
  });
});

describe("Integration: Faucet Rate Limiting", () => {
  it("allows first claim", () => {
    const state: FaucetState = { claims: new Map() };
    const result = processFaucetClaim(state, "wallet1", 10_000, Date.now());
    expect(result.allowed).toBe(true);
  });

  it("rejects claim over daily limit", () => {
    const now = Date.now();
    const state: FaucetState = { claims: new Map([["wallet1", { amount: 10_000, lastClaim: now }]]) };
    const result = processFaucetClaim(state, "wallet1", 1, now + 1000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Daily limit");
  });

  it("resets after 24 hours", () => {
    const now = Date.now();
    const state: FaucetState = { claims: new Map([["wallet1", { amount: 10_000, lastClaim: now }]]) };
    const result = processFaucetClaim(state, "wallet1", 10_000, now + 25 * 60 * 60 * 1000);
    expect(result.allowed).toBe(true);
  });

  it("allows partial claims up to limit", () => {
    const now = Date.now();
    let state: FaucetState = { claims: new Map() };

    const r1 = processFaucetClaim(state, "wallet1", 5_000, now);
    expect(r1.allowed).toBe(true);
    state = r1.newState;

    const r2 = processFaucetClaim(state, "wallet1", 5_000, now + 1000);
    expect(r2.allowed).toBe(true);
    state = r2.newState;

    const r3 = processFaucetClaim(state, "wallet1", 1, now + 2000);
    expect(r3.allowed).toBe(false);
  });

  it("different wallets have independent limits", () => {
    const now = Date.now();
    let state: FaucetState = { claims: new Map() };

    const r1 = processFaucetClaim(state, "wallet1", 10_000, now);
    state = r1.newState;

    const r2 = processFaucetClaim(state, "wallet2", 10_000, now);
    expect(r2.allowed).toBe(true);
  });
});

describe("Integration: Market Switching", () => {
  const SIM_MARKETS = {
    "SOL/USD": { slab: "sol_slab_addr", name: "SIM-SOL/USD" },
    "BTC/USD": { slab: "btc_slab_addr", name: "SIM-BTC/USD" },
    "ETH/USD": { slab: "eth_slab_addr", name: "SIM-ETH/USD" },
  };

  it("each market has a unique slab address", () => {
    const slabs = Object.values(SIM_MARKETS).map((m) => m.slab);
    const unique = new Set(slabs);
    expect(unique.size).toBe(slabs.length);
  });

  it("all market names start with SIM-", () => {
    for (const market of Object.values(SIM_MARKETS)) {
      expect(market.name).toMatch(/^SIM-/);
    }
  });

  it("3 markets configured", () => {
    expect(Object.keys(SIM_MARKETS).length).toBe(3);
  });
});
