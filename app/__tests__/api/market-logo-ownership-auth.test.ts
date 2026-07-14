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
 * This route used to gate on `requireAuth()` (a server-only `x-api-key`) — the
 * browser never held that key, so every real upload 401'd. It was then rewritten
 * to a wallet-signed stateless deployer proof; the FIRST rewrite authorised
 * against the market's on-chain LP portfolio, which is FORGEABLE
 * (SetMatcherConfig(enabled=1) only checks the caller owns their own portfolio,
 * not that they created the market — so any wallet could pass). This suite
 * covers the corrected version, which authorises against the AUTHORITATIVE,
 * non-forgeable `markets.deployer` column (set at creation against the on-chain
 * admin + a signed nonce; never rotated).
 *
 * Covers:
 *   1. Missing deployer/signature (no admin bypass) → 400
 *   2. Invalid deployer pubkey → 400
 *   3. Invalid signature (not base64 64 bytes) → 400
 *   4. Wrong-key signature (well-formed, doesn't verify) → 401
 *   5. Market row not found → 404
 *   6. Valid signature but market has a null deployer (no registered creator) → 403
 *   7. FORGERY: a different wallet with a VALID self-signature, != the registered
 *      deployer → 403 (the exact bypass the LP-portfolio version allowed)
 *   8. Valid signature + deployer === markets.deployer → auth passes (reaches the
 *      downstream "No file provided" 400, proving auth was NOT what failed)
 *   9. Clock-skew tolerance (signed a few minutes ago) with a matching deployer
 *  10. Admin bypass header skips the wallet-proof requirement entirely
 *  11. Storage backend unavailable (getServiceClient throws) → 503
 */

import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

// Controllable Supabase mock. `mockSingle` resolves the markets lookup
// (`{ data: { slab_address, deployer }, error }`); `mockGetServiceClient`
// returns a client exposing exactly the `.from().select().eq().single()` chain
// the route uses, and can be made to throw to exercise the 503 path.
const { mockGetServiceClient, mockSingle } = vi.hoisted(() => {
  const mockSingle = vi.fn();
  const mockGetServiceClient = vi.fn(() => ({
    from: () => ({ select: () => ({ eq: () => ({ single: mockSingle }) }) }),
  }));
  return { mockGetServiceClient, mockSingle };
});
vi.mock("@/lib/supabase", () => ({ getServiceClient: mockGetServiceClient }));

const SLAB = "7RXTVmGcJMDqqTCFu5ADQRyLDvVZBi3r5U5WXzoULHJV";

function genKeypair() {
  const kp = nacl.sign.keyPair();
  return { secretKey: kp.secretKey, publicKey: new PublicKey(kp.publicKey) };
}

/** The wallet recorded as this market's creator in the DB. */
const REGISTERED = genKeypair();

function signProof(slab: string, secretKey: Uint8Array, minuteOffset = 0): string {
  const unixMinute = Math.floor(Date.now() / 60_000) + minuteOffset;
  // Buffer→Uint8Array (not TextEncoder) — avoids a realm mismatch where
  // tweetnacl's `instanceof Uint8Array` check rejects a TextEncoder array.
  const msg = new Uint8Array(Buffer.from(`market-logo:${slab}:${unixMinute}`, "utf-8"));
  return Buffer.from(nacl.sign.detached(msg, secretKey)).toString("base64");
}

/** Builds a multipart/form-data POST request the route reads via req.formData().
 *  `includeFile` attaches a dummy `logo` File — omit it for auth-PASS tests so
 *  the route's own "No file provided" 400 (checked right after auth) cleanly
 *  proves auth passed rather than failed. */
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
  return new Request(`http://localhost/api/markets/${SLAB}/logo`, { method: "POST", headers, body: form });
}

