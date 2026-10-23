// @vitest-environment node
//
// Node, not jsdom: the route hashes inside PublicKey/spl-token helpers, and under
// jsdom the Buffer handed to @noble/hashes fails its Uint8Array check. On line 1
// by convention — vitest matches the directive anywhere, but every other
// node-environment test in this repo puts it here.
/**
 * GH#2597 — /api/devnet-pre-fund must give back the caller's 24h faucet claim when
 * it funds nothing.
 *
 * It used to burn the claim on three SERVER misconfiguration paths, so a deployment
 * problem cost the user their daily window and delivered nothing.
 *
 * `tryFaucetGate` is check-AND-reserve: the route's own comment calls the Supabase
 * path "the authoritative check-and-reserve". After it succeeds, three paths return
 * 500 without releasing the claim:
 *
 *   1. DEVNET_MINT_AUTHORITY_KEYPAIR missing        — "Server not configured…"
 *   2. DEVNET_MINT_AUTHORITY_KEYPAIR unparseable    — "Server keypair configuration is invalid"
 *   3. the configured keypair is not the mint authority — "Mint authority mismatch…"
 *
 * All three are `return`, not `throw`, so the outer catch — which does call
 * `releaseFallbackClaimOnError` — never runs. The Supabase claim is released in
 * exactly one place, the transaction-failure branch. The Blob fallback claim is
 * genuinely unaffected, because it is not reserved until just before the mint,
 * after all three of these.
 *
 * Every one is a server-side env or config problem. The user did nothing wrong,
 * received nothing, and every retry for 24 hours answered
 * 429 "Already pre-funded recently".
 *
 * The fix arms a release closure the moment the gate reserves and disarms it only
 * once a mint has broadcast, mirroring what the route already did for its Blob
 * fallback claim — so the default is "release unless the claim was spent". Adding a
 * release at each early return was the alternative, and it is the shape that
 * already failed once.
 *
 * SIBLING OF #2521, which fixed this exact defect on /api/auto-fund — and which
 * asserted in its own text that "all three sibling faucet routes already release
 * the claim on their failure paths". That is not true of this route. dcc's closing
 * comment on #2521 confirms the fix landed only in auto-fund.
 *
 * This drives the real handler, so it asserts behaviour rather than source text.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair, PublicKey } from "@solana/web3.js";

const MINT_AUTHORITY = Keypair.generate();
const OTHER_AUTHORITY = Keypair.generate();
const MINT = "DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs";
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ATA = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/** The single Supabase client the route must hand to releaseFaucetClaim. */
const SUPABASE = { from: () => ({}) };

const getAccount = vi.fn();
const getMint = vi.fn();
const createMintToInstruction = vi.fn();
const sendAndConfirmServerTx = vi.fn();
class ServerSignatureTimeoutError extends Error {
  constructor(readonly signature: string, readonly timeoutMs: number) {
    super(`Transaction ${signature} not confirmed within ${timeoutMs}ms`);
  }
}
const tryFaucetGate = vi.fn();
const releaseFaucetClaim = vi.fn();
const reserveClaim = vi.fn();
const releaseClaim = vi.fn();

