// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const bars = Array.from({ length: 24 }, (_, i) => [1_700_000_000 + i * 3600, 0.003, 0.004 + i * 0.0001, 0.002, 0.0035, 1]);

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

function stubFetch(requireCookie: boolean) {
  const seen: { url: string; cookie: string | null }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const cookie = (init?.headers as Record<string, string> | undefined)?.cookie ?? null;
    seen.push({ url: String(url), cookie });
    if (String(url).includes("/api/markets/")) {
      if (requireCookie && !cookie) return new Response("{}", { status: 401 }); // the waitlist gate
      return Response.json({ market: { dex_pool_address: "POOL1" } });
    }
    return Response.json({ data: { attributes: { ohlcv_list: bars } } });
  }));
  return seen;
}

describe("/api/prices/:slab 24h stats behind the waitlist gate (2026-10-02 regression)", () => {
  it("forwards the visitor's session cookie on the /api/markets self-call → stats present", async () => {
    const seen = stubFetch(true);
    const { GET } = await import("@/app/api/prices/[slab]/route");
    const req = new NextRequest(`https://play.percolator.trade/api/prices/${SLAB}`, { headers: { cookie: "pg_access=SESSION" } });
    const body = await (await GET(req, { params: Promise.resolve({ slab: SLAB }) })).json();
    expect(seen.find((s) => s.url.includes("/api/markets/"))?.cookie).toBe("pg_access=SESSION");
    expect(body.stats?.high24h).toBeTruthy();
    expect(body.stats?.low24h).toBeTruthy();
  });
  it("CONTROL: without the cookie the gate 401s the self-call and stats are null (the live symptom)", async () => {
    stubFetch(true);
    const { GET } = await import("@/app/api/prices/[slab]/route");
    const req = new NextRequest(`https://play.percolator.trade/api/prices/${SLAB}`);
    const body = await (await GET(req, { params: Promise.resolve({ slab: SLAB }) })).json();
    expect(body.stats).toBeNull();
  });
});
