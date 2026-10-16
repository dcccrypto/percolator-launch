/**
 * SOL-3 / S-2 (v2.2 QA 2026-10-11): the CSP frame-src must allow Solflare's connect iframe
 * (https://connect.solflare.com). Nothing else in the policy changes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@upstash/redis", () => ({
  Redis: vi.fn(function (this: object) {
    return this;
  }),
}));

type Mw = (req: NextRequest) => Promise<Response>;
let middleware: Mw;
beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("PLAYGROUND_GATE_ENABLED", "false");
  middleware = (await import("@/middleware")).middleware as Mw;
});

const directive = (csp: string, name: string) =>
  csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `))?.split(/\s+/).slice(1) ?? [];

describe("CSP frame-src", () => {
  it("allows connect.solflare.com alongside the existing origins", async () => {
    const r = await middleware(new NextRequest("https://play.percolator.trade/markets", { headers: { "x-forwarded-for": "10.9.9.9" } }));
    const csp = r.headers.get("Content-Security-Policy") ?? "";
    const frame = directive(csp, "frame-src");
    expect(frame).toContain("https://connect.solflare.com");
    expect(frame).toEqual([
      "'self'", "https://privy.percolator.trade", "https://auth.privy.io", "https://embedded-wallets.privy.io", "https://*.privy.systems",
      "https://phantom.app", "https://solflare.com", "https://connect.solflare.com", "https://verify.walletconnect.com",
      "https://verify.walletconnect.org", "https://challenges.cloudflare.com",
    ]);
  });
  it("NEGATIVE CONTROL: no wildcard Solflare or *.vercel.app origin was added", async () => {
    const r = await middleware(new NextRequest("https://play.percolator.trade/markets", { headers: { "x-forwarded-for": "10.9.9.8" } }));
    const frame = directive(r.headers.get("Content-Security-Policy") ?? "", "frame-src");
    expect(frame.some((o) => o.includes("*.solflare.com") || o.includes("vercel.app"))).toBe(false);
  });
});
