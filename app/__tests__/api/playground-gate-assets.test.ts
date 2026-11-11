// @vitest-environment node
/**
 * Logged-in asset behaviour behind the gate:
 *  - Next's image optimiser fetches its source without the user's cookie, so a local src that goes
 *    through it would be redirected by the gate and 400. Local images must be `unoptimized`.
 *  - /charting_library/ files keep the CSP from next.config.ts (middleware must not replace it).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { mintSession } from "@/lib/playground-access";

vi.mock("@upstash/redis", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Redis: vi.fn(function (this: any) {
    return this;
  }),
}));

const APP = path.resolve(__dirname, "../..");
const SECRET = "k".repeat(48);

describe("local next/image sources bypass the optimiser", () => {
  const files = execFileSync("git", ["grep", "-l", "from \"next/image\"", "--", "*.tsx"], { cwd: APP, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

  it("finds the next/image users", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s: every <Image> with a local (\"/...\") literal src is unoptimized", (f) => {
    const src = readFileSync(path.join(APP, f), "utf8");
    const tags = src.match(/<Image\b[\s\S]*?\/>/g) ?? [];
    for (const tag of tags) {
      if (/\bsrc=["']\//.test(tag)) expect(tag, `${f}: ${tag.slice(0, 80)}`).toMatch(/\bunoptimized\b/);
    }
  });
});

describe("/charting_library/ CSP", () => {
  let middleware: (r: NextRequest) => Promise<Response>;
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("PLAYGROUND_ACCESS_SECRET", SECRET);
    vi.stubEnv("PLAYGROUND_GATE_ENABLED", "true");
    middleware = (await import("@/middleware")).middleware as typeof middleware;
  });
  afterEach(() => vi.unstubAllEnvs());

  const get = (p: string, cookie?: string) =>
    middleware(new NextRequest(`https://x.test${p}`, { headers: cookie ? { cookie: `pg_access=${cookie}` } : {} }));

  it("logged-out chart library files stay gated", async () => {
    const r = await get("/charting_library/sameorigin.html");
    expect(r.status).toBe(307);
  });

  it("logged-in: middleware leaves the CSP to next.config (still adds the other security headers)", async () => {
    const cookie = await mintSession("row", 5, SECRET);
    const r = await get("/charting_library/sameorigin.html", cookie);
    expect(r.headers.get("x-middleware-next")).toBe("1");
    expect(r.headers.get("content-security-policy")).toBeNull();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("other pages still get the app CSP", async () => {
    const cookie = await mintSession("row", 5, SECRET);
    const r = await get("/trade/abc", cookie);
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("next.config.ts attaches the stricter frame CSP to that folder", () => {
    const cfg = readFileSync(path.join(APP, "next.config.ts"), "utf8");
    expect(cfg).toMatch(/source: "\/charting_library\/:path\*",\s*headers: \[\s*\{ key: "Content-Security-Policy", value: TV_FRAME_CSP \}/);
  });
});
