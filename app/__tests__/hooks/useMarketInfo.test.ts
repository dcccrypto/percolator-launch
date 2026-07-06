import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMarketInfo } from "../../hooks/useMarketInfo";

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
  pendingBySlab: {} as Record<string, Deferred<{ data: unknown; error: null | { message: string } }>>,
  realtimeHandler: null as null | ((payload: { new: Record<string, unknown> }) => void),
}));

vi.mock("@/lib/mock-mode", () => ({
  isMockMode: vi.fn(() => false),
}));

vi.mock("@/lib/mock-trade-data", () => ({
  isMockSlab: vi.fn(() => false),
  getMockMarketInfo: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  getSupabase: vi.fn(() => {
    const channel = {
      on: vi.fn((_event, _filter, handler) => {
        testState.realtimeHandler = handler;
        return channel;
      }),
      subscribe: vi.fn(() => channel),
    };

    return {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn((_column: string, slabAddress: string) => ({
            maybeSingle: vi.fn(() => testState.pendingBySlab[slabAddress].promise),
          })),
        })),
      })),
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
    };
  }),
}));

describe("useMarketInfo", () => {
  beforeEach(() => {
    testState.pendingBySlab = {
      "slab-a": deferred(),
      "slab-b": deferred(),
    };
    testState.realtimeHandler = null;
  });

  it("ignores stale market info responses after the active slab changes", async () => {
    const { result, rerender } = renderHook(({ slab }) => useMarketInfo(slab), {
      initialProps: { slab: "slab-a" },
    });

    rerender({ slab: "slab-b" });

    await act(async () => {
      testState.pendingBySlab["slab-a"].resolve({
        data: { slab_address: "slab-a", volume_24h: 100 },
        error: null,
      });
      await testState.pendingBySlab["slab-a"].promise;
    });

    expect(result.current.market).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => {
      testState.pendingBySlab["slab-b"].resolve({
        data: { slab_address: "slab-b", volume_24h: 200 },
        error: null,
      });
      await testState.pendingBySlab["slab-b"].promise;
    });

    await waitFor(() => {
      expect(result.current.market).toMatchObject({
        slab_address: "slab-b",
        volume_24h: 200,
      });
    });

    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});
