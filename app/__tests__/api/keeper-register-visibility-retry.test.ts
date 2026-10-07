// @vitest-environment node
/**
 * keeper-register, "not visible yet" (issue percolator-indexer#223): the client registers the moment
 * the launch's last transaction confirms, often against a different RPC node than this route reads,
 * so the first read of the creation tx can be a slot behind. The route re-reads it a few times
 * in-request before answering 409, so the creator does not wait out the client's backoff.
 *  - tx absent on read 1, present on read 2 -> past auth (not 409), 2 reads;
 *  - CONTROL: with the grace off (KEEPER_REGISTER_PROOF_TRIES=0) the same sequence is a 409 after 1 read;
 *  - a tx that never shows -> 409 after 1 + tries reads (bounded);
 *  - a REFUSED proof (a memo for another pool) is never retried: 403 after 1 read.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

const prevNetwork = process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
afterAll(() => {
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK = prevNetwork;
});

const h = vi.hoisted(() => ({ txSeq: [] as unknown[], tx: null as unknown, programId: "", slabOwner: "", slabData: null as Buffer | null, rpcCalls: 0, txCalls: 0, logoCalls: 0 }));
const blobPut = vi.fn(async () => ({ url: "https://blob.invalid/x" }));

vi.mock("@vercel/blob", () => ({ put: blobPut, list: vi.fn(async () => ({ blobs: [] })), head: vi.fn(async () => null), del: vi.fn(async () => undefined) }));
vi.mock("@lib/supabase", () => ({}));
vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => "devnet",
  getServiceClient: () => ({ from: () => ({ upsert: vi.fn(async () => ({ error: null })), select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/config", async (orig) => {
  const m = await orig<{ getConfig: () => Record<string, unknown> }>();
  return { ...m, getConfig: () => ({ ...m.getConfig(), programId: h.programId }) };
});
vi.mock("@/lib/token-logo", () => ({ resolveTokenLogo: async () => { h.logoCalls++; return null; } }));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getAccountInfo: async (pk: PublicKey) => {
      h.rpcCalls++;
      return pk.toBase58() === SLAB_KP.publicKey.toBase58() ? { owner: new PublicKey(h.slabOwner || h.programId), data: h.slabData ?? V18_MARKET_HEADER } : null;
    },
    getTransaction: async () => {
      h.rpcCalls++;
      h.txCalls++;
      return h.txSeq.length > 0 ? h.txSeq.shift() : h.tx;
    },
  }),
}));

/** A v18 wrapper market account header: magic "PERCV16\0" u64 LE, version 18, kind 1. */
const V18_MARKET_HEADER = (() => {
  const b = Buffer.alloc(64);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0);
  b.writeUInt16LE(18, 8);
  b[10] = 1;
  return b;
})();
const SIG = bs58.encode(new Uint8Array(64).fill(3));
// Past auth the route classifies the pool on mainnet: stop there, deterministically.
vi.mock("@/lib/dex-pool-owner", async (orig) => ({ ...(await orig<object>()), classifyPoolsByOwner: vi.fn(async () => new Map()) }));

const { buildM1Instructions } = await import("@/lib/create-market-m1");
const { buildBatchTx } = await import("@/lib/tx");
const { buildKeeperRegisterMemoIx, keeperMemoParams } = await import("@/lib/keeper-register-memo");
const { buildV17InitMarketArgs } = await import("@/lib/create-market-args");
const { deriveMarketParams } = await import("@/lib/market-params");
const { POST } = await import("@/app/api/playground/keeper-register/route");

const SLAB_KP = Keypair.generate();
const CREATOR = Keypair.generate();
const POOL = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const REQ = { slabAddress: SLAB_KP.publicKey.toBase58(), dexPoolAddress: POOL, mainnetCA: null, dexType: "meteora-dlmm", symbol: "TEST" };

function landed(tx: Transaction) {
  const msg = tx.compileMessage();
  return {
    meta: { err: null },
    transaction: {
      message: {
        staticAccountKeys: msg.accountKeys,
        header: msg.header,
        compiledInstructions: msg.instructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accountKeyIndexes: ix.accounts, data: Buffer.from(bs58.decode(ix.data)) })),
      },
    },
  };
}

