/**
 * /allocation and /vote (pages and their APIs) exist ONLY on percolator.trade.
 *
 * `main` is built by two Vercel projects: percolator-launch (percolator.trade)
 * and percolator-mainnet (mainnet.percolatorlaunch.com). Every host other than
 * the exact waitlist host must 404 these surfaces, including previews, localhost,
 * lookalikes, and requests that try to borrow the host via forwarding headers.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@upstash/redis", () => ({ Redis: vi.fn() }));
vi.mock("@upstash/ratelimit", () => ({ Ratelimit: vi.fn() }));

type MiddlewareFn = (req: NextRequest) => Promise<Response>;

async function freshMiddleware(): Promise<MiddlewareFn> {
  vi.resetModules();
  const mod = await import("@/middleware");
  return mod.middleware as unknown as MiddlewareFn;
}

// The middleware decides on the Host header. Some hostile Host values are not
// valid URL authorities, so the request URL falls back to a neutral base.
const urlBase = (host: string) => {
  try {
    return new URL(`https://${host}`).origin;
  } catch {
    return "https://request.invalid";
  }
};
const at = (host: string, p: string, extra: Record<string, string> = {}) =>
  new NextRequest(`${host ? urlBase(host) : "https://request.invalid"}${p}`, {
    headers: { host, "x-forwarded-for": "9.9.9.9", ...extra },
  });

const SURFACES = [
  "/allocation",
  "/allocation/",
  "/allocation/anything",
  "/vote",
  "/vote/",
  "/vote/anything",
  "/api/allocation/status",
  "/api/allocation/check",
  "/api/vote/status",
  "/api/vote/challenge",
  "/api/vote/submit",
  "/api/vote/results",
  "/api/vote/log",
  "/api/vote/start",
  "/api/vote/admin/start",
  "/VOTE",
  "/Allocation",
  "/%61llocation",
  "/%76ote",
  "/api/%76ote/status",
];

const OTHER_HOSTS = [
  "mainnet.percolatorlaunch.com",
  "percolator-mainnet.vercel.app",
  "percolator-mainnet-abc-khubair-nasirs-projects.vercel.app",
  "percolator-launch.vercel.app",
  "percolator-launch-git-main-khubair-nasirs-projects.vercel.app",
  "percolator-launch-abc123-khubair-nasirs-projects.vercel.app",
  "play.percolator.trade",
  "app.percolator.trade",
  "localhost",
  "127.0.0.1",
  // lookalikes / substring tricks
  "evilpercolator.trade",
  "percolator.trade.evil.com",
  "percolator.trade-evil.com",
  "xpercolator.trade",
  "percolator.trades",
  "percolator.trade.",
  "percolator.trade:evil",
  "",
];

describe("middleware: allocation/vote surfaces are percolator.trade only", () => {
  let middleware: MiddlewareFn;
  beforeEach(async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    middleware = await freshMiddleware();
  });

  for (const host of OTHER_HOSTS) {
    it.each(SURFACES)(`[${host || "<empty>"}] %s → 404`, async (p) => {
      const res = await middleware(at(host, p));
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
    });
  }

  it.each(SURFACES)(
    "forwarded-host spoofing cannot borrow percolator.trade: mainnet%s → 404",
    async (p) => {
      const res = await middleware(
        at("mainnet.percolatorlaunch.com", p, {
          "x-forwarded-host": "percolator.trade",
          forwarded: "host=percolator.trade",
          "x-original-host": "percolator.trade",
        }),
      );
      expect(res.status).toBe(404);
    },
  );

  it.each([
    "/allocation",
    "/vote",
    "/api/allocation/status",
    "/api/allocation/check",
    "/api/vote/status",
    "/api/vote/challenge",
    "/api/vote/submit",
  ])("percolator.trade%s passes through with noindex", async (p) => {
    const res = await middleware(at("percolator.trade", p));
    expect(res.status).not.toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("percolator.trade with an explicit port is the same host", async () => {
    const res = await middleware(at("percolator.trade:443", "/vote"));
    expect(res.status).not.toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  it("uppercase Host header is normalized", async () => {
    const res = await middleware(at("PERCOLATOR.TRADE", "/allocation"));
    expect(res.status).not.toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  it.each(["/allocationx", "/allocations", "/voter", "/votes", "/vote-now"])(
    "percolator.trade%s is NOT newly allowed (still redirects to /waitlist)",
    async (p) => {
      const res = await middleware(at("percolator.trade", p));
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/waitlist");
    },
  );

  it.each(["/allocations", "/voter", "/votes"])(
    "CONTROL: mainnet%s is not treated as a surface (no middleware 404)",
    async (p) => {
      const res = await middleware(at("mainnet.percolatorlaunch.com", p));
      expect(res.status).not.toBe(404);
    },
  );
});

describe("middleware: existing waitlist and mainnet behavior unchanged", () => {
  let middleware: MiddlewareFn;
  beforeEach(async () => {
    middleware = await freshMiddleware();
  });

  it("percolator.trade/ still rewrites to the waitlist (no redirect)", async () => {
    const res = await middleware(at("percolator.trade", "/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toMatch(/\/waitlist$/);
    expect(res.headers.get("x-robots-tag")).toBeNull();
  });

  it.each(["/waitlist", "/pitch", "/playground", "/r/ABC"])(
    "percolator.trade%s still allowed, no noindex added",
    async (p) => {
      const res = await middleware(at("percolator.trade", p));
      expect(res.headers.get("location")).toBeNull();
      expect(res.status).not.toBe(404);
      expect(res.headers.get("x-robots-tag")).toBeNull();
    },
  );

  it.each(["/markets", "/portfolio", "/faucet", "/dashboard"])(
    "percolator.trade%s still redirects to /waitlist",
    async (p) => {
      const res = await middleware(at("percolator.trade", p));
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/waitlist");
    },
  );

  it("www.percolator.trade canonical redirect is unchanged (path-preserving 301)", async () => {
    const res = await middleware(at("www.percolator.trade", "/vote"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://percolator.trade/vote");
  });

  it("mainnet playground surfaces still 404 and mainnet pages still serve", async () => {
    expect((await middleware(at("mainnet.percolatorlaunch.com", "/playground"))).status).toBe(404);
    expect((await middleware(at("mainnet.percolatorlaunch.com", "/markets"))).status).not.toBe(404);
    expect((await middleware(at("mainnet.percolatorlaunch.com", "/api/markets"))).status).not.toBe(404);
  });
});
