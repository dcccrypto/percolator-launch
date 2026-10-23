/**
 * GH#2592 — the ROUTE, not just the arithmetic helper.
 *
 * WHY THIS FILE EXISTS. The first version of this fix extracted the launch-cost
 * arithmetic into lib/prefund-requirement.ts and tested that thoroughly. Review
 * then established that **nothing in the repo imported the route module at all**,
 * so every one of these survived with a green suite:
 *
 *   - `fullMarketRequirement(insuranceAtoms, lpAtoms)` — arguments swapped, which
 *     computes 1,800 instead of 3,100 and re-creates a WORSE version of the very
 *     bug being fixed;
 *   - deleting the ceiling refusal entirely;
 *   - `const toMint = fullRequirement - currentBalance` — dropping the 2x, the
 *     under-mint that H3 depends on not happening;
 *   - deleting the malformed-amount 400;
 *   - replacing the parsed amounts with the fixed defaults, which un-wires the
 *     headline feature of the change;
 *   - swapping the balance read and the 24h rate gate — literally the property
 *     the neighbouring `h3-...` file is named after, which passed because that
 *     file asserts the ordering inside its own local simulation of the route.
 *
 * All six verified surviving by running them. A helper test plus a simulation of
 * the route is not a test of the route.
 *
 * Mocking follows the house pattern in devnet-airdrop tests:
 * `vi.doMock` inside a loader with `vi.resetModules()`, because NETWORK and
 * DEVNET_ALLOWED_MINTS are module-level consts read at import time.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair, PublicKey } from "@solana/web3.js";
import { fullMarketRequirement, fundAmountFor, fundingRequirement } from "@/lib/prefund-requirement";

const T = 1_000_000n;
const INSURANCE = 100n * T;

/** Real keypair, so `Keypair.fromSecretKey` and the authority check both work. */
const MINT_AUTHORITY = Keypair.generate();
const MINT = "DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs";
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ATA = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const getAccount = vi.fn();
const getMint = vi.fn();
const createMintToInstruction = vi.fn();
const createAssociatedTokenAccountInstruction = vi.fn();
const sendAndConfirmServerTx = vi.fn();
const tryFaucetGate = vi.fn();
const reserveClaim = vi.fn();
const checkFundRateLimit = vi.fn();

async function loadPostHandler() {
  vi.resetModules();

  vi.doMock("@solana/spl-token", () => ({
    getAssociatedTokenAddress: vi.fn(async () => ATA),
    getAccount: (...a: unknown[]) => getAccount(...a),
    getMint: (...a: unknown[]) => getMint(...a),
    createMintToInstruction: (...a: unknown[]) => createMintToInstruction(...a),
    createAssociatedTokenAccountInstruction: (...a: unknown[]) =>
      createAssociatedTokenAccountInstruction(...a),
  }));

  // Keep Keypair/PublicKey real; only Transaction needs to accept mock
  // instructions without validating them.
  vi.doMock("@solana/web3.js", async (orig) => {
    const actual = await (orig as () => Promise<typeof import("@solana/web3.js")>)();
    class FakeTx {
      instructions: unknown[] = [];
      add(...ix: unknown[]) { this.instructions.push(...ix); return this; }
    }
    return { ...actual, Transaction: FakeTx };
  });

  vi.doMock("@/lib/get-client-ip", () => ({ getClientIp: () => "1.2.3.4" }));
  vi.doMock("@/lib/fund-ip-rate-limit", () => ({
    checkFundRateLimit: (...a: unknown[]) => checkFundRateLimit(...a),
  }));
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
  }));
  vi.doMock("@sentry/nextjs", () => ({
    captureMessage: vi.fn(),
    captureException: vi.fn(),
  }));
  vi.doMock("@/lib/supabase", () => ({
    getServiceClient: () => null, // no DB gate → fallback claim store path
  }));
  vi.doMock("@/lib/faucet-rate-gate", () => ({
    tryFaucetGate: (...a: unknown[]) => tryFaucetGate(...a),
  }));
  vi.doMock("@/lib/prefund-claim-store", () => ({
    reserveClaim: (...a: unknown[]) => reserveClaim(...a),
    releaseClaim: vi.fn(async () => {}),
    peekClaim: vi.fn(async () => ({ limited: false, nextClaimAt: null })),
    PREFUND_CLAIM_TTL_MS: 86_400_000,
  }));

  const mod = await import("@/app/api/devnet-pre-fund/route");
  return mod.POST as (req: NextRequest) => Promise<Response>;
}

