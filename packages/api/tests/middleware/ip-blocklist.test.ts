import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";

vi.mock("@percolator/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// We must re-import the module after each env mutation because the blocklist
// is parsed at module load time. Use dynamic import with cache-busting.
async function loadMiddlewareWithEnv(blocklist: string) {
  vi.resetModules();
  process.env.IP_BLOCKLIST = blocklist;
  const mod = await import("../../src/middleware/ip-blocklist.js");
  return mod.ipBlocklist;
}

function makeApp(ipBlocklistFn: ReturnType<typeof import("../../src/middleware/ip-blocklist.js")["ipBlocklist"]>) {
  const app = new Hono();
  app.use("*", ipBlocklistFn());
  app.get("*", (c) => c.json({ ok: true }));
  return app;
}

function makeRequest(ip: string, path = "/test") {
  return new Request(`http://localhost${path}`, {
    headers: { "x-forwarded-for": ip },
  });
}

describe("ipBlocklist middleware", () => {
  beforeEach(() => {
    process.env.TRUSTED_PROXY_DEPTH = "1";
  });

  it("allows requests when blocklist is empty", async () => {
    const fn = await loadMiddlewareWithEnv("");
    const app = makeApp(fn);
    const res = await app.request(makeRequest("88.97.223.158"));
    expect(res.status).toBe(200);
  });

  it("blocks an exact-match IP", async () => {
    const fn = await loadMiddlewareWithEnv("88.97.223.158");
    const app = makeApp(fn);
    const res = await app.request(makeRequest("88.97.223.158"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("allows a non-blocklisted IP when blocklist has entries", async () => {
    const fn = await loadMiddlewareWithEnv("88.97.223.158");
    const app = makeApp(fn);
    const res = await app.request(makeRequest("1.2.3.4"));
    expect(res.status).toBe(200);
  });

  it("blocks an IP matching a /24 CIDR", async () => {
    const fn = await loadMiddlewareWithEnv("192.168.1.0/24");
    const app = makeApp(fn);

    const blocked = await app.request(makeRequest("192.168.1.99"));
    expect(blocked.status).toBe(403);

    const allowed = await app.request(makeRequest("192.168.2.1"));
    expect(allowed.status).toBe(200);
  });

  it("blocks an IP matching a /16 CIDR", async () => {
    const fn = await loadMiddlewareWithEnv("10.0.0.0/16");
    const app = makeApp(fn);

    const blocked = await app.request(makeRequest("10.0.255.1"));
    expect(blocked.status).toBe(403);

    const allowed = await app.request(makeRequest("10.1.0.1"));
    expect(allowed.status).toBe(200);
  });

  it("supports multiple entries (exact + CIDR)", async () => {
    const fn = await loadMiddlewareWithEnv("88.97.223.158,10.0.0.0/8");
    const app = makeApp(fn);

    expect((await app.request(makeRequest("88.97.223.158"))).status).toBe(403);
    expect((await app.request(makeRequest("10.99.1.2"))).status).toBe(403);
    expect((await app.request(makeRequest("172.16.0.1"))).status).toBe(200);
  });

  it("respects TRUSTED_PROXY_DEPTH for IP extraction", async () => {
    process.env.TRUSTED_PROXY_DEPTH = "1";
    const fn = await loadMiddlewareWithEnv("88.97.223.158");
    const app = makeApp(fn);

    // X-Forwarded-For: <spoofed>, <real client as seen by proxy>
    // With depth=1 we take the LAST ip (real one added by our trusted proxy)
    const req = new Request("http://localhost/test", {
      headers: { "x-forwarded-for": "1.2.3.4, 88.97.223.158" },
    });
    const res = await app.request(req);
    expect(res.status).toBe(403);
  });

  it("allows spoofed IPs that are not the trusted client IP (depth=1)", async () => {
    process.env.TRUSTED_PROXY_DEPTH = "1";
    const fn = await loadMiddlewareWithEnv("88.97.223.158");
    const app = makeApp(fn);

    // Attacker puts blocked IP in the header, but real IP (added by proxy) is 9.9.9.9
    const req = new Request("http://localhost/test", {
      headers: { "x-forwarded-for": "88.97.223.158, 9.9.9.9" },
    });
    const res = await app.request(req);
    expect(res.status).toBe(200);
  });
});
