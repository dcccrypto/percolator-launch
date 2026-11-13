// @vitest-environment node
/**
 * /api/markets/[slab] without Supabase (the v2.2 preview) keeps one short-lived copy per slab: repeat requests
 * within 5 s share one on-chain read, the body/status/headers are unchanged, and a 404 is never stored.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

const FX = path.join(__dirname, "..", "fixtures");
const j = JSON.parse(fs.readFileSync(path.join(FX, "5bVTTMRc.ansem.market.json"), "utf8")) as { market: string; dataBase64: string };
const SLAB = j.market;
const DATA = new Uint8Array(Buffer.from(j.dataBase64, "base64"));
const MISSING = "11111111111111111111111111111112";

const h = vi.hoisted(() => ({ reads: 0 }));
vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => "devnet",
  getServiceClient: () => { throw new Error("Supabase not configured"); },
}));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getAccountInfo: async (pk: { toBase58: () => string }) => {
      h.reads++;
      if (pk.toBase58() !== SLAB) return null;
      const { getConfig } = await vi.importActual<typeof import("@/lib/config")>("@/lib/config");
      const programId = getConfig().programId;
      return { data: Buffer.from(DATA), owner: { toBase58: () => programId } };
    },
  }),
}));
vi.mock("@/lib/lp-portfolio", () => ({ getMarketLpCapital: async () => 123n }));
vi.mock("@/lib/playground-registered-markets", () => ({ readRegisteredMarkets: async () => [] }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

async function load() {
  vi.resetModules();
  return (await import("@/app/api/markets/[slab]/route")).GET;
}
const call = (GET: Awaited<ReturnType<typeof load>>, slab: string) =>
  GET(new NextRequest(`http://x/api/markets/${slab}`), { params: Promise.resolve({ slab }) });

describe("/api/markets/[slab] no-Supabase memo", () => {
  beforeEach(() => { h.reads = 0; });
  afterEach(() => vi.unstubAllEnvs());

  it("repeat requests share one on-chain read and return the same response", async () => {
    vi.stubEnv("MARKET_ROWS_MEMO_MS", "20000");
    const GET = await load();
    const a = await call(GET, SLAB);
    const readsAfterFirst = h.reads;
    const b = await call(GET, SLAB);
    expect(h.reads).toBe(readsAfterFirst);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.headers.get("cache-control")).toBe(a.headers.get("cache-control"));
    expect(b.headers.get("x-percolator-data-source")).toBe("on-chain-direct");
    const [ja, jb] = [await a.json(), await b.json()];
    expect(jb).toEqual(ja);
    expect(ja.market.vault_balance).toBe(123);
  });

  it("a 404 is never stored", async () => {
    vi.stubEnv("MARKET_ROWS_MEMO_MS", "20000");
    const GET = await load();
    expect((await call(GET, MISSING)).status).toBe(404);
    expect((await call(GET, MISSING)).status).toBe(404);
    expect(h.reads).toBe(2);
  });

  it("MARKET_ROWS_MEMO_MS=0 (the test default) reads every time", async () => {
    vi.stubEnv("MARKET_ROWS_MEMO_MS", "0");
    const GET = await load();
    await call(GET, SLAB);
    const one = h.reads;
    await call(GET, SLAB);
    expect(h.reads).toBe(one * 2);
  });
});
