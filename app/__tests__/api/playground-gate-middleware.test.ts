// @vitest-environment node
/**
 * The devnet v2 waitlist lock in middleware.ts (PLAYGROUND_GATE_ENABLED).
 * Runs the REAL middleware function end to end.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { mintSession, teamFingerprint } from "@/lib/playground-access";
import { isExempt } from "@/lib/playground-gate";

vi.mock("@upstash/redis", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Redis: vi.fn(function (this: any) {
    return this;
  }),
}));

const SECRET = "s".repeat(40);
const SLAB = "AzagguvrH6sA8WvSFbYd5vV1zGZSeXP1oKm3uPq5RzYa"; // base58, 44 chars
const TEAM = "t".repeat(40);

type Mw = (req: NextRequest) => Promise<Response>;
let middleware: Mw;

function req(p: string, init: { method?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (init.cookie) headers.cookie = `pg_access=${init.cookie}`;
  return new NextRequest(`https://play.percolator.trade${p}`, { method: init.method ?? "GET", headers });
}

const isPassThrough = (r: Response) => r.headers.get("x-middleware-next") === "1";
const lockedTarget = (r: Response) => (r.headers.get("location") ? new URL(r.headers.get("location")!).pathname : null);

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("PLAYGROUND_ACCESS_SECRET", SECRET);
  vi.stubEnv("PLAYGROUND_TEAM_BYPASS_SECRET", TEAM);
  vi.stubEnv("PLAYGROUND_GATE_ENABLED", "true");
  middleware = (await import("@/middleware")).middleware as Mw;
});
afterEach(() => vi.unstubAllEnvs());

describe("gate ON", () => {
  it.each(["/", "/trade/Azagguvr", "/markets", "/earn", "/portfolio", "/create", "/trade/x.png", "/LOCKED"])(
    "page %s without a cookie → 307 /locked",
    async (p) => {
      const r = await middleware(req(p));
      expect(r.status).toBe(307);
      expect(lockedTarget(r)).toBe("/locked");
    },
  );

  it("page with a valid session passes", async () => {
    const r = await middleware(req("/trade/Azagguvr", { cookie: await mintSession("row", 5, SECRET) }));
    expect(isPassThrough(r)).toBe(true);
  });

  it("team session passes", async () => {
    const cookie = await mintSession(`team:${await teamFingerprint(TEAM)}`, 1, SECRET);
    expect(isPassThrough(await middleware(req("/", { cookie })))).toBe(true);
  });

  it.each([
    ["over-cutoff session", async () => mintSession("row", 1001, SECRET)],
    ["expired session", async () => mintSession("row", 1, SECRET, Date.now() - 25 * 3600_000)],
    ["session signed with another secret", async () => mintSession("row", 1, "z".repeat(40))],
    ["garbage cookie", async () => "abc.def"],
  ])("%s is refused", async (_n, mk) => {
    const r = await middleware(req("/", { cookie: await mk() }));
    expect(lockedTarget(r)).toBe("/locked");
  });

  it("a HANDOFF token used as the cookie is refused", async () => {
    const gate = await import("../fixtures/gate-playground-access.pr2732");
    const r = await middleware(req("/", { cookie: gate.mintHandoff("row", 1, SECRET) }));
    expect(lockedTarget(r)).toBe("/locked");
  });

  it.each(["/api/markets", "/api/rpc", "/api/prices", "/api/playground/faucet", "/api/playground/keeper-register", "/api/x.json"])(
    "browser API %s without a cookie → 401 JSON",
    async (p) => {
      const r = await middleware(req(p, { method: p.includes("faucet") || p.includes("register") ? "POST" : "GET" }));
      expect(r.status).toBe(401);
      expect(r.headers.get("content-type")).toMatch(/application\/json/);
      expect(await r.json()).toEqual({ error: "Playground access required" });
    },
  );

  it("browser API with a cookie passes", async () => {
    const r = await middleware(req("/api/markets", { cookie: await mintSession("row", 5, SECRET) }));
    expect(r.status).not.toBe(401);
    expect(isPassThrough(r)).toBe(true);
  });

  it.each([
    ["GET", "/enter"],
    ["POST", "/enter"],
    ["GET", "/locked"],
    ["GET", "/_next/static/chunks/main.js"],
    ["GET", "/_vercel/insights/script.js"],
    ["GET", "/opengraph-image"],
    ["GET", "/robots.txt"],
    ["GET", "/token-metadata/sim-usdc.json"],
    ["GET", "/chart-empty-state.svg"],
    ["GET", "/api/health"],
    ["HEAD", "/api/health"],
    ["GET", "/api/playground/registered-markets"],
    ["PATCH", `/api/markets/${SLAB}`],
    ["POST", "/api/oracle-keeper/register"],
    ["POST", "/api/oracle/set-price-cap"],
  ])("exempt %s %s passes without a cookie", async (method, p) => {
    const r = await middleware(req(p, { method }));
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(307);
  });

  it("exemptions are method-specific", async () => {
    expect((await middleware(req(`/api/markets/${SLAB}`))).status).toBe(401); // GET is browser data
    expect((await middleware(req("/api/markets/challenge", { method: "PATCH" }))).status).toBe(401);
    expect((await middleware(req("/api/health", { method: "POST" }))).status).toBe(401);
    expect((await middleware(req("/api/oracle/set-price-cap"))).status).toBe(401);
  });

  it("an unset access secret locks everyone out, even with a once-valid cookie", async () => {
    const cookie = await mintSession("row", 1, SECRET);
    vi.stubEnv("PLAYGROUND_ACCESS_SECRET", "");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(lockedTarget(await middleware(req("/", { cookie })))).toBe("/locked");
  });
});

describe("gate OFF (kill switch)", () => {
  it.each(["", "false", "TRUE", "1"])("PLAYGROUND_GATE_ENABLED=%j → passthrough, no lock", async (v) => {
    vi.stubEnv("PLAYGROUND_GATE_ENABLED", v);
    const page = await middleware(req("/trade/Azagguvr"));
    expect(isPassThrough(page)).toBe(true);
    const api = await middleware(req("/api/markets"));
    expect(api.status).not.toBe(401);
    expect(isPassThrough(api)).toBe(true);
  });
});

describe("every API route is classified", () => {
  // The exemption list is a security boundary. A new route must be a conscious
  // decision: gated by default, and this list must change if it is exempt.
  const EXPECTED_EXEMPT = new Set([
    "GET /api/health",
    "GET /api/playground/registered-markets",
    "PATCH /api/markets/[slab]",
    "POST /api/oracle-keeper/register",
    "POST /api/oracle/set-price-cap",
  ]);

  function routes(dir: string, base = "/api"): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir)) {
      const full = path.join(dir, e);
      if (statSync(full).isDirectory()) out.push(...routes(full, `${base}/${e}`));
      else if (e === "route.ts") out.push(base);
    }
    return out;
  }

  it("matches the documented exempt set exactly", () => {
    const all = routes(path.resolve(__dirname, "../../app/api"));
    expect(all.length).toBeGreaterThan(40);
    const exempt: string[] = [];
    for (const r of all) {
      const sample = r.replace(/\[[^\]]+\]/g, SLAB);
      for (const m of ["GET", "POST", "PATCH", "PUT", "DELETE"]) if (isExempt(sample, m)) exempt.push(`${m} ${r}`);
    }
    expect(new Set(exempt)).toEqual(EXPECTED_EXEMPT);
  });
});

describe("middleware matcher (compiled by Next's own getMiddlewareMatchers)", () => {
  // A path the matcher skips never reaches the gate at all, so the matcher is
  // part of the lock. The old `.*\.(png|…)$` skip let /trade/x.png render the
  // [slab] page shell past it.
  async function runs(p: string): Promise<boolean> {
    const { config } = await import("@/middleware");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getMiddlewareMatchers } = require("next/dist/build/analysis/get-page-static-info");
    const ms = getMiddlewareMatchers(config.matcher, {}) as { regexp: string }[];
    return ms.some((m) => new RegExp(m.regexp).test(p));
  }

  it.each(["/", "/trade/abc", "/trade/x.png", "/earn/a/b.svg", "/api/markets", "/locked", "/enter"])("runs on %s", async (p) => {
    expect(await runs(p)).toBe(true);
  });

  it.each(["/_next/static/chunks/a.js", "/_next/image", "/favicon.ico", "/icon.png", "/chart-empty-state.svg", "/images/logo.png", "/icons/chart-empty.svg", "/audio/percolator.mp3", "/token-metadata/sim-usdc.json"])(
    "skips %s",
    async (p) => {
      expect(await runs(p)).toBe(false);
    },
  );
});
