// @vitest-environment node
/** scripts/bot-api/uptime.ts against a stub server: degraded health fails, a keyed check runs when UPTIME_API_KEY is set. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { join } from "node:path";

const PORT = 3941;
let server: Server;
let health: { code: number; body: Record<string, unknown> };
let metricsCode = 200;

beforeAll(async () => {
  server = createServer((req, res) => {
    const json = (code: number, b: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (req.url === "/api/v1/health") return json(health.code, health.body);
    if (req.url === "/api/v1/metrics") {
      if (metricsCode !== 200) return json(metricsCode, { error: { code: "kv_unavailable" } });
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("botapi_requests_total 1\n");
    }
    if (req.url === "/api/v1/markets") return json(200, { markets: [{ market: "M" }] });
    return json(200, { market: { symbol: "X", oracle: { stale: false } } });
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function run(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(join(process.cwd(), "../node_modules/.bin/tsx"), ["scripts/bot-api/uptime.ts", "--base", `http://127.0.0.1:${PORT}`], { env: { PATH: process.env.PATH ?? "", ...env }, cwd: process.cwd() }, (err, stdout) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout });
    });
  });
}
const ok = { status: "ok", slot: 5, rpcMs: 3, kv: { backend: "upstash", degraded: false } };

describe("uptime.ts", () => {
  it("passes on a healthy deployment without a key (no keyed check)", async () => {
    health = { code: 200, body: ok };
    const r = await run({});
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("keyed");
  });
  it("fails on status degraded, and says why", async () => {
    health = { code: 503, body: { ...ok, status: "degraded", kv: { backend: "upstash", degraded: true } } };
    const r = await run({});
    expect(r.code).toBe(1);
    expect(r.out).toContain("kv degraded");
  });
  it("fails on a 200 degraded body too", async () => {
    health = { code: 200, body: { ...ok, status: "degraded" } };
    expect((await run({})).code).toBe(1);
  });
  it("with UPTIME_API_KEY runs the keyed /metrics check and fails when the key store is down", async () => {
    health = { code: 200, body: ok };
    metricsCode = 200;
    const good = await run({ UPTIME_API_KEY: "k" });
    expect(good.code).toBe(0);
    expect(good.out).toContain("keyed");
    metricsCode = 503;
    const bad = await run({ UPTIME_API_KEY: "k" });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("error kv_unavailable");
  });
});