async function loadPostHandler() {
  vi.resetModules();

  vi.doMock("@solana/spl-token", () => ({
    getAssociatedTokenAddress: vi.fn(async () => ATA),
    getAccount: (...a: unknown[]) => getAccount(...a),
    getMint: (...a: unknown[]) => getMint(...a),
    createMintToInstruction: (...a: unknown[]) => createMintToInstruction(...a),
    createAssociatedTokenAccountInstruction: vi.fn(() => ({ kind: "createAta" })),
  }));

  vi.doMock("@solana/web3.js", async (orig) => {
    const actual = await (orig as () => Promise<typeof import("@solana/web3.js")>)();
    class FakeTx {
      instructions: unknown[] = [];
      add(...ix: unknown[]) { this.instructions.push(...ix); return this; }
    }
    return { ...actual, Transaction: FakeTx };
  });

  vi.doMock("@/lib/config", () => ({
    getConfig: () => ({ rpcUrl: "https://api.devnet.solana.com" }),
  }));
  vi.doMock("@/lib/server-rpc", () => ({
    // S3-C5: the route proves the sending connection is devnet by genesis hash.
    getServerConnection: () => ({
      rpcEndpoint: "https://api.devnet.solana.com",
      getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    }),
    sendAndConfirmServerTx: (...a: unknown[]) => sendAndConfirmServerTx(...a),
    ServerSignatureTimeoutError,
  }));
  vi.doMock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

  // Truthy client, so the Supabase gate path is taken and its claim is reserved.
  // ONE client object, so the release can be asserted to receive THAT client.
  // A factory returning a fresh object per call left the argument unconstrained:
  // releasing with `{ notAClient: true }` passed every test while throwing in
  // production, where the closure's own catch would swallow it and the claim
  // would still leak.
  vi.doMock("@/lib/supabase", () => ({ getServiceClient: () => SUPABASE }));
  vi.doMock("@/lib/faucet-rate-gate", () => ({
    tryFaucetGate: (...a: unknown[]) => tryFaucetGate(...a),
    releaseFaucetClaim: (...a: unknown[]) => releaseFaucetClaim(...a),
  }));
  vi.doMock("@/lib/prefund-claim-store", () => ({
    reserveClaim: (...a: unknown[]) => reserveClaim(...a),
    releaseClaim: (...a: unknown[]) => releaseClaim(...a),
    peekClaim: vi.fn(async () => ({ limited: false, nextClaimAt: null })),
    PREFUND_CLAIM_TTL_MS: 86_400_000,
  }));

  const mod = await import("@/app/api/devnet-pre-fund/route");
  return mod.POST as (req: NextRequest) => Promise<Response>;
}

function post() {
  return new NextRequest("http://localhost/api/devnet-pre-fund", {
    method: "POST",
    body: JSON.stringify({ mintAddress: MINT, walletAddress: WALLET }),
    headers: { "content-type": "application/json" },
  });
}

const goodKeypairEnv = JSON.stringify(Array.from(MINT_AUTHORITY.secretKey));

beforeEach(() => {
  process.env.NEXT_PUBLIC_SOLANA_NETWORK = "devnet";
  process.env.DEVNET_ALLOWED_MINTS = MINT;
  process.env.DEVNET_MINT_AUTHORITY_KEYPAIR = goodKeypairEnv;

  for (const m of [
    getAccount, getMint, createMintToInstruction, sendAndConfirmServerTx,
    tryFaucetGate, releaseFaucetClaim, reserveClaim, releaseClaim,
  ]) m.mockReset();

  // Empty wallet, so the balance-first short-circuit is passed and the gate is
  // actually consulted.
  getAccount.mockRejectedValue(new Error("TokenAccountNotFoundError"));
  getMint.mockResolvedValue({ mintAuthority: MINT_AUTHORITY.publicKey });
  createMintToInstruction.mockReturnValue({ kind: "mintTo" });
  sendAndConfirmServerTx.mockResolvedValue("SIG");
  // The gate ALLOWS and hands back a claimId — i.e. the claim is now reserved.
  tryFaucetGate.mockResolvedValue({ allowed: true, nextClaimAt: null, claimId: 4242 });
  // NOT COVERAGE OF THE FALLBACK GATE. Every test here takes the Supabase gate, so
  // usingFallbackGate is always false and reserveClaim/releaseClaim are never
  // reached. This line exists only so the route would not crash if a future test
  // did reach it — it must not be read as the Blob-claim path being exercised.
  // Deleting `reservedFallbackClaim = false` on the success path, or either Blob
  // release, passes this whole file.
  reserveClaim.mockResolvedValue({ reserved: true, nextClaimAt: null });
});