async function creatorM1(pool = POOL, signer = CREATOR) {
  const derived = deriveMarketParams(5, 1_000_000_000n, 1_000_000n);
  const k = () => Keypair.generate().publicKey;
  const ixs = buildM1Instructions({
    programId: new PublicKey(h.programId), wallet: signer.publicKey, slab: SLAB_KP.publicKey, mint: k(), vaultAta: k(), vaultPda: k(), nftRegistry: k(),
    slabRent: 1, slabSize: 3675, initArgs: buildV17InitMarketArgs({ initialPriceE6: 1_000_000n, tradingFeeBps: 30 }, derived),
    memo: await buildKeeperRegisterMemoIx(signer.publicKey, await keeperMemoParams({ ...REQ, dexPoolAddress: pool })),
  });
  const tx = buildBatchTx({ instructions: ixs, computeUnits: 400_000, priorityFeeMicroLamports: 1, blockhash: "11111111111111111111111111111111", feePayer: signer.publicKey });
  tx.sign(signer, SLAB_KP);
  return tx;
}

const post = (body: Record<string, unknown>) =>
  POST(new NextRequest("http://localhost/api/playground/keeper-register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...REQ, ...body }) }));


describe("keeper-register re-reads a creation tx this RPC node has not seen yet", () => {
  beforeEach(() => {
    h.programId = Keypair.generate().publicKey.toBase58();
    h.slabOwner = "";
    h.slabData = null;
    h.tx = null;
    h.txSeq = [];
    h.rpcCalls = 0;
    h.txCalls = 0;
    h.logoCalls = 0;
    process.env.KEEPER_REGISTER_PROOF_TRIES = "3";
    process.env.KEEPER_REGISTER_PROOF_POLL_MS = "1";
    blobPut.mockClear();
  });
  afterAll(() => {
    delete process.env.KEEPER_REGISTER_PROOF_TRIES;
  });

  it("absent on read 1, present on read 2 -> past auth, 2 reads", async () => {
    h.txSeq = [null, landed(await creatorM1())];
    const r = await post({ proofTx: SIG });
    expect(r.status).not.toBe(409);
    expect([401, 403]).not.toContain(r.status);
    expect(h.txCalls).toBe(2);
  });

  it("CONTROL: with the grace off the same sequence is a 409 after one read", async () => {
    process.env.KEEPER_REGISTER_PROOF_TRIES = "0";
    h.txSeq = [null, landed(await creatorM1())];
    const r = await post({ proofTx: SIG });
    expect(r.status).toBe(409);
    expect(h.txCalls).toBe(1);
  });

  it("a tx that never shows is a 409 after 1 + 3 reads (bounded, then the client's ladder takes over)", async () => {
    h.tx = null;
    const r = await post({ proofTx: SIG });
    expect(r.status).toBe(409);
    expect(h.txCalls).toBe(4);
    // the slab is read ONCE (owner + header), only getTransaction repeats: 1 + 4, not 4 full passes
    expect(h.rpcCalls).toBe(5);
  });

  it("a REFUSED proof is never retried: a memo for another pool is a 403 after one read", async () => {
    h.tx = landed(await creatorM1(Keypair.generate().publicKey.toBase58()));
    const r = await post({ proofTx: SIG });
    expect(r.status).toBe(403);
    expect(h.txCalls).toBe(1);
    expect(blobPut).not.toHaveBeenCalled();
  });
});

describe("keeper-register per-IP limiter", () => {
  it("40 requests a minute from one IP pass through to the RPC checks, the 41st is a retryable 429 with Retry-After; another IP is unaffected", async () => {
    h.programId = Keypair.generate().publicKey.toBase58();
    h.tx = null;
    h.txSeq = [];
    process.env.KEEPER_REGISTER_PROOF_TRIES = "0";
    const from = (ip: string) =>
      POST(new NextRequest("http://localhost/api/playground/keeper-register", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ ...REQ, proofTx: SIG }),
      }));
    h.rpcCalls = 0;
    for (let i = 0; i < 40; i++) expect((await from("203.0.113.9")).status).toBe(409);
    const callsAfter40 = h.rpcCalls;
    const limited = await from("203.0.113.9");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(h.rpcCalls).toBe(callsAfter40); // refused before any RPC
    expect((await from("203.0.113.10")).status).toBe(409); // CONTROL: the limit is per IP
  });
});
