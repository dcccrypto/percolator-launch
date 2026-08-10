/**
 * Regression: warmup must clamp numUsedAccounts against the slab's real maxAccounts
 * IN THE ROUTE.
 *
 * warmup-account-index-clamp.test.ts exercises sanitizeAccountCount in isolation, so
 * replacing the route's clamp with a raw Number() left it green. This drives the real
 * GET handler with the SDK parsers mocked, and binds two properties:
 *   1. the clamp exists — a sentinel count is rejected at the bound;
 *   2. it uses the slab's maxAccounts — a plausible-but-garbage count that is below
 *      the 4096 default but above the real cap is also rejected;
 *   3. the cap is itself clamped — on an uninitialized slab maxAccounts is a sentinel
 *      too, and it must not become the ceiling that admits the sentinel count.
 * A control confirms an in-range index passes the bound (fails later, differently).
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ count: 0n as bigint, max: 0n as bigint }));

vi.mock("@percolatorct/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@percolatorct/sdk")>();
  return {
    ...actual,
    fetchSlab: vi.fn(async () => new Uint8Array(64)),
    parseEngine: vi.fn(() => ({ numUsedAccounts: h.count })),
    parseParams: vi.fn(() => ({ maxAccounts: h.max, warmupPeriodSlots: 100n })),
    parseAccount: vi.fn(() => ({ warmupStartedAtSlot: 0n, pnl: 0n, warmupSlopePerStep: 0n })),
  };
});

vi.mock("@/lib/config", () => ({
  // A non-v17 programId so the route doesn't 501; loopback rpc (fetchSlab is mocked).
  getConfig: () => ({ programId: "11111111111111111111111111111111", rpcUrl: "http://localhost" }),
  getAllProgramIds: () => [],
}));

const { GET } = await import("@/app/api/warmup/[slab]/[accountIdx]/route");

const SLAB = "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";
const call = (accountIdx: string) =>
  GET(new NextRequest(`http://localhost/api/warmup/${SLAB}/${accountIdx}`), {
    params: Promise.resolve({ slab: SLAB, accountIdx }),
  });
const errOf = async (r: Response) => String(((await r.json()) as { error?: string }).error);

describe("warmup clamps numUsedAccounts against the slab's real maxAccounts", () => {
  it("sentinel count (u64::MAX) is rejected at the bound (binds the clamp)", async () => {
    h.count = 2n ** 64n - 1n; h.max = 256n;
    const res = await call("5");
    expect(res.status).toBe(404);
    expect(await errOf(res)).toBe("Account not found");
  });

  it("sentinel count AND sentinel maxAccounts is still rejected (binds the cap clamp)", async () => {
    // Uninitialized slab: BOTH fields are garbage. A sentinel cap must not become
    // the ceiling — otherwise the sentinel count slips through the bound and the
    // request falls to a different, later 404 ("No active warmup") instead.
    h.count = 2n ** 64n - 1n; h.max = 2n ** 64n - 1n;
    const res = await call("5");
    expect(res.status).toBe(404);
    expect(await errOf(res)).toBe("Account not found");
  });

  it("plausible-but-garbage count above the real cap is rejected (binds maxAccounts)", async () => {
    // 500 < the 4096 default but > this slab's real cap of 10.
    h.count = 500n; h.max = 10n;
    const res = await call("50");
    expect(res.status).toBe(404);
    expect(await errOf(res)).toBe("Account not found");
  });

  it("an in-range index passes the bound (control — different 404)", async () => {
    h.count = 100n; h.max = 256n;
    const res = await call("5");
    expect(await errOf(res)).not.toBe("Account not found");
  });
});
