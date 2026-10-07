/**
 * Audit #10: when the taker's maintenance crank goes out as its own tx and its confirmation
 * times out, the trade is never sent. The error must not carry the crank's signature, or the
 * order ticket would watch the crank and report the trade as landed.
 * Harness copied from useTrade.v17-portfolio-selection.test.ts.
 */
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

vi.mock("@/lib/taker-crank", () => ({ planTakerCrank: vi.fn(async () => "separate-tx") }));

vi.mock("@/lib/tx", async (orig) => ({
  timedOutSignature: (await orig<typeof import("@/lib/tx")>()).timedOutSignature,
  sendTx: mocks.sendTx,
  sendTxWaiting: mocks.sendTx,
  prewarmTxLanding: vi.fn(),
  simulateForGate: vi.fn(),
  SimulationRefusal: class SimulationRefusal extends Error {},
  buildBatchTx: vi.fn(),
  signAllCompat: vi.fn(),
  broadcastSignedTx: vi.fn(),
  getPriorityFee: vi.fn(),
}));

vi.mock("@/lib/market-lp", () => ({
  resolveMarketLp: vi.fn(async () => ({
    pubkey: new PublicKey(new Uint8Array(32).fill(13)),
    data: new Uint8Array(0),
    owner: new PublicKey(new Uint8Array(32).fill(14)),
    portfolioId: 1n,
    matcherProg: new PublicKey(new Uint8Array(32).fill(15)),
    matcherCtx: new PublicKey(new Uint8Array(32).fill(16)),
    matcherDelegate: new PublicKey(new Uint8Array(32).fill(17)),
    reason: "asset-admin",
  })),
}));

vi.mock("@/lib/v18-wire", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  fetchPortfolioIdentity: vi.fn(async () => ({ portfolioId: 2n, matcherSequence: 0n, positionEpoch: 0n })),
  fetchAssetMarketId: vi.fn(async () => 1n),
}));

vi.mock("@/lib/programAllowlist", () => ({
  isKnownProgram: () => true,
  assertKnownProgram: () => {},
  // #2381: useTrade now pins the CPI matcher via assertCanonicalMatcher — stub it
  // (like assertKnownProgram) so this portfolio-selection test isn't coupled to the
  // canonical-matcher check (which has its own dedicated coverage).
  assertCanonicalMatcher: () => {},
}));

vi.mock("@/lib/oraclePrice", () => ({
  detectOracleMode: () => "admin",
  // GH#2525: useTrade now cross-checks the off-chain feed against the on-chain
  // price before deriving a slippage limit. Returning the same $1.00 the slab
  // fixture carries keeps this suite focused on portfolio selection instead of
  // tripping that guard.
  resolveMarketPriceE6: () => 1_000_000n,
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
    // A real v18 portfolio: full length, header kind byte [10] = 2 (F-3), and the 104-byte
    // PortfolioMatcherConfigV16 sits before the 24-byte identity trailer.
    const data = Buffer.alloc(9563);
    data[10] = 2;

    // readPortfolioOwner() reads provenance owner at offset 80.
    lpOwner.toBuffer().copy(data, 80);

    const matcherConfigOffset = data.length - 104 - 24;

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

    // GH#2525: the off-chain feed must sit within 200 bps of the on-chain
    // price (authorityPriceE6: 1_000_000n below), or the derived slippage
    // limit is refused. This fixture used $1.50 against an on-chain $1.00 — a
    // 50% divergence no real market shows. These tests are about PORTFOLIO
    // SELECTION, so the price is incidental; it is aligned rather than the
    // guard being loosened for them.
    mocks.getLivePriceSnapshot.mockReturnValue({
      priceUsd: 1.0,
      priceE6: 1_000_000n,
      price: 1.0,
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

  it("a crank confirmation timeout does not surface as a trade signature to watch", async () => {
    const { timedOutSignature } = await vi.importActual<typeof import("@/lib/tx")>("@/lib/tx");
    const crankSig = "5".repeat(88);
    connection.getProgramAccounts.mockResolvedValueOnce([
      { pubkey: portfolioOne, account: { data: Buffer.from([1]) } },
    ]);
    connection.getAccountInfo.mockResolvedValue({ data: Buffer.from([1]) });
    mocks.parsePortfolioV17.mockReturnValue({ owner: walletPk, legs: [{ active: true }] });
    mocks.sendTx.mockRejectedValueOnce(
      new Error(`Confirmation timeout (90s) — tx may still land. Check explorer: ${crankSig}`),
    );

    const { result, unmount } = renderHook(() => useTrade(new PublicKey(new Uint8Array(32).fill(41)).toBase58()));
    let err: unknown;
    await act(async () => {
      err = await result.current.trade({ lpIdx: 0, userIdx: 7, size: 1_000_000n }).then(() => null, (e) => e);
    });

    expect(mocks.sendTx).toHaveBeenCalledTimes(1); // the crank only; the trade never went out
    expect(err).toBeInstanceOf(Error);
    expect(timedOutSignature(err)).toBeNull();
    unmount();
  });
});
