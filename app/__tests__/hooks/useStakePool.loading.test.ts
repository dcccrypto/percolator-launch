import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useStakePool } from "../../hooks/useStakePool";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;

  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

const testState = vi.hoisted(() => ({
  pendingPoolInfo: null as null | Deferred<null>,
}));

vi.mock("next/navigation", () => {
  const params = {
    slab: "So11111111111111111111111111111111111111112",
  };

  return {
    useParams: vi.fn(() => params),
  };
});

vi.mock("@/hooks/useWalletCompat", () => {
  const { Keypair } = require("@solana/web3.js");

  const walletPk = Keypair.generate().publicKey;

  const connection = {
    getAccountInfo: vi.fn(() => testState.pendingPoolInfo?.promise ?? Promise.resolve(null)),
    getMultipleAccountsInfo: vi.fn(() => Promise.resolve([])),
    getTokenAccountBalance: vi.fn(() =>
      Promise.resolve({
        value: {
          amount: "0",
          decimals: 6,
          uiAmount: 0,
        },
      }),
    ),
  };

  return {
    useConnectionCompat: vi.fn(() => ({
      connection,
    })),
    useWalletCompat: vi.fn(() => ({
      publicKey: walletPk,
    })),
  };
});

vi.mock("@/components/providers/SlabProvider", () => {
  const { PublicKey } = require("@solana/web3.js");

  const slabState = {
    config: {
      collateralMint: new PublicKey("So11111111111111111111111111111111111111112"),
    },
  };

  return {
    useSlabState: vi.fn(() => slabState),
  };
});

vi.mock("@percolatorct/sdk", () => {
  const { Keypair } = require("@solana/web3.js");

  const poolPda = Keypair.generate().publicKey;
  const vaultAuthPda = Keypair.generate().publicKey;
  const depositPda = Keypair.generate().publicKey;

  return {
    STAKE_POOL_SIZE: 352,
    deriveStakePool: vi.fn(() => [poolPda]),
    deriveStakeVaultAuth: vi.fn(() => [vaultAuthPda]),
    deriveDepositPda: vi.fn(() => [depositPda]),
    decodeStakePool: vi.fn(() => ({
      isInitialized: false,
    })),
  };
});

vi.mock("@solana/spl-token", () => {
  const { Keypair } = require("@solana/web3.js");

  const ata = Keypair.generate().publicKey;

  return {
    getAssociatedTokenAddress: vi.fn(() => Promise.resolve(ata)),
    unpackMint: vi.fn(() => ({
      supply: 0n,
      decimals: 6,
    })),
    unpackAccount: vi.fn(() => ({
      amount: 0n,
    })),
  };
});

describe("useStakePool loading state", () => {
  beforeEach(() => {
    testState.pendingPoolInfo = deferred<null>();
  });

  it("keeps loading true while initial stake pool state is still being fetched", async () => {
    const { result } = renderHook(() => useStakePool());

    expect(result.current.loading).toBe(true);
    expect(result.current.state.userLpBalance).toBe(0n);

    await act(async () => {
      testState.pendingPoolInfo?.resolve(null);
      await testState.pendingPoolInfo?.promise;
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
  });
});
