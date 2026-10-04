// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCandleStore } from "@/lib/chart/candle-store";
import {
  COOLDOWN_AFTER_429_MS, MIN_SPACING_MS, REFRESH_MS, _resetBackfillState, ensureOracleBackfill, type GeckoPage,
} from "@/lib/chart/gecko-backfill";

const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const POOL = "Pool1111111111111111111111111111111111111";
const page = (n: number): GeckoPage => ({ ok: true, candles: Array.from({ length: n }, (_, i) => ({ t: 60 * (i + 1), o: 1, h: 2, l: 0.5, c: 1.5, n: 0 })) });

function deps(over: Partial<Parameters<typeof ensureOracleBackfill>[2]> = {}) {
  let t = 1_000_000_000_000;
  const store = new MemoryCandleStore();
  return {
    store,
    advance: (ms: number) => { t += ms; },
    d: { store, poolForSlab: async () => POOL, now: () => t, sleep: async (ms: number) => { t += ms; }, ...over },
  };
}

beforeEach(() => _resetBackfillState());

describe("ensureOracleBackfill", () => {
  it("pulls once, stores the bars as gecko-sourced oracle candles, and records the ledger", async () => {
    const { d, store } = deps({ fetchPage: vi.fn(async () => page(3)) });
    expect(await ensureOracleBackfill(SLAB, 1, d)).toEqual({ status: "pulled", bars: 3 });
    expect((await store.before(SLAB, "oracle", 1, 1e12, 10)).every((c) => c.src === "gecko")).toBe(true);
    expect(await store.backfilledAt(SLAB, 1)).toBeGreaterThan(0);
    expect(await store.before(SLAB, "mark", 1, 1e12, 10)).toEqual([]);
  });
  it("single-flights concurrent callers for the same (slab,res) into ONE upstream call", async () => {
    const fetchPage = vi.fn(async () => page(2));
    const { d } = deps({ fetchPage });
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => ensureOracleBackfill(SLAB, 1, d)));
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect([a.status, b.status, c.status]).toEqual(["pulled", "pulled", "pulled"]);
  });
  it("does not pull again while the ledger is fresh, and pulls again once it is due (24h terms)", async () => {
    const fetchPage = vi.fn(async () => page(1));
    const { d, advance } = deps({ fetchPage });
    await ensureOracleBackfill(SLAB, 1, d);
    expect((await ensureOracleBackfill(SLAB, 1, d)).status).toBe("fresh");
    advance(REFRESH_MS + 1);
    expect((await ensureOracleBackfill(SLAB, 1, d)).status).toBe("pulled");
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(REFRESH_MS).toBeLessThan(24 * 3600_000);
  });
  it("spaces calls for different keys by the minimum interval", async () => {
    const calls: number[] = [];
    let now = 0;
    const fetchPage = vi.fn(async () => { calls.push(now); return page(1); });
    const { d } = deps({ fetchPage, now: () => now, sleep: async (ms) => { now += ms; } });
    now = 5_000_000_000_000;
    await Promise.all([ensureOracleBackfill(SLAB, 1, d), ensureOracleBackfill(SLAB, 5, d), ensureOracleBackfill(SLAB, 60, d)]);
    expect(calls).toHaveLength(3);
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(MIN_SPACING_MS);
    expect(calls[2] - calls[1]).toBeGreaterThanOrEqual(MIN_SPACING_MS);
  });
  it("a 429 starts a cool-down: nothing is fetched until it ends, and the ledger is NOT marked", async () => {
    const fetchPage = vi.fn(async (): Promise<GeckoPage> => ({ ok: false, rateLimited: true }));
    const { d, advance, store } = deps({ fetchPage });
    expect((await ensureOracleBackfill(SLAB, 1, d)).status).toBe("rate-limited");
    expect((await ensureOracleBackfill(SLAB, 5, d)).status).toBe("cooldown");
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(await store.backfilledAt(SLAB, 1)).toBe(0);
    advance(COOLDOWN_AFTER_429_MS + 1);
    fetchPage.mockResolvedValueOnce(page(1));
    expect((await ensureOracleBackfill(SLAB, 5, d)).status).toBe("pulled");
  });
  it("reports no-pool and failed without marking the ledger", async () => {
    const a = deps({ poolForSlab: async () => null });
    expect((await ensureOracleBackfill(SLAB, 1, a.d)).status).toBe("no-pool");
    _resetBackfillState();
    const b = deps({ fetchPage: async () => ({ ok: false, rateLimited: false }) });
    expect((await ensureOracleBackfill(SLAB, 1, b.d)).status).toBe("failed");
    expect(await b.store.backfilledAt(SLAB, 1)).toBe(0);
  });
});
