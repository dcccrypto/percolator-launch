// @vitest-environment node
/**
 * loadDiscoveredMarketRows (the no-Supabase /api/markets + /api/stats path, e.g. the v2.2 preview) keeps one
 * shared, short-lived copy per instance, like loadMergedMarketRows (market-registry-memo.test.ts): repeat and
 * concurrent callers share one discovery read, `filter` still narrows per call, an empty result is not cached,
 * a new registration drops the copy, and MARKET_ROWS_MEMO_MS=0 (the test default) turns it off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

const h = vi.hoisted(() => {
  process.env.PLAYGROUND_SHOW_ALL_MARKETS = "true"; // module-level const: list every discovered market
  // registerPlaygroundSlab persists to this file: keep it out of the repo.
  process.env.PLAYGROUND_REGISTRY_PATH = `${require("os").tmpdir()}/discovered-rows-memo-${process.pid}.json`;
  return { discover: vi.fn(), registered: vi.fn(async () => [] as unknown[]) };
});

vi.mock("@/lib/v22/discovery", () => ({ discoverMarkets: h.discover }));
vi.mock("@/lib/server-rpc", () => ({ getServerConnection: () => ({ getMultipleAccountsInfo: async () => [] }) }));
vi.mock("@/lib/lp-portfolio", () => ({
  getKnownMarketLpCapitals: async () => new Map(),
  scanEnabledMarketLpCapitals: async () => new Map(),
}));
vi.mock("@/lib/playground-registered-markets", () => ({ readRegisteredMarkets: h.registered }));

import { loadDiscoveredMarketRows, registerPlaygroundSlab, resetDiscoveredRowsCache } from "@/lib/discovered-market-rows";

const PROG = new PublicKey("5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe");
const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const market = (n: number) => ({ slabAddress: key(n), programId: PROG, config: {}, params: {} });
const A = key(1).toBase58();
const B = key(2).toBase58();

beforeEach(() => {
  vi.stubEnv("MARKET_ROWS_MEMO_MS", "20000");
  resetDiscoveredRowsCache();
  h.discover.mockReset();
  h.discover.mockResolvedValue([market(1), market(2)]);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const slabs = (rows: Record<string, unknown>[]) => rows.map((r) => r.slab_address).sort();

describe("discovered-rows memo", () => {
  it("repeat callers within the TTL share one discovery read", async () => {
    expect(slabs(await loadDiscoveredMarketRows())).toEqual([A, B].sort());
    expect(slabs(await loadDiscoveredMarketRows())).toEqual([A, B].sort());
    expect(h.discover).toHaveBeenCalledTimes(1);
    expect(h.registered).toHaveBeenCalledTimes(1);
  });

  it("concurrent callers share the one in-flight read", async () => {
    const [x, y, z] = await Promise.all([loadDiscoveredMarketRows(), loadDiscoveredMarketRows(), loadDiscoveredMarketRows()]);
    expect(h.discover).toHaveBeenCalledTimes(1);
    expect(slabs(x)).toEqual(slabs(y));
    expect(slabs(y)).toEqual(slabs(z));
  });

  it("filter narrows per call and does not narrow the shared copy", async () => {
    const onlyA = await loadDiscoveredMarketRows({ filter: (r) => r.slab_address === A });
    expect(slabs(onlyA)).toEqual([A]);
    expect(slabs(await loadDiscoveredMarketRows())).toEqual([A, B].sort());
    expect(h.discover).toHaveBeenCalledTimes(1);
  });

  it("a caller mutating its array does not change the shared copy", async () => {
    const first = await loadDiscoveredMarketRows();
    first.length = 0;
    expect(slabs(await loadDiscoveredMarketRows())).toEqual([A, B].sort());
  });

  it("re-reads after the TTL (5 s cap, even when MARKET_ROWS_MEMO_MS is longer)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    await loadDiscoveredMarketRows();
    vi.setSystemTime(1_000_000 + 4_999);
    await loadDiscoveredMarketRows();
    expect(h.discover).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_000_000 + 5_000);
    await loadDiscoveredMarketRows();
    expect(h.discover).toHaveBeenCalledTimes(2);
  });

  it("an empty result (discovery failed / found nothing) is not cached", async () => {
    h.discover.mockResolvedValueOnce([]);
    expect(await loadDiscoveredMarketRows()).toEqual([]);
    expect(slabs(await loadDiscoveredMarketRows())).toEqual([A, B].sort());
    expect(h.discover).toHaveBeenCalledTimes(2);
  });

  it("registering a new slab drops the shared copy", async () => {
    await loadDiscoveredMarketRows();
    registerPlaygroundSlab(key(9).toBase58());
    await loadDiscoveredMarketRows();
    expect(h.discover).toHaveBeenCalledTimes(2);
  });

  it("MARKET_ROWS_MEMO_MS=0 turns the memo off", async () => {
    vi.stubEnv("MARKET_ROWS_MEMO_MS", "0");
    await loadDiscoveredMarketRows();
    await loadDiscoveredMarketRows();
    expect(h.discover).toHaveBeenCalledTimes(2);
  });
});
