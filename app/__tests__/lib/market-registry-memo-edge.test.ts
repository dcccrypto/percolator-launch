// @vitest-environment node
/**
 * Edge cases of the loadMergedMarketRows memo: clock step back, env / maxAgeMs parsing,
 * overlapping loads with different maxAge, and a rejected read shared by callers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  WRAPPER: "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB",
  LIVE: "4zopgi4NbdPbnBisYNMkWbVizGuWKHHuKYLpxXQoT5Hy",
  reads: 0,
  // Each read resolves via the gate queued here (in order), else immediately.
  gates: [] as Array<{ release: () => void; wait: Promise<void> }>,
  throwOnRead: false,
}));

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ network: "devnet", programId: h.WRAPPER }) }));
vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => "devnet",
  getServiceClient: () => {
    const n = ++h.reads;
    const chain: Record<string, unknown> = {};
    for (const k of ["from", "select", "eq", "not"]) chain[k] = () => chain;
    chain.or = async () => {
      const gate = h.gates.shift();
      if (gate) await gate.wait;
      if (h.throwOnRead) throw new Error("rpc exploded");
      return { data: [{ slab_address: h.LIVE, symbol: `R${n}` }], error: null };
    };
    return chain;
  },
}));
vi.mock("@/lib/live-market-state", () => ({
  readLiveMarketStateResolutions: async () => ({
    states: new Map([[h.LIVE, { owner: h.WRAPPER, markPriceUsd: 1 }]]),
    missing: new Set<string>(),
    tombstoned: new Set<string>(),
    unresolved: new Set<string>(),
  }),
}));

import { loadMergedMarketRows, resetMarketRegistryCache } from "@/lib/market-registry";

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  const g = { release, wait };
  h.gates.push(g);
  return g;
}
const sym = (rows: Awaited<ReturnType<typeof loadMergedMarketRows>>) => (rows![0] as { symbol: string }).symbol;

describe("loadMergedMarketRows memo edge cases", () => {
  let now = 1_800_000_000_000;
  beforeEach(() => {
    now = 1_800_000_000_000;
    vi.stubEnv("MARKET_ROWS_MEMO_MS", "20000");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    resetMarketRegistryCache();
    h.reads = 0;
    h.gates.length = 0;
    h.throwOnRead = false;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // Lead 1
  it("a backwards clock step does not keep serving the memo", async () => {
    await loadMergedMarketRows();
    now -= 60_000; // NTP step back: age is now -60 s
    await loadMergedMarketRows();
    expect(h.reads).toBe(2);
    await loadMergedMarketRows(); // the new read must replace the future-dated memo
    expect(h.reads).toBe(2);
  });

  it("a backwards clock step does not keep serving a stale in-flight read", async () => {
    const g = gate();
    const p1 = loadMergedMarketRows();
    now -= 60_000;
    const p2 = loadMergedMarketRows();
    g.release();
    await Promise.all([p1, p2]);
    expect(h.reads).toBe(2);
  });

  // Lead 2
  it.each(["0x10", "1e9", "abc", "-5", "Infinity", "1_000"])("MARKET_ROWS_MEMO_MS=%s falls back to the 20 s default", async (raw) => {
    vi.stubEnv("MARKET_ROWS_MEMO_MS", raw);
    await loadMergedMarketRows();
    now += 1_000;
    await loadMergedMarketRows();
    expect(h.reads).toBe(1); // 0x10 would parse as 16 ms and re-read here
    now += 19_001;
    await loadMergedMarketRows();
    expect(h.reads).toBe(2);
  });

  it("MARKET_ROWS_MEMO_MS=5000 is honoured", async () => {
    vi.stubEnv("MARKET_ROWS_MEMO_MS", "5000");
    await loadMergedMarketRows();
    now += 4_999;
    await loadMergedMarketRows();
    expect(h.reads).toBe(1);
    now += 2;
    await loadMergedMarketRows();
    expect(h.reads).toBe(2);
  });

  it.each([NaN, -1, -Infinity])("opts.maxAgeMs=%s is ignored (default TTL applies), not a silent cache bypass", async (bad) => {
    await loadMergedMarketRows();
    now += 1_000;
    await loadMergedMarketRows({ maxAgeMs: bad });
    expect(h.reads).toBe(1);
  });

  // Lead 3
  it("a slow older read cannot overwrite the memo of a newer finished read", async () => {
    const slow = gate();
    const fast = gate();
    const a = loadMergedMarketRows(); // t0, ttl 20 s
    now += 5_000;
    const b = loadMergedMarketRows({ maxAgeMs: 3_000 }); // t0+5 s, inflight too old -> new read
    expect(h.reads).toBe(2);
    fast.release();
    expect(sym(await b)).toBe("R2");
    slow.release();
    expect(sym(await a)).toBe("R1");
    // memo must still hold the newer read
    expect(sym(await loadMergedMarketRows())).toBe("R2");
    expect(h.reads).toBe(2);
  });

  it("a newer read that finishes after an older one replaces the memo", async () => {
    const older = gate();
    const newer = gate();
    const a = loadMergedMarketRows();
    now += 5_000;
    const b = loadMergedMarketRows({ maxAgeMs: 3_000 });
    older.release();
    await a;
    newer.release();
    await b;
    expect(sym(await loadMergedMarketRows())).toBe("R2");
  });

  // Lead 4
  it("a rejected read is shared by callers in its window, but never cached", async () => {
    const g = gate();
    h.throwOnRead = true;
    const p1 = loadMergedMarketRows();
    const p2 = loadMergedMarketRows();
    const r = Promise.allSettled([p1, p2]);
    g.release();
    const [s1, s2] = await r;
    expect(s1.status).toBe("rejected");
    expect(s2.status).toBe("rejected");
    expect(h.reads).toBe(1);
    h.throwOnRead = false;
    expect(await loadMergedMarketRows()).not.toBeNull(); // next caller retries, inflight cleared
    expect(h.reads).toBe(2);
  });
});
