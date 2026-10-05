// @vitest-environment happy-dom
/**
 * Single-transaction launch, NEGATIVE CONTROL for the gate: whenever the gate is not "use" (v2.1 flag
 * off, NEXT_PUBLIC_LAUNCH_SINGLE_TX=off, or a wallet that does not advertise v1), create() must build
 * the SAME batched transactions, byte for byte, as the code before the single-tx launch existed.
 *
 * BASE_DIGEST was recorded by running THIS file unchanged on the base commit (feat/tx-v1-app
 * 179081bdc, before any single-tx code): deterministic keypairs, blockhash and co-sign tx, so the
 * digest of every message the wallet is asked to sign is a stable fingerprint of the batch.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

const BASE_DIGEST = process.env.SINGLE_TX_BASE_DIGEST_RECORD ? "" : "6:d60b3210773b5ba9081ad3a55f8b40ac8ba0712365754b6c093c3e9cdcb5f090";

const mocks = vi.hoisted(() => ({
  sendTx: vi.fn(),
  signAllCompat: vi.fn(),
  detect: vi.fn(async () => true),
  connection: null as unknown as Record<string, unknown>,
  wallet: null as unknown as Record<string, unknown>,
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: mocks.connection }),
  useWalletCompat: () => mocks.wallet,
}));
vi.mock("@/lib/tx", async (orig) => ({
  ...(await orig<typeof import("@/lib/tx")>()),
  sendTx: mocks.sendTx,
  signAllCompat: mocks.signAllCompat,
  getFreshBlockhash: vi.fn(async () => "GHtXQBpHnMXhoLGsryeDY7i6bGqTC2LGqS11Kf3rKmFS"),
  getPriorityFee: vi.fn(async () => 50_000),
  prewarmTxLanding: vi.fn(),
  presimulateOrThrow: vi.fn(async () => undefined),
}));
vi.mock("@/lib/v21/sdk", async (orig) => ({ ...(await orig<typeof import("@/lib/v21/sdk")>()), detectTxV1Support: mocks.detect }));
vi.mock("@/lib/inFlightMarket", () => ({
  saveInFlightMarket: vi.fn(),
  updateInFlightStep: vi.fn(),
  clearInFlightMarket: vi.fn(),
  loadLastInFlightMarket: vi.fn(() => null),
}));

import { useCreateMarket } from "@/hooks/useCreateMarket";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";

const seed = (n: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : (i * 7 + n) & 0xff));
const WALLET = Keypair.fromSeed(seed(201));
const KEEPER = Keypair.fromSeed(seed(202));
const MINT = new PublicKey("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC");
const POOL = Keypair.fromSeed(seed(203)).publicKey;

/** A deterministic legacy co-sign tx (the route's shape: payer = deployer, keeper partial-signed). */
function cosignTx(): Transaction {
  const tx = new Transaction();
  tx.recentBlockhash = "GHtXQBpHnMXhoLGsryeDY7i6bGqTC2LGqS11Kf3rKmFS";
  tx.feePayer = WALLET.publicKey;
  tx.add(new TransactionInstruction({ programId: new PublicKey(seed(204)), keys: [{ pubkey: WALLET.publicKey, isSigner: true, isWritable: false }, { pubkey: KEEPER.publicKey, isSigner: true, isWritable: false }], data: Buffer.from([1, 2, 3]) }));
  tx.partialSign(KEEPER);
  return tx;
}

function params() {
  return {
    mint: MINT,
    initialPriceE6: 1_000_000n,
    lpCollateral: 1_000_000_000n,
    insuranceAmount: 100_000_000n,
    oracleFeed: "0".repeat(64),
    invert: false,
    tradingFeeBps: 30,
    initialMarginBps: 2_000,
    decimals: 6,
    symbol: "TST",
    name: "Test",
    oracleMode: "keeper" as const,
    dexPoolAddress: POOL.toBase58(),
    dexType: "raydium-clmm",
    mainnetCA: POOL.toBase58(),
    p3: { juniorFloorBps: 2_000, juniorAtoms: 1_000_000_000n },
  };
}

