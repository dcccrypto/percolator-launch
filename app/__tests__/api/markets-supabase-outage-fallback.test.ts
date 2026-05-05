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
    mockConfig.value = {
      rpcUrl: "https://api.devnet.solana.com",
      network: "devnet",
      programId: "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",
      programsBySlabTier: {
        small: "FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn",
        medium: "g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in",
        large: "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",
      },
    };

    const { GET } = await import("@/app/api/markets/route");
    const res = await GET(makeRequest({ program_id: "g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.markets).toHaveLength(3);
    expect(body.markets.every((m: Record<string, unknown>) => (
      m.program_id === "g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in"
    ))).toBe(true);
    expect(body.markets.map((m: Record<string, unknown>) => m.slab_address)).not.toContain(
      "2t389M7NwJ1FbwKuv1yf8TSGk84FR1itGgxMBkjh5fDs",
    );
  });
});
