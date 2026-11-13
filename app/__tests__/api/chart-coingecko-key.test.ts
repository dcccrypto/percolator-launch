// @vitest-environment node
/**
 * #2578 — optional server-side CoinGecko/GeckoTerminal API key for /api/chart/[mint].
 * Key set -> authenticated on-chain host + header; unset -> free keyless path.
 * The key must never appear in the response body/headers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@solana/web3.js";
import { GET } from "../../app/api/chart/[mint]/route";
import { getGeckoConfig } from "@/lib/gecko-fetch";

const SECRET = "CG-test-secret-key";

function geckoMock() {
  // Unique pool per test: the route's in-process candle cache is keyed by pool.
  const POOL = Keypair.generate().publicKey.toBase58();
  return vi.fn(async (url: string) => {
    if (url.includes("include=top_pools")) {
      return {
        ok: true, status: 200,
        json: async () => ({
          data: { relationships: { top_pools: { data: [{ id: `solana_${POOL}` }] } } },
          included: [{ id: `solana_${POOL}`, attributes: { address: POOL } }],
        }),
      } as unknown as Response;
    }
    return {
      ok: true, status: 200,
      json: async () => ({ data: { attributes: { ohlcv_list: [[1700000000, 1, 2, 0.5, 1.5, 10]] } } }),
    } as unknown as Response;
  });
}
async function call() {
  const mint = Keypair.generate().publicKey.toBase58();
  const res = await GET(new NextRequest(`http://localhost/api/chart/${mint}?timeframe=day`), {
    params: Promise.resolve({ mint }),
  });
  return { res, text: JSON.stringify(await res.json()) };
}
const headersOf = (c: unknown[]) => (c[1] as { headers: Record<string, string> }).headers;

describe("/api/chart/[mint] CoinGecko key (#2578)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("no key: free GeckoTerminal base, no auth header", async () => {
    const f = geckoMock();
    vi.stubGlobal("fetch", f);
    const { res } = await call();
    expect(res.status).toBe(200);
    expect(f.mock.calls.length).toBe(2);
    for (const c of f.mock.calls) {
      expect(String(c[0])).toMatch(/^https:\/\/api\.geckoterminal\.com\/api\/v2\/networks\/solana\//);
      expect(headersOf(c)).not.toHaveProperty("x-cg-demo-api-key");
      expect(headersOf(c)).not.toHaveProperty("x-cg-pro-api-key");
    }
  });

  it("blank key is treated as unset", () => {
    vi.stubEnv("COINGECKO_API_KEY", "   ");
    expect(getGeckoConfig().authHeaders).toEqual({});
  });

  it("key + default tier: demo host + x-cg-demo-api-key on both calls", async () => {
    vi.stubEnv("COINGECKO_API_KEY", SECRET);
    const f = geckoMock();
    vi.stubGlobal("fetch", f);
    await call();
    expect(f.mock.calls.length).toBe(2);
    for (const c of f.mock.calls) {
      expect(String(c[0])).toMatch(/^https:\/\/api\.coingecko\.com\/api\/v3\/onchain\/networks\/solana\//);
      expect(headersOf(c)["x-cg-demo-api-key"]).toBe(SECRET);
      expect(headersOf(c)).not.toHaveProperty("x-cg-pro-api-key");
    }
  });

  it("key + tier=pro: pro host + x-cg-pro-api-key", async () => {
    vi.stubEnv("COINGECKO_API_KEY", SECRET);
    vi.stubEnv("COINGECKO_API_TIER", "PRO");
    const f = geckoMock();
    vi.stubGlobal("fetch", f);
    await call();
    for (const c of f.mock.calls) {
      expect(String(c[0])).toMatch(/^https:\/\/pro-api\.coingecko\.com\/api\/v3\/onchain\/networks\/solana\//);
      expect(headersOf(c)["x-cg-pro-api-key"]).toBe(SECRET);
      expect(headersOf(c)).not.toHaveProperty("x-cg-demo-api-key");
    }
  });

  it("never leaks the key to the client (body or response headers)", async () => {
    vi.stubEnv("COINGECKO_API_KEY", SECRET);
    vi.stubGlobal("fetch", geckoMock());
    const { res, text } = await call();
    expect(text).not.toContain(SECRET);
    expect(JSON.stringify([...res.headers.entries()])).not.toContain(SECRET);
  });
});
