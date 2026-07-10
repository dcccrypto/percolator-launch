import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
  useSlabState: vi.fn(),
  sendTx: vi.fn(),
  isV17Account: vi.fn(),
  parsePortfolioV17: vi.fn(),
  deriveMatcherDelegate: vi.fn(),
  getLivePriceSnapshot: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: mocks.useConnectionCompat,
  useWalletCompat: mocks.useWalletCompat,
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: mocks.useSlabState,
}));

vi.mock("@/lib/tx", () => ({
  sendTx: mocks.sendTx,
}));

vi.mock("@/lib/programAllowlist", () => ({
  isKnownProgram: () => true,
  assertKnownProgram: () => {},
}));

vi.mock("@/lib/oraclePrice", () => ({
  detectOracleMode: () => "admin",
}));

vi.mock("@/lib/priceStore/priceStore", () => ({
  getLivePriceSnapshot: mocks.getLivePriceSnapshot,
}));

vi.mock("@percolatorct/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@percolatorct/sdk")>(
      "@percolatorct/sdk",
    );

  return {
    ...actual,
    isV17Account: mocks.isV17Account,
    parsePortfolioV17: mocks.parsePortfolioV17,
    deriveMatcherDelegate: mocks.deriveMatcherDelegate,
  };
});

import { useTrade } from "@/hooks/useTrade";

describe("useTrade v17 portfolio selection", () => {
  const slabAddress = "11111111111111111111111111111111";

  const walletPk = new PublicKey(
    new Uint8Array(32).fill(11),
  );

  const programId = new PublicKey(
    new Uint8Array(32).fill(12),
  );

  const lpPortfolioPk = new PublicKey(
    new Uint8Array(32).fill(13),
  );

  const lpOwner = new PublicKey(
    new Uint8Array(32).fill(14),
  );

  const matcherProgram = new PublicKey(
    new Uint8Array(32).fill(15),
  );

  const matcherContext = new PublicKey(
    new Uint8Array(32).fill(16),
  );

  const matcherDelegate = new PublicKey(
    new Uint8Array(32).fill(17),
  );

  const portfolioOne = new PublicKey(
    new Uint8Array(32).fill(21),
  );

  const portfolioTwo = new PublicKey(
    new Uint8Array(32).fill(22),
  );

  let connection: {
    getProgramAccounts: ReturnType<typeof vi.fn>;
    getAccountInfo: ReturnType<typeof vi.fn>;
  };

  function createLpPortfolioData(): Buffer {
    const data = Buffer.alloc(240);

    // readPortfolioOwner() reads provenance owner at offset 80.
    lpOwner.toBuffer().copy(data, 80);

    // PortfolioMatcherConfigV16 occupies the final 104 bytes.
    const matcherConfigOffset = data.length - 104;

    matcherProgram
      .toBuffer()
      .copy(data, matcherConfigOffset);

    matcherContext
      .toBuffer()
      .copy(data, matcherConfigOffset + 32);

    matcherDelegate
      .toBuffer()
      .copy(data, matcherConfigOffset + 64);

    // enabled = 1
    data.writeBigUInt64LE(
      1n,
      matcherConfigOffset + 96,
    );

    return data;
  }

  beforeEach(() => {
    vi.clearAllMocks();

    connection = {
      getProgramAccounts: vi.fn(),
      getAccountInfo: vi.fn().mockResolvedValue(null),
    };

    mocks.isV17Account.mockReturnValue(true);

    mocks.parsePortfolioV17.mockReturnValue({
      owner: walletPk,
      legs: [],
    });

    mocks.deriveMatcherDelegate.mockReturnValue([
      matcherDelegate,
      254,
    ]);

    mocks.getLivePriceSnapshot.mockReturnValue({
      priceUsd: 1.5,
      priceE6: 1_500_000n,
      price: 1.5,
      change24h: null,
      high24h: null,
      low24h: null,
      loading: false,
    });

    mocks.sendTx.mockResolvedValue({
      signature: "mock-signature",
    });

    mocks.useConnectionCompat.mockReturnValue({
      connection,
    });

    mocks.useWalletCompat.mockReturnValue({
      publicKey: walletPk,
      connected: true,
    });

    mocks.useSlabState.mockReturnValue({
      config: {
        oracleAuthority: PublicKey.default,
        indexFeedId: PublicKey.default,
        authorityPriceE6: 1_000_000n,
      },
      accounts: [],
      raw: Buffer.from([1]),
      programId,
      wrapperConfigV17: {
        oracleMode: 0,
      },
      refresh: vi.fn(),
      slabAddress,
    });
  });

  async function selectedAccountA(
    rpcPortfolioOrder: PublicKey[],
  ): Promise<PublicKey> {
    connection.getProgramAccounts
      // First GPA call: LP portfolio discovery.
      .mockResolvedValueOnce([
        {
          pubkey: lpPortfolioPk,
          account: {
            data: createLpPortfolioData(),
          },
        },
      ])
      // Second GPA call: taker portfolio discovery.
      .mockResolvedValueOnce(
        rpcPortfolioOrder.map((pubkey, index) => ({
          pubkey,
          account: {
            data: Buffer.from([index + 1]),
          },
        })),
      );

    mocks.sendTx.mockClear();

    const { result, unmount } = renderHook(() =>
      useTrade(slabAddress),
    );

    await act(async () => {
      await result.current.trade({
        lpIdx: 0,
        userIdx: 7,
        size: 1_000_000n,
      });
    });

    const sendCall = mocks.sendTx.mock.calls.at(-1)?.[0];

    expect(sendCall).toBeDefined();

    const instructions = sendCall.instructions as Array<{
      keys: Array<{ pubkey: PublicKey }>;
    }>;

    const tradeInstruction =
      instructions[instructions.length - 1];

    // TradeCpi account index 2 is accountA:
    // the taker's standalone v17 portfolio.
    const accountA = tradeInstruction.keys[2].pubkey;

    unmount();

    return accountA;
  }

  it("selects the canonical portfolio regardless of RPC result order", async () => {
    const ordered = [portfolioOne, portfolioTwo].sort(
      (a, b) =>
        a
          .toBase58()
          .localeCompare(b.toBase58()),
    );

    const canonicalPortfolio = ordered[0];
    const nonCanonicalPortfolio = ordered[1];

    const selectedFromReversedOrder =
      await selectedAccountA([
        nonCanonicalPortfolio,
        canonicalPortfolio,
      ]);

    const selectedFromCanonicalOrder =
      await selectedAccountA([
        canonicalPortfolio,
        nonCanonicalPortfolio,
      ]);

    // A deterministic client must submit the same portfolio regardless
    // of the array order returned by getProgramAccounts().
    expect(
      selectedFromReversedOrder.toBase58(),
    ).toBe(
      selectedFromCanonicalOrder.toBase58(),
    );

    expect(
      selectedFromCanonicalOrder.toBase58(),
    ).toBe(
      canonicalPortfolio.toBase58(),
    );
  });
});
