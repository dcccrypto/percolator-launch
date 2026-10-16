// @vitest-environment node
/**
 * percolator-api (NEXT_PUBLIC_API_URL / getBackendUrl / proxyToApi) is retired: it answers
 * "Application not found". Every caller now reads the indexer DB, the chain, or says plainly that
 * the data is not available. These tests drive the real route modules:
 *   - /api/markets/:slab/trades, /api/candles/:slab  -> indexer DB; 404 when none; 503 on DB error
 *   - /api/open-interest/:slab, /api/funding/global  -> chain (PENGU v18 slab, captured read-only)
 *   - /api/markets/:slab/prices                      -> honest 404 (no store of an oracle series)
 *   - ADL rankings, funding history(-Since)          -> deleted with their UI
 * plus a guard that fails if a percolator-api caller comes back into app code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { parseMarketGroupV17OI, V17_KIND_OFF } from "@percolatorct/sdk";
import { V17_ENGINE_CONFIG_OFF, V17_MAX_ABS_FUNDING_REL } from "@/lib/v17-engine-config";

const APP = resolve(__dirname, "..", "..");
const WRAPPER = "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB";
const OLD_WRAPPER = "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ";
const SLAB = "ENdXK8k6iiWCAx4Z9XfoKLg9oXsEbPL4hEtmEmUqozDZ"; // PENGU
const SLAB_B = "Azagguvr2wJ4Lpk8m3d7Y4CHSqYXfNXkQZ6EpyxjBnTk";
const SLAB_C = "HvCDVSx5QS8qN5r8W6gG1ug9xRkMhNw4YNnDu1n1XLrA";
const BLOCKED = "8eFFEFBY3HHbBgzxJJP5hyxdzMNMAumnYNhkWXErBM4c";
const PENGU = Buffer.from(
  readFileSync(join(__dirname, "..", "fixtures", "v18-liveness", "pengu-market-v18-healthy.b64"), "utf8").trim(),
  "base64",
);

interface FakeAccount {
  owner: string;
  data: Buffer;
}

const h = vi.hoisted(() => ({
  accounts: new Map<string, { owner: string; data: Buffer }>(),
  rpcThrows: false,
  rows: [] as Record<string, unknown>[] | null,
  dbConfigured: false,
  dbThrows: false,
  trades: [] as unknown[],
  candleRows: [] as { price: string | null; size: string; created_at: Date }[],
  tradeCalls: [] as Array<[string, number]>,
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/config", async (orig) => {
  const m = await orig<{ getConfig: () => Record<string, unknown> }>();
  return { ...m, getConfig: () => ({ ...m.getConfig(), programId: WRAPPER, network: "devnet" }) };
});
vi.mock("@/lib/server-rpc", () => {
  const toInfo = (a: { owner: string; data: Buffer } | undefined) =>
    a ? { owner: new PublicKey(a.owner), data: a.data } : null;
  return {
    getServerConnection: () => ({
      getAccountInfo: async (pk: PublicKey) => {
        if (h.rpcThrows) throw new Error("429");
        return toInfo(h.accounts.get(pk.toBase58()));
      },
      getMultipleAccountsInfo: async (pks: PublicKey[]) => {
        if (h.rpcThrows) throw new Error("429");
        return pks.map((pk) => toInfo(h.accounts.get(pk.toBase58())));
      },
    }),
  };
});
vi.mock("@/lib/market-registry", () => ({ loadMergedMarketRows: async () => h.rows }));
vi.mock("@/lib/indexer-db", async (orig) => {
  const m = await orig<typeof import("@/lib/indexer-db")>();
  return {
    ...m,
    hasIndexerDb: () => h.dbConfigured,
    queryTrades: async (slab: string, limit: number) => {
      h.tradeCalls.push([slab, limit]);
      if (h.dbThrows) throw new Error("connection refused");
      return h.trades;
    },
    // The route aggregates in SQL now; the double buckets the same rows with the reference
    // implementation (bucketCandles), which the SQL is tested against.
    queryCandlesAggregated: async (_slab: string, bucketSeconds: number) => {
      if (h.dbThrows) throw new Error("connection refused");
      return { udf: m.bucketCandles(h.candleRows, bucketSeconds), truncated: false };
    },
  };
});

const { NextRequest } = await import("next/server");
const { GET: tradesGET } = await import("@/app/api/markets/[slab]/trades/route");
const { GET: candlesGET } = await import("@/app/api/candles/[slab]/route");
const { GET: oiGET } = await import("@/app/api/open-interest/[slab]/route");
const { GET: pricesGET } = await import("@/app/api/markets/[slab]/prices/route");
const { GET: fundingGlobalGET } = await import("@/app/api/funding/global/route");

type SlabHandler = (r: InstanceType<typeof NextRequest>, c: { params: Promise<{ slab: string }> }) => Promise<Response>;
const call = (fn: SlabHandler, slab: string, qs = "") =>
  fn(new NextRequest(`http://localhost/x/${slab}${qs}`), { params: Promise.resolve({ slab }) });

function withMaxAbsFunding(v: bigint): Buffer {
  const d = Buffer.from(PENGU);
  d.writeBigUInt64LE(v, V17_ENGINE_CONFIG_OFF + V17_MAX_ABS_FUNDING_REL);
  return d;
}
const put = (slab: string, a: FakeAccount) => h.accounts.set(slab, a);

beforeEach(() => {
  h.accounts.clear();
  put(SLAB, { owner: WRAPPER, data: PENGU });
  h.rpcThrows = false;
  h.rows = [];
  h.dbConfigured = false;
  h.dbThrows = false;
  h.trades = [];
  h.candleRows = [];
  h.tradeCalls = [];
});

describe("/api/markets/:slab/trades (TradeHistory) -> indexer DB only", () => {
  it("DB configured: serves the indexer rows with the validated limit", async () => {
    h.dbConfigured = true;
    h.trades = [{ id: "1", slab_address: SLAB, side: "long" }];
    const res = await call(tradesGET, SLAB, "?limit=25");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ trades: h.trades });
    expect(h.tradeCalls).toEqual([[SLAB, 25]]);
  });
  it("no DB configured -> 404 (no trade tape here), never an invented empty 200", async () => {
    const res = await call(tradesGET, SLAB);
    expect(res.status).toBe(404);
    expect(await res.json()).not.toHaveProperty("trades");
    expect(h.tradeCalls).toEqual([]);
  });
  it("DB error -> 503 retryable", async () => {
    h.dbConfigured = true;
    h.dbThrows = true;
    const res = await call(tradesGET, SLAB);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
  });
  it("bad limit -> 400, bad slab -> 400", async () => {
    h.dbConfigured = true;
    expect((await call(tradesGET, SLAB, "?limit=999")).status).toBe(400);
    expect((await call(tradesGET, "not-a-slab")).status).toBe(400);
  });
});

describe("/api/candles/:slab (usePercolatorCandles) -> indexer DB only", () => {
  const qs = "?resolution=60&from=1700000000&to=1700036000";
  it("DB configured: buckets the indexer trades into UDF bars", async () => {
    h.dbConfigured = true;
    h.candleRows = [
      { price: "1.5", size: "10", created_at: new Date(1_700_000_100_000) },
      { price: "2.5", size: "5", created_at: new Date(1_700_000_200_000) },
    ];
    const res = await call(candlesGET, SLAB, qs);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { s: string; t: number[] };
    expect(body.s).toBe("ok");
    expect(body.t).toHaveLength(1);
  });
  it("no DB configured -> 404 (the hook's 'no candle source on this deployment' signal)", async () => {
    const res = await call(candlesGET, SLAB, qs);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { s: string }).s).toBe("error");
  });
  it("DB error -> 503; unsupported resolution / bad window -> 400", async () => {
    h.dbConfigured = true;
    h.dbThrows = true;
    expect((await call(candlesGET, SLAB, qs)).status).toBe(503);
    h.dbThrows = false;
    expect((await call(candlesGET, SLAB, "?resolution=7&from=1&to=2")).status).toBe(400);
    expect((await call(candlesGET, SLAB, "?resolution=60&from=5&to=2")).status).toBe(400);
  });
});

describe("/api/open-interest/:slab (OpenInterestCard) -> chain only", () => {
  it("v18 market slab: OI straight from the slab", async () => {
    const oi = parseMarketGroupV17OI(new Uint8Array(PENGU));
    const res = await call(oiGET, SLAB);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      longOi: oi.totalLongOiQ.toString(),
      shortOi: oi.totalShortOiQ.toString(),
      totalOi: (oi.totalLongOiQ + oi.totalShortOiQ).toString(),
      isV17: true,
    });
  });
  it("RPC failure -> 503 degraded (was: proxy to the dead API)", async () => {
    h.rpcThrows = true;
    const res = await call(oiGET, SLAB);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ unavailable: true });
  });
  it("v17 account that is not a market -> 404, not a 200 of zeros", async () => {
    const d = Buffer.from(PENGU);
    d[V17_KIND_OFF] = 2;
    put(SLAB, { owner: WRAPPER, data: d });
    expect((await call(oiGET, SLAB)).status).toBe(404);
  });
  it("v17 market that fails to parse -> 503, not a 200 of zeros", async () => {
    put(SLAB, { owner: WRAPPER, data: PENGU.subarray(0, 400) });
    expect((await call(oiGET, SLAB)).status).toBe(503);
  });
  it("an account that is not a market at all -> 404 (permanent), not 503 'temporarily unavailable'", async () => {
    put(SLAB, { owner: "11111111111111111111111111111111", data: Buffer.alloc(0) }); // system account
    expect((await call(oiGET, SLAB)).status).toBe(404);
    put(SLAB, { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: Buffer.alloc(82) }); // a mint
    expect((await call(oiGET, SLAB)).status).toBe(404);
    put(SLAB, { owner: WRAPPER, data: Buffer.alloc(64) }); // wrapper-owned, not a v17 market
    expect((await call(oiGET, SLAB)).status).toBe(404);
  });
  it("another program's market (e.g. the abandoned wrapper) -> 404 (owning-program check)", async () => {
    put(SLAB, { owner: OLD_WRAPPER, data: PENGU });
    expect((await call(oiGET, SLAB)).status).toBe(404);
  });
  it("missing account -> 404; blocked slab -> 404", async () => {
    h.accounts.clear();
    expect((await call(oiGET, SLAB)).status).toBe(404);
    expect((await call(oiGET, BLOCKED)).status).toBe(404);
  });
});

describe("/api/funding/global (dashboard FundingRates) -> chain", () => {
  it("funding-off slab of the current wrapper: listed at exactly 0, with its symbol", async () => {
    h.rows = [{ slab_address: SLAB, symbol: "PENGU" }];
    const res = await fundingGlobalGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      markets: [{ slabAddress: SLAB, baseSymbol: "PENGU", rateBpsPerSlot: 0, hourlyRatePercent: 0, dailyRatePercent: 0, fundingEnabled: false }],
      count: 1,
      ratesUnavailable: 0,
      source: "on-chain",
    });
  });
  it("funding-on slab: counted as ratesUnavailable, never listed with an invented rate", async () => {
    put(SLAB_B, { owner: WRAPPER, data: withMaxAbsFunding(1000n) });
    h.rows = [{ slab_address: SLAB, symbol: "PENGU" }, { slab_address: SLAB_B, symbol: "SOL" }];
    const body = (await (await fundingGlobalGET()).json()) as { markets: { slabAddress: string }[]; ratesUnavailable: number };
    expect(body.markets.map((m) => m.slabAddress)).toEqual([SLAB]);
    expect(body.ratesUnavailable).toBe(1);
  });
  it("skips another program's slab, a missing slab and a blocked slab", async () => {
    put(SLAB_B, { owner: OLD_WRAPPER, data: PENGU });
    h.rows = [{ slab_address: SLAB_B }, { slab_address: SLAB_C }, { slab_address: BLOCKED }];
    put(BLOCKED, { owner: WRAPPER, data: PENGU });
    const body = (await (await fundingGlobalGET()).json()) as { markets: unknown[]; ratesUnavailable: number };
    expect(body).toMatchObject({ markets: [], count: 0, ratesUnavailable: 0 });
  });
  it("registry unavailable -> 503; RPC failure -> 503 (the panel hides, no 'Funding: Off' claim)", async () => {
    h.rows = null;
    expect((await fundingGlobalGET()).status).toBe(503);
    h.rows = [{ slab_address: SLAB }];
    h.rpcThrows = true;
    expect((await fundingGlobalGET()).status).toBe(503);
  });
});

describe("/api/markets/:slab/prices (TradingChart oracle history)", () => {
  it("honest 404: no store records an oracle price series", async () => {
    const res = await call(pricesGET, SLAB);
    expect(res.status).toBe(404);
    expect(await res.json()).not.toHaveProperty("prices");
    expect((await call(pricesGET, "not-a-slab")).status).toBe(400);
  });
});

describe("deleted with their UI (no data source left)", () => {
  it.each([
    "app/api/adl/rankings/route.ts",
    "app/api/adl-leaderboard/route.ts",
    "app/api/funding/[slab]/history/route.ts",
    "app/api/funding/[slab]/historySince/route.ts",
    "lib/api-proxy.ts",
    "components/trade/AdlLeaderboard.tsx",
    "components/trade/FundingRateChart.tsx",
    "hooks/useBatchTrade.ts",
    "hooks/usePriceRouter.ts",
  ])("%s is gone", (f) => {
    expect(existsSync(join(APP, f))).toBe(false);
  });
  it("no surface still fetches the deleted routes", () => {
    for (const f of ["components/trade/PositionPanel.tsx", "components/trade/FundingRateCard.tsx", "components/trade/MarketStatsCard.tsx", "app/analytics/[slab]/page.tsx"]) {
      const src = readFileSync(join(APP, f), "utf8");
      expect(src, f).not.toMatch(/\/api\/adl|\/history|AdlLeaderboard|FundingRateChart/);
    }
  });
});

describe("guard: no percolator-api caller returns to app code", () => {
  const SKIP = new Set(["node_modules", ".next", "__tests__", "e2e", "coverage", "test-results", "playwright-report"]);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.|\.spec\./.test(name)) files.push(p);
    }
  };
  walk(APP);

  it("scans the app tree", () => {
    expect(files.length).toBeGreaterThan(200);
  });
  it.each([
    ["proxyToApi(", /\bproxyToApi\s*\(/],
    ["getBackendUrl", /\bgetBackendUrl\b/],
    ["process.env.NEXT_PUBLIC_API_URL", /process\.env\.NEXT_PUBLIC_API_URL\b|process\.env\[["']NEXT_PUBLIC_API_URL["']\]/],
    ["process.env.NEXT_PUBLIC_BACKEND_URL", /process\.env\.NEXT_PUBLIC_BACKEND_URL\b/],
    ["@/lib/api-proxy import", /from\s+["']@\/lib\/api-proxy["']/],
  ])("no %s", (_label, re) => {
    const hits = files.filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => relative(APP, f));
    expect(hits).toEqual([]);
  });
  it("the CSP no longer allows the retired api.percolatorlaunch.com host", () => {
    const connect = readFileSync(join(APP, "middleware.ts"), "utf8").match(/`connect-src [^`]*`/)?.[0] ?? "";
    expect(connect).toContain("wss://*.up.railway.app"); // the live price-ws host
    expect(connect).not.toContain("api.percolatorlaunch.com");
  });
  it("no deploy config sets NEXT_PUBLIC_API_URL", () => {
    expect(readFileSync(join(APP, "vercel.mainnet.json"), "utf8")).not.toContain("NEXT_PUBLIC_API_URL");
    expect(readFileSync(join(APP, "next.config.ts"), "utf8")).not.toContain("NEXT_PUBLIC_API_URL");
  });
});
