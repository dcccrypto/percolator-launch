/**
 * The indexer records `trades.fee` in USD (live: 0.25004477879138404 on a $500.09 SI fill at
 * 5 bps; every row since 2026-09-28 is exactly bps × notional in dollars). The portfolio read it
 * as 6-decimal token atoms: "Fees Paid" summed Math.round(fee) (~$7.03 over 11 fills became 6 ->
 * "0.000006") and the per-fill column rendered sub-$0.50 fees as "0".
 */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ trades: [] as unknown[], sql: vi.fn() }));
vi.mock("@/hooks/useTradeHistory", () => ({
  useTradeHistory: () => ({ trades: h.trades, total: h.trades.length, loading: false, error: null, hasMore: false, loadMore: vi.fn() }),
}));
vi.mock("postgres", () => ({ default: vi.fn(() => h.sql) }));

import { TradeHistoryTable } from "@/components/trade/TradeHistoryTable";
import { TradeStatsPanel } from "@/components/trade/TradeStatsPanel";

afterEach(() => vi.unstubAllGlobals());

const stats = (totalFees: string) => ({
  totalTrades: 11, longTrades: 1, shortTrades: 10, totalVolume: "7664413830", totalFees, feesRecorded: 11,
  tradesMissingPrice: 0, uniqueMarkets: 6, firstTradeAt: "2026-09-28T09:11:05Z", lastTradeAt: "2026-10-01T16:22:02Z",
});

describe("trader fees are dollars", () => {
  it("Fees Paid shows the micro-USD total as dollars", () => {
    render(<TradeStatsPanel stats={stats("7030000") as never} loading={false} error={null} />);
    expect(screen.getByText("$7.03")).toBeTruthy();
    expect(screen.queryByText("0.000006")).toBeNull();
  });

  // #76: totalVolume is micro-USD too (|size| x USD price), but it rendered as a bare 6-dp number.
  it("Volume Traded shows the micro-USD total as dollars, like Fees Paid", () => {
    render(<TradeStatsPanel stats={stats("7030000") as never} loading={false} error={null} />);
    expect(screen.getByText("$7.7K")).toBeTruthy(); // 7,664.41 USD
    expect(screen.queryByText(/7664\.4138/)).toBeNull(); // the old bare render, "7664.41383"
  });

  it("the per-fill Fee column shows the USD fee", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ markets: [] }))));
    h.trades = [{
      id: "1", slab_address: "8WC8vALsDJhNCUVRmqZBDSg5xgFAhDrgy7zWqF512pDx", trader: "W", side: "short",
      size: 89557585527, price: 0.005584, fee: 0.25004477879138404, tx_signature: "sig", created_at: "2026-10-01T16:22:02Z",
    }];
    render(<TradeHistoryTable wallet="W" />);
    expect(screen.getByText("$0.2500")).toBeTruthy();
  });

  it("the indexer-DB aggregate scales the USD fee to micro-USD", async () => {
    process.env.INDEXER_DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    h.sql.mockResolvedValueOnce([{ total_trades: "0" }]);
    vi.resetModules();
    const { queryTraderStatsAggregate } = await import("@/lib/indexer-db");
    await queryTraderStatsAggregate("WALLET");
    const sqlText = (h.sql.mock.calls[0][0] as string[]).join("?");
    expect(sqlText).toContain("sum(floor(fee::numeric * 1000000 + 0.5))");
  });
});
