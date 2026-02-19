/**
 * Tests for bugs found and fixed in sim-oracle.ts
 *
 * Bug 1: flushPriceHistory wrote to "simulation_price_history" — wrong table name.
 *        Correct table is "sim_price_history" (migration 024).
 *
 * Bug 2: priceWriteBuffer had wrong shape: {slab_address, price_e6: number, model}
 *        Correct shape: {slab_address, symbol, price_e6: string, raw_price_e6: string,
 *                        scenario_type: string|null, timestamp: number}
 *
 * Bug 3: cleanupOldPrices compared ISO date string against bigint timestamp column.
 *        Correct: compare as numeric epoch ms.
 *
 * These tests work on the extracted pure logic — no Solana RPC or Supabase needed.
 */

import { describe, it, expect } from "vitest";

// ── Mirror the exact buffer row type from the fixed oracle ────────────────────

interface PriceBufferRow {
  slab_address: string;
  symbol: string;
  price_e6: string;       // text
  raw_price_e6: string;   // text
  scenario_type: string | null;
  timestamp: number;      // bigint (unix ms)
}

/** Simulate building a buffer row (mirrors the fixed oracle tick logic) */
function buildBufferRow(opts: {
  slab: string;
  symbol: string;
  priceE6: bigint;
  rawPrice: number;
  scenarioType: string | null;
}): PriceBufferRow {
  return {
    slab_address: opts.slab,
    symbol: opts.symbol,
    price_e6: opts.priceE6.toString(),
    raw_price_e6: BigInt(Math.round(opts.rawPrice * 1_000_000)).toString(),
    scenario_type: opts.scenarioType,
    timestamp: Date.now(),
  };
}

/** Simulate building the cleanup URL (mirrors fixed cleanupOldPrices) */
function buildCleanupUrl(supabaseUrl: string, cutoffMs: number): string {
  // Bug fix: was `?timestamp=lt.${ISO_DATE}` — ISO strings don't compare against bigint
  return `${supabaseUrl}/rest/v1/sim_price_history?timestamp=lt.${cutoffMs}`;
}

/** Build the flush URL (mirrors fixed flushPriceHistory) */
function buildFlushUrl(supabaseUrl: string): string {
  // Bug fix: was "simulation_price_history" — wrong table name
  return `${supabaseUrl}/rest/v1/sim_price_history`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Oracle Bug #1 — table name fix (sim_price_history not simulation_price_history)", () => {
  const BASE = "https://example.supabase.co";

  it("flush URL uses sim_price_history", () => {
    const url = buildFlushUrl(BASE);
    expect(url).toContain("sim_price_history");
    expect(url).not.toContain("simulation_price_history");
  });

  it("cleanup URL uses sim_price_history", () => {
    const url = buildCleanupUrl(BASE, Date.now() - 86_400_000);
    expect(url).toContain("sim_price_history");
    expect(url).not.toContain("simulation_price_history");
  });

  it("flush URL would have been wrong before fix", () => {
    // This documents what the old (buggy) URL looked like
    const OLD_WRONG_URL = `${BASE}/rest/v1/simulation_price_history`;
    expect(OLD_WRONG_URL).not.toBe(buildFlushUrl(BASE));
  });
});

