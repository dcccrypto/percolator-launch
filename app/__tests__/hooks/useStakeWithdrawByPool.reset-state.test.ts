import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useStakeWithdrawByPool } from "../../hooks/useStakeWithdrawByPool";

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: vi.fn(() => ({
    connection: {},
  })),
  useWalletCompat: vi.fn(() => ({
    publicKey: null,
    signTransaction: null,
  })),
}));

describe("useStakeWithdrawByPool reset state", () => {
  it("clears stale withdraw error when the selected pool changes", async () => {
    const { result, rerender } = renderHook(
      ({ slabAddress, collateralMint }) =>
        useStakeWithdrawByPool({ slabAddress, collateralMint }),
      {
        initialProps: {
          slabAddress: "slab-a",
          collateralMint: "mint-a",
        },
      },
    );

    await act(async () => {
      await expect(result.current.withdraw(1n)).rejects.toThrow("Wallet not connected");
    });

    await waitFor(() => {
      expect(result.current.error).toBe("Wallet not connected");
      expect(result.current.loading).toBe(false);
    });

    rerender({
      slabAddress: "slab-b",
      collateralMint: "mint-b",
    });

    await waitFor(() => {
      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(false);
    });
  });
});
