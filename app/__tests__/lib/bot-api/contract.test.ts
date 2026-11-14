// @vitest-environment node
/**
 * Contract: the JSON the real route handlers return fits the OpenAPI schemas (first-timer F6: the spec said number|null where
 * the wire carried strings, and a client generated from it would have mis-typed the quote). Recorded devnet bytes behind a
 * fake connection; the handlers, the serializer and the spec are all real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { validate } from "./openapi-validate";
import { fakeConnection, SOL, SOL_DATA, LP, LP_DATA, CTX, CTX_DATA, WRAPPER, SOL_SLOT, pk } from "./fake-chain";

const state = vi.hoisted(() => ({ conn: null as unknown }));
vi.mock("@/lib/server-rpc", () => ({ getServerConnection: () => state.conn }));
vi.mock("@/lib/config", async (orig) => ({
  ...(await orig<typeof import("@/lib/config")>()),
  getMarketDiscoveryProgramIds: () => ["5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe"],
  getAllProgramIds: () => ["5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe"],
}));
vi.mock("@/lib/v22/trade-accounts", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/trade-accounts")>()),
  resolveLpTradeAccounts: vi.fn(async () => ({ accountB: LP, matcherProg: pk(5), matcherCtx: CTX, matcherDelegate: pk(6) })),
}));

import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __resetDiscoveryCacheForTest } from "@/lib/bot-api/reads/market-source";
import { __clearQuoteCacheForTest } from "@/lib/bot-api/reads/quote";
import { buildOpenApi } from "@/lib/bot-api/openapi";
import { parsePortfolio } from "@/lib/v22/layout";
import { GET as marketsList } from "@/app/api/v1/markets/route";
import { GET as marketOne } from "@/app/api/v1/markets/[market]/route";
import { GET as quote } from "@/app/api/v1/markets/[market]/quote/route";
import { GET as depth } from "@/app/api/v1/markets/[market]/depth/route";
import { GET as account } from "@/app/api/v1/accounts/[wallet]/route";
import { POST as orders } from "@/app/api/v1/orders/route";

const spec = buildOpenApi() as { components: { schemas: Record<string, Record<string, unknown>> } };
const schemas = spec.components.schemas;

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
const call = async (h: Handler, path: string, params: Record<string, string> = {}, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
  const r = await h(new NextRequest(`http://x${path}`, { method: init.method ?? "GET", headers: { "x-forwarded-for": "9.9.9.9", ...init.headers }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) }), { params: Promise.resolve(params) });
  return { status: r.status, body: await r.json() };
};
const fits = (schema: string, body: unknown) => expect(validate(schemas[schema], body, schemas), schema).toEqual([]);

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
  vi.stubEnv("BOT_API_ENABLED", "1");
  vi.stubEnv("BOT_API_LOG", "0");
  __setDevnetV22ForTest(true);
  __resetDiscoveryCacheForTest();
  __clearQuoteCacheForTest();
  state.conn = fakeConnection({
    slot: SOL_SLOT,
    accounts: [[SOL, SOL_DATA], [CTX, CTX_DATA, pk(5)], [LP, LP_DATA]],
    gpa: (_p, cfg) => (cfg.dataSlice ? [{ pubkey: SOL, account: { data: Buffer.alloc(0) } }] : [{ pubkey: LP, account: { data: LP_DATA } }]),
  }).conn;
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setDevnetV22ForTest(null);
});

describe("handler JSON fits the OpenAPI schemas", () => {
  it("GET /markets, /markets/{market}", async () => {
    const list = await call(marketsList as Handler, "/api/v1/markets");
    expect(list.status).toBe(200);
    fits("MarketList", list.body);
    expect(list.body.markets[0]).toMatchObject({ collateralMint: "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC", collateralDecimals: 6 });
    const one = await call(marketOne as Handler, `/api/v1/markets/${SOL.toBase58()}`, { market: SOL.toBase58() });
    expect(one.status).toBe(200);
    fits("MarketOne", one.body);
  });
  it("GET /quote carries numbers for bps, the oracle block and the fee fields", async () => {
    const r = await call(quote as Handler, `/api/v1/markets/${SOL.toBase58()}/quote?size=100000000&slippageBps=100`, { market: SOL.toBase58() });
    expect(r.status).toBe(200);
    fits("QuoteResponse", r.body);
    const q = r.body.quote;
    expect(typeof q.priceImpactBps).toBe("number");
    expect(typeof q.totalSpreadBps).toBe("number");
    expect(typeof q.matcher.adaptiveFeeBps).toBe("number");
    expect(q.oracle).toMatchObject({ stale: expect.any(Boolean) });
    expect(typeof q.feeCapBps).toBe("number");
    expect(typeof q.expectedFeeBps).toBe("number");
    expect(q.expectedFeeBps).toBeLessThanOrEqual(q.feeCapBps);
    expect(typeof q.sizeQ).toBe("string"); // engine integers stay strings
  });
  it("GET /quote refuses slippageBps 0 up front", async () => {
    const r = await call(quote as Handler, `/api/v1/markets/${SOL.toBase58()}/quote?size=100000000&slippageBps=0`, { market: SOL.toBase58() });
    expect([r.status, r.body.error.code]).toEqual([400, "bad_request"]);
    fits("ErrorEnvelope", r.body);
  });
  it("GET /depth", async () => {
    const r = await call(depth as Handler, `/api/v1/markets/${SOL.toBase58()}/depth`, { market: SOL.toBase58() });
    expect(r.status).toBe(200);
    fits("DepthResponse", r.body);
  });
  it("GET /accounts/{wallet}", async () => {
    const wallet = parsePortfolio(new Uint8Array(LP_DATA)).owner as PublicKey;
    const r = await call(account as Handler, `/api/v1/accounts/${wallet.toBase58()}`, { wallet: wallet.toBase58() });
    expect(r.status).toBe(200);
    fits("Account", r.body);
    const p = r.body.portfolios[0];
    expect(p.leverageEquity).toMatch(/^-?[0-9]+$/);
    expect(typeof p.positions[0].leverage).toBe("number");
  });
  it("an error answer fits ErrorEnvelope", async () => {
    const r = await call(orders as Handler, "/api/v1/orders", {}, { method: "POST", body: { owner: "x" } });
    expect(r.status).toBe(401);
    fits("ErrorEnvelope", r.body);
  });
  it("the validator itself fails a string where a number is declared (negative control)", () => {
    const bad = { slot: 1, observedAt: "2026-11-14T00:00:00Z", quote: { market: SOL.toBase58(), side: "buy", sizeQ: "1", effectivePriceE6: "1", limitPriceE6: "1", estExecPriceE6: null, oracle: { stale: false, ageSecs: 1, staleBoundSecs: 120 }, priceImpactBps: "1" } };
    expect(validate(schemas.QuoteResponse, bad, schemas).join("\n")).toContain("priceImpactBps");
  });
});
