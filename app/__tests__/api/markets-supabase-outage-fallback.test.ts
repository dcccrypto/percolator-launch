/**
 * PERC-8450: GET /api/markets should degrade to the static mainnet directory
 * when Supabase is unreachable, not return a hard 500 that pushes browsers into
 * expensive RPC discovery fallback.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const captureMessage = vi.fn();
const captureException = vi.fn();
const mockConfig = vi.hoisted(() => ({
  value: {
    rpcUrl: "https://api.mainnet-beta.solana.com",
    network: "mainnet",
    programId: "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv",
    programsBySlabTier: undefined as Record<string, string> | undefined,
  },
}));

vi.mock("@sentry/nextjs", () => ({
  captureException,
  captureMessage,
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => mockConfig.value,
}));

vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => mockConfig.value.network,
  getServiceClient: () => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.not = () => chain;
    chain.or = () => Promise.resolve({
      data: null,
      error: { message: "getaddrinfo ENOTFOUND ygvbajglkrwkbjdjyhxi.supabase.co" },
    });
    return { from: () => chain };
  },
}));

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL("http://localhost/api/markets");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const { NextRequest } = require("next/server");
  return new NextRequest(url.toString());
}

describe("GET /api/markets — Supabase outage fallback", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockConfig.value = {
      rpcUrl: "https://api.mainnet-beta.solana.com",
      network: "mainnet",
      programId: "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv",
      programsBySlabTier: undefined,
    };
  });

  it("returns the static mainnet market directory instead of 500", async () => {
    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Percolator-Data-Source")).toBe("static-directory-fallback");
    expect(body.total).toBe(1);
    expect(body.markets).toHaveLength(1);
    expect(body.markets[0].slab_address).toBe("AiVcTXxKfKmcpUBG3unxCdEHHtXvAq8zYpbtS6oPrV6J");
    expect(captureException).toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("static directory fallback"),
      expect.objectContaining({
        tags: expect.objectContaining({ degraded: "true", network: "mainnet" }),
      }),
    );
  });

  it("still applies search filtering to the fallback directory", async () => {
    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ search: "no-such-market" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.total).toBe(0);
    expect(body.markets).toHaveLength(0);
  });

  // The program_id filter, on the mainnet directory (it has an entry; the devnet one is empty).
  it("filters the fallback directory by program_id: a match keeps the entry", async () => {
    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ program_id: "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.markets.map((m: Record<string, unknown>) => m.slab_address)).toEqual(["AiVcTXxKfKmcpUBG3unxCdEHHtXvAq8zYpbtS6oPrV6J"]);
  });

  it("an unknown program_id over a non-empty directory is a real empty result (200), not an outage", async () => {
    // The negative half: without it the filter could be a no-op and the match case would still pass.
    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ program_id: "g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.markets).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  // The devnet directory is empty since the 2026-10-01 relaunch (PLAYGROUND_SLAB_META = {}). An
  // empty 200 read as "No markets yet. Create the first one" on every page during a backend
  // hiccup, CDN-cached for up to 70 s. With nothing to fall back to, the route says so.
  describe("devnet: nothing to fall back to", () => {
    beforeEach(() => {
      mockConfig.value = {
        rpcUrl: "https://api.devnet.solana.com",
        network: "devnet",
        programId: "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB",
        programsBySlabTier: undefined,
      };
    });

    it("503, not cached, same body shape, flagged unavailable", async () => {
      const { GET } = await import("@/app/api/markets/route");
      const res = await GET(makeRequest());
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("X-Percolator-Data-Source")).toBe("unavailable");
      expect(body).toMatchObject({ total: 0, activeTotal: 0, marketsWithPrice: 0, zombieCount: 0, markets: [], unavailable: true });
      expect(captureMessage).toHaveBeenCalledWith(
        expect.stringContaining("no static directory to fall back to"),
        expect.objectContaining({ tags: expect.objectContaining({ degraded: "true", network: "devnet" }) }),
      );
    });

    it("a search does not turn the outage into a \"no match\"", async () => {
      const { GET } = await import("@/app/api/markets/route");
      const res = await GET(makeRequest({ search: "SOL" }));
      expect(res.status).toBe(503);
    });
  });
});