function post(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/devnet-pre-fund", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

/** The amount handed to createMintToInstruction, or null if it never ran. */
function mintedAmount(): bigint | null {
  if (createMintToInstruction.mock.calls.length === 0) return null;
  return createMintToInstruction.mock.calls[0][3] as bigint;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SOLANA_NETWORK = "devnet";
  process.env.DEVNET_ALLOWED_MINTS = MINT;
  process.env.DEVNET_MINT_AUTHORITY_KEYPAIR = JSON.stringify(
    Array.from(MINT_AUTHORITY.secretKey),
  );

  for (const m of [
    getAccount, getMint, createMintToInstruction,
    createAssociatedTokenAccountInstruction, sendAndConfirmServerTx,
    tryFaucetGate, reserveClaim, checkFundRateLimit,
  ]) m.mockReset();

  // Empty wallet by default: no ATA yet.
  getAccount.mockRejectedValue(new Error("TokenAccountNotFoundError"));
  getMint.mockResolvedValue({ mintAuthority: MINT_AUTHORITY.publicKey });
  createMintToInstruction.mockReturnValue({ kind: "mintTo" });
  createAssociatedTokenAccountInstruction.mockReturnValue({ kind: "createAta" });
  sendAndConfirmServerTx.mockResolvedValue("SIG_MINT");
  tryFaucetGate.mockResolvedValue({ allowed: true, nextClaimAt: null, claimId: 1 });
  reserveClaim.mockResolvedValue({ reserved: true, nextClaimAt: null });
  checkFundRateLimit.mockResolvedValue({ allowed: true, retryAfter: 0 });
});

describe("the mint covers the launch the caller actually asked for", () => {
  it("mints 2x the requirement for the amounts in the request", async () => {
    // Pins the route's OWN call into the helper. Kills the argument-order swap
    // (which would compute 1,800 for the reference launch), the revert to fixed
    // defaults, and dropping fundAmountFor.
    const lp = 2_500n * T;
    const POST = await loadPostHandler();

    const res = await POST(post({
      mintAddress: MINT,
      walletAddress: WALLET,
      lpCollateral: lp.toString(),
      insuranceAmount: INSURANCE.toString(),
    }));

    expect(res.status).toBe(200);
    expect(mintedAmount()).toBe(fundAmountFor(fundingRequirement(lp, INSURANCE)));
  });

  it("a different LP size mints a different amount", async () => {
    // A fixed constant cannot be right for two LP sizes at once. Without this,
    // hardcoding the defaults in the route passes everything.
    // Both above the default floor, so this really tests per-request sizing
    // rather than the floor. Both inside the faucet ceiling.
    const small = 2_000n * T;
    const large = 3_000n * T;

    const POST1 = await loadPostHandler();
    await POST1(post({ mintAddress: MINT, walletAddress: WALLET, lpCollateral: small.toString(), insuranceAmount: INSURANCE.toString() }));
    const mintedSmall = mintedAmount();

    createMintToInstruction.mockClear();
    const POST2 = await loadPostHandler();
    await POST2(post({ mintAddress: MINT, walletAddress: WALLET, lpCollateral: large.toString(), insuranceAmount: INSURANCE.toString() }));
    const mintedLarge = mintedAmount();

    expect(mintedSmall).toBe(fundAmountFor(fundingRequirement(small, INSURANCE)));
    expect(mintedLarge).toBe(fundAmountFor(fundingRequirement(large, INSURANCE)));
    expect(mintedLarge).toBeGreaterThan(mintedSmall!);
  });

  it("subtracts the balance already held", async () => {
    const lp = 1_000n * T;
    const held = 400n * T;
    getAccount.mockResolvedValue({ amount: held });

    const POST = await loadPostHandler();
    const res = await POST(post({
      mintAddress: MINT, walletAddress: WALLET,
      lpCollateral: lp.toString(), insuranceAmount: INSURANCE.toString(),
    }));

    expect(res.status).toBe(200);
    expect(mintedAmount()).toBe(
      fundAmountFor(fundingRequirement(lp, INSURANCE)) - held,
    );
  });

  it("CONTROL: a caller that sends no amounts still gets funded, at the defaults", async () => {
    const POST = await loadPostHandler();
    const res = await POST(post({ mintAddress: MINT, walletAddress: WALLET }));

    expect(res.status).toBe(200);
    // 3,100 requirement -> 6,200 minted, not the pre-fix 3,200 (one backing bucket).
    expect(mintedAmount()).toBe(6_200n * T);
  });
});

