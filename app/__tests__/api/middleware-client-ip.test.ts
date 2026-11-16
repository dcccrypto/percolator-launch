/**
 * Client-IP resolution in middleware.ts (rate limiter + IP blocklist).
 * Same flaw as launch #3853 (lib/get-client-ip.ts) and indexer #291: when the
 * X-Forwarded-For chain is shorter than TRUSTED_PROXY_DEPTH, the old
 * Math.max(0, len - depth) clamped to hop 0, which the caller wrote.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

type MiddlewareFn = (req: NextRequest) => Promise<Response>;

function req(xff: string | null, extra: Record<string, string> = {}): NextRequest {
  const headers: Record<string, string> = { ...extra };
  if (xff !== null) headers["x-forwarded-for"] = xff;
  return new NextRequest("http://localhost/api/markets", { headers });
}

async function load(env: Record<string, string | undefined>): Promise<MiddlewareFn> {
  vi.resetModules();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.IP_BLOCKLIST;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = await import("@/middleware");
  return mod.middleware as unknown as MiddlewareFn;
}

/** Fire n requests, return how many got 429. */
async function count429(mw: MiddlewareFn, n: number, xff: (i: number) => string | null, extra = {}) {
  let blocked = 0;
  for (let i = 0; i < n; i++) {
    const res = await mw(req(xff(i), extra));
    if (res.status === 429) blocked++;
  }
  return blocked;
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("middleware rate limiter — client IP resolution", () => {
  it("short chain rotating hop 0 shares one bucket (depth 2)", async () => {
    const mw = await load({ TRUSTED_PROXY_DEPTH: "2" });
    const blocked = await count429(mw, 130, (i) => `10.0.${Math.floor(i / 250)}.${i % 250}`);
    expect(blocked).toBeGreaterThan(0);
  });

  it("empty/missing XFF shares one bucket", async () => {
    const mw = await load({ TRUSTED_PROXY_DEPTH: "1" });
    expect(await count429(mw, 130, () => null)).toBeGreaterThan(0);
  });

  it("depth 0 ignores XFF entirely (one shared bucket)", async () => {
    const mw = await load({ TRUSTED_PROXY_DEPTH: "0" });
    expect(await count429(mw, 130, (i) => `10.1.0.${i + 1}`)).toBeGreaterThan(0);
  });

  it("non-IP trusted hop falls to the shared bucket", async () => {
    const mw = await load({ TRUSTED_PROXY_DEPTH: "1" });
    expect(await count429(mw, 130, (i) => `garbage-${i}`)).toBeGreaterThan(0);
  });

  it("x-real-ip is never read", async () => {
    const mw = await load({ TRUSTED_PROXY_DEPTH: "2" });
    let i = 0;
    let blocked = 0;
    for (; i < 130; i++) {
      const res = await mw(req(`10.2.0.${i + 1}`, { "x-real-ip": `10.3.0.${i + 1}` }));
      if (res.status === 429) blocked++;
    }
    expect(blocked).toBeGreaterThan(0);
  });

  it("correctly sized chain: each client has its own bucket, caller prefix ignored", async () => {
    const mw = await load({ TRUSTED_PROXY_DEPTH: "2" });
    // Spoofed leftmost hop rotates, but the trusted hop (len-2) is constant => one bucket.
    const sameTrusted = await count429(mw, 130, (i) => `6.6.6.${(i % 250) + 1}, 1.1.1.1, 9.9.9.9`);
    expect(sameTrusted).toBeGreaterThan(0);
    // Distinct real clients (trusted hop differs) are never throttled.
    const mw2 = await load({ TRUSTED_PROXY_DEPTH: "2" });
    expect(await count429(mw2, 130, (i) => `20.0.${Math.floor(i / 250)}.${(i % 250) + 1}, 9.9.9.9`)).toBe(0);
  });

  it("depth 1 single-hop chain: distinct IPs get distinct buckets (unchanged)", async () => {
    const mw = await load({ TRUSTED_PROXY_DEPTH: "1" });
    expect(await count429(mw, 130, (i) => `30.0.0.${i + 1}`)).toBe(0);
  });
});

describe("middleware IP blocklist — client IP resolution", () => {
  it("short chain: caller-written hop 0 cannot match the blocklist (no framing)", async () => {
    const mw = await load({ TRUSTED_PROXY_DEPTH: "2", IP_BLOCKLIST: "9.9.9.9" });
    const res = await mw(req("9.9.9.9"));
    expect(res.status).not.toBe(403);
  });

  it("correctly sized chain: blocked IP at the trusted hop is 403", async () => {
    const mw = await load({ TRUSTED_PROXY_DEPTH: "2", IP_BLOCKLIST: "9.9.9.9" });
    // depth 2: client is the second-to-last hop
    expect((await mw(req("9.9.9.9, 8.8.8.8"))).status).toBe(403);
    // blocked address only in the caller-controlled prefix does not match
    expect((await mw(req("9.9.9.9, 1.1.1.1, 8.8.8.8"))).status).not.toBe(403);
  });

  it("depth 1: last hop is the client (unchanged)", async () => {
    const mw = await load({ TRUSTED_PROXY_DEPTH: "1", IP_BLOCKLIST: "9.9.9.9" });
    expect((await mw(req("1.1.1.1, 9.9.9.9"))).status).toBe(403);
  });
});
