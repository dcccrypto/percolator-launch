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
