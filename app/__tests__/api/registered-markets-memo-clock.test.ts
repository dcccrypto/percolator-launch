// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  reads: 0,
  dbSlabs: ["A"] as string[],
  fail: false,
  delayMs: 0,
}));

vi.mock("@/lib/playground-registered-markets", () => ({
  readRegisteredMarketsChecked: async () => ({
    ok: true,
    markets: ["A", "B"].map((s) => ({ slabAddress: s, marketAddress: s })),
  }),
}));
vi.mock("@/lib/blocklist", () => ({ BLOCKED_SLAB_ADDRESSES: new Set<string>() }));
vi.mock("@/lib/live-market-state", () => ({
  readSlabExistence: async () => ({ missing: new Set<string>() }),
}));
vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => "devnet",
  getServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: async () => {
          h.reads++;
          if (h.delayMs) await new Promise((r) => setTimeout(r, h.delayMs));
          if (h.fail) throw new Error("db down");
          return { data: h.dbSlabs.map((s) => ({ slab_address: s })), error: null };
        },
      }),
    }),
  }),
}));

async function slabs(): Promise<string[]> {
  const { GET } = await import("@/app/api/playground/registered-markets/route");
  const res = await GET();
  const body = await res.json();
  return body.markets.map((m: { slabAddress: string }) => m.slabAddress);
}

describe("registered-markets slab memo vs the clock", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    h.reads = 0;
    h.dbSlabs = ["A"];
    h.fail = false;
    h.delayMs = 0;
    delete process.env.REGISTERED_MARKETS_DB_MEMO_MS;
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.REGISTERED_MARKETS_DB_MEMO_MS;
  });

  it("serves the memo within the ttl", async () => {
    expect(await slabs()).toEqual(["A"]);
    h.dbSlabs = ["A", "B"];
    vi.setSystemTime(1_001_000);
    expect(await slabs()).toEqual(["A"]);
    expect(h.reads).toBe(1);
  });

  it("treats a backwards clock step as expired (new market is not hidden)", async () => {
    expect(await slabs()).toEqual(["A"]);
    h.dbSlabs = ["A", "B"];
    vi.setSystemTime(1_000_000 - 3_600_000); // clock stepped back 1h
    expect(await slabs()).toEqual(["A", "B"]);
  });

  it("ages the memo from when the read finished, not when it started", async () => {
    h.delayMs = 2_500;
    const p = slabs();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await p).toEqual(["A"]);
    h.delayMs = 0;
    h.dbSlabs = ["A", "B"];
    await vi.advanceTimersByTimeAsync(1_000); // 3.5s since start, 1s since finish
    expect(await slabs()).toEqual(["A"]); // still within 3s of completion
    await vi.advanceTimersByTimeAsync(2_100);
    expect(await slabs()).toEqual(["A", "B"]);
  });

  it("caps a huge configured ttl so the memo cannot pin forever", async () => {
    process.env.REGISTERED_MARKETS_DB_MEMO_MS = "1e12";
    expect(await slabs()).toEqual(["A"]);
    h.dbSlabs = ["A", "B"];
    vi.setSystemTime(1_000_000 + 10 * 60_000);
    expect(await slabs()).toEqual(["A", "B"]);
  });

  it("a rejected/failed read clears inflight and is retried", async () => {
    h.fail = true;
    expect(await slabs()).toEqual(["A", "B"]); // fail-open
    h.fail = false;
    expect(await slabs()).toEqual(["A"]);
    expect(h.reads).toBe(2);
  });
});
