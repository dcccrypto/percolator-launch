/**
 * No Pyth in the playground (2026-10-01). The DEX (DexScreener pool -> keeper) and Jupiter paths
 * carry everything Pyth used to:
 *   - /api/oracle/resolve: no Pyth step, never `source: "pyth"` / `oracleMode: "pyth"`, even for
 *     SOL (which had a pinned Pyth feed); DexScreener first, Jupiter (Price API v3) as the price
 *     fallback; the old Jupiter v2 URL answered 404, so that fallback was silently dead;
 *   - price-ws: SOL/USD from Jupiter while fresh, else a DEX read of the SOL/USDC pool;
 *   - no code path calls Hermes / pyth.network for these.
 *
 * Complete removal (same PR): no Pyth network use anywhere in the app —
 *   - /api/chart/pyth (benchmarks.pyth.network) and usePythChart are deleted; the chart's
 *     sources are Percolator trades -> DEX pool (GeckoTerminal) -> on-chain mark history;
 *   - /api/prices/[slab] derives 24h stats from GeckoTerminal only (no Benchmarks fallback);
 *   - /api/oracle/publishers has no `pyth-pinned` / Pythnet RPC mode;
 *   - the CSP connect-src no longer allows hermes.pyth.network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest } from "next/server";

const cache = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/bounded-ttl-cache", () => ({
  BoundedTtlCache: class {
    get(k: string) { return cache.get(k); }
    set(k: string, v: unknown) { cache.set(k, v); }
  },
}));
const owner = vi.hoisted(() => ({ classify: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/dex-pool-owner", async (orig) => ({ ...(await orig<typeof import("@/lib/dex-pool-owner")>()), classifyPoolsByOwner: owner.classify }));

import { GET } from "@/app/api/oracle/resolve/[ca]/route";
import { GET as pricesGET } from "@/app/api/prices/[slab]/route";
import { fetchJupiterSolUsdE6, fetchJupiterUsdPrice, parseJupiterUsdPrice, JUPITER_PRICE_URL } from "@/lib/jupiter-price";
import { pickSolUsdE6 } from "@/lib/priceStore/solUsd";

const SOL = "So11111111111111111111111111111111111111112";
const SOL_POOL = "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y"; // a SOL/USDC Meteora DLMM pool (raydium is withheld for new markets)
const resolve = (ca: string) => GET(new NextRequest(`http://localhost/api/oracle/resolve/${ca}`), { params: Promise.resolve({ ca }) });
const calls: string[] = [];

function stubFetch(o: { dex?: unknown; dexStatus?: number; jup?: unknown; jupStatus?: number }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes("dexscreener")) return new Response(JSON.stringify(o.dex ?? { pairs: [] }), { status: o.dexStatus ?? 200 });
    if (url.startsWith(JUPITER_PRICE_URL)) return new Response(JSON.stringify(o.jup ?? {}), { status: o.jupStatus ?? 200 });
    return new Response("unexpected", { status: 599 });
  }));
}

beforeEach(() => {
  calls.length = 0;
  cache.get.mockReturnValue(undefined);
  owner.classify.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("/api/oracle/resolve without Pyth", () => {
  it("SOL (formerly a pinned Pyth feed) resolves to its DEX pool, keeper-priced; no Pyth anywhere", async () => {
    stubFetch({
      dex: { pairs: [{ chainId: "solana", dexId: "meteora", pairAddress: SOL_POOL, priceUsd: "118", liquidity: { usd: 9e7 }, baseToken: { symbol: "SOL" } }] },
      jup: { [SOL]: { usdPrice: 118.2 } },
    });
    owner.classify.mockResolvedValue({ [SOL_POOL]: "meteora-dlmm" });
    const j = await (await resolve(SOL)).json();
    expect(j).toMatchObject({ feedId: null, source: "dexscreener", oracleMode: "hyperp", dexPoolAddress: SOL_POOL, symbol: "SOL" });
    expect(JSON.stringify(j)).not.toMatch(/pyth/i);
    expect(calls.some((u) => /pyth/i.test(u))).toBe(false);
  });

  it("Jupiter fallback works: DexScreener down -> Jupiter v3 price, admin (no pool)", async () => {
    stubFetch({ dexStatus: 500, jup: { [SOL]: { usdPrice: 117.5 } } });
    const res = await resolve(SOL);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ feedId: null, source: "jupiter", price: 117.5, oracleMode: "admin" });
    expect(calls.some((u) => u.startsWith(`${JUPITER_PRICE_URL}?ids=`))).toBe(true);
  });

  it("NEGATIVE CONTROL: neither source -> 404, never a Pyth guess", async () => {
    stubFetch({ dexStatus: 500, jupStatus: 500 });
    expect((await resolve(SOL)).status).toBe(404);
  });
});

describe("Jupiter Price API v3 reader", () => {
  it("parses the v3 shape; absent / zero / garbage -> null", () => {
    expect(parseJupiterUsdPrice({ [SOL]: { usdPrice: 118.0 } }, SOL)).toBe(118);
    expect(parseJupiterUsdPrice({}, SOL)).toBeNull();
    expect(parseJupiterUsdPrice({ [SOL]: { usdPrice: 0 } }, SOL)).toBeNull();
    expect(parseJupiterUsdPrice({ data: { [SOL]: { price: "118" } } }, SOL)).toBeNull(); // the dead v2 shape
  });
  it("fetches the keyless v3 host; SOL/USD as e6", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ [SOL]: { usdPrice: 118.009638 } }), { status: 200 }));
    expect(await fetchJupiterSolUsdE6(f as unknown as typeof fetch)).toBe(118_009_638n);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe(`https://lite-api.jup.ag/price/v3?ids=${SOL}`);
    const down = vi.fn(async () => new Response("x", { status: 404 }));
    expect(await fetchJupiterUsdPrice(SOL, down as unknown as typeof fetch)).toBeNull();
  });
});

describe("price-ws SOL/USD: Jupiter, else DEX", () => {
  const dex = vi.fn(async () => 117_000_000n);
  it("fresh Jupiter wins, no RPC", async () => {
    dex.mockClear();
    expect(await pickSolUsdE6({ jupiter: { e6: 118_000_000n, at: 1_000 }, now: 5_000, maxAgeMs: 30_000, dexRead: dex })).toBe(118_000_000n);
    expect(dex).not.toHaveBeenCalled();
  });
  it("missing or stale Jupiter -> the DEX SOL/USDC read", async () => {
    expect(await pickSolUsdE6({ jupiter: null, now: 0, maxAgeMs: 30_000, dexRead: dex })).toBe(117_000_000n);
    expect(await pickSolUsdE6({ jupiter: { e6: 118_000_000n, at: 0 }, now: 60_000, maxAgeMs: 30_000, dexRead: dex })).toBe(117_000_000n);
  });
});

describe("no Hermes / pyth.network in the playground's price paths", () => {
  const read = (f: string) => readFileSync(join(__dirname, "..", "..", f), "utf8");
  it("price-ws, the resolve route and the wizard's detection", () => {
    for (const f of ["scripts/local-price-ws-server.ts", "app/api/oracle/resolve/[ca]/route.ts", "hooks/useQuickLaunch.ts"]) {
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/hermes|pyth\.network|setOracleType\("pyth"\)|MINT_TO_PYTH/i);
    }
    expect(existsSync(join(__dirname, "..", "..", "hooks", "usePythFeedSearch.ts"))).toBe(false);
    expect(read("components/create/CreateMarketWizard.tsx")).not.toMatch(/case "pyth":/);
  });
});

// ---------------------------------------------------------------------------
// Complete removal: no Pyth network endpoint anywhere in the shipped app.
// ---------------------------------------------------------------------------

const APP_ROOT = join(__dirname, "..", "..");
const SCAN_DIRS = ["app", "components", "hooks", "lib", "scripts", "public"];
const SCAN_FILES = ["middleware.ts", "next.config.ts", "package.json", "vercel.json"];
const SCAN_EXT = /\.(ts|tsx|js|mjs|cjs|json)$/;

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "__tests__") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCAN_EXT.test(name)) out.push(full);
  }
  return out;
}

function shippedFiles(): string[] {
  const out: string[] = [];
  for (const d of SCAN_DIRS) if (existsSync(join(APP_ROOT, d))) walk(join(APP_ROOT, d), out);
  for (const f of SCAN_FILES) if (existsSync(join(APP_ROOT, f))) out.push(join(APP_ROOT, f));
  return out;
}

/** Any Pyth network host, SDK package, or the deleted chart route. Matched against the RAW
 *  file (not comment-stripped: stripping `//...` would also eat `https://...` inside strings). */
