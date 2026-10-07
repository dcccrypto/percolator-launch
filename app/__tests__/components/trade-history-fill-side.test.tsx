/**
 * #3314: trade-history rows are FILLS and are labelled BUY / SELL, never LONG / SHORT.
 * Closing a merged long is a sell (one row per leg of a split close); it used to read as
 * "SHORT" rows that looked like short positions. The price column is "Price": a fill can't
 * tell an entry from an exit.
 */
import "@testing-library/jest-dom";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SLAB = "FbC4d6n5yUeKfdGWA1bdnwuHJN4pguaziGq5K544msdH";
const WALLET = "4bXx1ioqZ5XLC86DCwuCtu8mPfS9MT9EEY12SxH1FEGa";

const h = vi.hoisted(() => ({ trades: [] as unknown[] }));
vi.mock("@/hooks/useTradeHistory", () => ({
  useTradeHistory: () => ({ trades: h.trades, total: h.trades.length, loading: false, error: null, hasMore: false, loadMore: vi.fn() }),
}));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: { toBase58: () => WALLET }, connected: true }),
}));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({ config: null }) }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ decimals: 6 }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/pollWhenVisible", () => ({ pollWhenVisible: () => () => {} }));

import { fillSide, fillSideLabel } from "@/lib/fill-side";
import { TradeHistoryTable } from "@/components/trade/TradeHistoryTable";
import { TradeHistory as DashboardTradeHistory } from "@/components/dashboard/TradeHistory";
import { TradeHistory as MarketTradeTape } from "@/components/trade/TradeHistory";
import { TradeStatsPanel } from "@/components/trade/TradeStatsPanel";

const row = (id: string, side: string | null, price: number) => ({
  id, slab_address: SLAB, trader: WALLET, side, size: "37993777298", price, fee: 0,
  tx_signature: `sig${id}`, created_at: "2026-10-05T19:46:07Z",
});
// Four longs merged, then Close 100% split into four sell legs (devnet 4ox5hksa…, 2026-10-05).
const MERGED_THEN_CLOSED = [
  row("8", "short", 1.31), row("7", "short", 1.31), row("6", "short", 1.31), row("5", "short", 1.31),
  row("4", "long", 1.2), row("3", "long", 1.1), row("2", "long", 1.05), row("1", "long", 1.0),
];

beforeEach(() => {
  h.trades = [];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ trades: h.trades, total: h.trades.length }))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("fillSide", () => {
  it("maps the stored side (and the chart feed's buy/sell spelling) to a fill side; unknown is none", () => {
    expect(fillSide("long")).toBe("buy");
    expect(fillSide("short")).toBe("sell");
    expect(fillSide("BUY")).toBe("buy");
    expect(fillSide("sell")).toBe("sell");
    expect(fillSide(null)).toBeNull();
    expect(fillSide("flat")).toBeNull();
    expect(fillSideLabel(undefined)).toBe("—");
  });
});

describe.each([
  ["portfolio activity", () => render(<TradeHistoryTable wallet={WALLET} />)],
  ["dashboard", () => render(<DashboardTradeHistory />)],
  ["market trades tab", () => render(<MarketTradeTape slabAddress={SLAB} />)],
])("%s", (_name, mount) => {
  it("a closed merged long reads as four SELLs, never SHORT", async () => {
    h.trades = MERGED_THEN_CLOSED;
    mount();
    await flush();
    expect(screen.getAllByText("SELL")).toHaveLength(4);
    expect(screen.getAllByText("BUY")).toHaveLength(4);
    expect(screen.queryByText("SHORT")).toBeNull();
    expect(screen.queryByText("LONG")).toBeNull();
  });

  it("the price column is 'Price', not 'Entry/Exit'", async () => {
    h.trades = MERGED_THEN_CLOSED;
    mount();
    await flush();
    expect(screen.getAllByText("Price").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Entry\/Exit/)).toBeNull();
  });

  it("a row with no side shows a dash, never a side", async () => {
    h.trades = [row("9", null, 1)];
    mount();
    await flush();
    expect(screen.getByText("—", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByText(/^(SELL|SHORT|BUY|LONG)$/)).toBeNull();
  });
});

describe("dashboard filter and export", () => {
  it("the side filter offers Buy / Sell", async () => {
    mount();
    await flush();
    expect(screen.getByRole("option", { name: "Buy" })).toHaveValue("long");
    expect(screen.getByRole("option", { name: "Sell" })).toHaveValue("short");
    expect(screen.queryByRole("option", { name: "Long" })).toBeNull();
    function mount() {
      h.trades = MERGED_THEN_CLOSED;
      render(<DashboardTradeHistory />);
    }
  });
});

describe("stats panel", () => {
  it("splits fills into buys and sells, not a long/short bias", () => {
    const stats = {
      totalTrades: 8, longTrades: 4, shortTrades: 4, totalVolume: "0", totalFees: "0", feesRecorded: 0,
      tradesMissingPrice: 0, uniqueMarkets: 1, firstTradeAt: "2026-10-05T17:45:26Z", lastTradeAt: "2026-10-05T19:46:07Z",
    };
    render(<TradeStatsPanel stats={stats as never} loading={false} error={null} />);
    expect(screen.getByText("Buy / Sell Split")).toBeInTheDocument();
    expect(screen.getByText("50% buys")).toBeInTheDocument();
    expect(screen.queryByText(/long bias/i)).toBeNull();
    expect(screen.queryByText("Long / Short Split")).toBeNull();
  });
});
