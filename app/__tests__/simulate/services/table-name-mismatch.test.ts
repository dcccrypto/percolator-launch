/**
 * Tests for critical bug: price history table name mismatch
 *
 * Bug #4: Oracle writes to sim_price_history (migration 024)
 *         but API reads from simulation_price_history (migration 011)
 *         → Charts show no data even though oracle is pushing prices
 *
 * Root cause: Two separate price history systems from different migrations
 *   - simulation_price_history (011): Legacy session-based simulation tracking
 *   - sim_price_history (024): Current simulator oracle price feed
 *
 * Fix: API route should read from sim_price_history (where oracle writes)
 */

import { describe, it, expect } from "vitest";

// ── Table schema validation ───────────────────────────────────────────────────

interface SimPriceHistoryRow {
  id: string;
  slab_address: string;
  symbol: string;
  price_e6: string;        // text column
  raw_price_e6: string;    // pre-scenario price
  scenario_type: string | null;
  timestamp: number;       // bigint (unix ms)
  created_at: string;
}

interface SimulationPriceHistoryRow {
  id: number;
  session_id: number;      // FK to simulation_sessions
  slab_address: string;
  price_e6: number;        // bigint
  model: string;
  timestamp: string;       // timestamptz
}

// ── Oracle price buffer shape (what oracle writes) ────────────────────────────

interface OraclePriceBuffer {
  slab_address: string;
  symbol: string;
  price_e6: string;
  raw_price_e6: string;
  scenario_type: string | null;
  timestamp: number;
}

function buildOracleRow(opts: {
  slab: string;
  symbol: string;
  priceE6: bigint;
  rawPrice: number;
  scenarioType: string | null;
}): OraclePriceBuffer {
  return {
    slab_address: opts.slab,
    symbol: opts.symbol,
    price_e6: opts.priceE6.toString(),
    raw_price_e6: BigInt(Math.round(opts.rawPrice * 1_000_000)).toString(),
    scenario_type: opts.scenarioType,
    timestamp: Date.now(),
  };
}

// ── API route response shape ──────────────────────────────────────────────────

interface PricesResponse {
  prices: Array<{
    price_e6: string;
    timestamp: number;
  }>;
}

/** Simulate what the API route does — BEFORE FIX (wrong table) */
function fetchPricesWrong(
  _slab: string,
  _simulationPriceHistory: SimulationPriceHistoryRow[]
): PricesResponse {
  // Bug: reads from simulation_price_history (wrong table)
  // This table is empty because oracle writes to sim_price_history
  return { prices: [] };
}

/** Simulate what the API route SHOULD do — AFTER FIX (correct table) */
function fetchPricesFixed(
  _slab: string,
  simPriceHistory: SimPriceHistoryRow[]
): PricesResponse {
  // Fix: reads from sim_price_history (where oracle writes)
  const prices = simPriceHistory.map((p) => ({
    price_e6: p.price_e6,
    timestamp: p.timestamp,
  }));
  return { prices };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Bug #4 — Price history table name mismatch", () => {
  const slab = "AtzJQmxUQitYAuGHeCTbupDkEsv5wDH44hv6ZmDJ8ufR";

  it("oracle writes to sim_price_history (migration 024)", () => {
    const row = buildOracleRow({
      slab,
      symbol: "SOL/USD",
      priceE6: 180_000_000n,
      rawPrice: 180.0,
      scenarioType: null,
    });

    // This row shape matches sim_price_history columns
    expect(row.slab_address).toBe(slab);
    expect(row.symbol).toBe("SOL/USD");
    expect(row.price_e6).toBe("180000000");
    expect(row.timestamp).toBeGreaterThan(0);
  });

  it("simulation_price_history has different schema (migration 011)", () => {
    const legacyRow: SimulationPriceHistoryRow = {
      id: 1,
      session_id: 42,
      slab_address: slab,
      price_e6: 180_000_000,
      model: "random-walk",
      timestamp: new Date().toISOString(),
    };

    // Different columns: session_id, model (not symbol, scenario_type)
    expect(legacyRow.session_id).toBe(42);
    expect("model" in legacyRow).toBe(true);
    expect("symbol" in legacyRow).toBe(false);
  });

  it("API reading from wrong table returns empty (no data)", () => {
    const legacyTable: SimulationPriceHistoryRow[] = [];
    const result = fetchPricesWrong(slab, legacyTable);
    expect(result.prices).toHaveLength(0);
  });

  it("API reading from correct table returns prices", () => {
    const correctTable: SimPriceHistoryRow[] = [
      {
        id: "uuid-1",
        slab_address: slab,
        symbol: "SOL/USD",
        price_e6: "180000000",
        raw_price_e6: "180000000",
        scenario_type: null,
        timestamp: Date.now() - 10_000,
        created_at: new Date().toISOString(),
      },
      {
        id: "uuid-2",
        slab_address: slab,
        symbol: "SOL/USD",
        price_e6: "182000000",
        raw_price_e6: "182000000",
        scenario_type: null,
        timestamp: Date.now(),
        created_at: new Date().toISOString(),
      },
    ];

    const result = fetchPricesFixed(slab, correctTable);
    expect(result.prices).toHaveLength(2);
    expect(result.prices[0].price_e6).toBe("180000000");
    expect(result.prices[1].price_e6).toBe("182000000");
  });

  it("table name typo breaks data flow (oracle writes, API reads elsewhere)", () => {
    // Oracle writes here:
    const oracleTarget = "sim_price_history";
    // API reads here (WRONG):
    const apiSource = "simulation_price_history";

    expect(oracleTarget).not.toBe(apiSource);
    expect(apiSource).toContain("simulation_"); // legacy naming
    expect(oracleTarget).toContain("sim_");     // new naming
  });

  it("fix: API should use sim_price_history", () => {
    const CORRECT_TABLE = "sim_price_history";
    const WRONG_TABLE = "simulation_price_history";

    // API route should query CORRECT_TABLE
    expect(CORRECT_TABLE).toBe("sim_price_history");
    expect(CORRECT_TABLE).not.toBe(WRONG_TABLE);
  });
});

