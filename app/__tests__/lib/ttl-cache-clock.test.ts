// @vitest-environment node
/**
 * Backwards wall-clock step: `Date.now() - stampedAt < TTL` serves a cached answer as fresh while the
 * age is negative. Scenario (all three caches): populate at t=0, step the clock back 1 h, then read
 * once a minute for 10 real minutes. A "stale read" is a cache hit served after the TTL has really
 * elapsed (real time is tracked separately from the stepped clock).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

const SLAB = Keypair.generate().publicKey.toBase58();
const POOL = Keypair.generate().publicKey.toBase58();
const MINT = Keypair.generate().publicKey.toBase58();
const BASE = 1_800_000_000_000;
const STEP_BACK = 3_600_000;

const h = vi.hoisted(() => ({ dbCalls: 0, rpcFail: false, rpcCalls: 0 }));

vi.mock("@/lib/supabase", () => {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  Object.assign(q, {
    select: chain, eq: chain, not: chain, order: chain, limit: chain,
    maybeSingle: async () => { h.dbCalls++; return { data: null, error: null }; },
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
      h.dbCalls++;
      return Promise.resolve({ data: [], error: null }).then(res, rej);
    },
  });
  return { getServerNetwork: () => "devnet", getServiceClient: () => ({ from: () => q }), getSupabase: () => ({ from: () => q }) };
});
vi.mock("@/lib/playground-registered-markets", () => ({ readRegisteredMarkets: async () => [] }));
vi.mock("@/lib/server-rpc", () => ({ getServerConnection: () => ({}) }));

let real = 0; // real elapsed ms
let offset = 0; // wall-clock step
beforeEach(() => {
  real = 0; offset = 0; h.dbCalls = 0; h.rpcCalls = 0;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://x";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
  vi.spyOn(Date, "now").mockImplementation(() => BASE + real + offset);
});
afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

/** Returns stale reads served over the 10-minute scenario. */
async function scenario(ttlMs: number, read: () => Promise<unknown>, loads: () => number): Promise<number> {
  await read();
  let lastLoadReal = 0;
  let seen = loads();
  expect(seen).toBeGreaterThan(0);
  offset = -STEP_BACK;
  let stale = 0;
  for (let m = 1; m <= 10; m++) {
    real += 60_000;
    await read();
    if (loads() > seen) { seen = loads(); lastLoadReal = real; }
    else if (real - lastLoadReal >= ttlMs) stale++;
  }
  console.log(`stale reads (ttl ${ttlMs} ms): ${stale}/10`);
  return stale;
}

describe("TTL caches after a backwards clock step", () => {
  it("registered-pool (slab + mint lookups)", async () => {
    const m = await import("@/lib/registered-pool");
    expect(await scenario(60_000, () => m.registeredPoolForSlab(SLAB), () => h.dbCalls)).toBe(0);
    h.dbCalls = 0; real = 0; offset = 0;
    expect(await scenario(60_000, () => m.registeredPoolForMint(MINT), () => h.dbCalls)).toBe(0);
  });

  it("retired-slabs", async () => {
    const m = await import("@/lib/retired-slabs");
    m.resetRetiredSlabCache();
    expect(await scenario(5 * 60_000, () => m.getRetiredSlabs(), () => h.dbCalls)).toBe(0);
  });

  it("program-upgrade-detect: an 'unknown' result must not outlive FAIL_TTL_MS", async () => {
    const m = await import("@/lib/program-upgrade-detect");
    m.__resetUpgradeDetectCache();
    const id = Object.keys(m.PRE_SYNC_FINGERPRINTS)[0];
    const conn = { getAccountInfo: vi.fn(async () => { h.rpcCalls++; throw new Error("rpc down"); }) } as never;
    expect(await scenario(15_000, async () => {
      const v = await m.programUpgradeState(conn, id);
      expect(v).toBe("unknown");
    }, () => h.rpcCalls)).toBe(0);
  });
});
