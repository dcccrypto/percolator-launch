/**
 * POST /api/oracle/set-price-cap — auth and input validation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mockSendAndConfirm = vi.hoisted(() => vi.fn());

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ programId: "FxfD37s1NC7CDPMPzqgSfLsiJxjYRjfQDsV1CRuW9dBH", rpcUrl: "https://api.devnet.solana.com" }),
}));

vi.mock("@solana/web3.js", () => {
  const pk = { toBase58: () => "11111111111111111111111111111111" };
  return {
    Connection: vi.fn().mockImplementation(() => ({})),
    Keypair: {
      fromSecretKey: vi.fn(() => ({ publicKey: pk })),
    },
    PublicKey: vi.fn().mockImplementation((addr: string) => ({
      toBase58: () => addr,
    })),
    Transaction: vi.fn().mockImplementation(function (this: { add: ReturnType<typeof vi.fn> }) {
      this.add = vi.fn().mockReturnValue(this);
      return this;
    }),
    ComputeBudgetProgram: {
      setComputeUnitPrice: vi.fn().mockReturnValue({}),
      setComputeUnitLimit: vi.fn().mockReturnValue({}),
    },
    sendAndConfirmTransaction: mockSendAndConfirm,
  };
});

vi.mock("@percolatorct/sdk", () => ({
  encodeSetOraclePriceCap: vi.fn().mockReturnValue(Buffer.from([1])),
  buildIx: vi.fn().mockReturnValue({ type: "ix" }),
  buildAccountMetas: vi.fn().mockReturnValue([]),
  ACCOUNTS_SET_ORACLE_PRICE_CAP: [],
}));

import { POST } from "@/app/api/oracle/set-price-cap/route";

const FAKE_KEYPAIR_JSON = JSON.stringify(Array.from({ length: 64 }, (_, i) => i));

function post(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("http://localhost/api/oracle/set-price-cap", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_API_SECRET = "test-admin-secret";
  process.env.CRANK_KEYPAIR = FAKE_KEYPAIR_JSON;
  mockSendAndConfirm.mockResolvedValue("sig_ok");
});

afterEach(() => {
  delete process.env.ADMIN_API_SECRET;
  delete process.env.CRANK_KEYPAIR;
  delete process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
});

describe("POST /api/oracle/set-price-cap", () => {
  it("returns 401 when ADMIN_API_SECRET is unset (empty header must not pass)", async () => {
    delete process.env.ADMIN_API_SECRET;
    const req = post({}, {});
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when ADMIN_API_SECRET is whitespace-only", async () => {
    process.env.ADMIN_API_SECRET = "   \n\t  ";
    const req = post({}, { "x-admin-secret": "test-admin-secret" });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when x-admin-secret is missing", async () => {
    const req = post({}, {});
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when x-admin-secret is wrong", async () => {
    const req = post({}, { "x-admin-secret": "wrong" });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 for non-integer maxChangeE2bps", async () => {
    const req = post(
      { slabAddress: "7G3SsnevWwUWjWAwGGmr2N11x8KAGn1abzjV3bBbZkAM", maxChangeE2bps: 1.5 },
      { "x-admin-secret": "test-admin-secret" },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toMatch(/maxChangeE2bps/i);
    expect(mockSendAndConfirm).not.toHaveBeenCalled();
  });
});
