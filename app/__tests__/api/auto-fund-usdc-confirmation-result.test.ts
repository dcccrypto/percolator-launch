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
  getBalance: vi.fn(),
  getTokenAccountBalance: vi.fn(),
  getLatestBlockhash: vi.fn(),
  sendRawTransaction: vi.fn(),
  confirmTransaction: vi.fn(),

  getAssociatedTokenAddress: vi.fn(),
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
    getBalance =
      mocks.getBalance;

    getTokenAccountBalance =
      mocks.getTokenAccountBalance;

    getLatestBlockhash =
      mocks.getLatestBlockhash;

    sendRawTransaction =
      mocks.sendRawTransaction;

    confirmTransaction =
      mocks.confirmTransaction;
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
    "@/app/api/auto-fund/route"
  ).POST;

function createRequest(): NextRequest {
  return new NextRequest(
    "http://localhost/api/auto-fund",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json",
      },
      body: JSON.stringify({
        wallet:
          "11111111111111111111111111111111",
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

  mocks.tryFaucetGate
    .mockResolvedValue({
      allowed: true,
      nextClaimAt: null,
      claimId: 99,
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
   * Skip the SOL airdrop path so this test remains
   * focused on Auto-fund USDC confirmation handling.
   */
  mocks.getBalance
    .mockResolvedValue(
      1_000_000_000,
    );

  mocks.getAssociatedTokenAddress
    .mockResolvedValue({
      toBase58: () =>
        "11111111111111111111111111111111",
    });

  /*
   * First call: wallet has less than 1 USDC,
   * therefore a mint is required.
   *
   * Second call: ATA exists, so no ATA-create
   * instruction is needed.
   */
  mocks.getTokenAccountBalance
    .mockResolvedValue({
      value: {
        uiAmount: 0,
      },
    });

  mocks.getLatestBlockhash
    .mockResolvedValue({
      blockhash:
        "auto-fund-test-blockhash",

      lastValidBlockHeight:
        54321,
    });

  mocks.sendRawTransaction
    .mockResolvedValue(
      "failed-on-chain-auto-fund-usdc-signature",
    );

  mocks.confirmTransaction
    .mockResolvedValue({
      context: {
        slot: 300,
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
      "@/app/api/auto-fund/route"
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
  "POST /api/auto-fund USDC confirmation validation",
  () => {
    it(
      "must not report USDC funding when confirmation contains an on-chain execution error",
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
         * Auto-fund treats mint failures as non-fatal, so the
         * corrected route may still return HTTP 200.
         *
         * The important invariant is that failed execution
         * must not be recorded or returned as funded.
         */
        expect(body.funded)
          .toBe(false);

        expect(body.usdc_minted)
          .toBe(false);

        expect(
          mocks.releaseFaucetClaim,
        ).toHaveBeenCalledWith(
          expect.anything(),
          99,
        );

        expect(
          mocks.analyticsInsert,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      "returns USDC funding success when confirmation contains no execution error",
      async () => {
        mocks.confirmTransaction
          .mockResolvedValueOnce({
            context: {
              slot: 301,
            },

            value: {
              err: null,
            },
          });

        const response =
          await POST(createRequest());

        const body =
          await response.json();

        expect(response.status)
          .toBe(200);

        expect(
          mocks.sendRawTransaction,
        ).toHaveBeenCalledTimes(1);

        expect(
          mocks.confirmTransaction,
        ).toHaveBeenCalledTimes(1);

        expect(body.funded)
          .toBe(true);

        expect(body.usdc_minted)
          .toBe(true);

        expect(body.usdc_amount)
          .toBe(1000);
      },
    );
  },
);
