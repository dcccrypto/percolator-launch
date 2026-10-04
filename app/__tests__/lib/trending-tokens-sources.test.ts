// @vitest-environment node
/**
 * The trending pipeline through the REAL fetch layer (global fetch mocked by URL):
 * GeckoTerminal is the primary source, pump.fun is best effort (it 403s from
 * geo/bot-blocked egress), DexScreener supplies market data with GeckoTerminal's
 * own pool data standing in when DexScreener is down. `sourceEmpty` must be true
 * only when no candidate source answered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTrendingTokens,
  parseGeckoTrending,
  safeLogoUrl,
  keeperFloorUsd,
} from "@/lib/trending-tokens";

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const M = (seed: string): string => (seed + "1".repeat(43)).slice(0, 43);
const POOL = (seed: string): string => (seed + "2".repeat(44)).slice(0, 44);

/** One GeckoTerminal trending pool, in the live response's shape (2026-10-04 probe). */
const gPool = (base: string, opts: { dex?: string; quote?: string; reserve?: string; vol?: string; mc?: string } = {}) => ({
  id: `solana_${POOL(base)}`,
  type: "pool",
  attributes: {
    address: POOL(base),
    name: `${base} / SOL`,
    base_token_price_usd: "0.00033",
    fdv_usd: "190559.38",
    market_cap_usd: opts.mc ?? "196476.73",
    volume_usd: { h24: opts.vol ?? "47551.13" },
    reserve_in_usd: opts.reserve ?? "122037.39",
  },
  relationships: {
    base_token: { data: { id: `solana_${M(base)}`, type: "token" } },
    quote_token: { data: { id: `solana_${opts.quote ?? WSOL}`, type: "token" } },
    dex: { data: { id: opts.dex ?? "pumpswap", type: "dex" } },
  },
});
const gToken = (base: string) => ({
  id: `solana_${M(base)}`,
  type: "token",
  attributes: { address: M(base), name: `${base} coin`, symbol: base.toUpperCase(), image_url: `https://coin-images.coingecko.com/${base}.png` },
});
const geckoBody = (...bases: Array<[string, Parameters<typeof gPool>[1]?]>) => ({
  data: bases.map(([b, o]) => gPool(b, o)),
  included: bases.map(([b]) => gToken(b)),
});

/** One DexScreener pair, in the live `latest/dex/tokens` shape. */
const dPair = (base: string, opts: { dex?: string; quote?: string; liq?: number; quoteAmt?: number; vol?: number } = {}) => ({
  chainId: "solana",
  dexId: opts.dex ?? "pumpswap",
  pairAddress: POOL(base),
  baseToken: { address: M(base), symbol: base.toUpperCase() },
  quoteToken: { address: opts.quote ?? WSOL, symbol: "SOL" },
  priceNative: "0.0000027",
  priceUsd: "0.00033", // => quote (SOL) ≈ $122.2
  liquidity: { usd: opts.liq ?? 122_966, base: 192_569_771, quote: opts.quoteAmt ?? 490.76 },
  volume: { h24: opts.vol ?? 47_000 },
  marketCap: 190_597,
});

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
let routes: { gecko: Route; pump: Route; dex: Route };
const calls: Array<{ url: string; headers: Record<string, string> }> = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const blocked = () =>
  new Response('<meta http-equiv="refresh" content="0; url=https://static.pump.fun/blocked">', { status: 403 });

