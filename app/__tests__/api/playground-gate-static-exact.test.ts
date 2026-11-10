// @vitest-environment node
/**
 * Council r5 #6: static-asset exemptions match EXACT paths only.
 * `/favicon.ico/x` used to skip middleware entirely (unanchored matcher alternative) and render
 * the app shell on a 404 without the access cookie. Runs the REAL matcher regex + middleware.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { mintSession } from "@/lib/playground-access";

vi.mock("@upstash/redis", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Redis: vi.fn(function (this: any) {
    return this;
  }),
}));

const SECRET = "s".repeat(40);
type Mw = (req: NextRequest) => Promise<Response>;
let middleware: Mw;
let matcherSources: string[];

/** Next compiles each matcher to ^source(?:/)?$ against the raw pathname. */
function matcherRuns(p: string): boolean {
  return matcherSources.some((m) => new RegExp(`^${m}(?:/)?$`).test(p));
}

/** What the edge does: skip middleware if the matcher misses (= served ungated), else run it. */
async function edge(p: string, cookie?: string): Promise<"skipped" | "pass" | "locked"> {
  if (!matcherRuns(p)) return "skipped";
  const headers: Record<string, string> = { "x-forwarded-for": `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (cookie) headers.cookie = `pg_access=${cookie}`;
  const r = await middleware(new NextRequest(`https://play.percolator.trade${p}`, { headers }));
  if (r.status === 307 && new URL(r.headers.get("location")!).pathname === "/locked") return "locked";
  return r.headers.get("x-middleware-next") === "1" ? "pass" : "locked";
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("PLAYGROUND_ACCESS_SECRET", SECRET);
  vi.stubEnv("PLAYGROUND_GATE_ENABLED", "true");
  const mod = await import("@/middleware");
  middleware = mod.middleware as Mw;
  matcherSources = mod.config.matcher as string[];
});
afterEach(() => vi.unstubAllEnvs());

const ABUSE = [
  "/favicon.ico/x",
  "/favicon.ico/",
  "/favicon.icox",
  "/favicon.ico%2Fx",
  "/favicon.ico%2fx",
  "/favicon.ico/../trade",
  "/faviconXico",
  "/robots.txt/x",
  "/robots.txt/",
  "/robots.txtx",
  "/robots.txt%2Fx",
  "/sitemap.xml/x",
  "/manifest.webmanifest/x",
  "/icon.png/x",
  "/opengraph-image/x",
  "/_next/staticx",
  "/_next/static",
  "/_next/image/x",
  "/_next/imagex",
  "/_next/static/../../trade",
  "/_next/static/%2e%2e/trade",
  "/images/../trade",
];

describe("exact static paths only (no cookie)", () => {
  it.each(ABUSE)("%s is gated, not served", async (p) => {
    expect(await edge(p)).toBe("locked");
  });

  it.each(["/favicon.ico", "/robots.txt", "/sitemap.xml", "/manifest.webmanifest", "/icon.png", "/_next/static/chunks/a.js", "/_next/image", "/images/a.png"])(
    "legit %s is still served without a cookie",
    async (p) => {
      expect(await edge(p)).not.toBe("locked");
    },
  );
});

describe("with a valid session", () => {
  it.each([...ABUSE, "/favicon.ico", "/robots.txt"])("%s does not lock out a cookie holder", async (p) => {
    const cookie = await mintSession("row", 5, SECRET);
    expect(await edge(p, cookie)).not.toBe("locked");
  });
});
