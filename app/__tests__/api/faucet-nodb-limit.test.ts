// R3 M8 (sibling route): /api/faucet type=usdc, the Fund-your-account modal's route, with no durable DB. Claims are read
// from chain history by content (10,000 mintTo to the ATA), see lib/sim-usdc-onchain-claim.ts.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  confirmTransaction: vi.fn(),
  getAccountInfo: vi.fn(),
  getSignaturesForAddress: vi.fn(),
  getParsedTransactions: vi.fn(),
  getLatestBlockhash: vi.fn(),
  sendRawTransaction: vi.fn(),

  getAssociatedTokenAddress: vi.fn(),
  getAccount: vi.fn(),

  getDevnetMintSigner: vi.fn(),

  tryFaucetGate: vi.fn(),
  releaseFaucetClaim: vi.fn(),

  analyticsInsert: vi.fn(),
  analyticsFrom: vi.fn(),

  captureException: vi.fn(),
}));

vi.mock("@solana/web3.js", () => {
  class PublicKey {
    // N4: the claim-marker derivation; a stable fake address is enough for these mocks.
    static async createWithSeed(_b: unknown, seed: string): Promise<PublicKey> {
      return new PublicKey(`marker-${seed}`);
    }
    constructor(
      private readonly value: unknown,
    ) {}

    toBase58(): string {
      return typeof this.value === "string"
        ? this.value
        : "11111111111111111111111111111111";
    }

    equals(
      other: { toBase58?: () => string },
    ): boolean {
      return (
        other?.toBase58?.() === this.toBase58()
      );
    }
  }

  class Transaction {
    recentBlockhash?: string;
    feePayer?: PublicKey;

    add(): this {
      return this;
    }

    serialize(): Buffer {
      return Buffer.from([]);
    }
  }

  class Connection {
    confirmTransaction =
      mocks.confirmTransaction;

    getAccountInfo =
      mocks.getAccountInfo;

    getSignaturesForAddress = mocks.getSignaturesForAddress;

    getParsedTransactions = mocks.getParsedTransactions;

    getLatestBlockhash =
      mocks.getLatestBlockhash;

    sendRawTransaction =
      mocks.sendRawTransaction;
  }

  const SystemProgram = { programId: new PublicKey('11111111111111111111111111111111'), createAccountWithSeed: () => ({}) };
  return {
    SystemProgram, Connection,
    PublicKey,
    Transaction,
    LAMPORTS_PER_SOL: 1_000_000_000,
  };
});

vi.mock("@solana/spl-token", () => ({
  getAssociatedTokenAddress:
    mocks.getAssociatedTokenAddress,

  createAssociatedTokenAccountInstruction:
    vi.fn(),

  createMintToInstruction:
    vi.fn(),

  getAccount:
    mocks.getAccount,
}));

// The route builds its connection with getServerConnection() (lib/server-rpc: DEVNET_RPC_URL + Origin).
// Unmocked, that returns a REAL Connection and the mocked RPC methods below are never called.
vi.mock("@/lib/server-rpc", async () => {
  const { Connection } = await import("@solana/web3.js");
  return { getServerConnection: () => new Connection() };
});

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    rpcUrl:
      "https://api.devnet.solana.com",

    testUsdcMint:
      "So11111111111111111111111111111111111111112",
  }),
}));

vi.mock("@/lib/devnet-signer", () => ({
  getDevnetMintSigner:
    mocks.getDevnetMintSigner,
}));

vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => ({
    from: mocks.analyticsFrom,
  }),
}));

vi.mock("@/lib/faucet-rate-gate", () => ({
  tryFaucetGate:
    mocks.tryFaucetGate,

  releaseFaucetClaim:
    mocks.releaseFaucetClaim,
}));

vi.mock("@sentry/nextjs", () => ({
  captureException:
    mocks.captureException,
}));

const MINT_AUTH = "11111111111111111111111111111111";
const DAY_MS = 24 * 60 * 60 * 1000;
let POST: typeof import("@/app/api/faucet/route").POST;

function req(type = "usdc"): NextRequest {
  return new NextRequest("http://localhost/api/faucet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: "WalletNoDbModal1111111111111111111111111111", type }),
  });
}
function newInstance() {
  delete (globalThis as unknown as Record<string, unknown>).__percolatorSimUsdcClaims__;
}
const ATA = 'Ata1';
function mintToIx(amount: string) {
  return { program: 'spl-token', parsed: { type: 'mintTo', info: { account: ATA, amount } } };
}