describe("a server misconfiguration gives the claim back", () => {
  it("releases on 500 — keypair missing", async () => {
    delete process.env.DEVNET_MINT_AUTHORITY_KEYPAIR;

    const POST = await loadPostHandler();
    const res = await POST(post());

    expect(res.status).toBe(500);
    // The claim was reserved, and given back.
    expect(tryFaucetGate).toHaveBeenCalledTimes(1);
    expect(releaseFaucetClaim).toHaveBeenCalledWith(SUPABASE, 4242);
    // Nothing was minted, which is exactly why the claim must not be spent.
    expect(createMintToInstruction).not.toHaveBeenCalled();
  });

  it("releases on 500 — keypair unparseable", async () => {
    process.env.DEVNET_MINT_AUTHORITY_KEYPAIR = "{not valid json";

    const POST = await loadPostHandler();
    const res = await POST(post());

    expect(res.status).toBe(500);
    expect(tryFaucetGate).toHaveBeenCalledTimes(1);
    expect(releaseFaucetClaim).toHaveBeenCalledTimes(1);
    expect(releaseFaucetClaim).toHaveBeenCalledWith(SUPABASE, 4242);
    expect(createMintToInstruction).not.toHaveBeenCalled();
  });

  it("releases on 500 — authority mismatch", async () => {
    getMint.mockResolvedValue({ mintAuthority: OTHER_AUTHORITY.publicKey });

    const POST = await loadPostHandler();
    const res = await POST(post());

    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Mint authority mismatch/i);
    expect(tryFaucetGate).toHaveBeenCalledTimes(1);
    expect(releaseFaucetClaim).toHaveBeenCalledWith(SUPABASE, 4242);
    expect(createMintToInstruction).not.toHaveBeenCalled();
  });
});

