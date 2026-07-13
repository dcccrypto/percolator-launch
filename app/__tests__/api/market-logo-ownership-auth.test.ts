// @vitest-environment node
//
// This route (and the ed25519 verification it performs via tweetnacl) only
// ever runs server-side in production — the default jsdom environment's
// TextEncoder produces a Uint8Array that fails tweetnacl's strict
// `instanceof Uint8Array` check across jsdom's realm, which would make every
// signature silently fail verification (a test-environment artifact, not a
// real bug — Next.js API routes execute in real Node, never jsdom). Forcing
// `node` here mirrors how this route actually runs.

/**
 * POST /api/markets/[slab]/logo — per-market wallet ownership proof.
 *
 * This route used to gate on `requireAuth()` (a server-only `x-api-key` vs
 * INDEXER_API_KEY header) — the browser never held that key, so every real
 * upload from components/create/LogoUpload.tsx 401'd unconditionally, and the
 * key itself was one shared secret with no per-market scoping. It's been
 * replaced with a wallet-signed stateless deployer proof (mirroring
 * app/api/playground/keeper-register/route.ts's H1v2 scheme) checked against
 * the market's LP-portfolio owner (the durable creator marker — marketauth
 * rotates away post-launch, see the route's header comment).
 *
 * Covers:
 *   1. Missing deployer/signature (no admin bypass) → 400
 *   2. Invalid deployer pubkey → 400
 *   3. Invalid signature (not base64 64 bytes) → 400
 *   4. Wrong-key signature (well-formed, doesn't verify) → 401
 *   5. Valid signature but no LP portfolio found for (slab, deployer) → 403
 *   6. Valid signature, a portfolio is found but it's NOT the LP → 403
 *   7. Valid signature + a real LP portfolio → auth passes (hits downstream
 *      503 from the mocked Supabase client, proving auth was NOT what failed)
 *   8. Admin bypass header skips the wallet-proof requirement entirely
 *   9. On-chain RPC failure during the ownership scan → 400
 */

import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config", () => ({
  getConfig: vi.fn(() => ({
    rpcUrl: "https://api.devnet.solana.com",
    programId: "69VUZ7a2BeXBTpRRManLamF5UWTaNR9B1hy5Se3cdXy9",
  })),
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

const mockGetProgramAccounts = vi.fn();
vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    // A plain `function` (not an arrow) — the route calls `new Connection(...)`,
    // and only a real constructor function can be invoked via `new` (an arrow
    // function has no [[Construct]] and throws "is not a constructor").
    // Explicitly returning an object from a constructor makes `new` use that
    // object instead of `this`, which is all this mock needs.
    Connection: vi.fn().mockImplementation(function mockConnection() {
      return { getProgramAccounts: mockGetProgramAccounts };
    }),
  };
});

vi.mock("@/lib/supabase", () => ({
  getServiceClient: vi.fn(() => {
    throw new Error("Storage backend unavailable (mocked)");
  }),
}));

const SLAB = "7RXTVmGcJMDqqTCFu5ADQRyLDvVZBi3r5U5WXzoULHJV";
/** market_group_id offset within a v17 portfolio account. */
const V17_PF_MARKET_OFF = 16;
/** Mutable owner offset within a v17 portfolio account. */
const V17_PF_OWNER_OFF = 116;
const V17_PORTFOLIO_MAGIC = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);

/** Builds a minimal v17-portfolio-shaped account buffer: magic@0,
 *  market_group_id@16, owner@116, and (optionally) an enabled trailing
 *  PortfolioMatcherConfigV16 (the LP discriminator — see lib/lpPortfolio.ts). */