describe("the balance is read before the 24h gate (H3 / GH#2335), in the route", () => {
  it("a sufficient balance is a 200 no-op that never touches the gate", async () => {
    // The gate is stubbed to REFUSE, so if the ordering is ever inverted this
    // returns 429 instead of 200. The neighbouring h3 file asserts this against
    // its own simulation; this asserts it against the route.
    const lp = 1_000n * T;
    getAccount.mockResolvedValue({ amount: fullMarketRequirement(lp, INSURANCE) });
    tryFaucetGate.mockResolvedValue({ allowed: false, nextClaimAt: "2026-01-01T00:00:00Z" });

    const POST = await loadPostHandler();
    const res = await POST(post({
      mintAddress: MINT, walletAddress: WALLET,
      lpCollateral: lp.toString(), insuranceAmount: INSURANCE.toString(),
    }));

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("sufficient");
    expect(tryFaucetGate).not.toHaveBeenCalled();
    expect(reserveClaim).not.toHaveBeenCalled();
    expect(createMintToInstruction).not.toHaveBeenCalled();
  });

  it("exactly at the requirement counts as sufficient", async () => {
    // Pins `>=` rather than `>`. One token below must fund.
    const lp = 1_000n * T;
    const requirement = fullMarketRequirement(lp, INSURANCE);

    getAccount.mockResolvedValue({ amount: requirement });
    const atLimit = await (await loadPostHandler())(post({
      mintAddress: MINT, walletAddress: WALLET,
      lpCollateral: lp.toString(), insuranceAmount: INSURANCE.toString(),
    }));
    expect((await atLimit.json()).status).toBe("sufficient");

    getAccount.mockResolvedValue({ amount: requirement - 1n });
    createMintToInstruction.mockClear();
    const oneBelow = await (await loadPostHandler())(post({
      mintAddress: MINT, walletAddress: WALLET,
      lpCollateral: lp.toString(), insuranceAmount: INSURANCE.toString(),
    }));
    expect((await oneBelow.json()).status).not.toBe("sufficient");
    expect(createMintToInstruction).toHaveBeenCalled();
  });

  it("REGRESSION: the mid-launch top-up is no longer refused", async () => {
    // THE bug. Pre-fix: wallet funded to 3,200, vault seed spent, 2,700 left,
    // step 4 needs 3,100 and asks for a top-up — and the route answered
    // "sufficient" because 2,700 >= its stale 1,600, minting nothing.
    const lp = 1_000n * T;
    getAccount.mockResolvedValue({ amount: 2_000n * T });

    const POST = await loadPostHandler();
    const res = await POST(post({
      mintAddress: MINT, walletAddress: WALLET,
      lpCollateral: lp.toString(), insuranceAmount: INSURANCE.toString(),
    }));

    expect((await res.json()).status).not.toBe("sufficient");
    expect(mintedAmount()).toBe(6_200n * T - 2_000n * T);
  });
});

