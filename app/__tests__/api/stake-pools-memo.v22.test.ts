// @vitest-environment node
/**
 * /api/stake/pools keeps one per-instance copy of the pool list: repeat requests within the fresh window share one
 * on-chain read (getProgramAccounts + account reads), the response is unchanged, an empty list or a failure is never
 * stored, and MARKET_ROWS_MEMO_MS=0 turns it off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import fixture from "../fixtures/v22-stake-pools-2026-10-11.json";

const STAKE = "7JrgAUHi4PxaRv5JKHoGAxodDFbozYexpERei66Xgq4V";
const MARKETS = [
  { slab: "BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5", symbol: "SOL" },
  { slab: "ARSMzcMZzgZT2f4GJVbyJsLSuvyuTHvkbaS3fYeoMrvK", symbol: "JUP" },
];
const ANY_KEY = "So11111111111111111111111111111111111111112";

const h = vi.hoisted(() => ({ gpa: 0, fail: false, empty: false }));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getProgramAccounts: async (pid: PublicKey, cfg: { filters: Array<{ dataSize?: number }> }) => {
      h.gpa++;
      if (h.fail) throw new Error("rpc down");
      if (h.empty) return [];
      return fixture.pools
        .map((p) => ({ pubkey: new PublicKey(p.pubkey), account: { data: Buffer.from(p.b64, "base64"), executable: false, lamports: 1, owner: pid } }))
        .filter((a) => a.account.data.length === cfg.filters[0]?.dataSize);
    },
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => ({ data: Buffer.alloc(165), executable: false, lamports: 1, owner: PublicKey.default })),
  }),
}));
vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => {
    throw new Error("no supabase on the preview");
  },
  getServerNetwork: () => "devnet",
}));
vi.mock("@/lib/playground-registered-markets", () => ({ readRegisteredMarkets: async () => [] }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => undefined }));

async function loadRoute(memoMs: string) {
  vi.resetModules();
  vi.stubEnv("MARKET_ROWS_MEMO_MS", memoMs);
  vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
  vi.stubEnv("NEXT_PUBLIC_ALLOW_PROGRAM_ID_OVERRIDE", "1");
  vi.stubEnv("NEXT_PUBLIC_STAKE_PROGRAM_ID", STAKE);
  vi.stubEnv("NEXT_PUBLIC_DEVNET_V22", "1");
  vi.stubEnv(
    "NEXT_PUBLIC_V22_MARKETS_JSON",
    JSON.stringify(MARKETS.map((m) => ({ slab: m.slab, symbol: m.symbol, name: m.symbol, mainnet_ca: ANY_KEY, dex_pool_address: ANY_KEY, lp_portfolio_address: ANY_KEY }))),
  );
  return (await import("@/app/api/stake/pools/route")).GET;
}

describe("/api/stake/pools per-instance memo", () => {
  beforeEach(() => {
    h.gpa = 0;
    h.fail = false;
    h.empty = false;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("repeat requests share one on-chain read and return the same body + Cache-Control", async () => {
    const GET = await loadRoute("20000");
    const a = await GET();
    const b = await GET();
    const c = await GET();
    expect(h.gpa).toBe(1);
    expect(a.status).toBe(200);
    const ja = (await a.json()) as { pools: unknown[] };
    expect(ja.pools.length).toBeGreaterThan(0);
    expect(await b.json()).toEqual(ja);
    expect(await c.json()).toEqual(ja);
    expect(b.headers.get("cache-control")).toBe(a.headers.get("cache-control"));
    expect(a.headers.get("cache-control")).toContain("s-maxage=30");
  });

  it("concurrent first requests share ONE load (single flight)", async () => {
    const GET = await loadRoute("20000");
    await Promise.all([GET(), GET(), GET(), GET()]);
    expect(h.gpa).toBe(1);
  });

  it("a failed read (500) is returned but never stored", async () => {
    const GET = await loadRoute("20000");
    h.fail = true;
    expect((await GET()).status).toBe(500);
    h.fail = false;
    const ok = await GET();
    expect(ok.status).toBe(200);
    expect(h.gpa).toBe(2);
    await GET();
    expect(h.gpa).toBe(2); // the good one is now stored
  });

  it("an empty list is never stored (a pool created a moment later must show up at once)", async () => {
    const GET = await loadRoute("20000");
    h.empty = true;
    expect(((await (await GET()).json()) as { pools: unknown[] }).pools).toEqual([]);
    h.empty = false;
    expect(((await (await GET()).json()) as { pools: unknown[] }).pools.length).toBeGreaterThan(0);
    expect(h.gpa).toBe(2);
  });

  it("MARKET_ROWS_MEMO_MS=0 reads every time (the kill-switch)", async () => {
    const GET = await loadRoute("0");
    await GET();
    await GET();
    expect(h.gpa).toBe(2);
  });
});
