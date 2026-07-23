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

  it("filters the static devnet directory by program_id", async () => {
    // The devnet fallback is a single v17 wrapper program. It has been
    // re-migrated over time (per-slab-tier → 69VUZ7a2… → the current fee-split
    // wrapper DhSkE7uTb8…), which is exactly why this asserts the filter's
    // BEHAVIOUR against getConfig().programId rather than a hardcoded id/count.
    //
    // Asserts the filter's behaviour rather than a hardcoded count, so editing
    // the directory doesn't break this again.
    const V17_DEVNET_PROGRAM = "DhSkE7uTb8HBUYYWF1xkxMYBGtLYJEoDq1tfBD7SnHcj";

    mockConfig.value = {
      rpcUrl: "https://api.devnet.solana.com",
      network: "devnet",
      programId: V17_DEVNET_PROGRAM,
      programsBySlabTier: undefined,
    };

    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ program_id: V17_DEVNET_PROGRAM }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.markets.length).toBeGreaterThan(0);
    expect(body.total).toBe(body.markets.length);
    expect(
      body.markets.every(
        (m: Record<string, unknown>) => m.program_id === V17_DEVNET_PROGRAM,
      ),
    ).toBe(true);
  });

  it("returns nothing when filtering the devnet directory by an unknown program_id", async () => {
    // The negative half — without this, the filter could be a no-op that
    // returns everything and the assertion above would still pass.
    mockConfig.value = {
      rpcUrl: "https://api.devnet.solana.com",
      network: "devnet",
      programId: "DhSkE7uTb8HBUYYWF1xkxMYBGtLYJEoDq1tfBD7SnHcj",
      programsBySlabTier: undefined,
    };

    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(
      makeRequest({ program_id: "g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.markets).toHaveLength(0);
    expect(body.total).toBe(0);
  });
});
