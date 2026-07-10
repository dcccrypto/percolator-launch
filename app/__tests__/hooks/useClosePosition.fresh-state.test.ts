import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({
  trade: vi.fn(),
  fetchSlab: vi.fn(),
  parseAccount: vi.fn(),
  isV17Account: vi.fn(),
  parsePortfolioV17: vi.fn(),
  getProgramAccounts: vi.fn(),
  getLivePriceSnapshot: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
}));

vi.mock("@/hooks/useTrade", () => ({
  useTrade: vi.fn(),
}));

vi.mock("@/hooks/useUserAccount", () => ({
  useUserAccount: vi.fn(),
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: vi.fn(),
}));

vi.mock("@/lib/priceStore/priceStore", () => ({
  getLivePriceSnapshot: mocks.getLivePriceSnapshot,
}));

vi.mock("@/lib/mock-mode", () => ({
  isMockMode: () => false,
}));

vi.mock("@/lib/mock-trade-data", () => ({
  isMockSlab: () => false,
}));

vi.mock("@/lib/errorMessages", () => ({
  humanizeError: (message: string) => message,
  withTransientRetry: async (
    operation: () => Promise<unknown>,
  ) => operation(),
}));

vi.mock("@percolatorct/sdk", () => ({
  AccountKind: {
    LP: "LP",
  },
  isV17Account: mocks.isV17Account,
  parsePortfolioV17: mocks.parsePortfolioV17,
  fetchSlab: mocks.fetchSlab,
  parseAccount: mocks.parseAccount,
}));

import {
  useConnectionCompat,
  useWalletCompat,
} from "@/hooks/useWalletCompat";
import { useTrade } from "@/hooks/useTrade";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useClosePosition } from "@/hooks/useClosePosition";

describe("useClosePosition fresh-state verification", () => {
  const slabAddress =
    "11111111111111111111111111111111";

  const walletPublicKey = new PublicKey(
    "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  );

  const programId = new PublicKey(
    "5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf",
  );

  beforeEach(() => {
    vi.clearAllMocks();

    mocks.trade.mockResolvedValue("mock-signature");
    mocks.isV17Account.mockReturnValue(false);
    mocks.getLivePriceSnapshot.mockReturnValue({
      priceE6: 100_000_000n,
    });

    vi.mocked(useConnectionCompat).mockReturnValue({
      connection: {
        getProgramAccounts: mocks.getProgramAccounts,
      },
    } as ReturnType<typeof useConnectionCompat>);

    vi.mocked(useWalletCompat).mockReturnValue({
      publicKey: walletPublicKey,
      connected: true,
    } as ReturnType<typeof useWalletCompat>);

    vi.mocked(useTrade).mockReturnValue({
      trade: mocks.trade,
    } as unknown as ReturnType<typeof useTrade>);

    // Cached UI state reports a long position of +10.
    vi.mocked(useUserAccount).mockReturnValue({
      idx: 7,
      account: {
        positionSize: 10n,
      },
    } as ReturnType<typeof useUserAccount>);

    vi.mocked(useSlabState).mockReturnValue({
      accounts: [
        {
          idx: 3,
          account: {
            kind: "LP",
          },
        },
      ],
      raw: Buffer.from([1]),
      programId,
    } as unknown as ReturnType<typeof useSlabState>);
  });

  it("control: uses the fresh v12 position when verification succeeds", async () => {
    mocks.fetchSlab.mockResolvedValue(Buffer.alloc(1));
    mocks.parseAccount.mockReturnValue({
      positionSize: 2n,
    });

    const { result } = renderHook(() =>
      useClosePosition(slabAddress),
    );

    await act(async () => {
      await result.current.closePosition(100);
    });

    expect(mocks.trade).toHaveBeenCalledWith({
      lpIdx: 3,
      userIdx: 7,
      size: -2n,
    });
  });

  it("control: uses the fresh v17 position when verification succeeds", async () => {
    mocks.isV17Account.mockReturnValue(true);
    mocks.getProgramAccounts.mockResolvedValue([
      {
        account: {
          data: Buffer.alloc(1),
        },
      },
    ]);

    mocks.parsePortfolioV17.mockReturnValue({
      owner: walletPublicKey,
      legs: [
        {
          active: true,
          basisPosQ: 2n,
        },
      ],
    });

    const { result } = renderHook(() =>
      useClosePosition(slabAddress),
    );

    await act(async () => {
      await result.current.closePosition(100);
    });

    expect(mocks.getProgramAccounts).toHaveBeenCalled();
    expect(mocks.trade).toHaveBeenCalledWith({
      lpIdx: 3,
      userIdx: 7,
      size: -2n,
    });
  });

  it("blocks close when the v12 fresh-position read fails", async () => {
    mocks.fetchSlab.mockRejectedValue(
      new Error("RPC fresh-state read failed"),
    );

    const { result } = renderHook(() =>
      useClosePosition(slabAddress),
    );

    await act(async () => {
      await expect(
        result.current.closePosition(100),
      ).rejects.toThrow(/verify current on-chain position/i);
    });

    expect(mocks.trade).not.toHaveBeenCalled();
  });

  it("blocks close when the v17 fresh-position read fails", async () => {
    mocks.isV17Account.mockReturnValue(true);
    mocks.getProgramAccounts.mockRejectedValue(
      new Error("RPC getProgramAccounts failed"),
    );

    const { result } = renderHook(() =>
      useClosePosition(slabAddress),
    );

    await act(async () => {
      await expect(
        result.current.closePosition(100),
      ).rejects.toThrow(/verify current on-chain position/i);
    });

    expect(mocks.getProgramAccounts).toHaveBeenCalled();
    expect(mocks.trade).not.toHaveBeenCalled();
  });

});