let digests: string[] = [];
let generated = 0;

beforeEach(() => {
  vi.clearAllMocks();
  generated = 0;
  vi.spyOn(Keypair, "generate").mockImplementation(() => Keypair.fromSeed(seed(100 + generated++)));
  mocks.connection = {
    rpcEndpoint: "http://127.0.0.1:1",
    getAccountInfo: vi.fn(async () => null),
    getMinimumBalanceForRentExemption: vi.fn(async (n: number) => 1_000_000 + n),
    getBalance: vi.fn(async () => 50_000_000_000),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: "GHtXQBpHnMXhoLGsryeDY7i6bGqTC2LGqS11Kf3rKmFS", lastValidBlockHeight: 1_000 })),
  };
  mocks.wallet = {
    publicKey: WALLET.publicKey,
    connected: true,
    connecting: false,
    // An adapter that advertises only legacy + v0 (Phantom 26.31.0 shape).
    wallet: { adapter: { supportedTransactionVersions: new Set(["legacy", 0]), wallet: { accounts: [{ address: WALLET.publicKey.toBase58() }], features: { "solana:signTransaction": { supportedTransactionVersions: ["legacy", 0], signTransaction: vi.fn() } } } } },
    signTransaction: vi.fn(async (tx: Transaction) => tx),
    signAllTransactions: vi.fn(async (txs: Transaction[]) => txs),
    signMessage: undefined,
    disconnect: vi.fn(),
  };
  mocks.signAllCompat.mockImplementation(async (_w: unknown, txs: Transaction[]) => {
    const h = createHash("sha256");
    for (const tx of txs) h.update(Buffer.from(tx.serializeMessage()));
    digests.push(`${txs.length}:${h.digest("hex")}`);
    throw new Error("stop: captured the batch");
  });
  mocks.sendTx.mockRejectedValue(new Error("stop: sequential path reached"));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("keeper-cosign")) {
      return new Response(JSON.stringify({ partialTxBase64: cosignTx().serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), keeperPubkey: KEEPER.publicKey.toBase58() }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
  digests = [];
});
afterEach(() => {
  __setDevnetV21ForTest(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function launchDigest(): Promise<string> {
  const { result } = renderHook(() => useCreateMarket());
  await act(async () => {
    await result.current.create(params());
  });
  expect(digests).toHaveLength(1);
  return digests[0]!;
}

describe("single-tx launch gate closed => the batch is byte-identical to the base", () => {
  it("v2.1 flag off", async () => {
    __setDevnetV21ForTest(false);
    const d = await launchDigest();
    if (!BASE_DIGEST) writeFileSync(process.env.SINGLE_TX_BASE_DIGEST_RECORD!, d);
    else expect(d).toBe(BASE_DIGEST);
    // The batch is the P3 keeper launch: M1, co-sign, M3b, M4a, M4p, M4b.
    expect(d.startsWith("6:")).toBe(true);
    expect(mocks.detect).not.toHaveBeenCalled();
  });

  it("v2.1 flag on, NEXT_PUBLIC_LAUNCH_SINGLE_TX=off", async () => {
    __setDevnetV21ForTest(true);
    vi.stubEnv("NEXT_PUBLIC_LAUNCH_SINGLE_TX", "off");
    const d = await launchDigest();
    if (BASE_DIGEST) expect(d).toBe(BASE_DIGEST);
    expect(mocks.detect).not.toHaveBeenCalled();
  });

  it("v2.1 flag on, mode auto, wallet without v1 (legacy + v0 only)", async () => {
    __setDevnetV21ForTest(true);
    const d = await launchDigest();
    if (BASE_DIGEST) expect(d).toBe(BASE_DIGEST);
    // The wallet gate fails first, so the cluster is never even asked.
    expect(mocks.detect).not.toHaveBeenCalled();
  });
});