const PYTH_ENDPOINT = /pyth\.network|hermes\.pyth|benchmarks\.pyth|pythnet\.rpcpool|@pythnetwork\/|\/api\/chart\/pyth/i;

describe("no Pyth network endpoint anywhere in the app", () => {
  it("grep: no pyth.network / Hermes / Benchmarks / Pythnet RPC / @pythnetwork / /api/chart/pyth", () => {
    const files = shippedFiles();
    expect(files.length).toBeGreaterThan(100); // the scan actually ran over the tree
    const hits = files
      .map((f) => ({ f: relative(APP_ROOT, f), m: readFileSync(f, "utf8").match(PYTH_ENDPOINT) }))
      .filter((h) => h.m !== null)
      .map((h) => `${h.f}: ${h.m?.[0]}`);
    expect(hits).toEqual([]);
  });

  it("the Pyth chart route and its hook are gone", () => {
    expect(existsSync(join(APP_ROOT, "app", "api", "chart", "pyth"))).toBe(false);
    expect(existsSync(join(APP_ROOT, "hooks", "usePythChart.ts"))).toBe(false);
  });

  it("CSP connect-src does not allow any Pyth host", () => {
    const mw = readFileSync(join(APP_ROOT, "middleware.ts"), "utf8");
    const connect = mw.match(/`connect-src [^`]*`/)?.[0] ?? "";
    expect(connect).toContain("api.geckoterminal.com"); // the line we inspect is the real one
    expect(connect).not.toMatch(/pyth/i);
  });

  it("the chart has no Pyth source tier", () => {
    for (const f of ["lib/chart-live-tick.ts", "lib/chart-source-select.ts", "components/trade/TradingChart.tsx"]) {
      const code = readFileSync(join(APP_ROOT, f), "utf8");
      expect(code, f).not.toMatch(/['"]pyth['"]|usePythChart|pythStatus|hasPythData/);
    }
  });
});

describe("/api/prices/[slab]: 24h stats from GeckoTerminal, never Pyth Benchmarks", () => {
  const SLAB = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const POOL = "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y";

  it("looks up the market's DEX pool and reads its GeckoTerminal OHLCV; no Pyth call", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes(`/api/markets/${SLAB}`)) return new Response(JSON.stringify({ market: { dex_pool_address: POOL } }), { status: 200 });
      if (url.includes("api.geckoterminal.com")) {
        // newest first: [ts, o, h, l, c, v], both inside the last 24h
        const t = Math.floor(Date.now() / 1000);
        const ohlcv_list = [[t - 3600, 110, 120, 105, 115, 1], [t - 7200, 100, 112, 95, 110, 1]];
        return new Response(JSON.stringify({ data: { attributes: { ohlcv_list } } }), { status: 200 });
      }
      return new Response("unexpected", { status: 599 });
    }));
    const res = await pricesGET(new NextRequest(`http://localhost/api/prices/${SLAB}`), { params: Promise.resolve({ slab: SLAB }) });
    expect(res.status).toBe(200);
    const { stats } = (await res.json()) as { stats: { change24h: number; high24h: string; low24h: string; series?: number[] } | null };
    // `series` = the closes over the stats window, oldest to newest (the landing rail's mini chart):
    // the 24h-ago reference bar's close (110) then the newer bar's close (115).
    expect(stats).toEqual({ change24h: 15, high24h: "120000000", low24h: "95000000", series: [110, 115] });
    expect(calls.some((u) => u.includes(`/pools/${POOL}/ohlcv/hour`))).toBe(true);
    expect(calls.some((u) => /pyth/i.test(u))).toBe(false);
  });
});
