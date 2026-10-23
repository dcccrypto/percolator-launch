/**
 * S3-C5 (fix-all 2026-10-18): /api/devnet-pre-fund mints with a server key, so it
 * must refuse unless the cluster is devnet. Before: an ALLOW_MIRROR_MINTS=true
 * constant bypassed the network gate, and the only endpoint check looked at
 * getConfig().rpcUrl, not the connection the mint is actually sent on.
 * Harness copied from devnet-pre-fund-route-requirement.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
const DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
let genesis: string | Error = DEVNET;
let senderEndpoint = "https://devnet.example/a";

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
      rpcEndpoint: senderEndpoint,
      getGenesisHash: async () => {
        if (genesis instanceof Error) throw genesis;
        return genesis;
      },
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


const ENV_KEYS = ["NEXT_PUBLIC_DEFAULT_NETWORK", "NEXT_PUBLIC_SOLANA_NETWORK"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  genesis = DEVNET;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const body = { mintAddress: MINT, walletAddress: WALLET };

describe("S3-C5 devnet-pre-fund refuses unless the cluster is devnet", () => {
  it("refuses (403, no mint) when no network is configured", async () => {
    delete process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
    delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;
    const POST = await loadPostHandler();
    const res = await POST(post(body));
    expect(res.status).toBe(403);
    expect(sendAndConfirmServerTx).not.toHaveBeenCalled();
  });

  it("refuses (403, no mint) on a mainnet deployment", async () => {
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "mainnet";
    const POST = await loadPostHandler();
    const res = await POST(post(body));
    expect(res.status).toBe(403);
    expect(sendAndConfirmServerTx).not.toHaveBeenCalled();
  });

  it("refuses when the SENDING connection's genesis hash is not devnet", async () => {
    genesis = MAINNET;
    senderEndpoint = "https://devnet.example/mainnet-mislabelled";
    const POST = await loadPostHandler();
    const res = await POST(post(body));
    expect(res.status).toBe(403);
    expect(sendAndConfirmServerTx).not.toHaveBeenCalled();
    expect(getAccount).not.toHaveBeenCalled();
  });

  it("refuses when the genesis hash cannot be read (unproven = refused)", async () => {
    genesis = new Error("rpc down");
    senderEndpoint = "https://devnet.example/down";
    const POST = await loadPostHandler();
    const res = await POST(post(body));
    expect(res.status).toBe(403);
    expect(sendAndConfirmServerTx).not.toHaveBeenCalled();
  });

  it("CONTROL: devnet network + devnet sender mints", async () => {
    senderEndpoint = "https://devnet.example/ok";
    const POST = await loadPostHandler();
    const res = await POST(post(body));
    expect(res.status).toBe(200);
    expect(sendAndConfirmServerTx).toHaveBeenCalledTimes(1);
  });
});
