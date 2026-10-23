// @vitest-environment node

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  Connection,
  Keypair,
  Transaction,
} from "@solana/web3.js";
import { NextRequest } from "next/server";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { v22MarketBytes } from "../helpers/v22-fixtures";

const state = vi.hoisted(() => ({
  keeper: null as Keypair | null,
  partialSign: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  getRpcEndpoint: vi.fn(
    () => "http://127.0.0.1:8899",
  ),
  // getServerConnection() (lib/server-rpc) calls getNetwork() to pick the
  // cluster; without it every request 500'd and these tests could not run.
  getNetwork: vi.fn(() => "devnet"),
  getConfig: vi.fn(() => ({
    programId:
      "11111111111111111111111111111111",
  })),
}));

vi.mock("@/lib/playground-keeper-signer", () => ({
  requirePlaygroundKeeperSigner: () => {
    if (!state.keeper) {
      throw new Error(
        "Test keeper was not initialized",
      );
    }

    return {
      publicKey: () =>
        state.keeper!.publicKey.toBase58(),
      partialSign: state.partialSign,
    };
  },
}));

const originalDefaultNetwork =
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK;

const originalSolanaNetwork =
  process.env.NEXT_PUBLIC_SOLANA_NETWORK;

let POST: (
  request: NextRequest,
) => Promise<Response>;

function buildCosignRequest(
  deployer: string,
): NextRequest {
  return new NextRequest(
    "http://localhost/api/playground/keeper-cosign",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deployer,
        slabAddress:
          Keypair.generate().publicKey.toBase58(),
        initialPriceE6: "1000000",
        assetIndex: 0,
      }),
    },
  );
}

describe("keeper-cosign signer-role separation", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK =
      "devnet";

    delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;

    vi.spyOn(
      Connection.prototype,
      "getSlot",
    );

    vi.spyOn(
      Connection.prototype,
      "getLatestBlockhash",
    );
    // v18: the route reads asset 0's market_id + control sequences from the
    // slab. Unmocked, this was a real network call.
    vi.spyOn(
      Connection.prototype,
      "getAccountInfo",
    );

    ({ POST } = await import(
      "@/app/api/playground/keeper-cosign/route"
    ));
  });

  beforeEach(() => {
    vi.clearAllMocks();

    state.keeper = Keypair.generate();

    state.partialSign.mockImplementation(
      (tx: Transaction) => {
        tx.partialSign(state.keeper!);
      },
    );

    vi.mocked(
      Connection.prototype.getSlot,
    ).mockResolvedValue(123456);

    vi.mocked(
      Connection.prototype.getLatestBlockhash,
    ).mockResolvedValue({
      blockhash:
        Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 999999,
    });
    // Flag off: a zeroed market at a live slab's size (the v18 readers see asset 0 with market_id 0 and both control lanes at 0).
    // Flag on the readers are VERSION-keyed and refuse zeros, so the market is the captured v2.2 (VERSION 19) one-slot account.
    vi.mocked(
      Connection.prototype.getAccountInfo,
    ).mockResolvedValue({
      data: isDevnetV22Enabled() ? Buffer.from(v22MarketBytes()) : Buffer.alloc(24_600),
      executable: false,
      lamports: 1,
      owner: Keypair.generate().publicKey,
      rentEpoch: 0,
    });
  });

  afterAll(() => {
    vi.restoreAllMocks();

    if (originalDefaultNetwork === undefined) {
      delete process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
    } else {
      process.env.NEXT_PUBLIC_DEFAULT_NETWORK =
        originalDefaultNetwork;
    }

    if (originalSolanaNetwork === undefined) {
      delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;
    } else {
      process.env.NEXT_PUBLIC_SOLANA_NETWORK =
        originalSolanaNetwork;
    }
  });

  it("rejects deployer equal to the server keeper before RPC or signing", async () => {
    const keeper = state.keeper;
    expect(keeper).not.toBeNull();

    const response = await POST(
      buildCosignRequest(
        keeper!.publicKey.toBase58(),
      ),
    );

    const payload = (await response.json()) as {
      error?: string;
    };

    expect(response.status).toBe(400);

    expect(payload).toEqual({
      error:
        "deployer must be distinct from keeper",
    });

    expect(
      Connection.prototype.getSlot,
    ).not.toHaveBeenCalled();

    expect(
      Connection.prototype.getLatestBlockhash,
    ).not.toHaveBeenCalled();

    expect(
      state.partialSign,
    ).not.toHaveBeenCalled();
  });

  it("preserves the normal partial-signing flow for a distinct deployer", async () => {
    const keeper = state.keeper;
    expect(keeper).not.toBeNull();

    const deployer =
      Keypair.generate().publicKey;

    expect(
      deployer.equals(keeper!.publicKey),
    ).toBe(false);

    const response = await POST(
      buildCosignRequest(
        deployer.toBase58(),
      ),
    );

    const payload = (await response.json()) as {
      partialTxBase64?: string;
      keeperPubkey?: string;
      nowSlot?: string;
      error?: string;
      detail?: string;
    };

    expect(
      response.status,
      JSON.stringify(payload),
    ).toBe(200);

    expect(payload).toMatchObject({
      keeperPubkey:
        keeper!.publicKey.toBase58(),
      nowSlot: "123456",
    });

    expect(payload.partialTxBase64).toEqual(
      expect.any(String),
    );

    expect(
      Connection.prototype.getSlot,
    ).toHaveBeenCalledOnce();

    expect(
      Connection.prototype.getLatestBlockhash,
    ).toHaveBeenCalledOnce();

    expect(
      state.partialSign,
    ).toHaveBeenCalledOnce();

    const tx = Transaction.from(
      Buffer.from(
        payload.partialTxBase64!,
        "base64",
      ),
    );

    const deployerSignature =
      tx.signatures.find(({ publicKey }) =>
        publicKey.equals(deployer),
      );

    const keeperSignature =
      tx.signatures.find(({ publicKey }) =>
        publicKey.equals(
          keeper!.publicKey,
        ),
      );

    expect(deployerSignature).toBeDefined();

    expect(
      deployerSignature?.signature,
    ).toBeNull();

    expect(keeperSignature).toBeDefined();

    expect(
      keeperSignature?.signature,
    ).not.toBeNull();

    expect(
      tx.verifySignatures(),
    ).toBe(false);
  });
});
