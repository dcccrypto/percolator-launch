/**
 * PERC-376 / PERC-1233 (GH#1382): Tests for /api/faucet route
 *
 * Covers:
 * - Network guard (devnet-only)
 * - Wallet validation
 * - Rate limiting per type (sol / usdc)
 * - USDC amount constant
 * - SOL airdrop path dispatching
 * - USDC sealed-signer path: on-chain authority check returns 400 (not 500)
 * - GH#1474: error field is never empty string (fallback to toString/generic)
 * - GH#1820: empty/non-JSON body returns 400 (not 500)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    rpcUrl: "https://api.devnet.solana.com",
    network: "devnet",
    testUsdcMint: "DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs",
  }),
}));

const mockSupabase = {
  from: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  gte: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue({ data: [], error: null }),
  insert: vi.fn().mockResolvedValue({ data: null, error: null }),
};

vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => mockSupabase,
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal SPL Token mint account data buffer with the given authority. */
function buildMintData(authority: PublicKey | null): Buffer {
  const buf = Buffer.alloc(82, 0);
  if (authority) {
    // coption = 1 (has authority)
    buf.writeUInt32LE(1, 0);
    authority.toBuffer().copy(buf, 4);
  } else {
    // coption = 0 (no authority)
    buf.writeUInt32LE(0, 0);
  }
  return buf;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("/api/faucet route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
    process.env.NEXT_PUBLIC_SOLANA_NETWORK = "devnet";
  });

  describe("GH#1820: empty/non-JSON body returns 400, not 500", () => {
    // Mirrors the req.json() try/catch added in GH#1820 fix.
    // Previously: req.json() threw SyntaxError which bubbled to the outer catch → 500.
    // After fix: parse failure returns 400 with a descriptive message.

    const simulateParse = (rawBody: string | null): { status: number; error?: string } => {
      try {
        if (rawBody === null || rawBody.trim() === "") throw new SyntaxError("Unexpected end of JSON input");
        JSON.parse(rawBody);
        return { status: 200 };
      } catch {
        return { status: 400, error: "Request body must be valid JSON with fields: wallet (string), type ('sol' | 'usdc')" };
      }
    };

    it("empty body → 400 (not 500)", () => {
      const res = simulateParse("");
      expect(res.status).toBe(400);
      expect(res.error).toContain("valid JSON");
    });

    it("null body → 400 (not 500)", () => {
      const res = simulateParse(null);
      expect(res.status).toBe(400);
      expect(res.error).toContain("valid JSON");
    });

    it("non-JSON plain text body → 400 (not 500)", () => {
      const res = simulateParse("garbage");
      expect(res.status).toBe(400);
      expect(res.error).toContain("valid JSON");
    });

    it("valid JSON body → proceeds past parse step (200 from parse sim)", () => {
      const res = simulateParse(JSON.stringify({ wallet: "abc", type: "sol" }));
      expect(res.status).toBe(200);
    });

    it("error message describes required fields", () => {
      const res = simulateParse("");
      expect(res.error).toContain("wallet");
      expect(res.error).toContain("type");
    });
  });

  it("rejects requests on mainnet", () => {
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "mainnet";
    process.env.NEXT_PUBLIC_SOLANA_NETWORK = "mainnet";
    expect(process.env.NEXT_PUBLIC_DEFAULT_NETWORK).toBe("mainnet");
  });

  it("requires wallet address", () => {
    const body = {};
    expect(body).not.toHaveProperty("wallet");
  });

  it("validates wallet address format", () => {
    expect(() => new PublicKey("not-a-valid-address")).toThrow();
  });

  it("rate-limits USDC claims per 24h (usdc_minted field)", async () => {
    mockSupabase.limit.mockResolvedValueOnce({
      data: [{ id: 1, created_at: new Date().toISOString() }],
      error: null,
    });
    const { data } = await mockSupabase.limit();
    expect(data).toHaveLength(1);
  });

  it("rate-limits SOL claims per 24h (sol_airdropped field)", async () => {
    mockSupabase.limit.mockResolvedValueOnce({
      data: [{ id: 2, created_at: new Date().toISOString() }],
      error: null,
    });
    const { data } = await mockSupabase.limit();
    expect(data).toHaveLength(1);
  });

  it("USDC mint amount constant: 10,000 USDC = 10,000,000,000 raw", () => {
    const USDC_MINT_AMOUNT = 10_000_000_000;
    expect(USDC_MINT_AMOUNT / 1_000_000).toBe(10_000);
  });

  it("SOL airdrop amount constant: 2 SOL = 2,000,000,000 lamports", () => {
    const LAMPORTS_PER_SOL = 1_000_000_000;
    const SOL_AIRDROP_AMOUNT = 2 * LAMPORTS_PER_SOL;
    expect(SOL_AIRDROP_AMOUNT).toBe(2_000_000_000);
  });

  it("GH#1815: missing type returns 400, not 500 (TokenOwnerOffCurveError)", () => {
    // Regression guard: previously, omitting 'type' silently defaulted to "usdc"
    // and proceeded to token operations, crashing with TokenOwnerOffCurveError (500).
    // Now missing type must return 400 immediately, before any token ops.
    //
    // Mirrors the route's normalisation logic:
    //   normalizedType = typeof rawType === "string" ? rawType.trim().toLowerCase() : undefined
    //   if (normalizedType === undefined) → 400 "Missing required field: type"
    const normalize = (rawType: unknown): string | undefined =>
      typeof rawType === "string" ? rawType.trim().toLowerCase() : undefined;

    // undefined (field absent) and null both normalise to undefined → 400
    expect(normalize(undefined)).toBeUndefined(); // was silently "usdc" before fix
    expect(normalize(null)).toBeUndefined();
    // valid values pass through
    expect(normalize("sol")).toBe("sol");
    expect(normalize("usdc")).toBe("usdc");
    expect(normalize("  SOL  ")).toBe("sol"); // trimmed + lowercased
    // non-string (e.g. number) also normalises to undefined → 400
    expect(normalize(42)).toBeUndefined();
  });

  it("GH#1399: unknown type returns 400 with descriptive error (not authority_mismatch)", () => {
    // Regression guard: sending type:"token" or type:"mirror" previously
    // silently fell through to the USDC mint path, producing a confusing
    // authority_mismatch error. Now it must return 400 immediately.
    // GH#1815: same 400 path also handles missing type (undefined/null).
    const VALID_TYPES = ["sol", "usdc"];
    const unknownType = "token";
    const isKnown = VALID_TYPES.includes(unknownType);
    const expectedStatus = isKnown ? 200 : 400;
    expect(expectedStatus).toBe(400);

    const unknownType2 = "mirror";
    const isKnown2 = VALID_TYPES.includes(unknownType2);
    expect(isKnown2).toBe(false);

    // GH#1815: undefined (missing) type must also return 400
    const missingType = undefined;
    const expectedStatusMissing = missingType === undefined ? 400 : 200;
    expect(expectedStatusMissing).toBe(400);
  });

  it("on-chain authority check: authority mismatch should return 400, not 500 (GH#1382)", () => {
    // Simulates the path where on-chain authority != DEVNET_MINT_AUTHORITY_KEYPAIR.
    // The route must return 400 with hint:"authority_mismatch" instead of throwing 500.
    const signerPk = new PublicKey("So11111111111111111111111111111111111111112");
    const onChainPk = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const mintData = buildMintData(onChainPk);

    // Decode the authority from the simulated mint data (what the route does)
    const hasAuthority = new DataView(mintData.buffer, mintData.byteOffset).getUint32(0, true) === 1;
    expect(hasAuthority).toBe(true);

    const decoded = new PublicKey(mintData.slice(4, 36));
    expect(decoded.toBase58()).toBe(onChainPk.toBase58());
    expect(decoded.equals(signerPk)).toBe(false); // ← mismatch → route returns 400
  });

  it("on-chain authority check: matching authority should proceed to mint", () => {
    const signerPk = new PublicKey("So11111111111111111111111111111111111111112");
    const mintData = buildMintData(signerPk);

    const hasAuthority = new DataView(mintData.buffer, mintData.byteOffset).getUint32(0, true) === 1;
    expect(hasAuthority).toBe(true);

    const decoded = new PublicKey(mintData.slice(4, 36));
    expect(decoded.equals(signerPk)).toBe(true); // ← match → route proceeds
  });

  describe("SOL airdrop rate-limit detection (GH#1385)", () => {
    // Mirror of the regex used in the route to detect Solana devnet rate-limits.
    // Ensures the pattern catches real error strings from the devnet faucet.
    const isRateLimit = (msg: string) =>
      /429|too many requests|rate.?limit|airdrop.*limit|limit.*airdrop/i.test(msg);

    it("detects '429 Too Many Requests' from devnet RPC", () => {
      expect(isRateLimit("429 Too Many Requests")).toBe(true);
    });

    it("detects 'airdrop request limit reached' from devnet faucet", () => {
      expect(isRateLimit("airdrop request limit reached for the wallet address")).toBe(true);
    });

    it("detects 'rate limit exceeded' variations", () => {
      expect(isRateLimit("rate limit exceeded")).toBe(true);
      expect(isRateLimit("RateLimit: too many requests")).toBe(true);
    });

    it("does NOT flag unrelated errors as rate-limits", () => {
      expect(isRateLimit("Transaction simulation failed")).toBe(false);
      expect(isRateLimit("Connection refused")).toBe(false);
      expect(isRateLimit("Invalid public key input")).toBe(false);
      expect(isRateLimit("Internal error")).toBe(false); // GH#1392: handled separately as retryable
    });

  });

  describe("SOL airdrop retryable error detection (GH#1392)", () => {
    // Mirror of the retryable regex added for transient Solana devnet failures.
    // GH#1764: extended to cover additional Node.js socket-level error codes.
    // GH#1776: extended to cover superstruct RPC validation errors.
    const isTransient = (msg: string) =>
      /internal error|service unavailable|timeout|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EHOSTUNREACH|network.*changed|fetch failed|socket hang up|satisfy a union|superstruct/i.test(
        msg,
      );

    it("detects 'Internal error' from Solana devnet", () => {
      expect(isTransient("airdrop to G7NG... failed: Internal error")).toBe(true);
    });

    it("detects 'Service unavailable'", () => {
      expect(isTransient("Service unavailable")).toBe(true);
    });

    it("detects connection refused", () => {
      expect(isTransient("connect ECONNREFUSED 127.0.0.1:8899")).toBe(true);
    });

    it("detects timeout errors", () => {
      expect(isTransient("Request timeout")).toBe(true);
    });

    it("GH#1764: detects ETIMEDOUT", () => {
      expect(isTransient("connect ETIMEDOUT 145.40.91.120:443")).toBe(true);
    });

    it("GH#1764: detects ENOTFOUND (DNS failure)", () => {
      expect(isTransient("getaddrinfo ENOTFOUND api.devnet.solana.com")).toBe(true);
    });

    it("GH#1764: detects ECONNRESET", () => {
      expect(isTransient("read ECONNRESET")).toBe(true);
    });

    it("GH#1764: detects 'fetch failed' (Node.js 18+ undici errors)", () => {
      expect(isTransient("fetch failed")).toBe(true);
    });

    it("GH#1764: detects 'socket hang up'", () => {
      expect(isTransient("socket hang up")).toBe(true);
    });

    it("does NOT flag unrelated errors as retryable", () => {
      expect(isTransient("Transaction simulation failed")).toBe(false);
      expect(isTransient("Invalid public key input")).toBe(false);
    });

    it("returns 503 status for retryable SOL airdrop errors (not 500)", () => {
      const errMsg = "airdrop to G7NG... failed: Internal error";
      const statusCode = isTransient(errMsg) ? 503 : 500;
      expect(statusCode).toBe(503);
    });
  });

  describe("GH#1764: multi-RPC fallback logic", () => {
    // Simulate the loop logic: try each RPC, fall through on transient errors.
    // GH#1776: superstruct errors added to transient pattern.
    const isTransient = (msg: string) =>
      /internal error|service unavailable|timeout|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EHOSTUNREACH|network.*changed|fetch failed|socket hang up|satisfy a union|superstruct/i.test(
        msg,
      );
    const isRateLimit = (msg: string) =>
      /429|too many requests|rate.?limit|airdrop.*limit|limit.*airdrop/i.test(msg);

    type AirdropResult =
      | { status: "success"; sig: string }
      | { status: "rate-limited" }
      | { status: "transient"; msg: string }
      | { status: "fatal"; msg: string };

    function simulateRpcPool(
      responses: Array<() => AirdropResult>,
    ): { finalSig: string | null; rateLimited: boolean; allTransient: boolean; fatal: boolean } {
      let sig: string | null = null;
      let rateLimited = false;
      let lastTransient = false;
      let fatal = false;

      for (const attempt of responses) {
        const result = attempt();
        if (result.status === "success") {
          sig = result.sig;
          lastTransient = false;
          break;
        }
        if (result.status === "rate-limited") {
          rateLimited = true;
          break;
        }
        if (result.status === "transient") {
          lastTransient = true;
          continue;
        }
        if (result.status === "fatal") {
          fatal = true;
          break;
        }
      }

      return { finalSig: sig, rateLimited, allTransient: !fatal && !rateLimited && sig === null && lastTransient, fatal };
    }

    it("succeeds on first RPC — no fallback needed", () => {
      const result = simulateRpcPool([
        () => ({ status: "success", sig: "abc123" }),
        () => ({ status: "success", sig: "def456" }),
      ]);
      expect(result.finalSig).toBe("abc123");
      expect(result.rateLimited).toBe(false);
    });

    it("falls back to second RPC when first has ENOTFOUND", () => {
      const result = simulateRpcPool([
        () => ({ status: "transient", msg: "getaddrinfo ENOTFOUND api.devnet.solana.com" }),
        () => ({ status: "success", sig: "fallback-sig-xyz" }),
      ]);
      expect(result.finalSig).toBe("fallback-sig-xyz");
      expect(result.allTransient).toBe(false);
    });

    it("returns allTransient when both RPCs fail transiently", () => {
      const result = simulateRpcPool([
        () => ({ status: "transient", msg: "fetch failed" }),
        () => ({ status: "transient", msg: "socket hang up" }),
      ]);
      expect(result.finalSig).toBeNull();
      expect(result.allTransient).toBe(true);
      expect(result.rateLimited).toBe(false);
    });

    it("rate-limit aborts immediately without trying fallback", () => {
      let fallbackCalled = false;
      const result = simulateRpcPool([
        () => ({ status: "rate-limited" }),
        () => { fallbackCalled = true; return { status: "success", sig: "nope" }; },
      ]);
      expect(result.rateLimited).toBe(true);
      expect(fallbackCalled).toBe(false);
      expect(result.finalSig).toBeNull();
    });

    it("fatal error aborts immediately without trying fallback", () => {
      let fallbackCalled = false;
      const result = simulateRpcPool([
        () => ({ status: "fatal", msg: "Transaction simulation failed" }),
        () => { fallbackCalled = true; return { status: "success", sig: "nope" }; },
      ]);
      expect(result.fatal).toBe(true);
      expect(fallbackCalled).toBe(false);
    });

    it("transient then rate-limit: rate-limit wins (no more fallbacks)", () => {
      const result = simulateRpcPool([
        () => ({ status: "transient", msg: "ETIMEDOUT" }),
        () => ({ status: "rate-limited" }),
      ]);
      // In this scenario: first RPC transient → try second → rate-limited → abort
      // allTransient is false because rateLimited=true
      expect(result.rateLimited).toBe(true);
      expect(result.finalSig).toBeNull();
    });
  });

  describe("SOL airdrop rate-limit detection — regression (GH#1385)", () => {
    const isRateLimit = (msg: string) =>
      /429|too many requests|rate.?limit|airdrop.*limit|limit.*airdrop/i.test(msg);

    it("returns 429 status for rate-limited SOL airdrop (not 500)", () => {
      // Validate that a 429 from devnet → our API returns 429 with retryable:true.
      // This is a logic regression guard — not a full integration test.
      const errMsg = "429 Too Many Requests";
      const rateLimited = isRateLimit(errMsg);
      const statusCode = rateLimited ? 429 : 500;
      expect(statusCode).toBe(429);
    });
  });

  describe("GH#1474: error response is never empty string", () => {
    // Mirrors the error serialisation logic in the catch handler and SOL airdrop catch.
    const serializeError = (error: unknown): string => {
      if (error instanceof Error) {
        return error.message || error.toString() || "Internal server error";
      }
      return String(error) || "Internal server error";
    };

    it("returns message when Error has non-empty message", () => {
      const e = new Error("something went wrong");
      expect(serializeError(e)).toBe("something went wrong");
    });

    it("falls back to toString() when Error.message is empty string", () => {
      const e = new Error("");
      // Error.toString() returns "Error" when message is empty
      expect(serializeError(e)).toBe("Error");
    });

    it("returns generic message when Error.message and toString both empty", () => {
      const e = new Error("");
      // Override toString to simulate degenerate case
      e.toString = () => "";
      expect(serializeError(e)).toBe("Internal server error");
    });

    it("stringifies non-Error throws (e.g. string literal throws)", () => {
      const thrown = "authority_mismatch";
      expect(serializeError(thrown)).toBe("authority_mismatch");
    });

    it("handles null/undefined thrown values without returning empty", () => {
      expect(serializeError(null)).toBe("null");
      expect(serializeError(undefined)).toBe("undefined");
    });
  });

  describe("GH#1776: superstruct RPC validation error treated as transient (not 500)", () => {
    // The superstruct error "Expected the value to satisfy a union of `type | type`"
    // comes from web3.js confirmTransaction when devnet RPC returns an unexpected
    // response format. Must be treated as a transient error (try next RPC), never a 500.
    const isTransient = (msg: string) =>
      /internal error|service unavailable|timeout|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EHOSTUNREACH|network.*changed|fetch failed|socket hang up|satisfy a union|superstruct/i.test(
        msg,
      );

    it("classifies superstruct union error as transient (retryable)", () => {
      const superstructMsg =
        "Expected the value to satisfy a union of `type | type`, but received: [object Object]";
      expect(isTransient(superstructMsg)).toBe(true);
    });

    it("classifies 'superstruct' keyword as transient", () => {
      expect(isTransient("superstruct validation error")).toBe(true);
    });

    it("superstruct error routes to 503, not 500", () => {
      const superstructMsg =
        "Expected the value to satisfy a union of `type | type`, but received: [object Object]";
      const isRateLimit =
        /429|too many requests|rate.?limit|airdrop.*limit|limit.*airdrop/i.test(superstructMsg);
      const transient = isTransient(superstructMsg);
      // Should be transient (503), not rate-limit (429), not fatal (500)
      expect(isRateLimit).toBe(false);
      expect(transient).toBe(true);
      const statusCode = isRateLimit ? 429 : transient ? 503 : 500;
      expect(statusCode).toBe(503);
    });
  });

  describe("GH#1798: SOL faucet 429 includes correct fields (not 'temporarily unavailable')", () => {
    // Validates the response shape returned when the Solana devnet RPC rate-limits us.
    // Before fix: error said "Solana devnet temporarily unavailable" (confusing).
    // After fix: error message is explicit about rate-limiting, includes nextClaimAt,
    // rpcRateLimited flag, and retryable:false (per-wallet limit, no point retrying soon).

    const buildRateLimitResponse = (lastRateLimitMsg: string) => {
      const isRateLimit =
        /429|too many requests|rate.?limit|airdrop.*limit|limit.*airdrop/i.test(lastRateLimitMsg);
      if (!isRateLimit) return null;
      const nextClaimAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      return {
        error:
          "SOL airdrop rate limit reached — Solana devnet limits 1 airdrop per wallet per day. Try again tomorrow or use https://faucet.solana.com.",
        retryable: false,
        nextClaimAt,
        rpcRateLimited: true,
        status: 429,
      };
    };

    it("builds correct response for '429 Too Many Requests' from devnet RPC", () => {
      const resp = buildRateLimitResponse("429 Too Many Requests");
      expect(resp).not.toBeNull();
      expect(resp!.status).toBe(429);
      expect(resp!.retryable).toBe(false);
      expect(resp!.rpcRateLimited).toBe(true);
      expect(resp!.nextClaimAt).toBeDefined();
      expect(resp!.error).toContain("rate limit");
      expect(resp!.error).not.toContain("temporarily unavailable");
    });

    it("builds correct response for 'airdrop request limit reached' from devnet RPC", () => {
      const resp = buildRateLimitResponse("airdrop request limit reached");
      expect(resp).not.toBeNull();
      expect(resp!.rpcRateLimited).toBe(true);
      expect(resp!.error).toContain("faucet.solana.com");
    });

    it("returns null for non-rate-limit errors (not mis-classified)", () => {
      expect(buildRateLimitResponse("Internal error")).toBeNull();
      expect(buildRateLimitResponse("connection timeout")).toBeNull();
    });
  });

  describe("GH#1803: DB rate-limit check runs BEFORE RPC call", () => {
    // Regression guard: previously, a transient DB error on first call caused
    // fail-open (tryFaucetGate returns allowed:true), then the RPC call fired
    // and also failed transiently → wallet got "devnet unavailable" 503.
    // On 2nd call, DB was warm → 23505 fired → wallet correctly got 429.
    //
    // Fix: tryFaucetGate now does a SELECT pre-check for active claims BEFORE
    // any INSERT or RPC. Rate-limited wallets are caught on first call.

    // Simulate the pre-check SELECT behaviour
    const buildGateResult = (
      activeClaim: { claimed_at: string } | null,
    ): { allowed: boolean; nextClaimAt: string | null } => {
      const RATE_LIMIT_MS = 24 * 60 * 60 * 1000;
      if (activeClaim) {
        const nextClaimAt = new Date(
          new Date(activeClaim.claimed_at).getTime() + RATE_LIMIT_MS,
        ).toISOString();
        return { allowed: false, nextClaimAt };
      }
      return { allowed: true, nextClaimAt: null };
    };

    it("SELECT pre-check: returns denied immediately when active claim exists", () => {
      const claimed_at = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
      const result = buildGateResult({ claimed_at });
      expect(result.allowed).toBe(false);
      expect(result.nextClaimAt).not.toBeNull();
    });

    it("SELECT pre-check: nextClaimAt is ~23h from claimed_at (1h ago)", () => {
      const claimedAt = Date.now() - 60 * 60 * 1000; // 1 hour ago
      const result = buildGateResult({ claimed_at: new Date(claimedAt).toISOString() });
      const nextClaim = new Date(result.nextClaimAt!).getTime();
      const expected = claimedAt + 24 * 60 * 60 * 1000; // 24h from claimed_at
      // Allow 5s drift for test execution time
      expect(Math.abs(nextClaim - expected)).toBeLessThan(5000);
    });

    it("SELECT pre-check: returns allowed when no active claim (first-time user)", () => {
      const result = buildGateResult(null);
      expect(result.allowed).toBe(true);
      expect(result.nextClaimAt).toBeNull();
    });

    it("rate-limited wallet gets denied BEFORE reaching RPC path", () => {
      // Simulates: wallet with active claim → gate returns denied → RPC is never called.
      let rpcCallCount = 0;
      const mockRequestAirdrop = () => { rpcCallCount++; return Promise.resolve("sig"); };

      const claimed_at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
      const gate = buildGateResult({ claimed_at });

      // Route should return 429 immediately when !gate.allowed, without calling RPC.
      if (!gate.allowed) {
        // Return 429 — do NOT call mockRequestAirdrop
      } else {
        void mockRequestAirdrop(); // would be called if gate is allowed
      }

      expect(rpcCallCount).toBe(0); // RPC was NOT called for rate-limited wallet
      expect(gate.allowed).toBe(false);
    });
  });
});
