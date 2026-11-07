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

    getSignatureStatus =
      mocks.getSignatureStatus;

    sendRawTransaction =
      mocks.sendRawTransaction;
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

  process.env
    .NEXT_PUBLIC_DEFAULT_NETWORK =
    "devnet";

  delete process.env
    .NEXT_PUBLIC_SOLANA_NETWORK;

  mocks.tryFaucetGate.mockResolvedValue({
    allowed: true,
    nextClaimAt: null,
    claimId: 88,
  });

  mocks.releaseFaucetClaim
    .mockResolvedValue(undefined);

  mocks.analyticsInsert
    .mockResolvedValue({
      error: null,
    });

  mocks.analyticsFrom
    .mockReturnValue({
      insert: mocks.analyticsInsert,
    });

  /*
   * Return an existing ATA so the test remains
   * focused on confirmation-result handling.
   */
  mocks.getAssociatedTokenAddress
    .mockResolvedValue({
      toBase58: () =>
        "11111111111111111111111111111111",
    });

  mocks.getAccount
    .mockResolvedValue({});

  /*
   * A truthy mint account with short data skips
   * the unrelated mint-authority byte comparison.
   */
  mocks.getAccountInfo
    .mockResolvedValue({
      data: Buffer.alloc(0),
    });

  mocks.getLatestBlockhash
    .mockResolvedValue({
      blockhash:
        "test-blockhash",

      lastValidBlockHeight:
        12345,
    });

  mocks.sendRawTransaction
    .mockResolvedValue(
      "failed-on-chain-usdc-signature",
    );

  mocks.confirmTransaction
    .mockResolvedValue({
      context: {
        slot: 200,
      },

      value: {
        err: {
          InstructionError: [
            0,
            {
              Custom: 1,
            },
          ],
        },
      },
    });

  mocks.getDevnetMintSigner
    .mockReturnValue({
      publicKey: () =>
        "11111111111111111111111111111111",

      signTransaction:
        (transaction: unknown) =>
          transaction,
    });

  const route =
    await import(
      "@/app/api/faucet/route"
    );

  POST = route.POST;
});

afterEach(() => {
  delete process.env
    .NEXT_PUBLIC_DEFAULT_NETWORK;

  delete process.env
    .NEXT_PUBLIC_SOLANA_NETWORK;
});

describe(
  "POST /api/faucet USDC confirmation validation",
  () => {
    it(
      "must reject a USDC mint whose confirmation contains an on-chain execution error",
      async () => {
        const response =
          await POST(createRequest());

        const body =
          await response.json();

        expect(
          mocks.sendRawTransaction,
        ).toHaveBeenCalledTimes(1);

        expect(
          mocks.confirmTransaction,
        ).toHaveBeenCalledTimes(1);

        /*
         * Correct behavior:
         * value.err must prevent success recording.
         *
         * Current behavior is expected to return 200,
         * producing the RED regression failure.
         */
        expect(response.status)
          .toBe(500);

        expect(body.funded)
          .not.toBe(true);

        expect(body.usdc_minted)
          .not.toBe(true);
      },
    );

    it(
      "returns success when USDC confirmation contains no execution error",
      async () => {
        mocks.confirmTransaction
          .mockResolvedValueOnce({
            context: {
              slot: 201,
            },

            value: {
              err: null,
            },
          });

        const response =
          await POST(createRequest());

        const body =
          await response.json();

        expect(
          mocks.sendRawTransaction,
        ).toHaveBeenCalledTimes(1);

        expect(
          mocks.confirmTransaction,
        ).toHaveBeenCalledTimes(1);

        expect(response.status)
          .toBe(200);

        expect(body.funded)
          .toBe(true);

        expect(body.usdc_minted)
          .toBe(true);

        expect(body.signature)
          .toBe(
            "failed-on-chain-usdc-signature",
          );
      },
    );
  },
);

// The mint is sent and confirmTransaction throws. The claim is given back only when nothing was minted (the
// re-checked status has an error, or the tx is not found once its blockhash expired). Any other outcome is
// unknown: keep the claim and answer "on its way", or a retry mints a second 1,000 USDC.
describe("POST /api/faucet USDC: a confirm that throws keeps the claim unless nothing was minted", () => {
  const blockheightExpired = () => Object.assign(new Error("block height exceeded"), { name: "TransactionExpiredBlockheightExceededError" });
  const confirmThrows = (err: Error) => mocks.confirmTransaction.mockRejectedValueOnce(err);
  const status = (value: unknown) => mocks.getSignatureStatus.mockResolvedValueOnce({ context: { slot: 202 }, value });

  it("landed on re-check (confirmed, no error): success, the claim is spent", async () => {
    confirmThrows(blockheightExpired());
    status({ err: null, confirmationStatus: "confirmed" });
    const res = await POST(createRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).usdc_minted).toBe(true);
    expect(mocks.releaseFaucetClaim).not.toHaveBeenCalled();
  });

  it("landed with an error: nothing minted, the claim is released", async () => {
    confirmThrows(new Error("confirm failed"));
    status({ err: { InstructionError: [0, { Custom: 1 }] }, confirmationStatus: "confirmed" });
    const res = await POST(createRequest());
    expect(res.status).toBe(500);
    expect(mocks.releaseFaucetClaim).toHaveBeenCalledWith(expect.anything(), 88);
  });

  it("not found after the blockhash expired: it can never land, the claim is released", async () => {
    confirmThrows(blockheightExpired());
    status(null);
    const res = await POST(createRequest());
    expect(res.status).toBe(500);
    expect(mocks.releaseFaucetClaim).toHaveBeenCalledWith(expect.anything(), 88);
  });

  it.each([
    ["seen but only processed", () => { confirmThrows(new Error("timeout")); status({ err: null, confirmationStatus: "processed" }); }],
    ["not found, blockhash not expired (e.g. a 429 on confirm)", () => { confirmThrows(new Error("429 Too Many Requests")); status(null); }],
    ["the status re-check itself fails", () => { confirmThrows(new Error("timeout")); mocks.getSignatureStatus.mockRejectedValueOnce(new Error("fetch failed")); }],
  ])("%s: outcome unknown, the claim is kept and the reply says it is on its way", async (_name, arrange) => {
    arrange();
    const res = await POST(createRequest());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body).toMatchObject({ pending: true, retryable: false, signature: "failed-on-chain-usdc-signature" });
    expect(body.error).toMatch(/on its way but not confirmed yet/);
    expect(mocks.releaseFaucetClaim).not.toHaveBeenCalled();
  });
});