function makePortfolioBuffer(marketGroupId: PublicKey, owner: PublicKey, isLp: boolean): Buffer {
  const PORTFOLIO_MATCHER_CONFIG_LEN = 104;
  const totalLen = 200; // arbitrary, large enough to hold both regions with no overlap
  const buf = Buffer.alloc(totalLen);
  V17_PORTFOLIO_MAGIC.copy(buf, 0);
  marketGroupId.toBuffer().copy(buf, V17_PF_MARKET_OFF);
  owner.toBuffer().copy(buf, V17_PF_OWNER_OFF);
  const matcherConfigOffset = buf.length - PORTFOLIO_MATCHER_CONFIG_LEN;
  buf.writeBigUInt64LE(isLp ? 1n : 0n, matcherConfigOffset + 96);
  return buf;
}

function genKeypair() {
  const kp = nacl.sign.keyPair();
  return { secretKey: kp.secretKey, publicKey: new PublicKey(kp.publicKey) };
}

function signProof(slab: string, secretKey: Uint8Array, minuteOffset = 0): string {
  const unixMinute = Math.floor(Date.now() / 60_000) + minuteOffset;
  // Mirrors markets-deployer-auth.test.ts's approach (Buffer→Uint8Array, not
  // TextEncoder) — avoids a jsdom-environment realm mismatch where tweetnacl's
  // `instanceof Uint8Array` check rejects a TextEncoder-produced array.
  const msg = new Uint8Array(Buffer.from(`market-logo:${slab}:${unixMinute}`, "utf-8"));
  return Buffer.from(nacl.sign.detached(msg, secretKey)).toString("base64");
}

/** Builds a multipart/form-data POST request the route handler can read via
 *  req.formData(). `includeFile` attaches a dummy `logo` File — needed for
 *  tests that assert auth PASSED, since without one the route's own
 *  "No file provided" 400 (checked right after auth) would be
 *  indistinguishable from an auth failure. */
function buildRequest(
  fields: Record<string, string>,
  headers: Record<string, string> = {},
  includeFile = false,
): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (includeFile) {
    form.append("logo", new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" }));
  }
  return new Request(`http://localhost/api/markets/${SLAB}/logo`, {
    method: "POST",
    headers,
    body: form,
  });
}

