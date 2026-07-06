import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTraderStats } from "../../hooks/useTraderStats";

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

describe("useTraderStats", () => {
  beforeEach(() => {
    testState.pendingByWallet = {
      "wallet-a": deferred<Response>(),
      "wallet-b": deferred<Response>(),
    };

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const match = url.match(/\/api\/trader\/([^/]+)\/stats/);
        const wallet = decodeURIComponent(match?.[1] ?? "");

        return testState.pendingByWallet[wallet].promise;
      }),
    );
  });

  it("ignores stale trader stats responses after the wallet changes", async () => {
    const { result, rerender } = renderHook(({ wallet }) => useTraderStats(wallet), {
      initialProps: { wallet: "wallet-a" },
    });

    rerender({ wallet: "wallet-b" });

    await act(async () => {
      testState.pendingByWallet["wallet-a"].resolve(
        makeResponse({
          totalTrades: 1,
          totalVolume: 100,
        }),
      );

      await testState.pendingByWallet["wallet-a"].promise;
    });

    expect(result.current.stats).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => {
      testState.pendingByWallet["wallet-b"].resolve(
        makeResponse({
          totalTrades: 2,
          totalVolume: 200,
        }),
      );

      await testState.pendingByWallet["wallet-b"].promise;
    });

    await waitFor(() => {
      expect(result.current.stats).toMatchObject({
        totalTrades: 2,
        totalVolume: 200,
      });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
