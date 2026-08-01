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
  requestAirdrop: vi.fn(),
  confirmTransaction: vi.fn(),
  tryFaucetGate: vi.fn(),
  releaseFaucetClaim: vi.fn(),
  analyticsInsert: vi.fn(),
  analyticsFrom: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@solana/web3.js", () => {
  class PublicKey {
    constructor(private readonly value: string) {}

    toBase58(): string {
      return this.value;
    }

    equals(other: { toBase58?: () => string }): boolean {
      return other?.toBase58?.() === this.value;
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
    requestAirdrop = mocks.requestAirdrop;
    confirmTransaction = mocks.confirmTransaction;
  }

  return {
    Connection,
    PublicKey,
    Transaction,
    LAMPORTS_PER_SOL: 1_000_000_000,
  };
});

vi.mock("@solana/spl-token", () => ({
  getAssociatedTokenAddress: vi.fn(),
  createAssociatedTokenAccountInstruction: vi.fn(),
  createMintToInstruction: vi.fn(),
  getAccount: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    rpcUrl: "https://api.devnet.solana.com",
    testUsdcMint:
      "So11111111111111111111111111111111111111112",
  }),
}));

vi.mock("@/lib/devnet-signer", () => ({
  getDevnetMintSigner: vi.fn(() => null),
}));

vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => ({
    from: mocks.analyticsFrom,
  }),
}));

vi.mock("@/lib/faucet-rate-gate", () => ({
  tryFaucetGate: mocks.tryFaucetGate,
  releaseFaucetClaim: mocks.releaseFaucetClaim,
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: mocks.captureException,
}));

let POST: typeof import("@/app/api/faucet/route").POST;

function createRequest(): NextRequest {
  return new NextRequest("http://localhost/api/faucet", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      wallet:
        "11111111111111111111111111111111",
      type: "sol",
    }),
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();

  process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
  delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;

  mocks.tryFaucetGate.mockResolvedValue({
    allowed: true,
    nextClaimAt: null,
    claimId: 77,
  });

  mocks.releaseFaucetClaim.mockResolvedValue(undefined);

  mocks.analyticsInsert.mockResolvedValue({
    error: null,
  });

  mocks.analyticsFrom.mockReturnValue({
    insert: mocks.analyticsInsert,
  });

  mocks.requestAirdrop.mockResolvedValue(
    "failed-on-chain-airdrop-signature",
  );

  /**
   * Solana RPC confirmation resolves normally but reports that
   * transaction execution failed on-chain.
   *
   * confirmTransaction() does not need to throw for this condition.
   */
  mocks.confirmTransaction.mockResolvedValue({
    context: {
      slot: 123,
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

  const route =
    await import("@/app/api/faucet/route");

  POST = route.POST;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
  delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;
});

describe("POST /api/faucet confirmation result validation", () => {
  it("must reject a SOL airdrop whose confirmation contains an on-chain execution error", async () => {
    const response = await POST(createRequest());
    const body = await response.json();

    // Confirm that the test reached the vulnerable confirmation sink.
    expect(
      mocks.requestAirdrop,
    ).toHaveBeenCalledTimes(1);

    expect(
      mocks.confirmTransaction,
    ).toHaveBeenCalledTimes(1);

    /**
     * Correct behavior:
     *
     * A confirmation response containing value.err represents a
     * transaction that failed during on-chain execution. The route
     * must reject that result rather than returning funded=true.
     *
     * The affected implementation ignores value.err and returns 200.
     */
    expect(response.status).toBe(500);
    expect(body.funded).not.toBe(true);
    expect(body.sol_airdropped).not.toBe(true);
  });

  it("returns success when SOL confirmation contains no execution error", async () => {
    mocks.confirmTransaction.mockResolvedValueOnce({
      context: {
        slot: 124,
      },
      value: {
        err: null,
      },
    });

    const response = await POST(createRequest());
    const body = await response.json();

    expect(
      mocks.requestAirdrop,
    ).toHaveBeenCalledTimes(1);

    expect(
      mocks.confirmTransaction,
    ).toHaveBeenCalledTimes(1);

    expect(response.status).toBe(200);
    expect(body.funded).toBe(true);
    expect(body.sol_airdropped).toBe(true);
    expect(body.signature).toBe(
      "failed-on-chain-airdrop-signature",
    );
  });

});
