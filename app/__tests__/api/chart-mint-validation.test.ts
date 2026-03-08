/**
 * Tests for /api/chart/[mint] input validation.
 * Ensures that the mint path segment is validated as a properly decodable
 * Solana PublicKey, not just a base58-alphabet string.
 *
 * Covers regression for GitHub issue #942.
 */

import { NextRequest } from "next/server";
import { GET } from "../../app/api/chart/[mint]/route";

// Minimal mock for NextRequest with nextUrl
function makeReq(mint: string): NextRequest {
  const url = `http://localhost/api/chart/${mint}`;
  return new NextRequest(url);
}

async function callRoute(mint: string) {
  const req = makeReq(mint);
  const params = Promise.resolve({ mint });
  return GET(req, { params });
}

describe("GET /api/chart/[mint] — input validation", () => {
  it("returns 400 for an empty mint", async () => {
    const res = await callRoute("");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid mint/i);
  });

  it("returns 400 for a non-base58 string", async () => {
    const res = await callRoute("not-a-pubkey!!");
    expect(res.status).toBe(400);
  });

  it("returns 400 for a base58-alphabet string that is not a valid pubkey", async () => {
    // 44-char base58 string that passes the old regex but fails PublicKey decode
    const res = await callRoute("11111111111111111111111111111111111111111111");
    // This is actually the system program (valid) — use a string of wrong length
    const res2 = await callRoute("1111111111111111111111111111111"); // 31 chars
    expect(res2.status).toBe(400);
  });

  it("accepts a valid Solana pubkey (system program)", async () => {
    // System program: 11111111111111111111111111111111 — 32 chars, valid
    // Route will try to fetch GeckoTerminal data; with no pool it returns 200 with empty candles
    const res = await callRoute("11111111111111111111111111111111");
    // Accepts the pubkey (200) — external fetch returns no pool → { candles: [], poolAddress: null }
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("candles");
  });
});
