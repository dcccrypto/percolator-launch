/**
 * Taker (accountA) portfolio selection in useTrade.
 *
 * 2026-10-02 (fix/preexisting-test-failures): since 18526d86 the LP side (accountB) is
 * resolved by on-chain identity in lib/market-lp.ts (its own suite, incl. a negative
 * control) — it reads the market + ctx accounts, which this suite never served, so the
 * resolver is stubbed here and the ONLY program scan left is the taker's owner scan.
 * The v17 trade is sent with sendTxWaiting (not sendTx) and binds both portfolios'
 * identity via lib/v18-wire (0d975d00) — stubbed as well. Since F-3 (fb7700c6) an
 * "LP-shaped" account must be a full portfolio (kind 2, 9,563 B) to count as an LP.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { comparePortfolioPubkeys } from "@/lib/owner-portfolio";

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

  async function selectedAccountA(
    rpcPortfolioOrder: PublicKey[],
  ): Promise<PublicKey> {
    connection.getProgramAccounts
      // The only GPA call: taker portfolio discovery (the LP is resolved by identity).
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

  describe("explicit target portfolio (#2560 F1): act on exactly the chosen account, or refuse", () => {
    // Fresh slabs so the 60s v17TradeAccountsCache can't serve a prior test.
    const targetUsedSlab = new PublicKey(new Uint8Array(32).fill(41)).toBase58();
    const targetSubstitutionSlab = new PublicKey(new Uint8Array(32).fill(42)).toBase58();

    it("uses an explicit target that verifies as owned as accountA", async () => {
      const ordered = [portfolioOne, portfolioTwo].sort(comparePortfolioPubkeys);
      const canonical = ordered[0];
      const target = ordered[1]; // the NON-canonical one — proves the target wins over the pick
      // The direct read of the target returns an owned account (parsePortfolioV17
      // mock → owner = walletPk), so the verify passes and the target is used.
      mocks.parsePortfolioV17.mockReturnValue({ owner: walletPk, legs: [], marketGroupId: new PublicKey(targetUsedSlab) });
      connection.getAccountInfo.mockImplementation(async (pk: PublicKey) =>
        pk.equals(target) ? { owner: programId, data: Buffer.from([9]) } : null,
      );
      connection.getProgramAccounts.mockResolvedValueOnce([
        { pubkey: canonical, account: { data: Buffer.from([1]) } },
        { pubkey: target, account: { data: Buffer.from([2]) } },
      ]);

      const { result, unmount } = renderHook(() => useTrade(targetUsedSlab));
      await act(async () => {
        await result.current.trade({ lpIdx: 0, userIdx: 7, size: 1_000_000n, portfolioPk: target });
      });
      const sendCall = mocks.sendTx.mock.calls.at(-1)?.[0];
      const instructions = sendCall.instructions as Array<{ keys: Array<{ pubkey: PublicKey }> }>;
      const accountA = instructions[instructions.length - 1].keys[2].pubkey;
      expect(accountA.equals(target)).toBe(true);
      expect(accountA.equals(canonical)).toBe(false);
      unmount();
    });

    it("REFUSES rather than substituting a different owned portfolio when the target can't be confirmed", async () => {
      const ordered = [portfolioOne, portfolioTwo].sort(comparePortfolioPubkeys);
      const canonical = ordered[0];
      const target = ordered[1]; // non-canonical target
      // The target's direct read lags (null) — getAccountInfo default. The
      // fallback resolves the canonical pick (≠ target), so the guard must throw
      // instead of trading against `canonical`.
      connection.getAccountInfo.mockResolvedValue(null);
      connection.getProgramAccounts.mockResolvedValueOnce([
        { pubkey: canonical, account: { data: Buffer.from([1]) } },
        { pubkey: target, account: { data: Buffer.from([2]) } },
      ]);

      const { result, unmount } = renderHook(() => useTrade(targetSubstitutionSlab));
      await act(async () => {
        await expect(
          result.current.trade({ lpIdx: 0, userIdx: 7, size: 1_000_000n, portfolioPk: target }),
        ).rejects.toThrow("Couldn't confirm the selected portfolio");
      });
      // And nothing was sent.
      expect(mocks.sendTx).not.toHaveBeenCalled();
      unmount();
    });
  });

  describe("explicit target must be the program's, this wallet's and THIS market's (#2560 review)", () => {
    const slabs = [51, 52, 53].map((n) => new PublicKey(new Uint8Array(32).fill(n)).toBase58());
    const cases: [string, string, (slab: string) => { owner: PublicKey; parsed: Record<string, unknown> }][] = [
      ["owned by another program", slabs[0], (slab) => ({ owner: matcherProgram, parsed: { owner: walletPk, legs: [], marketGroupId: new PublicKey(slab) } })],
      ["a portfolio of ANOTHER market", slabs[1], () => ({ owner: programId, parsed: { owner: walletPk, legs: [], marketGroupId: new PublicKey(new Uint8Array(32).fill(99)) } })],
      ["a portfolio of another wallet", slabs[2], (slab) => ({ owner: programId, parsed: { owner: lpOwner, legs: [], marketGroupId: new PublicKey(slab) } })],
    ];
    for (const [name, slab, build] of cases) {
      it(`REFUSES a target that is ${name} (and would otherwise substitute the canonical pick)`, async () => {
        const ordered = [portfolioOne, portfolioTwo].sort(comparePortfolioPubkeys);
        const canonical = ordered[0];
        const target = ordered[1];
        const { owner, parsed } = build(slab);
        // the target's bytes (first byte 9) decode as `parsed`; the canonical pick's decode as the wallet's own
        mocks.parsePortfolioV17.mockImplementation((d: Uint8Array) => (d[0] === 9 ? parsed : { owner: walletPk, legs: [] }));
        connection.getAccountInfo.mockImplementation(async (pk: PublicKey) => (pk.equals(target) ? { owner, data: Buffer.from([9]) } : null));
        connection.getProgramAccounts.mockResolvedValueOnce([{ pubkey: canonical, account: { data: Buffer.from([1]) } }]);
        const { result, unmount } = renderHook(() => useTrade(slab));
        await act(async () => {
          await expect(result.current.trade({ lpIdx: 0, userIdx: 7, size: 1_000_000n, portfolioPk: target })).rejects.toThrow("Couldn't confirm the selected portfolio");
        });
        expect(mocks.sendTx).not.toHaveBeenCalled();
        unmount();
      });
    }
  });

  describe("LP-portfolio exclusion (GH bug: market creator's LP mistaken for their own trading account)", () => {
    /** A portfolio buffer whose trailing PortfolioMatcherConfigV16 is
     *  enabled — same LP shape as createLpPortfolioData, but returned from
     *  the TAKER's own owner+market scan (findV17Portfolio / accountA),
     *  simulating a market CREATOR whose wallet is also the LP's owner. */
    function createOwnerScanLpShapedData(): Buffer {
      return createLpPortfolioData();
    }

    // useTrade caches resolved trade accounts per (programId, slabPk, taker)
    // for 60s (v17TradeAccountsCache) — reusing the describe-level
    // `slabAddress` here would silently hit the cache populated by the
    // "selects the canonical portfolio..." tests above and skip the fresh
    // GPA mocks entirely. Each test below uses its own throwaway slab
    // address (independent of useSlabState's mocked `programId`, which
    // isn't part of the cache lookup that matters here since `slabPk` is
    // derived from this argument) to guarantee a cache miss.
    const lpMistakenForOwnSlab = new PublicKey(new Uint8Array(32).fill(31)).toBase58();
    const lpAndGenuineBothMatchSlab = new PublicKey(new Uint8Array(32).fill(32)).toBase58();

    it("never resolves accountA to the market's own LP portfolio, even when it matches the owner+market filter", async () => {
      connection.getProgramAccounts
        // Taker portfolio discovery (accountA) — the ONLY
        // match is the market's own LP (this wallet is the creator, whose
        // wallet is the LP's mutable owner too).
        .mockResolvedValueOnce([
          { pubkey: portfolioOne, account: { data: createOwnerScanLpShapedData() } },
        ]);

      const { result, unmount } = renderHook(() => useTrade(lpMistakenForOwnSlab));

      await act(async () => {
        await expect(
          result.current.trade({ lpIdx: 0, userIdx: 7, size: 1_000_000n }),
        ).rejects.toThrow("No portfolio account found for your wallet on this market");
      });

      unmount();
    });

    it("selects the genuine (non-LP) portfolio when both it and the LP-shaped one match the owner+market filter", async () => {
      connection.getProgramAccounts
        .mockResolvedValueOnce([
          { pubkey: portfolioOne, account: { data: createOwnerScanLpShapedData() } },
          { pubkey: portfolioTwo, account: { data: Buffer.from([1]) } }, // genuine, non-LP-shaped
        ]);

      const { result, unmount } = renderHook(() => useTrade(lpAndGenuineBothMatchSlab));

      await act(async () => {
        await result.current.trade({ lpIdx: 0, userIdx: 7, size: 1_000_000n });
      });

      const sendCall = mocks.sendTx.mock.calls.at(-1)?.[0];
      const instructions = sendCall.instructions as Array<{ keys: Array<{ pubkey: PublicKey }> }>;
      const tradeInstruction = instructions[instructions.length - 1];
      const accountA = tradeInstruction.keys[2].pubkey;

      expect(accountA.equals(portfolioTwo)).toBe(true);
      expect(accountA.equals(portfolioOne)).toBe(false);

      unmount();
    });
  });
});