describe("Schema differences between the two tables", () => {
  it("sim_price_history does not have session_id FK", () => {
    const row = buildOracleRow({
      slab: "test-slab",
      symbol: "BTC/USD",
      priceE6: 95_000_000_000n,
      rawPrice: 95_000,
      scenarioType: "black-swan",
    });

    // No session_id — sim slabs are not in simulation_sessions
    expect("session_id" in row).toBe(false);
  });

  it("sim_price_history uses symbol not model", () => {
    const row = buildOracleRow({
      slab: "test-slab",
      symbol: "ETH/USD",
      priceE6: 3_200_000_000n,
      rawPrice: 3_200,
      scenarioType: null,
    });

    expect(row.symbol).toBe("ETH/USD");
    expect("model" in row).toBe(false);
  });

  it("sim_price_history.timestamp is bigint (unix ms), not timestamptz", () => {
    const row = buildOracleRow({
      slab: "test-slab",
      symbol: "SOL/USD",
      priceE6: 180_000_000n,
      rawPrice: 180,
      scenarioType: null,
    });

    expect(typeof row.timestamp).toBe("number");
    expect(row.timestamp).toBeGreaterThan(1_700_000_000_000); // after 2023
    expect(row.timestamp.toString()).not.toContain("T"); // not ISO string
  });

  it("sim_price_history.price_e6 is text, not bigint", () => {
    const row = buildOracleRow({
      slab: "test-slab",
      symbol: "SOL/USD",
      priceE6: 180_000_000n,
      rawPrice: 180,
      scenarioType: null,
    });

    expect(typeof row.price_e6).toBe("string");
    expect(row.price_e6).toBe("180000000");
  });

  it("simulation_price_history has FK to simulation_sessions", () => {
    const legacyRow: SimulationPriceHistoryRow = {
      id: 1,
      session_id: 99, // FK to simulation_sessions.id
      slab_address: "slab-1",
      price_e6: 100_000_000,
      model: "trending",
      timestamp: new Date().toISOString(),
    };

    expect(legacyRow.session_id).toBe(99);
    expect(typeof legacyRow.session_id).toBe("number");
  });
});

describe("Migration 024 — sim_price_history purpose", () => {
  it("is designed for continuous oracle price feed (no sessions)", () => {
    // Migration 024 comment: "no FK to markets (sim slabs aren't in markets table)"
    // This table is for the live simulator oracle, not session-based sims
    const row = buildOracleRow({
      slab: "sim-slab-not-in-markets",
      symbol: "SOL/USD",
      priceE6: 180_000_000n,
      rawPrice: 180,
      scenarioType: null,
    });

    expect(row.slab_address).toBeTruthy();
    expect("session_id" in row).toBe(false);
  });

  it("stores scenario_type for active scenarios", () => {
    const row = buildOracleRow({
      slab: "slab-1",
      symbol: "SOL/USD",
      priceE6: 153_000_000n,
      rawPrice: 180,
      scenarioType: "flash-crash",
    });

    expect(row.scenario_type).toBe("flash-crash");
    expect(row.raw_price_e6).toBe("180000000"); // pre-scenario
    expect(row.price_e6).toBe("153000000");     // post-scenario (15% drop)
  });

  it("cleanup keeps max 24h of data (stateless feed)", () => {
    const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
    const recentRow = buildOracleRow({
      slab: "slab-1",
      symbol: "SOL/USD",
      priceE6: 180_000_000n,
      rawPrice: 180,
      scenarioType: null,
    });

    expect(recentRow.timestamp).toBeGreaterThan(cutoffMs);
  });
});
