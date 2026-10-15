/**
 * S24: Portfolio Overview's trade history filtered Buy/Sell on the client, over the one 25-row
 * page it had fetched. A page with none of the chosen side read "No trades yet" (with the
 * not-indexed copy) for a wallet that has such trades, the pager counted every fill, and the
 * page number survived a filter change. The filter now goes to the API.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WALLET = "8WC8vALsDJhNCUVRmqZBDSg5xgFAhDrgy7zWqF512pDx";
// The Market cell resolves symbols from the shared market stats; keep that fetch out of this
// test's fetch queue (it reads the last request as the trades call).
vi.mock("@/hooks/useAllMarketStats", () => ({ useAllMarketStats: () => ({ statsMap: new Map() }) }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: { toBase58: () => WALLET }, connected: true }),
}));

import { TradeHistory } from "@/components/dashboard/TradeHistory";

const SLAB_L = "AaaaQ6oZ1JEnwFXsuS3AqYEYV17Msmd7hv2VUxjLAaaa";
const SLAB_S = "BbbbYb1YUUd6UzcrkiRsqdhrAzagguvrWmRgcBpsBbbb";
const ROW_S = "Bbbb…Bbbb";
function trade(id: string, side: "long" | "short") {
  return {
    id, slab_address: side === "long" ? SLAB_L : SLAB_S, trader: WALLET, side, size: "1000000", price: 1, fee: 0.01,
    tx_signature: null, created_at: "2026-10-01T00:00:00Z",
  };
}
const longs = (n: number) => Array.from({ length: n }, (_, i) => trade(`l${i}`, "long"));

type Pending = { url: string; resolve: (body: unknown, status?: number) => void };
let pending: Pending[];
const params = (p: Pending) => new URL(p.url, "http://x").searchParams;

beforeEach(() => {
  pending = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      new Promise<Response>((res) => {
        pending.push({ url, resolve: (body, status = 200) => res(new Response(JSON.stringify(body), { status })) });
      }),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function settle(p: Pending, body: unknown, status?: number) {
  await act(async () => {
    p.resolve(body, status);
    await new Promise((r) => setTimeout(r, 0));
  });
}
async function pickSide(value: "all" | "long" | "short") {
  await act(async () => {
    fireEvent.change(screen.getByRole("combobox"), { target: { value } });
  });
}

describe("Overview trade history: Buy/Sell filter", () => {
  it("asks the API for the side, so a page of buys doesn't hide the wallet's sells", async () => {
    render(<TradeHistory />);
    await act(async () => {});
    await settle(pending.at(-1)!, { trades: longs(25), total: 30 });
    expect(params(pending.at(-1)!).get("side")).toBeNull(); // unfiltered URL unchanged

    const before = pending.length;
    await pickSide("short");
    expect(pending.length).toBe(before + 1); // one read, not one at the old offset first
    const req = pending.at(-1)!;
    expect(params(req).get("side")).toBe("short");
    await settle(req, { trades: [trade("s1", "short")], total: 1 });

    expect(screen.getByText(ROW_S)).toBeTruthy();
    expect(screen.queryByText("No trades yet")).toBeNull();
    expect(screen.queryByText(/Page \d+ of/)).toBeNull(); // one filtered page: no pager
  });

  it("a filter change goes back to page 1, and the pager counts the filtered total", async () => {
    render(<TradeHistory />);
    await act(async () => {});
    await settle(pending.at(-1)!, { trades: longs(25), total: 60 });
    fireEvent.click(screen.getByText("Next →"));
    await settle(pending.at(-1)!, { trades: longs(25), total: 60 });
    fireEvent.click(screen.getByText("Next →"));
    await settle(pending.at(-1)!, { trades: longs(10), total: 60 });
    expect(screen.getByText("Page 3 of 3")).toBeTruthy();

    await pickSide("short");
    const req = pending.at(-1)!;
    expect(params(req).get("offset")).toBe("0");
    await settle(req, { trades: Array.from({ length: 25 }, (_, i) => trade(`s${i}`, "short")), total: 30 });
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
  });

  it("no fills on the chosen side says so, not that the indexer hasn't caught up", async () => {
    render(<TradeHistory />);
    await act(async () => {});
    await settle(pending.at(-1)!, { trades: longs(3), total: 3 });
    await pickSide("short");
    await settle(pending.at(-1)!, { trades: [], total: 0 });
    expect(screen.getByText("No sell fills")).toBeTruthy();
    expect(screen.queryByText("No trades yet")).toBeNull();
    expect(screen.queryByText(/trade indexer/)).toBeNull();
  });

  it("an outage while filtered still shows the error and Retry, which re-reads the filtered page", async () => {
    render(<TradeHistory />);
    await act(async () => {});
    await settle(pending.at(-1)!, { trades: longs(25), total: 60 });
    await pickSide("short");
    await settle(pending.at(-1)!, { error: "Trade history is temporarily unavailable" }, 503);
    expect(screen.getByText("Trade history is temporarily unavailable")).toBeTruthy();
    expect(screen.queryByText("No sell fills")).toBeNull();
    // The buys from the last good read are still in state: they must not export, and their total must not page.
    expect((screen.getByText("Export CSV") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/Page \d+ of/)).toBeNull();

    fireEvent.click(screen.getByText("Retry"));
    expect(params(pending.at(-1)!).get("side")).toBe("short");
  });
});
