/** F3: the lot-exponent read of /api/markets exists for v2.2 only. Flag off the trade history makes NO request (v2.1 behaviour). */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useTradeHistory", () => ({
  useTradeHistory: () => ({ trades: [], total: 0, loading: false, error: null, hasMore: false, loadMore: vi.fn() }),
}));

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function mount() {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ markets: [] })));
  vi.stubGlobal("fetch", fetchMock);
  // fresh module: the table keeps a module-level "already fetched" latch
  const { TradeHistoryTable } = await import("@/components/trade/TradeHistoryTable");
  render(<TradeHistoryTable wallet="W" />);
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return fetchMock;
}

describe("TradeHistoryTable /api/markets read", () => {
  it("flag OFF: no fetch at all", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEVNET_V22", "");
    expect(await mount()).not.toHaveBeenCalled();
  });
  it("flag ON: one fetch for the lot exponents", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEVNET_V22", "1");
    const f = await mount();
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0]![0])).toContain("/api/markets");
  });
});