describe("the claim is kept only when it was actually spent", () => {
  it("a failed mint transaction releases the claim", async () => {
    // Pre-existing behaviour, and the only path that released before the fix.
    sendAndConfirmServerTx.mockRejectedValue(new Error("blockhash not found"));

    const POST = await loadPostHandler();
    const res = await POST(post());

    expect(res.status).toBe(500);
    expect(releaseFaucetClaim).toHaveBeenCalledTimes(1);
    expect(releaseFaucetClaim).toHaveBeenCalledWith(SUPABASE, 4242);
  });

  it("GH#2599: a broadcast mint with no confirmation yet KEEPS the claim", async () => {
    // Unknown outcome, not a failure: the tx can still land after the 45s wait,
    // so releasing would let an immediate retry mint twice.
    sendAndConfirmServerTx.mockRejectedValue(new ServerSignatureTimeoutError("SIG-PENDING", 45_000));

    const POST = await loadPostHandler();
    const res = await POST(post());
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.pending).toBe(true);
    expect(body.retryable).toBe(false);
    expect(body.signature).toBe("SIG-PENDING");
    expect(releaseFaucetClaim).not.toHaveBeenCalled();
    expect(releaseClaim).not.toHaveBeenCalled();
  });

  it("CONTROL: the happy path mints and keeps the claim", async () => {
    const POST = await loadPostHandler();
    const res = await POST(post());

    expect(res.status).toBe(200);
    expect(createMintToInstruction).toHaveBeenCalled();
    // Correct: the claim was spent on an actual mint.
    expect(releaseFaucetClaim).not.toHaveBeenCalled();
  });

  it("CONTROL: a rate-limited wallet never reserves anything to leak", async () => {
    tryFaucetGate.mockResolvedValue({ allowed: false, nextClaimAt: "2026-01-01T00:00:00Z" });

    const POST = await loadPostHandler();
    const res = await POST(post());

    expect(res.status).toBe(429);
    expect(releaseFaucetClaim).not.toHaveBeenCalled();
    expect(createMintToInstruction).not.toHaveBeenCalled();
  });

  it("the release is best-effort — a cleanup failure does not change the response", async () => {
    // If releasing threw, the route would turn a clear 500 into an opaque one and
    // still leak. Wrapped, so the caller keeps the actionable message.
    delete process.env.DEVNET_MINT_AUTHORITY_KEYPAIR;
    releaseFaucetClaim.mockRejectedValue(new Error("supabase unavailable"));

    const POST = await loadPostHandler();
    const res = await POST(post());

    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/not configured for devnet minting/i);
    expect(releaseFaucetClaim).toHaveBeenCalledTimes(1);
  });

  it("a THROW between reserving and minting also releases the claim", async () => {
    // The hole the first version of this fix left, and the reason the release
    // closure now lives outside the try and is called from the outer catch. Before
    // that, only the three `return` paths released; anything that THREW while
    // building the transaction fell to the outer catch, which released the Blob
    // claim and burned the Supabase one. No test covered it.
    createMintToInstruction.mockImplementation(() => {
      throw new Error("spl-token blew up while building the mint instruction");
    });

    const POST = await loadPostHandler();
    const res = await POST(post());

    expect(res.status).toBe(500);
    expect(tryFaucetGate).toHaveBeenCalledTimes(1);
    expect(releaseFaucetClaim).toHaveBeenCalledWith(SUPABASE, 4242);
  });

  it("releases at most once, however many exits are reached", async () => {
    // The closure is self-disarming, which is what makes calling it from the outer
    // catch safe: the tx-failure branch releases and then rethrows into that catch.
    sendAndConfirmServerTx.mockRejectedValue(new Error("blockhash not found"));

    const POST = await loadPostHandler();
    await POST(post());

    expect(releaseFaucetClaim).toHaveBeenCalledTimes(1);
  });

  it("a hanging release does not hang the response", async () => {
    // The release is bounded by the route's withTimeout helper. supabase-js uses
    // fetch with no default timeout, and the try/catch around the release catches
    // REJECTIONS, not HANGS — so without the bound a Supabase incident would turn
    // an instant, actionable 500 into a request held until the platform kills it.
    // Cases 1 and 2 are deployment-wide, so that would be every caller at once.
    delete process.env.DEVNET_MINT_AUTHORITY_KEYPAIR;
    releaseFaucetClaim.mockImplementation(() => new Promise(() => {})); // never settles

    const POST = await loadPostHandler();

    const res = await Promise.race([
      POST(post()),
      new Promise<"TIMED_OUT">((r) => setTimeout(() => r("TIMED_OUT"), 10_000)),
    ]);

    expect(res).not.toBe("TIMED_OUT");
    expect((res as Response).status).toBe(500);
    expect(await (res as Response).json()).toMatchObject({
      error: expect.stringMatching(/not configured for devnet minting/i),
    });
  }, 20_000);

  it("a reserved claim with no id is surfaced rather than silently unreleasable", async () => {
    // tryFaucetGate returns `claimId: data?.id`, so an INSERT that commits while
    // .select() returns no representation yields allowed:true with no id. The row
    // exists, the claim is spent, and there is no handle to release it — so every
    // path leaks exactly as before this fix. Nothing can repair it from the route,
    // but it must not look like a working release. Every other test here hardcodes
    // claimId 4242, which is why this went unseen.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    tryFaucetGate.mockResolvedValue({ allowed: true, nextClaimAt: null }); // no claimId
    delete process.env.DEVNET_MINT_AUTHORITY_KEYPAIR;

    const POST = await loadPostHandler();
    const res = await POST(post());

    expect(res.status).toBe(500);
    // Nothing to release, and the route does not pretend otherwise...
    expect(releaseFaucetClaim).not.toHaveBeenCalled();
    // ...it says so.
    expect(
      warn.mock.calls.some((c) =>
        c.some((a) => typeof a === "string" && /cannot be released/i.test(a)),
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  it("CONTROL: the warning does NOT fire on the normal path", async () => {
    // Otherwise the assertion above would pass on every request and mean nothing.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const POST = await loadPostHandler();
    await POST(post());

    expect(
      warn.mock.calls.some((c) =>
        c.some((a) => typeof a === "string" && /cannot be released/i.test(a)),
      ),
    ).toBe(false);
    warn.mockRestore();
  });
});
