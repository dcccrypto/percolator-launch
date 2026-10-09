/**
 * The registered (user-launched) market list feeds the Earn TVL. When it can't be loaded, or the
 * route says its store read failed (`complete: false`), the vaults only it lists would silently
 * drop out of a TVL published as good. The cycle now counts that as a failed fetch.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));

import { useEarnStats } from "@/hooks/useEarnStats";

let registered: () => Response;
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  // No markets anywhere, so a cycle makes no RPC calls; only the registered list's answer varies.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).includes("registered-markets") ? registered() : new Response(JSON.stringify({ markets: [] }), { status: 200 }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const run = async () => {
  const { result } = renderHook(() => useEarnStats());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return result.current;
};

describe("useEarnStats: the registered market list", () => {
  it.each([
    ["the route flags its store read as incomplete", () => new Response(JSON.stringify({ markets: [], complete: false }), { status: 200 })],
    ["the request fails", () => new Response("down", { status: 503 })],
    ["the body has no market list", () => new Response(JSON.stringify({}), { status: 200 })],
    ["the request throws", () => {
      throw new TypeError("Failed to fetch");
    }],
  ])("%s: the cycle fails instead of publishing a TVL missing those vaults", async (_n, reply) => {
    registered = reply;
    expect((await run()).error).not.toBeNull();
  });

  it("CONTROL: a complete (even empty) list is a good cycle", async () => {
    registered = () => new Response(JSON.stringify({ markets: [] }), { status: 200 });
    expect((await run()).error).toBeNull();
  });
});
