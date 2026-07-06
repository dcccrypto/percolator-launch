import { act, renderHook, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTokenMeta } from "../../hooks/useTokenMeta";

type TokenMetaFixture = {
  symbol: string;
  name: string;
  decimals: number;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

const testState = vi.hoisted(() => ({
  stableConnection: {},
  pendingByMint: {} as Record<string, Deferred<TokenMetaFixture>>,
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: vi.fn(() => ({
    connection: testState.stableConnection,
  })),
}));

vi.mock("@/lib/mock-trade-data", () => ({
  getMockSymbol: vi.fn(() => null),
}));

vi.mock("@/lib/tokenMeta", () => ({
  fetchTokenMeta: vi.fn((_connection: unknown, mint: PublicKey) => {
    const pending = testState.pendingByMint[mint.toBase58()];

    if (!pending) {
      throw new Error(`Unexpected mint ${mint.toBase58()}`);
    }

    return pending.promise;
  }),
}));

describe("useTokenMeta", () => {
  const mintA = new PublicKey("11111111111111111111111111111111");
  const mintB = new PublicKey("So11111111111111111111111111111111111111112");

  beforeEach(() => {
    testState.pendingByMint = {
      [mintA.toBase58()]: deferred<TokenMetaFixture>(),
      [mintB.toBase58()]: deferred<TokenMetaFixture>(),
    };
  });

  it("clears previous token metadata while loading a new mint", async () => {
    const { result, rerender } = renderHook(({ mint }) => useTokenMeta(mint), {
      initialProps: { mint: mintA },
    });

    await act(async () => {
      testState.pendingByMint[mintA.toBase58()].resolve({
        symbol: "AAA",
        name: "Token A",
        decimals: 6,
      });

      await testState.pendingByMint[mintA.toBase58()].promise;
    });

    await waitFor(() => {
      expect(result.current).toMatchObject({
        symbol: "AAA",
        name: "Token A",
        decimals: 6,
      });
    });

    rerender({ mint: mintB });

    await waitFor(() => {
      expect(result.current).toBeNull();
    });

    await act(async () => {
      testState.pendingByMint[mintB.toBase58()].resolve({
        symbol: "BBB",
        name: "Token B",
        decimals: 9,
      });

      await testState.pendingByMint[mintB.toBase58()].promise;
    });

    await waitFor(() => {
      expect(result.current).toMatchObject({
        symbol: "BBB",
        name: "Token B",
        decimals: 9,
      });
    });
  });
});
