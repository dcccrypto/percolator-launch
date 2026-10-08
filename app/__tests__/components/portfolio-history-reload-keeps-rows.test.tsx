/**
 * #41: history and stats now reload in the background after every fill. A reload in flight must not
 * flash the stats skeleton, and a failed reload must not replace rows already on screen.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TradeStatsPanel } from "@/components/trade/TradeStatsPanel";
import { TradeHistoryTable } from "@/components/trade/TradeHistoryTable";
import type { TraderStatsResponse } from "@/hooks/useTraderStats";

const history = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/hooks/useTradeHistory", () => ({ useTradeHistory: () => history.value }));

const stats = {
  totalTrades: 7,
  longTrades: 4,
  shortTrades: 3,
  totalVolume: "0",
  totalFees: "0",
  feesRecorded: 0,
  tradesMissingPrice: 0,
} as unknown as TraderStatsResponse;

describe("background reloads keep what is on screen", () => {
  it("stats panel shows the last stats while reloading or after a failed reload", () => {
    const { rerender } = render(<TradeStatsPanel stats={stats} loading error={null} onRetry={() => {}} />);
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.queryByText(/Couldn.t refresh stats/)).toBeNull();
    const onRetry = vi.fn();
    rerender(<TradeStatsPanel stats={stats} loading={false} error="HTTP 429" onRetry={onRetry} />);
    expect(screen.getByText("7")).toBeTruthy();
    // ...and says they are the last loaded ones, with a way to try again.
    expect(screen.getByText(/Couldn.t refresh stats/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("history table keeps its rows when a reload fails", () => {
    history.value = {
      trades: [{
        id: "t1", slab_address: "SlabAddr1111111111", trader: "w", side: "long", size: "1000000",
        price: 1.5, fee: 0, tx_signature: null, created_at: new Date().toISOString(),
      }],
      total: 1, loading: false, error: "HTTP 429", hasMore: false, loadMore: () => {},
    };
    render(<TradeHistoryTable wallet="wallet-a" />);
    expect(screen.queryByText(/Failed to load trade history/)).toBeNull();
    expect(screen.getByTitle("SlabAddr1111111111")).toBeTruthy();
  });
});