describe("POST /api/markets/[slab]/logo — wallet ownership auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ADMIN_API_SECRET;
  });
  afterEach(() => {
    delete process.env.ADMIN_API_SECRET;
  });

  it("returns 400 when deployer/signature are both missing", async () => {
    const { POST } = await import("@/app/api/markets/[slab]/logo/route");
    const req = buildRequest({});
    // @ts-expect-error - NextRequest wraps Request
    const res = await POST(req, { params: Promise.resolve({ slab: SLAB }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/deployer|signature/i);
  });

  it("returns 400 for an invalid deployer pubkey", async () => {
    const { POST } = await import("@/app/api/markets/[slab]/logo/route");
    const req = buildRequest({ deployer: "not-a-pubkey", signature: "dGVzdA==" });
    // @ts-expect-error
    const res = await POST(req, { params: Promise.resolve({ slab: SLAB }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/deployer/i);
  });

  it("returns 400 for a malformed signature (not base64 64 bytes)", async () => {
    const kp = genKeypair();
    const { POST } = await import("@/app/api/markets/[slab]/logo/route");
    const req = buildRequest({ deployer: kp.publicKey.toBase58(), signature: "dGVzdA==" });
    // @ts-expect-error
    const res = await POST(req, { params: Promise.resolve({ slab: SLAB }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/signature/i);
  });

  it("returns 401 for a well-formed signature that doesn't verify (wrong key)", async () => {
    const kp = genKeypair();
    const wrongKp = genKeypair();
    const badSig = signProof(SLAB, wrongKp.secretKey);
    const { POST } = await import("@/app/api/markets/[slab]/logo/route");
    const req = buildRequest({ deployer: kp.publicKey.toBase58(), signature: badSig });
    // @ts-expect-error
    const res = await POST(req, { params: Promise.resolve({ slab: SLAB }) });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/signature/i);
  });

  it("returns 403 when the signer owns no portfolio on this market", async () => {
    const kp = genKeypair();
    const sig = signProof(SLAB, kp.secretKey);
    mockGetProgramAccounts.mockResolvedValue([]);
    const { POST } = await import("@/app/api/markets/[slab]/logo/route");
    const req = buildRequest({ deployer: kp.publicKey.toBase58(), signature: sig });
    // @ts-expect-error
    const res = await POST(req, { params: Promise.resolve({ slab: SLAB }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/not the creator/i);
  });

  it("returns 403 when the signer owns a portfolio on this market that is NOT the LP", async () => {
    const kp = genKeypair();
    const sig = signProof(SLAB, kp.secretKey);
    const tradingPortfolio = makePortfolioBuffer(new PublicKey(SLAB), kp.publicKey, false);
    mockGetProgramAccounts.mockResolvedValue([{ pubkey: kp.publicKey, account: { data: tradingPortfolio } }]);
    const { POST } = await import("@/app/api/markets/[slab]/logo/route");
    const req = buildRequest({ deployer: kp.publicKey.toBase58(), signature: sig });
    // @ts-expect-error
    const res = await POST(req, { params: Promise.resolve({ slab: SLAB }) });
    expect(res.status).toBe(403);
  });

  it("passes auth when the signer owns the market's LP portfolio (hits downstream storage-unavailable, not an auth error)", async () => {
    const kp = genKeypair();
    const sig = signProof(SLAB, kp.secretKey);
    const lpPortfolio = makePortfolioBuffer(new PublicKey(SLAB), kp.publicKey, true);
    mockGetProgramAccounts.mockResolvedValue([{ pubkey: kp.publicKey, account: { data: lpPortfolio } }]);
    const { POST } = await import("@/app/api/markets/[slab]/logo/route");
    const req = buildRequest({ deployer: kp.publicKey.toBase58(), signature: sig }, {}, true);
    // @ts-expect-error
    const res = await POST(req, { params: Promise.resolve({ slab: SLAB }) });
    // Auth passed — the mocked getServiceClient() throw surfaces as 503, not 400/401/403.
    expect(res.status).toBe(503);
  });

  it("accepts a signature signed a couple minutes in the past (clock-skew tolerance)", async () => {
    const kp = genKeypair();
    const sig = signProof(SLAB, kp.secretKey, -3);
    const lpPortfolio = makePortfolioBuffer(new PublicKey(SLAB), kp.publicKey, true);
    mockGetProgramAccounts.mockResolvedValue([{ pubkey: kp.publicKey, account: { data: lpPortfolio } }]);
    const { POST } = await import("@/app/api/markets/[slab]/logo/route");
    const req = buildRequest({ deployer: kp.publicKey.toBase58(), signature: sig }, {}, true);
    // @ts-expect-error
    const res = await POST(req, { params: Promise.resolve({ slab: SLAB }) });
    expect(res.status).toBe(503);
  });

  it("admin bypass header skips the wallet-proof requirement entirely", async () => {
    process.env.ADMIN_API_SECRET = "test-admin-secret";
    const { POST } = await import("@/app/api/markets/[slab]/logo/route");
    const req = buildRequest({}, { "x-admin-secret": "test-admin-secret" }, true);
    // @ts-expect-error
    const res = await POST(req, { params: Promise.resolve({ slab: SLAB }) });
    // No deployer/signature at all, yet auth passes — hits the same downstream 503.
    expect(res.status).toBe(503);
    expect(mockGetProgramAccounts).not.toHaveBeenCalled();
  });

  it("returns 400 when the on-chain ownership scan itself fails (RPC error)", async () => {
    const kp = genKeypair();
    const sig = signProof(SLAB, kp.secretKey);
    mockGetProgramAccounts.mockRejectedValue(new Error("mock RPC failure"));
    const { POST } = await import("@/app/api/markets/[slab]/logo/route");
    const req = buildRequest({ deployer: kp.publicKey.toBase58(), signature: sig });
    // @ts-expect-error
    const res = await POST(req, { params: Promise.resolve({ slab: SLAB }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/verify market ownership/i);
  });
});
