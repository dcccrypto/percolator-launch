// @vitest-environment node
/**
 * The no-Supabase /api/markets/[slab] MISS path used to be 4 sequential RPCs (slab, then resolveMarketLp re-reading the
 * slab, then the known LP, then its ctx). Now round trip 1 is the slab (+ the known LP account in the same
 * getMultipleAccountsInfo for a curated market) with the registration Blob read beside it, and both are HANDED to the
 * LP resolve, which then reads only the matcher ctx (known LP) or scans (wizard market).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

// The first test cold-imports the whole route module graph, which can pass the 10 s default on a loaded CI box.
vi.setConfig({ testTimeout: 60_000 });

const j = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "5bVTTMRc.ansem.market.json"), "utf8")) as { market: string; dataBase64: string };
const SLAB = j.market;
const DATA = Buffer.from(j.dataBase64, "base64");
const KNOWN_LP = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS";

const h = vi.hoisted(() => ({
  log: [] as string[],
  capitalArgs: [] as unknown[],
  curated: false,
  programId: "",
}));

vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => "devnet",
  getServiceClient: () => { throw new Error("Supabase not configured"); },
}));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getAccountInfo: async (pk: { toBase58: () => string }) => {
      h.log.push(`getAccountInfo:${pk.toBase58() === SLAB ? "slab" : "other"}`);
      return pk.toBase58() === SLAB ? { data: Buffer.from(DATA), owner: { toBase58: () => h.programId, equals: () => true } } : null;
    },
    getMultipleAccountsInfo: async (keys: { toBase58: () => string }[]) => {
      h.log.push(`getMultipleAccountsInfo:${keys.map((k) => (k.toBase58() === SLAB ? "slab" : "lp")).join("+")}`);
      return keys.map((k) => (k.toBase58() === SLAB
        ? { data: Buffer.from(DATA), owner: { toBase58: () => h.programId, equals: () => true } }
        : { data: Buffer.from([1, 2, 3]), owner: { toBase58: () => h.programId, equals: () => true } }));
    },
  }),
}));
vi.mock("@/lib/lp-portfolio", () => ({
  getMarketLpCapital: async (_c: unknown, _p: unknown, _s: string, prefetched: unknown) => {
    h.log.push("getMarketLpCapital");
    h.capitalArgs.push(prefetched);
    return 55n;
  },
}));
vi.mock("@/lib/playground-slab-meta", () => ({
  get PLAYGROUND_SLAB_META() {
    return h.curated
      ? { [SLAB]: { symbol: "T", name: "T/USD", dex_pool_address: null, mainnet_ca: null, lp_portfolio_address: KNOWN_LP } }
      : {};
  },
}));
vi.mock("@/lib/playground-registered-markets", () => ({
  readRegisteredMarkets: async () => {
    h.log.push("readRegisteredMarkets");
    return [{ slabAddress: SLAB, symbol: "WZ", label: "Wizard/USD", poolAddress: "POOLX", mainnetCA: "CA" }];
  },
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

async function get() {
  vi.resetModules();
  const { getConfig } = await vi.importActual<typeof import("@/lib/config")>("@/lib/config");
  h.programId = getConfig().programId as string;
  const { GET } = await import("@/app/api/markets/[slab]/route");
  return GET(new NextRequest(`http://x/api/markets/${SLAB}`), { params: Promise.resolve({ slab: SLAB }) });
}

describe("/api/markets/[slab] miss path (no Supabase)", () => {
  beforeEach(() => {
    vi.stubEnv("MARKET_ROWS_MEMO_MS", "0");
    h.log = [];
    h.capitalArgs = [];
  });
  afterEach(() => vi.unstubAllEnvs());

  it("curated market: round trip 1 is ONE getMultipleAccountsInfo [slab, known LP]; no separate slab read", async () => {
    h.curated = true;
    const res = await get();
    expect(res.status).toBe(200);
    const rpc = h.log.filter((l) => l.startsWith("get") && l !== "getMarketLpCapital");
    expect(rpc).toEqual(["getMultipleAccountsInfo:slab+lp"]);
    expect(h.log).not.toContain("readRegisteredMarkets"); // curated metadata: no Blob read
    const pre = h.capitalArgs[0] as { marketData: Uint8Array; knownLpInfo: { data: Buffer } | null };
    expect(Buffer.from(pre.marketData).equals(DATA)).toBe(true); // the slab bytes are handed on, not re-read
    expect(pre.knownLpInfo?.data).toEqual(Buffer.from([1, 2, 3]));
    expect((await res.json()).market.vault_balance).toBe(55);
  });

  it("wizard market: ONE slab read with the registration Blob read alongside it; slab bytes handed on, no known LP", async () => {
    h.curated = false;
    const res = await get();
    expect(res.status).toBe(200);
    expect(h.log.filter((l) => l.startsWith("getAccountInfo"))).toEqual(["getAccountInfo:slab"]);
    expect(h.log.filter((l) => l === "readRegisteredMarkets")).toHaveLength(1);
    const pre = h.capitalArgs[0] as { marketData: Uint8Array; knownLpInfo?: unknown };
    expect(Buffer.from(pre.marketData).equals(DATA)).toBe(true);
    expect(pre.knownLpInfo).toBeUndefined();
    const body = await res.json();
    expect(body.market.symbol).toBe("WZ"); // the Blob metadata still lands in the response
    expect(body.market.dex_pool_address).toBe("POOLX");
  });
});