function chain() {
  const landed: { signature: string; blockTime: number; err: unknown }[] = [];
  mocks.sendRawTransaction.mockImplementation(async () => {
    const signature = `mint-sig-${landed.length + 1}`;
    landed.unshift({ signature, blockTime: Math.floor(Date.now() / 1000), err: null });
    return signature;
  });
  mocks.confirmTransaction.mockResolvedValue({ context: { slot: 1 }, value: { err: null } });
  mocks.getSignaturesForAddress.mockImplementation(async () => landed.map((l) => ({ ...l, slot: 1, memo: null })));
  mocks.getParsedTransactions.mockImplementation(async (sigs: string[]) =>
    sigs.map((sig) => ({
      transaction: {
        message: {
          accountKeys: [{ pubkey: { toBase58: () => MINT_AUTH } }],
          instructions: [mintToIx(sig.startsWith('autofund') ? '1000000000' : '10000000000')],
        },
      },
    })),
  );
  return landed;
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  newInstance();
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
  delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;
  mocks.tryFaucetGate.mockRejectedValue(new Error("Supabase env vars not set"));
  mocks.getAssociatedTokenAddress.mockResolvedValue({ toBase58: () => "Ata1" });
  mocks.getAccount.mockResolvedValue({});
  mocks.getAccountInfo.mockResolvedValue({ data: Buffer.alloc(0) });
  mocks.getLatestBlockhash.mockResolvedValue({ blockhash: "bh", lastValidBlockHeight: 1 });
  mocks.getDevnetMintSigner.mockReturnValue({ publicKey: () => MINT_AUTH, signTransaction: (t: unknown) => t, signMessage: () => new Uint8Array(64).fill(7) });
  POST = (await import("@/app/api/faucet/route")).POST;
});
afterEach(() => vi.restoreAllMocks());

describe("R3 M8: /api/faucet type=usdc keeps the daily limit with no durable DB", () => {
  it("first claim works; a second after a cold start is refused with the real next-claim time", async () => {
    const landed = chain();
    const first = await POST(req());
    expect(first.status).toBe(200);
    expect(mocks.sendRawTransaction).toHaveBeenCalledTimes(1);

    newInstance();
    const second = await POST(req());
    const body = await second.json();
    expect(second.status).toBe(429);
    expect(mocks.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(new Date(body.nextClaimAt).getTime()).toBe(landed[0].blockTime * 1000 + DAY_MS);
  });

  it("fails closed (503, nothing minted) when chain history cannot be read", async () => {
    chain();
    mocks.getSignaturesForAddress.mockRejectedValue(new Error("rpc down"));
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect((await res.json()).retryable).toBe(true);
    expect(mocks.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("a mint older than 24h does not block", async () => {
    const landed = chain();
    landed.unshift({ signature: "old", blockTime: Math.floor((Date.now() - DAY_MS - 3_600_000) / 1000), err: null });
    expect((await POST(req())).status).toBe(200);
  });
});

describe("R3 M8 (review H1/L1): content-based claim detection and honest failures", () => {
  it("an auto-fund mint (1,000, same fee payer) is NOT a claim: the first faucet claim still works", async () => {
    const landed = chain();
    landed.unshift({ signature: "autofund-1", blockTime: Math.floor(Date.now() / 1000), err: null });
    expect((await POST(req())).status).toBe(200);
    expect(mocks.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("a full in-window page it cannot decide is refused with honest, non-retryable copy", async () => {
    chain();
    const now = Math.floor(Date.now() / 1000);
    mocks.getSignaturesForAddress.mockImplementation(async () =>
      Array.from({ length: 40 }, (_, i) => ({ signature: `autofund-${i}`, blockTime: now - i, err: null, slot: 1, memo: null })),
    );
    const res = await POST(req());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.retryable).toBe(false);
    expect(body.error).not.toMatch(/try again in a moment/i);
    expect(mocks.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("with a healthy durable gate the chain is not queried", async () => {
    mocks.tryFaucetGate.mockResolvedValue({ allowed: true, nextClaimAt: null, claimId: 5 });
    chain();
    expect((await POST(req())).status).toBe(200);
    expect(mocks.getSignaturesForAddress).not.toHaveBeenCalled();
  });
});
