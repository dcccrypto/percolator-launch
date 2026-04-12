/**
 * Tests for POST /api/oracle/advance-phase
 *
 * PERC-799 changes:
 * - GH#1124: 60 req/IP/min rate limit
 * - GH#1125: CRANK_KEYPAIR only — DEVNET_MINT_AUTHORITY_KEYPAIR fallback removed
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// --- Hoisted mock references ---

const { mockSendAndConfirm, mockFromSecretKey, mockCheckRateLimit } = vi.hoisted(() => ({
  mockSendAndConfirm: vi.fn(),
  mockFromSecretKey: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

// --- Mocks ---

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ rpcUrl: "https://api.devnet.solana.com" }),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

vi.mock("@/lib/advance-phase-rate-limit", () => ({
  checkAdvancePhaseRateLimit: mockCheckRateLimit,
  ADVANCE_PHASE_RATE_LIMIT: 60,
}));

vi.mock("@solana/web3.js", () => {
  const fakePublicKey = {
    toBase58: () => "11111111111111111111111111111111",
    toString: () => "11111111111111111111111111111111",
  };
  return {
    Connection: vi.fn().mockImplementation(function () { return {}; }),
    Keypair: {
      fromSecretKey: mockFromSecretKey.mockReturnValue({ publicKey: fakePublicKey }),
    },
    PublicKey: vi.fn().mockImplementation(function (addr: string) {
      return { toBase58: () => addr, toString: () => addr };
    }),
    Transaction: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
      this.feePayer = null;
      this.add = function () { return this; };
      return this;
    }),
    ComputeBudgetProgram: {
      setComputeUnitLimit: vi.fn().mockReturnValue({ type: "cu_limit" }),
    },
    sendAndConfirmTransaction: mockSendAndConfirm,
  };
});

vi.mock("@percolatorct/sdk", () => ({
  encodeAdvanceOraclePhase: vi.fn().mockReturnValue(Buffer.from([56])),
  buildIx: vi.fn().mockReturnValue({ type: "ix" }),
  buildAccountMetas: vi.fn().mockReturnValue([]),
  ACCOUNTS_ADVANCE_ORACLE_PHASE: [],
}));

import { POST } from "@/app/api/oracle/advance-phase/route";

// --- Helpers ---

const VALID_SLAB = "7G3SsnevWwUWjWAwGGmr2N11x8KAGn1abzjV3bBbZkAM";
const FAKE_KEYPAIR_JSON = JSON.stringify(Array.from({ length: 64 }, (_, i) => i));
const FAKE_PUBKEY = {
  toBase58: () => "11111111111111111111111111111111",
  toString: () => "11111111111111111111111111111111",
};

function makeRequest(body: unknown, ip = "1.2.3.4"): NextRequest {
  return new NextRequest("http://localhost/api/oracle/advance-phase", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

const RL_ALLOWED = { allowed: true, remaining: 59, retryAfterSecs: 60 };
const RL_BLOCKED = { allowed: false, remaining: 0, retryAfterSecs: 42 };

beforeEach(() => {
  vi.clearAllMocks();
  mockSendAndConfirm.mockResolvedValue("sig_default_ok");
  mockFromSecretKey.mockReturnValue({ publicKey: FAKE_PUBKEY });
  mockCheckRateLimit.mockResolvedValue(RL_ALLOWED);

  process.env.NEXT_PUBLIC_SOLANA_NETWORK = "devnet";
  process.env.CRANK_KEYPAIR = FAKE_KEYPAIR_JSON;
  process.env.NEXT_PUBLIC_PROGRAM_ID = "FxfD37s1NC7CDPMPzqgSfLsiJxjYRjfQDsV1CRuW9dBH";
});

afterEach(() => {
  process.env.NEXT_PUBLIC_SOLANA_NETWORK = "devnet";
  process.env.CRANK_KEYPAIR = FAKE_KEYPAIR_JSON;
  delete process.env.DEVNET_MINT_AUTHORITY_KEYPAIR;
  delete process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
});

// --- Tests ---

describe("POST /api/oracle/advance-phase", () => {
  // ── Validation ────────────────────────────────────────────────────────

  it("returns 400 for missing slabAddress", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/slabAddress/);
  });

  it("returns 400 for invalid slabAddress (non-base58 chars)", async () => {
    const res = await POST(makeRequest({ slabAddress: "not-valid!!!" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid slabAddress (too short)", async () => {
    const res = await POST(makeRequest({ slabAddress: "abc" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for malformed JSON body", async () => {
    const req = new NextRequest("http://localhost/api/oracle/advance-phase", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "1.2.3.4" },
      body: "{ bad json {{",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  // ── Network guard ─────────────────────────────────────────────────────

  it("returns skipped:true on mainnet (rate limiter not called)", async () => {
    delete process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
    process.env.NEXT_PUBLIC_SOLANA_NETWORK = "mainnet";
    const res = await POST(makeRequest({ slabAddress: VALID_SLAB }));
    const json = await res.json();
    expect(json.skipped).toBe(true);
    expect(json.reason).toBe("not devnet");
    // Rate limit check should not fire for no-op network guard
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it("prefers NEXT_PUBLIC_DEFAULT_NETWORK over NEXT_PUBLIC_SOLANA_NETWORK", async () => {
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "mainnet";
    process.env.NEXT_PUBLIC_SOLANA_NETWORK = "devnet";
    const res = await POST(makeRequest({ slabAddress: VALID_SLAB }));
    const json = await res.json();
    expect(json.skipped).toBe(true);
    expect(json.reason).toBe("not devnet");
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it("uses NEXT_PUBLIC_DEFAULT_NETWORK=devnet when NEXT_PUBLIC_SOLANA_NETWORK is unset", async () => {
    delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
    mockSendAndConfirm.mockResolvedValue("sig_default_network");
    const res = await POST(makeRequest({ slabAddress: VALID_SLAB }));
    const json = await res.json();
    expect(mockCheckRateLimit).toHaveBeenCalled();
    expect(json.success).toBe(true);
    expect(json.signature).toBe("sig_default_network");
  });

  // ── GH#1124: Rate limiting ─────────────────────────────────────────────

  it("returns 429 when rate limit exceeded", async () => {
    mockCheckRateLimit.mockResolvedValue(RL_BLOCKED);
    const res = await POST(makeRequest({ slabAddress: VALID_SLAB }));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toMatch(/rate limit/i);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("calls checkAdvancePhaseRateLimit with the client IP", async () => {
    mockSendAndConfirm.mockResolvedValue("sig_ok");
    await POST(makeRequest({ slabAddress: VALID_SLAB }, "10.0.0.1"));
    expect(mockCheckRateLimit).toHaveBeenCalledWith("10.0.0.1");
  });

  it("does not call sendAndConfirm when rate limited", async () => {
    mockCheckRateLimit.mockResolvedValue(RL_BLOCKED);
    await POST(makeRequest({ slabAddress: VALID_SLAB }));
    expect(mockSendAndConfirm).not.toHaveBeenCalled();
  });

  // ── GH#1125: CRANK_KEYPAIR required, no fallback ──────────────────────

  it("returns skipped:true when CRANK_KEYPAIR is not set", async () => {
    delete process.env.CRANK_KEYPAIR;
    delete process.env.DEVNET_MINT_AUTHORITY_KEYPAIR;
    const res = await POST(makeRequest({ slabAddress: VALID_SLAB }));
    const json = await res.json();
    expect(json.skipped).toBe(true);
    expect(json.reason).toMatch(/no crank keypair/);
  });

  it("does NOT fall back to DEVNET_MINT_AUTHORITY_KEYPAIR when CRANK_KEYPAIR unset", async () => {
    // GH#1125: mint authority key must not be used as crank key
    delete process.env.CRANK_KEYPAIR;
    process.env.DEVNET_MINT_AUTHORITY_KEYPAIR = FAKE_KEYPAIR_JSON;
    const res = await POST(makeRequest({ slabAddress: VALID_SLAB }));
    const json = await res.json();
    // Should skip, not attempt to send a transaction
    expect(json.skipped).toBe(true);
    expect(mockSendAndConfirm).not.toHaveBeenCalled();
  });

  // ── Happy path ────────────────────────────────────────────────────────

  it("calls sendAndConfirmTransaction and returns success:true with signature", async () => {
    mockSendAndConfirm.mockResolvedValue("sig_advance_123");
    const res = await POST(makeRequest({ slabAddress: VALID_SLAB }));
    const json = await res.json();
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1);
    expect(json.success).toBe(true);
    expect(json.signature).toBe("sig_advance_123");
  });

  // ── Error handling ────────────────────────────────────────────────────

  it("returns skipped (non-error) when program returns expected on-chain error", async () => {
    mockSendAndConfirm.mockRejectedValue(
      new Error("Transaction simulation failed: custom program error: 0x64"),
    );
    const res = await POST(makeRequest({ slabAddress: VALID_SLAB }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.skipped).toBe(true);
  });
});
