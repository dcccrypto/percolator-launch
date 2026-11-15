// @vitest-environment node
/**
 * loadDiscoveredMarketRows (the no-Supabase /api/markets + /api/stats read) memoizes the chain read:
 * one discovery per TTL, concurrent callers share it, ?search=/?program_id= filter the memoized set,
 * and an empty (failed) read is never cached.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const A = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";
const B = "HvCDVSx5gStg1WAxBAaXwpouLyTvAHCyBPHJHh3RfVJg";
const state = vi.hoisted(() => ({ discoverCalls: 0, found: [] as unknown[] }));

vi.mock("@/lib/v22/discovery", () => ({
  discoverMarkets: async () => {
    state.discoverCalls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return state.found;
  },
}));
vi.mock("@/lib/playground-registered-markets", () => ({
  // a registered (Blob) slab is listed whatever the curated-only gate says
  readRegisteredMarkets: async () => [A, B].map((slabAddress) => ({ slabAddress, symbol: "T", label: "T" })),
}));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({ getMultipleAccountsInfo: async (a: unknown[]) => a.map(() => null) }),
}));
vi.mock("@/lib/lp-portfolio", () => ({
  getKnownMarketLpCapitals: async () => new Map(),
  scanEnabledMarketLpCapitals: async () => new Map(),
}));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ network: "devnet", programId: "11111111111111111111111111111111" }) }));

import { PublicKey } from "@solana/web3.js";
import { loadDiscoveredMarketRows, resetDiscoveredMarketRowsCache } from "@/lib/discovered-market-rows";

const slabs = [A, B];
const mk = (slab: string) => ({ slabAddress: new PublicKey(slab), programId: new PublicKey("11111111111111111111111111111111"), config: {}, params: {}, configV17: null });

describe("loadDiscoveredMarketRows memo", () => {
  beforeEach(() => {
    process.env.DISCOVERY_MEMO_MS = "60000";
    state.discoverCalls = 0;
    state.found = slabs.map(mk);
    resetDiscoveredMarketRowsCache();
  });
  afterEach(() => { process.env.DISCOVERY_MEMO_MS = "0"; resetDiscoveredMarketRowsCache(); });

  it("reads the chain once for repeated and concurrent calls", async () => {
    const [a, b] = await Promise.all([loadDiscoveredMarketRows(), loadDiscoveredMarketRows()]);
    const c = await loadDiscoveredMarketRows();
    expect(state.discoverCalls).toBe(1);
    expect(a.length).toBe(2);
    expect(b.length).toBe(2);
    expect(c.length).toBe(2);
  });

  it("applies the filter to the memoized set without another read", async () => {
    await loadDiscoveredMarketRows();
    const one = await loadDiscoveredMarketRows({ filter: (m) => m.slab_address === slabs[0] });
    expect(one.map((m) => m.slab_address)).toEqual([slabs[0]]);
    expect(state.discoverCalls).toBe(1);
  });

  it("does not memoize an empty read", async () => {
    state.found = [];
    expect(await loadDiscoveredMarketRows()).toEqual([]);
    state.found = slabs.map(mk);
    expect((await loadDiscoveredMarketRows()).length).toBe(2);
    expect(state.discoverCalls).toBe(2);
  });

  it("DISCOVERY_MEMO_MS=0 reads every call", async () => {
    process.env.DISCOVERY_MEMO_MS = "0";
    await loadDiscoveredMarketRows();
    await loadDiscoveredMarketRows();
    expect(state.discoverCalls).toBe(2);
  });
});
