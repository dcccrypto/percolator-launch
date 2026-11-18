// @vitest-environment node
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
  getSignatureStatus: vi.fn(),
  getAccountInfo: vi.fn(),
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

    getLatestBlockhash =
      mocks.getLatestBlockhash;

    sendRawTransaction =
      mocks.sendRawTransaction;

    getSignatureStatus =
      mocks.getSignatureStatus;
  }

  return {
    Connection,
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

let POST:
  typeof import(
    "@/app/api/faucet/route"
  ).POST;

function createRequest(): NextRequest {
  return new NextRequest(
    "http://localhost/api/faucet",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json",
      },
      body: JSON.stringify({
        wallet:
          "11111111111111111111111111111111",

        type: "usdc",
      }),
    },
  );
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
  delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;
  mocks.tryFaucetGate.mockResolvedValue({ allowed: true, nextClaimAt: null, claimId: 88 });
  mocks.releaseFaucetClaim.mockResolvedValue(undefined);
  mocks.analyticsInsert.mockResolvedValue({ error: null });
  mocks.analyticsFrom.mockReturnValue({ insert: mocks.analyticsInsert });
  mocks.getAssociatedTokenAddress.mockResolvedValue({ toBase58: () => "11111111111111111111111111111111" });
  mocks.getAccount.mockResolvedValue({});
  mocks.getAccountInfo.mockResolvedValue({ data: Buffer.alloc(0) });
  mocks.getLatestBlockhash.mockResolvedValue({ blockhash: "test-blockhash", lastValidBlockHeight: 12345 });
  mocks.sendRawTransaction.mockResolvedValue("sent-usdc-signature");
  mocks.confirmTransaction.mockRejectedValue(new Error("confirm threw"));
  mocks.getDevnetMintSigner.mockReturnValue({
    publicKey: () => "11111111111111111111111111111111",
    signTransaction: (transaction: unknown) => transaction,
  });
  POST = (await import("@/app/api/faucet/route")).POST;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
});

// #3757: the claim is released only when nothing can have been minted (the e665b92b rule).
describe("POST /api/faucet USDC: a confirm that throws after the mint was sent", () => {
  const expectKept = async () => {
    const response = await POST(createRequest());
    const body = await response.json();
    expect(mocks.releaseFaucetClaim).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(body.pending).toBe(true);
    expect(body.error).not.toMatch(/nothing was sent/i);
    expect(body.signature).toBe("sent-usdc-signature");
  };

  it("keeps the claim when the signature is only processed", async () => {
    mocks.getSignatureStatus.mockResolvedValue({ value: { err: null, confirmationStatus: "processed" } });
    await expectKept();
  });

  it("keeps the claim when there is no status yet and the blockhash has not expired", async () => {
    mocks.getSignatureStatus.mockResolvedValue({ value: null });
    await expectKept();
  });

  it("keeps the claim when the re-check itself throws", async () => {
    mocks.getSignatureStatus.mockRejectedValue(new Error("429"));
    await expectKept();
  });

  it("releases the claim when the signature landed with an error", async () => {
    mocks.getSignatureStatus.mockResolvedValue({ value: { err: { InstructionError: [0, { Custom: 1 }] }, confirmationStatus: "confirmed" } });
    const response = await POST(createRequest());
    expect(response.status).toBe(500);
    expect(mocks.releaseFaucetClaim).toHaveBeenCalled(); // also fires from the outer catch (a no-op by id)
  });

  it("releases the claim when the signature is not found and the blockhash expired", async () => {
    const e = new Error("expired");
    e.name = "TransactionExpiredBlockheightExceededError";
    mocks.confirmTransaction.mockRejectedValue(e);
    mocks.getSignatureStatus.mockResolvedValue({ value: null });
    const response = await POST(createRequest());
    expect(response.status).toBe(500);
    expect(mocks.releaseFaucetClaim).toHaveBeenCalled();
  });

  it("still succeeds when the re-check shows it landed", async () => {
    mocks.getSignatureStatus.mockResolvedValue({ value: { err: null, confirmationStatus: "confirmed" } });
    const response = await POST(createRequest());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.usdc_minted).toBe(true);
    expect(mocks.releaseFaucetClaim).not.toHaveBeenCalled();
  });
});
