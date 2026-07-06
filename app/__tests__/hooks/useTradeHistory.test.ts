import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTradeHistory } from "../../hooks/useTradeHistory";

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
  pendingByWallet: {} as Record<string, Deferred<Response>>,
}));

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

describe("useTradeHistory", () => {
  beforeEach(() => {
    testState.pendingByWallet = {
      "wallet-a": deferred<Response>(),
      "wallet-b": deferred<Response>(),
    };

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const match = url.match(/\/api\/trader\/([^/]+)\/trades/);
        const wallet = decodeURIComponent(match?.[1] ?? "");

        return testState.pendingByWallet[wallet].promise;
      }),
    );
  });

  it("ignores stale trade history responses after the wallet changes", async () => {
    const { result, rerender } = renderHook(({ wallet }) => useTradeHistory({ wallet, limit: 10 }), {
      initialProps: { wallet: "wallet-a" },
    });

    rerender({ wallet: "wallet-b" });

    await act(async () => {
      testState.pendingByWallet["wallet-a"].resolve(
        makeResponse({
          total: 1,
          trades: [{ signature: "old-wallet-trade" }],
        }),
      );

      await testState.pendingByWallet["wallet-a"].promise;
    });

    expect(result.current.trades).toEqual([]);
    expect(result.current.total).toBe(0);
    expect(result.current.loading).toBe(true);

    await act(async () => {
      testState.pendingByWallet["wallet-b"].resolve(
        makeResponse({
          total: 1,
          trades: [{ signature: "current-wallet-trade" }],
        }),
      );

      await testState.pendingByWallet["wallet-b"].promise;
    });

    await waitFor(() => {
      expect(result.current.trades).toEqual([{ signature: "current-wallet-trade" }]);
    });

    expect(result.current.total).toBe(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
