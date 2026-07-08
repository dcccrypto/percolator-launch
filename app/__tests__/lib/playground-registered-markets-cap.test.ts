/**
 * H1 hardening: the playground registered-markets registry must stay capped at
 * MAX_REGISTERED_MARKETS even under an unbounded stream of registrations —
 * oldest-by-registeredAt entries are evicted first. See
 * app/lib/playground-registered-markets.ts (upsertRegisteredMarket).
 *
 * @vercel/blob is mocked with an in-memory store so this runs without real
 * Blob credentials.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let fakeStore: string | null = null;
const FAKE_BLOB_URL = "http://fake-blob/playground/registered-markets.json";

vi.mock("@vercel/blob", () => ({
  list: vi.fn(async () => {
    if (fakeStore === null) return { blobs: [] };
    return { blobs: [{ pathname: "playground/registered-markets.json", url: FAKE_BLOB_URL }] };
  }),
  put: vi.fn(async (_pathname: string, body: string) => {
    fakeStore = body;
    return { url: FAKE_BLOB_URL };
  }),
}));

beforeEach(() => {
  fakeStore = null;
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => JSON.parse(fakeStore ?? "[]"),
  })) as unknown as typeof fetch;
});

// Imported after the mock so the module under test picks up the mocked @vercel/blob.
const { upsertRegisteredMarket, MAX_REGISTERED_MARKETS } = await import("@/lib/playground-registered-markets");
type RegisteredMarket = Awaited<ReturnType<typeof upsertRegisteredMarket>>[number];

function makeEntry(i: number, registeredAt: number): RegisteredMarket {
  return {
    slabAddress: `SLAB_${i}`,
    marketAddress: `SLAB_${i}`,
    poolAddress: `POOL_${i}`,
    dexType: "raydium-clmm",
    symbol: null,
    label: `label-${i}`,
    mainnetCA: null,
    collateral: "COLLATERAL_MINT",
    registeredAt,
  };
}

describe("H1: registered-markets registry cap", () => {
  it("caps at MAX_REGISTERED_MARKETS, evicting the oldest entry first", async () => {
    let result: RegisteredMarket[] = [];
    for (let i = 0; i < MAX_REGISTERED_MARKETS; i++) {
      result = await upsertRegisteredMarket(makeEntry(i, i));
    }
    expect(result).toHaveLength(MAX_REGISTERED_MARKETS);

    // One more registration beyond the cap should evict the oldest (SLAB_0).
    result = await upsertRegisteredMarket(makeEntry(MAX_REGISTERED_MARKETS, MAX_REGISTERED_MARKETS));
    expect(result).toHaveLength(MAX_REGISTERED_MARKETS);
    expect(result.find((m) => m.slabAddress === "SLAB_0")).toBeUndefined();
    expect(result.find((m) => m.slabAddress === `SLAB_${MAX_REGISTERED_MARKETS}`)).toBeDefined();
  });

  it("updating an existing slab does not grow the registry or evict anything", async () => {
    let result: RegisteredMarket[] = [];
    for (let i = 0; i < 5; i++) {
      result = await upsertRegisteredMarket(makeEntry(i, i));
    }
    expect(result).toHaveLength(5);

    // Re-register SLAB_2 with a fresh timestamp — updates in place, doesn't grow.
    result = await upsertRegisteredMarket(makeEntry(2, 1000));
    expect(result).toHaveLength(5);
    expect(result.find((m) => m.slabAddress === "SLAB_2")?.registeredAt).toBe(1000);
  });
});