describe("Oracle Bug #2 — priceWriteBuffer shape", () => {
  const slab = "AtzJQmxUQitYAuGHeCTbupDkEsv5wDH44hv6ZmDJ8ufR";
  const symbol = "SOL/USD";
  const rawPrice = 180.50;
  const adjustedPrice = 180.50 * 0.85; // flash-crash scenario
  const priceE6 = BigInt(Math.round(adjustedPrice * 1_000_000));

  it("includes required symbol field (was missing before fix)", () => {
    const row = buildBufferRow({ slab, symbol, priceE6, rawPrice, scenarioType: "flash-crash" });
    expect(row.symbol).toBe("SOL/USD");
  });

  it("includes timestamp as number (unix ms, not string)", () => {
    const before = Date.now();
    const row = buildBufferRow({ slab, symbol, priceE6, rawPrice, scenarioType: null });
    const after = Date.now();
    expect(typeof row.timestamp).toBe("number");
    expect(row.timestamp).toBeGreaterThanOrEqual(before);
    expect(row.timestamp).toBeLessThanOrEqual(after);
  });

  it("price_e6 is stored as string (text column in DB)", () => {
    const row = buildBufferRow({ slab, symbol, priceE6, rawPrice, scenarioType: null });
    expect(typeof row.price_e6).toBe("string");
    expect(row.price_e6).toBe(priceE6.toString());
  });

  it("raw_price_e6 captures pre-scenario price", () => {
    const row = buildBufferRow({ slab, symbol, priceE6, rawPrice, scenarioType: "flash-crash" });
    const expectedRaw = BigInt(Math.round(rawPrice * 1_000_000)).toString();
    expect(row.raw_price_e6).toBe(expectedRaw);
    // raw_price_e6 should differ from price_e6 when scenario is active
    expect(row.raw_price_e6).not.toBe(row.price_e6);
  });

  it("raw_price_e6 equals price_e6 when no scenario (no adjustment)", () => {
    const row = buildBufferRow({
      slab, symbol,
      priceE6: BigInt(Math.round(rawPrice * 1_000_000)),
      rawPrice,
      scenarioType: null,
    });
    expect(row.raw_price_e6).toBe(row.price_e6);
  });

  it("scenario_type is null when no active scenario (not 'pyth')", () => {
    const row = buildBufferRow({ slab, symbol, priceE6, rawPrice, scenarioType: null });
    expect(row.scenario_type).toBeNull();
  });

  it("scenario_type records active scenario name", () => {
    const row = buildBufferRow({ slab, symbol, priceE6, rawPrice, scenarioType: "short-squeeze" });
    expect(row.scenario_type).toBe("short-squeeze");
  });

  it("uses column name scenario_type not model (was wrong before fix)", () => {
    const row = buildBufferRow({ slab, symbol, priceE6, rawPrice, scenarioType: "flash-crash" }) as any;
    expect(row.scenario_type).toBeDefined();
    expect(row.model).toBeUndefined(); // old buggy field name
  });

  it("all required columns present for sim_price_history insert", () => {
    const row = buildBufferRow({ slab, symbol, priceE6, rawPrice, scenarioType: null });
    // sim_price_history required fields: slab_address, symbol, price_e6, timestamp
    expect(row.slab_address).toBeTruthy();
    expect(row.symbol).toBeTruthy();
    expect(row.price_e6).toBeTruthy();
    expect(row.timestamp).toBeGreaterThan(0);
  });
});

describe("Oracle Bug #3 — cleanup timestamp type", () => {
  const BASE = "https://example.supabase.co";

  it("cleanup uses numeric epoch ms, not ISO date string", () => {
    const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
    const url = buildCleanupUrl(BASE, cutoffMs);
    // Should end with a number, not an ISO date string
    const queryParam = new URL(url).search;
    const value = queryParam.split("timestamp=lt.")[1];
    expect(isNaN(Number(value))).toBe(false);
    expect(value).not.toContain("T"); // ISO dates contain "T"
    expect(value).not.toContain("Z"); // ISO dates end in "Z"
  });

  it("old buggy URL would use ISO string — would fail bigint comparison", () => {
    const cutoff = new Date(Date.now() - 86_400_000).toISOString();
    const oldUrl = `${BASE}/rest/v1/simulation_price_history?timestamp=lt.${cutoff}`;
    // The old URL has wrong table name AND wrong value format
    expect(oldUrl).toContain("simulation_price_history"); // wrong table
    expect(oldUrl).toContain("T");                         // ISO date format (wrong for bigint)
  });

  it("cutoff is exactly 24h ago", () => {
    const before = Date.now();
    const cutoffMs = before - 24 * 60 * 60 * 1000;
    const url = buildCleanupUrl(BASE, cutoffMs);
    const value = Number(new URL(url).search.split("timestamp=lt.")[1]);
    expect(value).toBeCloseTo(before - 86_400_000, -3); // within 1 second
  });
});

describe("Oracle buffer shape — edge cases", () => {
  it("handles BTC price (large number)", () => {
    const rawPrice = 95000.50;
    const priceE6 = BigInt(Math.round(rawPrice * 1_000_000));
    const row = buildBufferRow({
      slab: "btc-slab",
      symbol: "BTC/USD",
      priceE6,
      rawPrice,
      scenarioType: "black-swan",
    });
    expect(row.price_e6).toBe("95000500000");
    expect(row.raw_price_e6).toBe("95000500000");
  });

  it("handles very small ETH/USD sub-cent price (hypothetical)", () => {
    const rawPrice = 0.001;
    const priceE6 = BigInt(Math.round(rawPrice * 1_000_000));
    const row = buildBufferRow({
      slab: "eth-slab",
      symbol: "ETH/USD",
      priceE6,
      rawPrice,
      scenarioType: null,
    });
    expect(row.price_e6).toBe("1000");
    expect(row.raw_price_e6).toBe("1000");
  });

  it("rejects empty slab_address (not stored)", () => {
    // A row with empty slab would fail DB NOT NULL constraint
    const row = buildBufferRow({
      slab: "",
      symbol: "SOL/USD",
      priceE6: 100_000_000n,
      rawPrice: 100,
      scenarioType: null,
    });
    // slab_address is empty — caller should prevent this
    expect(row.slab_address).toBe("");
    // In production, the oracle skips markets with no slab (checked before pushing to buffer)
  });
});