describe("amounts that size a mint are refused, not coerced", () => {
  it("a malformed amount is a 400 and mints nothing", async () => {
    for (const bad of ["1.5", "-1", "1e9", "abc", "", " 100"]) {
      createMintToInstruction.mockClear();
      const POST = await loadPostHandler();
      const res = await POST(post({
        mintAddress: MINT, walletAddress: WALLET,
        lpCollateral: bad, insuranceAmount: INSURANCE.toString(),
      }));

      expect(res.status).toBe(400);
      expect(createMintToInstruction).not.toHaveBeenCalled();
    }
  });

  it("a launch above the faucet ceiling is refused, never part-funded", async () => {
    // Clamping to the ceiling would fund part-way and answer 200 — the defect
    // class this whole change is about.
    const POST = await loadPostHandler();
    const res = await POST(post({
      mintAddress: MINT, walletAddress: WALLET,
      lpCollateral: (100_000n * T).toString(), insuranceAmount: INSURANCE.toString(),
    }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.required).toBeDefined();
    expect(body.maxFundable).toBeDefined();
    expect(BigInt(body.required as string)).toBeGreaterThan(BigInt(body.maxFundable as string));
    expect(createMintToInstruction).not.toHaveBeenCalled();
    expect(tryFaucetGate).not.toHaveBeenCalled();
  });

  it("CONTROL: a large-but-allowed launch is funded, so the ceiling is not just 'no'", async () => {
    const lp = 3_000n * T;
    const POST = await loadPostHandler();
    const res = await POST(post({
      mintAddress: MINT, walletAddress: WALLET,
      lpCollateral: lp.toString(), insuranceAmount: INSURANCE.toString(),
    }));

    expect(res.status).toBe(200);
    expect(mintedAmount()).toBe(fundAmountFor(fundingRequirement(lp, INSURANCE)));
  });
});

describe("a request cannot shrink the funding target (GH#2592 security)", () => {
  it("lpCollateral 0 still funds a default launch, and does not strand the wallet", async () => {
    // The grief this closes: the caller does not prove ownership of
    // walletAddress and the 24h gate key is public, so `lpCollateral: "0"`
    // against a victim burnt their claim and minted them an amount too small to
    // launch with — blocking their own launch for 24h.
    const POST = await loadPostHandler();
    const res = await POST(post({
      mintAddress: MINT, walletAddress: WALLET,
      lpCollateral: "0", insuranceAmount: "0",
    }));

    expect(res.status).toBe(200);
    expect(mintedAmount()).toBe(6_200n * T);
  });

  it("CONTROL: a larger request still raises the target", async () => {
    const lp = 3_000n * T;
    const POST = await loadPostHandler();
    await POST(post({
      mintAddress: MINT, walletAddress: WALLET,
      lpCollateral: lp.toString(), insuranceAmount: INSURANCE.toString(),
    }));

    expect(mintedAmount()).toBeGreaterThan(6_200n * T);
  });
});

describe("the shared mint authority is bounded per IP", () => {
  it("a limited IP is refused before the 24h gate or any mint", async () => {
    // This was the only one of the five fund endpoints without a per-IP bound
    // (GH#2471's vector), and the mint is now request-derived.
    checkFundRateLimit.mockResolvedValue({ allowed: false, retryAfter: 30 });

    const POST = await loadPostHandler();
    const res = await POST(post({ mintAddress: MINT, walletAddress: WALLET }));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(tryFaucetGate).not.toHaveBeenCalled();
    expect(createMintToInstruction).not.toHaveBeenCalled();
  });

  it("CONTROL: a sufficient balance never spends IP budget", async () => {
    // The second in-launch call is a no-op and must not consume the IP bound.
    getAccount.mockResolvedValue({ amount: 10_000n * T });

    const POST = await loadPostHandler();
    const res = await POST(post({ mintAddress: MINT, walletAddress: WALLET }));

    expect((await res.json()).status).toBe("sufficient");
    expect(checkFundRateLimit).not.toHaveBeenCalled();
  });
});
