import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({
  wrapper: "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB",
  matcher: "EDKKgRaVHna6FCxiY1kgMzegD9rpaN1nwJNSzAzeBUBX",
  nft: "EMYT15LZWaP7Mmmm245kQPbrTyVjG16yZiU9kfNTF3GZ",
  stake: "VmpVUArRnVkrjaPXQ2qaqCQa3ZrZFgsz7rjeALitF5w",

  discoverMarketsViaProgramDirectory: vi.fn(),
  getAllProgramIds: vi.fn(),
  getMarketDiscoveryProgramIds: vi.fn(),
  getNetwork: vi.fn(),
}));

let wallet = new PublicKey(new Uint8Array(32).fill(71));

const connection = {
  getMultipleAccountsInfo: vi.fn().mockResolvedValue([]),
  getProgramAccounts: vi.fn().mockResolvedValue([]),
};

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection }),
  useWalletCompat: () => ({
    publicKey: wallet,
    connected: true,
  }),
}));

vi.mock("@/lib/market-directory-discovery", () => ({
  discoverMarketsViaProgramDirectory:
    mocks.discoverMarketsViaProgramDirectory,
}));

vi.mock("@/lib/config", async (orig) => {
  const actual = await orig<Record<string, unknown>>();

  return {
    ...actual,
    getAllProgramIds: mocks.getAllProgramIds,
    // Deliberately mocked before the production helper exists.
    // The regression test should go RED until usePortfolio separates
    // known/security programs from market-discovery programs.
    getMarketDiscoveryProgramIds:
      mocks.getMarketDiscoveryProgramIds,
    getNetwork: mocks.getNetwork,
  };
});

import { usePortfolio } from "@/hooks/usePortfolio";

describe("usePortfolio market-discovery program scope", () => {
  let walletSeed = 72;

  beforeEach(() => {
    vi.clearAllMocks();

    wallet = new PublicKey(
      new Uint8Array(32).fill(walletSeed++),
    );

    mocks.getNetwork.mockReturnValue("devnet");

    // Security/known-program allowlist intentionally contains every deployed
    // Percolator program.
    mocks.getAllProgramIds.mockReturnValue([
      mocks.wrapper,
      mocks.matcher,
      mocks.nft,
      mocks.stake,
    ]);

    // Market/slab discovery must be narrower: current v18 markets are owned
    // by the wrapper program, not matcher/NFT/stake.
    mocks.getMarketDiscoveryProgramIds.mockReturnValue([
      mocks.wrapper,
    ]);

    mocks.discoverMarketsViaProgramDirectory.mockImplementation(
      async (
        _connection: unknown,
        programId: PublicKey,
      ) => {
        const id = programId.toBase58();

        if (id === mocks.wrapper) {
          // Successful directory with zero markets is a legitimate result.
          // We intentionally do not need real slab fixtures for this test.
          return [];
        }

        throw new Error(
          `non-market directory unavailable: ${id}`,
        );
      },
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ markets: [] }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not let matcher/NFT/stake directory failures take down portfolio market discovery", async () => {
    const { result } = renderHook(() => usePortfolio());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBeNull();

    expect(
      mocks.discoverMarketsViaProgramDirectory,
    ).toHaveBeenCalledTimes(1);

    expect(
      (
        mocks.discoverMarketsViaProgramDirectory.mock
          .calls[0][1] as PublicKey
      ).toBase58(),
    ).toBe(mocks.wrapper);

    expect(
      mocks.discoverMarketsViaProgramDirectory.mock.calls[0][3],
    ).toEqual(
      expect.objectContaining({
        timeoutMs: 15_000,
      }),
    );

    expect(
      mocks.getMarketDiscoveryProgramIds,
    ).toHaveBeenCalled();

    expect(
      mocks.getAllProgramIds,
    ).not.toHaveBeenCalled();
  });

  it("preserves the existing 8s market-directory timeout on mainnet", async () => {
    mocks.getNetwork.mockReturnValue("mainnet");
    mocks.getMarketDiscoveryProgramIds.mockReturnValue([
      mocks.wrapper,
      mocks.matcher,
    ]);
    mocks.discoverMarketsViaProgramDirectory.mockResolvedValue([]);

    const { result } = renderHook(() => usePortfolio());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(
      mocks.discoverMarketsViaProgramDirectory,
    ).toHaveBeenCalled();

    for (
      const call of
      mocks.discoverMarketsViaProgramDirectory.mock.calls
    ) {
      expect(call[3]).toEqual(
        expect.objectContaining({
          timeoutMs: 8_000,
        }),
      );
    }
  });

});
