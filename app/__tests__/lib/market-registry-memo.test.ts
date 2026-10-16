// @vitest-environment node
/**
 * Review E2 (2026-10-14): loadMergedMarketRows is the one Supabase read behind /api/markets,
 * /api/stats and /api/funding/global. It is memoized per instance with in-flight dedupe, and the
 * rows that can never be listed are filtered IN THE QUERY.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  WRAPPER: "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB",
  LIVE: "4zopgi4NbdPbnBisYNMkWbVizGuWKHHuKYLpxXQoT5Hy",
  FOREIGN: "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn",
  TOMB: "6Y4bfYLWrhabgzU4p3onx9CeW1jCKjGjjSCaoCHf2Q9R",
  queries: [] as Array<Array<[string, ...unknown[]]>>,
  fail: false,
  delayMs: 0,
}));

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ network: "devnet", programId: h.WRAPPER }) }));
vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => "devnet",
  getServiceClient: () => {
    const calls: Array<[string, ...unknown[]]> = [];
    h.queries.push(calls);
    const chain: Record<string, unknown> = {};
    for (const k of ["from", "select", "eq", "not"]) chain[k] = (...a: unknown[]) => { calls.push([k, ...a]); return chain; };
    chain.or = async (...a: unknown[]) => {
      calls.push(["or", ...a]);
      if (h.delayMs) await new Promise((r) => setTimeout(r, h.delayMs));
      if (h.fail) return { data: null, error: { message: "boom" } };
      return { data: [h.LIVE, h.FOREIGN, h.TOMB].map((slab_address) => ({ slab_address, symbol: "X" })), error: null };
    };
    return chain;
  },
}));
vi.mock("@/lib/live-market-state", () => ({
  readLiveMarketStateResolutions: async () => ({
    states: new Map([
      [h.LIVE, { owner: h.WRAPPER, markPriceUsd: 1 }],
      [h.FOREIGN, { owner: "Vote111111111111111111111111111111111111111", markPriceUsd: 1 }],
    ]),
    missing: new Set([h.TOMB]),
    tombstoned: new Set([h.TOMB]),
    unresolved: new Set<string>(),
  }),
}));

import { loadMergedMarketRows, resetMarketRegistryCache } from "@/lib/market-registry";

const FRESH_MAX_AGE_MS = 3_000; // what /api/markets passes for ?fresh=

describe("loadMergedMarketRows memo", () => {
  let now = 1_800_000_000_000;
  beforeEach(() => {
    vi.stubEnv("MARKET_ROWS_MEMO_MS", "20000");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    resetMarketRegistryCache();
    h.queries.length = 0;
    h.fail = false;
    h.delayMs = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("serves repeat calls inside the TTL from one read, and re-reads after it", async () => {
    const a = await loadMergedMarketRows();
    now += 19_000;
    const b = await loadMergedMarketRows();
    expect(h.queries).toHaveLength(1);
    expect(b).toBe(a);
    now += 1_001;
    await loadMergedMarketRows();
    expect(h.queries).toHaveLength(2);
  });

  it("collapses concurrent callers onto the one in-flight read", async () => {
    h.delayMs = 5;
    const rs = await Promise.all([loadMergedMarketRows(), loadMergedMarketRows(), loadMergedMarketRows()]);
    expect(h.queries).toHaveLength(1);
    expect(rs[1]).toBe(rs[0]);
    expect(rs[2]).toBe(rs[0]);
  });

  it("a fresh caller accepts a copy at most FRESH_MAX_AGE_MS old (negative control: a younger copy is reused)", async () => {
    await loadMergedMarketRows();
    now += FRESH_MAX_AGE_MS - 1;
    await loadMergedMarketRows({ maxAgeMs: FRESH_MAX_AGE_MS });
    expect(h.queries).toHaveLength(1);
    now += 2;
    await loadMergedMarketRows({ maxAgeMs: FRESH_MAX_AGE_MS });
    expect(h.queries).toHaveLength(2);
  });

  it("does not cache a failure", async () => {
    h.fail = true;
    expect(await loadMergedMarketRows()).toBeNull();
    h.fail = false;
    expect(await loadMergedMarketRows()).not.toBeNull();
    expect(h.queries).toHaveLength(2);
  });

  it("MARKET_ROWS_MEMO_MS=0 turns the memo off", async () => {
    vi.stubEnv("MARKET_ROWS_MEMO_MS", "0");
    await loadMergedMarketRows();
    await loadMergedMarketRows();
    expect(h.queries).toHaveLength(2);
  });

  it("filters closed rows in the query, and excludes proven-dead slabs from later queries", async () => {
    const first = await loadMergedMarketRows();
    // Same visible answer as before: only the wrapper-owned slab is listed.
    expect(first!.map((r) => r.slab_address)).toEqual([h.LIVE]);
    const q1 = h.queries[0];
    expect(q1).toContainEqual(["not", "status", "eq", "closed"]);
    expect(q1.some((c) => c[0] === "not" && c[1] === "slab_address" && c[2] === "in")).toBe(false);
    now += 21_000;
    await loadMergedMarketRows();
    const inFilter = h.queries[1].find((c) => c[0] === "not" && c[1] === "slab_address" && c[2] === "in");
    expect(inFilter).toBeDefined();
    const listed = String(inFilter![3]).replace(/[()]/g, "").split(",").sort();
    // Tombstone and foreign owner are permanent; the live slab is never excluded.
    expect(listed).toEqual([h.FOREIGN, h.TOMB].sort());
  });
});
