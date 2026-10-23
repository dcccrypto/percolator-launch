/**
 * A fill's `trades.size` is engine Q: a base-asset amount at POS_SCALE 1e6, whatever the
 * mint's decimals (lib/q-usd.ts). The portfolio trade history (TradeHistoryTable) formatted it
 * with the market's MINT decimals from /api/markets, so on the 9-decimal SOL market a
 * 3_298_097 Q fill (3.298 SOL, the $1.1752 fee at 30 bps of 3.298 SOL x $118.78) read
 * "0.003298" — 1000x low — while the Overview tab's history showed the same fill as 3.2981.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ trades: [] as unknown[] }));
vi.mock("@/hooks/useTradeHistory", () => ({
  useTradeHistory: () => ({ trades: h.trades, total: h.trades.length, loading: false, error: null, hasMore: false, loadMore: vi.fn() }),
}));

import { TradeHistoryTable } from "@/components/trade/TradeHistoryTable";

const SOL_SLAB = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";

afterEach(() => vi.unstubAllGlobals());

/** Render with /api/markets reporting the SOL market's mint decimals (9), as it does live, and
 *  let any market-directory read land and re-render before the caller asserts. */
async function renderWithSolDirectory() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ markets: [{ slab_address: SOL_SLAB, decimals: 9 }] }))),
  );
  render(<TradeHistoryTable wallet="W" />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("trade history size is engine Q", () => {
  it("a SOL (9-decimal mint) fill shows its base amount, not 1000x low", async () => {
    h.trades = [{
      id: "1", slab_address: SOL_SLAB, trader: "W", side: "long",
      size: "3298097", price: 118.78, fee: 1.1752, tx_signature: "sig", created_at: "2026-09-29T10:00:00Z",
    }];
    await renderWithSolDirectory();
    expect(screen.getByText("3.298097")).toBeTruthy();
    expect(screen.queryByText("0.003298097")).toBeNull();
  });

  it("a short fill's negative Q prints as its absolute base amount", async () => {
    h.trades = [{
      id: "2", slab_address: SOL_SLAB, trader: "W", side: "short",
      size: "-1500000", price: 118.78, fee: 0.5, tx_signature: null, created_at: "2026-09-29T10:00:00Z",
    }];
    await renderWithSolDirectory();
    expect(screen.getByText("1.5")).toBeTruthy();
    expect(screen.queryByText("0.0015")).toBeNull();
  });
});