beforeEach(() => {
  calls.length = 0;
  routes = { gecko: () => json(geckoBody()), pump: () => blocked(), dex: () => json({ pairs: [] }) };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
      if (url.includes("geckoterminal.com") || url.includes("coingecko.com")) return routes.gecko(url, init);
      if (url.includes("pump.fun")) return routes.pump(url, init);
      if (url.includes("dexscreener.com")) return routes.dex(url, init);
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("getTrendingTokens — sources", () => {
  it("lists GeckoTerminal trending tokens when pump.fun 403s (the live situation)", async () => {
    routes.gecko = () => json(geckoBody(["aaa"], ["bbb", { vol: "90000" }]));
    routes.dex = () => json({ pairs: [dPair("aaa", { vol: 10_000 }), dPair("bbb", { vol: 90_000 })] });
    const r = await getTrendingTokens();
    expect(r.sourceEmpty).toBe(false);
    expect(r.sources).toEqual({ geckoterminal: "ok", pumpfun: "error" });
    expect(r.tokens.map((t) => t.symbol)).toEqual(["BBB", "AAA"]); // ranked by DexScreener 24h volume
    expect(r.tokens[0]).toMatchObject({
      mint: M("bbb"),
      dexId: "pumpswap",
      source: "geckoterminal",
      chartUrl: `https://dexscreener.com/solana/${POOL("bbb")}`,
      logoUrl: "https://coin-images.coingecko.com/bbb.png",
    });
  });

  it("sourceEmpty when every source fails (403 / 500) — not 'nothing matched'", async () => {
    routes.gecko = () => json({ errors: [{ status: "403" }] }, 403);
    routes.pump = () => blocked();
    const r = await getTrendingTokens();
    expect(r.tokens).toEqual([]);
    expect(r.sourceEmpty).toBe(true);
    expect(r.sources).toEqual({ geckoterminal: "error", pumpfun: "error" });
    // No candidates → no DexScreener call at all.
    expect(calls.some((c) => c.url.includes("dexscreener"))).toBe(false);
  });

  it("sourceEmpty when sources time out / throw", async () => {
    routes.gecko = () => new Response("bad gateway", { status: 404 });
    routes.pump = () => Promise.reject(new DOMException("timeout", "TimeoutError"));
    const r = await getTrendingTokens();
    expect(r.sourceEmpty).toBe(true);
  });

  it("NOT sourceEmpty when sources answered but nothing passed the filters", async () => {
    routes.gecko = () => json(geckoBody(["ray", { dex: "raydium" }], ["doge", { quote: M("Doge") }]));
    routes.dex = () => json({ pairs: [dPair("ray", { dex: "raydium" }), dPair("doge", { quote: M("Doge") })] });
    const r = await getTrendingTokens();
    expect(r.tokens).toEqual([]);
    expect(r.sourceEmpty).toBe(false);
  });

  it("NOT sourceEmpty when a source answered but every coin failed its flag gate (zero candidates)", async () => {
    routes.gecko = () => json({ errors: [{ status: "403" }] }, 403);
    routes.pump = () => json([{ mint: M("curve"), symbol: "CURVE", complete: false }]);
    const r = await getTrendingTokens();
    expect(r.tokens).toEqual([]);
    expect(r.sources.pumpfun).toBe("ok");
    expect(r.sourceEmpty).toBe(false);
  });

  it("uses pump.fun when it answers, applying its flag gate", async () => {
    routes.gecko = () => json({}, 500);
    routes.pump = () =>
      json([
        { mint: M("pump"), symbol: "PUMP", name: "Pump", complete: true, image_uri: "https://ipfs.example/p.png" },
        { mint: M("hook"), symbol: "HOOK", complete: true, transfer_hook_program: M("Hk") },
        { mint: M("curve"), symbol: "CURVE", complete: false },
      ]);
    routes.dex = () => json({ pairs: [dPair("pump"), dPair("hook"), dPair("curve")] });
    const r = await getTrendingTokens();
    expect(r.sources.pumpfun).toBe("ok");
    expect(r.sourceEmpty).toBe(false);
    expect(r.tokens.map((t) => t.symbol)).toEqual(["PUMP"]);
    expect(r.tokens[0].source).toBe("pumpfun");
  }, 20_000);

  it("falls back to GeckoTerminal's own pool data when DexScreener is down", async () => {
    routes.gecko = () => json(geckoBody(["aaa"]));
    routes.dex = () => json({}, 503);
    const r = await getTrendingTokens();
    expect(r.tokens).toHaveLength(1);
    expect(r.tokens[0].chartUrl).toBe(`https://www.geckoterminal.com/solana/pools/${POOL("aaa")}`);
    expect(r.tokens[0].liquidityUsd).toBeCloseTo(122037.39);
  });

  it("does NOT fall back when DexScreener answered but has no supported pool (fail-closed)", async () => {
    routes.gecko = () => json(geckoBody(["aaa"]));
    routes.dex = () => json({ pairs: [dPair("aaa", { dex: "raydium" })] });
    const r = await getTrendingTokens();
    expect(r.tokens).toEqual([]);
  });

  it("drops a PumpSwap pool whose quote side is under the keeper's $1000 floor", async () => {
    routes.gecko = () => json(geckoBody(["thin"]));
    // $9k total liquidity but only 5 SOL (~$611) on the quote side.
    routes.dex = () => json({ pairs: [dPair("thin", { liq: 9_000, quoteAmt: 5 })] });
    const r = await getTrendingTokens();
    expect(r.tokens).toEqual([]);
  });

  it("sends the CoinGecko key only server-side, to the CoinGecko host, when configured", async () => {
    vi.stubEnv("COINGECKO_API_KEY", "test-key");
    routes.gecko = () => json(geckoBody(["aaa"]));
    routes.dex = () => json({ pairs: [dPair("aaa")] });
    await getTrendingTokens();
    const g = calls.find((c) => c.url.includes("trending_pools"))!;
    expect(g.url.startsWith("https://api.coingecko.com/api/v3/onchain/networks/solana/trending_pools")).toBe(true);
    expect(g.headers["x-cg-demo-api-key"]).toBe("test-key");
    for (const c of calls.filter((c) => !c.url.includes("coingecko"))) {
      expect(JSON.stringify(c.headers)).not.toContain("test-key");
    }
  });

  it("never interpolates an invalid mint into the DexScreener URL", async () => {
    const body = geckoBody(["aaa"]);
    body.data.push({ ...gPool("x"), relationships: { ...gPool("x").relationships, base_token: { data: { id: "solana_../../evil", type: "token" } } } });
    routes.gecko = () => json(body);
    routes.dex = () => json({ pairs: [dPair("aaa")] });
    await getTrendingTokens();
    const d = calls.find((c) => c.url.includes("dexscreener"))!;
    expect(d.url).toBe(`https://api.dexscreener.com/latest/dex/tokens/${M("aaa")}`);
  });
});

describe("parseGeckoTrending", () => {
  it("skips pools whose base is SOL/USDC (reversed pairs) and duplicate mints", () => {
    const body = geckoBody(["aaa"], ["aaa"]);
    body.data.push({ ...gPool("q"), relationships: { ...gPool("q").relationships, base_token: { data: { id: `solana_${USDC}`, type: "token" } } } });
    expect(parseGeckoTrending(body).map((c) => c.mint)).toEqual([M("aaa")]);
  });
  it("returns [] for garbage", () => {
    expect(parseGeckoTrending(null)).toEqual([]);
    expect(parseGeckoTrending({ data: "x" })).toEqual([]);
  });
});

describe("safeLogoUrl / keeperFloorUsd", () => {
  it("passes only https URLs", () => {
    expect(safeLogoUrl("https://a.example/x.png")).toBe("https://a.example/x.png");
    expect(safeLogoUrl("http://a.example/x.png")).toBeNull();
    expect(safeLogoUrl("javascript:alert(1)")).toBeNull();
    expect(safeLogoUrl("ipfs://Qm")).toBeNull();
    expect(safeLogoUrl(42)).toBeNull();
  });
  it("defaults the keeper floor to $1000 and follows MIN_POOL_LIQUIDITY_USD", () => {
    expect(keeperFloorUsd(undefined)).toBe(1000);
    expect(keeperFloorUsd("")).toBe(1000);
    expect(keeperFloorUsd("2500")).toBe(2500);
    expect(keeperFloorUsd("junk")).toBe(1000);
  });
});
