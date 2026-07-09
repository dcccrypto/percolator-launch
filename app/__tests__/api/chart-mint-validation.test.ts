/**
 * Tests for /api/chart/[mint] input validation + graceful fallback.
 *
 * The route now fetches OHLCV directly from GeckoTerminal (the old percolator-api
 * proxy is dead/deprecated), so these tests:
 *   1. Validate the mint path segment decodes to a real Solana PublicKey before any
 *      network call (regression for GH issue #942).
 *   2. Confirm a valid mint with no resolvable pool degrades gracefully to
 *      { candles: [], poolAddress: null } (200) so the client's oracle-price
 *      fallback still renders.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../../app/api/chart/[mint]/route";

function makeReq(mint: string): NextRequest {
  return new NextRequest(`http://localhost/api/chart/${mint}?timeframe=hour&aggregate=1&limit=24`);
}

async function callRoute(mint: string) {
  const req = makeReq(mint);
  const params = Promise.resolve({ mint });
  return GET(req, { params });
}

describe("GET /api/chart/[mint] — input validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No pool → route resolves nothing and returns empty candles gracefully.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: {}, included: [] }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 for an empty mint (no network call)", async () => {
    const res = await callRoute("");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid mint/i);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-base58 string (no network call)", async () => {
    const res = await callRoute("not-a-pubkey!!");
    expect(res.status).toBe(400);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("returns 400 for a base58-alphabet string that is not a valid pubkey", async () => {
    const res = await callRoute("1111111111111111111111111111111"); // 31 chars — too short
    expect(res.status).toBe(400);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("accepts a valid Solana pubkey and returns a candles payload", async () => {
    const res = await callRoute("11111111111111111111111111111111"); // system program
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("candles");
    expect(Array.isArray(body.candles)).toBe(true);
  });

  it("degrades gracefully to empty candles when no pool resolves", async () => {
    const res = await callRoute("So11111111111111111111111111111111111111112"); // wSOL
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candles).toEqual([]);
    expect(body.poolAddress).toBeNull();
  });
});
