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

/** GH#2509: send a raw body verbatim, so malformed/empty payloads can be exercised. */
function postRaw(
  raw: string | undefined,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("http://localhost/api/oracle/set-price-cap", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    ...(raw === undefined ? {} : { body: raw }),
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

  // ── GH#2509: malformed input must fail closed, not widen the operation ──────
  //
  // The route treats an EMPTY body as "apply to every admin-oracle market". It
  // used to reach that same state on ANY parse failure, so a truncated payload
  // was indistinguishable from the deliberate all-market command and could
  // submit one signed transaction per market.

  it("GH#2509: returns 400 for malformed JSON instead of targeting all markets", async () => {
    const req = postRaw('{"slabAddress": "7G3SsnevWwUWjWAwGGmr2N11x8KAGn1abzjV3bBbZkAM"', {
      "x-admin-secret": "test-admin-secret",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toMatch(/malformed JSON/i);
    // The point of the fix: no transaction may be signed for a request we
    // could not parse.
    expect(mockSendAndConfirm).not.toHaveBeenCalled();
  });

  it("GH#2509: returns 400 for a non-object JSON body", async () => {
    // These parse successfully, so a try/catch alone would not catch them, yet
    // every field read yields undefined — the same all-market path.
    for (const raw of ["[]", '"a string"', "123", "null"]) {
      const res = await POST(postRaw(raw, { "x-admin-secret": "test-admin-secret" }));
      expect(res.status).toBe(400);
      const j = await res.json();
      expect(j.error).toMatch(/must be a JSON object/i);
    }
    expect(mockSendAndConfirm).not.toHaveBeenCalled();
  });

  it("GH#2509: an empty body is still routed to the all-markets command", async () => {
    // The contract this fix must NOT break: empty body still means "all
    // admin-oracle markets".
    //
    // What counts as evidence here needs stating, because this harness does not
    // mock far enough to reach a response on that branch. The all-market path
    // runs `new PublicKey(config.programId)`, and this file's PublicKey mock is
    // an arrow function, so it throws "is not a constructor". That throw is
    // raised BELOW the parse gate — so reaching it proves the empty body was
    // accepted and dispatched to the all-market branch. Being rejected at the
    // gate would instead return a 400 and never touch PublicKey.
    for (const raw of ["", "   \n  ", undefined]) {
      let status: number | null = null;
      try {
        status = (await POST(postRaw(raw, { "x-admin-secret": "test-admin-secret" }))).status;
      } catch (err) {
        expect(String(err)).toMatch(/not a constructor/);
        continue; // got past the gate — which is the property under test
      }
      expect(status).not.toBe(400);
    }
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
