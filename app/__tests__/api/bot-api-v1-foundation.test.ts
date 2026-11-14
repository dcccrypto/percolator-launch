// @vitest-environment node
/** /api/v1 wrapper: kill switch, auth, scopes, limits, body checks, idempotency, envelope, logs; health and metrics; the gate. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const rpc = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getSlot: async () => {
      rpc.calls++;
      if (rpc.fail) throw new Error("429 upstream text with a secret-ish url");
      return 1234;
    },
    getBlockHeight: async () => 1200,
  }),
}));

import { botRoute } from "@/lib/bot-api/handler";
import { ApiError } from "@/lib/bot-api/errors";
import { MemoryKv, __setKvForTest } from "@/lib/bot-api/kv";
import { issueKey } from "@/lib/bot-api/keys";
import { TIER_BUDGET } from "@/lib/bot-api/limits";
import { __resetMetricsForTest } from "@/lib/bot-api/metrics";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { GET as health } from "@/app/api/v1/health/route";
import { GET as metrics } from "@/app/api/v1/metrics/route";
import { gateDecision } from "@/lib/playground-gate";

let kv: MemoryKv;
let logs: string[];
const req = (path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`http://x${path}`, { method: init.method ?? "GET", body: init.body, headers: { "x-forwarded-for": "1.2.3.4", ...(init.headers ?? {}) } });

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
  vi.stubEnv("BOT_API_ENABLED", "1");
  __setDevnetV22ForTest(true);
  kv = new MemoryKv();
  __setKvForTest(kv);
  __resetMetricsForTest();
  rpc.fail = false;
  rpc.calls = 0;
  logs = [];
  vi.spyOn(console, "log").mockImplementation((s: unknown) => void logs.push(String(s)));
  vi.spyOn(console, "error").mockImplementation((s: unknown) => void logs.push(String(s)));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  __setDevnetV22ForTest(null);
  __setKvForTest(null);
});

const echo = botRoute({ route: "/v1/echo", scope: "read", weight: 1 }, async ({ principal }) => ({ body: { who: principal.kind, big: 2n ** 70n } }));
let buildCalls = 0;
const build = botRoute({ route: "/v1/build", scope: "build", weight: 10, build: true, body: true, idempotent: true }, async ({ body }) => {
  buildCalls++;
  if (body.fail === "margin") throw new ApiError("insufficient_margin", undefined, { onchain: { code: 49, name: "EngineInsufficientInitialMargin" } });
  if (body.fail === "boom") throw new Error("internal detail that must not leak");
  return { body: { n: buildCalls, lastValidBlockHeight: 99 } };
});

describe("kill switch and gating", () => {
  it("503 disabled when BOT_API_ENABLED is unset, off devnet, or off v2.2", async () => {
    vi.stubEnv("BOT_API_ENABLED", "");
    let r = await echo(req("/api/v1/echo"));
    expect(r.status).toBe(503);
    expect((await r.json()).error.code).toBe("disabled");
    vi.stubEnv("BOT_API_ENABLED", "1");
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "mainnet");
    r = await echo(req("/api/v1/echo"));
    expect(r.status).toBe(503);
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
    __setDevnetV22ForTest(false);
    expect((await echo(req("/api/v1/echo"))).status).toBe(503);
  });
  it("playground gate: /api/v1 exempt only with the flag on; other /api stays gated", async () => {
    const env = { PLAYGROUND_GATE_ENABLED: "true" };
    expect(await gateDecision("/api/v1/markets", "GET", undefined, env)).toBe("pass");
    expect(await gateDecision("/api/v1/orders", "POST", undefined, env)).toBe("pass");
    expect(await gateDecision("/api/v1/../markets", "GET", undefined, env)).toBe("unauthorized");
    expect(await gateDecision("/api/markets", "GET", undefined, env)).toBe("unauthorized");
    expect(await gateDecision("/api/v1/orders", "DELETE", undefined, env)).toBe("unauthorized");
    vi.stubEnv("BOT_API_ENABLED", "");
    expect(await gateDecision("/api/v1/markets", "GET", undefined, env)).toBe("unauthorized");
    vi.stubEnv("BOT_API_ENABLED", "1");
    __setDevnetV22ForTest(false);
    expect(await gateDecision("/api/v1/markets", "GET", undefined, env)).toBe("unauthorized");
  });
});

describe("auth and scopes", () => {
  it("anonymous reads work at the anon budget; builds need a key", async () => {
    const r = await echo(req("/api/v1/echo"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ who: "anon", big: (2n ** 70n).toString() });
    expect(r.headers.get("X-RateLimit-Limit")).toBe(String(TIER_BUDGET.anon));
    expect(r.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
    const b = await build(req("/api/v1/build", { method: "POST", body: "{}" }));
    expect(b.status).toBe(401);
    expect((await b.json()).error.code).toBe("unauthorized");
  });
  it("BOT_API_ANON_READS=0 turns anonymous reads off", async () => {
    vi.stubEnv("BOT_API_ANON_READS", "0");
    expect((await echo(req("/api/v1/echo"))).status).toBe(401);
  });
  it("a read-only key cannot build; a bad key is 401 and never logged", async () => {
    const { key } = await issueKey({ scopes: ["read"] }, kv);
    const r = await build(req("/api/v1/build", { method: "POST", body: "{}", headers: { authorization: `Bearer ${key}` } }));
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("forbidden_scope");
    const bad = await echo(req("/api/v1/echo", { headers: { "x-api-key": key.slice(0, -1) + (key.endsWith("A") ? "B" : "A") } }));
    expect(bad.status).toBe(401);
    expect(logs.join("\n")).not.toContain(key.split("_")[2]);
  });
  it("locks an IP out after 20 bad keys", async () => {
    for (let i = 0; i < 20; i++) await echo(req("/api/v1/echo", { headers: { "x-api-key": "pbk_AAAAAAAAAAAA_" + "x".repeat(43) } }));
    const r = await echo(req("/api/v1/echo", { headers: { "x-api-key": "pbk_AAAAAAAAAAAA_" + "x".repeat(43) } }));
    expect(r.status).toBe(429);
  });
});

describe("limits, body, idempotency, envelope", () => {
  let key: string;
  const post = (body: string, headers: Record<string, string> = {}) =>
    build(req("/api/v1/build", { method: "POST", body, headers: { authorization: `Bearer ${key}`, ...headers } }));
  beforeEach(async () => {
    key = (await issueKey({ scopes: ["read", "build"] }, kv)).key;
    buildCalls = 0;
  });
  it("429 with Retry-After once the weighted budget is spent", async () => {
    let last: Response | null = null;
    for (let i = 0; i < TIER_BUDGET.default / 10 + 1; i++) last = await post("{}");
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await last!.json()).error).toMatchObject({ code: "rate_limited", retryable: true });
  });
  it("refuses an oversized body, bad JSON, a non-object, and an expired request", async () => {
    expect((await post("x".repeat(5000))).status).toBe(413);
    expect((await (await post("{bad")).json()).error.code).toBe("bad_request");
    expect((await post("[1]")).status).toBe(400);
    const r = await post(JSON.stringify({ expiresAfter: Date.now() - 1 }));
    expect((await r.json()).error.code).toBe("request_expired");
    expect(buildCalls).toBe(0);
  });
  it("same Idempotency-Key + body replays the same response without running again; another body conflicts", async () => {
    const h = { "idempotency-key": "order-0001" };
    const a = await post('{"x":1}', h);
    const b = await post('{"x":1}', h);
    expect(await b.json()).toEqual(await a.json());
    expect(b.headers.get("Idempotent-Replayed")).toBe("true");
    expect(buildCalls).toBe(1);
    const c = await post('{"x":2}', h);
    expect(c.status).toBe(409);
    expect((await c.json()).error.code).toBe("idempotency_conflict");
    expect((await post("{}", { "idempotency-key": "bad key" })).status).toBe(400);
  });
  it("a failed build frees its Idempotency-Key", async () => {
    const h = { "idempotency-key": "order-0002" };
    expect((await post('{"fail":"margin"}', h)).status).toBe(422);
    expect((await post('{"fail":"margin"}', h)).status).toBe(422);
    expect(buildCalls).toBe(2);
  });
  it("on-chain refusals carry the code and name; unexpected errors are a bare 500", async () => {
    const r = await post('{"fail":"margin"}');
    expect(await r.json()).toEqual({ error: { code: "insufficient_margin", message: expect.any(String), retryable: false, onchain: { code: 49, name: "EngineInsufficientInitialMargin" } } });
    const x = await post('{"fail":"boom"}');
    expect(x.status).toBe(500);
    const body = await x.json();
    expect(JSON.stringify(body)).not.toContain("internal detail");
    expect(body.error).toEqual({ code: "internal", message: "internal error", retryable: true });
  });
  it("writes one JSON log line per request with keyId, status and code", async () => {
    await post('{"fail":"margin"}');
    const line = logs.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((l) => l?.route === "/v1/build");
    expect(line).toMatchObject({ svc: "bot-api", route: "/v1/build", status: 422, code: "insufficient_margin", principal: key.split("_")[1] });
    expect(typeof line.ms).toBe("number");
  });
});

describe("health and metrics", () => {
  it("health reports slot, block height and the KV backend", async () => {
    const r = await health(req("/api/v1/health"));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "ok", version: "v1", slot: 1234, blockHeight: 1200, kv: { backend: "memory", degraded: false } });
  });
  it("health is 503 rpc_unavailable with no upstream text when the RPC fails", async () => {
    rpc.fail = true;
    const r = await health(req("/api/v1/health"));
    expect(r.status).toBe(503);
    const b = await r.json();
    expect(b.error.code).toBe("rpc_unavailable");
    expect(JSON.stringify(b)).not.toContain("upstream");
  });
  it("metrics need the ops scope and render Prometheus text", async () => {
    await health(req("/api/v1/health"));
    expect((await metrics(req("/api/v1/metrics"))).status).toBe(401);
    const { key } = await issueKey({ scopes: ["ops"] }, kv);
    const r = await metrics(req("/api/v1/metrics", { headers: { authorization: `Bearer ${key}` } }));
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("text/plain");
    const t = await r.text();
    expect(t).toContain('botapi_requests_total{route="/v1/health",status="200",code=""} 1');
    expect(t).toContain('botapi_request_duration_ms_count{route="/v1/health"} 1');
  });
});