describe("POST /api/markets/[slab]/logo — wallet ownership auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ADMIN_API_SECRET;
    // Default: the market exists and its registered creator is REGISTERED.
    mockGetServiceClient.mockImplementation(() => ({
      from: () => ({ select: () => ({ eq: () => ({ single: mockSingle }) }) }),
    }));
    mockSingle.mockResolvedValue({
      data: { slab_address: SLAB, deployer: REGISTERED.publicKey.toBase58() },
      error: null,
    });
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
    expect((await res.json()).error).toMatch(/deployer|signature/i);
  });

  it("returns 400 for an invalid deployer pubkey", async () => {
    const { POST } = await import("@/app/api/markets/[slab]/logo/route");
    const req = buildRequest({ deployer: "not-a-pubkey", signature: "dGVzdA==" });
    // @ts-expect-error
    const res = await POST(req, { params: Promise.resolve({ slab: SLAB }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/deployer/i);
  });

  it("returns 400 for a malformed signature (not base64 64 bytes)", async () => {
    const kp = genKeypair();
    const { POST } = await import("@/app/api/markets/[slab]/logo/route");
    const req = buildRequest({ deployer: kp.publicKey.toBase58(), signature: "dGVzdA==" });
    // @ts-expect-error
    const res = await POST(req, { params: Promise.resolve({ slab: SLAB }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/signature/i);
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
    expect((await res.json()).error).toMatch(/signature/i);
  });

  it("returns 404 when the market row does not exist", async () => {
    mockSingle.mockResolvedValue({ data: null, error: { message: "not found" } });
    const sig = signProof(SLAB, REGISTERED.secretKey);
    const { POST } = await import("@/app/api/markets/[slab]/logo/route");
    const req = buildRequest({ deployer: REGISTERED.publicKey.toBase58(), signature: sig });
    // @ts-expect-error
    const res = await POST(req, { params: Promise.resolve({ slab: SLAB }) });
    expect(res.status).toBe(404);
  });

  it("returns 403 when the market has no registered creator (null deployer)", async () => {
    mockSingle.mockResolvedValue({ data: { slab_address: SLAB, deployer: null }, error: null });
    const kp = genKeypair();
    const sig = signProof(SLAB, kp.secretKey);
    const { POST } = await import("@/app/api/markets/[slab]/logo/route");
    const req = buildRequest({ deployer: kp.publicKey.toBase58(), signature: sig });
    // @ts-expect-error
    const res = await POST(req, { params: Promise.resolve({ slab: SLAB }) });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/no registered creator/i);
  });

  it("FORGERY: a different wallet with a VALID self-signature is rejected (not the registered deployer)", async () => {
    // Attacker generates their own keypair and signs the proof correctly FOR
    // THAT KEY — the signature verifies, but the key is not markets.deployer.
    // This is the exact case the forgeable LP-portfolio check let through.
    const attacker = genKeypair();
    const sig = signProof(SLAB, attacker.secretKey);
    const { POST } = await import("@/app/api/markets/[slab]/logo/route");
    const req = buildRequest({ deployer: attacker.publicKey.toBase58(), signature: sig });
    // @ts-expect-error
    const res = await POST(req, { params: Promise.resolve({ slab: SLAB }) });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not the creator/i);
  });

  it("passes auth when the signer IS the registered deployer (reaches the no-file 400)", async () => {
    const sig = signProof(SLAB, REGISTERED.secretKey);
    const { POST } = await import("@/app/api/markets/[slab]/logo/route");
    const req = buildRequest({ deployer: REGISTERED.publicKey.toBase58(), signature: sig }); // no file
    // @ts-expect-error
    const res = await POST(req, { params: Promise.resolve({ slab: SLAB }) });
    // Auth passed → downstream file check fires; message distinguishes it from an auth 400.
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no file provided/i);
  });

  it("accepts a signature signed a couple minutes in the past (clock-skew tolerance)", async () => {
    const sig = signProof(SLAB, REGISTERED.secretKey, -3);
    const { POST } = await import("@/app/api/markets/[slab]/logo/route");
    const req = buildRequest({ deployer: REGISTERED.publicKey.toBase58(), signature: sig });
    // @ts-expect-error
    const res = await POST(req, { params: Promise.resolve({ slab: SLAB }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no file provided/i);
  });

  it("admin bypass header skips the wallet-proof requirement entirely", async () => {
    process.env.ADMIN_API_SECRET = "test-admin-secret";
    const { POST } = await import("@/app/api/markets/[slab]/logo/route");
    const req = buildRequest({}, { "x-admin-secret": "test-admin-secret" }); // no deployer/sig, no file
    // @ts-expect-error
    const res = await POST(req, { params: Promise.resolve({ slab: SLAB }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no file provided/i);
  });

  it("returns 503 when the storage backend is unavailable", async () => {
    mockGetServiceClient.mockImplementation(() => {
      throw new Error("Storage backend unavailable (mocked)");
    });
    const sig = signProof(SLAB, REGISTERED.secretKey);
    const { POST } = await import("@/app/api/markets/[slab]/logo/route");
    const req = buildRequest({ deployer: REGISTERED.publicKey.toBase58(), signature: sig });
    // @ts-expect-error
    const res = await POST(req, { params: Promise.resolve({ slab: SLAB }) });
    expect(res.status).toBe(503);
  });
});
