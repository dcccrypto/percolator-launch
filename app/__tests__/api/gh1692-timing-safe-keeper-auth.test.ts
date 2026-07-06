/**
 * GH#1692 / LAUNCH-16: Timing-safe HMAC auth in oracle-keeper/register.
 *
 * GH#1692 originally hardened this route's auth check (raw shared-secret header) to use
 * a timing-safe comparison instead of plain string equality. LAUNCH-16 went further and
 * replaced the raw-secret header entirely with HMAC-SHA256(secret, "<timestamp>.<rawBody>")
 * request signing (app/lib/keeper-hmac.ts) — the shared secret itself never appears on
 * the wire, and the comparison of the derived signature is still timing-safe.
 *
 * This file verifies:
 * 1. Requests with no signature headers are rejected with 401
 * 2. A signature computed with the wrong secret is rejected with 401
 * 3. A signature computed over a different body (tamper detection) is rejected with 401
 * 4. A stale (expired) signature is rejected with 401
 * 5. Config-not-set / whitespace-only-secret still short-circuit to 503
 * 6. A validly-signed request passes auth (proceeds to body validation)
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";

// ── Mock dependencies before importing route ──────────────────────────────────

vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => ({
    from: () => ({
      update: () => ({
        eq: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: null, error: { code: "PGRST116" } }),
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("@solana/web3.js", () => ({
  PublicKey: class {
    constructor(s: string) {
      if (s.length < 32) throw new Error("Invalid pubkey");
    }
  },
}));

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("GH#1692/LAUNCH-16: oracle-keeper/register HMAC auth", () => {
  const CORRECT_SECRET = "super-secret-register-key-12345";
  const RAW_BODY = JSON.stringify({
    slabAddress: "11111111111111111111111111111111",
    mainnetCA: "22222222222222222222222222222222",
  });

  function sign(secret: string, rawBody: string, timestamp = Date.now().toString()) {
    const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
    return { timestamp, signature };
  }

  beforeEach(() => {
    vi.resetModules();
    process.env.KEEPER_REGISTER_SECRET = CORRECT_SECRET;
    process.env.KEEPER_INTERNAL_URL = "http://localhost:8081";
  });

  afterEach(() => {
    delete process.env.KEEPER_REGISTER_SECRET;
    delete process.env.KEEPER_INTERNAL_URL;
  });

  function makeRequest(opts: { timestamp?: string; signature?: string; rawBody?: string }): NextRequest {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.timestamp) headers["x-keeper-timestamp"] = opts.timestamp;
    if (opts.signature) headers["x-keeper-signature"] = opts.signature;
    return new NextRequest("http://localhost/api/oracle-keeper/register", {
      method: "POST",
      headers,
      body: opts.rawBody ?? RAW_BODY,
    });
  }

  it("rejects a request with no signature headers", async () => {
    const { POST } = await import("@/app/api/oracle-keeper/register/route");
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects a signature computed with the wrong secret", async () => {
    const { POST } = await import("@/app/api/oracle-keeper/register/route");
    const { timestamp, signature } = sign("wrong-secret", RAW_BODY);
    const res = await POST(makeRequest({ timestamp, signature }));
    expect(res.status).toBe(401);
  });

  it("rejects a signature computed over a different body (no short-circuit / tamper detection)", async () => {
    const { POST } = await import("@/app/api/oracle-keeper/register/route");
    const otherBody = JSON.stringify({
      slabAddress: "11111111111111111111111111111111",
      mainnetCA: "33333333333333333333333333333333",
    });
    const { timestamp, signature } = sign(CORRECT_SECRET, otherBody);
    // Signature was computed over `otherBody`, but the actual request carries RAW_BODY.
    const res = await POST(makeRequest({ timestamp, signature, rawBody: RAW_BODY }));
    expect(res.status).toBe(401);
  });

  it("rejects a stale (expired) signature", async () => {
    const { POST } = await import("@/app/api/oracle-keeper/register/route");
    const staleTimestamp = (Date.now() - 10 * 60_000).toString(); // 10 minutes old
    const { signature } = sign(CORRECT_SECRET, RAW_BODY, staleTimestamp);
    const res = await POST(makeRequest({ timestamp: staleTimestamp, signature }));
    expect(res.status).toBe(401);
  });

  it("rejects when KEEPER_REGISTER_SECRET not configured", async () => {
    delete process.env.KEEPER_REGISTER_SECRET;
    vi.resetModules();
    process.env.KEEPER_INTERNAL_URL = "http://localhost:8081";
    const { POST } = await import("@/app/api/oracle-keeper/register/route");
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(503);
  });

  it("rejects when KEEPER_REGISTER_SECRET is whitespace-only (treated as unset)", async () => {
    process.env.KEEPER_REGISTER_SECRET = "  \t\n  ";
    vi.resetModules();
    process.env.KEEPER_INTERNAL_URL = "http://localhost:8081";
    const { POST } = await import("@/app/api/oracle-keeper/register/route");
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(503);
  });

  it("passes auth with a valid signature (proceeds to body validation)", async () => {
    const { POST } = await import("@/app/api/oracle-keeper/register/route");
    const badBody = JSON.stringify({ slabAddress: "not-a-pubkey", mainnetCA: "also-not-a-pubkey" });
    const { timestamp, signature } = sign(CORRECT_SECRET, badBody);
    const res = await POST(makeRequest({ timestamp, signature, rawBody: badBody }));
    // Should pass auth and fail on pubkey validation, not on auth
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(503);
  });
});
