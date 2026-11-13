// @vitest-environment node
/**
 * Council 2026-11-07 council-leftovers run 2, finding 2 (MED-HIGH; Operator, Trader, First-timer, Clerk, Skeptic):
 * "/api/runtime-config serves ws://localhost:8797, and the CSP connect-src omits it, so the console shows a CSP
 * violation." Fix asked for: one predicate for "accept" and "allow", and a SERVED-HEADER test that connect-src contains
 * the runtime URL. This drives the real middleware (the CSP header it serves on a page) and the real
 * /api/runtime-config route with the same env, and checks: whatever URL is served is allowed by connect-src, and in
 * production a ws:// value is neither served nor allowed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@upstash/redis", () => ({
  Redis: vi.fn(function (this: object) {
    return this;
  }),
}));

type Mw = (req: NextRequest) => Promise<Response>;

const directive = (csp: string, name: string) =>
  csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `))?.split(/\s+/).slice(1) ?? [];

async function serve(env: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("PLAYGROUND_GATE_ENABLED", "false");
  vi.stubEnv("NEXT_PUBLIC_WS_URL", "");
  vi.stubEnv("PRICE_WS_URL", "");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const middleware = (await import("@/middleware")).middleware as Mw;
  const { GET } = await import("@/app/api/runtime-config/route");
  const page = await middleware(new NextRequest("https://preview.example.test/trade/x", { headers: { "x-forwarded-for": "10.7.7.7" } }));
  const csp = page.headers.get("Content-Security-Policy") ?? "";
  const body = await GET().text();
  const served = JSON.parse(body.slice(body.indexOf("Object.freeze(") + "Object.freeze(".length, body.lastIndexOf(")"))) as { priceWsUrl: string };
  return { connect: directive(csp, "connect-src"), served: served.priceWsUrl };
}

const originOf = (url: string) => {
  const u = new URL(url);
  return `${u.protocol}//${u.port ? `${u.hostname}:${u.port}` : u.hostname}`;
};

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe("served price-WS URL ⇔ CSP connect-src (production)", () => {
  it("a wss:// PRICE_WS_URL is served AND its exact origin (+ https twin) is in the served connect-src", async () => {
    const { connect, served } = await serve({ NODE_ENV: "production", PRICE_WS_URL: "wss://tunnel-abc.trycloudflare.com" });
    expect(served).toBe("wss://tunnel-abc.trycloudflare.com");
    expect(connect).toContain(originOf(served));
    expect(connect).toContain("https://tunnel-abc.trycloudflare.com");
  });

  it("a wss:// with a port and path: the origin with the port is allowed", async () => {
    const { connect, served } = await serve({ NODE_ENV: "production", PRICE_WS_URL: "wss://price.example.com:8443/feed" });
    expect(served).toBe("wss://price.example.com:8443/feed");
    expect(connect).toContain("wss://price.example.com:8443");
  });

  it("ws://localhost (the run-2 environment) is NOT served in production, so nothing the CSP refuses is handed out", async () => {
    const { connect, served } = await serve({ NODE_ENV: "production", PRICE_WS_URL: "ws://localhost:8797" });
    expect(served).toBe("");
    expect(connect.some((o) => o.startsWith("ws://"))).toBe(false);
  });

  it("a refused PRICE_WS_URL falls back to a wss:// NEXT_PUBLIC_WS_URL, which is then both served and allowed", async () => {
    const { connect, served } = await serve({ NODE_ENV: "production", PRICE_WS_URL: "ws://localhost:8797", NEXT_PUBLIC_WS_URL: "wss://old.trycloudflare.com" });
    expect(served).toBe("wss://old.trycloudflare.com");
    expect(connect).toContain("wss://old.trycloudflare.com");
  });

  it("for every candidate value: served non-empty ⇒ its origin is allowed", async () => {
    for (const v of ["wss://a.example.com", "ws://localhost:8787", "ws://127.0.0.1:8797", "ws://evil.example.com", "https://x.example.com", "wss://u:p@x.example.com", "junk"]) {
      const { connect, served } = await serve({ NODE_ENV: "production", PRICE_WS_URL: v });
      if (served) expect(connect, v).toContain(originOf(served));
    }
  });
});

describe("outside production (next dev) a local ws:// is served and allowed", () => {
  it("ws://localhost:8787 is served and its origin is in connect-src", async () => {
    const { connect, served } = await serve({ NODE_ENV: "development", PRICE_WS_URL: "ws://localhost:8787" });
    expect(served).toBe("ws://localhost:8787");
    expect(connect).toContain("ws://localhost:8787");
  });
});
